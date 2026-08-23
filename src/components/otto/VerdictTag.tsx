import { clsx } from "clsx";
import type { Verdict } from "@/lib/otto/schema";

const STYLES: Record<Verdict, string> = {
  "Strong Buy": "bg-otto-gold-soft text-otto-gold border-otto-gold/40",
  Buy: "bg-otto-bull-soft text-otto-bull border-otto-bull/40",
  Hold: "bg-white/5 text-otto-text-muted border-otto-border",
  Avoid: "bg-otto-bear-soft text-otto-bear border-otto-bear/40",
  "Strong Avoid": "bg-otto-bear-soft text-otto-bear border-otto-bear/50",
};

export function VerdictTag({ verdict }: { verdict: Verdict }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium tracking-wide uppercase",
        STYLES[verdict]
      )}
    >
      {verdict}
    </span>
  );
}
