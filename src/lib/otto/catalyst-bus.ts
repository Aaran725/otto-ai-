import { redis } from "./cache";
import { invalidateTodaysAnalysis } from "./groq";

/**
 * The one place "a real catalyst happened for this symbol" turns into
 * action — every detector (the market-wide insider-cluster feed today,
 * the 8-K item-code tripwire in catalyst-filings.ts, anything added
 * later) publishes here instead of rolling its own invalidation logic.
 * Adding a new catalyst source only ever means writing the detector;
 * what happens next (invalidate today's cache, keep a real recent-events
 * log per symbol) is shared, written once.
 */
export type CatalystType = "insider_cluster" | "material_filing";

export interface CatalystEvent {
  symbol: string;
  type: CatalystType;
  detail: string; // short, human-readable — e.g. "Net insider buying" or "Item 1.01: material agreement filed"
  detectedAt: string; // ISO
  sourceUrl?: string; // links straight to the real filing/source when one exists
}

const NAMESPACE = "otto:catalysts";
const RECENT_PER_SYMBOL = 5;
const RECENT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // Redis key TTL — resets on every new event for that symbol
const MAX_EVENT_AGE_MS = 14 * 24 * 60 * 60 * 1000; // real per-event staleness — checked by detectedAt, not list position

const recentKey = (symbol: string) => `${NAMESPACE}:${symbol.toUpperCase()}`;

// The key's own TTL resets every time a NEW event is appended for that
// symbol — without this, a months-old event could keep riding along
// indefinitely just because a fresh, unrelated event for the same symbol
// kept resetting the whole list's clock. Filtering by each event's own
// detectedAt makes staleness self-correcting regardless of TTL resets or
// how long something's sat in the top-5 by insertion order.
export function dropStale(events: CatalystEvent[]): CatalystEvent[] {
  const cutoff = Date.now() - MAX_EVENT_AGE_MS;
  return events.filter((e) => new Date(e.detectedAt).getTime() >= cutoff);
}

/**
 * One symbol's invalidation-plus-logging failing must never sink the rest
 * of the batch — same "fail soft per item" discipline as everything else
 * that sweeps a list of symbols in this codebase.
 */
export async function publishCatalystEvents(events: CatalystEvent[]): Promise<void> {
  await Promise.all(
    events.map(async (event) => {
      try {
        await Promise.all([invalidateTodaysAnalysis(event.symbol), appendRecentCatalyst(event)]);
      } catch {
        // best-effort — see the module comment
      }
    })
  );
}

async function appendRecentCatalyst(event: CatalystEvent): Promise<void> {
  const key = recentKey(event.symbol);
  const existing = (await redis.get<CatalystEvent[]>(key)) ?? [];
  // Same detector re-firing for the same real-world event (a retried cron
  // run, or a symbol that stays flagged across several runs before its
  // underlying condition changes) shouldn't pile up as separate rows —
  // dedupe on (type, detail, calendar day) rather than exact timestamp.
  const sameDay = (a: string, b: string) => a.slice(0, 10) === b.slice(0, 10);
  const isDuplicate = existing.some(
    (e) => e.type === event.type && e.detail === event.detail && sameDay(e.detectedAt, event.detectedAt)
  );
  const updated = dropStale(isDuplicate ? existing : [event, ...existing]).slice(0, RECENT_PER_SYMBOL);
  await redis.set(key, updated, { px: RECENT_TTL_MS });
}

/** Read-side for any subscriber — a UI badge, a future alert, a future
 * feature nobody's built yet — without needing to know which detector
 * fired. Never throws; a lookup failure just means "nothing to show."
 * Filters by real event age too (not just relying on write-time
 * filtering), so anything already stale in Redis self-heals on read. */
export async function getRecentCatalysts(symbol: string): Promise<CatalystEvent[]> {
  try {
    const events = (await redis.get<CatalystEvent[]>(recentKey(symbol))) ?? [];
    return dropStale(events);
  } catch {
    return [];
  }
}
