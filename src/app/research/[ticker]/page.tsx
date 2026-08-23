import Link from "next/link";
import { fetchStockBundle } from "@/lib/otto/fmp";
import { runOttoAnalysis } from "@/lib/otto/groq";
import { ResearchCard } from "@/components/otto/ResearchCard";

export const dynamic = "force-dynamic";

export default async function ResearchPage({
  params,
}: PageProps<"/research/[ticker]">) {
  const { ticker } = await params;
  const symbol = ticker.toUpperCase();

  let content: React.ReactNode;

  try {
    const bundle = await fetchStockBundle(symbol);
    const analysis = await runOttoAnalysis(symbol, bundle);
    content = <ResearchCard analysis={analysis} />;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    content = (
      <div className="mx-auto w-full max-w-3xl rounded-2xl border border-otto-bear/30 bg-otto-bear-soft p-8 text-center">
        <p className="text-sm text-otto-bear">Couldn&apos;t generate research for {symbol}.</p>
        <p className="mt-2 text-xs text-otto-text-faint">{message}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-10 sm:px-8">
      <div className="mx-auto mb-8 flex w-full max-w-3xl items-center justify-between">
        <Link href="/" className="text-sm font-medium tracking-tight text-otto-text-muted hover:text-otto-text">
          ← Otto
        </Link>
      </div>
      {content}
    </div>
  );
}
