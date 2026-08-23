/**
 * Deterministic technical signals computed purely from price history
 * already fetched for every ticker (FMP or the Yahoo fallback) — no new API
 * call. Monthly-resolution data makes these rougher than a daily-bar RSI/
 * SMA a real desk would use, but they're real math on real closes, not a
 * fabricated read, and — crucially — they're available even for tickers
 * where FMP's /quote (and its 50/200-day averages) is blocked entirely.
 */
export interface TechnicalSignals {
  sma3: number;
  sma6: number;
  rsi6: number; // 0-100, Wilder-style RSI over the trailing 6 monthly changes
  trend: "uptrend" | "downtrend" | "neutral";
  trailing12moHigh: number;
  trailing12moLow: number;
  pctFromHigh: number; // negative = below the trailing high
}

const MIN_POINTS = 7; // 6 month-over-month changes needed for RSI(6)

export function computeTechnicals(closes: number[]): TechnicalSignals | null {
  if (closes.length < MIN_POINTS) return null;

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const sma3 = avg(closes.slice(-3));
  const sma6 = avg(closes.slice(-6));

  const changes: number[] = [];
  for (let i = closes.length - 6; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const gains = changes.filter((c) => c > 0);
  const losses = changes.filter((c) => c < 0).map((c) => Math.abs(c));
  const avgGain = gains.reduce((a, b) => a + b, 0) / 6;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / 6;
  const rsi6 =
    avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : Math.round(100 - 100 / (1 + avgGain / avgLoss));

  const trailing12moHigh = Math.max(...closes);
  const trailing12moLow = Math.min(...closes);
  const currentPrice = closes[closes.length - 1];
  const pctFromHigh = (currentPrice - trailing12moHigh) / trailing12moHigh;

  const trend: TechnicalSignals["trend"] =
    sma3 > sma6 * 1.01 ? "uptrend" : sma3 < sma6 * 0.99 ? "downtrend" : "neutral";

  return { sma3, sma6, rsi6, trend, trailing12moHigh, trailing12moLow, pctFromHigh };
}
