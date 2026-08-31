import { describe, it, expect } from "vitest";
import { dropStale, type CatalystEvent } from "../catalyst-bus";

function event(daysAgo: number, overrides: Partial<CatalystEvent> = {}): CatalystEvent {
  return {
    symbol: "TEST",
    type: "insider_cluster",
    detail: "Net insider buying (market-wide cluster feed)",
    detectedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("dropStale — the self-healing staleness filter", () => {
  it("keeps a genuinely fresh event", () => {
    expect(dropStale([event(1)])).toHaveLength(1);
  });

  it("drops an event older than the 14-day relevance window", () => {
    expect(dropStale([event(20)])).toHaveLength(0);
  });

  it("keeps an event right at the boundary and drops one just past it", () => {
    expect(dropStale([event(14)])).toHaveLength(1);
    expect(dropStale([event(15)])).toHaveLength(0);
  });

  it("filters a mixed list down to only the real, still-relevant events — this is the exact bug this fixes: a fresh event resetting a Redis key's TTL must never keep a months-old event alive alongside it", () => {
    const mixed = [event(1), event(180), event(5), event(400)];
    const result = dropStale(mixed);
    expect(result).toHaveLength(2);
    expect(result.every((e) => new Date(e.detectedAt).getTime() > Date.now() - 14 * 24 * 60 * 60 * 1000)).toBe(true);
  });
});
