import type {
  OttoAnalysis,
  OttoForecast,
  OttoSnowflake,
  HistoricalPoint,
  MetricComparison,
  StreetConsensus,
  FundamentalTrendPoint,
} from "./schema";
import type { PeerValuation } from "./peers";
import type { InsiderActivity } from "./insider";

/** A small, targeted visual answering one follow-up question about a stock
 * already discussed — deliberately smaller than the full OttoCardCompact,
 * built from data already cached (no new fetch/LLM call for the numbers). */
export type FollowUpVisual =
  | {
      type: "forecast";
      forecast: OttoForecast;
      historicalPrices: HistoricalPoint[];
      street: StreetConsensus | null;
      positive: boolean;
    }
  | { type: "metrics"; metrics: MetricComparison[] }
  | { type: "thesis"; catalysts: [string, string, string]; risks: [string, string] }
  | { type: "snowflake"; snowflake: OttoSnowflake }
  | { type: "peers"; peerValuation: PeerValuation; currentPE?: number; currentPFCF?: number; currentROIC?: number }
  | { type: "rating"; street: StreetConsensus }
  | { type: "revenue"; fundamentalTrend: FundamentalTrendPoint[] }
  | { type: "cashflow"; fundamentalTrend: FundamentalTrendPoint[] }
  | { type: "sparkline"; historicalPrices: HistoricalPoint[]; positive: boolean }
  | { type: "insider"; insiderActivity: InsiderActivity };

export interface ScreenerResultItem {
  rank: number;
  symbol: string;
  companyName: string;
  price: number;
  compositeScore: number;
  keyStat: string;
  thinCoverage?: boolean; // true when ranked without real fundamentals data (e.g. a momentum spike with no ratios/metrics)
  insiderActivity?: { buys: number; sells: number; netShares: number; direction: "buying" | "selling" | "mixed" };
  filingNote?: string; // real excerpt from the company's own 10-K
}

export interface ScreenerResults {
  intentLabel: string; // e.g. "Undervalued picks"
  results: ScreenerResultItem[];
  isAvoidList?: boolean; // inverts score coloring — a "least bad" score still isn't good
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  card?: OttoAnalysis;
  visual?: FollowUpVisual;
  screener?: ScreenerResults;
}

export interface ChatRequestBody {
  message: string;
  history: ChatMessage[];
}

export interface ChatResponseBody {
  reply: string;
  card?: OttoAnalysis;
  visual?: FollowUpVisual;
  screener?: ScreenerResults;
}

/**
 * The chat route streams newline-delimited JSON so a slow multi-stage
 * screener scan can report real progress instead of one silent wait — a
 * "status" event per pipeline stage, then exactly one terminal "done" event
 * carrying the same shape as the old single-shot ChatResponseBody (plus an
 * optional error, since a stream can't change its HTTP status mid-flight).
 */
export type ChatStreamEvent =
  | { type: "status"; text: string }
  | ({ type: "done"; error?: string } & Partial<ChatResponseBody>);
