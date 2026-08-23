"use client";

import { useEffect, useState } from "react";
import type { WatchlistEntry } from "@/lib/otto/persistence";
import type { PortfolioAnalysis } from "@/lib/otto/portfolio-analysis";
import { removeFromWatchlist } from "@/lib/otto/persistence";
import { Disclaimer } from "./Disclaimer";

export function PortfolioPanel({
  watchlist,
  onChange,
  onSelect,
}: {
  watchlist: WatchlistEntry[];
  onChange: () => void;
  onSelect: (symbol: string) => void;
}) {
  const [analysis, setAnalysis] = useState<PortfolioAnalysis | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (watchlist.length < 2) {
      setAnalysis(null);
      return;
    }
    setLoading(true);
    fetch("/api/portfolio-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: watchlist.map((w) => w.symbol) }),
    })
      .then((res) => res.json())
      .then((data: PortfolioAnalysis) => setAnalysis(data))
      .catch(() => setAnalysis(null))
      .finally(() => setLoading(false));
  }, [watchlist]);

  return (
    <div>
      <h2 className="otto-text-title text-otto-text">Watchlist</h2>
      <p className="mt-1 text-sm text-otto-text-muted">
        {watchlist.length} name{watchlist.length === 1 ? "" : "s"} saved.
        {watchlist.length < 2 && " Add at least 2 for concentration/correlation checks."}
      </p>

      <div className="otto-list-group mt-4">
        {watchlist.map((w) => (
          <div key={w.symbol} className="otto-list-row flex items-center gap-3">
            <button className="min-w-0 flex-1 text-left" onClick={() => onSelect(w.symbol)}>
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold text-otto-text">{w.symbol}</span>
                <span className="truncate text-xs text-otto-text-faint">{w.companyName}</span>
              </div>
              <p className="text-xs text-otto-text-muted">
                Added at ${w.addedPrice.toFixed(2)} · {w.addedVerdict} · conviction {Math.round(w.addedConvictionScore)}
              </p>
            </button>
            <button
              onClick={() => {
                removeFromWatchlist(w.symbol);
                onChange();
              }}
              className="shrink-0 text-xs text-otto-text-faint hover:text-otto-bear"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {loading && <p className="mt-4 text-sm text-otto-text-muted">Checking sector concentration and correlation…</p>}

      {analysis && analysis.sectorConcentration.length === 0 && analysis.correlatedPairs.length === 0 && !loading && watchlist.length >= 2 && (
        <p className="mt-4 text-sm text-otto-bull">No concentration or correlation flags — reasonably diversified.</p>
      )}

      {analysis && analysis.sectorConcentration.length > 0 && (
        <div className="mt-4">
          <h3 className="otto-text-label text-otto-text-faint">Sector concentration</h3>
          <div className="mt-2 space-y-2">
            {analysis.sectorConcentration.map((s) => (
              <div key={s.sicDescription} className="rounded-lg border border-otto-bear/30 bg-otto-bear/5 px-3 py-2 text-sm">
                <span className="font-medium text-otto-text">{s.pct}% of your book</span>{" "}
                <span className="text-otto-text-muted">
                  is {s.sicDescription} ({s.symbols.join(", ")}) — not much diversification benefit there.
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {analysis && analysis.correlatedPairs.length > 0 && (
        <div className="mt-4">
          <h3 className="otto-text-label text-otto-text-faint">Highly correlated pairs</h3>
          <div className="mt-2 space-y-2">
            {analysis.correlatedPairs.map((p) => (
              <div key={`${p.a}-${p.b}`} className="rounded-lg border border-otto-bear/30 bg-otto-bear/5 px-3 py-2 text-sm">
                <span className="font-medium text-otto-text">
                  {p.a} &amp; {p.b}
                </span>{" "}
                <span className="text-otto-text-muted">moved together {Math.round(p.correlation * 100)}% of the time — limited diversification benefit holding both.</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Disclaimer className="mt-4" />
    </div>
  );
}
