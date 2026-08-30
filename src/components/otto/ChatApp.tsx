"use client";

import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import type { ChatMessage, ChatStreamEvent, ProgressUpdate, StageIcon } from "@/lib/otto/chat-types";
import type { ScreenIntent } from "@/lib/otto/screener";
import type { OttoAnalysis } from "@/lib/otto/schema";
import { OttoCardCompact } from "./OttoCardCompact";
import { MiniSparkline } from "./MiniSparkline";
import { SlideOver } from "./SlideOver";
import { ExpandedResearchSheet } from "./ExpandedResearchSheet";
import { FollowUpVisualCard } from "./FollowUpVisualCard";
import { ScreenerResultsCard } from "./ScreenerResultsCard";
import { ComparisonCard } from "./ComparisonCard";
import { WhatChangedBanner } from "./WhatChangedBanner";
import { ProvisionalCard } from "./ProvisionalCard";
import { PresetMenu } from "./PresetMenu";
import { TrackRecordPanel } from "./TrackRecordPanel";
import { PortfolioPanel } from "./PortfolioPanel";
import { AuthModal } from "./AuthModal";
import { LandingHero } from "./LandingHero";
import { useAuth } from "@/lib/supabase/auth-context";
import {
  logCall,
  getCallLog,
  getPriorCall,
  getWatchlist,
  isWatched,
  addToWatchlist,
  removeFromWatchlist,
  type LoggedCall,
  type WatchlistEntry,
} from "@/lib/otto/persistence";
import type { WhatChanged } from "@/lib/otto/chat-types";

// Below this, a re-search doesn't count as a real change worth interrupting
// the user over — normal day-to-day conviction-score noise, not a genuine
// verdict-relevant move.
const MEANINGFUL_SCORE_DELTA = 8;

function uid() {
  return Math.random().toString(36).slice(2);
}

const STAGE_ICON_LETTER: Record<StageIcon, string> = { sec: "S", finnhub: "F", fmp: "$", fred: "M", otto: "O" };

/** Small data-source mark for one loading stage — the same active
 * (pulsing gold) / settled (bull green) coloring the dots always used,
 * now labeled by which real source that stage is hitting. */
function StageBadge({ icon, settled }: { icon?: StageIcon; settled: boolean }) {
  return (
    <span
      className={clsx(
        "otto-text-label flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[8px] leading-none",
        settled ? "bg-otto-bull/15 text-otto-bull" : "animate-pulse bg-otto-gold/20 text-otto-gold"
      )}
    >
      {STAGE_ICON_LETTER[icon ?? "otto"]}
    </span>
  );
}

