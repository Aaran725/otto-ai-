import { getInsiderFeedCache } from "./cache";
import { mapWithConcurrency } from "./batch";

const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? "Otto AI research@ottoai.app";
const FEED_CONCURRENCY = 8;

/**
 * Market-wide insider-cluster signal: instead of checking one company's
 * Form 4s on request (insider.ts), this pulls SEC's live "recent filings"
 * feed — the most recent Form 4s across the ENTIRE market in one request —
 * and parses each one for issuer ticker + transaction. Aggregating across
 * many companies at once turns "one insider bought some stock" into "these
 * N stocks all have real insider buying clusters right now," a genuinely
 * stronger signal a per-company check can't surface market-wide (checking
 * every candidate individually would mean one submissions.json + several
 * Form-4 fetches PER candidate — infeasible across a 300+ pool).
 */
export interface InsiderClusterEntry {
  symbol: string;
  companyName: string;
  netShares: number; // positive = net buying
  buys: number;
  sells: number;
  // Most recent open-market transaction date seen for this issuer across
  // the feed window, ISO "YYYY-MM-DD" — used to decay the cluster nudge by
  // real recency (see freshness.ts). Optional: absent if no transaction in
  // this issuer's filings had a parseable date.
  mostRecentTransactionDate?: string;
}

interface FeedEntry {
  cik: string;
  accessionNoDashes: string;
}

async function fetchFeedEntries(count: number): Promise<FeedEntry[]> {
  try {
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=${count}&output=atom`;
    const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT } });
    if (!res.ok) return [];
    const xml = await res.text();
    const entries: FeedEntry[] = [];
    const hrefs = xml.matchAll(/href="https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/(\d+)\/(\d+)\//g);
    // Dedupe by accession number ALONE, not (cik, accession) — a Form 4
    // with multiple reporting owners produces one <entry> per co-filer,
    // each pointing at the SAME accession through a different filer's own
    // CIK path. Confirmed live: a single GoodRx filing showed up 6 times
    // under 6 different CIKs before this fix, inflating its sell count 6x.
    // The document content is identical regardless of which associated
    // CIK's path is used to fetch it, so the first CIK seen is fine to keep.
    const seen = new Set<string>();
    for (const m of hrefs) {
      const accession = m[2];
      if (seen.has(accession)) continue;
      seen.add(accession);
      entries.push({ cik: m[1], accessionNoDashes: accession });
    }
    return entries;
  } catch {
    return [];
  }
}

interface DirectoryListing {
  directory?: { item?: { name: string }[] };
}

async function fetchXmlFilename(cik: string, accessionNoDashes: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNoDashes}/index.json`,
      { headers: { "User-Agent": SEC_USER_AGENT } }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as DirectoryListing;
    const xmlFile = data.directory?.item?.find((i) => i.name.endsWith(".xml") && !i.name.includes("primary_doc"));
    return xmlFile?.name ?? data.directory?.item?.find((i) => i.name.endsWith(".xml"))?.name ?? null;
  } catch {
    return null;
  }
}

interface ParsedForm4 {
  symbol: string;
  companyName: string;
  netShares: number;
  buys: number;
  sells: number;
  mostRecentTransactionDate?: string;
}

function parseForm4(xml: string): ParsedForm4 | null {
  const symbol = xml.match(/<issuerTradingSymbol>\s*([A-Za-z.\-]+)\s*<\/issuerTradingSymbol>/)?.[1];
  const companyName = xml.match(/<issuerName>\s*([^<]+?)\s*<\/issuerName>/)?.[1];
  if (!symbol || !companyName) return null;

  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) ?? [];
  let netShares = 0;
  let buys = 0;
  let sells = 0;
  let mostRecentTransactionDate: string | undefined;
  for (const block of blocks) {
    const code = block.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/)?.[1];
    const shares = Number(block.match(/<transactionShares>\s*<value>([\d.]+)<\/value>/)?.[1] ?? "0");
    if (shares <= 0) continue;
    // Same P/S-only rule as insider.ts — only real open-market conviction,
    // not grants/exercises/gifts.
    if (code === "P") {
      buys++;
      netShares += shares;
    } else if (code === "S") {
      sells++;
      netShares -= shares;
    } else {
      continue;
    }
    const date = block.match(/<transactionDate>\s*<value>([\d-]+)<\/value>/)?.[1];
    if (date && (!mostRecentTransactionDate || date > mostRecentTransactionDate)) mostRecentTransactionDate = date;
  }
  if (buys === 0 && sells === 0) return null;
  return { symbol: symbol.toUpperCase(), companyName, netShares, buys, sells, mostRecentTransactionDate };
}

/**
 * Fetches and aggregates the last `feedCount` Form 4 filings market-wide
 * into a per-ticker net-buying leaderboard. Cached briefly (this is a live
 * feed, not slow-moving fundamentals) so a burst of screener requests
 * shares one scan instead of re-fetching ~100 filings per request.
 */
export async function fetchInsiderClusterFeed(feedCount = 100): Promise<InsiderClusterEntry[]> {
  return getInsiderFeedCache<InsiderClusterEntry[]>().getOrSet(`cluster-feed:${feedCount}`, async () => {
    const entries = await fetchFeedEntries(feedCount);
    if (entries.length === 0) return [];

    const parsed = await mapWithConcurrency(entries, FEED_CONCURRENCY, async (e) => {
      const filename = await fetchXmlFilename(e.cik, e.accessionNoDashes);
      if (!filename) return null;
      try {
        const res = await fetch(
          `https://www.sec.gov/Archives/edgar/data/${e.cik}/${e.accessionNoDashes}/${filename}`,
          { headers: { "User-Agent": SEC_USER_AGENT } }
        );
        if (!res.ok) return null;
        return parseForm4(await res.text());
      } catch {
        return null;
      }
    });

    // Aggregate — the same ticker can appear across multiple filings in the
    // window (different insiders, or the same one filing several Form 4s).
    const byTicker = new Map<string, InsiderClusterEntry>();
    for (const p of parsed) {
      if (!p) continue;
      const existing = byTicker.get(p.symbol);
      if (existing) {
        existing.netShares += p.netShares;
        existing.buys += p.buys;
        existing.sells += p.sells;
        if (p.mostRecentTransactionDate && (!existing.mostRecentTransactionDate || p.mostRecentTransactionDate > existing.mostRecentTransactionDate)) {
          existing.mostRecentTransactionDate = p.mostRecentTransactionDate;
        }
      } else {
        byTicker.set(p.symbol, {
          symbol: p.symbol,
          companyName: p.companyName,
          netShares: p.netShares,
          buys: p.buys,
          sells: p.sells,
          mostRecentTransactionDate: p.mostRecentTransactionDate,
        });
      }
    }
    return [...byTicker.values()];
  });
}
