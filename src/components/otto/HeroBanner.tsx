import { clsx } from "clsx";
import type { OttoAnalysis } from "@/lib/otto/schema";
import { ConvictionGauge } from "./ConvictionGauge";
import { VerdictTag } from "./VerdictTag";
import { PriceChart } from "./PriceChart";

export function HeroBanner({ analysis }: { analysis: OttoAnalysis }) {
  const positive = analysis.priceChangePercent1D >= 0;

  return (
    <div className="otto-material otto-elevation-raised rounded-2xl border p-6 sm:p-8">
      <div className="flex flex-col justify-between gap-8 sm:flex-row sm:items-start">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="otto-text-display text-otto-text">
              {analysis.ticker}
            </h1>
            <VerdictTag verdict={analysis.verdict} />
          </div>
          <p className="mt-1 text-sm text-otto-text-muted">{analysis.companyName}</p>

          <div className="mt-6 flex items-baseline gap-3">
            <span className="tabular-nums text-4xl font-semibold text-otto-text">
              ${analysis.price.toFixed(2)}
            </span>
            <span
              className={clsx(
                "tabular-nums text-sm font-medium",
                positive ? "text-otto-bull" : "text-otto-bear"
              )}
            >
              {positive ? "+" : ""}
              {analysis.priceChangePercent1D.toFixed(2)}%
            </span>
            <span className="text-xs text-otto-text-faint">{analysis.currency} · 1D</span>
          </div>

          <p className="mt-5 max-w-lg text-sm leading-relaxed text-otto-text-muted">
            {analysis.oneLiner}
          </p>
        </div>

        <div className="flex flex-col items-center gap-2">
          <ConvictionGauge score={analysis.convictionScore} />
          {analysis.positionSizing && (
            <div className="text-center" title={analysis.positionSizing.rationale}>
              <div className="tabular-nums text-sm font-semibold text-otto-text">
                {analysis.positionSizing.suggestedPct}%
              </div>
              <div className="text-[9px] uppercase tracking-wide text-otto-text-faint">suggested size</div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 border-t border-otto-border-soft pt-6">
        <div className="mb-3 flex items-center justify-between">
          <span className="otto-text-label text-otto-text-faint">
            12mo Price History &amp; Otto Forecast
          </span>
          <div className="flex items-center gap-3 text-[11px] tabular-nums">
            <span className="text-otto-bear">${analysis.forecast.bearTarget.toFixed(0)}</span>
            <span className="text-otto-gold">${analysis.forecast.baseTarget.toFixed(0)}</span>
            <span className="text-otto-bull">${analysis.forecast.bullTarget.toFixed(0)}</span>
          </div>
        </div>
        <PriceChart
          data={analysis.historicalPrices}
          positive={positive}
          forecast={analysis.forecast}
          street={analysis.streetConsensus}
        />
        <p className="mt-3 text-xs leading-relaxed text-otto-text-faint">
          {analysis.forecast.rationale}
        </p>

        {analysis.streetConsensus && (
          <div className="mt-4 flex flex-col gap-2 rounded-lg border border-otto-border-soft bg-black/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="flex items-center gap-2 text-xs text-otto-text-muted">
              <span className="h-2 w-2 shrink-0 rounded-full bg-otto-text" />
              Otto vs. The Street
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
              <span className="text-otto-gold">
                Otto ${analysis.forecast.baseTarget.toFixed(0)}
              </span>
              {analysis.streetConsensus.targetConsensus !== undefined ? (
                <span className="text-otto-text">
                  Street ${analysis.streetConsensus.targetConsensus.toFixed(0)}
                </span>
              ) : (
                <span className="text-otto-text-faint">no price target available</span>
              )}
              <span className="text-otto-text-faint">
                {analysis.streetConsensus.analystCount} analysts · {analysis.streetConsensus.rating}
              </span>
            </div>
          </div>
        )}

        {analysis.macro && (
          <div className="otto-text-label mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-otto-text-faint">
            <span>Macro</span>
            <span className="tabular-nums normal-case">Fed Funds {analysis.macro.fedFundsRate.toFixed(2)}%</span>
            <span className="tabular-nums normal-case">10Y {analysis.macro.treasury10Y.toFixed(2)}%</span>
            <span className="tabular-nums normal-case">CPI YoY {analysis.macro.cpiYoyPct.toFixed(1)}%</span>
            {analysis.rateSensitivity && (
              <span
                className="normal-case"
                style={{
                  color:
                    analysis.rateSensitivity === "high"
                      ? "var(--otto-bear)"
                      : analysis.rateSensitivity === "low"
                        ? "var(--otto-bull)"
                        : undefined,
                }}
              >
                Rate sensitivity: {analysis.rateSensitivity}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
