from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol


@dataclass
class SourceResult:
    ok: bool
    source_name: str
    data_type: str
    data_as_of: str
    payload: dict[str, Any] = field(default_factory=dict)
    missing_data: list[str] = field(default_factory=list)
    confidence: str = "low"
    evidence_level: str = "unverified"


class MarketDataProvider(Protocol):
    def quote(self, code: str, market: str = "") -> SourceResult:
        ...

    def index_quote(self, code: str, market: str = "") -> SourceResult:
        ...

    def trading_calendar(self, market: str = "CN") -> SourceResult:
        ...


class DisclosureProvider(Protocol):
    def announcements(self, code: str, market: str = "") -> SourceResult:
        ...

    def financial_reports(self, code: str, market: str = "") -> SourceResult:
        ...


class NullDataProvider:
    """Provider used until real data sources are configured."""

    name = "null_provider"

    def quote(self, code: str, market: str = "") -> SourceResult:
        return self._missing("market_price", [f"quote:{market}:{code}"])

    def index_quote(self, code: str, market: str = "") -> SourceResult:
        return self._missing("index_price", [f"index_quote:{market}:{code}"])

    def trading_calendar(self, market: str = "CN") -> SourceResult:
        return self._missing("trading_calendar", [f"trading_calendar:{market}"])

    def announcements(self, code: str, market: str = "") -> SourceResult:
        return self._missing("announcement", [f"announcements:{market}:{code}"])

    def financial_reports(self, code: str, market: str = "") -> SourceResult:
        return self._missing("financial_report", [f"financial_reports:{market}:{code}"])

    def _missing(self, data_type: str, missing: list[str]) -> SourceResult:
        return SourceResult(
            ok=False,
            source_name=self.name,
            data_type=data_type,
            data_as_of=datetime.now(timezone.utc).isoformat(),
            missing_data=missing,
            confidence="low",
            evidence_level="unverified",
        )


def provider_from_config(_: dict[str, Any]) -> NullDataProvider:
    return NullDataProvider()
