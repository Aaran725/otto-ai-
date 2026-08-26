import Groq from "groq-sdk";
import { OTTO_SYSTEM_PROMPT, buildOttoUserPrompt } from "./system-prompt";
import type { GroqOttoResponse, OttoAnalysis, OttoSnowflake, StreetConsensus, DataQuality } from "./schema";
import { getCachedScreenerSnapshot } from "./screener";
import { recordEvent } from "./observability";
import { getAnalysisCache } from "./cache";
import { computeSnowflake, type OttoSnowflakeScores } from "./snowflake";
import { computeForecastTargets } from "./forecast";
import { computeMetrics } from "./metrics";
import { summarizeBundleForPrompt } from "./summarize-bundle";
import { fetchRiskFactorExcerpt } from "./sec-edgar";
import { fetchMacroContext } from "./fred";
import { fetchFinnhubRecommendation, type FinnhubRatingCounts } from "./finnhub";
import { fetchYahooPriceTarget } from "./yahoo";
import { fetchPeerValuation } from "./peers";
import { computeRateSensitivity } from "./macro-sensitivity";
import { fetchEarningsRecord } from "./earnings";
import { fetchShortInterest } from "./short-interest";
import { fetchInsiderActivity } from "./insider";
import { computePositionSizing } from "./position-sizing";
import type { StockBundle } from "./fmp";
import type { ProgressFn } from "./chat-types";

function ratingFromCounts(c: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number }): string {
  const buyWeight = c.strongBuy + c.buy;
  const sellWeight = c.sell + c.strongSell;
  if (buyWeight > c.hold && buyWeight > sellWeight) return "Buy";
  if (sellWeight > c.hold && sellWeight > buyWeight) return "Sell";
  return "Hold";
}

/**
 * FMP's price-target-consensus/grades-consensus are blocked for some
 * tickers (same whitelist gate as ratios/key-metrics — confirmed on MARA).
 * Finnhub's free recommendation-trends endpoint still gives real rating
 * counts even then — no $ price targets (that's paid on Finnhub too), but
 * a ratings-only "Street" read is more honest than hiding the panel.
 */
async function computeStreetConsensus(bundle: StockBundle, symbol: string): Promise<StreetConsensus | null> {
  const { priceTargetConsensus: t, gradesConsensus: g } = bundle;

  if (t) {
    return {
      targetHigh: t.targetHigh,
      targetLow: t.targetLow,
      targetConsensus: t.targetConsensus,
      targetMedian: t.targetMedian,
      analystCount: g ? g.strongBuy + g.buy + g.hold + g.sell + g.strongSell : 0,
      rating: g?.consensus ?? "n/a",
      ratingCounts: g
        ? { strongBuy: g.strongBuy, buy: g.buy, hold: g.hold, sell: g.sell, strongSell: g.strongSell }
        : { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 },
    };
  }

  // Yahoo's unauthenticated chart/quoteSummary endpoints have covered every
  // FMP-restricted ticker tested so far, including a real $ price target —
  // try it before falling back to Finnhub's ratings-only read.
  const yahoo = await fetchYahooPriceTarget(symbol);
  if (yahoo) {
    const analystCount =
      yahoo.ratingCounts.strongBuy +
      yahoo.ratingCounts.buy +
      yahoo.ratingCounts.hold +
      yahoo.ratingCounts.sell +
      yahoo.ratingCounts.strongSell;
    return {
      targetHigh: yahoo.targetHigh,
      targetLow: yahoo.targetLow,
      targetConsensus: yahoo.targetConsensus,
      targetMedian: yahoo.targetMedian,
      analystCount,
      rating: analystCount > 0 ? ratingFromCounts(yahoo.ratingCounts) : "n/a",
      ratingCounts: yahoo.ratingCounts,
    };
  }

  const finnhubCounts: FinnhubRatingCounts | null = await fetchFinnhubRecommendation(symbol);
  if (!finnhubCounts) return null;

  const analystCount =
    finnhubCounts.strongBuy + finnhubCounts.buy + finnhubCounts.hold + finnhubCounts.sell + finnhubCounts.strongSell;
  if (analystCount === 0) return null;

  return {
    analystCount,
    rating: ratingFromCounts(finnhubCounts),
    ratingCounts: finnhubCounts,
  };
}

const ANALYSIS_MODEL = "openai/gpt-oss-120b";
const FOLLOWUP_MODEL = "openai/gpt-oss-20b"; // cheaper/faster, fine for short Q&A

function getGroqKeys(): string[] {
  return [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ].filter((k): k is string => Boolean(k));
}

