import { NextResponse } from "next/server";
import { evaluateDueScreenerCalls, updateDailyPeaks, evaluateFactorKillSwitch } from "@/lib/otto/screener-track-record";

/**
 * Cron target (see vercel.json) — daily sweep that (1) evaluates any
 * logged screener call that just crossed its 30/90/180-day mark, computing
 * real realized alpha vs SPY, (2) checks today's real price and alpha
 * against every active call's peaks and raises either if today's a new
 * high, and (3) checks whether any real-signal factor has been net-
 * negative for a full rolling quarter and kills it if so (see
 * evaluateFactorKillSwitch). All three are idempotent — a missed or
 * retried run never double-counts, lowers, or un-kills anything already
 * recorded.
 *
 * Gated behind CRON_SECRET when set, matching Vercel's own convention:
 * when the env var is present, Vercel's Cron scheduler automatically sends
 * `Authorization: Bearer $CRON_SECRET` on the request it triggers, so this
 * still fires on schedule with the secret set — it's just no longer
 * publicly triggerable by anyone who finds the URL. Same "open by default
 * until you set the secret" convention already used by /api/metrics.
 *
 * updateDailyPeaks and evaluateDueScreenerCalls both read-modify-write the
 * SAME call records (peakPrice/peakAlphaPct vs. evaluations/closed) —
 * running them in Promise.all used to race: whichever finished last wrote
 * back its OWN stale read of the record, silently erasing whatever the
 * other one had just written. Confirmed live: a synthetic 31-day-old test
 * record got correctly evaluated (evaluated:1 in the response) but the
 * evaluations.d30 write never actually stuck — updateDailyPeaks's
 * peakPrice update, reading the pre-evaluation snapshot, overwrote it a
 * moment later. Real bug, real consequence (a milestone evaluation could
 * silently vanish on any day its call also got a peak update, which is
 * most days) — not something a synthetic test happened to trigger by
 * chance. Sequenced below on purpose; evaluateFactorKillSwitch never
 * touches an individual call record, so it stays safely parallel.
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
  const [peaks, factorKillSwitch] = await Promise.all([updateDailyPeaks(), evaluateFactorKillSwitch()]);
  const evaluation = await evaluateDueScreenerCalls();
  return NextResponse.json({ evaluation, peaks, factorKillSwitch });
}
