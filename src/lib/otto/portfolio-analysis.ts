import { fetchSicCode } from "./sec-universe";
import { fetchYahooHistoricalMonthly } from "./yahoo";
import { mapWithConcurrency } from "./batch";

export interface SectorConcentration {
  sicDescription: string;
  symbols: string[];
  pct: number; // % of the watchlist in this one SIC classification
}

export interface CorrelatedPair {
  a: string;
  b: string;
  correlation: number; // -1 to 1, Pearson correlation of monthly returns
}

/** A classic stat-arb signal: two names that normally move together just
 * didn't, over their most recent month. Doesn't say which direction is
 * "right" — just that the historical relationship broke, which is either
 * a mean-reversion setup or a sign the relationship itself changed. */
export interface DivergentPair {
  a: string;
  b: string;
  correlation: number;
  aLatestReturnPct: number;
  bLatestReturnPct: number;
  divergencePct: number; // |aLatestReturnPct - bLatestReturnPct|
}

export interface PortfolioAnalysis {
  sectorConcentration: SectorConcentration[]; // only entries above the flag threshold
  correlatedPairs: CorrelatedPair[]; // only pairs above the flag threshold
  divergentPairs: DivergentPair[]; // only pairs above the flag threshold
}

const CONCENTRATION_FLAG_PCT = 40; // a single SIC bucket over this share of the book gets flagged
const CORRELATION_FLAG = 0.7;
// A pair has to actually be correlated (CORRELATION_FLAG) before a gap
// between their latest returns means anything — an 8pt gap between two
// unrelated stocks is just noise; the same gap between two names that
// normally move as one is a real, checkable break in the pattern.
const DIVERGENCE_FLAG_PCT = 8;

function pearsonCorrelation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ax = a.slice(-n);
  const bx = b.slice(-n);
  const meanA = ax.reduce((s, v) => s + v, 0) / n;
  const meanB = bx.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = ax[i] - meanA;
    const db = bx[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

function monthlyReturns(closes: number[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
  }
  return rets;
}

/**
 * A hedge fund desk doesn't just underwrite names one at a time — it checks
 * whether the book is secretly one bet wearing five tickers. Sector
 * concentration comes from the same free SEC SIC classification used for
 * peer valuation; correlation comes from real monthly price history
 * (Yahoo's free fallback — no FMP spend) rather than a guess. Both only
 * report entries that cross a real flag threshold, not a wall of numbers.
 */
export async function analyzePortfolio(symbols: string[]): Promise<PortfolioAnalysis> {
  const uniqueSymbols = [...new Set(symbols.map((s) => s.toUpperCase()))];
  if (uniqueSymbols.length < 2) {
    return { sectorConcentration: [], correlatedPairs: [], divergentPairs: [] };
  }

  const [sicResults, priceResults] = await Promise.all([
    mapWithConcurrency(uniqueSymbols, 10, async (s) => ({ symbol: s, sic: await fetchSicCode(s) })),
    mapWithConcurrency(uniqueSymbols, 10, async (s) => ({
      symbol: s,
      closes: (await fetchYahooHistoricalMonthly(s)).map((p) => p.price),
    })),
  ]);

  // Sector concentration
  const bySic = new Map<string, { description: string; symbols: string[] }>();
  for (const r of sicResults) {
    if (!r.sic) continue;
    const bucket = bySic.get(r.sic.sic) ?? { description: r.sic.description, symbols: [] };
    bucket.symbols.push(r.symbol);
    bySic.set(r.sic.sic, bucket);
  }
  const sectorConcentration: SectorConcentration[] = [...bySic.values()]
    .map((b) => ({ sicDescription: b.description, symbols: b.symbols, pct: Math.round((b.symbols.length / uniqueSymbols.length) * 100) }))
    .filter((b) => b.symbols.length >= 2 && b.pct >= CONCENTRATION_FLAG_PCT)
    .sort((a, b) => b.pct - a.pct);

  // Pairwise correlation, and — for pairs that actually are correlated —
  // whether their most recent month's returns just broke that pattern.
  const returnsBySymbol = new Map(priceResults.map((r) => [r.symbol, monthlyReturns(r.closes)]));
  const correlatedPairs: CorrelatedPair[] = [];
  const divergentPairs: DivergentPair[] = [];
  for (let i = 0; i < uniqueSymbols.length; i++) {
    for (let j = i + 1; j < uniqueSymbols.length; j++) {
      const a = returnsBySymbol.get(uniqueSymbols[i]);
      const b = returnsBySymbol.get(uniqueSymbols[j]);
      if (!a || !b || a.length < 3 || b.length < 3) continue;
      const corr = pearsonCorrelation(a, b);
      if (corr === null || corr < CORRELATION_FLAG) continue;
      const correlation = Math.round(corr * 100) / 100;
      correlatedPairs.push({ a: uniqueSymbols[i], b: uniqueSymbols[j], correlation });

      const aLatestReturnPct = a[a.length - 1] * 100;
      const bLatestReturnPct = b[b.length - 1] * 100;
      const divergencePct = Math.abs(aLatestReturnPct - bLatestReturnPct);
      if (divergencePct >= DIVERGENCE_FLAG_PCT) {
        divergentPairs.push({
          a: uniqueSymbols[i],
          b: uniqueSymbols[j],
          correlation,
          aLatestReturnPct: Math.round(aLatestReturnPct * 10) / 10,
          bLatestReturnPct: Math.round(bLatestReturnPct * 10) / 10,
          divergencePct: Math.round(divergencePct * 10) / 10,
        });
      }
    }
  }
  correlatedPairs.sort((x, y) => y.correlation - x.correlation);
  divergentPairs.sort((x, y) => y.divergencePct - x.divergencePct);

  return { sectorConcentration, correlatedPairs, divergentPairs };
}
