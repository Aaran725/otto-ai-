import { getUniverseCache } from "./cache";

const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? "Otto AI research@ottoai.app";

interface SecTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

export interface UniverseEntry {
  symbol: string;
  companyName: string;
}

/**
 * SEC's company_tickers.json is free, unlimited, no API key — a complete
 * list of SEC-registered tickers, empirically ordered roughly by prominence
 * (mega-caps first: NVDA/AAPL/GOOGL/MSFT/AMZN topped it in testing). This
 * replaces relying on FMP's /stock-list or /sp500-constituent, which are
 * both paid-only on this plan (confirmed live, not a quota artifact).
 *
 * The ordering isn't rigorously guaranteed beyond the first few entries, so
 * this is treated as "a reasonable large-cap-weighted pool", not a precise
 * ranked list — the real quality filtering still happens downstream via the
 * deterministic Snowflake scoring on each candidate.
 */
export async function fetchSecUniverse(limit = 500): Promise<UniverseEntry[]> {
  return getUniverseCache<UniverseEntry[]>().getOrSet(`sec-universe:${limit}`, async () => {
    try {
      const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
        headers: { "User-Agent": SEC_USER_AGENT },
        next: { revalidate: 86400 },
      });
      if (!res.ok) return [];

      const data = (await res.json()) as Record<string, SecTickerEntry>;
      const entries: UniverseEntry[] = [];

      for (const entry of Object.values(data)) {
        // Plausibility filter: skip obvious non-standard listings (foreign
        // ADRs with suffixes, very short/odd symbols) that tend to have thin
        // or unavailable fundamentals anyway.
        if (!/^[A-Z]{1,5}$/.test(entry.ticker)) continue;
        entries.push({ symbol: entry.ticker, companyName: entry.title });
        if (entries.length >= limit) break;
      }

      return entries;
    } catch {
      return [];
    }
  });
}

/**
 * Full ticker → 10-digit zero-padded CIK map, used to resolve a symbol to
 * the identifier SEC's filing APIs (submissions, Form 4 documents) require.
 * Unlike fetchSecUniverse this is unlimited/unfiltered — a small-cap needed
 * for an insider-activity lookup shouldn't be missing just because it fell
 * outside the mega-cap-weighted screener sample.
 */
// A plain object, not a Map — the cache is now Redis-backed (JSON over the
// wire), and a Map doesn't survive a JSON round-trip (it serializes to "{}"
// and deserializes as a plain object anyway, so a cached Map silently loses
// all its data and any later `.get()` on it throws "not a function").
// Confirmed live during the Redis migration.
async function fetchCikMap(): Promise<Record<string, string>> {
  return getUniverseCache<Record<string, string>>().getOrSet("sec-cik-map", async () => {
    try {
      const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
        headers: { "User-Agent": SEC_USER_AGENT },
        next: { revalidate: 86400 },
      });
      if (!res.ok) return {};

      const data = (await res.json()) as Record<string, SecTickerEntry>;
      const map: Record<string, string> = {};
      for (const entry of Object.values(data)) {
        map[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, "0");
      }
      return map;
    } catch {
      return {};
    }
  });
}

export async function fetchCikForSymbol(symbol: string): Promise<string | null> {
  const map = await fetchCikMap();
  return map[symbol.toUpperCase()] ?? null;
}

async function fetchFullNamedUniverse(): Promise<UniverseEntry[]> {
  return getUniverseCache<UniverseEntry[]>().getOrSet("sec-universe:full", async () => {
    try {
      const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
        headers: { "User-Agent": SEC_USER_AGENT },
        next: { revalidate: 86400 },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as Record<string, SecTickerEntry>;
      return Object.values(data)
        .filter((e) => /^[A-Z]{1,5}$/.test(e.ticker))
        .map((e) => ({ symbol: e.ticker, companyName: e.title }));
    } catch {
      return [];
    }
  });
}

/**
 * Free company-name → ticker fallback for when FMP's /search-name is down —
 * a plain word-overlap match against SEC's full ~10k-ticker universe
 * (company_tickers.json already includes the registered company title).
 * Cruder than FMP's real search (no fuzzy matching, no relevance ranking
 * beyond "most words matched"), but free and needs no external quota.
 */
// Deliberately wide — this is a last-resort fallback, so it needs to reject
// generic chat phrasing ("any", "does", "stocks") confidently, not just
// obvious noise. A real bug caught this list being too small: "any rocket
// stocks?" matched Wells Fargo & Company because a bare substring check let
// "any" match inside "compANY" — word-boundary matching (below) closes that
// specific hole, but a short query word still needs to be a real word this
// generic list correctly excludes, not just "not a stopword."
const NAME_SEARCH_STOPWORDS = new Set([
  "the", "inc", "corp", "ltd", "llc", "plc", "co", "company", "companies",
  "stock", "stocks", "shares", "share", "share's", "any", "some", "all",
  "does", "did", "what", "whats", "which", "who", "how", "why", "when",
  "about", "give", "show", "find", "tell", "your", "you", "and", "for",
  "with", "this", "that", "best", "good", "rocket", "hot", "top",
]);

