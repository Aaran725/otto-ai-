import { fetchCikForSymbol } from "./sec-universe";
import { getInsiderCache } from "./cache";
import { mapWithConcurrency } from "./batch";

const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? "Otto AI research@ottoai.app";
const WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_FORM4S = 15; // bounds cost per candidate — most issuers won't exceed this in 180 days

interface SecSubmissionsResponse {
  filings?: {
    recent?: {
      form: string[];
      accessionNumber: string[];
      primaryDocument: string[];
      filingDate: string[];
    };
  };
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    // No Next.js fetch-cache hint here on purpose — a large filer's
    // submissions.json can run several MB (confirmed live on a real
    // request), well past Next's 2MB fetch-cache ceiling; the getOrSet
    // TtlCache wrapping every caller already handles caching at a level
    // that isn't size-limited.
    const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT }, next: { revalidate: 3600 } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

interface RawTransaction {
  code: string;
  shares: number;
  date?: string;
  pricePerShare?: number;
}

/**
 * Only P (open-market purchase) and S (open-market sale) are a real
 * "insider put their own money in/out" signal — grants (A), option
 * exercises (M), tax-withholding sales (F), and gifts (G) are routine
 * compensation mechanics, not a buy/sell conviction call, so they're
 * deliberately excluded rather than diluting the signal.
 */
function extractOpenMarketTransactions(xml: string): RawTransaction[] {
  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) ?? [];
  const out: RawTransaction[] = [];
  for (const block of blocks) {
    const code = block.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/)?.[1];
    const shares = Number(block.match(/<transactionShares>\s*<value>([\d.]+)<\/value>/)?.[1] ?? "0");
    const date = block.match(/<transactionDate>\s*<value>([\d-]+)<\/value>/)?.[1];
    const priceRaw = block.match(/<transactionPricePerShare>\s*<value>([\d.]+)<\/value>/)?.[1];
    const pricePerShare = priceRaw ? Number(priceRaw) : undefined;
    if ((code === "P" || code === "S") && shares > 0) out.push({ code, shares, date, pricePerShare });
  }
  return out;
}

export interface InsiderTransaction {
  date: string; // ISO date, e.g. "2026-06-12"
  code: "P" | "S";
  shares: number;
  pricePerShare?: number;
  value?: number; // shares * pricePerShare, when a price was reported
}

export interface InsiderActivity {
  buys: number; // count of open-market purchase transactions in the window
  sells: number; // count of open-market sale transactions in the window
  netShares: number; // positive = net buying, negative = net selling
  direction: "buying" | "selling" | "mixed";
  /** Individual open-market transactions, newest first, for the timeline view. */
  transactions: InsiderTransaction[];
}

/**
 * Real insider-trading signal from free SEC EDGAR data: pulls each
 * company's Form 4 filings from the last 180 days and nets out open-market
 * buy vs sell transactions. Best-effort — returns null on any failure or
 * when there's simply no recent insider activity to report, never fabricated.
 */
export async function fetchInsiderActivity(symbol: string): Promise<InsiderActivity | null> {
  return getInsiderCache<InsiderActivity | null>().getOrSet(symbol.toUpperCase(), async () => {
    const cik = await fetchCikForSymbol(symbol);
    if (!cik) return null;

    const submissions = await fetchJson<SecSubmissionsResponse>(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const recent = submissions?.filings?.recent;
    if (!recent) return null;

    const cutoff = Date.now() - WINDOW_MS;
    const cikNumeric = String(Number(cik)); // filing paths use the un-padded CIK
    const targets: { url: string }[] = [];
    for (let i = 0; i < recent.form.length && targets.length < MAX_FORM4S; i++) {
      if (recent.form[i] !== "4") continue;
      if (new Date(recent.filingDate[i]).getTime() < cutoff) continue;
      const accession = recent.accessionNumber[i].replace(/-/g, "");
      // submissions API's primaryDocument points at the human-rendered path
      // (e.g. "xslF345X06/form4.xml") — the raw, parseable XML sits at the
      // same filename directly in the accession folder root, no subfolder.
      const filename = recent.primaryDocument[i].split("/").pop();
      targets.push({ url: `https://www.sec.gov/Archives/edgar/data/${cikNumeric}/${accession}/${filename}` });
    }
    if (targets.length === 0) return null;

    const parsed = await mapWithConcurrency(targets, 5, async (t) => {
      const xml = await fetchText(t.url);
      return xml ? extractOpenMarketTransactions(xml) : [];
    });

    let buys = 0;
    let sells = 0;
    let netShares = 0;
    const transactions: InsiderTransaction[] = [];
    for (const txns of parsed) {
      for (const t of txns) {
        if (t.code === "P") {
          buys++;
          netShares += t.shares;
        } else {
          sells++;
          netShares -= t.shares;
        }
        transactions.push({
          date: t.date ?? new Date().toISOString().slice(0, 10),
          code: t.code as "P" | "S",
          shares: t.shares,
          pricePerShare: t.pricePerShare,
          value: t.pricePerShare ? t.shares * t.pricePerShare : undefined,
        });
      }
    }
    if (buys === 0 && sells === 0) return null;
    transactions.sort((a, b) => b.date.localeCompare(a.date));

    return {
      buys,
      sells,
      netShares,
      direction: netShares > 0 ? "buying" : netShares < 0 ? "selling" : "mixed",
      transactions,
    };
  });
}
