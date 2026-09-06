import { fetchSicCode, fetchCiksBySic, fetchTickerForCik, fetchSicSiblings } from "./sec-universe";
import { fetchFinnhubFundamentals } from "./finnhub";
import { mapWithConcurrency } from "./batch";
import { getPeerCache } from "./cache";

export interface PeerRow {
  symbol: string;
  pe?: number;
  pfcf?: number;
  roic?: number;
  pb?: number;
  ps?: number;
  grossMargin?: number;
  roe?: number;
}

/**
 * Per-metric percentile rank among real sector peers — 0-100, same
 * convention as the existing top-level `percentile` (P/E) field: the
 * share of real peers that are BETTER than this stock on that metric, so
 * 0 always means "best in this peer set" and 100 always means "worst,"
 * regardless of whether the underlying metric is lower-is-better
 * (valuation multiples: fewer peers cheaper = low percentile) or
 * higher-is-better (margins/returns: fewer peers with a higher number =
 * low percentile). Keeps the "good = low" direction uniform across every
 * metric so snowflake.ts never has to special-case direction per check.
 * null when too few real peers report that specific metric to rank
 * against (a thin SIC code, or a metric Finnhub doesn't carry for most of
 * this industry) — the caller is expected to fall back to an absolute
 * threshold in that case, never to treat null as 0.
 */
export interface PeerPercentiles {
  pe: number | null;
  pfcf: number | null;
  pb: number | null;
  ps: number | null;
  grossMargin: number | null;
  roic: number | null;
  roe: number | null;
}

export interface PeerValuation {
  sicDescription: string;
  peerCount: number;
  medianPE: number;
  percentile: number; // this stock's P/E percentile among real peers — lower = cheaper than peers
  medianPFCF: number | null;
  medianROIC: number | null;
  peers: PeerRow[]; // individual real peer rows — powers the comparison table and gauge cluster
  percentiles: PeerPercentiles; // same real peer set, ranked across every metric Snowflake can use sector-relatively
}

const MAX_PEERS = 15;
const RESOLVE_CONCURRENCY = 15;
const FETCH_CONCURRENCY = 10;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * "% of real peers better than this stock on the metric," 0-100, same
 * convention for every metric regardless of direction — see PeerPercentiles.
 * Returns null (not 0) when fewer than 3 peers report a usable value, since
 * a percentile against 1-2 peers isn't a real distribution.
 */
function percentileRank(peerValues: number[], current: number | undefined, higherIsBetter: boolean): number | null {
  if (current === undefined || peerValues.length < 3) return null;
  const better = higherIsBetter ? peerValues.filter((v) => v > current).length : peerValues.filter((v) => v < current).length;
  return Math.round((better / peerValues.length) * 100);
}

export interface CurrentMetrics {
  pe?: number;
  pfcf?: number;
  pb?: number;
  ps?: number;
  grossMargin?: number;
  roic?: number;
  roe?: number;
}

/**
 * One SIC code's real member companies (EDGAR's browse-by-SIC endpoint —
 * a direct population, not a guess) resolved to tickers, each with a real
 * P/E, P/FCF, P/B, P/S, gross margin, ROIC, and ROE from a single Finnhub
 * call per peer (the same /stock/metric response already carries all of
 * them). No caching here — the caller (fetchPeerRowsForSic) caches the
 * final, possibly sibling-widened result as one unit.
 */
async function fetchRowsForExactSic(sic: string, excludeSymbol: string): Promise<PeerRow[]> {
  const ciks = await fetchCiksBySic(sic);
  const tickers = await mapWithConcurrency(ciks, RESOLVE_CONCURRENCY, (cik) => fetchTickerForCik(cik));
  const peerSymbols = tickers
    .filter((t): t is string => t !== null && t.toUpperCase() !== excludeSymbol.toUpperCase())
    .slice(0, MAX_PEERS);

  const rows = await mapWithConcurrency(peerSymbols, FETCH_CONCURRENCY, async (sym): Promise<PeerRow | null> => {
    const fundamentals = await fetchFinnhubFundamentals(sym);
    if (!fundamentals) return null;
    const pe = fundamentals.ratios.priceToEarningsRatio;
    const pfcf = fundamentals.ratios.priceToFreeCashFlowRatio;
    const roic = fundamentals.keyMetrics.returnOnInvestedCapital;
    const pb = fundamentals.ratios.priceToBookRatio;
    const ps = fundamentals.ratios.priceToSalesRatio;
    const grossMargin = fundamentals.ratios.grossProfitMargin;
    const roe = fundamentals.keyMetrics.returnOnEquity;
    if ([pe, pfcf, roic, pb, ps, grossMargin, roe].every((v) => v === undefined)) return null;
    return { symbol: sym, pe, pfcf, roic, pb, ps, grossMargin, roe };
  });
  return rows.filter((r): r is PeerRow => r !== null);
}

