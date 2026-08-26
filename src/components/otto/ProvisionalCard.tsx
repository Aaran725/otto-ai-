import { clsx } from "clsx";
import type { LoggedCall } from "@/lib/otto/persistence";

function scoreColor(score: number) {
  if (score >= 75) return "var(--otto-gold)";
  if (score >= 55) return "var(--otto-bull)";
  if (score >= 40) return "var(--otto-text-muted)";
  return "var(--otto-bear)";
}

function relativeDay(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * The "delete the wait" move: a real search still has to fetch and compute
 * fresh data, no way around that, but the user doesn't have to stare at a
 * blank progress trace while it happens if Otto already has a real,
 * honestly-labeled last-known answer sitting in the call log. Shown only
 * while the matching search is actually in flight, and only ever built
 * from data that's already there (see ChatApp.tsx's send()) — no new fetch,
 * no new storage, just not making the user wait to see something real.
 */
export function ProvisionalCard({ prior }: { prior: LoggedCall }) {
  return (
    <div className="otto-material w-full max-w-md rounded-2xl border border-otto-border-soft p-5 opacity-75">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="otto-text-title text-otto-text">{prior.symbol}</span>
            <span className="otto-text-caption rounded-full border border-otto-border px-2 py-0.5 text-otto-text-muted">
              {prior.verdict}
            </span>
          </div>
          <p className="otto-text-caption mt-0.5 truncate text-otto-text-muted">{prior.companyName}</p>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="tabular-nums text-xl font-semibold text-otto-text">${prior.calledPrice.toFixed(2)}</span>
          </div>
        </div>
        <span className="tabular-nums text-2xl font-semibold" style={{ color: scoreColor(prior.convictionScore) }}>
          {Math.round(prior.convictionScore)}
        </span>
      </div>
      <p className={clsx("otto-text-caption mt-3 text-otto-gold")}>
        <span className="animate-pulse">●</span> Last checked {relativeDay(prior.calledAt)} — pulling fresh data now…
      </p>
    </div>
  );
}
