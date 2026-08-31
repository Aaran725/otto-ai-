import { fmpGetOptional } from "./fmp";
import { getSegmentCache } from "./cache";

export interface FmpSegmentEntry {
  symbol: string;
  fiscalYear: number;
  period: string;
  reportedCurrency: string;
  date: string;
  data: Record<string, number>;
}

export interface SegmentRevenue {
  label: string;
  revenue: number;
  pctOfTotal: number;
  /** Only present when the same segment label exists in both this fiscal
   * year and the prior one — a company that renamed or restructured a
   * segment shouldn't get a fabricated growth number. */
  yoyGrowthPct?: number;
}

export interface SegmentAnalysis {
  fiscalYear: string;
  segments: SegmentRevenue[]; // sorted descending by revenue share
  topSegmentConcentrationPct: number; // largest segment's % of total revenue
}

/**
 * Real per-segment revenue (FMP's /revenue-product-segmentation, confirmed
 * live: Apple's real iPhone/Services/Mac/iPad/Wearables split) — used for
 * two honestly-computable insights: how concentrated revenue is in one
 * line of business, and which segments are actually growing vs. shrinking.
 *
 * Deliberately NOT a dollar-valued "sum of the parts." That needs a
 * different valuation multiple per segment — a hardware line and a
 * services line don't deserve the same multiple — and Otto has no real
 * segment-level peer-multiple data to assign one honestly. Applying the
 * company's own blended multiple to each segment and summing them would
 * just reproduce the same market cap already known: a tautology dressed
 * up as analysis, not a real one. This is the honest slice of the idea.
 */
/** Pure computation, separated from the fetch so it's directly testable —
 * everything below is real arithmetic on whatever FMP returned, no I/O. */
export function buildSegmentAnalysis(entries: FmpSegmentEntry[]): SegmentAnalysis | null {
  if (entries.length === 0) return null;

  const latest = entries[0];
  const prior = entries.find((e) => e.fiscalYear === latest.fiscalYear - 1);
  const total = Object.values(latest.data).reduce((sum, v) => sum + v, 0);
  if (total <= 0) return null;

  const segments: SegmentRevenue[] = Object.entries(latest.data)
    .map(([label, revenue]) => {
      const priorRevenue = prior?.data[label];
      return {
        label,
        revenue,
        pctOfTotal: Math.round((revenue / total) * 1000) / 10,
        ...(priorRevenue !== undefined && priorRevenue > 0
          ? { yoyGrowthPct: Math.round(((revenue - priorRevenue) / priorRevenue) * 1000) / 10 }
          : {}),
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  return {
    fiscalYear: String(latest.fiscalYear),
    segments,
    topSegmentConcentrationPct: segments[0]?.pctOfTotal ?? 0,
  };
}

export async function fetchSegmentAnalysis(symbol: string): Promise<SegmentAnalysis | null> {
  return getSegmentCache<SegmentAnalysis | null>().getOrSet(symbol.toUpperCase(), async () => {
    const entries = await fmpGetOptional<FmpSegmentEntry[]>("/revenue-product-segmentation", { symbol }, []);
    return buildSegmentAnalysis(entries);
  });
}