export async function searchSecUniverseByName(query: string): Promise<UniverseEntry | null> {
  const universe = await fetchFullNamedUniverse();
  const queryWords = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    // A bare number ("100", "500", "2000") is common in fund/index names
    // (Nasdaq 100, S&P 500, Russell 2000) but far too generic on its own to
    // signal a real company mention — same class of bug as the "any rocket
    // stocks?" -> Wells Fargo & Company misfire this filter already guards.
    .filter((w) => w.length > 2 && !NAME_SEARCH_STOPWORDS.has(w) && !/^\d+$/.test(w));
  if (queryWords.length === 0) return null;

  let best: UniverseEntry | null = null;
  let bestScore = 0;
  for (const entry of universe) {
    const nameLower = entry.companyName.toLowerCase();
    // Word-boundary match, not a raw substring check — a bare `.includes()`
    // let "any" match inside "compANY" (confirmed live: misrouted "any
    // rocket stocks?" to Wells Fargo & Company instead of the screener).
    const score = queryWords.filter((w) => new RegExp(`\\b${w}\\b`).test(nameLower)).length;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  // Require at least one real word match of meaningful length — guards
  // against a single short/common word coincidentally naming a company.
  return bestScore > 0 && queryWords.some((w) => w.length >= 4) ? best : null;
}

// Plain object, same reasoning as fetchCikMap above — a Map doesn't survive
// the Redis JSON round-trip.
async function fetchTickerByCikMap(): Promise<Record<string, string>> {
  return getUniverseCache<Record<string, string>>().getOrSet("sec-ticker-by-cik-map", async () => {
    try {
      const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
        headers: { "User-Agent": SEC_USER_AGENT },
        next: { revalidate: 86400 },
      });
      if (!res.ok) return {};
      const data = (await res.json()) as Record<string, SecTickerEntry>;
      const map: Record<string, string> = {};
      for (const entry of Object.values(data)) {
        map[String(entry.cik_str).padStart(10, "0")] = entry.ticker;
      }
      return map;
    } catch {
      return {};
    }
  });
}

export async function fetchTickerForCik(cik: string): Promise<string | null> {
  const map = await fetchTickerByCikMap();
  return map[cik.padStart(10, "0")] ?? null;
}

/**
 * SEC EDGAR's own browse-by-SIC endpoint — a direct list of real companies
 * classified under a given SIC code, instead of blind-sampling the full
 * ~10k-ticker universe and hoping enough land in the right industry. That
 * random-sampling approach failed live for AAPL (SIC 3571 "Electronic
 * Computers" turned out to have so few members that a 90-candidate random
 * draw from 2000 tickers usually catches zero) — this endpoint returns the
 * real population directly, no luck involved.
 */
/** One page (max 100, EDGAR's own cap) of the browse-by-SIC results. */
async function fetchCiksBySicPage(sic: string, start: number): Promise<string[]> {
  try {
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&SIC=${encodeURIComponent(sic)}&type=10-K&dateb=&owner=include&count=100&start=${start}&output=atom`;
    const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT } });
    if (!res.ok) return [];
    const xml = await res.text();
    return [...xml.matchAll(/<cik>(\d+)<\/cik>/g)].map((m) => m[1].padStart(10, "0"));
  } catch {
    return [];
  }
}

/**
 * Most CIKs under a given SIC code turn out to be delisted/inactive filers
 * with no current ticker (confirmed live: SIC 3571 "Electronic Computers"
 * returned 113 CIKs across 3 pages but only 8 resolved to an active ticker,
 * ~7% hit rate) — a single 100-result page usually isn't enough. Paginates
 * up to 3 pages (300 raw CIKs) so there's a real shot at enough resolvable
 * peers even for a narrow/legacy SIC bucket.
 */
export async function fetchCiksBySic(sic: string): Promise<string[]> {
  return getUniverseCache<string[]>().getOrSet(`ciks-by-sic:${sic}`, async () => {
    const pages = await Promise.all([0, 100, 200].map((start) => fetchCiksBySicPage(sic, start)));
    return [...new Set(pages.flat())];
  });
}

interface SecSubmissionsClassification {
  sic?: string;
  sicDescription?: string;
}

export interface SicClassification {
  sic: string;
  description: string;
}

/**
 * SEC's own SIC (Standard Industrial Classification) code, pulled from the
 * same submissions.json already used for insider-activity lookups. Far more
 * useful for peer grouping than Finnhub's free /profile2 industry field,
 * which lumps CRWD, PANW, and NVDA all under one "Technology" bucket
 * (confirmed live) — SIC 7372 ("Prepackaged Software") vs 3577 ("Computer
 * Peripheral Equipment") vs 3674 ("Semiconductors") actually separates them.
 */
export async function fetchSicCode(symbol: string): Promise<SicClassification | null> {
  return getUniverseCache<SicClassification | null>().getOrSet(`sic:${symbol.toUpperCase()}`, async () => {
    const cik = await fetchCikForSymbol(symbol);
    if (!cik) return null;
    try {
      // No Next.js fetch-cache hint — large filers' submissions.json can run
      // several MB, past Next's 2MB fetch-cache ceiling (confirmed live);
      // the getOrSet TtlCache above already caches this without that limit.
      const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
        headers: { "User-Agent": SEC_USER_AGENT },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as SecSubmissionsClassification;
      if (!data.sic) return null;
      return { sic: data.sic, description: data.sicDescription ?? data.sic };
    } catch {
      return null;
    }
  });
}
