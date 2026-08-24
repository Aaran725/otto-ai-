import { NextResponse } from "next/server";
import { evaluateDueScreenerCalls, updateDailyPeaks } from "@/lib/otto/screener-track-record";

/**
 * Cron target (see vercel.json) — daily sweep that (1) evaluates any
 * logged screener call that just crossed its 30/90/180-day mark, computing
 * real realized alpha vs SPY, and (2) checks today's real price against
 * every active call's peak and raises it if today's a new high. Both are
 * idempotent — a missed or retried run never double-counts or lowers
 * anything already recorded.
 *
 * Gated behind CRON_SECRET when set, matching Vercel's own convention:
 * when the env var is present, Vercel's Cron scheduler automatically sends
 * `Authorization: Bearer $CRON_SECRET` on the request it triggers, so this
 * still fires on schedule with the secret set — it's just no longer
 * publicly triggerable by anyone who finds the URL. Same "open by default
 * until you set the secret" convention already used by /api/metrics.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Not authorized" }, { status: 401 });
    }
  }
  const [evaluation, peaks] = await Promise.all([evaluateDueScreenerCalls(), updateDailyPeaks()]);
  return NextResponse.json({ evaluation, peaks });
}
