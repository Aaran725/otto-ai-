import type { StockBundle } from "./fmp";
import type { MetricComparison } from "./schema";
import type { PeerValuation } from "./peers";
import type { EarningsRecord } from "./earnings";
import type { ShortInterestData } from "./short-interest";
import { computeTechnicals } from "./technicals";

function pct(n: number | undefined | null, digits = 1) {
  return n === undefined || n === null ? "n/a" : `${(n * 100).toFixed(digits)}%`;
}

function x(n: number | undefined | null, digits = 1) {
  return n === undefined || n === null ? "n/a" : `${n.toFixed(digits)}x`;
}

/**
 * The 6-row metrics table, computed deterministically from FMP data — same
 * philosophy as the Snowflake and forecast: Groq narrates, it doesn't invent
 * numbers. Also keeps Groq's prompt/output smaller.
 */
export function computeMetrics(
  bundle: StockBundle,
  peerValuation?: PeerValuation | null,
  earnings?: EarningsRecord | null,
  shortInterest?: ShortInterestData | null
): MetricComparison[] {
  const { ratios, keyMetrics, income } = bundle;
  const latest = income.at(-1);
  const prior = income.at(-2);
  const incomeRevenueGrowth = latest && prior && prior.revenue !== 0 ? (latest.revenue - prior.revenue) / Math.abs(prior.revenue) : null;
  const incomeNetMargin = latest && latest.revenue !== 0 ? latest.netIncome / latest.revenue : null;
  // Fall back to ratios (possibly Finnhub-sourced) when FMP's income
  // statement is blocked for this ticker — see fmp.ts's Finnhub fallback.
  const revenueGrowth = incomeRevenueGrowth ?? ratios?.revenueGrowthYoY ?? null;
  const netMargin = incomeNetMargin ?? ratios?.netProfitMargin ?? null;

  const pe = ratios?.priceToEarningsRatio;
  const fcfYield = keyMetrics?.freeCashFlowYield;
  const roic = keyMetrics?.returnOnInvestedCapital;
  const de = ratios?.debtToEquityRatio;
  const technicals = computeTechnicals(bundle.historicalMonthly.map((p) => p.price));

  // Real peers (SEC SIC-code matched) when available — a percentile among
  // actual comparable companies beats a static "~20x" placeholder every
  // time it's present, and falls back cleanly when it isn't.
  const peBenchmark = peerValuation
    ? `${peerValuation.sicDescription} peers: ${peerValuation.medianPE.toFixed(1)}x median`
    : "~20x industry avg";
  const peSignal: MetricComparison["signal"] = peerValuation
    ? peerValuation.percentile <= 40
      ? "bull"
      : peerValuation.percentile >= 70
        ? "bear"
        : "neutral"
    : pe === undefined
      ? "neutral"
      : pe < 20
        ? "bull"
        : pe < 30
          ? "neutral"
          : "bear";

  return [
    {
      label: "Valuation (P/E)",
      value: x(pe),
      benchmark: peBenchmark,
      signal: peSignal,
    },
    {
      label: "FCF Yield",
      value: pct(fcfYield),
      benchmark: ">4% attractive",
      signal: fcfYield === undefined ? "neutral" : fcfYield > 0.04 ? "bull" : "bear",
    },
    {
      label: "ROIC",
      value: pct(roic),
      benchmark: ">8% cost of capital",
      signal: roic === undefined ? "neutral" : roic > 0.1 ? "bull" : roic > 0.08 ? "neutral" : "bear",
    },
    {
      label: "Debt-to-Equity",
      value: de === undefined || de === null ? "n/a" : de.toFixed(2),
      benchmark: "<1.0 preferred",
      signal: de === undefined ? "neutral" : de < 0.5 ? "bull" : de < 1 ? "neutral" : "bear",
    },
    {
      label: "Revenue Growth (YoY)",
      value: pct(revenueGrowth),
      benchmark: "~8% healthy",
      signal: revenueGrowth === null ? "neutral" : revenueGrowth > 0.08 ? "bull" : revenueGrowth > 0 ? "neutral" : "bear",
    },
    {
      label: "Net Margin",
      value: pct(netMargin),
      benchmark: ">5% healthy",
      signal: netMargin === null ? "neutral" : netMargin > 0.05 ? "bull" : netMargin > 0 ? "neutral" : "bear",
    },
    // Real technical signals computed from price history already on hand —
    // see technicals.ts. Omitted (not shown as "n/a") when there isn't
    // enough price history to compute them at all.
    ...(technicals
      ? ([
          {
            label: "Trend (SMA)",
            value: technicals.trend === "uptrend" ? "Uptrend" : technicals.trend === "downtrend" ? "Downtrend" : "Neutral",
            benchmark: "3mo avg vs 6mo avg",
            signal: technicals.trend === "uptrend" ? "bull" : technicals.trend === "downtrend" ? "bear" : "neutral",
          },
          {
            label: "RSI (6mo)",
            value: String(technicals.rsi6),
            benchmark: "30-70 healthy range",
            signal: technicals.rsi6 > 70 ? "bear" : technicals.rsi6 < 30 ? "bull" : "neutral",
          },
        ] satisfies MetricComparison[])
      : []),
    ...(earnings?.nextEarningsDate
      ? ([
          {
            label: "Next Earnings",
            value: earnings.nextEarningsDate,
            benchmark:
              earnings.recentSurprises.length > 0
                ? `Beat ${earnings.beatCount}/${earnings.recentSurprises.length} last quarters`
                : "no recent surprise history",
            signal:
              earnings.recentSurprises.length === 0
                ? "neutral"
                : earnings.beatCount > earnings.missCount
                  ? "bull"
                  : earnings.beatCount < earnings.missCount
                    ? "bear"
                    : "neutral",
          },
        ] satisfies MetricComparison[])
      : []),
    ...(shortInterest
      ? ([
          {
            label: "Short Interest",
            value: `${shortInterest.daysToCover.toFixed(1)}d to cover`,
            benchmark: ">5 days = elevated",
            signal: shortInterest.daysToCover > 5 ? "bear" : "neutral",
          },
        ] satisfies MetricComparison[])
      : []),
  ];
}
