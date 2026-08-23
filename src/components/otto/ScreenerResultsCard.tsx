"use client";

import { useState } from "react";
import { clsx } from "clsx";
import type { ScreenerResults } from "@/lib/otto/chat-types";
import { Disclaimer } from "./Disclaimer";

function scoreColor(score: number, isAvoidList: boolean) {
  // On the avoid list every entry is flagged as weak — the "least bad" one
  // still isn't good, so don't color it green the way a normal ranking would.
  if (isAvoidList) return "var(--otto-bear)";
  if (score >= 70) return "var(--otto-gold)";
  if (score >= 50) return "var(--otto-bull)";
  return "var(--otto-text-muted)";
}

/**
 * Three real segments only — Fundamentals (the Snowflake composite),
 * Insider (the actual ±4 rank nudge from Form 4 data), Filing (whether a
 * real 10-K excerpt was found). Deliberately NOT five: "Institutional" (SEC
 * 13F) and "Buzz" (Reddit) have no live per-ticker free source wired up —
 * an empty segment for either would read as "checked, found nothing"
 * instead of the truth, "never checked at all."
 */
function ConvictionStack({
  compositeScore,
  isAvoidList,
  insiderDirection,
  hasFiling,
}: {
  compositeScore: number;
  isAvoidList: boolean;
  insiderDirection?: "buying" | "selling" | "mixed";
  hasFiling: boolean;
}) {
  const fill = Math.max(4, Math.min(100, compositeScore));
  const color = scoreColor(compositeScore, isAvoidList);
  const insiderColor =
    insiderDirection === "buying" ? "var(--otto-bull)" : insiderDirection === "selling" ? "var(--otto-bear)" : undefined;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-white/[0.08]">
        <div className="h-full rounded-full transition-all" style={{ width: `${fill}%`, background: color }} />
      </div>
      <div className="flex items-center gap-1">
        <span className="h-1 w-1 rounded-full" style={{ background: color }} title="Fundamentals" />
        <span
          className="h-1 w-1 rounded-full"
          style={{ background: insiderColor ?? "var(--otto-text-faint)", opacity: insiderColor ? 1 : 0.3 }}
          title="Insider activity"
        />
        <span
          className="h-1 w-1 rounded-full"
          style={{ background: hasFiling ? "var(--otto-gold)" : "var(--otto-text-faint)", opacity: hasFiling ? 1 : 0.3 }}
          title="Filing-grounded"
        />
      </div>
    </div>
  );
}

/** Apple Stocks-app-style heat tile — background intensity scales with the
 * score itself (via opacity on the same bull/gold/muted color used
 * elsewhere), not a separate color scale, so grid and list modes read as
 * the same underlying data shown two ways. */
