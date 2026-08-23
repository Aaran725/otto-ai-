export type RateSensitivity = "high" | "moderate" | "low";

/**
 * A real equity-risk-premium read, not a vibe: compares a stock's free
 * cash flow yield against the risk-free 10-year Treasury yield. When a
 * stock earns less on its own cash flow than a Treasury bond pays for free,
 * its valuation depends heavily on rates staying low ("high" sensitivity).
 * A wide positive spread means the stock's cash generation already clears
 * the risk-free bar comfortably, insulating it from rate moves ("low").
 */
export function computeRateSensitivity(
  fcfYield: number | undefined,
  treasury10Y: number | undefined
): RateSensitivity | null {
  if (fcfYield === undefined || treasury10Y === undefined) return null;
  const spreadPct = fcfYield * 100 - treasury10Y;
  if (spreadPct < 0) return "high";
  if (spreadPct < 2) return "moderate";
  return "low";
}
