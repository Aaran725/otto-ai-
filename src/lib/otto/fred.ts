import { getMacroCache } from "./cache";

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";

export interface MacroContext {
  fedFundsRate: number;
  treasury10Y: number;
  cpiYoyPct: number;
  asOf: string; // ISO date of the most recent series point used
}

interface FredObservation {
  date: string;
  value: string;
}

interface FredResponse {
  observations: FredObservation[];
}

async function fetchSeries(seriesId: string, limit: number): Promise<FredObservation[]> {
  const key = process.env.FRED_API_KEY;
  if (!key) return [];

  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=${limit}`;
  const res = await fetch(url, { next: { revalidate: 3600 } });
  if (!res.ok) return [];
  const data = (await res.json()) as FredResponse;
  return (data.observations ?? []).filter((o) => o.value !== ".");
}

/**
 * Macro backdrop is ticker-agnostic — one shared fetch serves every
 * analysis rather than hitting FRED per-ticker. Cached for hours since
 * these series move slowly (Fed funds monthly, CPI monthly, Treasury daily).
 */
export async function fetchMacroContext(): Promise<MacroContext | null> {
  return getMacroCache<MacroContext | null>().getOrSet("macro-context", async () => {
    try {
      const [fedFunds, treasury, cpi] = await Promise.all([
        fetchSeries("FEDFUNDS", 1),
        fetchSeries("DGS10", 5), // a few points back in case the latest 1-2 days are holidays/missing
        fetchSeries("CPIAUCSL", 13),
      ]);

      const fedFundsRate = fedFunds[0] ? Number(fedFunds[0].value) : null;
      const treasury10Y = treasury[0] ? Number(treasury[0].value) : null;

      let cpiYoyPct: number | null = null;
      if (cpi.length >= 12) {
        const latest = Number(cpi[0].value);
        const yearAgo = Number(cpi[cpi.length - 1].value);
        if (yearAgo !== 0) cpiYoyPct = ((latest - yearAgo) / yearAgo) * 100;
      }

      if (fedFundsRate === null || treasury10Y === null || cpiYoyPct === null) return null;

      return {
        fedFundsRate,
        treasury10Y,
        cpiYoyPct: Math.round(cpiYoyPct * 10) / 10,
        asOf: fedFunds[0].date,
      };
    } catch {
      return null;
    }
  });
}
