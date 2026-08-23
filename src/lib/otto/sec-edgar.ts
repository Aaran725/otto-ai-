import { getFilingCache } from "./cache";

const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? "Otto AI research@ottoai.app";
const MAX_EXCERPT_CHARS = 1400; // keeps the Groq prompt small — see summarize-bundle.ts's TPM notes

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface SecSubmissions {
  filings: {
    recent: {
      form: string[];
      accessionNumber: string[];
      primaryDocument: string[];
      filingDate: string[];
    };
  };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#8217;|&#39;/g, "'")
    .replace(/&#8212;|&mdash;/g, "-")
    .replace(/&#8226;/g, "•")
    .replace(/&amp;/g, "&");
}

function extractRiskFactorsExcerpt(html: string): string | null {
  const startMatch = /ITEM(?:&#160;|&nbsp;|\s)+1A\.?\s*RISK\s*FACTORS/i.exec(html);
  if (!startMatch) return null;
  const start = startMatch.index;

  const summaryMatch = /Summary\s+of\s+Risk\s+Factors/i.exec(html.slice(start, start + 5000));
  const excerptStart = summaryMatch ? start + summaryMatch.index : start;

  const raw = html.slice(excerptStart, excerptStart + MAX_EXCERPT_CHARS * 4); // generous slice before stripping tags
  const text = decodeEntities(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  if (text.length < 100) return null;

  return text.slice(0, MAX_EXCERPT_CHARS);
}

/**
 * Pulls a real excerpt from the company's own latest 10-K "Risk Factors"
 * section (preferring the concise "Summary of Risk Factors" subsection when
 * present) to ground Groq's risk-writing in the company's own disclosed
 * language instead of generic knowledge. Free, unlimited, no API key — just
 * a compliant User-Agent per SEC's fair-access policy.
 *
 * Best-effort only: returns null on any failure rather than blocking the
 * main analysis, since fetching/parsing a multi-MB filing is the slowest,
 * least essential part of the pipeline.
 */
export async function fetchRiskFactorExcerpt(cik: string | undefined, symbol: string): Promise<string | null> {
  if (!cik) return null;
  const paddedCik = cik.padStart(10, "0");

  return getFilingCache<string | null>().getOrSet(paddedCik, async () => {
    try {
      const subRes = await fetchWithTimeout(`https://data.sec.gov/submissions/CIK${paddedCik}.json`, 6000);
      if (!subRes.ok) return null;
      const submissions = (await subRes.json()) as SecSubmissions;
      const { form, accessionNumber, primaryDocument } = submissions.filings.recent;

      let filingIndex = form.findIndex((f) => f === "10-K");
      if (filingIndex === -1) filingIndex = form.findIndex((f) => f === "10-Q");
      if (filingIndex === -1) return null;

      const accession = accessionNumber[filingIndex].replace(/-/g, "");
      const doc = primaryDocument[filingIndex];
      const cikNumeric = String(Number(cik));
      const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikNumeric}/${accession}/${doc}`;

      const docRes = await fetchWithTimeout(docUrl, 8000);
      if (!docRes.ok) return null;
      const html = await docRes.text();

      return extractRiskFactorsExcerpt(html);
    } catch {
      return null;
    }
  });
}