/**
 * The actual expensive part of a peer lookup — resolving a SIC code's real
 * member companies and fetching each one's fundamentals — factored out so
 * it can be warmed ahead of time (see warmSicPeerRows) without needing any
 * particular stock's own current metrics. `excludeSymbol` is only relevant
 * for a live per-stock lookup (a stock is never its own peer); pass "" to
 * warm generically. Same 24h SIC-keyed cache either way, so a live request
 * right after a warm finds it ready instead of racing a cold population
 * burst against its own scan's Finnhub budget — this was confirmed live to
 * be unreliable under load: in one real screener scan, only 1 of 5
 * finalists got a real percentile because the other 4's SIC codes weren't
 * warm yet and lost the race to the scan's own concurrent Finnhub usage.
 *
 * When the exact SIC still comes back too thin (fewer than 3 real peers),
 * widens to SEC's own real sibling codes sharing the same 3-digit family
 * (fetchSicSiblings) before giving up — confirmed live and specific: SIC
 * 6021 "National Commercial Banks" and 6022 "State Commercial Banks" are
 * the same real industry, split only by SEC's own classification
 * granularity. A broad catch-all code (e.g. 7389 "Services-Business
 * Services, NEC") has no useful family this way and simply stays thin —
 * this widening helps the "split adjacent codes" case, not every case.
 */
async function fetchPeerRowsForSic(sic: string, excludeSymbol: string): Promise<PeerRow[]> {
  return getPeerCache<PeerRow[]>().getOrSet(`sic-rows:${sic}`, async () => {
    const rows = await fetchRowsForExactSic(sic, excludeSymbol);
    if (rows.length >= 3) return rows;

    const siblings = await fetchSicSiblings(sic);
    if (siblings.length === 0) return rows;
    const siblingRows = await mapWithConcurrency(siblings, 3, (sibSic) => fetchRowsForExactSic(sibSic, excludeSymbol));
    const seen = new Set(rows.map((r) => r.symbol));
    const widened = [...rows];
    for (const row of siblingRows.flat()) {
      if (seen.has(row.symbol)) continue;
      seen.add(row.symbol);
      widened.push(row);
      if (widened.length >= MAX_PEERS) break;
    }
    return widened;
  });
}

/** Prewarm-only entry point (see the prewarm cron) — populates the same
 * peer cache a live fetchPeerValuation call would, ahead of any real
 * request needing it. Returns the real peer count found, purely for the
 * cron's own reporting. */
export async function warmSicPeerRows(sic: string): Promise<number> {
  const rows = await fetchPeerRowsForSic(sic, "");
  return rows.length;
}

export async function fetchPeerValuation(symbol: string, current: CurrentMetrics): Promise<PeerValuation | null> {
  if (current.pe === undefined || current.pe <= 0) return null;

  const target = await fetchSicCode(symbol);
  if (!target) return null;

  const peerRows = await fetchPeerRowsForSic(target.sic, symbol);

  if (peerRows.length < 3) return null; // too few real peers to mean anything

  // Sanity bounds per metric — a negative or absurd multiple (distressed
  // earnings, a data glitch) would skew a median/percentile without
  // reflecting real peer valuation.
  const validPEs = peerRows.map((r) => r.pe).filter((p): p is number => p !== undefined && p > 0 && p < 300);
  if (validPEs.length < 3) return null;

  const medianPE = median(validPEs)!;
  const below = validPEs.filter((p) => p < current.pe!).length;
  const percentile = Math.round((below / validPEs.length) * 100);

  const validPFCF = peerRows.map((r) => r.pfcf).filter((p): p is number => p !== undefined && p > 0 && p < 300);
  const validROIC = peerRows.map((r) => r.roic).filter((r): r is number => r !== undefined && r > -1 && r < 2);
  const validPB = peerRows.map((r) => r.pb).filter((p): p is number => p !== undefined && p > 0 && p < 100);
  const validPS = peerRows.map((r) => r.ps).filter((p): p is number => p !== undefined && p > 0 && p < 100);
  const validGrossMargin = peerRows.map((r) => r.grossMargin).filter((m): m is number => m !== undefined && m > 0 && m < 1);
  const validROE = peerRows.map((r) => r.roe).filter((r): r is number => r !== undefined && r > -1 && r < 2);

  return {
    sicDescription: target.description,
    peerCount: validPEs.length,
    medianPE,
    percentile,
    medianPFCF: median(validPFCF),
    medianROIC: median(validROIC),
    peers: peerRows,
    percentiles: {
      pe: percentile,
      pfcf: percentileRank(validPFCF, current.pfcf, false),
      pb: percentileRank(validPB, current.pb, false),
      ps: percentileRank(validPS, current.ps, false),
      grossMargin: percentileRank(validGrossMargin, current.grossMargin, true),
      roic: percentileRank(validROIC, current.roic, true),
      roe: percentileRank(validROE, current.roe, true),
    },
  };
}
