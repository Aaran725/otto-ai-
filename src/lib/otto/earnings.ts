import { getEarningsCache } from "./cache";

function getFinnhubKeys(): string[] {
  return [
    process.env.FINNHUB_API_KEY,
    process.env.FINNHUB_API_KEY_2,
    process.env.FINNHUB_API_KEY_3,
    process.env.FINNHUB_API_KEY_4,
    process.env.FINNHUB_API_KEY_5,
  ].filter((k): k is string => Boolean(k));
}

// Sticky cursor, same pattern as finnhub.ts's own rotation — a separate
// cursor here is fine since these are read-only lookups, not a shared
// rate-limit budget that needs coordinating with the main client.
const globalForEarningsRotation = globalThis as unknown as { __ottoEarningsKeyIndex?: number };

async function finnhubGet<T>(path: string): Promise<T | null> {
  const keys = getFinnhubKeys();
  if (keys.length === 0) return null;
  const startIndex = globalForEarningsRotation.__ottoEarningsKeyIndex ?? 0;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx = (startIndex + attempt) % keys.length;
    try {
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetch(`https://finnhub.io/api/v1${path}${sep}token=${keys[idx]}`, {
        next: { revalidate: 3600 },
      });
      if (res.status === 429) continue;
      if (!res.ok) return null;
      globalForEarningsRotation.__ottoEarningsKeyIndex = idx;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
  return null;
}

interface FinnhubEarningsCalendarEntry {
  date: string;
  epsEstimate: number | null;
  revenueEstimate: number | null;
}

interface FinnhubEarningsCalendarResponse {
  earningsCalendar: FinnhubEarningsCalendarEntry[];
}

interface FinnhubEarningsSurpriseEntry {
  period: string;
  estimate: number;
  actual: number;
  surprisePercent: number;
}

export interface EarningsSurprise {
  period: string; // fiscal quarter end date
  estimate: number;
  actual: number;
  surprisePercent: number;
  beat: boolean;
}

export interface EarningsRecord {
  nextEarningsDate: string | null;
  recentSurprises: EarningsSurprise[]; // up to 4, most recent first
  beatCount: number;
  missCount: number;
}

/**
 * Real earnings catalyst data from Finnhub's free calendar + surprise-
 * history endpoints — replaces LLM-guessed "catalysts" with an actual
 * beat/miss record and confirmed next report date. Best-effort: returns
 * null on failure rather than blocking the analysis.
 */
export async function fetchEarningsRecord(symbol: string): Promise<EarningsRecord | null> {
  return getEarningsCache<EarningsRecord | null>().getOrSet(symbol.toUpperCase(), async () => {
    const today = new Date();
    const in180Days = new Date(today.getTime() + 180 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const [calendar, surprises] = await Promise.all([
      finnhubGet<FinnhubEarningsCalendarResponse>(
        `/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${fmt(today)}&to=${fmt(in180Days)}`
      ),
      finnhubGet<FinnhubEarningsSurpriseEntry[]>(`/stock/earnings?symbol=${encodeURIComponent(symbol)}`),
    ]);

    const nextEarningsDate = calendar?.earningsCalendar?.[0]?.date ?? null;
    const recentSurprises: EarningsSurprise[] = (surprises ?? []).slice(0, 4).map((s) => ({
      period: s.period,
      estimate: s.estimate,
      actual: s.actual,
      surprisePercent: s.surprisePercent,
      beat: s.actual > s.estimate,
    }));

    if (!nextEarningsDate && recentSurprises.length === 0) return null;

    return {
      nextEarningsDate,
      recentSurprises,
      beatCount: recentSurprises.filter((s) => s.beat).length,
      missCount: recentSurprises.filter((s) => !s.beat).length,
    };
  });
}
