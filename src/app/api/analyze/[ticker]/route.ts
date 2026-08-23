import { NextResponse } from "next/server";
import { fetchStockBundle } from "@/lib/otto/fmp";
import { runOttoAnalysis } from "@/lib/otto/groq";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/analyze/[ticker]">
) {
  const { ticker } = await ctx.params;

  try {
    const bundle = await fetchStockBundle(ticker);
    const analysis = await runOttoAnalysis(bundle.symbol, bundle);
    return NextResponse.json(analysis);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
