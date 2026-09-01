import { redis } from "./cache";
import type { OttoSnowflakeScores } from "./snowflake";

/**
 * The "best" screen no longer runs one fixed, hand-tuned weight formula
 * forever. Three genuinely different real philosophies compete for the
 * same real capital pool, and a real Thompson-sampling bandit — not a
 * human, not a schedule — decides which one gets to make the next call,
 * weighted by which one has actually been earning real alpha so far.
 * Nobody picks the "right" formula again; the formula that's actually
 * working keeps winning more chances to prove it, automatically,
 * forever, off real evaluated outcomes (see recordVariantOutcome).
 */
export type BestVariant = "value" | "momentum" | "quality";

const VARIANTS: BestVariant[] = ["value", "momentum", "quality"];

type SnowflakeAxis = keyof OttoSnowflakeScores;

// Three real, meaningfully different takes on "what makes a good stock" —
// not a copy of the existing undervalued/momentum/quality screens (those
// have their own narrower mandates and their own capital pools already);
// these three specifically compete to answer "best," the one intent
// that was always just "balanced across everything" by default rather
// than a real answer to which balance actually works.
export const BEST_VARIANT_WEIGHTS: Record<BestVariant, Partial<Record<SnowflakeAxis, number>>> = {
  value: { valuation: 2, quality: 1, financialHealth: 1, growth: 0.5, momentum: 0.3 },
  momentum: { momentum: 2, growth: 1.5, valuation: 0.5, quality: 0.5, financialHealth: 0.3 },
  quality: { quality: 2, financialHealth: 1.5, valuation: 0.7, growth: 0.8, momentum: 0.5 },
};

interface BetaPosterior {
  alpha: number; // real positive-alpha outcomes, +1 prior
  beta: number; // real negative/zero-alpha outcomes, +1 prior
}

const NAMESPACE = "otto:bandit:best";
const posteriorKey = (variant: BestVariant) => `${NAMESPACE}:${variant}`;

// Marsaglia-Tsang: standard, well-tested method for sampling Gamma(shape, 1)
// with no external dependency. Two independent Gamma draws give a real
// Beta(alpha, beta) sample via X/(X+Y) — genuine Thompson sampling, not an
// approximation dressed up as one.
function gaussianRandom(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleGamma(shape: number): number {
  if (shape < 1) {
    const u = Math.random();
    return sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = gaussianRandom();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

async function getPosterior(variant: BestVariant): Promise<BetaPosterior> {
  const stored = await redis.get<BetaPosterior>(posteriorKey(variant));
  // Beta(1,1) — a flat, honest uniform prior. No variant starts favored;
  // the bandit only ever tilts toward one once real evaluated calls say so.
  return stored ?? { alpha: 1, beta: 1 };
}

/**
 * One real Thompson-sampling draw: sample each variant's current belief
 * distribution, hand the pick to whichever sampled highest THIS time. A
 * variant with little evidence yet still gets picked sometimes (its
 * distribution is wide, so its sample can land high) — real exploration,
 * not just always picking the current leader. As real evaluated outcomes
 * accumulate, each variant's distribution narrows around its true rate,
 * and the actually-better variant naturally wins the draw more and more.
 */
export async function selectVariant(): Promise<BestVariant> {
  const posteriors = await Promise.all(VARIANTS.map((v) => getPosterior(v)));
  const samples = posteriors.map((p) => sampleBeta(p.alpha, p.beta));
  let bestIdx = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] > samples[bestIdx]) bestIdx = i;
  }
  return VARIANTS[bestIdx];
}

/** Real evidence, once — called exactly once per call, at its first real
 * evaluated milestone (see evaluateDueScreenerCalls), never re-recorded. */
export async function recordVariantOutcome(variant: BestVariant, alphaWasPositive: boolean): Promise<void> {
  const current = await getPosterior(variant);
  const updated: BetaPosterior = alphaWasPositive
    ? { alpha: current.alpha + 1, beta: current.beta }
    : { alpha: current.alpha, beta: current.beta + 1 };
  await redis.set(posteriorKey(variant), updated);
}

export interface VariantStatus {
  variant: BestVariant;
  alpha: number;
  beta: number;
  realSamples: number; // total real evaluated outcomes behind this posterior, excluding the prior
  impliedWinRate: number; // alpha / (alpha + beta) — the bandit's current best guess, not a guarantee
}

/** Read-only status for a real transparency panel — exactly what the
 * bandit currently believes about each variant, and how much real
 * evidence that belief is actually built on. */
export async function getBanditStatus(): Promise<VariantStatus[]> {
  const posteriors = await Promise.all(VARIANTS.map((v) => getPosterior(v)));
  return VARIANTS.map((variant, i) => {
    const { alpha, beta } = posteriors[i];
    return {
      variant,
      alpha,
      beta,
      realSamples: alpha + beta - 2, // minus the Beta(1,1) prior's two phantom counts
      impliedWinRate: Math.round((alpha / (alpha + beta)) * 1000) / 10,
    };
  });
}
