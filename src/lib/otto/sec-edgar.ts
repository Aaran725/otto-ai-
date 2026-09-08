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

/**
 * Real, live-confirmed bug found while building Round 8, Phase EE: "Item
 * 1A. Risk Factors" appears MANY times in a real 10-K (7 times in NVDA's)
 * — almost every occurrence is a cross-reference from an unrelated
 * section ("...as discussed in Item 1A. Risk Factors" for a discussion
 * of...", "for additional information about...") pointing back at the
 * real section, not the section itself. A naive first-match regex landed
 * on one of these cross-references, not the real heading — confirmed live
 * by pulling NVDA's actual two most recent 10-Ks and manually inspecting
 * what each match's surrounding text actually said. This almost certainly
 * affected the ORIGINAL single-excerpt path too (fetchRiskFactorExcerpt,
 * already shipped and displayed to users as "the company's own risk
 * disclosure"), not just this new comparison feature.
 *
 * The real heading is reliably distinguished by what immediately follows
 * it: a cross-reference always continues with "for a discussion of..." or
 * "for additional information about...", while the real section continues
 * directly into real prose ("The following risk(s)..."). Scans every real
 * match in filing order and returns the first one that ISN'T followed by
 * cross-reference language — verified live against NVDA's two most recent
 * real 10-Ks that this lands on the true section start in both.
 */
export function findRiskFactorsSectionStart(html: string): number | null {
  const re = /ITEM(?:&#160;|&nbsp;|\s)+1A\.?\s*RISK\s*FACTORS/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const following = decodeEntities(html.slice(m.index, m.index + 300).replace(/<[^>]+>/g, " "));
    if (/\bfor\s+(a\s+)?(further\s+)?discussion\b|\bfor\s+additional\s+information\b/i.test(following)) continue;
    return m.index;
  }
  return null;
}

/**
 * `preferSummary` defaults to true for the main single-excerpt path
 * (fetchRiskFactorExcerpt) — the concise "Summary of Risk Factors"
 * bullets are the right size to ground Groq's risk-writing without
 * bloating the main analysis prompt. Round 8, Phase EE's year-over-year
 * comparison wants the opposite: confirmed live (NVDA) that the summary
 * bullets alone are too terse/stable to show a real substantive change
 * even in a year with genuine new disclosure — the full detailed section,
 * with a real larger cap since this is a separate, standalone LLM call
 * with its own token budget, is what actually surfaces a real difference.
 */
function extractRiskFactorsExcerpt(html: string, maxChars: number = MAX_EXCERPT_CHARS, preferSummary: boolean = true): string | null {
  const start = findRiskFactorsSectionStart(html);
  if (start === null) return null;

  let excerptStart = start;
  if (preferSummary) {
    const summaryMatch = /Summary\s+of\s+Risk\s+Factors/i.exec(html.slice(start, start + 5000));
    if (summaryMatch) excerptStart = start + summaryMatch.index;
  }

  const raw = html.slice(excerptStart, excerptStart + maxChars * 4); // generous slice before stripping tags
  const text = decodeEntities(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  if (text.length < 100) return null;

  return text.slice(0, maxChars);
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

/** Pure, exported for direct testing — finds the first `count` real 10-K
 * (never 10-Q) indices in a submissions feed's real `form` array, which
 * interleaves 10-Ks with 10-Qs and other filing types in real filing
 * order. */
export function findTenKIndices(form: string[], count: number): number[] {
  const indices: number[] = [];
  for (let i = 0; i < form.length && indices.length < count; i++) {
    if (form[i] === "10-K") indices.push(i);
  }
  return indices;
}

// A real, larger cap than the main analysis's 1400 chars — this feeds a
// separate, standalone comparison call with its own token budget, and the
// full detailed section (not just the terse summary bullets) is what
// actually shows a genuine year-over-year change — confirmed live.
const RISK_FACTOR_COMPARISON_CHARS = 6000;

async function fetchFilingRiskExcerpt(cik: string, accessionNumber: string, primaryDocument: string): Promise<string | null> {
  const accession = accessionNumber.replace(/-/g, "");
  const cikNumeric = String(Number(cik));
  const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikNumeric}/${accession}/${primaryDocument}`;
  const docRes = await fetchWithTimeout(docUrl, 8000);
  if (!docRes.ok) return null;
  const html = await docRes.text();
  return extractRiskFactorsExcerpt(html, RISK_FACTOR_COMPARISON_CHARS, false);
}

export interface RiskFactorExcerptPair {
  latest: string;
  prior: string;
  latestFilingDate: string;
  priorFilingDate: string;
}

/**
 * Round 8, Phase EE — a real year-over-year pair of 10-K risk-factor
 * excerpts, the same real primary source fetchRiskFactorExcerpt already
 * reads, just one real filing further back too. Requires genuinely TWO
 * real 10-Ks on file (a newly-public company won't have one yet) — a 10-K
 * compared against a thinner 10-Q (which often only has a "material
 * changes" subsection, not the full section) wouldn't be a fair
 * like-for-like read, so this returns null rather than guessing at one.
 * Cached separately from the single-excerpt cache above — a genuinely
 * different real question ("what changed" vs. "what does it say now").
 * No LLM call here — pure fetching; the real comparison happens in
 * groq.ts (keeps this file's only dependency on Otto's own Groq client
 * setup at zero, avoiding a circular import back into groq.ts).
 */
export async function fetchRiskFactorExcerptPair(cik: string | undefined): Promise<RiskFactorExcerptPair | null> {
  if (!cik) return null;
  const paddedCik = cik.padStart(10, "0");

  return getFilingCache<RiskFactorExcerptPair | null>().getOrSet(`${paddedCik}-pair`, async () => {
    try {
      const subRes = await fetchWithTimeout(`https://data.sec.gov/submissions/CIK${paddedCik}.json`, 6000);
      if (!subRes.ok) return null;
      const submissions = (await subRes.json()) as SecSubmissions;
      const { form, accessionNumber, primaryDocument, filingDate } = submissions.filings.recent;

      const indices = findTenKIndices(form, 2);
      if (indices.length < 2) return null;

      const [latest, prior] = await Promise.all(
        indices.map((idx) => fetchFilingRiskExcerpt(cik, accessionNumber[idx], primaryDocument[idx]))
      );
      if (!latest || !prior) return null;

      return { latest, prior, latestFilingDate: filingDate[indices[0]], priorFilingDate: filingDate[indices[1]] };
    } catch {
      return null;
    }
  });
}
