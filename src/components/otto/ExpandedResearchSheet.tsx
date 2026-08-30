"use client";

import { useState } from "react";
import { clsx } from "clsx";
import type { OttoAnalysis } from "@/lib/otto/schema";
import { ConvictionGauge } from "./ConvictionGauge";
import { VerdictTag } from "./VerdictTag";
import { PriceChart } from "./PriceChart";
import { SnowflakeChart } from "./SnowflakeChart";
import { MetricsTable } from "./MetricsTable";
import { FundamentalTrendChart } from "./FundamentalTrendChart";
import { ThesisCard } from "./ThesisCard";
import { Disclaimer } from "./Disclaimer";
import { PeerComparisonTable } from "./PeerComparisonTable";
import { ValuationGaugeCluster } from "./ValuationGaugeCluster";
import { RatingDonut } from "./RatingDonut";
import { RevenueMarginChart } from "./RevenueMarginChart";
import { CashFlowWaterfall } from "./CashFlowWaterfall";
import { InsiderTimeline } from "./InsiderTimeline";
import { CandlestickChart } from "./CandlestickChart";
import { useGlassPointer } from "./useGlassPointer";

const TABS = ["Overview", "Financials", "Snowflake", "Forecast", "Catalysts"] as const;
type Tab = (typeof TABS)[number];

/**
 * Otto handing you a folder that opens on the table, not a page reload —
 * the compact chat card expands in place into this tabbed sheet, right
 * where it sits in the thread, and collapses back into the same slot.
 * "Catalysts" (not "News") is the deliberately honest label for the fifth
 * tab: real catalysts/risks grounded in filings and earnings data, not a
 * live news feed this app doesn't have.
 */
