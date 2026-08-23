import { fetchMostActive, fetchBiggestGainers, type FmpRatios, type FmpKeyMetrics, type StockBundle } from "./fmp";
import {
  fetchFinnhubQuote,
  fetchFinnhubFundamentals,
  fetchFinnhubProfile2,
  fetchFinnhubRatingTrend,
  fetchFinnhubFinancialsTrend,
} from "./finnhub";
import { fetchSecUniverse, fetchCikForSymbol, type UniverseEntry } from "./sec-universe";
import { computeSnowflake, type OttoSnowflakeScores } from "./snowflake";
import { getScreenerCache, getSymbolScoreCache } from "./cache";
import { mapWithConcurrency } from "./batch";
import { fetchInsiderActivity, type InsiderActivity } from "./insider";
import { fetchInsiderClusterFeed, type InsiderClusterEntry } from "./insider-feed";
import { fetchRiskFactorExcerpt } from "./sec-edgar";
import { fetchMacroContext } from "./fred";
import { fetchPeerValuation } from "./peers";
import type { ProgressFn } from "./chat-types";
import type { ScreenQueryRequirements } from "./screen-query";

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
  if (
    /\bpick\b|\brecommend|best stock|good stock|what should i buy|give me a stock|find (me |us )?(a |some )?(good |great |strong |solid )?stocks?|upside potential|massive (gains|upside|growth|potential)|growth potential|high(est)? potential stock|next (big|great) stock|winning stock|strong stock|stocks? (worth buying|to buy)|invest in/.test(
      m
    )
  ) {
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

// Deterministic PRNG (mulberry32) seeded with a fixed constant — not
// Math.random(). A screen's candidate pool is now a *stable, reproducible*
// draw: the same "extra" slice of the universe every time, so a re-scan
// after the cache expires surfaces the same ranking unless the underlying
// market data actually changed, instead of a fresh random sample that could
// miss a genuinely strong candidate purely by luck of the draw.
function mulberry32(seed: number) {
  let state = seed | 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const POOL_SEED = 20260101;

function seededShuffle<T>(arr: T[]): T[] {
  const random = mulberry32(POOL_SEED);
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const LEVERAGED_OR_FUND_NAME = /\b(2X|3X|Bull|Bear|Daily|Leveraged|Inverse|ETF|Trust|Fund|Depositary)\b/i;

/**
 * Anchors on the most prominent slice of the pool (SEC's universe list is
 * empirically ordered roughly mega-cap-first) so real large/mid-cap quality
 * names are always in the scoring pool, then fills the rest with a
 * deterministically-seeded sample of the remainder for "hidden gem"
 * diversity — reproducible run to run, unlike a fresh Math.random() draw.
 */
function buildCandidatePool(companies: UniverseEntry[], size: number): UniverseEntry[] {
  const anchor = companies.slice(0, Math.min(50, companies.length));
  const rest = companies.slice(anchor.length);
  const extra = seededShuffle(rest).slice(0, Math.max(size - anchor.length, 0));
  return [...anchor, ...extra];
}

// Bounded concurrency for the wide Stage 1 scan — Finnhub's free tier caps
// each key at 60 req/min, so firing hundreds of candidates via a single
// Promise.all would cascade into mass 429s the instant the pool got wide.
// A worker pool this size keeps the reactive key-rotation actually able to
// keep up as it moves through 5 keys' worth of budget.
const SCORING_CONCURRENCY = 15;
const CLASSIFY_CONCURRENCY = 20;

// Below this, a nano-cap "momentum" candidate sourced from the general
// universe (rather than today's gainers/actives list) is dropped before it
// even reaches scoring — thinly-traded micro-caps dominate the raw
// gainers/actives feed with 1-day spikes that don't reflect a real,
// tradeable trend.
const MOMENTUM_UNIVERSE_CAP_FLOOR_MILLIONS = 300;

/**
 * "momentum" pulls from FMP's free /biggest-gainers + /most-actives — a
 * real, live market-wide source, but on its own that only ever catches
 * *today's* spike (confirmed live: single-day 300%+ moves in thinly-traded
 * names dominating the list). It's supplemented with a deterministic sample
 * of the general universe, cap-floored and scored on the same real 13/26-
 * week trailing returns as everyone else (see snowflake.ts), so a stock
 * with a genuine sustained multi-week trend has a real shot at the list too
 * — not just whatever moved most in the last session. The other three
 * intents pull from SEC's free company_tickers.json (thousands of real
 * tickers, not a fixed shortlist) since FMP has no free valuation/quality
 * filter endpoint (company-screener, batch quote, sp500-constituent,
 * stock-list are all paid-only — confirmed live).
 */
async function sourceCandidates(
  intent: ScreenIntent,
  theme: ThemeFilter | null,
  capFilter: CapFilter | null = null,
  seedTickers: { symbol: string; companyName: string }[] = []
): Promise<{ symbol: string; companyName: string }[]> {
  // seedTickers come from the LLM query-interpreter (see screen-query.ts) —
  // already independently verified against a live quote before reaching
  // here, so they're unioned straight into the pool regardless of source,
  // bypassing the industry-keyword classify (which is too coarse to catch a
  // specific niche like "physical AI" on its own — Tesla's Finnhub industry
  // is "Auto Manufacturers", not "robotics"). A capFilter is still honored
  // for seeds so "mega cap physical AI stocks" doesn't let a small-cap seed
  // through.
  async function unionSeeds(pool: { symbol: string; companyName: string }[]) {
    if (seedTickers.length === 0) return pool;
    const merged = new Map(pool.map((c) => [c.symbol, c]));
    for (const s of seedTickers) {
      if (merged.has(s.symbol)) continue;
      if (capFilter) {
        const { marketCapMillions } = await fetchFinnhubProfile2(s.symbol);
        if (marketCapMillions === null || marketCapMillions < capFilter.minMarketCapMillions) continue;
      }
      merged.set(s.symbol, s);
    }
    return [...merged.values()];
  }

  if (intent === "momentum") {
    const [gainers, active, universe] = await Promise.all([
      fetchBiggestGainers(),
      fetchMostActive(),
      fetchSecUniverse(1000),
    ]);
    const merged = new Map<string, { symbol: string; companyName: string }>();
    for (const m of [...gainers, ...active]) {
      if (m.price >= 5 && !LEVERAGED_OR_FUND_NAME.test(m.name)) merged.set(m.symbol, { symbol: m.symbol, companyName: m.name });
    }

    const companies = universe.filter((u) => !LEVERAGED_OR_FUND_NAME.test(u.companyName));
    const sample = buildCandidatePool(companies, 150);
    const classified = await mapWithConcurrency(sample, CLASSIFY_CONCURRENCY, async (c) => {
      if (merged.has(c.symbol)) return null; // already covered via gainers/actives
      const { marketCapMillions } = await fetchFinnhubProfile2(c.symbol);
      return marketCapMillions !== null && marketCapMillions >= MOMENTUM_UNIVERSE_CAP_FLOOR_MILLIONS ? c : null;
    });
    for (const c of classified) if (c) merged.set(c.symbol, c);

    return unionSeeds([...merged.values()]);
  }

  const universe = await fetchSecUniverse(1000);
  const companies = universe.filter((u) => !LEVERAGED_OR_FUND_NAME.test(u.companyName));

  // Stage 1 of the funnel: hundreds of candidates get a real shot instead
  // of the old 20-80 name sample, now that scoring runs through a bounded
  // worker pool (see SCORING_CONCURRENCY) instead of one giant Promise.all.
  // Widened again once per-symbol score caching (getSymbolScoreCache) meant
  // a symbol scanned by one screen is free the next time any other screen
  // scans it — the budget that pays for wider coverage.
  // A seed-only request (theme/cap absent but the LLM named specific real
  // companies) must NOT also fall through to the full unfiltered market —
  // that would dilute a focused custom screen with random unrelated names
  // that just happened to score well on generic fundamentals.
  if (!theme && !capFilter) return seedTickers.length > 0 ? unionSeeds([]) : unionSeeds(buildCandidatePool(companies, 450));

  // Theme/cap screens need a much wider initial sample since most
  // candidates get filtered out (a 40-ticker sample only turned up 1 AI
  // match in testing, and $200B+ mega-caps are rare even in a large-cap
  // pool) — one cheap Finnhub profile2 call per candidate (industry +
  // market cap in one shot) decides in/out before spending the heavier
  // quote+metric calls only on actual matches.
  const sample = buildCandidatePool(companies, capFilter ? 500 : 380);
  const classified = await mapWithConcurrency(sample, CLASSIFY_CONCURRENCY, async (c) => {
    const { industry, marketCapMillions } = await fetchFinnhubProfile2(c.symbol);
    if (theme && !(industry && theme.industryMatch.test(industry))) return null;
    if (capFilter && !(marketCapMillions !== null && marketCapMillions >= capFilter.minMarketCapMillions)) {
      return null;
    }
    return c;
  });
  return unionSeeds(classified.filter((c): c is { symbol: string; companyName: string } => c !== null).slice(0, 50));
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
    quote: {
      symbol,
      name: symbol,
      price: quote.price,
      changePercentage: quote.changePercent,
      marketCap: 0,
      currency: "USD",
      // Real 52-week high/low from the same /stock/metric call — activates
      // the Snowflake momentum axis's "within 25% of 52-week high" check
      // with real data instead of leaving it unscoreable.
      yearHigh: fundamentals?.week52High,
      yearLow: fundamentals?.week52Low,
    },
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

interface SymbolSnapshot {
  price: number;
  ratios: FmpRatios | null;
  keyMetrics: FmpKeyMetrics | null;
  changePercentage: number;
  sf: OttoSnowflakeScores;
  fundamentalsChecksRun: number;
}

/**
 * Per-symbol, intent-agnostic snapshot (quote + fundamentals + Snowflake
 * scores) — cached independently of which screen asked for it, so a symbol
 * scanned in "best" and then "quality" 10 minutes later is free the second
 * time (see getSymbolScoreCache). Intent-specific ranking (compositeScore,
 * keyStat) is derived from this shared snapshot per-screen, not cached here.
 */
async function getSymbolSnapshot(symbol: string): Promise<SymbolSnapshot | null> {
  return getSymbolScoreCache<SymbolSnapshot | null>().getOrSet(symbol, async () => {
    const bundle = await buildFinnhubBundle(symbol);
    if (!bundle) return null;
    const sf = computeSnowflake(bundle);
    const fundamentalsChecksRun =
      sf.valuation.checks.length + sf.growth.checks.length + sf.quality.checks.length + sf.financialHealth.checks.length;
    return {
      price: bundle.quote.price,
      ratios: bundle.ratios,
      keyMetrics: bundle.keyMetrics,
      changePercentage: bundle.quote.changePercentage,
      sf,
      fundamentalsChecksRun,
    };
  });
}

type SnowflakeAxis = keyof OttoSnowflakeScores;
// Base weights, chosen to mirror real factor-investing logic rather than
// arbitrary points: "undervalued" leans on valuation but still requires
// some quality/health (a cheap stock with a broken balance sheet isn't a
// value play, it's a value trap) — the classic quality+value combination
// factor research favors over value alone. "momentum" leans on momentum
// and growth since price trend and revenue trend tend to move together.
// "quality" doubles up quality+financialHealth (the two axes that most
// directly answer "is this a well-run, durable business"). "best"/"avoid"
// stay balanced across all five since they're asking a general question,
// not screening for one specific factor.
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

/**
 * Tilts the base weights by the current macro regime rather than scoring
 * every environment the same way. Real basis: when the Fed funds rate is
 * elevated, capital is expensive — speculative/unprofitable growth names
 * get punished hardest (their cash flows are further out, so they discount
 * worse) while cash-generative, low-leverage names hold up — so quality
 * and financial-health weight goes up, growth/momentum weight comes down.
 * When rates are low/easing, that logic reverses: cheap capital favors
 * growth and risk-taking. Between ~3% and ~4.5% Fed funds, weights stay at
 * the base (no strong regime signal either way).
 */
function applyRegimeTilt(
  weights: Partial<Record<SnowflakeAxis, number>>,
  macro: { fedFundsRate: number } | null
): Partial<Record<SnowflakeAxis, number>> {
  if (!macro) return weights;
  let tilt: Partial<Record<SnowflakeAxis, number>> | null = null;
  if (macro.fedFundsRate >= 4.5) {
    tilt = { quality: 1.25, financialHealth: 1.25, growth: 0.85, momentum: 0.9 };
  } else if (macro.fedFundsRate <= 3) {
    tilt = { growth: 1.2, momentum: 1.15, quality: 0.9 };
  }
  if (!tilt) return weights;
  const adjusted: Partial<Record<SnowflakeAxis, number>> = { ...weights };
  for (const axis of Object.keys(tilt) as SnowflakeAxis[]) {
    if (adjusted[axis] !== undefined) adjusted[axis] = adjusted[axis]! * tilt[axis]!;
  }
  return adjusted;
}

function scoreCandidate(intent: ScreenIntent, sf: OttoSnowflakeScores, weights: Partial<Record<SnowflakeAxis, number>> = AXIS_WEIGHTS[intent]): number {
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

function buildKeyStat(
  intent: ScreenIntent,
  data: { ratios: FmpRatios | null; keyMetrics: FmpKeyMetrics | null; changePercentage: number },
  sf: OttoSnowflakeScores
): string {
  const pe = data.ratios?.priceToEarningsRatio;
  const roic = data.keyMetrics?.returnOnInvestedCapital;
  switch (intent) {
    case "undervalued":
      return pe !== undefined
        ? `P/E ${pe.toFixed(1)}x · Valuation ${sf.valuation.score}/6`
        : `Valuation ${sf.valuation.score}/6`;
    case "momentum":
      return `Momentum ${sf.momentum.score}/6 · ${data.changePercentage >= 0 ? "+" : ""}${data.changePercentage.toFixed(1)}% today`;
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
function passesRequirements(snap: Pick<SymbolSnapshot, "ratios" | "keyMetrics">, req: ScreenQueryRequirements | null): boolean {
  if (!req) return true;
  if (req.maxPE !== undefined) {
    const pe = snap.ratios?.priceToEarningsRatio;
    if (pe === undefined || pe > req.maxPE) return false;
  }
  if (req.minRevenueGrowthPct !== undefined) {
    const g = snap.ratios?.revenueGrowthYoY;
    if (g === undefined || g * 100 < req.minRevenueGrowthPct) return false;
  }
  if (req.minROICPct !== undefined) {
    const r = snap.keyMetrics?.returnOnInvestedCapital;
    if (r === undefined || r * 100 < req.minROICPct) return false;
  }
  if (req.minFCFYieldPct !== undefined) {
    const f = snap.keyMetrics?.freeCashFlowYield;
    if (f === undefined || f * 100 < req.minFCFYieldPct) return false;
  }
  return true;
}

export async function runScreener(
  intent: ScreenIntent,
  theme: ThemeFilter | null = null,
  capFilter: CapFilter | null = null,
  onProgress?: ProgressFn,
  seedTickers: { symbol: string; companyName: string }[] = [],
  requirements: ScreenQueryRequirements | null = null
): Promise<ScreenerCandidate[]> {
  const cacheKey = [
    intent,
    theme?.key,
    capFilter?.key,
    seedTickers.length ? `seed:${seedTickers.map((s) => s.symbol).sort().join(",")}` : null,
    requirements ? `req:${JSON.stringify(requirements)}` : null,
  ]
    .filter(Boolean)
    .join(":");
  // On a cache hit nothing below runs, so no progress events fire — the
  // scan really is instant then, not staged for show.
  return getScreenerCache<ScreenerCandidate[]>().getOrSet(cacheKey, async () => {
    // Macro (for regime-tilted weights) and the market-wide insider-cluster
    // feed are both ticker-agnostic — fetched once per scan, in parallel
    // with sourcing the pool, not once per candidate.
    const [pool, macro, clusterFeed] = await Promise.all([
      sourceCandidates(intent, theme, capFilter, seedTickers),
      fetchMacroContext().catch(() => null),
      fetchInsiderClusterFeed().catch(() => [] as InsiderClusterEntry[]),
    ]);
    onProgress?.({ id: "scan", text: `Scanning ${pool.length} tickers…`, icon: "finnhub" });

    const weights = applyRegimeTilt(AXIS_WEIGHTS[intent], macro);
    const clusterBySymbol = new Map(clusterFeed.map((e) => [e.symbol, e]));

    // Cheap (already in memory, no extra fetch) real-money signal applied
    // to the WHOLE pool, not just semifinalists — a stock with a live
    // insider-buying cluster can win a spot in contention it wouldn't have
    // gotten on fundamentals alone, the same way a real desk would flag it.
    const CLUSTER_NUDGE = 3;
    function clusterNudgeFor(symbol: string): number {
      const entry = clusterBySymbol.get(symbol);
      if (!entry) return 0;
      if (entry.buys > entry.sells && entry.netShares > 0) return CLUSTER_NUDGE;
      if (entry.sells > entry.buys && entry.netShares < 0) return -CLUSTER_NUDGE;
      return 0;
    }

    const scored = await mapWithConcurrency(pool, SCORING_CONCURRENCY, async (c): Promise<ScreenerCandidate | null> => {
      try {
        // getSymbolSnapshot is cached per-symbol, independent of intent —
        // the fetch+score work only happens once per symbol per cache
        // window even across different screens (see getSymbolScoreCache).
        const snap = await getSymbolSnapshot(c.symbol);
        if (!snap) return null;
        if (!passesRequirements(snap, requirements)) return null;
        return {
          symbol: c.symbol,
          companyName: c.companyName,
          price: snap.price,
          compositeScore: scoreCandidate(intent, snap.sf, weights),
          keyStat: buildKeyStat(intent, snap, snap.sf),
          // Flagged rather than hidden so a data-starved spike never looks
          // equivalent to a fully-scored pick (the "rocket stock" problem).
          thinCoverage: snap.fundamentalsChecksRun <= 3,
        };
      } catch {
        return null; // one bad candidate shouldn't sink the whole screen
      }
    });

    const ascending = ASCENDING_INTENTS.has(intent);
    function preRankKey(c: ScreenerCandidate): number {
      return c.compositeScore + clusterNudgeFor(c.symbol);
    }
    const ranked = scored
      .filter((s): s is ScreenerCandidate => s !== null)
      .sort((a, b) => {
        // Fully-scored candidates always outrank thin-coverage ones,
        // regardless of raw composite score — see the comment above.
        if (a.thinCoverage !== b.thinCoverage) return a.thinCoverage ? 1 : -1;
        return ascending ? preRankKey(a) - preRankKey(b) : preRankKey(b) - preRankKey(a);
      });
    onProgress?.({ id: "narrow", text: `${ranked.length} cleared fundamentals — narrowing to the leading candidates…`, icon: "otto" });

    // Stage 3: the expensive real-money checks — per-company Form 4 detail
    // (for the display data, distinct from the market-wide cluster feed
    // above), analyst-rating-trend direction, and this stock's P/E
    // percentile against its real sector peers. Only run on the candidates
    // actually in contention for the final 5, so cost stays bounded even as
    // the funnel above widens to hundreds of names.
    const SEMIFINALIST_COUNT = 12;
    const semifinalists = ranked.slice(0, SEMIFINALIST_COUNT);
    const rest = ranked.slice(SEMIFINALIST_COUNT);
    onProgress?.({
      id: "crosscheck",
      text: `Cross-checking insider trades, analyst tone, and sector valuation on ${semifinalists.length} finalists…`,
      icon: "sec",
    });

    const ratingTrendBySymbol = new Map<string, { direction: "improving" | "worsening" | "flat"; delta: number }>();
    const sectorPercentileBySymbol = new Map<string, number>();

    const withInsider = await mapWithConcurrency(semifinalists, 4, async (candidate) => {
      const [activity, trend, fundamentals, financialsTrend, snap] = await Promise.all([
        fetchInsiderActivity(candidate.symbol).catch(() => null),
        fetchFinnhubRatingTrend(candidate.symbol).catch(() => null),
        fetchFinnhubFundamentals(candidate.symbol).catch(() => null),
        // Real 5-year income/cash-flow trend — only worth the extra Finnhub
        // call for the ~12 names actually in contention. The wide Stage 1
        // scan only has a quote+metric snapshot (no growth axis to speak
        // of); semifinalists get a real growth-axis score from this before
        // the final cut to 5.
        fetchFinnhubFinancialsTrend(candidate.symbol).catch(() => null),
        getSymbolSnapshot(candidate.symbol),
      ]);
      if (trend) ratingTrendBySymbol.set(candidate.symbol, trend);
      const pe = fundamentals?.ratios?.priceToEarningsRatio;
      if (pe !== undefined) {
        const peerValuation = await fetchPeerValuation(candidate.symbol, pe).catch(() => null);
        if (peerValuation) sectorPercentileBySymbol.set(candidate.symbol, peerValuation.percentile);
      }

      let enriched = candidate;
      if (financialsTrend && fundamentals) {
        const enrichedBundle: StockBundle = {
          symbol: candidate.symbol,
          quote: {
            symbol: candidate.symbol,
            name: candidate.companyName,
            price: candidate.price,
            changePercentage: snap?.changePercentage ?? 0,
            marketCap: 0,
            currency: "USD",
            yearHigh: fundamentals.week52High,
            yearLow: fundamentals.week52Low,
          },
          profile: null,
          ratios: fundamentals.ratios,
          keyMetrics: fundamentals.keyMetrics,
          priceTargetConsensus: null,
          gradesConsensus: null,
          historicalMonthly: [],
          income: financialsTrend.income,
          cashFlow: financialsTrend.cashFlow,
        };
        const sf = computeSnowflake(enrichedBundle);
        const fundamentalsChecksRun =
          sf.valuation.checks.length + sf.growth.checks.length + sf.quality.checks.length + sf.financialHealth.checks.length;
        enriched = {
          ...candidate,
          compositeScore: scoreCandidate(intent, sf, weights),
          keyStat: buildKeyStat(intent, { ratios: fundamentals.ratios, keyMetrics: fundamentals.keyMetrics, changePercentage: enrichedBundle.quote.changePercentage }, sf),
          thinCoverage: fundamentalsChecksRun <= 3,
        };
      }

      return activity ? { ...enriched, insiderActivity: activity } : enriched;
    });

    // Real signals nudge the final ranking rather than overriding the
    // fundamentals score outright — compositeScore itself stays a pure
    // reflection of the Snowflake data so it remains comparable across
    // runs; these only decide ordering among near-tied semifinalists.
    const INSIDER_NUDGE = 4;
    const RATING_TREND_NUDGE = 3;
    const SECTOR_NUDGE_MAX = 4; // scaled by percentile: cheapest-vs-peers = full nudge, priciest = full penalty
    function rankKey(c: ScreenerCandidate): number {
      let key = c.compositeScore + clusterNudgeFor(c.symbol);
      if (c.insiderActivity?.direction === "buying") key += INSIDER_NUDGE;
      else if (c.insiderActivity?.direction === "selling") key -= INSIDER_NUDGE;
      const trend = ratingTrendBySymbol.get(c.symbol);
      if (trend?.direction === "improving") key += RATING_TREND_NUDGE;
      else if (trend?.direction === "worsening") key -= RATING_TREND_NUDGE;
      const percentile = sectorPercentileBySymbol.get(c.symbol);
      if (percentile !== undefined) key += ((50 - percentile) / 50) * SECTOR_NUDGE_MAX;
      return key;
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
    onProgress?.({ id: "filings", text: "Reading SEC filings for the top picks…", icon: "sec" });
    return mapWithConcurrency(finalists, 5, async (candidate) => {
      const cik = await fetchCikForSymbol(candidate.symbol);
      const excerpt = await fetchRiskFactorExcerpt(cik ?? undefined, candidate.symbol).catch(() => null);
      if (!excerpt) return candidate;
      const note = excerpt.length > 160 ? `${excerpt.slice(0, 157).trimEnd()}…` : excerpt;
      return { ...candidate, filingNote: note };
    });
  });
}
