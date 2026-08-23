"use client";

import { useState } from "react";
import { clsx } from "clsx";
import type { PeerValuation } from "@/lib/otto/peers";

type SortKey = "symbol" | "pe" | "pfcf" | "roic";

function fmtX(n: number | undefined) {
  return n === undefined ? "—" : `${n.toFixed(1)}x`;
}
function fmtPct(n: number | undefined) {
  return n === undefined ? "—" : `${(n * 100).toFixed(1)}%`;
}

/** Real SEC-classified industry peers, sortable — the sector median row
 * stays pinned rather than sorting with the rest, since it's a reference
 * line, not another candidate. */
export function PeerComparisonTable({ peerValuation, symbol }: { peerValuation: PeerValuation; symbol: string }) {
  const [sortKey, setSortKey] = useState<SortKey>("pe");
  const [asc, setAsc] = useState(true);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setAsc(!asc);
    else {
      setSortKey(key);
      setAsc(true);
    }
  }

  const sorted = [...peerValuation.peers].sort((a, b) => {
    const av = sortKey === "symbol" ? a.symbol : a[sortKey];
    const bv = sortKey === "symbol" ? b.symbol : b[sortKey];
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return asc ? cmp : -cmp;
  });

  const headers: { key: SortKey; label: string }[] = [
    { key: "symbol", label: "Peer" },
    { key: "pe", label: "P/E" },
    { key: "pfcf", label: "P/FCF" },
    { key: "roic", label: "ROIC" },
  ];

  return (
    <div className="overflow-x-auto">
      <p className="otto-text-label mb-2 text-otto-text-faint">
        {peerValuation.sicDescription} · {peerValuation.peers.length} peers found
        {peerValuation.peers.length !== peerValuation.peerCount && ` (${peerValuation.peerCount} with valid P/E)`}
      </p>
      <table className="otto-list-group otto-text-body w-full min-w-[360px] border-collapse">
        <thead>
          <tr className="otto-text-label text-otto-text-faint">
            {headers.map((h) => (
              <th key={h.key} className={clsx("otto-list-row py-2 font-normal", h.key === "symbol" ? "text-left" : "text-right")}>
                <button onClick={() => toggleSort(h.key)} className="hover:text-otto-text">
                  {h.label}
                  {sortKey === h.key && (asc ? " ↑" : " ↓")}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="bg-otto-gold-soft/40">
            <td className="otto-list-row otto-text-caption text-left font-semibold text-otto-gold">Sector median</td>
            <td className="otto-list-row otto-text-caption text-right tabular-nums font-semibold text-otto-gold">{fmtX(peerValuation.medianPE)}</td>
            <td className="otto-list-row otto-text-caption text-right tabular-nums font-semibold text-otto-gold">{fmtX(peerValuation.medianPFCF ?? undefined)}</td>
            <td className="otto-list-row otto-text-caption text-right tabular-nums font-semibold text-otto-gold">{fmtPct(peerValuation.medianROIC ?? undefined)}</td>
          </tr>
          {sorted.map((p) => (
            <tr key={p.symbol} className={clsx(p.symbol === symbol && "bg-white/[0.04]")}>
              <td className="otto-list-row otto-text-caption text-left font-medium text-otto-text">{p.symbol}</td>
              <td className="otto-list-row otto-text-caption text-right tabular-nums text-otto-text-muted">{fmtX(p.pe)}</td>
              <td className="otto-list-row otto-text-caption text-right tabular-nums text-otto-text-muted">{fmtX(p.pfcf)}</td>
              <td className="otto-list-row otto-text-caption text-right tabular-nums text-otto-text-muted">{fmtPct(p.roic)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
