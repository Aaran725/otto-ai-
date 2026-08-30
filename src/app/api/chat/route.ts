import { fetchStockBundle } from "@/lib/otto/fmp";
import { runOttoAnalysis, runOttoFollowUp } from "@/lib/otto/groq";
import { resolveExplicitTickers, resolveTickerByFuzzyName, type ResolvedTicker } from "@/lib/otto/resolve-ticker";
import { looksLikeFreshRequest, detectFollowUpTopic, buildFollowUpVisual } from "@/lib/otto/followup-intent";
import { detectScreenIntent, detectThemeFilter, detectCapFilter, intentLabel, runScreener, type CapFilter } from "@/lib/otto/screener";
import { interpretScreenQuery, themeQueryToFilter, verifySeedTickers } from "@/lib/otto/screen-query";
import { recordEvent } from "@/lib/otto/observability";
import type { ChatRequestBody, ChatStreamEvent, ProgressFn } from "@/lib/otto/chat-types";

/**
 * Streams newline-delimited JSON instead of one JSON blob. A single-stock
 * lookup or follow-up still resolves in a couple seconds and just emits its
 * one "done" event immediately — but a cache-miss screener scan now takes
 * 15-30s+ (wide funnel + insider + filing checks), and previously that was
 * dead air behind a spinner. Real stage progress from runScreener's
 * onProgress callback lands as its own "status" event as it actually
 * happens, so the wait reads as Otto doing real work, not lag.
 */
// Screener scans widened in the Tier 1 quality pass (deterministic pool +
// per-symbol caching let a cold scan cover more of the market) — give it
// headroom above the platform's default function timeout.
export const maxDuration = 90;

