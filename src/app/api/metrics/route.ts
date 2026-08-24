import { NextResponse } from "next/server";
import { getMetricsSnapshot } from "@/lib/otto/observability";

/**
 * Basic error-rate visibility (Phase 3 item 2) — no monitoring service
 * wired up, so this is a plain JSON snapshot of the in-process counters
 * from metrics.ts. Gated behind METRICS_SECRET when set, since even
 * aggregate counts (which tickers hit data failures) aren't something to
 * leave fully public by default; if the env var isn't set, the endpoint is
 * open (fine for local/dev, set the secret in production).
 */
export async function GET(request: Request) {
  const secret = process.env.METRICS_SECRET;
  if (secret) {
    const provided = new URL(request.url).searchParams.get("secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Not authorized" }, { status: 401 });
    }
  }
  return NextResponse.json(getMetricsSnapshot());
}
