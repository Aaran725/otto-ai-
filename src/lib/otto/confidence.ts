import type { DataQuality } from "./schema";

/**
 * Half-width of an honest confidence range shown around a conviction
 * score. Even "full" data quality carries real slack — the score blends a
 * deterministic Snowflake read with an LLM judgment layered on top of it,
 * not a physics measurement — and "partial" (one or more axes had no real
 * checks run at all) carries meaningfully more. Never shown for
 * "insufficient" — that case already shows no number at all (see
 * ConvictionGauge), so there's nothing to range around.
 */
export function confidenceRangeHalfWidth(dataQuality: DataQuality): number {
  switch (dataQuality) {
    case "full":
      return 3;
    case "partial":
      return 8;
    case "insufficient":
      return 0;
  }
}
