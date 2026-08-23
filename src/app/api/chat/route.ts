import { fetchStockBundle } from "@/lib/otto/fmp";
import { runOttoAnalysis, runOttoFollowUp } from "@/lib/otto/groq";
import { resolveExplicitTicker, resolveTickerByFuzzyName, type ResolvedTicker } from "@/lib/otto/resolve-ticker";
import { looksLikeFreshRequest, detectFollowUpTopic, buildFollowUpVisual } from "@/lib/otto/followup-intent";
import { detectScreenIntent, detectThemeFilter, detectCapFilter, intentLabel, runScreener, type CapFilter } from "@/lib/otto/screener";
import { interpretScreenQuery, themeQueryToFilter, verifySeedTickers } from "@/lib/otto/screen-query";
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      function send(event: ChatStreamEvent) {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      }

      if (!message) {
        send({ type: "done", error: "Message is required" });
        controller.close();
        return;
      }

      try {
        const lastCard = [...history].reverse().find((m) => m.role === "assistant" && m.card)?.card;

        async function runFreshAnalysis(resolved: ResolvedTicker) {
          const emit: ProgressFn = (update) => send({ type: "status", ...update });
          const bundle = await fetchStockBundle(resolved.symbol, emit);
          const analysis = await runOttoAnalysis(resolved.symbol, bundle, emit);
          send({ type: "done", reply: analysis.oneLiner, card: analysis });
          controller.close();
        }

        // A ticker mentioned in a question about the stock we're already
        // discussing ("what's your forecast for UBER") is a follow-up, not a
        // request to regenerate the card — only re-run the full pipeline when
        // there's no existing card for this ticker, or the message is an
        // explicit fresh/refresh request. Explicit signals ($TICKER, or a
        // literal ALL-CAPS token the user typed) are trusted immediately —
        // unambiguous, unlike the fuzzy whole-message company-name match
        // below, which needs a screen-request check to run first.
        const explicitTicker = await resolveExplicitTicker(message);
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
          // interpreted === null only on a failed LLM call (rate limit,
          // network) — fall back to the regex-detected read. A successful
          // call is trusted as-is, including an explicit "not a screen"
          // (intent: null) even if the regex thought otherwise.
          const screenIntent = interpreted ? interpreted.intent : screenIntentRegex;
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

          if (screenIntent) {
            const results = await runScreener(
              screenIntent,
              theme,
              capFilter,
              (update) => send({ type: "status", ...update }),
              seedTickers,
              requirements
            );
            if (results.length === 0) {
              const reply = requirements
                ? "Screened the market, but nothing currently trading meets all of those requirements together — try loosening one (a lower growth bar, or a higher P/E ceiling)."
                : "Couldn't screen the market right now — data provider is temporarily unavailable, or no matches for that filter. Try again shortly, or ask about a specific ticker.";
              send({ type: "done", reply });
              controller.close();
              return;
            }
            const label = [capFilter?.label, theme?.label].filter(Boolean).join(" ") || null;
            const fullLabel = label ? `${label} — ${intentLabel(screenIntent)}` : intentLabel(screenIntent);
            const top = results[0];
            send({
              type: "done",
              reply: `Screened the market for "${fullLabel}" — top pick is ${top.symbol} at $${top.price.toFixed(2)}. Tap any row for the full research.`,
              screener: {
                intentLabel: fullLabel,
                results: results.map((r, i) => ({ rank: i + 1, ...r })),
                isAvoidList: screenIntent === "avoid",
              },
            });
            controller.close();
            return;
          }

          // Confirmed not a screen — now safe to try the fuzzy whole-message
          // company-name match ("tell me about the ride-sharing company
          // Uber" with no explicit ticker typed).
          const fuzzyTicker = await resolveTickerByFuzzyName(message);
          if (fuzzyTicker) {
            await runFreshAnalysis(fuzzyTicker);
            return;
          }
        }

        if (lastCard) {
          const topic = detectFollowUpTopic(message);
          const visual = topic ? buildFollowUpVisual(topic, lastCard) : undefined;
          const reply = await runOttoFollowUp(lastCard, message);
          send({ type: "done", reply, visual });
          controller.close();
          return;
        }

        send({
          type: "done",
          reply: "Give me a ticker, company name, or ask something like \"what's undervalued\" and I'll run the numbers.",
        });
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        send({ type: "done", error: message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
