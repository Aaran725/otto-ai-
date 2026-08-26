"use client";

import { useRef } from "react";
import { clsx } from "clsx";

const CAPABILITIES = ["Real filings", "Live market data", "Deterministic scoring", "Any ticker", "Free"];

const DATA_SOURCES = ["Financial Modeling Prep", "Finnhub", "SEC EDGAR", "FRED", "Alpaca"];

const FACTS = [
  { value: "5", label: "live data sources" },
  { value: "Free", label: "no card required" },
  { value: "Real", label: "SEC filings cited" },
  { value: "0", label: "fabricated numbers" },
];

/** Pointer-reactive Liquid Glass — moves the highlight in .otto-glass via
 * CSS custom properties instead of a static gradient position. */
function useGlassPointer() {
  const ref = useRef<HTMLDivElement>(null);
  return {
    ref,
    onMouseMove: (e: React.MouseEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${((e.clientX - rect.left) / rect.width) * 100}%`);
      el.style.setProperty("--my", `${((e.clientY - rect.top) / rect.height) * 100}%`);
    },
  };
}

/**
 * The landing moment — what a visitor sees before their first message.
 * Structured like a real marketing landing page (nav implied by ChatApp's
 * header, hero split, trust strip, stats) rather than a single centered
 * headline. Every claim here is real: the mockup card uses illustrative
 * example numbers (clearly a UI demo, not a live fetch), and the trust
 * strip/stats name actual data sources and mechanisms — never invented
 * user counts or fake testimonials.
 */
export function LandingHero({ onStart, onExample }: { onStart: () => void; onExample: (text: string) => void }) {
  const mockGlass = useGlassPointer();
  const navGlass = useGlassPointer();

  return (
    <div className="relative flex h-full flex-col items-center overflow-y-auto px-4 pb-32 pt-24 sm:px-6">
      <div className="otto-grid-field" />
      <div className="otto-ambient-field" />

      <div className="relative z-10 grid w-full max-w-5xl grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-8">
        {/* Left: headline, subhead, capabilities, CTAs */}
        <div className="otto-liquid-in flex flex-col items-start text-left">
          <span className="otto-text-label mb-4 block tracking-[0.3em] text-otto-gold">Otto AI</span>
          <h1 className="otto-text-display text-4xl leading-[1.05] text-otto-text sm:text-5xl">
            Everyone has an opinion.
            <br />
            <span className="otto-shine-text">Otto has a verdict.</span>
          </h1>
          <p className="otto-text-body mt-5 max-w-md text-otto-text-muted">
            Ask about any ticker. Otto pulls real filings and market data, runs a deterministic score, and gives
            you a number — not a vibe.
          </p>

          <div className="mt-6 flex flex-wrap gap-2">
            {CAPABILITIES.map((c) => (
              <span
                key={c}
                className="otto-material otto-elevation-resting otto-text-caption rounded-full border px-3 py-1 text-otto-text-muted"
              >
                {c}
              </span>
            ))}
          </div>

          <div className="mt-8 flex items-center gap-3">
            <button
              onClick={onStart}
              className="otto-text-caption otto-elevation-raised otto-lift rounded-full bg-otto-gold px-5 py-2.5 font-medium text-otto-bg transition-opacity hover:opacity-90"
            >
              Start for free
            </button>
            <button
              onClick={() => onExample("Is UBER undervalued?")}
              className="otto-text-caption rounded-full border border-otto-border px-5 py-2.5 text-otto-text-muted transition-colors hover:border-otto-text-faint hover:text-otto-text"
            >
              See an example
            </button>
          </div>
        </div>

        {/* Right: illustrative product mockup in a Liquid Glass window */}
        <div
          ref={mockGlass.ref}
          onMouseMove={mockGlass.onMouseMove}
          className="otto-liquid-in otto-glass otto-material-thick otto-elevation-floating overflow-hidden rounded-2xl border"
          style={{ animationDelay: "120ms" }}
        >
          <div className="relative z-10 flex items-center gap-2 border-b border-otto-border-soft px-4 py-3">
            <span className="h-2.5 w-2.5 rounded-full bg-otto-bear" />
            <span className="h-2.5 w-2.5 rounded-full bg-otto-gold" />
            <span className="h-2.5 w-2.5 rounded-full bg-otto-bull" />
            <span className="otto-text-caption ml-2 text-otto-text-faint">Otto AI · Example</span>
          </div>
          <div className="relative z-10 flex flex-col gap-4 p-5">
            <div className="flex justify-end">
              <div className="max-w-[70%] rounded-2xl rounded-br-sm bg-white/[0.06] px-4 py-2.5 text-sm text-otto-text">
                Is UBER undervalued?
              </div>
            </div>
            <div className="otto-material rounded-2xl border p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="otto-text-title text-otto-text">UBER</span>
                    <span className="rounded-full bg-otto-bull-soft px-2 py-0.5 text-[10px] font-medium text-otto-bull">
                      Buy
                    </span>
                  </div>
                  <p className="otto-text-caption mt-0.5 text-otto-text-muted">Uber Technologies, Inc.</p>
                </div>
                <span className="otto-text-title text-otto-gold">83</span>
              </div>
              <p className="otto-text-caption mt-3 text-otto-text-muted">
                Strong free-cash-flow yield and high-quality balance sheet make it a compelling buy despite modest
                upside.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Trust strip — real data sources, never a fabricated testimonial */}
      <div className="otto-liquid-in relative z-10 mt-16 flex flex-col items-center gap-3" style={{ animationDelay: "200ms" }}>
        <p className="otto-text-caption text-otto-text-faint">Real data, every time — pulled live from</p>
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {DATA_SOURCES.map((s) => (
            <span key={s} className="otto-text-caption text-otto-text-muted">
              {s}
            </span>
          ))}
        </div>
      </div>

      {/* Stats — mechanism facts, not invented usage numbers */}
      <div
        className="otto-liquid-in relative z-10 mt-12 grid w-full max-w-3xl grid-cols-2 gap-6 sm:grid-cols-4"
        style={{ animationDelay: "260ms" }}
      >
        {FACTS.map((f) => (
          <div key={f.label} className="flex flex-col items-center text-center">
            <span className="otto-text-title text-otto-text">{f.value}</span>
            <span className="otto-text-caption mt-1 text-otto-text-faint">{f.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
