from __future__ import annotations

import argparse
from pathlib import Path

from .task_engine import TaskEngine


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="invest-assistant", description="Investment assistant MVP runner")
    sub = parser.add_subparsers(dest="command", required=True)

    daily = sub.add_parser("daily-review", help="Generate a daily review report")
    daily.add_argument("--date", dest="period_key", default=None)
    daily.add_argument("--trigger", default="manual", choices=["manual", "auto", "refresh"])

    metrics = sub.add_parser("metrics", help="Compute product metrics")
    metrics.add_argument("--period", dest="period_key", default=None)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    engine = TaskEngine(Path.cwd())
    if args.command == "daily-review":
        path = engine.run_daily_review(args.period_key, args.trigger)
        print(path)
        return 0
    if args.command == "metrics":
        path = engine.compute_metrics(args.period_key)
        print(path)
        return 0
    raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
