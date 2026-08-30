import { getNewsCache } from "./cache";

const TAVILY_URL = "https://api.tavily.com/search";

export interface NewsResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  published_date?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

/**
 * Real, dated news via Tavily's search API (built for exactly this —
 * unlike a generic web search, `topic: "news"` + `days` genuinely limits
 * results to recent coverage instead of whatever ranks highest overall).
 *
 * Deliberately kept OUT of computedSignals in groq.ts — this never reaches
 * the LLM prompt, never touches the conviction score or any Snowflake
 * axis. Web results are unstructured and unverified in a way a real SEC
 * filing or a quote isn't; the whole rest of this app's design is "every
 * number traceable to a primary source," and blending news into the score
 * would quietly break that. It's shown as its own labeled, linked-out
 * panel — real context you can go verify yourself, not a silent input to
 * Otto's own reasoning.
 *
 * Null (not an empty array) means "couldn't get real results" — no key
 * configured, the request failed, or nothing came back — so the UI can
 * tell "checked, found nothing" apart from "never checked."
 */
export async function fetchRecentNews(symbol: string, companyName: string): Promise<NewsResult[] | null> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;

  return getNewsCache<NewsResult[] | null>().getOrSet(symbol.toUpperCase(), async () => {
    try {
      const res = await fetch(TAVILY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query: `${companyName} (${symbol}) stock`,
          topic: "news",
          days: 7,
          max_results: 5,
          include_answer: false,
        }),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as TavilyResponse;
      const results = data.results ?? [];
      if (results.length === 0) return null;

      return results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content.length > 220 ? `${r.content.slice(0, 220)}…` : r.content,
        publishedDate: r.published_date,
      }));
    } catch {
      return null;
    }
  });
}
