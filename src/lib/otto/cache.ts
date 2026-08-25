import { Redis } from "@upstash/redis";

/**
 * Shared, cross-instance cache (Upstash Redis over REST — works from any
 * serverless runtime, no persistent connection needed). Replaces the old
 * per-process `globalThis` Map: that in-memory cache was invisible across
 * serverless cold starts and instances, which is part of what let the AYI
 * bug happen at all — the screener's instance had a real cached result
 * while the single-stock lookup's instance (a different cold start, no
 * shared state) had nothing to fall back on, seconds apart. Every cache
 * below now shares one real, durable store, namespaced by key prefix so
 * the different logical caches (FMP bundles, screener results, symbol
 * snapshots, ...) can't collide inside Redis's single flat keyspace.
 *
 * Every read/write is now a network round-trip, so `get`/`set` are async
 * (`getOrSet` already was) — callers must `await` them.
 */
// Exported so other modules that need raw Redis commands (observability.ts's
// counters/lists — INCR/LPUSH aren't expressible through the get/set-only
// TtlCache below) reuse this same client instead of opening a second one.
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

class TtlCache<T> {
  // In-flight request coalescing (single-flight) — per-process, not shared
  // across serverless instances the way the Redis cache itself is, but it
  // catches the common real case: N concurrent requests to the SAME warm
  // instance during a cache miss (e.g. 10 people asking "best pick" at once
  // right after the 4h screener cache expired) previously each ran their
  // own full scan independently. Now the first caller's promise is shared
  // with every concurrent caller for the same key instead of each paying
  // for a duplicate scan.
  private inFlight = new Map<string, Promise<T>>();

  constructor(
    private namespace: string,
    private ttlMs: number
  ) {}

  private fullKey(key: string): string {
    return `otto:${this.namespace}:${key}`;
  }

  async get(key: string): Promise<T | undefined> {
    try {
      const value = await redis.get<T>(this.fullKey(key));
      return value === null ? undefined : value;
    } catch {
      // Best-effort cache — a Redis hiccup should degrade to "cache miss",
      // never to a broken request. Every caller already handles a miss by
      // re-fetching from the real source.
      return undefined;
    }
  }

  async set(key: string, value: T, ttlOverrideMs?: number): Promise<void> {
    try {
      await redis.set(this.fullKey(key), value, { px: ttlOverrideMs ?? this.ttlMs });
    } catch {
      // Fail soft — losing a cache write is a performance cost, not a
      // correctness one.
    }
  }

  async getOrSet(key: string, fn: () => Promise<T>): Promise<T> {
    const cached = await this.get(key);
    if (cached !== undefined) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const value = await fn();
        await this.set(key, value);
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }
}

// One singleton per logical cache, reused across requests within the same
// process — the TtlCache instances themselves hold no local state (all
// reads/writes go straight to Redis), so this is just avoiding
// re-constructing the same thin wrapper repeatedly, not a caching layer
// of its own.
const globalForCache = globalThis as unknown as {
  __ottoFmpCache?: TtlCache<unknown>;
  __ottoAnalysisCache?: TtlCache<unknown>;
  __ottoFilingCache?: TtlCache<unknown>;
  __ottoMacroCache?: TtlCache<unknown>;
  __ottoScreenerCache?: TtlCache<unknown>;
  __ottoUniverseCache?: TtlCache<unknown>;
  __ottoInsiderCache?: TtlCache<unknown>;
  __ottoInsiderFeedCache?: TtlCache<unknown>;
  __ottoPeerCache?: TtlCache<unknown>;
  __ottoEarningsCache?: TtlCache<unknown>;
  __ottoShortInterestCache?: TtlCache<unknown>;
  __ottoSymbolScoreCache?: TtlCache<unknown>;
  __ottoFinnhubFundamentalsCache?: TtlCache<unknown>;
  __ottoDailyPriceCache?: TtlCache<unknown>;
};

export function getFmpCache<T>(): TtlCache<T> {
  globalForCache.__ottoFmpCache ??= new TtlCache("fmp", 30 * 60 * 1000); // 30 min
  return globalForCache.__ottoFmpCache as TtlCache<T>;
}

export function getAnalysisCache<T>(): TtlCache<T> {
  globalForCache.__ottoAnalysisCache ??= new TtlCache("analysis", 24 * 60 * 60 * 1000); // 24 h
  return globalForCache.__ottoAnalysisCache as TtlCache<T>;
}

export function getFilingCache<T>(): TtlCache<T> {
  // Filings change quarterly at most — cache aggressively, both to avoid
  // re-downloading multi-MB documents and to be a good SEC.gov citizen.
  globalForCache.__ottoFilingCache ??= new TtlCache("filing", 7 * 24 * 60 * 60 * 1000); // 7 days
  return globalForCache.__ottoFilingCache as TtlCache<T>;
}

export function getMacroCache<T>(): TtlCache<T> {
  // Ticker-agnostic — one shared entry. Treasury yields move daily, so
  // this needs a shorter TTL than the filing cache.
  globalForCache.__ottoMacroCache ??= new TtlCache("macro", 6 * 60 * 60 * 1000); // 6 h
  return globalForCache.__ottoMacroCache as TtlCache<T>;
}

