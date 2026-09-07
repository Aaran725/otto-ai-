import AdmZip from "adm-zip";
// Must be imported before "pdf-parse" — its own troubleshooting docs
// confirm this is the fix for "Setting up fake worker failed" under
// Next.js/Turbopack's server bundling, which rewrites the module paths
// pdfjs-dist's dynamic worker resolution otherwise relies on. Confirmed
// live: every real PTR fetch failed with that exact error before this.
import { getPath } from "pdf-parse/worker";
import { PDFParse } from "pdf-parse";
import { getUniverseCache } from "./cache";

PDFParse.setWorker(getPath());

/**
 * Real US House STOCK Act disclosure data — the Clerk of the House
 * publishes a real, free, daily-updated ZIP of every financial disclosure
 * filed this year at a fixed URL (confirmed live). Senate coverage is
 * deliberately NOT attempted: efdsearch.senate.gov requires a session
 * cookie handshake (POST a click-through agreement first) and sits behind
 * Akamai bot protection that blocks even residential proxies — a real,
 * confirmed-live technical wall, not a shortcut taken for convenience.
 *
 * Initially scoped this out as "too hard, needs real PDF-table parsing
 * across inconsistent per-filer layouts." Actually tested it before
 * committing to that: pdf-parse extracts real, structured text cleanly
 * from a real sample PTR (Periodic Transaction Report), and the
 * ticker/type/date/amount fields are genuinely regex-extractable most of
 * the time. Real coverage isn't 100% — some rows describe a security by
 * name only with no clean "(TICKER)" pattern (confirmed on real ETF
 * rows in testing) — skipped rather than guessed, same discipline as
 * everywhere else in this codebase.
 *
 * Research is specific about what this kind of data is actually good
 * for: convergence (several independent reps buying the same stock),
 * never a single-rep "so-and-so bought it, buy it too" copy signal.
 * Real, honest limitation baked in: STOCK Act gives a rep up to 45 days
 * to file after a trade, so "recent" here always means "at most 45 days
 * of real filing lag," never live.
 */
const HOUSE_USER_AGENT = "Mozilla/5.0 (compatible; OttoAI/1.0; +otto-ai research)";
const WINDOW_DAYS = 45; // matches the real STOCK Act filing deadline
const MAX_PTRS_TO_FETCH = 80; // real, modest cap — a bad week could spike filings well past the typical count

interface HouseDisclosureEntry {
  lastName: string;
  firstName: string;
  filingType: string;
  filingDate: string; // MM/DD/YYYY as published
  docId: string;
}

/** Fetches and parses the real, official, daily-updated ZIP the Clerk of
 * the House publishes — a tab-separated index (name, filing type, date,
 * DocID), not the transactions themselves (those live in each real
 * per-filer PDF, see fetchPtrTransactions). Cached 24h; this index
 * doesn't change intraday. */
async function fetchHouseDisclosureIndex(year: number): Promise<HouseDisclosureEntry[]> {
  return getUniverseCache<HouseDisclosureEntry[]>().getOrSet(`house-fd-index:${year}`, async () => {
    try {
      const res = await fetch(`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`, {
        headers: { "User-Agent": HOUSE_USER_AGENT },
      });
      if (!res.ok) return [];
      const buffer = Buffer.from(await res.arrayBuffer());
      const zip = new AdmZip(buffer);
      const txtEntry = zip.getEntries().find((e) => e.entryName.endsWith(".txt"));
      if (!txtEntry) return [];
      const text = txtEntry.getData().toString("utf-8").replace(/^﻿/, "");
      const lines = text.split("\n").slice(1); // header row
      const entries: HouseDisclosureEntry[] = [];
      for (const line of lines) {
        const parts = line.split("\t");
        if (parts.length < 9) continue;
        const [, last, first, , filingType, , , filingDate, docId] = parts;
        if (!docId?.trim()) continue;
        entries.push({ lastName: last, firstName: first, filingType, filingDate, docId: docId.trim() });
      }
      return entries;
    } catch {
      return [];
    }
  });
}

export interface HouseTransaction {
  symbol: string;
  transactionType: "purchase" | "sale";
  transactionDate: string; // MM/DD/YYYY, real, as filed
}

/**
 * Pure regex parse of real PTR text (see pdf-parse output on a real
 * filing). A ticker in parens followed by an asset-type code in
 * brackets, then the transaction type (P/S, S carries an optional
 * "(partial)"), then two real dates and a dollar-range. Real-world
 * coverage gap, confirmed on an actual filing: some ETF/fund rows
 * describe the security by name only with no clean "(TICKER)" — those
 * rows are skipped, never guessed at. Exported for direct testing.
 */
