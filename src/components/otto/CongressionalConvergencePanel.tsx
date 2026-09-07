"use client";

import type { CongressionalConvergence } from "@/lib/otto/house-stock-act";

/**
 * Real US House STOCK Act disclosure convergence — how many different
 * representatives each independently disclosed a real purchase of this
 * stock recently. House-only (Senate's efdsearch.senate.gov is a
 * confirmed-live Akamai-protected wall) — never framed as "rep X bought
 * it, buy it too," only the real, independent-agreement count.
 */
export function CongressionalConvergencePanel({ signal }: { signal: CongressionalConvergence }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="otto-text-label text-otto-text-faint">Congressional Buying (US House, STOCK Act)</p>
      <p className="text-xs text-otto-text-muted">
        <span className="font-medium text-otto-bull">{signal.buyerCount}</span> different representative
        {signal.buyerCount === 1 ? "" : "s"} disclosed a real purchase of this stock in the last {signal.windowDays}{" "}
        days — House only, real independent agreement, not one member's call.
      </p>
      <div className="flex flex-col gap-1">
        {signal.buyers.map((b, i) => (
          <div key={i} className="flex items-center justify-between text-[11px] text-otto-text-muted">
            <span>{b.name}</span>
            <span className="tabular-nums text-otto-text-faint">{b.transactionDate}</span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-otto-text-faint">
        House members have up to 45 real days under the STOCK Act to disclose a trade — this always reflects
        that real filing lag, never a live feed. Senate coverage isn&apos;t included (Senate's disclosure system
        blocks automated access).
      </p>
    </div>
  );
}
