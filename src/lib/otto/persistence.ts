"use client";

/**
 * Watchlist + call-log persistence. Signed-out visitors get the original
 * browser-local behavior (localStorage) — signed-in users get the same data
 * synced to Supabase, scoped to their account via Row Level Security (see
 * supabase/schema.sql). Every function checks auth state per call rather
 * than requiring a userId param, so call sites don't need to know or care
 * which backend is actually in use.
 */

import { createClient } from "../supabase/client";

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
const MAX_LOGGED_CALLS = 200; // bounds storage size — oldest entries drop off

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

/** getSession() reads from local storage first — unlike getUser(), it
 * doesn't round-trip to the auth server on every call, so this stays cheap
 * even though every persistence function calls it. */
async function getUserId(): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

/** The most recent logged call for a symbol, if any — used to detect "what
 * changed since you last looked" without any new storage: every fresh
 * search already logs here unconditionally (see logCall below), so the
 * memory this reads already exists, it just wasn't being surfaced. Callers
 * must look this up BEFORE calling logCall for the current search, or
 * "prior" will just be today's own entry. */
export async function getPriorCall(symbol: string): Promise<LoggedCall | null> {
  const log = await getCallLog();
  return log.find((c) => c.symbol === symbol.toUpperCase()) ?? null;
}

export async function getCallLog(): Promise<LoggedCall[]> {
  const userId = await getUserId();
  if (!userId) return readJson<LoggedCall[]>(CALL_LOG_KEY, []);

  const supabase = createClient();
  const { data, error } = await supabase
    .from("call_log")
    .select("id, symbol, company_name, called_at, called_price, conviction_score, verdict")
    .order("called_at", { ascending: false })
    .limit(MAX_LOGGED_CALLS);
  if (error || !data) return [];

  return data.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    companyName: r.company_name,
    calledAt: r.called_at,
    calledPrice: Number(r.called_price),
    convictionScore: Number(r.conviction_score),
    verdict: r.verdict,
  }));
}

/** Called automatically for every fresh analysis, regardless of whether the
 * user saves it to a watchlist — the whole point is an unfiltered record. */
export async function logCall(call: Omit<LoggedCall, "id">) {
  const userId = await getUserId();
  const dayKey = call.calledAt.slice(0, 10);

  if (!userId) {
    const log = readJson<LoggedCall[]>(CALL_LOG_KEY, []);
    const entry: LoggedCall = { ...call, id: `${call.symbol}-${call.calledAt}` };
    // Replace same-day duplicate calls for the same symbol rather than
    // piling up near-identical entries every time a ticker is re-viewed.
    const deduped = log.filter((c) => !(c.symbol === entry.symbol && c.calledAt.slice(0, 10) === dayKey));
    writeJson(CALL_LOG_KEY, [entry, ...deduped].slice(0, MAX_LOGGED_CALLS));
    return;
  }

  const supabase = createClient();
  // Same same-day dedupe rule, enforced against the DB instead of an
  // in-memory array.
  await supabase
    .from("call_log")
    .delete()
    .eq("user_id", userId)
    .eq("symbol", call.symbol)
    .gte("called_at", `${dayKey}T00:00:00.000Z`)
    .lt("called_at", `${dayKey}T23:59:59.999Z`);

  await supabase.from("call_log").insert({
    user_id: userId,
    symbol: call.symbol,
    company_name: call.companyName,
    called_at: call.calledAt,
    called_price: call.calledPrice,
    conviction_score: call.convictionScore,
    verdict: call.verdict,
  });
}

export async function getWatchlist(): Promise<WatchlistEntry[]> {
  const userId = await getUserId();
  if (!userId) return readJson<WatchlistEntry[]>(WATCHLIST_KEY, []);

  const supabase = createClient();
  const { data, error } = await supabase
    .from("watchlist")
    .select("symbol, company_name, added_at, added_price, added_conviction_score, added_verdict")
    .order("added_at", { ascending: false });
  if (error || !data) return [];

  return data.map((r) => ({
    symbol: r.symbol,
    companyName: r.company_name,
    addedAt: r.added_at,
    addedPrice: Number(r.added_price),
    addedConvictionScore: Number(r.added_conviction_score),
    addedVerdict: r.added_verdict,
  }));
}

export async function isWatched(symbol: string): Promise<boolean> {
  const list = await getWatchlist();
  return list.some((w) => w.symbol === symbol.toUpperCase());
}

export async function addToWatchlist(entry: WatchlistEntry) {
  const userId = await getUserId();
  const symbol = entry.symbol.toUpperCase();

  if (!userId) {
    const list = readJson<WatchlistEntry[]>(WATCHLIST_KEY, []).filter((w) => w.symbol !== symbol);
    writeJson(WATCHLIST_KEY, [{ ...entry, symbol }, ...list]);
    return;
  }

  const supabase = createClient();
  await supabase.from("watchlist").upsert({
    user_id: userId,
    symbol,
    company_name: entry.companyName,
    added_at: entry.addedAt,
    added_price: entry.addedPrice,
    added_conviction_score: entry.addedConvictionScore,
    added_verdict: entry.addedVerdict,
  });
}

export async function removeFromWatchlist(symbol: string) {
  const userId = await getUserId();
  const upper = symbol.toUpperCase();

  if (!userId) {
    writeJson(
      WATCHLIST_KEY,
      readJson<WatchlistEntry[]>(WATCHLIST_KEY, []).filter((w) => w.symbol !== upper)
    );
    return;
  }

  const supabase = createClient();
  await supabase.from("watchlist").delete().eq("user_id", userId).eq("symbol", upper);
}