export function ChatApp() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [statusTrace, setStatusTrace] = useState<ProgressUpdate[]>([]);
  const [provisional, setProvisional] = useState<LoggedCall | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [callLog, setCallLog] = useState<LoggedCall[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [panel, setPanel] = useState<"track-record" | "watchlist" | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { user, loading: authLoading, signOut } = useAuth();

  async function refreshPersisted() {
    const [calls, list] = await Promise.all([getCallLog(), getWatchlist()]);
    setCallLog(calls);
    setWatchlist(list);
  }

  // Re-load whenever auth state resolves or changes — signing in/out swaps
  // which backend (Supabase vs. localStorage) persistence.ts reads from, so
  // the previously-loaded list is for the wrong account otherwise.
  useEffect(() => {
    if (authLoading) return;
    refreshPersisted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  async function toggleWatch(analysis: OttoAnalysis) {
    if (await isWatched(analysis.ticker)) {
      await removeFromWatchlist(analysis.ticker);
    } else {
      await addToWatchlist({
        symbol: analysis.ticker,
        companyName: analysis.companyName,
        addedAt: new Date().toISOString(),
        addedPrice: analysis.price,
        addedConvictionScore: analysis.convictionScore,
        addedVerdict: analysis.verdict,
      });
    }
    await refreshPersisted();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  }

  async function send(text: string, intentHint?: ScreenIntent) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;

    const userMessage: ChatMessage = { id: uid(), role: "user", text: trimmed };
    const nextHistory = [...messages, userMessage];
    setMessages(nextHistory);
    setInput("");
    setPending(true);
    setStatusTrace([]);
    // A word-boundary match against the call log's own symbols — cheap,
    // client-side, no guess at what the server will actually resolve.
    // False negatives (a real ticker just never searched before) just mean
    // no provisional card shows, same as today; a stray word coincidentally
    // matching a past symbol is harmless too, since it only ever renders a
    // clearly-labeled "last checked" placeholder that gets replaced the
    // moment the real response lands, never treated as the real answer.
    const priorMatch = callLog.find((c) => new RegExp(`\\b${c.symbol}\\b`, "i").test(trimmed)) ?? null;
    setProvisional(priorMatch);
    scrollToBottom();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, history: nextHistory, intentHint }),
      });
      if (!res.body) throw new Error("Something went wrong");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done: (ChatStreamEvent & { type: "done" }) | null = null;

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;

          const event = JSON.parse(line) as ChatStreamEvent;
          if (event.type === "status") {
            // Stages announce themselves once (just `text`), then update the
            // SAME entry in place once their fetch resolves (adding
            // `finding`) — merge by id rather than always appending, so a
            // stage's line updates instead of duplicating.
            setStatusTrace((prev) => {
              const idx = prev.findIndex((s) => s.id === event.id);
              if (idx === -1) return [...prev, event];
              const next = [...prev];
              next[idx] = { ...next[idx], ...event };
              return next;
            });
            scrollToBottom();
          } else {
            done = event;
          }
        }
      }

      if (!done) throw new Error("Something went wrong");
      if (done.error) throw new Error(done.error);

      // Log every fresh analysis automatically — the track record has to be
      // the whole record, not a cherry-picked subset the user chose to save.
      let whatChanged: WhatChanged | undefined;
      if (done.card) {
        // Looked up BEFORE logCall, so "prior" is genuinely the last time
        // this symbol was searched, not the entry about to be written for
        // right now — this is the entire "standing watch" feature: the
        // call log already remembers every search, this just diffs against
        // that existing memory instead of adding new storage.
        const prior = await getPriorCall(done.card.ticker);
        if (prior) {
          const scoreDelta = done.card.convictionScore - prior.convictionScore;
          if (prior.verdict !== done.card.verdict || Math.abs(scoreDelta) >= MEANINGFUL_SCORE_DELTA) {
            whatChanged = {
              previousVerdict: prior.verdict,
              previousScore: prior.convictionScore,
              previousAt: prior.calledAt,
              scoreDelta,
            };
          }
        }
        await logCall({
          symbol: done.card.ticker,
          companyName: done.card.companyName,
          calledAt: done.card.generatedAt,
          calledPrice: done.card.price,
          convictionScore: done.card.convictionScore,
          verdict: done.card.verdict,
        });
        setCallLog(await getCallLog());
      }

      // A comparison is really 2-3 real searches run together — each one
      // counts in the unfiltered record the same as a solo search would.
      if (done.comparison) {
        for (const analysis of done.comparison.tickers) {
          await logCall({
            symbol: analysis.ticker,
            companyName: analysis.companyName,
            calledAt: analysis.generatedAt,
            calledPrice: analysis.price,
            convictionScore: analysis.convictionScore,
            verdict: analysis.verdict,
          });
        }
        setCallLog(await getCallLog());
      }

      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          text: done!.reply ?? "",
          card: done!.card,
          visual: done!.visual,
          screener: done!.screener,
          comparison: done!.comparison,
          whatChanged,
        },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "assistant", text: `Couldn't complete that: ${message}` },
      ]);
    } finally {
      setPending(false);
      setStatusTrace([]);
      setProvisional(null);
      scrollToBottom();
    }
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="flex h-screen flex-col">
      <div className="relative min-h-0 flex-1">
      <div
        className={clsx(
          "absolute inset-x-0 top-0 z-20 flex items-center justify-between border-b px-4 py-2 transition-colors duration-300 sm:px-6",
          scrolled ? "otto-material-thick border-otto-border-soft" : "border-transparent"
        )}
      >
        <div className="flex items-center gap-2">
          <span className="otto-material flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold text-otto-gold">
            O
          </span>
          <span className="otto-text-caption font-semibold tracking-wide text-otto-text">Otto AI</span>
        </div>
        <div className="otto-material flex items-center rounded-full border p-0.5">
          <button
            onClick={() => setPanel("watchlist")}
            className="otto-text-caption rounded-full px-3 py-1 text-otto-text-muted transition-colors hover:text-otto-text"
          >
            Watchlist{watchlist.length > 0 ? ` (${watchlist.length})` : ""}
          </button>
          <div className="h-3.5 w-px bg-otto-border" />
          <button
            onClick={() => setPanel("track-record")}
            className="otto-text-caption rounded-full px-3 py-1 text-otto-text-muted transition-colors hover:text-otto-text"
          >
            Track Record{callLog.length > 0 ? ` (${callLog.length})` : ""}
          </button>
          <div className="h-3.5 w-px bg-otto-border" />
          {user ? (
            <div className="flex items-center gap-2 pl-3">
              <span
                className="otto-text-caption max-w-[160px] truncate text-otto-text-muted"
                title={user.email ?? undefined}
              >
                {user.email}
              </span>
              <button
                onClick={() => signOut()}
                className="otto-text-caption rounded-full px-3 py-1 text-otto-text-faint transition-colors hover:text-otto-bear"
              >
                Sign out
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAuthOpen(true)}
              className="otto-text-caption rounded-full px-3 py-1 text-otto-gold transition-colors hover:opacity-80"
            >
              Sign in
            </button>
          )}
        </div>
      </div>
      {isEmpty && authLoading ? null : isEmpty && !user ? (
        <LandingHero onStart={() => inputRef.current?.focus()} onExample={(text) => send(text)} />
      ) : isEmpty && user ? (
        <div className="flex h-full flex-col items-center justify-center px-6 pb-24 text-center">
          <span className="otto-text-label mb-3 block tracking-[0.3em] text-otto-gold">Otto AI</span>
          <h1 className="otto-text-display text-otto-text">Welcome back.</h1>
          <p className="otto-text-body mt-3 max-w-sm text-otto-text-muted">
            Ask about any ticker, or check your watchlist above.
          </p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}
          className="absolute inset-0 overflow-y-auto pb-28"
        >
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 pb-8 pt-16 sm:px-0">
            {messages.map((m) => (
              <div
                key={m.id}
                className={clsx("otto-arrive flex", m.role === "user" ? "justify-end" : "justify-start")}
              >
                {m.role === "user" ? (
                  <div className="max-w-sm rounded-2xl rounded-br-sm bg-white/[0.06] px-4 py-2.5 text-sm text-otto-text">
                    {m.text}
                  </div>
                ) : (
                  <div className="flex w-full flex-col gap-3">
                    {m.card ? (
                      <>
                        {m.whatChanged && <WhatChangedBanner whatChanged={m.whatChanged} />}
                        {expandedId === m.id ? (
                          <ExpandedResearchSheet
                            analysis={m.card}
                            onCollapse={() => setExpandedId(null)}
                            watched={watchlist.some((w) => w.symbol === m.card!.ticker)}
                            onToggleWatch={() => toggleWatch(m.card!)}
                          />
                        ) : (
                          <OttoCardCompact
                            analysis={m.card}
                            onExpand={() => setExpandedId(m.id)}
                            watched={watchlist.some((w) => w.symbol === m.card!.ticker)}
                            onToggleWatch={() => toggleWatch(m.card!)}
                            onCompare={(symbols) => send(symbols.join(" "))}
                          />
                        )}
                      </>
                    ) : m.comparison ? (
                      <>
                        <p className="max-w-lg text-sm leading-relaxed text-otto-text">{m.text}</p>
                        <ComparisonCard comparison={m.comparison} onSelect={(symbol) => send(symbol)} />
                      </>
                    ) : (
                      <>
                        {m.visual?.type === "sparkline" ? (
                          <div className="flex max-w-lg items-center gap-3">
                            <p className="text-sm leading-relaxed text-otto-text">{m.text}</p>
                            <MiniSparkline data={m.visual.historicalPrices} positive={m.visual.positive} />
                          </div>
                        ) : (
                          <>
                            <p className="max-w-lg text-sm leading-relaxed text-otto-text">{m.text}</p>
                            {m.visual && <FollowUpVisualCard visual={m.visual} />}
                          </>
                        )}
                        {m.screener && (
                          <ScreenerResultsCard screener={m.screener} onSelect={(symbol) => send(symbol, m.screener?.intent)} />
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
            {pending && provisional && (
              <div className="otto-arrive flex justify-start">
                <ProvisionalCard prior={provisional} />
              </div>
            )}
            {pending && (
              <div className="otto-arrive otto-glow-border rounded-2xl">
                <div className="otto-progress-rail flex flex-col gap-2 rounded-2xl border border-otto-border-soft bg-otto-bg-raised p-4">
                  {statusTrace.length === 0 ? (
                    <div className="flex items-center gap-1.5 text-otto-text-faint">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
                    </div>
                  ) : (
                    statusTrace.map((stage, i) => {
                      // A stage that tracks its own finding only settles once
                      // that finding actually lands (genuinely parallel work —
                      // several can be "still in flight" at once). A plain
                      // sequential stage (no finding ever coming) falls back to
                      // "settled once a later stage exists," same as before.
                      const settled = stage.finding !== undefined || (!stage.tracksFinding && i < statusTrace.length - 1);
                      return (
                        <div key={stage.id} className="flex flex-col gap-0.5">
                          <div
                            className={clsx(
                              "otto-arrive flex items-center gap-2 text-xs",
                              settled ? "text-otto-text-faint" : "text-otto-text-muted"
                            )}
                          >
                            <StageBadge icon={stage.icon} settled={settled} />
                            <span className={settled ? "line-through decoration-otto-text-faint/50" : ""}>{stage.text}</span>
                          </div>
                          {stage.finding && (
                            <span className="otto-finding-flash otto-text-caption pl-5 text-otto-bull">✓ {stage.finding}</span>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="otto-material-thick absolute inset-x-0 bottom-0 border-t px-4 pb-6 pt-4 sm:px-0">
        <div
          className={clsx("mx-auto w-full max-w-2xl rounded-full", (pending || inputFocused) && "otto-glow-border")}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 rounded-full border border-otto-border bg-otto-bg-raised px-3 py-2.5"
          >
            <PresetMenu disabled={pending} onSelect={(query) => send(query)} />
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder="Ask Otto about a stock…"
              className="flex-1 bg-transparent text-sm text-otto-text placeholder:text-otto-text-faint focus:outline-none"
              autoFocus
            />
            <button
              type="submit"
              disabled={pending}
              className="rounded-full bg-otto-gold px-4 py-1.5 text-xs font-medium text-otto-bg transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </div>
      </div>
      </div>

      <SlideOver open={panel === "track-record"} onClose={() => setPanel(null)}>
        <TrackRecordPanel calls={callLog} />
      </SlideOver>

      <SlideOver open={panel === "watchlist"} onClose={() => setPanel(null)}>
        <PortfolioPanel
          watchlist={watchlist}
          onChange={refreshPersisted}
          onSelect={(symbol) => {
            setPanel(null);
            send(symbol);
          }}
        />
      </SlideOver>

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
    </div>
  );
}
