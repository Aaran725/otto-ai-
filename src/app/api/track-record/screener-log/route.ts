import { NextResponse } from "next/server";
import { getAllScreenerCalls } from "@/lib/otto/screener-track-record";

/**
 * Private-only viewer for the permanent screener track record (Phase 1b) —
 * deliberately not a public page yet. Reuses METRICS_SECRET as the gate,
 * same "private diagnostic" tier as /api/metrics, rather than introducing
 * a second secret for what's conceptually the same kind of endpoint. This
 * stays private until the graduation criteria (real sample size, real
 * elapsed time, avoid/best calibration confirmed against the backtest
 * script) are actually met — see the Phase 1c plan.
 */
export async function GET(request: Request) {
  const secret = process.env.METRICS_SECRET;
  if (secret) {
    const provided = new URL(request.url).searchParams.get("secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Not authorized" }, { status: 401 });
    }
  }
  const calls = await getAllScreenerCalls();
  calls.sort((a, b) => new Date(b.calledAt).getTime() - new Date(a.calledAt).getTime());
  return NextResponse.json({ count: calls.length, calls });
}
