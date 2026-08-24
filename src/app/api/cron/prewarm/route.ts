import { NextResponse } from "next/server";
import { fetchSecUniverse, fetchSicCode } from "@/lib/otto/sec-universe";
import { getSymbolSnapshot } from "@/lib/otto/screener";
import { mapWithConcurrency } from "@/lib/otto/batch";

/**
 * Daily cron target (see vercel.json) — quietly refreshes the per-symbol
 * snapshot cache (45min TTL) and the SIC classification cache (24h TTL)
 * for a rotating slice of the real universe, so a live user's screener
 * scan or single-stock lookup is more likely to hit a warm cache instead
 * of paying for a cold Finnhub/SEC fetch. Rotates by day-of-year so a
 * different slice warms each day — full universe coverage over time
 * without needing more than one run a day (Vercel Hobby's cron limit).
 *
 * Deliberately modest batch sizes: this shares the same real API budgets
 * (Finnhub's 60/min/key, the SEC EDGAR rate-limit tracker in rate-limit.ts)
 * as live traffic, so pre-warming must never be large enough to itself
 * become the thing that trips a limit real users then pay for.
 */
export const maxDuration = 60;

const SNAPSHOT_BATCH = 150;
const SIC_BATCH = 60; // subset of the same day's window — SIC only matters for symbols also worth scoring
const CONCURRENCY = 10;

function dayOfYear(): number {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  return Math.floor((now.getTime() - start) / (24 * 60 * 60 * 1000));
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Not authorized" }, { status: 401 });
    }
  }

  const universe = await fetchSecUniverse(1000);
  if (universe.length === 0) {
    return NextResponse.json({ warmed: { snapshots: 0, sic: 0 }, universeSize: 0 });
  }

  const start = (dayOfYear() * SNAPSHOT_BATCH) % universe.length;
  let batch = universe.slice(start, start + SNAPSHOT_BATCH);
  if (batch.length < SNAPSHOT_BATCH) batch = [...batch, ...universe.slice(0, SNAPSHOT_BATCH - batch.length)];
  const sicBatch = batch.slice(0, SIC_BATCH);

  const [snapshotResults, sicResults] = await Promise.all([
    mapWithConcurrency(batch, CONCURRENCY, async (c) => getSymbolSnapshot(c.symbol).catch(() => null)),
    mapWithConcurrency(sicBatch, CONCURRENCY, async (c) => fetchSicCode(c.symbol).catch(() => null)),
  ]);

  return NextResponse.json({
    warmed: {
      snapshots: snapshotResults.filter((r) => r !== null).length,
      sic: sicResults.filter((r) => r !== null).length,
    },
    batchSize: batch.length,
    universeSize: universe.length,
  });
}
