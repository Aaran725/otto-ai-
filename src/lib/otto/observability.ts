import { redis } from "./cache";

/**
 * Error-rate signal — a structured log line (grep-able, picked up by
 * Vercel's own log drain / any future log aggregator without extra setup)
 * plus real counters, persisted in the same shared Redis instance the
 * caches use, exposed at /api/metrics.
 *
 * Previously these counters lived in a per-process `globalThis` object —
 * accurate for exactly one cold start, then gone, and never combined across
 * serverless instances. That's the same root problem the shared cache
 * (cache.ts) fixed for data; this fixes it for the numbers *about* that
 * data, so "how often is Finnhub exhausted this week" is a real fleet-wide
 * answer instead of "whatever this one instance happened to see."
 */

export type MetricEvent =
  | "data_quality_insufficient" // an OttoAnalysis rendered with essentially no real fundamentals data
  | "score_divergence" // screen score vs conviction score disagreed by >25 points
  | "finnhub_exhausted" // every Finnhub key failed for one request
  | "fmp_bundle_partial" // a single-stock bundle came back missing history/income/ratios
  | "screener_zero_results"; // a screen returned nothing after all filters

const ALL_EVENTS: MetricEvent[] = [
  "data_quality_insufficient",
  "score_divergence",
  "finnhub_exhausted",
  "fmp_bundle_partial",
  "screener_zero_results",
];

interface MetricSample {
  at: string;
  meta?: Record<string, unknown>;
}

interface MetricRecord {
  count: number;
  lastSeenAt: string | null;
  recentSamples: MetricSample[];
}

const MAX_SAMPLES_PER_EVENT = 20;
const NAMESPACE = "otto:metrics";
const FIRST_EVENT_KEY = `${NAMESPACE}:firstEventAt`;

const countKey = (event: MetricEvent) => `${NAMESPACE}:${event}:count`;
const lastSeenKey = (event: MetricEvent) => `${NAMESPACE}:${event}:lastSeenAt`;
const samplesKey = (event: MetricEvent) => `${NAMESPACE}:${event}:samples`;

/**
 * Fire-and-forget from every call site (none of them await this, same as
 * the old console.warn-only version) — so a metrics-store hiccup must never
 * surface as a failure in the real request that triggered the event.
 */
export async function recordEvent(event: MetricEvent, meta?: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  // Structured, single-line, grep-able — "[metric] event=X meta={...}"
  // rather than a free-text message, so a log drain can parse it without
  // needing app-specific tooling. Kept even with Redis persistence: log
  // drains and the /api/metrics snapshot answer different questions ("what
  // just happened" vs "what's the rate over time").
  console.warn(`[metric] event=${event}${meta ? " meta=" + JSON.stringify(meta) : ""}`);
  try {
    const sample: MetricSample = { at: now, meta };
    await Promise.all([
      redis.incr(countKey(event)),
      redis.set(lastSeenKey(event), now),
      redis.lpush(samplesKey(event), sample),
      redis.ltrim(samplesKey(event), 0, MAX_SAMPLES_PER_EVENT - 1),
      redis.set(FIRST_EVENT_KEY, now, { nx: true }),
    ]);
  } catch {
    // Best-effort — losing a metrics write is a visibility gap, not a
    // correctness one.
  }
}

export async function getMetricsSnapshot() {
  try {
    const entries = await Promise.all(
      ALL_EVENTS.map(async (event): Promise<[MetricEvent, MetricRecord]> => {
        const [count, lastSeenAt, samples] = await Promise.all([
          redis.get<number>(countKey(event)),
          redis.get<string>(lastSeenKey(event)),
          redis.lrange<MetricSample>(samplesKey(event), 0, MAX_SAMPLES_PER_EVENT - 1),
        ]);
        return [event, { count: count ?? 0, lastSeenAt: lastSeenAt ?? null, recentSamples: samples ?? [] }];
      })
    );
    const firstEventAt = await redis.get<string>(FIRST_EVENT_KEY);
    return {
      firstEventAt,
      events: Object.fromEntries(entries) as Record<MetricEvent, MetricRecord>,
      note: "Persisted in Redis, shared across every serverless instance — real fleet-wide counts, not per-process.",
    };
  } catch {
    return {
      firstEventAt: null,
      events: null,
      note: "Metrics store temporarily unavailable — this reflects a Redis outage, not zero events.",
    };
  }
}