export async function POST(request: Request) {
  const body = (await request.json()) as ChatRequestBody;
  const message = body.message?.trim();
  const history = body.history ?? [];
  const intentHint = body.intentHint;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      // Guards against a double-close/double-send once the soft timeout
      // below fires — the in-flight work below keeps running in the
      // background even after the timeout wins the race (there's no clean
      // way to cancel a nested Finnhub/SEC fetch chain), so anything it
      // tries to send/close afterward must silently no-op instead of
      // throwing on an already-closed controller.
      let settled = false;
      function send(event: ChatStreamEvent) {
        if (settled) return;
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      }
      function closeOnce() {
        if (settled) return;
        settled = true;
        try {
          controller.close();
        } catch {
          // Already closed/errored — nothing to do.
        }
      }

      if (!message) {
        send({ type: "done", error: "Message is required" });
        closeOnce();
        return;
      }

      // A real Vercel platform timeout (maxDuration above) kills the
      // function with no final event at all — the client then falls back
      // to a generic "Something went wrong," a worse failure than an
      // honest message. Confirmed live: a wide screener scan hit a window
      // where every Finnhub key was rate-limited at once, and retrying
      // through hundreds of candidates pushed one real request to the 90s
      // wall. This soft internal timeout fires first, with real margin,
      // so the user always gets an explicit "this timed out" message
      // instead of a silently dropped stream — the in-flight work isn't
      // cancelled (no clean way to), it just loses the race to report.
      const SOFT_TIMEOUT_MS = 80_000;
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, SOFT_TIMEOUT_MS));

      const work = (async () => {
      try {
        const lastCard = [...history].reverse().find((m) => m.role === "assistant" && m.card)?.card;

        async function runFreshAnalysis(resolved: ResolvedTicker) {
          const emit: ProgressFn = (update) => send({ type: "status", ...update });
          const bundle = await fetchStockBundle(resolved.symbol, emit);
          const analysis = await runOttoAnalysis(resolved.symbol, bundle, emit, intentHint);
          send({ type: "done", reply: analysis.oneLiner, card: analysis });
          closeOnce();
        }

        // 2-3 explicit tickers named together ("PLTR or PATH", "compare
        // NVDA and AMD") is already an unambiguous, low-false-positive
        // signal on its own — no connector word required — since
        // extractExplicitCandidates only trusts $-prefixed or literal
        // all-caps tokens, the same strict standard the single-ticker path
        // already relies on. Each analysis is the exact same cached,
        // independently-verified pipeline as a normal search, just run in
        // parallel and rendered as one comparative view instead of 2-3
        // separate messages.
        async function runComparison(resolvedTickers: ResolvedTicker[]) {
          send({
            type: "status",
            id: "compare",
            text: `Comparing ${resolvedTickers.map((t) => t.symbol).join(", ")}…`,
            icon: "otto",
          });
          const analyses = await Promise.all(
            resolvedTickers.map(async (resolved) => {
              const bundle = await fetchStockBundle(resolved.symbol);
              return runOttoAnalysis(resolved.symbol, bundle);
            })
          );
          const symbolList = analyses.map((a) => a.ticker).join(" vs. ");
          send({
            type: "done",
            reply: `Here's how ${symbolList} stack up side by side.`,
            comparison: { tickers: analyses },
          });
          closeOnce();
        }

        // A ticker mentioned in a question about the stock we're already
        // discussing ("what's your forecast for UBER") is a follow-up, not a
        // request to regenerate the card — only re-run the full pipeline when
        // there's no existing card for this ticker, or the message is an
        // explicit fresh/refresh request. Explicit signals ($TICKER, or a
        // literal ALL-CAPS token the user typed) are trusted immediately —
        // unambiguous, unlike the fuzzy whole-message company-name match
        // below, which needs a screen-request check to run first.
        const explicitTickers = await resolveExplicitTickers(message);
        if (explicitTickers.length >= 2) {
          await runComparison(explicitTickers);
          return;
        }
        const explicitTicker = explicitTickers[0] ?? null;
        if (explicitTicker) {
          const isNewTicker = explicitTicker.symbol !== lastCard?.ticker;
          if (isNewTicker || looksLikeFreshRequest(message)) {
            await runFreshAnalysis(explicitTicker);
            return;
          }
        }

        if (!explicitTicker) {
          const themeRegex = detectThemeFilter(message);
          const capFilterRegex = detectCapFilter(message);
          // A theme/cap filter alone ("AI stocks", "mega cap stocks") with no
          // explicit intent word defaults to "best" — momentum stays momentum
          // even with a filter, since "hot AI stocks" should still mean
          // momentum-ranked, not composite.
          const screenIntentRegex = detectScreenIntent(message) ?? (themeRegex || capFilterRegex ? "best" : null);

          // No specific ticker named — "what's undervalued", "your pick",
          // "rocket stock", "physical AI stocks", "P/E under 30 cybersecurity
          // stocks" etc. should screen the market. The fixed 6-theme regex
          // list only covers common cases — an LLM classifier (never trusted
          // for actual financial data, only for turning free text into a
          // structured query) refines or replaces it so an arbitrary niche
          // the regex list was never going to enumerate ("physical AI",
          // "quantum computing") still gets a real screen. This check runs
          // BEFORE the fuzzy whole-message ticker match below — a screen-y
          // phrase regularly shares a word with a real company name ("Apple",
          // "Rocket", "Under [Armour]") and would otherwise get misrouted to
          // that one ticker instead of running the screener.
          const interpreted = await interpretScreenQuery(message);
          const theme = interpreted ? (interpreted.theme ? themeQueryToFilter(interpreted.theme) : null) : themeRegex;
          let capFilter: CapFilter | null = capFilterRegex;
          if (interpreted?.minMarketCapMillions) {
            capFilter = {
              label: `$${Math.round(interpreted.minMarketCapMillions / 1000)}B+ cap`,
              key: `cap-${interpreted.minMarketCapMillions}`,
              minMarketCapMillions: interpreted.minMarketCapMillions,
            };
          }
          const seedTickers = interpreted?.seedTickers?.length ? await verifySeedTickers(interpreted.seedTickers) : [];
          const requirements = interpreted?.requirements ?? null;
          const requireInsiderBuying = interpreted?.requiresInsiderBuying ?? false;
          // interpreted === null only on a failed LLM call (rate limit,
          // network) — fall back to the regex-detected read. A successful
          // call is trusted as-is, EXCEPT a bare "intent: null" doesn't
          // necessarily mean "not a screen" — the model can (and does, e.g.
          // "search for stocks with inside rbuying") correctly extract a
          // real constraint like requiresInsiderBuying/theme/requirements
          // while leaving intent unset. When that happens, fall back to the
          // regex-detected intent BEFORE defaulting to "best" — confirmed
          // live: "where does otto disagree with wall street" correctly
          // regex-matched "contrarian", but the LLM prompt (written before
          // that intent existed) didn't recognize it and returned intent:
          // null with no other signal, so the merge discarded the correct
          // regex read entirely and fell through to fuzzy ticker matching,
          // misrouting to STT ("State Street") instead of running the
          // screen. A regex-detected intent is a real signal on its own,
          // not just an LLM-outage fallback.
          const screenIntent = interpreted
            ? (interpreted.intent ??
              screenIntentRegex ??
              (theme || capFilter !== capFilterRegex || seedTickers.length || requirements || requireInsiderBuying ? "best" : null))
            : screenIntentRegex;

          if (screenIntent) {
            const results = await runScreener(
              screenIntent,
              theme,
              capFilter,
              (update) => send({ type: "status", ...update }),
              seedTickers,
              requirements,
              requireInsiderBuying
            );
            if (results.length === 0) {
              recordEvent("screener_zero_results", { intent: screenIntent, theme: theme?.key, capFilter: capFilter?.key });
              // Phase C: "undervalued" and "best" now apply a real bar
              // (minimum forecast upside / conviction gate — see
              // runScreener) before a candidate can appear at all, so a
              // clean sweep genuinely can mean "nothing today clears the
              // bar," not just a data-provider hiccup. Say that honestly
              // instead of serving a mediocre pick to fill 5 slots.
              const reply =
                requirements || requireInsiderBuying
                  ? "Screened the market, but nothing currently trading meets all of those requirements together — try loosening one (a lower growth bar, a higher P/E ceiling, or dropping the insider-buying requirement)."
                  : screenIntent === "undervalued"
                    ? "Screened the market, but nothing right now clears the bar for genuinely undervalued — at least 15% real forecast upside to target, not just a cheap-looking ratio. Try again later as prices move, or ask about a specific ticker."
                    : screenIntent === "best"
                      ? "Screened the market, but nothing right now clears Otto's conviction bar for a top pick — either the data was too thin to trust, or a real red flag (insider selling plus a worsening analyst trend) knocked out the leading candidates. Try again later, or ask about a specific ticker."
                      : screenIntent === "contrarian"
                        ? "Screened the market, but Otto and Wall Street are largely in agreement right now — nothing cleared a real 20-point gap between Otto's own forecast and the analyst consensus. That's a legitimate result, not a data hiccup; try again later as forecasts update."
                        : "Couldn't screen the market right now — data provider is temporarily unavailable, or no matches for that filter. Try again shortly, or ask about a specific ticker.";
              send({ type: "done", reply });
              closeOnce();
              return;
            }
            const label = [capFilter?.label, theme?.label].filter(Boolean).join(" ") || null;
            const fullLabel = label ? `${label} — ${intentLabel(screenIntent)}` : intentLabel(screenIntent);
            const top = results[0];
            // A gated intent (undervalued/best) that came back with fewer
            // than 5 real picks should say so, not silently present a
            // shorter list as if 5 was never the target — same honesty
            // principle as the zero-results case above.
            const shortListNote =
              results.length < 5 && (screenIntent === "undervalued" || screenIntent === "best" || screenIntent === "contrarian")
                ? ` Only ${results.length} ${results.length === 1 ? "stock" : "stocks"} cleared the bar today — showing real picks only, not padding to 5.`
                : "";
            send({
              type: "done",
              reply: `Screened the market for "${fullLabel}" — top pick is ${top.symbol} at $${top.price.toFixed(2)}.${shortListNote} Tap any row for the full research.`,
              screener: {
                intent: screenIntent,
                intentLabel: fullLabel,
                results: results.map((r, i) => ({ rank: i + 1, ...r })),
                isAvoidList: screenIntent === "avoid",
              },
            });
            closeOnce();
            return;
          }

          // Confirmed not a screen — now safe to try the fuzzy whole-message
          // company-name match ("tell me about the ride-sharing company
          // Uber" with no explicit ticker typed), but ONLY when there's no
          // active conversation to derail. Ordinary finance vocabulary
          // regularly collides with real company names ("bull" -> Silver
          // Bull Resources, "under" -> Under Armour, "100" -> a Nasdaq-100
          // fund) — low-risk when starting a fresh lookup with nothing else
          // to go on, but a follow-up mid-conversation ("so urs is average,
          // in the middle of bull and bear") should never be able to hijack
          // an existing thread into an unrelated ticker. When a card is
          // already active, an ambiguous message stays a follow-up.
          if (!lastCard) {
            const fuzzyTicker = await resolveTickerByFuzzyName(message);
            if (fuzzyTicker) {
              await runFreshAnalysis(fuzzyTicker);
              return;
            }
          }
        }

        if (lastCard) {
          const topic = detectFollowUpTopic(message);
          const visual = topic ? buildFollowUpVisual(topic, lastCard) : undefined;
          const reply = await runOttoFollowUp(lastCard, message);
          send({ type: "done", reply, visual });
          closeOnce();
          return;
        }

        send({
          type: "done",
          reply: "Give me a ticker, company name, or ask something like \"what's undervalued\" and I'll run the numbers.",
        });
        closeOnce();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        send({ type: "done", error: message });
        closeOnce();
      }
      })();

      await Promise.race([work, timeout]);
      if (!settled) {
        send({ type: "done", error: "This is taking Otto longer than usual and timed out — try again in a moment." });
        closeOnce();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
