import { fetchSicCode, fetchCiksBySic, fetchTickerForCik } from "./sec-universe";
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
 * Real relative-valuation context: pulls the actual list of SEC-registered
 * companies sharing this stock's exact SIC code (via EDGAR's browse-by-SIC
 * endpoint — a direct population, not a guess), resolves each to a ticker,
 * and fetches P/E, P/FCF, P/B, P/S, gross margin, ROIC, and ROE for each
 * from a single Finnhub call per peer (the same /stock/metric response
 * already carries all of them). Cached per SIC code (24h) so the lookup is
 * paid once per industry per day. The P/E percentile stays the required
 * gate (matches the original behavior — no peer lookup without at least
 * that one anchor metric); every other percentile is best-effort and comes
 * back null when either this stock or too few peers lack that number.
 */
export async function fetchPeerValuation(symbol: string, current: CurrentMetrics): Promise<PeerValuation | null> {
  if (current.pe === undefined || current.pe <= 0) return null;

  const target = await fetchSicCode(symbol);
  if (!target) return null;

  const peerRows = await getPeerCache<PeerRow[]>().getOrSet(`sic-rows:${target.sic}`, async () => {
    const ciks = await fetchCiksBySic(target.sic);
    const tickers = await mapWithConcurrency(ciks, RESOLVE_CONCURRENCY, (cik) => fetchTickerForCik(cik));
    const peerSymbols = tickers
      .filter((t): t is string => t !== null && t.toUpperCase() !== symbol.toUpperCase())
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
  });

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
