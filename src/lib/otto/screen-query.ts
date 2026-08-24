import { withKeyRotation } from "./groq";
import { fetchFinnhubQuote, fetchFinnhubProfile2 } from "./finnhub";
import type { ScreenIntent, ThemeFilter } from "./screener";

// The stronger model, not the cheap/fast one — precision matters here more
// than latency (a wrong seed ticker pollutes a whole screen's results with
// an irrelevant company, confirmed live: the smaller model occasionally
// named Sanofi for a "cybersecurity" request), and this call never writes
// analysis prose or generates financial figures, just a short JSON object.
const QUERY_MODEL = "openai/gpt-oss-120b";

export interface ScreenQueryRequirements {
  maxPE?: number;
  minRevenueGrowthPct?: number;
  minROICPct?: number;
  minFCFYieldPct?: number;
}

export interface ScreenQuery {
  intent: ScreenIntent | null;
  theme: { label: string; keywords: string[] } | null;
  minMarketCapMillions: number | null;
  seedTickers: string[];
  requirements: ScreenQueryRequirements | null;
  requiresInsiderBuying: boolean;
}

const SYSTEM_PROMPT = `You classify a user's free-form stock-market request into a structured screen query. Output strict JSON only, matching this exact shape:
{
  "intent": "undervalued" | "momentum" | "best" | "quality" | "avoid" | null,
  "theme": { "label": string, "keywords": string[] } | null,
  "minMarketCapMillions": number | null,
  "seedTickers": string[],
  "requirements": { "maxPE": number, "minRevenueGrowthPct": number, "minROICPct": number, "minFCFYieldPct": number } | null,
  "requiresInsiderBuying": boolean
}

Rules:
- "intent" is the ranking style: "undervalued" (cheap/value), "momentum" (hot/trending stocks with strong expected forward upside — this covers common finance slang like "rocket stock(s)", "moonshot", "breakout", "hot stock", "surging", "stocks that might go boom/high upside" even when that slang isn't a literal industry), "quality" (safe/stable/defensive), "avoid" (red flags/risky), "best" (general "good stock" ask, or no clearer signal). Use null only if this message isn't a stock-screening request at all.
- IMPORTANT disambiguation: "rocket stock(s)" and "moonshot" are finance SLANG for "momentum" intent (a stock expected to rise sharply) — do NOT set "theme" to literal rocket/space/aerospace companies for these phrases unless the user also clearly names that industry (e.g. "space industry stocks", "aerospace stocks", "rocket launch companies"). Same logic for other slang: "hot stock" is not about temperature/energy, "breakout" is not about health/skincare.
- "theme" describes a specific sector/niche/industry focus, if the user named one (e.g. "physical AI / robotics", "quantum computing", "cybersecurity", "space", "EV batteries", "humanoid robots"). "label" is a short display name (2-4 words). "keywords" is 4-8 REAL industry/business-model terms actually used to describe such companies (e.g. for "physical AI": ["robotics","humanoid","industrial automation","autonomous systems","actuators","sensors"]) — used to match against real company industry classifications. Use null if the user didn't name a sector/niche.
- "seedTickers" is a list (0-12) of REAL, currently-trading, publicly-listed company ticker symbols whose PRIMARY, core business is genuinely in the requested theme/niche — not a company with only minor/incidental exposure, a coincidentally similar name, or a loosely related sector. For a narrow/specific niche (e.g. "physical AI", "quantum computing") this list is the PRIMARY way real companies reach the screen — a generic industry-code match often can't find them — so name every real, core-business-relevant, currently-listed company you're confident about, not just one or two, but double-check each one actually belongs before including it. Example of what NOT to do: for "cybersecurity stocks", include CrowdStrike/Palo Alto Networks/Fortinet (core business is cybersecurity) but do NOT include a large, well-known company just because it's prominent or vaguely tech-adjacent (e.g. Sanofi is a pharmaceutical company — wrong for "cybersecurity" even though it's a large real company). Every ticker is independently checked against a live market data feed for existence (not relevance) before use, so a wrong guess still reaches the user — precision here matters more than a long list. Use each company's EXACT, full ticker symbol (e.g. "TENB" for Tenable, not a truncated "TEN" — a truncated symbol can silently resolve to a completely different real company). Never invent a plausible-looking symbol or include a private/delisted company.
- "requirements" captures explicit numeric thresholds the user actually stated (a P/E ceiling, a minimum revenue growth %, a minimum ROIC %, a minimum free cash flow yield %). Only include fields the user gave a real number for. Use null if none were stated.
- "minMarketCapMillions" only if the user gave an explicit cap floor beyond generic "mega cap" wording (e.g. "above $50 billion" -> 50000). Use null otherwise.
- "requiresInsiderBuying" is true only if the user explicitly asked for stocks with insider buying / executives or insiders buying shares / insider accumulation (including misspellings like "inside rbuying"). Otherwise false.

You are only classifying the request and naming real companies you're confident about — never fabricate financial figures, and never invent a ticker symbol.`;

/**
 * Refines the cheap regex-based intent/theme detection into a precise,
 * free-form screen — the fixed 6-theme keyword list ("AI", "tech",
 * "healthcare"...) can't cover an arbitrary niche like "physical AI" or
 * "quantum computing", and a bare `\bai\b` regex match on "physical AI"
 * would otherwise misroute it into the generic chip/software AI theme. Best
 * effort: on any failure (rate limit, malformed JSON) the caller falls back
 * to the regex-detected result, so this only ever refines, never blocks.
 */
export async function interpretScreenQuery(message: string): Promise<ScreenQuery | null> {
  try {
    return await withKeyRotation(async (client) => {
      const completion = await client.chat.completions.create({
        model: QUERY_MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: message },
        ],
      });
      const content = completion.choices[0]?.message?.content;
      if (!content) return null;
      return JSON.parse(content) as ScreenQuery;
    });
  } catch {
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Converts an LLM-classified free-text theme into the same ThemeFilter
 * shape the deterministic screener already knows how to apply — the
 * industry-match regex is built from real keywords the model named, not
 * fabricated data, so the rest of the funnel (classify against Finnhub's
 * real finnhubIndustry field) is unchanged. */
export function themeQueryToFilter(query: { label: string; keywords: string[] }): ThemeFilter {
  const pattern = query.keywords.map(escapeRegExp).filter(Boolean).join("|");
  const key = query.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "custom";
  return {
    label: query.label,
    key,
    // No keywords named: match nothing on industry alone — seedTickers
    // (verified separately) still carry the request, this filter just adds
    // no false-positive net.
    industryMatch: pattern ? new RegExp(pattern, "i") : /(?!)/,
  };
}

/**
 * Every LLM-suggested ticker is independently verified against a live quote
 * (and profile) before it can ever enter a candidate pool — a hallucinated,
 * stale, or delisted symbol simply fails this check and is dropped, so no
 * fabricated company can slip into a screen result.
 */
export async function verifySeedTickers(symbols: string[]): Promise<{ symbol: string; companyName: string }[]> {
  const unique = [...new Set(symbols.map((s) => s.toUpperCase().trim()).filter(Boolean))].slice(0, 12);
  const results = await Promise.all(
    unique.map(async (symbol) => {
      const [quote, profile] = await Promise.all([fetchFinnhubQuote(symbol), fetchFinnhubProfile2(symbol)]);
      if (!quote) return null;
      return { symbol, companyName: profile.name ?? symbol };
    })
  );
  return results.filter((r): r is { symbol: string; companyName: string } => r !== null);
}