export function getScreenerCache<T>(): TtlCache<T> {
  // Keyed by intent bucket (not raw query text) so differently-worded but
  // same-intent questions ("undervalued" / "cheap stocks") share one scan —
  // the whole point of screening is to NOT re-scan hundreds of tickers per
  // question asked.
  globalForCache.__ottoScreenerCache ??= new TtlCache("screener", 4 * 60 * 60 * 1000); // 4 h
  return globalForCache.__ottoScreenerCache as TtlCache<T>;
}

export function getUniverseCache<T>(): TtlCache<T> {
  // SEC's full ticker list barely changes day to day — cache long.
  globalForCache.__ottoUniverseCache ??= new TtlCache("universe", 24 * 60 * 60 * 1000); // 24 h
  return globalForCache.__ottoUniverseCache as TtlCache<T>;
}

export function getInsiderCache<T>(): TtlCache<T> {
  // New Form 4s land daily for active issuers, but a 90-day trailing window
  // doesn't meaningfully shift hour to hour — cache long enough to spare
  // SEC's servers on repeated screens without going stale within a session.
  globalForCache.__ottoInsiderCache ??= new TtlCache("insider", 12 * 60 * 60 * 1000); // 12 h
  return globalForCache.__ottoInsiderCache as TtlCache<T>;
}

export function getInsiderFeedCache<T>(): TtlCache<T> {
  // The market-wide Form 4 feed is genuinely live (new filings land
  // continuously), unlike the 12h-cached per-company insider check —
  // refresh every 30 min so a screen doesn't go stale within a session but
  // repeated requests in a short window still share one ~100-filing scan.
  globalForCache.__ottoInsiderFeedCache ??= new TtlCache("insider-feed", 30 * 60 * 1000); // 30 min
  return globalForCache.__ottoInsiderFeedCache as TtlCache<T>;
}

export function getEarningsCache<T>(): TtlCache<T> {
  // Next earnings date and beat/miss history change at most once per
  // quarter — cache long, refreshed daily just to catch date confirmations.
  globalForCache.__ottoEarningsCache ??= new TtlCache("earnings", 24 * 60 * 60 * 1000); // 24 h
  return globalForCache.__ottoEarningsCache as TtlCache<T>;
}

export function getShortInterestCache<T>(): TtlCache<T> {
  // FINRA only republishes this biweekly — no reason to refetch same-day.
  globalForCache.__ottoShortInterestCache ??= new TtlCache("short-interest", 24 * 60 * 60 * 1000); // 24 h
  return globalForCache.__ottoShortInterestCache as TtlCache<T>;
}

export function getSymbolScoreCache<T>(): TtlCache<T> {
  // Per-symbol Snowflake snapshot (quote+fundamentals+score), independent of
  // which screen intent asked for it — a stock scanned in "best" and then
  // "quality" 10 minutes later reuses the same fetch instead of re-hitting
  // Finnhub twice. Now genuinely shared across every serverless instance,
  // not just within one — this is also what getCachedScreenerScore/
  // getCachedScreenerSnapshot read from for the reconciliation-note and
  // score-divergence checks.
  globalForCache.__ottoSymbolScoreCache ??= new TtlCache("symbol-score", 45 * 60 * 1000); // 45 min
  return globalForCache.__ottoSymbolScoreCache as TtlCache<T>;
}

export function getFinnhubFundamentalsCache<T>(): TtlCache<T> {
  // Cached at the source (inside fetchFinnhubFundamentals itself), not per
  // caller — so the screener's scan and a single-stock lookup for the same
  // symbol share one real result instead of each risking its own fetch
  // failure independently, and now that sharing is real across instances
  // too (confirmed live pre-Redis: AYI's screener entry had real data while
  // its single-stock card, fetched moments later on a different instance,
  // didn't — this closes that gap by construction, not just by luck of
  // landing on the same warm instance).
  globalForCache.__ottoFinnhubFundamentalsCache ??= new TtlCache("finnhub-fundamentals", 30 * 60 * 1000); // 30 min
  return globalForCache.__ottoFinnhubFundamentalsCache as TtlCache<T>;
}

export function getDailyPriceCache<T>(): TtlCache<T> {
  // Keyed by symbol — shared across every screen's correlation check within
  // a 4h window, matching the screener cache's own lifetime, so repeated
  // scans don't refetch the same ~10 finalist-candidates' daily bars.
  globalForCache.__ottoDailyPriceCache ??= new TtlCache("daily-price", 4 * 60 * 60 * 1000); // 4 h
  return globalForCache.__ottoDailyPriceCache as TtlCache<T>;
}

export function getPeerCache<T>(): TtlCache<T> {
  // Keyed by SIC code, not symbol — every stock in the same industry
  // reuses one peer scan per day, which is what makes a ~60-candidate SEC
  // classification pass affordable inside a single-stock lookup at all.
  globalForCache.__ottoPeerCache ??= new TtlCache("peer", 24 * 60 * 60 * 1000); // 24 h
  return globalForCache.__ottoPeerCache as TtlCache<T>;
}
