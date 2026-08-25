import { getShortInterestCache } from "./cache";

const FINRA_URL = "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest";

export interface ShortInterestData {
  shortShares: number;
  daysToCover: number;
  changePercent: number; // vs the prior settlement period
  settlementDate: string;
  // The settlement BEFORE the one above, when the 45-day window caught two
  // (FINRA publishes biweekly) — its own reported changePercent, not
  // re-derived from share counts. Lets a caller tell "one jump" apart from
  // "two consecutive rising periods," a genuinely different, stronger
  // signal a single period's changePercent can't show. Optional: absent
  // when only one settlement fell in the window.
  priorChangePercent?: number;
  priorSettlementDate?: string;
}

/**
 * FINRA's short-interest API is free and unauthenticated, but has a sharp
 * gotcha confirmed live: an unfiltered/undated query silently returns
 * stale default rows from 2019-2020 instead of an error — looks like it
 * worked, didn't. An explicit settlementDate range is required to get
 * current data. Published biweekly (mid-month and month-end settlement
 * dates, with a few days' reporting lag), so a 45-day trailing window
 * reliably catches at least one real settlement even right after a
 * publish date.
 */
export async function fetchShortInterest(symbol: string): Promise<ShortInterestData | null> {
  return getShortInterestCache<ShortInterestData | null>().getOrSet(symbol.toUpperCase(), async () => {
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 45 * 24 * 60 * 60 * 1000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);

      const res = await fetch(FINRA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: 5,
          dateRangeFilters: [{ startDate: fmt(start), endDate: fmt(end), fieldName: "settlementDate" }],
          compareFilters: [{ compareType: "equal", fieldName: "symbolCode", fieldValue: symbol.toUpperCase() }],
        }),
      });
      if (!res.ok) return null;

      const csv = await res.text();
      const lines = csv.trim().split("\n");
      if (lines.length < 2) return null; // header only, no data rows

      const header = parseCsvLine(lines[0]);
      const rows = lines.slice(1).map(parseCsvLine);

      const idx = (col: string) => header.indexOf(col);
      const shortIdx = idx("currentShortPositionQuantity");
      const daysIdx = idx("daysToCoverQuantity");
      const changeIdx = idx("changePercent");
      const dateIdx = idx("settlementDate");
      if ([shortIdx, daysIdx, changeIdx, dateIdx].some((i) => i === -1)) return null;

      // Multiple settlement dates can come back within the window — keep
      // the most recent one.
      rows.sort((a, b) => (a[dateIdx] < b[dateIdx] ? 1 : -1));
      const latest = rows[0];
      if (!latest) return null;

      const shortShares = Number(latest[shortIdx]);
      const daysToCover = Number(latest[daysIdx]);
      const changePercent = Number(latest[changeIdx]);
      if (!Number.isFinite(shortShares) || !Number.isFinite(daysToCover)) return null;

      const prior = rows[1];
      const priorChangePercent = prior ? Number(prior[changeIdx]) : undefined;
      const hasPrior = priorChangePercent !== undefined && Number.isFinite(priorChangePercent);

      return {
        shortShares,
        daysToCover,
        changePercent,
        settlementDate: latest[dateIdx],
        ...(hasPrior ? { priorChangePercent, priorSettlementDate: prior[dateIdx] } : {}),
      };
    } catch {
      return null;
    }
  });
}

/**
 * FINRA returns quoted CSV, and a plain split(",") corrupts any row whose
 * issuer name itself contains a comma — confirmed live: MARA's own name is
 * `"MARA Holdings, Inc. Common Sto"`, which shifted every column after it
 * and silently produced garbage (NaN share count) instead of an error. This
 * respects quotes so an embedded comma inside a quoted field doesn't split.
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}
