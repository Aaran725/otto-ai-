"use client";

import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";

interface Preset {
  label: string;
  emoji: string;
  query: string;
}

const PRESETS: Preset[] = [
  { emoji: "🏢", label: "Mega-cap giants", query: "best mega cap stocks like Apple, Google, Tesla" },
  { emoji: "🏆", label: "Otto's best pick", query: "what's your best pick?" },
  { emoji: "💎", label: "Undervalued", query: "find undervalued stocks" },
  { emoji: "🚀", label: "Rocket stocks", query: "any rocket stocks?" },
  { emoji: "🛡️", label: "Safe & stable", query: "safe stable stocks" },
  { emoji: "⚠️", label: "Stocks to avoid", query: "stocks to avoid" },
  { emoji: "🤖", label: "AI stocks", query: "best AI stocks" },
  { emoji: "🏥", label: "Healthcare", query: "best healthcare stocks" },
];

export function PresetMenu({ onSelect, disabled }: { onSelect: (query: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-label="Quick screens"
        className={clsx(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-otto-border text-otto-text-muted transition-colors",
          "hover:border-otto-text-faint hover:text-otto-text disabled:opacity-40",
          open && "border-otto-gold text-otto-gold"
        )}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="otto-material-thick otto-elevation-floating absolute bottom-full left-0 mb-2 w-64 rounded-2xl border p-2">
          <p className="otto-text-label px-2 pb-1.5 pt-1 text-otto-text-faint">
            Quick screens
          </p>
          <div className="flex flex-col gap-0.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSelect(p.query);
                }}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-otto-text transition-colors hover:bg-white/[0.06]"
              >
                <span className="text-base leading-none">{p.emoji}</span>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
