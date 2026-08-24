interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  constructor(private ttlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlOverrideMs?: number) {
    this.store.set(key, { value, expiresAt: Date.now() + (ttlOverrideMs ?? this.ttlMs) });
  }

  async getOrSet(key: string, fn: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await fn();
    this.set(key, value);
    return value;
  }
}

// Module-level singletons: survive across requests within the same Next.js
// dev/server process (in-memory only — resets on restart, fine for free-tier
// quota protection on a single-instance deployment).
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
};

export function getFmpCache<T>(): TtlCache<T> {
  globalForCache.__ottoFmpCache ??= new TtlCache(30 * 60 * 1000); // 30 min
  return globalForCache.__ottoFmpCache as TtlCache<T>;
}

export function getAnalysisCache<T>(): TtlCache<T> {
  globalForCache.__ottoAnalysisCache ??= new TtlCache(24 * 60 * 60 * 1000); // 24 h
  return globalForCache.__ottoAnalysisCache as TtlCache<T>;
}

export function getFilingCache<T>(): TtlCache<T> {
  // Filings change quarterly at most — cache aggressively, both to avoid
  // re-downloading multi-MB documents and to be a good SEC.gov citizen.
  globalForCache.__ottoFilingCache ??= new TtlCache(7 * 24 * 60 * 60 * 1000); // 7 days
  return globalForCache.__ottoFilingCache as TtlCache<T>;
}

export function getMacroCache<T>(): TtlCache<T> {
  // Ticker-agnostic — one shared entry. Treasury yields move daily, so
  // this needs a shorter TTL than the filing cache.
  globalForCache.__ottoMacroCache ??= new TtlCache(6 * 60 * 60 * 1000); // 6 h
  return globalForCache.__ottoMacroCache as TtlCache<T>;
}

export function getScreenerCache<T>(): TtlCache<T> {
  // Keyed by intent bucket (not raw query text) so differently-worded but
  // same-intent questions ("undervalued" / "cheap stocks") share one scan —
  // the whole point of screening is to NOT re-scan hundreds of tickers per
  // question asked.
  globalForCache.__ottoScreenerCache ??= new TtlCache(4 * 60 * 60 * 1000); // 4 h
  return globalForCache.__ottoScreenerCache as TtlCache<T>;
}

export function getUniverseCache<T>(): TtlCache<T> {
  // SEC's full ticker list barely changes day to day — cache long.
  globalForCache.__ottoUniverseCache ??= new TtlCache(24 * 60 * 60 * 1000); // 24 h
  return globalForCache.__ottoUniverseCache as TtlCache<T>;
}

export function getInsiderCache<T>(): TtlCache<T> {
  // New Form 4s land daily for active issuers, but a 90-day trailing window
  // doesn't meaningfully shift hour to hour — cache long enough to spare
  // SEC's servers on repeated screens without going stale within a session.
  globalForCache.__ottoInsiderCache ??= new TtlCache(12 * 60 * 60 * 1000); // 12 h
  return globalForCache.__ottoInsiderCache as TtlCache<T>;
}

export function getInsiderFeedCache<T>(): TtlCache<T> {
  // The market-wide Form 4 feed is genuinely live (new filings land
  // continuously), unlike the 12h-cached per-company insider check —
  // refresh every 30 min so a screen doesn't go stale within a session but
  // repeated requests in a short window still share one ~100-filing scan.
  globalForCache.__ottoInsiderFeedCache ??= new TtlCache(30 * 60 * 1000); // 30 min
  return globalForCache.__ottoInsiderFeedCache as TtlCache<T>;
}

export function getEarningsCache<T>(): TtlCache<T> {
  // Next earnings date and beat/miss history change at most once per
  // quarter — cache long, refreshed daily just to catch date confirmations.
  globalForCache.__ottoEarningsCache ??= new TtlCache(24 * 60 * 60 * 1000); // 24 h
  return globalForCache.__ottoEarningsCache as TtlCache<T>;
}

export function getShortInterestCache<T>(): TtlCache<T> {
  // FINRA only republishes this biweekly — no reason to refetch same-day.
  globalForCache.__ottoShortInterestCache ??= new TtlCache(24 * 60 * 60 * 1000); // 24 h
  return globalForCache.__ottoShortInterestCache as TtlCache<T>;
}

export function getSymbolScoreCache<T>(): TtlCache<T> {
  // Per-symbol Snowflake snapshot (quote+fundamentals+score), independent of
  // which screen intent asked for it — a stock scanned in "best" and then
  // "quality" 10 minutes later reuses the same fetch instead of re-hitting
  // Finnhub twice. This is what pays for widening the candidate pool: repeat
  // symbols across screens (and across a session's worth of scans) become
  // free instead of linear in the number of screens run.
  globalForCache.__ottoSymbolScoreCache ??= new TtlCache(45 * 60 * 1000); // 45 min
  return globalForCache.__ottoSymbolScoreCache as TtlCache<T>;
}

export function getFinnhubFundamentalsCache<T>(): TtlCache<T> {
  // Cached at the source (inside fetchFinnhubFundamentals itself), not per
  // caller — so the screener's scan and a single-stock lookup for the same
  // symbol share one real result instead of each risking its own fetch
  // failure independently. This is what makes the single-stock path's
  // Finnhub fallback benefit from the screener already having succeeded on
  // the same ticker minutes earlier (confirmed live: AYI's screener entry
  // had real data while its single-stock card, fetched moments later,
  // didn't — this closes that gap by construction).
  globalForCache.__ottoFinnhubFundamentalsCache ??= new TtlCache(30 * 60 * 1000); // 30 min
  return globalForCache.__ottoFinnhubFundamentalsCache as TtlCache<T>;
}

export function getPeerCache<T>(): TtlCache<T> {
  // Keyed by SIC code, not symbol — every stock in the same industry
  // reuses one peer scan per day, which is what makes a ~60-candidate SEC
  // classification pass affordable inside a single-stock lookup at all.
  globalForCache.__ottoPeerCache ??= new TtlCache(24 * 60 * 60 * 1000); // 24 h
  return globalForCache.__ottoPeerCache as TtlCache<T>;
}