function HeatmapGrid({ screener, onSelect }: { screener: ScreenerResults; onSelect: (symbol: string) => void }) {
  return (
    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
      {screener.results.map((r, i) => {
        const color = scoreColor(r.compositeScore, screener.isAvoidList ?? false);
        const intensity = Math.max(0.15, Math.min(r.compositeScore / 100, 0.9));
        return (
          <button
            key={r.symbol}
            onClick={() => onSelect(r.symbol)}
            style={{ animationDelay: `${i * 60}ms`, background: color, opacity: intensity }}
            className="otto-arrive flex aspect-square flex-col items-center justify-center rounded-lg p-2 text-center transition-transform hover:scale-[1.03]"
          >
            <span className="text-sm font-bold text-black/80">{r.symbol}</span>
            <span className="text-[10px] font-medium text-black/70">{r.compositeScore}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ScreenerResultsCard({
  screener,
  onSelect,
}: {
  screener: ScreenerResults;
  onSelect: (symbol: string) => void;
}) {
  const VIEWS = ["list", "grid"] as const;
  const [view, setView] = useState<"list" | "grid">("list");

  return (
    <div className="otto-material otto-elevation-resting w-full max-w-md rounded-2xl border p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="otto-text-label text-otto-text-faint">{screener.intentLabel}</h3>
        <div className="otto-segmented">
          <div
            className="otto-segmented-thumb"
            style={{ left: `${(VIEWS.indexOf(view) / VIEWS.length) * 100}%`, width: `${100 / VIEWS.length}%` }}
          />
          {VIEWS.map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={clsx(
                "otto-text-caption relative z-10 rounded-full px-2.5 py-1 capitalize transition-colors",
                view === v ? "text-otto-bg" : "text-otto-text-faint hover:text-otto-text"
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === "grid" ? (
        <HeatmapGrid screener={screener} onSelect={onSelect} />
      ) : (
      <div className="divide-y divide-otto-border-soft">
        {screener.results.map((r, i) => (
          <button
            key={r.symbol}
            onClick={() => onSelect(r.symbol)}
            style={{ animationDelay: `${i * 60}ms` }}
            className="otto-arrive flex w-full flex-col gap-1.5 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
          >
            <div className="flex w-full items-center gap-3">
              <span className="w-4 shrink-0 text-xs text-otto-text-faint">{r.rank}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-otto-text">{r.symbol}</span>
                  <span className="truncate text-xs text-otto-text-faint">{r.companyName}</span>
                </div>
                <p className="truncate text-xs text-otto-text-muted">{r.keyStat}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {r.thinCoverage && (
                    <span className="inline-block rounded-full border border-otto-bear/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-otto-bear">
                      Thin coverage · speculative
                    </span>
                  )}
                  {r.insiderActivity && r.insiderActivity.direction !== "mixed" && (
                    <span
                      className="inline-block rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wide"
                      style={{
                        borderColor: r.insiderActivity.direction === "buying" ? "var(--otto-bull)" : "var(--otto-bear)",
                        color: r.insiderActivity.direction === "buying" ? "var(--otto-bull)" : "var(--otto-bear)",
                        opacity: 0.85,
                      }}
                    >
                      Insiders {r.insiderActivity.direction} · {r.insiderActivity.buys}B/{r.insiderActivity.sells}S 90d
                    </span>
                  )}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="tabular-nums text-sm text-otto-text">${r.price.toFixed(2)}</div>
                <div className="mt-1 flex items-center justify-end gap-2">
                  <span
                    className="tabular-nums text-xs font-medium"
                    style={{ color: scoreColor(r.compositeScore, screener.isAvoidList ?? false) }}
                  >
                    {r.compositeScore}
                  </span>
                  <ConvictionStack
                    compositeScore={r.compositeScore}
                    isAvoidList={screener.isAvoidList ?? false}
                    insiderDirection={r.insiderActivity?.direction}
                    hasFiling={Boolean(r.filingNote)}
                  />
                </div>
                <div className="mt-0.5 text-[9px] uppercase tracking-wide text-otto-text-faint">screen score</div>
              </div>
            </div>
            {r.filingNote && (
              <p className="pl-7 text-[11px] italic leading-snug text-otto-text-faint">
                From the 10-K: &ldquo;{r.filingNote}&rdquo;
              </p>
            )}
          </button>
        ))}
      </div>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-otto-text-faint">
        Screen score is a quick market-wide ranking — open a stock for Otto&apos;s full
        Conviction score, which weighs more context and won&apos;t always match.
      </p>
      <p className="mt-1 flex items-center gap-3 text-[9px] uppercase tracking-wide text-otto-text-faint">
        <span className="flex items-center gap-1">
          <span className="h-1 w-1 rounded-full bg-otto-gold" /> Fundamentals
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1 w-1 rounded-full bg-otto-bull" /> Insider
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1 w-1 rounded-full" style={{ background: "var(--otto-gold)" }} /> Filing
        </span>
      </p>
      <Disclaimer className="mt-2" />
    </div>
  );
}