export function parsePtrTransactions(text: string): HouseTransaction[] {
  const results: HouseTransaction[] = [];
  const re = /\(([A-Z][A-Z.]{0,6})\)\s*\[[A-Z]{2}\]\s*\n?\s*([PSE])(?:\s*\(partial\))?\s+(\d{2}\/\d{2}\/\d{4})\s+\d{2}\/\d{2}\/\d{4}\s+\$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [, symbol, typeCode, date] = m;
    if (typeCode === "E") continue; // exchange — not a clean buy/sell signal
    results.push({ symbol, transactionType: typeCode === "P" ? "purchase" : "sale", transactionDate: date });
  }
  return results;
}

async function fetchPtrTransactions(docId: string, year: number): Promise<HouseTransaction[]> {
  try {
    const res = await fetch(`https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`, {
      headers: { "User-Agent": HOUSE_USER_AGENT },
    });
    if (!res.ok) return [];
    const buffer = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return parsePtrTransactions(result.text);
    } finally {
      await parser.destroy(); // pdf-parse's own recommendation — frees real memory per document
    }
  } catch {
    return [];
  }
}

function daysAgo(mmddyyyy: string): number {
  const [month, day, year] = mmddyyyy.split("/").map(Number);
  const filed = new Date(Date.UTC(year, month - 1, day));
  return (Date.now() - filed.getTime()) / (24 * 60 * 60 * 1000);
}

export interface HouseBuyer {
  name: string;
  transactionDate: string;
}

/**
 * Real, aggregated "which representatives bought which real ticker in
 * the last WINDOW_DAYS" — computed once and cached (12h), not per
 * request. Bounded to MAX_PTRS_TO_FETCH real filings so this can never
 * become an unbounded fetch storm regardless of how many PTRs land in a
 * given week.
 *
 * A plain Record, not a Map — confirmed live this actually matters:
 * TtlCache.set JSON-serializes its value, and JSON.stringify(new Map())
 * produces "{}", silently discarding every real entry. The cache then
 * happily re-serves that empty result for its full TTL, and every lookup
 * against it looks like an honest "no convergence" instead of the bug it
 * actually is. Caught this exact failure live: AMD had a real, confirmed
 * purchase disclosure in a fetched PTR, but the app still returned null.
 */
async function fetchRecentHouseBuying(): Promise<Record<string, HouseBuyer[]>> {
  return getUniverseCache<Record<string, HouseBuyer[]>>().getOrSet("house-recent-buying", async () => {
    const year = new Date().getUTCFullYear();
    const index = await fetchHouseDisclosureIndex(year);
    const recentPtrs = index
      .filter((e) => e.filingType === "P" && daysAgo(e.filingDate) <= WINDOW_DAYS)
      .slice(0, MAX_PTRS_TO_FETCH);

    const bySymbol: Record<string, HouseBuyer[]> = {};
    const results = await Promise.all(
      recentPtrs.map(async (entry) => ({
        entry,
        transactions: await fetchPtrTransactions(entry.docId, year).catch(() => [] as HouseTransaction[]),
      }))
    );
    for (const { entry, transactions } of results) {
      const repName = `${entry.firstName} ${entry.lastName}`.trim();
      for (const t of transactions) {
        if (t.transactionType !== "purchase") continue;
        (bySymbol[t.symbol] ??= []).push({ name: repName, transactionDate: t.transactionDate });
      }
    }
    return bySymbol;
  });
}

export interface CongressionalConvergence {
  buyerCount: number;
  buyers: HouseBuyer[];
  windowDays: number;
}

/**
 * Real convergence for one ticker: how many different House members each
 * independently disclosed a real purchase in the last 45 days. Never a
 * "rep X bought it" copy signal — only ever a count of real, independent
 * agreement, same discipline as the 13F convergence check. Returns null
 * when zero of the tracked recent PTRs mention this ticker — the common
 * case for the overwhelming majority of stocks.
 */
export async function fetchCongressionalConvergence(symbol: string): Promise<CongressionalConvergence | null> {
  const bySymbol = await fetchRecentHouseBuying();
  const buyers = bySymbol[symbol.toUpperCase()];
  if (!buyers || buyers.length === 0) return null;
  // A single rep can appear more than once in the same window (multiple
  // real, separate purchases) — dedupe to real distinct buyers for the
  // convergence count, since "one person traded twice" isn't independent
  // agreement the way "two different people traded" is.
  const distinctNames = [...new Set(buyers.map((b) => b.name))];
  return { buyerCount: distinctNames.length, buyers, windowDays: WINDOW_DAYS };
}
