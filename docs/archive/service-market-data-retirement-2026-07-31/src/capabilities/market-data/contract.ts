import type {
  MarketCalendarReport,
  MarketCapitalFlow,
  MarketHealthReport,
  MarketIndexQuote,
  MarketKlinePeriod,
  MarketKlineResult,
  MarketQuote,
  MarketSectorTheme,
  MarketStockInfo,
} from "../../services/market-data.js";

export interface MarketDataCapabilityContract {
  quote(codes: string[], telemetryUserId?: string | null): Promise<{ items: MarketQuote[]; warnings: string[] }>;
  kline(input: MarketKlineInput, telemetryUserId?: string | null): Promise<MarketKlineResult>;
  indices(telemetryUserId?: string | null): Promise<{ items: MarketIndexQuote[]; warnings: string[] }>;
  capitalFlow(codes: string[], telemetryUserId?: string | null): Promise<{ items: MarketCapitalFlow[]; warnings: string[] }>;
  sectorTheme(codes: string[], telemetryUserId?: string | null): Promise<{ items: MarketSectorTheme[]; warnings: string[] }>;
  stockInfo(
    stocks: Array<{ code: string; name?: string }>,
    options?: { days?: number; targetDate?: string },
    telemetryUserId?: string | null,
  ): Promise<{ items: MarketStockInfo[]; warnings: string[] }>;
  resolve(keyword: string, telemetryUserId?: string | null): Promise<{ items: unknown[]; warnings: string[]; source: unknown }>;
  calendar(date?: Date, telemetryUserId?: string | null): Promise<MarketCalendarReport>;
  health(): Promise<MarketHealthReport>;
}

export interface MarketKlineInput {
  code: string;
  period?: MarketKlinePeriod;
  count?: number;
  startDate?: string;
  endDate?: string;
}
