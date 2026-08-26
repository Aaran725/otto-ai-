import { NextResponse } from "next/server";
import { buildWatchlistDigest } from "@/lib/otto/watchlist-digest";

// Same reasoning as the chat route's screener path — real multi-source
// fetch + LLM synthesis per symbol, run in parallel across up to 10 names,
// needs real headroom above the platform default.
export const maxDuration = 60;

interface WatchlistDigestRequestBody {
  symbols: string[];
}

export async function POST(request: Request) {
  const body = (await request.json()) as WatchlistDigestRequestBody;
  const symbols = body.symbols ?? [];

  try {
    const digest = await buildWatchlistDigest(symbols);
    return NextResponse.json({ digest });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
