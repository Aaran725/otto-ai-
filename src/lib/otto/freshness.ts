const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Exponential half-life decay for time-sensitive signals — an 85-day-old
 * insider buy shouldn't score identically to a 3-day-old one. A half-life
 * curve, not a hard cutoff, to match the continuous-scaling style already
 * used elsewhere in buildWhyNudges (percentile-scaled sectorValuation,
 * ratio-scaled earnings) rather than introducing a new binary threshold
 * pattern.
 *
 * Fails open (returns full weight 1) when the event date is unknown —
 * "unknown" isn't the same claim as "stale," and treating a missing date as
 * maximally decayed would silently zero out a real signal just because its
 * date wasn't extracted, not because it's actually old. Same "unknown ≠
 * zero-signal" convention already used elsewhere (insider.ts's fallback
 * cluster-entry path).
 *
 * halfLifeDays=45 is a first-pass tuning constant, not backtested — expect
 * to revisit once there's enough real factor-contribution data (see
 * getFactorContributions in screener-track-record.ts) to actually test
 * whether 45 days is right.
 */
export function freshnessMultiplier(eventDate: string | undefined, halfLifeDays = 45): number {
  if (!eventDate) return 1;
  const ageDays = (Date.now() - new Date(eventDate).getTime()) / MS_PER_DAY;
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1; // unparseable date or clock skew — fail open
  return Math.pow(0.5, ageDays / halfLifeDays);
}
