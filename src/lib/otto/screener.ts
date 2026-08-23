import { fetchMostActive, fetchBiggestGainers, type FmpMarketMover, type StockBundle } from "./fmp";
import { fetchFinnhubQuote, fetchFinnhubFundamentals, fetchFinnhubProfile2 } from "./finnhub";
import { fetchSecUniverse, fetchCikForSymbol, type UniverseEntry } from "./sec-universe";
import { computeSnowflake, type OttoSnowflakeScores } from "./snowflake";
import { getScreenerCache } from "./cache";
import { mapWithConcurrency } from "./batch";
import { fetchInsiderActivity, type InsiderActivity } from "./insider";
import { fetchRiskFactorExcerpt } from "./sec-edgar";

export type ScreenIntent = "undervalued" | "momentum" | "best" | "quality" | "avoid";

export interface ScreenerCandidate {
  symbol: string;
  companyName: string;
  price: number;
  compositeScore: number; // 0-100, weighted by intent
  keyStat: string; // short deterministic blurb, no LLM
  thinCoverage: boolean; // ranked without real ratios/keyMetrics data behind it
  insiderActivity?: InsiderActivity; // real Form 4 signal, only checked on semifinalists
  filingNote?: string; // real excerpt from the company's own 10-K, only fetched for the final 5
}

/** Keyword classification — deliberately simple/cheap, no LLM call needed
 * just to decide whether someone is asking to screen the market. */
export function detectScreenIntent(message: string): ScreenIntent | null {
  const m = message.toLowerCase();
  if (/undervalu|cheap stock|discount|value stock|bargain|hidden gem|underrated/.test(m)) return "undervalued";
  if (/rocket|hot stock|momentum|breakout|surging|moonshot/.test(m)) return "momentum";
  if (/\bsafe\b|stable stock|low.?risk|defensive|quality stock/.test(m)) return "quality";
  if (/worst stock|red flag|stocks? to avoid|risky stock|bad stock|what to avoid|\bavoid\b/.test(m)) {
    return "avoid";
  }
  if (/\bpick\b|\brecommend|best stock|good stock|what should i buy|give me a stock/.test(m)) {
    return "best";
  }
  return null;
}

const INTENT_LABELS: Record<ScreenIntent, string> = {
  undervalued: "Undervalued picks",
  momentum: "Momentum picks",
  best: "Otto's top picks",
  quality: "Quality & stability picks",
  avoid: "Stocks to avoid",
};

export function intentLabel(intent: ScreenIntent): string {
  return INTENT_LABELS[intent];
}

export interface ThemeFilter {
  label: string; // e.g. "AI", "healthcare" — shown in the leaderboard title
  key: string; // stable cache-key slug
  industryMatch: RegExp; // tested against Finnhub's finnhubIndustry classification
}

const THEME_FILTERS: ThemeFilter[] = [
  { label: "AI", key: "ai", industryMatch: /semiconductor|software|internet|computer hardware/i },
  { label: "tech", key: "tech", industryMatch: /semiconductor|software|internet|computer|technology|telecommunications/i },
  { label: "healthcare", key: "healthcare", industryMatch: /biotechnology|pharmaceutical|health|medical|drug/i },
  { label: "energy", key: "energy", industryMatch: /oil|gas|energy|utilities/i },
  { label: "financial", key: "financial", industryMatch: /bank|insurance|financial|capital markets|asset management/i },
  { label: "consumer", key: "consumer", industryMatch: /retail|consumer|apparel|restaurant/i },
];

const THEME_TRIGGERS: [RegExp, ThemeFilter][] = [
  [/\bai\b|artificial intelligence/i, THEME_FILTERS[0]],
  [/\btech(nology)?\b/i, THEME_FILTERS[1]],
  [/healthcare|biotech|pharma/i, THEME_FILTERS[2]],
  [/\benergy\b|oil.?(and.?)?gas/i, THEME_FILTERS[3]],
  [/financial|\bbanks?\b|\bbanking\b|insurance/i, THEME_FILTERS[4]],
  [/consumer|retail/i, THEME_FILTERS[5]],
];