export function ExpandedResearchSheet({
  analysis,
  onCollapse,
  watched,
  onToggleWatch,
}: {
  analysis: OttoAnalysis;
  onCollapse: () => void;
  watched?: boolean;
  onToggleWatch?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("Overview");
  const positive = analysis.priceChangePercent1D >= 0;
  const glass = useGlassPointer<HTMLDivElement>();

  return (
    <div
      ref={glass.ref}
      onMouseMove={glass.onMouseMove}
      className="otto-expand otto-glass otto-material-thick otto-elevation-floating w-full max-w-2xl overflow-hidden rounded-2xl border"
    >
      <div className="relative z-10 flex items-start justify-between gap-4 p-5 pb-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="otto-text-title text-otto-text">{analysis.ticker}</h2>
            <VerdictTag verdict={analysis.verdict} dataQuality={analysis.dataQuality} />
          </div>
          <p className="otto-text-caption mt-0.5 text-otto-text-muted">{analysis.companyName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {onToggleWatch && (
            <button
              onClick={onToggleWatch}
              aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
              className={clsx("text-lg leading-none", watched ? "text-otto-gold" : "text-otto-text-faint hover:text-otto-text")}
            >
              {watched ? "★" : "☆"}
            </button>
          )}
          <button
            onClick={() => {
              if (typeof window !== "undefined") {
                navigator.clipboard.writeText(`${window.location.origin}/research/${analysis.ticker}`);
              }
            }}
            className="rounded-full border border-otto-border px-2.5 py-1 text-[10px] text-otto-text-faint hover:text-otto-text"
          >
            Copy link
          </button>
          <button
            onClick={onCollapse}
            aria-label="Collapse"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-otto-border text-otto-text-muted hover:text-otto-text"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="otto-segmented relative z-10 mx-5 mt-4">
        <div
          className="otto-segmented-thumb"
          style={{ left: `${(TABS.indexOf(tab) / TABS.length) * 100}%`, width: `${100 / TABS.length}%` }}
        />
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx(
              "otto-text-caption relative z-10 flex-1 whitespace-nowrap rounded-full px-2 py-1.5 text-center font-medium transition-colors",
              tab === t ? "text-otto-bg" : "text-otto-text-faint hover:text-otto-text"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="relative z-10 p-5">
        {tab === "Overview" && (
          <div className="flex flex-col gap-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-baseline gap-3">
                  <span className="otto-text-display tabular-nums text-otto-text">${analysis.price.toFixed(2)}</span>
                  <span className={clsx("tabular-nums text-sm font-medium", positive ? "text-otto-bull" : "text-otto-bear")}>
                    {positive ? "+" : ""}
                    {analysis.priceChangePercent1D.toFixed(2)}%
                  </span>
                  <span className="text-xs text-otto-text-faint">{analysis.currency} · 1D</span>
                </div>
                <p className="otto-text-body mt-3 max-w-md text-otto-text-muted">{analysis.oneLiner}</p>
              </div>
              <ConvictionGauge score={analysis.convictionScore} dataQuality={analysis.dataQuality} />
            </div>
            {analysis.historicalPrices.some((p) => p.open !== undefined) && (
              <div>
                <p className="otto-text-label mb-2 text-otto-text-faint">Recent Candles</p>
                <CandlestickChart data={analysis.historicalPrices} />
              </div>
            )}
            <p className="otto-text-body text-otto-text-muted">{analysis.synthesis}</p>
            {analysis.reconciliationNote && (
              <div className="rounded-lg border border-otto-gold/25 bg-otto-gold-soft px-4 py-3 text-xs text-otto-text-muted">
                <span className="font-medium text-otto-gold">Score changed from the screen. </span>
                {analysis.reconciliationNote}
              </div>
            )}
            {analysis.counterArgument && (
              <div className="rounded-lg border border-otto-bear/25 bg-otto-bear-soft px-4 py-3 text-xs text-otto-text-muted">
                <span className="font-medium text-otto-bear">If Otto's wrong. </span>
                {analysis.counterArgument}
              </div>
            )}
            {analysis.positionSizing && analysis.dataQuality !== "insufficient" && (
              <div className="rounded-lg border border-otto-border-soft bg-black/20 px-4 py-3 text-xs text-otto-text-muted">
                <span className="font-medium text-otto-text">Suggested size: {analysis.positionSizing.suggestedPct}% of book.</span>{" "}
                {analysis.positionSizing.rationale}
              </div>
            )}
            {analysis.macro && (
              <div className="otto-text-label flex flex-wrap items-center gap-x-3 gap-y-1 text-otto-text-faint">
                <span>Macro</span>
                <span className="tabular-nums normal-case">Fed Funds {analysis.macro.fedFundsRate.toFixed(2)}%</span>
                <span className="tabular-nums normal-case">10Y {analysis.macro.treasury10Y.toFixed(2)}%</span>
                <span className="tabular-nums normal-case">CPI YoY {analysis.macro.cpiYoyPct.toFixed(1)}%</span>
                {analysis.rateSensitivity && <span className="normal-case">Rate sensitivity: {analysis.rateSensitivity}</span>}
              </div>
            )}
          </div>
        )}

        {tab === "Financials" && (
          <div className="flex flex-col gap-6">
            <MetricsTable metrics={analysis.metrics} />
            {analysis.peerValuation && (
              <div className="flex flex-col gap-5 border-t border-otto-border-soft pt-5">
                <ValuationGaugeCluster
                  peerValuation={analysis.peerValuation}
                  currentPE={parseMetric(analysis, "Valuation (P/E)")}
                  currentPFCF={pfcfFromYield(parseMetric(analysis, "FCF Yield"))}
                  currentROIC={roicFraction(parseMetric(analysis, "ROIC"))}
                />
                <PeerComparisonTable peerValuation={analysis.peerValuation} symbol={analysis.ticker} />
              </div>
            )}
            <div className="border-t border-otto-border-soft pt-5">
              <p className="mb-3 otto-text-label text-otto-text-faint">Revenue &amp; Margin</p>
              <RevenueMarginChart data={analysis.fundamentalTrend} />
            </div>
            <div className="border-t border-otto-border-soft pt-5">
              <p className="mb-3 otto-text-label text-otto-text-faint">Cash Flow Bridge</p>
              <CashFlowWaterfall data={analysis.fundamentalTrend} />
            </div>
            <div className="border-t border-otto-border-soft pt-5">
              <FundamentalTrendChart data={analysis.fundamentalTrend} />
            </div>
          </div>
        )}

        {tab === "Snowflake" && <SnowflakeChart snowflake={analysis.snowflake} />}

        {tab === "Forecast" && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="otto-text-label text-otto-text-faint">12mo Price History &amp; Forecast</span>
              <div className="flex items-center gap-3 text-[11px] tabular-nums">
                <span className="text-otto-bear">${analysis.forecast.bearTarget.toFixed(0)}</span>
                <span className="text-otto-gold">${analysis.forecast.baseTarget.toFixed(0)}</span>
                <span className="text-otto-bull">${analysis.forecast.bullTarget.toFixed(0)}</span>
              </div>
            </div>
            <PriceChart data={analysis.historicalPrices} positive={positive} forecast={analysis.forecast} street={analysis.streetConsensus} />
            <p className="text-xs leading-relaxed text-otto-text-faint">{analysis.forecast.rationale}</p>
            {analysis.streetConsensus && (
              <div className="flex flex-col gap-2 rounded-lg border border-otto-border-soft bg-black/20 px-4 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-xs text-otto-text-muted">Otto vs. The Street</span>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
                    <span className="text-otto-gold">Otto ${analysis.forecast.baseTarget.toFixed(0)}</span>
                    {analysis.streetConsensus.targetConsensus !== undefined ? (
                      <span className="text-otto-text">Street ${analysis.streetConsensus.targetConsensus.toFixed(0)}</span>
                    ) : (
                      <span className="text-otto-text-faint">no price target available</span>
                    )}
                    <span className="text-otto-text-faint">
                      {analysis.streetConsensus.analystCount} analysts · {analysis.streetConsensus.rating}
                    </span>
                  </div>
                </div>
                {(analysis.streetConsensus.ratingTrend || analysis.streetConsensus.targetDispersionPct !== undefined) && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-otto-border-soft/60 pt-2 text-[11px] text-otto-text-faint">
                    {analysis.streetConsensus.ratingTrend && analysis.streetConsensus.ratingTrend.direction !== "flat" && (
                      <span
                        className={
                          analysis.streetConsensus.ratingTrend.direction === "improving" ? "text-otto-bull" : "text-otto-bear"
                        }
                      >
                        {analysis.streetConsensus.ratingTrend.direction === "improving" ? "↑" : "↓"} Estimates{" "}
                        {analysis.streetConsensus.ratingTrend.direction} recently
                      </span>
                    )}
                    {analysis.streetConsensus.targetDispersionPct !== undefined && (
                      <span>
                        {analysis.streetConsensus.targetDispersionPct >= 30 ? "Wide disagreement" : "Tight consensus"} — targets
                        span {analysis.streetConsensus.targetDispersionPct.toFixed(0)}% of the consensus
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
            {analysis.streetConsensus && analysis.streetConsensus.analystCount > 0 && (
              <div className="border-t border-otto-border-soft pt-4">
                <RatingDonut street={analysis.streetConsensus} />
              </div>
            )}
          </div>
        )}

        {tab === "Catalysts" && (
          <div className="flex flex-col gap-6">
            <ThesisCard catalysts={analysis.catalysts} risks={analysis.risks} />
            {analysis.insiderActivity && (
              <div className="border-t border-otto-border-soft pt-5">
                <p className="otto-text-label mb-3 text-otto-text-faint">Insider Activity</p>
                <InsiderTimeline insiderActivity={analysis.insiderActivity} />
              </div>
            )}
          </div>
        )}
      </div>

      <Disclaimer className="relative z-10 px-5 pb-5" />
    </div>
  );
}

function parseMetric(analysis: OttoAnalysis, label: string): number | undefined {
  const raw = analysis.metrics.find((m) => m.label === label)?.value;
  if (!raw || raw === "n/a") return undefined;
  return Number.parseFloat(raw);
}

/** FCF Yield is stored as a %; P/FCF is its reciprocal. */
function pfcfFromYield(fcfYieldPct: number | undefined): number | undefined {
  return fcfYieldPct && fcfYieldPct > 0 ? 100 / fcfYieldPct : undefined;
}

/** ROIC is stored as a %; peerValuation.medianROIC is a fraction. */
function roicFraction(roicPct: number | undefined): number | undefined {
  return roicPct !== undefined ? roicPct / 100 : undefined;
}
