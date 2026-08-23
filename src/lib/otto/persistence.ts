"use client";

/**
 * Client-side persistence (localStorage) — there's no user-account/backend
 * system in this app, so a browser-local store is the right scope for a
 * single-user "book" rather than standing up auth + a database for it.
 * Two separate stores: an append-only CALL LOG (every fresh analysis Otto
 * runs, whether or not the user "saved" it — this is what makes the track
 * record honest, not cherry-picked) and a user-curated WATCHLIST.
 */

export interface LoggedCall {
  id: string;
  symbol: string;
  companyName: string;
  calledAt: string; // ISO timestamp
  calledPrice: number;
  convictionScore: number;
  verdict: string;
}

export interface WatchlistEntry {
  symbol: string;
  companyName: string;
  addedAt: string;
  addedPrice: number;
  addedConvictionScore: number;
  addedVerdict: string;
}

const CALL_LOG_KEY = "otto:call-log";
const WATCHLIST_KEY = "otto:watchlist";
const MAX_LOGGED_CALLS = 200; // bounds localStorage size — oldest entries drop off

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage full or unavailable (private browsing) — fail silently,
    // this is a nice-to-have feature, not core functionality.
  }
}

export function getCallLog(): LoggedCall[] {
  return readJson<LoggedCall[]>(CALL_LOG_KEY, []);
}

/** Called automatically for every fresh analysis, regardless of whether the
 * user saves it to a watchlist — the whole point is an unfiltered record. */
export function logCall(call: Omit<LoggedCall, "id">) {
  const log = getCallLog();
  const entry: LoggedCall = { ...call, id: `${call.symbol}-${call.calledAt}` };
  // Replace same-day duplicate calls for the same symbol rather than piling
  // up near-identical entries every time a ticker is re-viewed.
  const deduped = log.filter((c) => !(c.symbol === entry.symbol && c.calledAt.slice(0, 10) === entry.calledAt.slice(0, 10)));
  writeJson(CALL_LOG_KEY, [entry, ...deduped].slice(0, MAX_LOGGED_CALLS));
}

export function getWatchlist(): WatchlistEntry[] {
  return readJson<WatchlistEntry[]>(WATCHLIST_KEY, []);
}

export function isWatched(symbol: string): boolean {
  return getWatchlist().some((w) => w.symbol === symbol.toUpperCase());
}

export function addToWatchlist(entry: WatchlistEntry) {
  const list = getWatchlist().filter((w) => w.symbol !== entry.symbol.toUpperCase());
  writeJson(WATCHLIST_KEY, [{ ...entry, symbol: entry.symbol.toUpperCase() }, ...list]);
}

export function removeFromWatchlist(symbol: string) {
  writeJson(
    WATCHLIST_KEY,
    getWatchlist().filter((w) => w.symbol !== symbol.toUpperCase())
  );
}
