import type { StockBundle } from "./fmp";

export interface ForecastTargets {
  bearTarget: number;
  baseTarget: number;
  bullTarget: number;
  horizonMonths: number;
  /** what basis was used, surfaced to the LLM so its rationale stays honest */
  basis: "earnings" | "revenue-fallback";
  assumedGrowthRate: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Bear/base/bull 12-month price targets computed mechanically: project next
 * year's earnings (or revenue, if earnings are unusable) with a growth rate
 * derived from recent trend, then apply a multiple that compresses for the
 * bear case and expands for the bull case around today's actual multiple.
 * No LLM involved — Groq only narrates the rationale afterward.
 */
export function computeForecastTargets(bundle: StockBundle): ForecastTargets {
  const { quote, ratios, income } = bundle;
  const horizonMonths = 12;

  const latestIncome = income.at(-1);
  const priorIncome = income.at(-2);
  const rawGrowth =
    latestIncome && priorIncome && priorIncome.netIncome !== 0
      ? (latestIncome.netIncome - priorIncome.netIncome) / Math.abs(priorIncome.netIncome)
      : null;

  const pe = ratios?.priceToEarningsRatio;
  const peUsable = pe !== undefined && pe > 0 && pe < 200;

  if (peUsable && rawGrowth !== null) {
    const growthRate = clamp(rawGrowth, -0.15, 0.35);
    const currentPE = clamp(pe, 5, 50);
    const nextYearFactor = 1 + growthRate;

    const bearMultiple = currentPE * 0.85;
    const baseMultiple = currentPE;
    const bullMultiple = currentPE * 1.15;

    const currentEPS = quote.price / currentPE;
    const nextYearEPS = currentEPS * nextYearFactor;

    return {
      bearTarget: Math.max(nextYearEPS * bearMultiple, quote.price * 0.5),
      baseTarget: nextYearEPS * baseMultiple,
      bullTarget: nextYearEPS * bullMultiple,
      horizonMonths,
      basis: "earnings",
      assumedGrowthRate: growthRate,
    };
  }

  // Fallback for unprofitable / thinly-covered names: project off revenue
  // growth instead, with a wider band since there's no earnings multiple to anchor to.
  const revGrowthRaw =
    latestIncome && priorIncome && priorIncome.revenue !== 0
      ? (latestIncome.revenue - priorIncome.revenue) / Math.abs(priorIncome.revenue)
      : 0.05;
  const growthRate = clamp(revGrowthRaw, -0.2, 0.4);

  return {
    bearTarget: quote.price * (1 + growthRate) * 0.75,
    baseTarget: quote.price * (1 + growthRate),
    bullTarget: quote.price * (1 + growthRate) * 1.3,
    horizonMonths,
    basis: "revenue-fallback",
    assumedGrowthRate: growthRate,
  };
}
