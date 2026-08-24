import Link from "next/link";
import { getScreenerCallsWithLiveMarks } from "@/lib/otto/screener-track-record";

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

  const calls = await getScreenerCallsWithLiveMarks();
  calls.sort((a, b) => new Date(b.calledAt).getTime() - new Date(a.calledAt).getTime());

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-6 py-12 text-otto-text">
      <Link href="/" className="otto-text-caption text-otto-gold hover:opacity-80">
        ← Back to Otto
      </Link>
      <h1 className="otto-text-display mt-6">Screener Track Record</h1>
      <p className="otto-text-caption mt-2 text-otto-text-faint">
        Private — every real screener pick Otto has made, unedited. {calls.length} logged.
      </p>

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
                <th className="px-4 py-3 font-medium">Peak since</th>
                <th className="px-4 py-3 font-medium">Current</th>
                <th className="px-4 py-3 font-medium">Alpha vs SPY (live)</th>
                <th className="px-4 py-3 font-medium">30d</th>
                <th className="px-4 py-3 font-medium">90d</th>
                <th className="px-4 py-3 font-medium">180d</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} className="border-b border-otto-border/50 last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{c.symbol}</div>
                    <div className="otto-text-caption text-otto-text-faint">{c.companyName}</div>
                  </td>
                  <td className="px-4 py-3 capitalize text-otto-text-muted">{c.intent}</td>
                  <td className="px-4 py-3 text-otto-text-muted">{fmtDate(c.calledAt)}</td>
                  <td className="px-4 py-3">{fmtPrice(c.priceAtCall)}</td>
                  <td className="px-4 py-3">
                    {fmtPrice(c.peakPrice)}
                    <span className="otto-text-caption ml-1 text-otto-text-faint">({fmtDate(c.peakAt)})</span>
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
