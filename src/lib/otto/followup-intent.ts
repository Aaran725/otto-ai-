import type { OttoAnalysis } from "./schema";
import type { FollowUpVisual } from "./chat-types";

/**
 * Distinguishes "UBER" / "analyze UBER" (wants a fresh full card) from
 * "what's your forecast for UBER" / "why is it a buy" (a question about a
 * ticker already discussed — should NOT re-trigger the whole pipeline).
 */
export function looksLikeFreshRequest(message: string): boolean {
  const m = message.trim().toLowerCase();
  const explicitRefresh = /\b(again|refresh|update|re-?analyze|recheck|redo)\b/.test(m);
  if (explicitRefresh) return true;

  const hasQuestionWord = /\b(what|whats|why|how|when|where|is|does|do|should|can|will|are|about)\b/.test(m);
  if (hasQuestionWord) return false;

  const wordCount = m.split(/\s+/).filter(Boolean).length;
  return wordCount <= 4; // bare ticker or short "analyze X" style phrasing
}

export type FollowUpTopic = FollowUpVisual["type"];

/** Cheap keyword classification — no LLM call needed for this. */
export function detectFollowUpTopic(message: string): FollowUpTopic | null {
  const m = message.toLowerCase();

  // Checked before "revenue trend"/"margin trend" below so those stay
  // specific — this only catches a bare quick-glance ask.
  if (/how.?s?\s*it\s*(trending|doing|looking)|quick (chart|look|trend|sparkline)|show.*(sparkline|mini chart)/.test(m)) {
    return "sparkline";
  }
  if (/forecast|target price|price target|where.*(going|headed)|12.?month|upside|downside/.test(m)) {
    return "forecast";
  }
  if (/debt|balance sheet|leverage|liquidity|cash position|financial health|solvency/.test(m)) {
    return "metrics";
  }
  if (/why (is it|.*buy|.*avoid|.*hold)|thesis|catalyst|\brisk/.test(m)) {
    return "thesis";
  }
  if (/snowflake|\bscore\b|quality|momentum|checks?\b/.test(m)) {
    return "snowflake";
  }
  if (/peer|vs\.?\s*(peers|industry|sector)|relative valuation|compared? to (its|the) (peers|industry|sector)/.test(m)) {
    return "peers";
  }
  if (/who.*(bullish|bearish)|analyst rating|buy.?hold.?sell|rating (breakdown|split)|street (rating|split|think)/.test(m)) {
    return "rating";
  }
  if (/revenue (trend|growth)|margin (trend|expansion)|top.?line/.test(m)) {
    return "revenue";
  }
  if (/cash flow|\bfcf\b|capex|capital expenditure/.test(m)) {
    return "cashflow";
  }
  if (/insiders?\b|form 4|(management|executives?)\s+(buying|selling)/.test(m)) {
    return "insider";
  }
  return null;
}

/** Builds the visual payload deterministically from the already-cached
 * analysis — no LLM involved, same numbers the user already saw. */
export function buildFollowUpVisual(topic: FollowUpTopic, card: OttoAnalysis): FollowUpVisual {
  switch (topic) {
    case "forecast":
      return {
        type: "forecast",
        forecast: card.forecast,
        historicalPrices: card.historicalPrices,
        street: card.streetConsensus,
        positive: card.priceChangePercent1D >= 0,
      };
    case "metrics":
      return { type: "metrics", metrics: card.metrics };
    case "thesis":
      return { type: "thesis", catalysts: card.catalysts, risks: card.risks };
    case "snowflake":
      return { type: "snowflake", snowflake: card.snowflake };
    case "peers": {
      if (!card.peerValuation) return { type: "thesis", catalysts: card.catalysts, risks: card.risks }; // no peer data — fall back rather than show nothing
      const metricValue = (label: string) => {
        const raw = card.metrics.find((m) => m.label === label)?.value;
        if (!raw || raw === "n/a") return undefined;
        return Number.parseFloat(raw);
      };
      const fcfYieldPct = metricValue("FCF Yield");
      return {
        type: "peers",
        peerValuation: card.peerValuation,
        currentPE: metricValue("Valuation (P/E)"),
        currentPFCF: fcfYieldPct && fcfYieldPct > 0 ? 100 / fcfYieldPct : undefined, // P/FCF is the reciprocal of FCF yield
        currentROIC: metricValue("ROIC") !== undefined ? metricValue("ROIC")! / 100 : undefined,
      };
    }
    case "rating":
      return card.streetConsensus
        ? { type: "rating", street: card.streetConsensus }
        : { type: "thesis", catalysts: card.catalysts, risks: card.risks };
    case "revenue":
      return { type: "revenue", fundamentalTrend: card.fundamentalTrend };
    case "cashflow":
      return { type: "cashflow", fundamentalTrend: card.fundamentalTrend };
    case "sparkline":
      return { type: "sparkline", historicalPrices: card.historicalPrices, positive: card.priceChangePercent1D >= 0 };
    case "insider":
      return card.insiderActivity
        ? { type: "insider", insiderActivity: card.insiderActivity }
        : { type: "thesis", catalysts: card.catalysts, risks: card.risks };
  }
}
