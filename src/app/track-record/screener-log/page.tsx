import Link from "next/link";
import {
  getScreenerCallsWithLiveMarks,
  getPortfolioSummary,
  getFlagshipSummary,
  getFactorContributions,
  getKilledFactors,
} from "@/lib/otto/screener-track-record";

const NUDGE_TYPE_LABELS: Record<string, string> = {
  cluster: "Insider cluster (market-wide)",
  insider: "Insider activity (90d)",
  officerBuying: "Officer buying (own money)",
  ratingTrend: "Analyst rating trend",
  sectorValuation: "Sector valuation percentile",
  forecastUpside: "Forecast upside",
  earnings: "Earnings track record",
  shortInterest: "Short interest risk",
};

export const metadata = { title: "Screener Track Record (private) — Otto AI" };
export const dynamic = "force-dynamic";

/**
 * Private, human-readable view of the permanent screener track record
 * (Phase 1b) — the raw JSON API (/api/track-record/screener-log) still
 * exists for programmatic access, but this is the actual "where do I check"
 * answer: a real page instead of asking someone to read JSON. Gated the
 * same way (METRICS_SECRET), deliberately not linked from anywhere public.
 */
function fmtPct(n: number | undefined | null) {
  if (n === undefined || n === null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function fmtPrice(n: number | undefined | null) {
  return n === undefined || n === null ? "—" : `$${n.toFixed(2)}`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDollars(n: number) {
  return `$${n.toLocaleString("en-US")}`;
}

/** "Still climbing" means the alpha high was set very recently (the daily
 * cron just caught it) AND live alpha hasn't since pulled back off that
 * peak — a genuinely live, still-holding high, not a stale one from weeks
 * ago that just happens to still be the record. */
function isRecentAlphaHigh(c: { peakAlphaPct: number; peakAlphaAt: string; live: { alphaPct: number } | null }): boolean {
  const daysSincePeak = (Date.now() - new Date(c.peakAlphaAt).getTime()) / (24 * 60 * 60 * 1000);
  const stillAtPeak = c.live !== null && c.live.alphaPct >= c.peakAlphaPct - 0.5;
  return daysSincePeak <= 2 && c.peakAlphaPct > 0 && stillAtPeak;
}

export default async function ScreenerTrackRecordPage({
  searchParams,
}: {
  searchParams: Promise<{ secret?: string }>;
}) {
  const { secret: provided } = await searchParams;
  const secret = process.env.METRICS_SECRET;
  if (secret && provided !== secret) {
    return (
      <div className="mx-auto max-w-md px-6 py-24 text-center text-otto-text">
        <p className="otto-text-body text-otto-text-muted">Not authorized.</p>
      </div>
    );
  }

  const [calls, portfolio, flagship, factorContributions, killedFactors] = await Promise.all([
    getScreenerCallsWithLiveMarks(),
    getPortfolioSummary(),
    getFlagshipSummary(),
    getFactorContributions(),
    getKilledFactors(),
  ]);
  calls.sort((a, b) => new Date(b.calledAt).getTime() - new Date(a.calledAt).getTime());
  const flagshipAlpha = flagship.avgLiveAlphaPct ?? flagship.avgD30AlphaPct ?? flagship.avgD90AlphaPct ?? flagship.avgD180AlphaPct;

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-6 py-12 text-otto-text">
      <Link href="/" className="otto-text-caption text-otto-gold hover:opacity-80">
        ← Back to Otto
      </Link>
      <h1 className="otto-text-display mt-6">Screener Track Record</h1>
      <p className="otto-text-caption mt-2 text-otto-text-faint">
        Private — every real screener pick Otto has made, unedited. {calls.length} logged.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="rounded-xl border border-otto-border-soft bg-white/[0.02] p-3">
          <div className="otto-text-caption text-[10px] uppercase tracking-wide text-otto-text-faint">Portfolio value</div>
          <div className="tabular-nums text-lg font-semibold text-otto-text">{fmtDollars(portfolio.totalValue)}</div>
        </div>
        <div className="rounded-xl border border-otto-border-soft bg-white/[0.02] p-3">
          <div className="otto-text-caption text-[10px] uppercase tracking-wide text-otto-text-faint">Total return</div>
          <div className={`tabular-nums text-lg font-semibold ${portfolio.totalReturnPct >= 0 ? "text-otto-bull" : "text-otto-bear"}`}>
            {fmtPct(portfolio.totalReturnPct)}
          </div>
        </div>
        <div className="rounded-xl border border-otto-border-soft bg-white/[0.02] p-3">
          <div className="otto-text-caption text-[10px] uppercase tracking-wide text-otto-text-faint">Cash available</div>
          <div className="tabular-nums text-lg font-semibold text-otto-text">{fmtDollars(portfolio.cashAvailable)}</div>
        </div>
        <div className="rounded-xl border border-otto-border-soft bg-white/[0.02] p-3">
          <div className="otto-text-caption text-[10px] uppercase tracking-wide text-otto-text-faint">Open positions</div>
          <div className="tabular-nums text-lg font-semibold text-otto-text">
            {portfolio.openPositionCount} · {fmtDollars(portfolio.openPositionsValue)}
          </div>
        </div>
        <div className="rounded-xl border border-otto-border-soft bg-white/[0.02] p-3">
          <div className="otto-text-caption text-[10px] uppercase tracking-wide text-otto-text-faint">Started</div>
          <div className="text-lg font-semibold text-otto-text">{fmtDate(portfolio.startedAt)}</div>
        </div>
      </div>
      <p className="otto-text-caption mt-2 text-otto-text-faint">
        A real ${portfolio.startingCash.toLocaleString("en-US")} simulated stake, sized by conviction (4-12% per pick) and
        allocated in the order picks were made — not a promise about real trading, a real accounting of what this specific
        rule set would be worth today.
      </p>

      <div className="mt-4 flex items-center gap-4 rounded-xl border border-otto-gold/30 bg-otto-gold/[0.04] p-3">
        <span className="otto-text-caption shrink-0 text-[10px] font-semibold uppercase tracking-wide text-otto-gold">
          ★ Flagship
        </span>
        <span className="text-sm text-otto-text-muted">
          {flagship.count} calls — Otto&apos;s single #1-ranked pick per scan, not diluted by picks 2-5.
          {flagshipAlpha !== null && (
            <>
              {" "}
              Avg alpha:{" "}
              <span className={`font-medium ${flagshipAlpha >= 0 ? "text-otto-bull" : "text-otto-bear"}`}>
                {fmtPct(flagshipAlpha)}
              </span>
            </>
          )}
        </span>
      </div>

      <div className="mt-6">
        <h2 className="otto-text-label text-otto-text-faint">Factor performance — fail-fast kill switch</h2>
        <p className="otto-text-caption mt-1 text-otto-text-faint">
          Real avg alpha of picks where each signal actually fired. A factor needs 15+ real samples AND a genuine 90-day-old
          sample before it's eligible to be killed — with a brand-new record, most rows below will show &ldquo;not enough
          data yet,&rdquo; honestly, not a fake result.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {factorContributions.map((f) => {
            const isKilled = killedFactors.has(f.type);
            return (
              <div
                key={f.type}
                className={`rounded-xl border p-3 ${isKilled ? "border-otto-bear/40 bg-otto-bear-soft" : "border-otto-border-soft bg-white/[0.02]"}`}
              >
                <div className="otto-text-caption text-[10px] uppercase tracking-wide text-otto-text-faint">
                  {NUDGE_TYPE_LABELS[f.type] ?? f.type}
                </div>
                {isKilled ? (
                  <div className="text-sm font-semibold text-otto-bear">✕ Disabled</div>
                ) : f.sampleSize === 0 ? (
                  <div className="text-sm text-otto-text-faint">Not enough data yet</div>
                ) : (
                  <div className={`tabular-nums text-sm font-semibold ${(f.avgAlphaPct ?? 0) >= 0 ? "text-otto-bull" : "text-otto-bear"}`}>
                    {fmtPct(f.avgAlphaPct)} <span className="text-otto-text-faint">(n={f.sampleSize})</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {calls.length === 0 ? (
        <p className="otto-text-body mt-8 text-otto-text-muted">
          No calls logged yet — every fresh screener scan gets recorded here automatically.
        </p>
      ) : (
        <div className="mt-8 overflow-x-auto rounded-2xl border border-otto-border">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-otto-border text-otto-text-faint">
                <th className="px-4 py-3 font-medium">Symbol</th>
                <th className="px-4 py-3 font-medium">Intent</th>
                <th className="px-4 py-3 font-medium">Called</th>
                <th className="px-4 py-3 font-medium">Price found</th>
                <th className="px-4 py-3 font-medium">Allocated</th>
                <th className="px-4 py-3 font-medium">Peak since</th>
                <th className="px-4 py-3 font-medium">Peak alpha</th>
                <th className="px-4 py-3 font-medium">Current</th>
                <th className="px-4 py-3 font-medium">Alpha vs SPY (live)</th>
                <th className="px-4 py-3 font-medium">30d</th>
                <th className="px-4 py-3 font-medium">90d</th>
                <th className="px-4 py-3 font-medium">180d</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} className={`border-b border-otto-border/50 last:border-0 ${c.isFlagship ? "bg-otto-gold/[0.03]" : ""}`}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 font-medium">
                      {c.isFlagship && <span className="text-otto-gold" title="Flagship — #1 pick of its scan">★</span>}
                      {c.symbol}
                    </div>
                    <div className="otto-text-caption text-otto-text-faint">{c.companyName}</div>
                  </td>
                  <td className="px-4 py-3 capitalize text-otto-text-muted">{c.intent}</td>
                  <td className="px-4 py-3 text-otto-text-muted">{fmtDate(c.calledAt)}</td>
                  <td className="px-4 py-3">{fmtPrice(c.priceAtCall)}</td>
                  <td className="px-4 py-3">
                    {fmtDollars(c.allocatedAmount)}
                    {c.closed && <span className="otto-text-caption ml-1 text-otto-text-faint">(closed)</span>}
                  </td>
                  <td className="px-4 py-3">
                    {fmtPrice(c.peakPrice)}
                    <span className="otto-text-caption ml-1 text-otto-text-faint">({fmtDate(c.peakAt)})</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={c.peakAlphaPct >= 0 ? "text-otto-bull" : "text-otto-bear"}>{fmtPct(c.peakAlphaPct)}</span>
                    {isRecentAlphaHigh(c) && (
                      <span
                        className="ml-1.5 inline-block rounded-full border border-otto-gold/50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-otto-gold"
                        title={`New alpha high set ${fmtDate(c.peakAlphaAt)} and still holding`}
                      >
                        🔥 climbing
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">{fmtPrice(c.live?.price)}</td>
                  <td className={`px-4 py-3 ${c.live && c.live.alphaPct >= 0 ? "text-otto-bull" : "text-otto-bear"}`}>
                    {fmtPct(c.live?.alphaPct)}
                  </td>
                  <td className="px-4 py-3">{fmtPct(c.evaluations.d30?.alphaPct)}</td>
                  <td className="px-4 py-3">{fmtPct(c.evaluations.d90?.alphaPct)}</td>
                  <td className="px-4 py-3">{fmtPct(c.evaluations.d180?.alphaPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
