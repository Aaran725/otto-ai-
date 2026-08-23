import { clsx } from "clsx";
import type { MetricComparison } from "@/lib/otto/schema";

const SIGNAL_COLOR: Record<MetricComparison["signal"], string> = {
  bull: "text-otto-bull",
  bear: "text-otto-bear",
  neutral: "text-otto-text-muted",
};

export function MetricsTable({ metrics }: { metrics: MetricComparison[] }) {
  return (
    <div>
      <div className="otto-text-label grid grid-cols-3 px-1 pb-2 text-otto-text-faint">
        <span>Metric</span>
        <span className="text-right">Otto</span>
        <span className="text-right">Benchmark</span>
      </div>
      <div className="otto-list-group">
        {metrics.map((m) => (
          <div key={m.label} className="otto-list-row grid grid-cols-3 items-center">
            <span className="otto-text-body text-otto-text-muted">{m.label}</span>
            <span
              className={clsx(
                "otto-text-body tabular-nums text-right font-medium",
                SIGNAL_COLOR[m.signal]
              )}
            >
              {m.value}
            </span>
            <span className="otto-text-body tabular-nums text-right text-otto-text-faint">
              {m.benchmark}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
