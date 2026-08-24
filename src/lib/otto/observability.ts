/**
 * Basic, zero-dependency error-rate signal — no monitoring service wired
 * up, so this is a structured log line (grep-able, and picked up by
 * Vercel's own log drain / any future log aggregator without extra setup)
 * plus an in-memory rolling counter exposed at /api/metrics.
 *
 * Known limitation, called out explicitly: this counter is per-process,
 * not shared across serverless instances — the same root issue Phase 3
 * item 1 (shared cache) addresses for data itself. Once that lands, this
 * counter should move to the same store so the numbers are real
 * fleet-wide rates, not just "whatever this one cold start happened to
 * see." Until then, treat this as a fast, cheap smoke signal, not a
 * precise dashboard.
 */

export type MetricEvent =
  | "data_quality_insufficient" // an OttoAnalysis rendered with essentially no real fundamentals data
  | "score_divergence" // screen score vs conviction score disagreed by >25 points
  | "finnhub_exhausted" // every Finnhub key failed for one request
  | "fmp_bundle_partial" // a single-stock bundle came back missing history/income/ratios
  | "screener_zero_results"; // a screen returned nothing after all filters

interface MetricRecord {
  count: number;
  lastSeenAt: string | null;
  recentSamples: { at: string; meta?: Record<string, unknown> }[];
}

const MAX_SAMPLES_PER_EVENT = 20;

const globalForMetrics = globalThis as unknown as {
  __ottoObservabilityMetrics?: Record<MetricEvent, MetricRecord>;
  __ottoObservabilityProcessStart?: string;
};

function store(): Record<MetricEvent, MetricRecord> {
  if (!globalForMetrics.__ottoObservabilityMetrics) {
    globalForMetrics.__ottoObservabilityMetrics = {
      data_quality_insufficient: { count: 0, lastSeenAt: null, recentSamples: [] },
      score_divergence: { count: 0, lastSeenAt: null, recentSamples: [] },
      finnhub_exhausted: { count: 0, lastSeenAt: null, recentSamples: [] },
      fmp_bundle_partial: { count: 0, lastSeenAt: null, recentSamples: [] },
      screener_zero_results: { count: 0, lastSeenAt: null, recentSamples: [] },
    };
    globalForMetrics.__ottoObservabilityProcessStart = new Date().toISOString();
  }
  return globalForMetrics.__ottoObservabilityMetrics;
}

export function recordEvent(event: MetricEvent, meta?: Record<string, unknown>) {
  const now = new Date().toISOString();
  const records = store();
  const record = records[event];
  record.count += 1;
  record.lastSeenAt = now;
  record.recentSamples.push({ at: now, meta });
  if (record.recentSamples.length > MAX_SAMPLES_PER_EVENT) record.recentSamples.shift();

  // Structured, single-line, grep-able — "[metric] event=X meta={...}"
  // rather than a free-text message, so a log drain can parse it without
  // needing app-specific tooling.
  console.warn(`[metric] event=${event}${meta ? " meta=" + JSON.stringify(meta) : ""}`);
}

export function getMetricsSnapshot() {
  return {
    processStartedAt: globalForMetrics.__ottoObservabilityProcessStart ?? null,
    events: store(),
    note:
      "Per-process counters only (resets on cold start, not shared across instances) — a coarse smoke signal until Phase 3 item 1 (shared cache) lands and this can move to the same store.",
  };
}
