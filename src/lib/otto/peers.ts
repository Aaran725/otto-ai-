import { fetchSicCode, fetchCiksBySic, fetchTickerForCik } from "./sec-universe";
import { fetchFinnhubFundamentals } from "./finnhub";
import { mapWithConcurrency } from "./batch";
import { getPeerCache } from "./cache";

export interface PeerRow {
  symbol: string;
  pe?: number;
  pfcf?: number;
  roic?: number;
}

export interface PeerValuation {
  sicDescription: string;
  peerCount: number;
  medianPE: number;
  percentile: number; // this stock's P/E percentile among real peers — lower = cheaper than peers
  medianPFCF: number | null;
  medianROIC: number | null;
  peers: PeerRow[]; // individual real peer rows — powers the comparison table and gauge cluster
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
 * Real relative-valuation context: pulls the actual list of SEC-registered
 * companies sharing this stock's exact SIC code (via EDGAR's browse-by-SIC
 * endpoint — a direct population, not a guess), resolves each to a ticker,
 * and fetches P/E, P/FCF, and ROIC for each from a single Finnhub call per
 * peer (the same /stock/metric response already carries all three). Cached
 * per SIC code (24h) so the lookup is paid once per industry per day.
 */
export async function fetchPeerValuation(symbol: string, currentPE: number | undefined): Promise<PeerValuation | null> {
  if (currentPE === undefined || currentPE <= 0) return null;

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
      if (pe === undefined && pfcf === undefined && roic === undefined) return null;
      return { symbol: sym, pe, pfcf, roic };
    });
    return rows.filter((r): r is PeerRow => r !== null);
  });

  if (peerRows.length < 3) return null; // too few real peers to mean anything

  // Sanity bounds on P/E specifically — a negative or absurd multiple
  // (distressed earnings, data glitch) would skew the median without
  // reflecting real peer valuation.
  const validPEs = peerRows.map((r) => r.pe).filter((p): p is number => p !== undefined && p > 0 && p < 300);
  if (validPEs.length < 3) return null;

  const medianPE = median(validPEs)!;
  const below = validPEs.filter((p) => p < currentPE).length;
  const percentile = Math.round((below / validPEs.length) * 100);

  const validPFCF = peerRows.map((r) => r.pfcf).filter((p): p is number => p !== undefined && p > 0 && p < 300);
  const validROIC = peerRows.map((r) => r.roic).filter((r): r is number => r !== undefined && r > -1 && r < 2);

  return {
    sicDescription: target.description,
    peerCount: validPEs.length,
    medianPE,
    percentile,
    medianPFCF: median(validPFCF),
    medianROIC: median(validROIC),
    peers: peerRows,
  };
}