export async function withKeyRotation<T>(fn: (client: Groq) => Promise<T>): Promise<T> {
  const keys = getGroqKeys();
  if (keys.length === 0) throw new Error("No GROQ_API_KEY configured");

  let lastError: unknown;
  for (const apiKey of keys) {
    try {
      return await fn(new Groq({ apiKey }));
    } catch (err) {
      lastError = err;
      // Only worth trying the next key for quota/exhaustion errors. A
      // "request too large" 413 means the payload itself exceeds the
      // per-request token ceiling — every key on this model shares that
      // same ceiling, so retrying with a different key can't help and just
      // burns another key's quota for nothing.
      if (err instanceof Error && /request too large/i.test(err.message)) {
        throw err;
      }
      continue;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All Groq keys failed");
}

/** Trims each axis down to its score + only the checks that failed, since
 * that's the only part Groq needs to write an accurate one-line note — the
 * full pass/fail list for all 30 checks was most of the prompt's bulk. */
function summarizeSnowflakeForPrompt(scores: OttoSnowflakeScores) {
  const trim = (axis: OttoSnowflakeScores[keyof OttoSnowflakeScores]) => ({
    score: axis.score,
    checksRun: axis.checks.length, // out of 6 possible — low means limited data was available
    failedChecks: axis.checks.filter((c) => !c.passed).map((c) => c.label),
  });
  return {
    valuation: trim(scores.valuation),
    growth: trim(scores.growth),
    quality: trim(scores.quality),
    financialHealth: trim(scores.financialHealth),
    momentum: trim(scores.momentum),
  };
}

function mergeSnowflake(scores: OttoSnowflakeScores, notes: GroqOttoResponse["snowflakeNotes"]): OttoSnowflake {
  const merge = (s: OttoSnowflakeScores[keyof OttoSnowflakeScores], note: string) => ({
    score: s.score,
    checksRun: s.checks.length,
    note,
  });
  return {
    valuation: merge(scores.valuation, notes.valuation),
    growth: merge(scores.growth, notes.growth),
    quality: merge(scores.quality, notes.quality),
    financialHealth: merge(scores.financialHealth, notes.financialHealth),
    momentum: merge(scores.momentum, notes.momentum),
  };
}

// Shortened from 5 min — item 1 (retry through the full Finnhub key
// rotation on any transient error) and item 3 (a shared fundamentals cache
// between the screener and single-stock paths) should already make a
// genuine failure much rarer, so whatever does still slip through deserves
// a fast retry rather than staying broken for minutes.
const PARTIAL_ANALYSIS_TTL_MS = 90 * 1000;

export async function runOttoAnalysis(
  ticker: string,
  bundle: StockBundle,
  onProgress?: ProgressFn
): Promise<OttoAnalysis> {
  const cacheKey = `${ticker}:${new Date().toISOString().slice(0, 10)}`;
  const cache = getAnalysisCache<OttoAnalysis>();

  const cached = await cache.get(cacheKey);
  if (cached) return cached; // cache hit: genuinely instant, no stages to report

  const analysis = await buildOttoAnalysis(ticker, bundle, onProgress);

  // If the underlying bundle was missing price history/financials, OR the
  // analysis itself came back data-starved (dataQuality, computed from real
  // checks-run counts — catches the AYI case specifically: historicalMonthly
  // and income can both be non-empty while ratios/keyMetrics still failed),
  // don't lock the broken result in for the full 24h — that's exactly what
  // made a ticker's chart/rating show "unavailable" for most of a day even
  // after the key/quota issue cleared.
  const isPartial =
    bundle.historicalMonthly.length === 0 || bundle.income.length === 0 || analysis.dataQuality === "insufficient";
  cache.set(cacheKey, analysis, isPartial ? PARTIAL_ANALYSIS_TTL_MS : undefined);
  return analysis;
}

/**
 * Early invalidation for a real same-day catalyst — see the prewarm cron's
 * catalyst-aware pass. The cache key is already date-scoped (rolls over on
 * its own at UTC midnight), so this only ever matters for a catalyst that
 * lands the SAME calendar day someone already has a cached read — without
 * it, that stale read would otherwise survive until the date rolls over,
 * not until the real 24h TTL.
 */
export async function invalidateTodaysAnalysis(ticker: string): Promise<void> {
  const cacheKey = `${ticker}:${new Date().toISOString().slice(0, 10)}`;
  await getAnalysisCache<OttoAnalysis>().del(cacheKey);
}

const AXIS_LABELS: Record<keyof OttoSnowflakeScores, string> = {
  valuation: "valuation",
  growth: "growth",
  quality: "quality",
  financialHealth: "financial health",
  momentum: "momentum",
};

// Below this point-difference, the existing generic disclaimer ("Screen
// score is a quick ranking... won't always match") already covers it — not
// every gap is worth a specific explanation, only the ones large enough to
// look like a contradiction to a user. Lowered from 15 to 10 — confirmed
// live on ALL: a real, meaningful gap (screener showed 100 in "undervalued"
// vs conviction 85, a 15pt gap from what the user actually saw) went
// unexplained because this check compares against getCachedScreenerSnapshot's
// neutral "best"-weighted baseline (97 for ALL), not the specific intent
// score the user actually looked at — the two can differ enough that a real
// gap sits right at the old threshold without tripping it.
const RECONCILIATION_THRESHOLD = 10;

/**
 * Deterministic, grounded in the same real numbers used to rank the stock
 * in the screener — never LLM-generated, so it can't invent a reason that
 * didn't actually drive the score. Only fires when there's a cached
 * screener result for this exact symbol to compare against (see
 * getCachedScreenerSnapshot) and the gap is large enough to need
 * explaining, not just labeling.
 */
function buildReconciliationNoteFromSnapshot(
  screenerSnap: { compositeScore: number; sf: OttoSnowflakeScores } | null,
  convictionScore: number,
  analysisSf: OttoSnowflakeScores
): string | null {
  if (!screenerSnap) return null;

  const rounded = Math.round(convictionScore);
  const delta = rounded - screenerSnap.compositeScore;
  if (Math.abs(delta) < RECONCILIATION_THRESHOLD) return null;

  let biggestAxis: keyof OttoSnowflakeScores | null = null;
  let biggestAxisDelta = 0;
  for (const axis of Object.keys(AXIS_LABELS) as (keyof OttoSnowflakeScores)[]) {
    const axisDelta = analysisSf[axis].score - screenerSnap.sf[axis].score;
    if (Math.abs(axisDelta) > Math.abs(biggestAxisDelta)) {
      biggestAxisDelta = axisDelta;
      biggestAxis = axis;
    }
  }

  const direction = delta > 0 ? "up" : "down";
  if (biggestAxis && Math.abs(biggestAxisDelta) >= 2) {
    const label = AXIS_LABELS[biggestAxis];
    const from = screenerSnap.sf[biggestAxis].score;
    const to = analysisSf[biggestAxis].score;
    return `Screened at ${screenerSnap.compositeScore}, but the full analysis moved ${direction} to ${rounded} — mainly driven by ${label} (${from}/6 on the quick scan vs ${to}/6 with real financials).`;
  }
  return `Screened at ${screenerSnap.compositeScore} using a quicker, thinner scan — the full analysis (real financials, forecast, peer comparison) landed at ${rounded} instead.`;
}

async function buildOttoAnalysis(ticker: string, bundle: StockBundle, onProgress?: ProgressFn): Promise<OttoAnalysis> {
    onProgress?.({ id: "snowflake", text: "Computing Snowflake & forecast…", icon: "otto", tracksFinding: true });
    const snowflakeScores = computeSnowflake(bundle);
    const forecastTargets = computeForecastTargets(bundle);
    onProgress?.({
      id: "snowflake",
      text: "Computing Snowflake & forecast…",
      finding: "Scored valuation, growth, quality, health & momentum",
      icon: "otto",
      tracksFinding: true,
    });

    // Each of these genuinely runs in parallel, so every stage announces
    // itself up front, then updates its OWN entry (matched by id) with a
    // real finding the moment its fetch resolves — not one combined
    // "reading things" message with a single summary tacked on at the end.
    onProgress?.({ id: "street", text: "Checking analyst consensus…", icon: "fmp", tracksFinding: true });
    onProgress?.({ id: "filing", text: "Checking SEC EDGAR for the latest 10-K…", icon: "sec", tracksFinding: true });
    onProgress?.({ id: "macro", text: "Pulling the macro backdrop…", icon: "fred", tracksFinding: true });
    onProgress?.({ id: "peers", text: "Pulling real sector peer valuations…", icon: "finnhub", tracksFinding: true });
    onProgress?.({ id: "earnings", text: "Checking earnings beat/miss history…", icon: "finnhub", tracksFinding: true });
    onProgress?.({ id: "shortinterest", text: "Checking short interest…", icon: "finnhub", tracksFinding: true });
    onProgress?.({ id: "insider", text: "Cross-referencing Form 4 insider filings…", icon: "sec", tracksFinding: true });

    // Enrichment only — never let a slow/failed fetch block the analysis.
    const [streetConsensus, filingExcerpt, macro, peerValuation, earnings, shortInterest, insiderActivity] = await Promise.all([
      computeStreetConsensus(bundle, bundle.symbol)
        .catch(() => null)
        .then((r) => {
          onProgress?.({
            id: "street",
            text: "Checking analyst consensus…",
            finding: r ? `${r.analystCount} analysts · ${r.rating}` : "No analyst coverage found",
            icon: "fmp",
            tracksFinding: true,
          });
          return r;
        }),
      fetchRiskFactorExcerpt(bundle.profile?.cik, bundle.symbol)
        .catch(() => null)
        .then((r) => {
          onProgress?.({
            id: "filing",
            text: "Checking SEC EDGAR for the latest 10-K…",
            finding: r ? "Found the risk-factors excerpt" : "No 10-K excerpt available",
            icon: "sec",
            tracksFinding: true,
          });
          return r;
        }),
      fetchMacroContext()
        .catch(() => null)
        .then((r) => {
          onProgress?.({
            id: "macro",
            text: "Pulling the macro backdrop…",
            finding: r ? `Fed funds ${r.fedFundsRate.toFixed(2)}% · 10Y ${r.treasury10Y.toFixed(2)}%` : "Macro data unavailable",
            icon: "fred",
            tracksFinding: true,
          });
          return r;
        }),
      fetchPeerValuation(bundle.symbol, bundle.ratios?.priceToEarningsRatio)
        .catch(() => null)
        .then((r) => {
          onProgress?.({
            id: "peers",
            text: "Pulling real sector peer valuations…",
            finding: r ? `${r.peerCount} real sector peers found` : "No sector peers found",
            icon: "finnhub",
            tracksFinding: true,
          });
          return r;
        }),
      fetchEarningsRecord(bundle.symbol)
        .catch(() => null)
        .then((r) => {
          onProgress?.({
            id: "earnings",
            text: "Checking earnings beat/miss history…",
            finding: r ? `${r.beatCount}/${r.beatCount + r.missCount} recent beats` : "No earnings history found",
            icon: "finnhub",
            tracksFinding: true,
          });
          return r;
        }),
      fetchShortInterest(bundle.symbol)
        .catch(() => null)
        .then((r) => {
          onProgress?.({
            id: "shortinterest",
            text: "Checking short interest…",
            finding: r ? `${r.daysToCover.toFixed(1)}d to cover` : "No short interest data",
            icon: "finnhub",
            tracksFinding: true,
          });
          return r;
        }),
      fetchInsiderActivity(bundle.symbol)
        .catch(() => null)
        .then((r) => {
          onProgress?.({
            id: "insider",
            text: "Cross-referencing Form 4 insider filings…",
            finding: r ? `${r.buys} buys · ${r.sells} sells (180d)` : "No recent insider activity",
            icon: "sec",
            tracksFinding: true,
          });
          return r;
        }),
    ]);

    const metrics = computeMetrics(bundle, peerValuation, earnings, shortInterest);
    const rateSensitivity = computeRateSensitivity(bundle.keyMetrics?.freeCashFlowYield, macro?.treasury10Y);

    const computedSignals = {
      snowflake: summarizeSnowflakeForPrompt(snowflakeScores),
      forecast: forecastTargets,
      ...(streetConsensus ? { streetConsensus } : {}),
      ...(macro ? { macro } : {}),
      ...(peerValuation ? { peerValuation } : {}),
      ...(rateSensitivity ? { rateSensitivity } : {}),
      ...(earnings ? { earnings } : {}),
      ...(shortInterest ? { shortInterest } : {}),
      // Summary only for the LLM prompt — the full transaction list is for
      // the timeline visual, not something worth spending prompt tokens on.
      ...(insiderActivity
        ? { insiderActivity: { direction: insiderActivity.direction, buys: insiderActivity.buys, sells: insiderActivity.sells } }
        : {}),
    };

    onProgress?.({ id: "writing", text: "Writing the analysis…", icon: "otto" });
    const groqResponse = await withKeyRotation(async (client) => {
      const completion = await client.chat.completions.create({
        model: ANALYSIS_MODEL,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: OTTO_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildOttoUserPrompt(
              ticker,
              JSON.stringify(summarizeBundleForPrompt(bundle)),
              JSON.stringify(computedSignals),
              filingExcerpt
            ),
          },
        ],
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) throw new Error("Empty response from Groq");
      return JSON.parse(content) as GroqOttoResponse;
    });

    const { snowflakeNotes, forecastRationale, ...base } = groqResponse;
    // Needs convictionScore, which only exists after Groq responds — pure
    // math, no LLM involvement, computed here rather than in the parallel
    // enrichment stage above.
    const positionSizing = computePositionSizing(
      base.convictionScore,
      bundle.historicalMonthly.map((p) => p.price)
    );

    // Deterministic, never LLM-influenced — a stock where FMP and its
    // Finnhub fallback both failed still gets *a* score from Groq (it's
    // instructed to produce one), but that score is meaningless when 4/5
    // Snowflake axes ran zero real checks. Confirmed live: AYI showed a
    // clean "Hold, 55" card that looked identical to a genuinely-scored
    // mediocre stock, with nothing telling the user the data just wasn't
    // there. Counting axes with zero checks run is the same signal the UI
    // already surfaces per-axis ("Score 3/6 but no checks were run") —
    // this just makes it impossible to miss at the headline level too.
    const emptyAxisCount = (Object.values(snowflakeScores) as { checks: unknown[] }[]).filter(
      (axis) => axis.checks.length === 0
    ).length;
    const dataQuality: DataQuality = emptyAxisCount >= 3 ? "insufficient" : emptyAxisCount >= 1 ? "partial" : "full";
    const oneLiner =
      dataQuality === "insufficient"
        ? `Not enough real financial data available for ${ticker} right now — treat any score as unreliable and verify independently.`
        : base.oneLiner;
    // Fetched once and reused for both the reconciliation note and the
    // divergence metric below, rather than two separate cache round-trips.
    const screenerSnap = await getCachedScreenerSnapshot(ticker);
    const reconciliationNote = buildReconciliationNoteFromSnapshot(screenerSnap, base.convictionScore, snowflakeScores);

    if (dataQuality === "insufficient") {
      recordEvent("data_quality_insufficient", { ticker });
    }

    // Phase 1 item 3 / Phase 3 item 2: passive server-side signal for how
    // often the two pipelines actually disagree by a lot. If this fires
    // rarely, the existing disclaimer is sufficient; if it's common, the
    // screener and single-stock scoring need to converge, not just be
    // labeled differently.
    if (screenerSnap && Math.abs(Math.round(base.convictionScore) - screenerSnap.compositeScore) > 25) {
      recordEvent("score_divergence", {
        ticker,
        screenScore: screenerSnap.compositeScore,
        convictionScore: Math.round(base.convictionScore),
      });
    }

    return {
      ...base,
      oneLiner,
      reconciliationNote,
      dataQuality,
      historicalPrices: bundle.historicalMonthly.map((p) => ({
        date: p.date,
        close: p.price,
        ...(p.open !== undefined && p.high !== undefined && p.low !== undefined
          ? { open: p.open, high: p.high, low: p.low }
          : {}),
      })),
      fundamentalTrend: bundle.income.map((inc, i) => ({
        period: `FY${inc.fiscalYear}`,
        revenue: inc.revenue,
        earnings: inc.netIncome,
        freeCashFlow: bundle.cashFlow[i]?.freeCashFlow ?? 0,
        operatingCashFlow: bundle.cashFlow[i]?.operatingCashFlow,
        capex: bundle.cashFlow[i]?.capex,
      })),
      metrics,
      snowflake: mergeSnowflake(snowflakeScores, snowflakeNotes),
      forecast: { ...forecastTargets, rationale: forecastRationale },
      streetConsensus,
      macro,
      rateSensitivity,
      earnings,
      shortInterest,
      positionSizing,
      peerValuation,
      insiderActivity,
      generatedAt: new Date().toISOString(),
    };
}

const FOLLOWUP_SYSTEM_PROMPT = `You are Otto, a high-conviction stock research analyst. You already
produced a structured analysis for a ticker (given below as JSON) and the user is now asking a
follow-up question about it. Answer directly and concisely (2-4 sentences, no markdown headers,
no JSON) using the analysis data as ground truth. Stay in Otto's voice: decisive, numbers-driven,
skeptical of hype.`;

export async function runOttoFollowUp(
  priorAnalysis: OttoAnalysis,
  question: string
): Promise<string> {
  return withKeyRotation(async (client) => {
    const completion = await client.chat.completions.create({
      model: FOLLOWUP_MODEL,
      temperature: 0.4,
      messages: [
        { role: "system", content: FOLLOWUP_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Prior analysis:\n${JSON.stringify(priorAnalysis)}\n\nFollow-up question: ${question}`,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("Empty response from Groq");
    return content.trim();
  });
}
