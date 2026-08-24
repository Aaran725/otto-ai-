import { redis } from "./cache";

/**
 * Shared, Redis-backed request budget — proactive self-throttling instead
 * of the purely reactive posture this app had before (retry through keys,
 * catch the 429 after it already happened). SEC EDGAR's rate limit is real
 * and was tripped live this session purely from testing volume, not real
 * user traffic — "Request Rate Threshold Exceeded" confirmed via a direct
 * curl. SEC publishes no official numeric quota, so the limit below is a
 * conservative, tuned-to-avoid-that-exact-trip number, not an authoritative
 * figure. Shared across every serverless instance (unlike a per-process
 * counter), which is what actually matters here — the trip that happened
 * was from cumulative load across the whole app, not one hot instance.
 *
 * Fixed-window, not sliding — a real sliding window needs a sorted set and
 * a cleanup pass; a fixed window can allow a short burst right at a window
 * boundary, but that's an acceptable approximation for a safety margin,
 * not a hard contractual limit.
 */
export async function withinBudget(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  try {
    const windowId = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `otto:ratelimit:${bucket}:${windowId}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);
    return count <= limit;
  } catch {
    // Fail open — a rate-limit-check hiccup must never block a real
    // request; worst case we're back to the old reactive-only behavior.
    return true;
  }
}

// Conservative shared budget for SEC EDGAR's data.sec.gov/www.sec.gov
// endpoints — the two real per-candidate hot paths (fetchInsiderActivity,
// fetchSicCode) each call this before firing. 240/min ≈ 4/sec sustained,
// well under any reasonable unofficial guidance, with headroom for the
// market-wide insider feed and filing-excerpt calls that don't check this
// budget (lower-frequency, not the documented cause of the live trip).
export const SEC_EDGAR_BUDGET = { limit: 240, windowSeconds: 60 };

export async function withinSecEdgarBudget(): Promise<boolean> {
  return withinBudget("sec-edgar", SEC_EDGAR_BUDGET.limit, SEC_EDGAR_BUDGET.windowSeconds);
}
