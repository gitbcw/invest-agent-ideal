export interface StockQuote {
  code: string;
  name: string;
  price: number;
  yesterdayClose: number;
  open: number;
  volume: number;
  amount: number;
  high: number;
  low: number;
  change: number;
  changePercent: number;
  turnoverRate: number;
  time: string;
  bidVolume?: number;
  askVolume?: number;
  bidAskImbalance?: number;
  source?: MarketSourceMeta;
}

export interface StockKline {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface MarketSourceMeta {
  provider: string;
  endpoint: string;
  referenceUrl?: string;
  fetchedAt: string;
  marketTime?: string | null;
  confidence: "low" | "medium" | "high";
  stale?: boolean;
  warnings: string[];
}

export interface MarketSnapshotItem {
  stockCode: string;
  stockName: string;
  support?: number | null;
  resistance?: number | null;
  targetPrice?: number | null;
  stopLoss?: number | null;
  quote?: {
    price?: number | null;
    changePercent?: number | null;
    tradingStatus: { status: string };
  } | null;
}

export interface MarketSnapshot {
  userId: string;
  instanceId: string;
  updatedAt: string;
  holdings: MarketSnapshotItem[];
  watchlist: MarketSnapshotItem[];
  plans: MarketSnapshotItem[];
  indices: Array<{ code: string; name: string; price: number | null; changePercent: number | null }>;
  warnings: string[];
}
