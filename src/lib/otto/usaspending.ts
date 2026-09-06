import { getMacroCache } from "./cache";

/**
 * USASpending.gov's own official API — real, free, public, no API key at
 * all (confirmed live). Every federal contract award, searchable by
 * recipient name (the API does its own real fuzzy matching server-side —
 * "Lockheed Martin" correctly matched "LOCKHEED MARTIN CORP" and
 * "LOCKHEED MARTIN CORPORATION" in testing, so no separate name-resolution
 * step is needed here). A real revenue-durability signal distinct from
 * anything already in snowflake.ts: steady or growing federal contract
 * exposure is a genuine quality signal for the subset of public companies
 * that have real, material government business (defense, infrastructure,
 * gov health IT, and more) — most companies simply have none, which is
 * "not applicable," not a bad sign, so this returns null rather than a
 * misleading $0.
 */
const USASPENDING_BASE = "https://api.usaspending.gov/api/v2";
const CONTRACT_AWARD_TYPE_CODES = ["A", "B", "C", "D"]; // real USASpending codes for definitive/BPA/purchase-order/delivery-order contracts

interface SpendingOverTimeResult {
  aggregated_amount: number;
  time_period: { fiscal_year: string };
}

interface SpendingOverTimeResponse {
  results: SpendingOverTimeResult[];
}

/**
 * The US federal fiscal year containing this date — FY(Y) runs Oct 1 of
 * (Y-1) through Sep 30 of Y, so October already belongs to next year's
 * fiscal year even though the calendar year hasn't turned. Pure, exported
 * for direct testing: getting this wrong is exactly what silently turned
 * "FY2026 is only 11 months in" into a misleading "-40% YoY" before this
 * was caught — comparing a complete year's total against a still-open
 * one's partial total isn't a real decline, it's an incomplete period.
 */
export function usFiscalYear(date: Date): number {
  const month = date.getUTCMonth() + 1; // 1-12
  return month >= 10 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
}

export interface GovernmentContractSignal {
  recentFiscalYear: string;
  recentFiscalYearTotal: number;
  priorFiscalYear: string;
  priorFiscalYearTotal: number;
  growthPct: number | null; // null when the prior year had zero federal awards (no meaningful YoY base)
}

/**
 * Real trailing-2-fiscal-year federal contract award totals for a company,
 * by its real legal/trading name (bundle.quote.name or companyName —
 * whatever Otto already resolved this symbol to). Cached 24h — award data
 * updates on the government's own reporting cadence, not intraday.
 * Returns null when the company has no material real federal contract
 * history (the overwhelming majority of public companies) or the real
 * fetch fails — never fabricates a number for a company with no gov
 * business.
 */
export async function fetchGovernmentContractSignal(companyName: string): Promise<GovernmentContractSignal | null> {
  return getMacroCache<GovernmentContractSignal | null>().getOrSet(`usaspending:${companyName.toLowerCase()}`, async () => {
    try {
      // Always compare the two most recent COMPLETE fiscal years — the
      // current, still-open one is deliberately excluded from the query
      // entirely. Confirmed live why this matters: querying "the most
      // recent 2 results" naively compared a full FY2025 against an
      // 11-months-in FY2026 and reported a misleading "-40% YoY," which
      // was really just "this year isn't over yet," not a real decline.
      const currentFY = usFiscalYear(new Date());
      const recentCompleteFY = currentFY - 1;
      const priorCompleteFY = currentFY - 2;
      const res = await fetch(`${USASPENDING_BASE}/search/spending_over_time/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          group: "fiscal_year",
          filters: {
            award_type_codes: CONTRACT_AWARD_TYPE_CODES,
            recipient_search_text: [companyName],
            time_period: [{ start_date: `${priorCompleteFY - 1}-10-01`, end_date: `${recentCompleteFY}-09-30` }],
          },
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as SpendingOverTimeResponse;
      const recent = data.results.find((r) => Number(r.time_period.fiscal_year) === recentCompleteFY && r.aggregated_amount > 0);
      const prior = data.results.find((r) => Number(r.time_period.fiscal_year) === priorCompleteFY && r.aggregated_amount > 0);
      if (!recent || !prior) return null; // no real, comparable 2-complete-fiscal-year federal contract history

      const growthPct = prior.aggregated_amount > 0 ? ((recent.aggregated_amount - prior.aggregated_amount) / prior.aggregated_amount) * 100 : null;

      return {
        recentFiscalYear: recent.time_period.fiscal_year,
        recentFiscalYearTotal: recent.aggregated_amount,
        priorFiscalYear: prior.time_period.fiscal_year,
        priorFiscalYearTotal: prior.aggregated_amount,
        growthPct,
      };
    } catch {
      return null;
    }
  });
}
