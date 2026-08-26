import { clsx } from "clsx";
import type { WhatChanged } from "@/lib/otto/chat-types";

function relativeDay(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** Search already has memory (every fresh search gets logged, unfiltered —
 * see persistence.ts's call log) — this is what surfaces it: a quiet
 * "here's what's different since you last looked" instead of the same
 * static verdict every time, with no new fetch or storage, just a diff
 * against the record that already existed. */
export function WhatChangedBanner({ whatChanged }: { whatChanged: WhatChanged }) {
  const up = whatChanged.scoreDelta >= 0;
  return (
    <div className="mb-2 rounded-xl border border-otto-gold/30 bg-otto-gold/[0.04] px-3 py-2 text-xs text-otto-text-muted">
      <span className="font-medium text-otto-gold">Since you last checked</span> ({relativeDay(whatChanged.previousAt)}):{" "}
      {whatChanged.previousVerdict} at {Math.round(whatChanged.previousScore)}.{" "}
      Conviction {up ? "up" : "down"}{" "}
      <span className={clsx("font-medium tabular-nums", up ? "text-otto-bull" : "text-otto-bear")}>
        {up ? "+" : ""}
        {Math.round(whatChanged.scoreDelta)}
      </span>
      .
    </div>
  );
}
