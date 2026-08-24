import { clsx } from "clsx";
import type { DataQuality, Verdict } from "@/lib/otto/schema";

const STYLES: Record<Verdict, string> = {
  "Strong Buy": "bg-otto-gold-soft text-otto-gold border-otto-gold/40",
  Buy: "bg-otto-bull-soft text-otto-bull border-otto-bull/40",
  Hold: "bg-white/5 text-otto-text-muted border-otto-border",
  Avoid: "bg-otto-bear-soft text-otto-bear border-otto-bear/40",
  "Strong Avoid": "bg-otto-bear-soft text-otto-bear border-otto-bear/50",
};

export function VerdictTag({ verdict, dataQuality }: { verdict: Verdict; dataQuality?: DataQuality }) {
  // A verdict computed from data that mostly wasn't there must never look
  // like a real rating — this overrides the styled Buy/Hold/Avoid badge
  // regardless of what Groq returned, since dataQuality is deterministic
  // and the verdict text isn't trustworthy to begin with here.
  if (dataQuality === "insufficient") {
    return (
      <span className="inline-flex items-center rounded-full border border-otto-text-faint/40 bg-white/5 px-3 py-1 text-xs font-medium tracking-wide uppercase text-otto-text-faint">
        Insufficient Data
      </span>
    );
  }
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
