import { fetchStockBundle } from "@/lib/otto/fmp";
import { runOttoAnalysis, runOttoFollowUp } from "@/lib/otto/groq";
import { resolveTickerFromText } from "@/lib/otto/resolve-ticker";
import { looksLikeFreshRequest, detectFollowUpTopic, buildFollowUpVisual } from "@/lib/otto/followup-intent";
import { detectScreenIntent, detectThemeFilter, detectCapFilter, intentLabel, runScreener } from "@/lib/otto/screener";
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

        // A ticker mentioned in a question about the stock we're already
        // discussing ("what's your forecast for UBER") is a follow-up, not a
        // request to regenerate the card — only re-run the full pipeline when
        // there's no existing card for this ticker, or the message is an
        // explicit fresh/refresh request.
        const resolved = await resolveTickerFromText(message);
        const isNewTicker = resolved && resolved.symbol !== lastCard?.ticker;
        const wantsFreshAnalysis = resolved && (isNewTicker || looksLikeFreshRequest(message));

        if (wantsFreshAnalysis && resolved) {
          const emit: ProgressFn = (update) => send({ type: "status", ...update });
          const bundle = await fetchStockBundle(resolved.symbol, emit);
          const analysis = await runOttoAnalysis(resolved.symbol, bundle, emit);
          send({ type: "done", reply: analysis.oneLiner, card: analysis });
          controller.close();
          return;
        }

        // No specific ticker named — "what's undervalued", "your pick",
        // "rocket stock" etc. should screen the market, not fall through to
        // a generic "give me a ticker" prompt or a stale follow-up about
        // whatever was discussed last.
        if (!resolved) {
          const theme = detectThemeFilter(message);
          const capFilter = detectCapFilter(message);
          // A theme/cap filter alone ("AI stocks", "mega cap stocks") with no
          // explicit intent word defaults to "best" — momentum stays momentum
          // even with a filter, since "hot AI stocks" should still mean
          // momentum-ranked, not composite.
          const screenIntent = detectScreenIntent(message) ?? (theme || capFilter ? "best" : null);

          if (screenIntent) {
            const results = await runScreener(screenIntent, theme, capFilter, (update) => send({ type: "status", ...update }));
            if (results.length === 0) {
              send({
                type: "done",
                reply: "Couldn't screen the market right now — data provider is temporarily unavailable, or no matches for that filter. Try again shortly, or ask about a specific ticker.",
              });
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
