import type { FollowUpVisual } from "@/lib/otto/chat-types";
import { PriceChart } from "./PriceChart";
import { MetricsTable } from "./MetricsTable";
import { ThesisCard } from "./ThesisCard";
import { SnowflakeChart } from "./SnowflakeChart";
import { PeerComparisonTable } from "./PeerComparisonTable";
import { ValuationGaugeCluster } from "./ValuationGaugeCluster";
import { RatingDonut } from "./RatingDonut";
import { RevenueMarginChart } from "./RevenueMarginChart";
import { CashFlowWaterfall } from "./CashFlowWaterfall";
import { InsiderTimeline } from "./InsiderTimeline";

const TITLES: Record<FollowUpVisual["type"], string> = {
  forecast: "Forecast",
  metrics: "Financial Metrics",
  thesis: "Thesis",
  snowflake: "Otto Snowflake",
  peers: "Peer Comparison",
  rating: "Analyst Ratings",
  revenue: "Revenue & Margin",
  cashflow: "Cash Flow Bridge",
  sparkline: "Trend", // rendered inline in the chat bubble instead — see ChatApp.tsx
  insider: "Insider Activity",
};

export function FollowUpVisualCard({ visual }: { visual: FollowUpVisual }) {
  return (
    <div className="otto-material otto-elevation-resting w-full max-w-md rounded-2xl border p-4">
      <h3 className="otto-text-label mb-3 text-otto-text-faint">
        {TITLES[visual.type]}
      </h3>

      {visual.type === "forecast" && (
        <>
          <div className="mb-2 flex items-center gap-3 text-[11px] tabular-nums">
            <span className="text-otto-bear">${visual.forecast.bearTarget.toFixed(0)}</span>
            <span className="text-otto-gold">${visual.forecast.baseTarget.toFixed(0)}</span>
            <span className="text-otto-bull">${visual.forecast.bullTarget.toFixed(0)}</span>
            {visual.street?.targetConsensus !== undefined && (
              <span className="text-otto-text-faint">
                Street ${visual.street.targetConsensus.toFixed(0)}
              </span>
            )}
          </div>
          <PriceChart
            data={visual.historicalPrices}
            positive={visual.positive}
            forecast={visual.forecast}
            street={visual.street}
          />
        </>
      )}

      {visual.type === "metrics" && <MetricsTable metrics={visual.metrics} />}

      {visual.type === "thesis" && (
        <ThesisCard catalysts={visual.catalysts} risks={visual.risks} />
      )}

      {visual.type === "snowflake" && <SnowflakeChart snowflake={visual.snowflake} />}

      {visual.type === "peers" && (
        <div className="flex flex-col gap-5">
          <ValuationGaugeCluster
            peerValuation={visual.peerValuation}
            currentPE={visual.currentPE}
            currentPFCF={visual.currentPFCF}
            currentROIC={visual.currentROIC}
          />
          <PeerComparisonTable peerValuation={visual.peerValuation} symbol="" />
        </div>
      )}

      {visual.type === "rating" && <RatingDonut street={visual.street} />}

      {visual.type === "revenue" && <RevenueMarginChart data={visual.fundamentalTrend} />}

      {visual.type === "cashflow" && <CashFlowWaterfall data={visual.fundamentalTrend} />}

      {visual.type === "insider" && <InsiderTimeline insiderActivity={visual.insiderActivity} />}
    </div>
  );
}
