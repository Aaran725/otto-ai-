"use client";

import type { InstitutionalConvergence } from "@/lib/otto/sec-13f";

/**
 * Real 13F convergence — how many of a curated, independent list of
 * well-known institutional managers each increased their own position,
 * per their own real quarterly filing. Deliberately never framed as
 * "fund X bought it, buy it too" — research is clear that's the weak,
 * unreliable use of 13F data. Only the real, independent-agreement count.
 */
export function InstitutionalConvergencePanel({ signal }: { signal: InstitutionalConvergence }) {
  const filingDate = new Date(signal.asOfFilingDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return (
    <div className="flex flex-col gap-2">
      <p className="otto-text-label text-otto-text-faint">Institutional Convergence (SEC Form 13F)</p>
      <p className="text-xs text-otto-text-muted">
        <span className="font-medium text-otto-bull">
          {signal.increasedCount} of {signal.totalManagersChecked}
        </span>{" "}
        real, independent managers we track each increased their own position last quarter — not one fund's
        call, real agreement across unrelated managers.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {signal.managerNames.map((name) => (
          <span
            key={name}
            className="inline-block rounded-full border border-otto-border-soft px-2 py-0.5 text-[10px] text-otto-text-muted"
          >
            {name}
          </span>
        ))}
      </div>
      <p className="text-[10px] text-otto-text-faint">
        As of the {filingDate} 13F filing — real institutional data is always at least a quarter old (a real
        45-day SEC filing lag), never live.
      </p>
    </div>
  );
}
