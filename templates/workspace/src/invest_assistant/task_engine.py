from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from .config_loader import read_yaml
from .data_sources import provider_from_config
from .memory_store import JsonlStore


@dataclass
class TaskContext:
    root: Path
    task_type: str
    period_key: str
    trigger: str = "manual"

    @property
    def idempotency_key(self) -> str:
        raw = f"{self.task_type}:{self.period_key}:{self.trigger}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


class TaskEngine:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.paths = read_yaml(root / "config" / "paths.yaml")
        self.store = JsonlStore(root)
        self.sources = read_yaml(root / "config" / "sources.yaml")
        self.provider = provider_from_config(self.sources)

    def run_daily_review(self, period_key: str | None = None, trigger: str = "manual") -> Path:
        period = period_key or date.today().isoformat()
        ctx = TaskContext(self.root, "daily_review", period, trigger)
        report_rel = f"reports/daily/{period}.md"
        report_path = self.root / report_rel
        if report_path.exists() and trigger != "refresh":
            self._record_task(ctx, "skipped_duplicate", {"report": report_rel})
            return report_path

        portfolio = read_yaml(self.root / "config" / "portfolio.yaml")
        holdings = portfolio.get("holdings", [])
        watchlist = portfolio.get("watchlist", [])
        missing_data: list[str] = []
        quote_rows: list[dict[str, Any]] = []

        for item in holdings:
            result = self.provider.quote(str(item.get("code", "")), str(item.get("market", "")))
            missing_data.extend(result.missing_data)
            quote_rows.append({
                "name": item.get("name", ""),
                "code": item.get("code", ""),
                "role": item.get("role", ""),
                "data_status": "ok" if result.ok else "missing",
                "confidence": result.confidence,
            })

        report = self._render_daily_report(period, holdings, watchlist, quote_rows, missing_data)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report, encoding="utf-8")

        empty_portfolio = not holdings and not watchlist
        decision = self.store.append(
            "memory/decisions.jsonl",
            {
                "source_task_trace_id": ctx.idempotency_key,
                "task_type": ctx.task_type,
                "period_key": period,
                "decision_type": "onboarding_required" if empty_portfolio else ("no_action" if missing_data else "observe"),
                "action_boundary": "analysis_only",
                "view": "持仓为空时进入冷启动；数据源未配置或缺少关键行情时，默认不输出交易动作。",
                "reasons": ["MVP 执行内核已生成日复盘骨架", "持仓为空或缺少真实行情源时降低结论强度"],
                "validation_points": ["完成 30 秒冷启动后生成第一份正式持仓复盘", "接入行情源后复核持仓价格、盈亏和关键区间"],
                "invalidation_signals": ["真实行情显示已触发用户确认过的 P0 风险或操作规则"],
                "confidence": "low" if (empty_portfolio or missing_data) else "medium",
            },
            "decision_record",
        )

        if missing_data:
            self.store.append(
                "memory/source_events.jsonl",
                {
                    "source_name": "null_provider",
                    "source_type": "market_price",
                    "event": "missing",
                    "reason": "Daily review ran without configured market data provider.",
                    "related_task": ctx.idempotency_key,
                    "missing_data": missing_data,
                },
                "source_event",
            )

        self._record_task(ctx, "completed", {"report": report_rel, "decision_id": decision["id"]})
        return report_path

    def compute_metrics(self, period_key: str | None = None) -> Path:
        period = period_key or datetime.now(timezone.utc).strftime("%Y-%m")
        decisions = self.store.read_all("memory/decisions.jsonl")
        behaviors = self.store.read_all("memory/behavior_events.jsonl")
        sources = self.store.read_all("memory/source_events.jsonl")
        task_runs = self.store.read_all("memory/task_runs.jsonl")
        metrics = {
            "period": period,
            "decision_records": len([r for r in decisions if str(r.get("period_key", "")).startswith(period)]),
            "short_term_query_count": len([r for r in behaviors if r.get("event_type") == "short_term_query"]),
            "manual_refresh_count": len([r for r in task_runs if r.get("trigger") == "refresh"]),
            "source_conflict_count": len([r for r in sources if r.get("event") == "conflict"]),
            "missing_data_events": len([r for r in sources if r.get("event") == "missing"]),
        }
        out = self.root / "reports" / "metrics" / f"{period}.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            f"# {period} 产品指标",
            "",
            "| 指标 | 数值 |",
            "| :--- | ---: |",
        ]
        for key, value in metrics.items():
            if key == "period":
                continue
            lines.append(f"| {key} | {value} |")
        out.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return out

    def _record_task(self, ctx: TaskContext, status: str, extra: dict[str, Any]) -> None:
        self.store.append(
            "memory/task_runs.jsonl",
            {
                "task_type": ctx.task_type,
                "period_key": ctx.period_key,
                "trigger": ctx.trigger,
                "idempotency_key": ctx.idempotency_key,
                "status": status,
                "extra": extra,
            },
            "task_run",
        )

    @staticmethod
    def _render_daily_report(
        period: str,
        holdings: list[dict[str, Any]],
        watchlist: list[dict[str, Any]],
        quote_rows: list[dict[str, Any]],
        missing_data: list[str],
    ) -> str:
        lines = [
            f"# {period} 日复盘",
            "",
            "## 一、核心结论",
            "",
            "当前已跑通 MVP 日复盘执行链路。由于持仓或真实行情源可能尚未配置，所有涉及价格、盈亏和触发区间的结论均降级为待验证。",
            "",
            "## 二、今日动作结论",
            "",
            "| 项目 | 结论 | 原因 |",
            "| :--- | :--- | :--- |",
            "| 是否需要操作 | 否 | 缺少可信行情或未触发用户确认规则 |",
            "| 是否需要关注 | 是 | 需要优先补齐行情/公告数据源 |",
            "| 是否需要用户确认 | 否 | 本报告不包含交易确认单 |",
            "",
            "## 三、持仓数据状态",
            "",
            "| 标的 | 代码 | 定位 | 数据状态 | 置信度 |",
            "| :--- | :--- | :--- | :--- | :--- |",
        ]
        if quote_rows:
            for row in quote_rows:
                lines.append(
                    f"| {row['name']} | {row['code']} | {row['role']} | {row['data_status']} | {row['confidence']} |"
                )
        else:
            lines.append("| 无持仓 |  |  | missing | low |")
        lines.extend([
            "",
            "## 四、观察仓",
            "",
        ])
        if watchlist:
            for item in watchlist:
                lines.append(f"- {item.get('name', '')} {item.get('code', '')}：{item.get('trigger', '')}")
        else:
            lines.append("- 暂无观察仓。")
        if not holdings and not watchlist:
            lines.extend([
                "",
                "## 五、冷启动状态",
                "",
                "- 当前没有持仓和观察仓，应进入 30 秒冷启动：上传持仓截图或输入核心持仓、选择风格包、确认低打扰模式。",
            ])
        lines.extend([
            "",
            "## 六、数据缺口",
            "",
        ])
        if missing_data:
            lines.extend(f"- {item}" for item in missing_data)
        else:
            lines.append("- 暂无关键缺口。")
        lines.extend([
            "",
            "## 七、下一步",
            "",
            "- 接入最小行情和公告源后，再生成可用于持仓盈亏、关键区间和 P0/P1/P2 触发判断的正式日复盘。",
        ])
        return "\n".join(lines) + "\n"
