import Groq from "groq-sdk";
import { OTTO_SYSTEM_PROMPT, buildOttoUserPrompt } from "./system-prompt";
import type { GroqOttoResponse, OttoAnalysis, OttoSnowflake, StreetConsensus } from "./schema";
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

async function withKeyRotation<T>(fn: (client: Groq) => Promise<T>): Promise<T> {
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

const PARTIAL_ANALYSIS_TTL_MS = 5 * 60 * 1000; // retry soon rather than staying broken for 24h

export async function runOttoAnalysis(
  ticker: string,
  bundle: StockBundle,
  onProgress?: (text: string) => void
): Promise<OttoAnalysis> {
  const cacheKey = `${ticker}:${new Date().toISOString().slice(0, 10)}`;
  const cache = getAnalysisCache<OttoAnalysis>();

  const cached = cache.get(cacheKey);
  if (cached) return cached; // cache hit: genuinely instant, no stages to report

  const analysis = await buildOttoAnalysis(ticker, bundle, onProgress);

  // If the underlying bundle was missing price history or financials (a
  // rate-limited fetch, not a real data gap), don't lock the broken result
  // in for the full 24h — that's exactly what made a ticker's chart show
  // "unavailable" for most of a day even after the key/quota issue cleared.
  const isPartial = bundle.historicalMonthly.length === 0 || bundle.income.length === 0;
  cache.set(cacheKey, analysis, isPartial ? PARTIAL_ANALYSIS_TTL_MS : undefined);
  return analysis;
}

async function buildOttoAnalysis(ticker: string, bundle: StockBundle, onProgress?: (text: string) => void): Promise<OttoAnalysis> {
    onProgress?.("Computing Snowflake & forecast…");
    const snowflakeScores = computeSnowflake(bundle);
    const forecastTargets = computeForecastTargets(bundle);

    onProgress?.("Reading filings, peers, insider & earnings data…");
    // Enrichment only — never let a slow/failed fetch block the analysis.
    const [streetConsensus, filingExcerpt, macro, peerValuation, earnings, shortInterest, insiderActivity] = await Promise.all([
      computeStreetConsensus(bundle, bundle.symbol).catch(() => null),
      fetchRiskFactorExcerpt(bundle.profile?.cik, bundle.symbol).catch(() => null),
      fetchMacroContext().catch(() => null),
      fetchPeerValuation(bundle.symbol, bundle.ratios?.priceToEarningsRatio).catch(() => null),
      fetchEarningsRecord(bundle.symbol).catch(() => null),
      fetchShortInterest(bundle.symbol).catch(() => null),
      fetchInsiderActivity(bundle.symbol).catch(() => null),
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

    onProgress?.("Writing the analysis…");
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

    return {
      ...base,
      historicalPrices: bundle.historicalMonthly.map((p) => ({ date: p.date, close: p.price })),
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
