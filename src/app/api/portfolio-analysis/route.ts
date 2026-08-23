import { NextResponse } from "next/server";
import { analyzePortfolio } from "@/lib/otto/portfolio-analysis";

interface PortfolioAnalysisRequestBody {
  symbols: string[];
}

export async function POST(request: Request) {
  const body = (await request.json()) as PortfolioAnalysisRequestBody;
  const symbols = (body.symbols ?? []).slice(0, 30); // bound one request's cost

  try {
    const analysis = await analyzePortfolio(symbols);
    return NextResponse.json(analysis);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