/** Runs independently of intent detection — "best AI stocks" combines both
 * (rank by "best" weights, restricted to AI-industry candidates); "AI
 * stocks" alone defaults to the "best" intent with the theme applied. */
export function detectThemeFilter(message: string): ThemeFilter | null {
  const m = message.toLowerCase();
  for (const [pattern, theme] of THEME_TRIGGERS) {
    if (pattern.test(m)) return theme;
  }
  return null;
}

export interface CapFilter {
  label: string; // shown in the leaderboard title
  key: string; // stable cache-key slug
  minMarketCapMillions: number;
}

const CAP_FILTERS: CapFilter[] = [{ label: "mega-cap", key: "mega", minMarketCapMillions: 200_000 }]; // $200B+

const CAP_TRIGGERS: [RegExp, CapFilter][] = [
  [/mega.?cap|giant compan(y|ies)|blue.?chip|(apple|google|tesla|spacex|microsoft|amazon).{0,20}(stock|compan)/i, CAP_FILTERS[0]],
];

/** Runs alongside intent + theme detection — "best mega cap stocks" combines
 * "best" intent with a $200B+ market-cap floor so the pool is restricted to
 * genuine giants (Apple/Google/Tesla-tier) instead of the whole market. */
export function detectCapFilter(message: string): CapFilter | null {
  const m = message.toLowerCase();
  for (const [pattern, cap] of CAP_TRIGGERS) {
    if (pattern.test(m)) return cap;
  }
  return null;
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const LEVERAGED_OR_FUND_NAME = /\b(2X|3X|Bull|Bear|Daily|Leveraged|Inverse|ETF|Trust|Fund|Depositary)\b/i;

/**
 * Anchors on the most prominent slice of the pool (SEC's universe list is
 * empirically ordered roughly mega-cap-first) so real large/mid-cap quality
 * names are always in the scoring pool, then fills the rest with a random
 * sample of the remainder for "hidden gem" diversity. Previously this whole
 * pool was a single `shuffle().slice(0, 20)` — a pure-random draw from 500
 * names that regularly missed every genuinely strong candidate and let a
 * mediocre score (e.g. 58) "win" simply because nothing better was sampled.
 */
function buildCandidatePool(companies: UniverseEntry[], size: number): UniverseEntry[] {
  const anchor = companies.slice(0, Math.min(50, companies.length));
  const rest = companies.slice(anchor.length);
  const extra = shuffle(rest).slice(0, Math.max(size - anchor.length, 0));
  return [...anchor, ...extra];
}

// Bounded concurrency for the wide Stage 1 scan — Finnhub's free tier caps
// each key at 60 req/min, so firing hundreds of candidates via a single
// Promise.all would cascade into mass 429s the instant the pool got wide.
// A worker pool this size keeps the reactive key-rotation actually able to
// keep up as it moves through 5 keys' worth of budget.
const SCORING_CONCURRENCY = 15;
const CLASSIFY_CONCURRENCY = 20;

/**
 * "momentum" pulls from FMP's free /biggest-gainers + /most-actives — a
 * real, live market-wide source that's exactly the right signal for that
 * intent. The other three intents pull from SEC's free company_tickers.json
 * (thousands of real tickers, not a fixed shortlist) since FMP has no free
 * valuation/quality filter endpoint (company-screener, batch quote,
 * sp500-constituent, stock-list are all paid-only — confirmed live).
 */
async function sourceCandidates(
  intent: ScreenIntent,
  theme: ThemeFilter | null,
  capFilter: CapFilter | null = null
): Promise<{ symbol: string; companyName: string }[]> {
  if (intent === "momentum") {
    const [gainers, active] = await Promise.all([fetchBiggestGainers(), fetchMostActive()]);
    const merged = new Map<string, FmpMarketMover>();
    for (const m of [...gainers, ...active]) {
      if (m.price >= 5 && !LEVERAGED_OR_FUND_NAME.test(m.name)) merged.set(m.symbol, m);
    }
    return [...merged.values()].slice(0, 15).map((m) => ({ symbol: m.symbol, companyName: m.name }));
  }

  const universe = await fetchSecUniverse(1000);
  const companies = universe.filter((u) => !LEVERAGED_OR_FUND_NAME.test(u.companyName));

  // Stage 1 of the funnel: hundreds of candidates get a real shot instead
  // of the old 20-80 name sample, now that scoring runs through a bounded
  // worker pool (see SCORING_CONCURRENCY) instead of one giant Promise.all.
  if (!theme && !capFilter) return buildCandidatePool(companies, 300);

  // Theme/cap screens need a much wider initial sample since most
  // candidates get filtered out (a 40-ticker sample only turned up 1 AI
  // match in testing, and $200B+ mega-caps are rare even in a large-cap
  // pool) — one cheap Finnhub profile2 call per candidate (industry +
  // market cap in one shot) decides in/out before spending the heavier
  // quote+metric calls only on actual matches.
  const sample = buildCandidatePool(companies, capFilter ? 350 : 250);
  const classified = await mapWithConcurrency(sample, CLASSIFY_CONCURRENCY, async (c) => {
    const { industry, marketCapMillions } = await fetchFinnhubProfile2(c.symbol);
    if (theme && !(industry && theme.industryMatch.test(industry))) return null;
    if (capFilter && !(marketCapMillions !== null && marketCapMillions >= capFilter.minMarketCapMillions)) {
      return null;
    }
    return c;
  });
  return classified.filter((c): c is { symbol: string; companyName: string } => c !== null).slice(0, 50);
}

/**
 * Builds a StockBundle-compatible object from Finnhub data alone (quote +
 * metric, 2 calls) so the exact same computeSnowflake engine used for
 * single-stock analysis can score screening candidates too — without
 * spending any of FMP's scarce 250/day quota on the wide scan. Finnhub's
 * free tier is 60 req/min, not 250/day, which is what actually makes
 * screening dozens of candidates per request viable.
 */
async function buildFinnhubBundle(symbol: string): Promise<StockBundle | null> {
  const [quote, fundamentals] = await Promise.all([
    fetchFinnhubQuote(symbol),
    fetchFinnhubFundamentals(symbol),
  ]);
  if (!quote) return null;

  return {
    symbol,
    quote: { symbol, name: symbol, price: quote.price, changePercentage: quote.changePercent, marketCap: 0, currency: "USD" },
    profile: null,
    ratios: fundamentals?.ratios ?? null,
    keyMetrics: fundamentals?.keyMetrics ?? null,
    priceTargetConsensus: null,
    gradesConsensus: null,
    historicalMonthly: [],
    income: [],
    cashFlow: [],
  };
}

type SnowflakeAxis = keyof OttoSnowflakeScores;
const AXIS_WEIGHTS: Record<ScreenIntent, Partial<Record<SnowflakeAxis, number>>> = {
  undervalued: { valuation: 2, quality: 1, financialHealth: 1, growth: 0.5, momentum: 0.5 },
  momentum: { momentum: 2, growth: 1.5, quality: 0.5, valuation: 0.3, financialHealth: 0.5 },
  best: { valuation: 1, growth: 1, quality: 1, financialHealth: 1, momentum: 1 },
  quality: { quality: 2, financialHealth: 2, valuation: 0.5, growth: 0.5, momentum: 0.3 },
  // Same composite as "best" — the screen just sorts ascending instead of
  // descending, surfacing the weakest overall scores rather than strongest.
  avoid: { valuation: 1, growth: 1, quality: 1, financialHealth: 1, momentum: 1 },
};

const ASCENDING_INTENTS = new Set<ScreenIntent>(["avoid"]);

function scoreCandidate(intent: ScreenIntent, sf: OttoSnowflakeScores): number {
  const weights = AXIS_WEIGHTS[intent];
  const axes = Object.keys(weights) as SnowflakeAxis[];
  let weightedSum = 0;
  let weightTotal = 0;
  for (const axis of axes) {
    const w = weights[axis] ?? 1;
    weightedSum += sf[axis].score * w;
    weightTotal += 6 * w; // each axis maxes at 6
  }
  return Math.round((weightedSum / weightTotal) * 100);
}

function buildKeyStat(intent: ScreenIntent, bundle: StockBundle, sf: OttoSnowflakeScores): string {
  const pe = bundle.ratios?.priceToEarningsRatio;
  const roic = bundle.keyMetrics?.returnOnInvestedCapital;
  switch (intent) {
    case "undervalued":
      return pe !== undefined
        ? `P/E ${pe.toFixed(1)}x · Valuation ${sf.valuation.score}/6`
        : `Valuation ${sf.valuation.score}/6`;
    case "momentum":
      return `Momentum ${sf.momentum.score}/6 · ${bundle.quote.changePercentage >= 0 ? "+" : ""}${bundle.quote.changePercentage.toFixed(1)}% today`;
    case "quality":
      return roic !== undefined
        ? `ROIC ${(roic * 100).toFixed(1)}% · Health ${sf.financialHealth.score}/6`
        : `Health ${sf.financialHealth.score}/6`;
    case "best":
      return `Composite ${sf.valuation.score + sf.growth.score + sf.quality.score + sf.financialHealth.score + sf.momentum.score}/30 across all axes`;
    case "avoid": {
      const weakest = (Object.entries(sf) as [SnowflakeAxis, { score: number }][]).sort(
        (a, b) => a[1].score - b[1].score
      )[0];
      return `Weakest: ${weakest[0]} ${weakest[1].score}/6`;
    }
  }
}

/**
 * Screens for a given intent: sources ~15-20 candidates (real market movers
 * for momentum via FMP's free lists, an SEC-sourced universe sample
 * otherwise), then scores every candidate the same way regardless of
 * source — via Finnhub's quote + metric endpoints (60 req/min, not FMP's
 * shared 250/day) — so screening never competes with normal ticker lookups
 * for FMP's quota. FMP is only spent later, when a user clicks into one
 * specific pick for the full report. No LLM involved anywhere in this path.
 * Cached 4h per intent bucket so repeated "what's undervalued" questions
 * from anyone share one scan.
 */
export async function runScreener(
  intent: ScreenIntent,
  theme: ThemeFilter | null = null,
  capFilter: CapFilter | null = null,
  onProgress?: (text: string) => void
): Promise<ScreenerCandidate[]> {
  const cacheKey = [intent, theme?.key, capFilter?.key].filter(Boolean).join(":");
  // On a cache hit nothing below runs, so no progress events fire — the
  // scan really is instant then, not staged for show.
  return getScreenerCache<ScreenerCandidate[]>().getOrSet(cacheKey, async () => {
    const pool = await sourceCandidates(intent, theme, capFilter);
    onProgress?.(`Scanning ${pool.length} tickers…`);

    const scored = await mapWithConcurrency(pool, SCORING_CONCURRENCY, async (c): Promise<ScreenerCandidate | null> => {
      try {
        const bundle = await buildFinnhubBundle(c.symbol);
        if (!bundle) return null;
        const sf = computeSnowflake(bundle);
        // Fundamentals coverage, not momentum — Finnhub's /stock/metric
        // returns *something* (trading volume, 52-week range) for nearly
        // every symbol even with zero real financials behind it, so
        // checking ratios/keyMetrics for null isn't enough (confirmed live:
        // ELMT/AIAI/VOGX all return 10-17 metric fields, none of them
        // P/E, margins, or ROIC). The valuation/growth/quality/health axes'
        // actual checks-that-ran count is the real signal.
        const fundamentalsChecksRun =
          sf.valuation.checks.length + sf.growth.checks.length + sf.quality.checks.length + sf.financialHealth.checks.length;
        return {
          symbol: c.symbol,
          companyName: c.companyName,
          price: bundle.quote.price,
          compositeScore: scoreCandidate(intent, sf),
          keyStat: buildKeyStat(intent, bundle, sf),
          // Flagged rather than hidden so a data-starved spike never looks
          // equivalent to a fully-scored pick (the "rocket stock" problem).
          thinCoverage: fundamentalsChecksRun <= 3,
        };
      } catch {
        return null; // one bad candidate shouldn't sink the whole screen
      }
    });

    const ascending = ASCENDING_INTENTS.has(intent);
    const ranked = scored
      .filter((s): s is ScreenerCandidate => s !== null)
      .sort((a, b) => {
        // Fully-scored candidates always outrank thin-coverage ones,
        // regardless of raw composite score — see the comment above.
        if (a.thinCoverage !== b.thinCoverage) return a.thinCoverage ? 1 : -1;
        return ascending ? a.compositeScore - b.compositeScore : b.compositeScore - a.compositeScore;
      });
    onProgress?.(`${ranked.length} cleared fundamentals — narrowing to the leading candidates…`);

    // Stage 3: the expensive real-money check — free SEC Form 4 data on
    // whether insiders have actually bought or sold on the open market in
    // the last 90 days. Only run on the candidates actually in contention
    // for the final 5, so cost stays bounded even as the funnel above
    // widens to hundreds of names.
    const SEMIFINALIST_COUNT = 12;
    const semifinalists = ranked.slice(0, SEMIFINALIST_COUNT);
    const rest = ranked.slice(SEMIFINALIST_COUNT);
    onProgress?.(`Checking insider trading activity on ${semifinalists.length} finalists…`);

    const withInsider = await mapWithConcurrency(semifinalists, 4, async (candidate) => {
      const activity = await fetchInsiderActivity(candidate.symbol).catch(() => null);
      return activity ? { ...candidate, insiderActivity: activity } : candidate;
    });

    // Real insider buying/selling nudges the final ranking rather than
    // overriding the fundamentals score outright — compositeScore itself
    // stays a pure reflection of the Snowflake data so it remains
    // comparable across runs; this only decides ordering among near-tied
    // semifinalists.
    const INSIDER_NUDGE = 4;
    function rankKey(c: ScreenerCandidate): number {
      if (c.insiderActivity?.direction === "buying") return c.compositeScore + INSIDER_NUDGE;
      if (c.insiderActivity?.direction === "selling") return c.compositeScore - INSIDER_NUDGE;
      return c.compositeScore;
    }

    const finalists = [...withInsider, ...rest]
      .sort((a, b) => {
        if (a.thinCoverage !== b.thinCoverage) return a.thinCoverage ? 1 : -1;
        return ascending ? rankKey(a) - rankKey(b) : rankKey(b) - rankKey(a);
      })
      .slice(0, 5);

    // Stage 4: only the actual final 5 get a real 10-K excerpt — purely
    // presentational (doesn't affect ranking, unlike the insider check),
    // so there's no reason to spend it on anyone who didn't make the cut.
    onProgress?.("Reading SEC filings for the top picks…");
    return mapWithConcurrency(finalists, 5, async (candidate) => {
      const cik = await fetchCikForSymbol(candidate.symbol);
      const excerpt = await fetchRiskFactorExcerpt(cik ?? undefined, candidate.symbol).catch(() => null);
      if (!excerpt) return candidate;
      const note = excerpt.length > 160 ? `${excerpt.slice(0, 157).trimEnd()}…` : excerpt;
      return { ...candidate, filingNote: note };
    });
  });
}
