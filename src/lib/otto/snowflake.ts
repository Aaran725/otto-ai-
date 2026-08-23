import type { StockBundle } from "./fmp";
import { computeTechnicals } from "./technicals";

export interface SnowflakeCheck {
  label: string;
  passed: boolean;
}

export interface SnowflakeAxisScore {
  score: number; // 0-6, normalized regardless of how many checks actually ran
  checks: SnowflakeCheck[]; // only checks whose underlying data existed
}

export interface OttoSnowflakeScores {
  valuation: SnowflakeAxisScore;
  growth: SnowflakeAxisScore;
  quality: SnowflakeAxisScore;
  financialHealth: SnowflakeAxisScore;
  momentum: SnowflakeAxisScore;
}

/**
 * Normalizes to a 0-6 scale regardless of how many checks actually ran, and
 * — critically — never scores an axis on data it doesn't have. FMP blocks
 * ratios/key-metrics/income-statement entirely for some large, liquid
 * tickers (CRWD, RDDT) under this plan; a missing value must never resolve
 * to "failed check", or Otto would call every data-starved stock a Strong
 * Avoid regardless of its actual fundamentals. checks.length < 6 in the
 * result means "fewer checks were applicable", which the UI surfaces.
 */
function axis(checks: SnowflakeCheck[]): SnowflakeAxisScore {
  if (checks.length === 0) return { score: 3, checks }; // truly no data: neutral, not zero
  const passed = checks.filter((c) => c.passed).length;
  const score = Math.round((passed / checks.length) * 6);
  return { score, checks };
}

function yoyGrowth(latest: number, prior: number): number | null {
  if (!prior || prior === 0) return null;
  return (latest - prior) / Math.abs(prior);
}

/**
 * All five axes are scored from fixed absolute thresholds against real FMP
 * data — no LLM involved. This mirrors Simply Wall St's pass/fail-check
 * methodology: reproducible, explainable, can't hallucinate a number. Every
 * check below is only added to its axis when the underlying field actually
 * exists — see the `axis()` doc comment for why that matters.
 */
export function computeSnowflake(bundle: StockBundle): OttoSnowflakeScores {
  const { quote, ratios, keyMetrics, income, cashFlow } = bundle;

  const valuationChecks: SnowflakeCheck[] = [];
  if (ratios?.priceToEarningsRatio !== undefined) {
    valuationChecks.push({ label: "P/E under 25x", passed: ratios.priceToEarningsRatio < 25 });
  }
  if (ratios?.priceToFreeCashFlowRatio !== undefined) {
    valuationChecks.push({ label: "P/FCF under 20x", passed: ratios.priceToFreeCashFlowRatio < 20 });
  }
  if (keyMetrics?.freeCashFlowYield !== undefined) {
    valuationChecks.push({ label: "FCF yield above 4%", passed: keyMetrics.freeCashFlowYield > 0.04 });
  }
  if (ratios?.priceToBookRatio !== undefined) {
    valuationChecks.push({ label: "P/B under 6x", passed: ratios.priceToBookRatio < 6 });
  }
  if (ratios?.priceToSalesRatio !== undefined) {
    valuationChecks.push({ label: "P/S under 6x", passed: ratios.priceToSalesRatio < 6 });
  }
  if (ratios?.priceToEarningsGrowthRatio !== undefined) {
    const peg = ratios.priceToEarningsGrowthRatio;
    valuationChecks.push({ label: "PEG under 2x", passed: peg > 0 && peg < 2 });
  }
  const valuation = axis(valuationChecks);

  const latestIncome = income.at(-1);
  const priorIncome = income.at(-2);
  const latestCashFlow = cashFlow.at(-1);
  const priorCashFlow = cashFlow.at(-2);
  const oldestIncome = income[0];

  // Fall back to ratios.revenueGrowthYoY (Finnhub) when FMP's income
  // statement is blocked for this ticker.
  const revenueGrowthYoY =
    (latestIncome && priorIncome ? yoyGrowth(latestIncome.revenue, priorIncome.revenue) : null) ??
    ratios?.revenueGrowthYoY ??
    null;
  const earningsGrowthYoY = latestIncome && priorIncome ? yoyGrowth(latestIncome.netIncome, priorIncome.netIncome) : null;
  const fcfGrowthYoY = latestCashFlow && priorCashFlow ? yoyGrowth(latestCashFlow.freeCashFlow, priorCashFlow.freeCashFlow) : null;
  const revenueCagr =
    latestIncome && oldestIncome && income.length > 1
      ? Math.pow(latestIncome.revenue / Math.max(oldestIncome.revenue, 1), 1 / (income.length - 1)) - 1
      : null;
  const netMarginLatest = latestIncome && latestIncome.revenue !== 0 ? latestIncome.netIncome / latestIncome.revenue : null;
  const netMarginPrior = priorIncome && priorIncome.revenue !== 0 ? priorIncome.netIncome / priorIncome.revenue : null;

  const growthChecks: SnowflakeCheck[] = [];
  if (revenueGrowthYoY !== null) growthChecks.push({ label: "Revenue grew YoY", passed: revenueGrowthYoY > 0 });
  if (revenueCagr !== null) growthChecks.push({ label: "Revenue 5yr CAGR above 8%", passed: revenueCagr > 0.08 });
  if (earningsGrowthYoY !== null) growthChecks.push({ label: "Net income grew YoY", passed: earningsGrowthYoY > 0 });
  if (fcfGrowthYoY !== null) growthChecks.push({ label: "Free cash flow grew YoY", passed: fcfGrowthYoY > 0 });
  if (netMarginLatest !== null && netMarginPrior !== null) {
    growthChecks.push({ label: "Net margin expanding", passed: netMarginLatest > netMarginPrior });
  }
  if (latestIncome !== undefined) {
    growthChecks.push({ label: "Profitable (positive net income)", passed: latestIncome.netIncome > 0 });
  }
  const growth = axis(growthChecks);

  const qualityChecks: SnowflakeCheck[] = [];
  if (ratios?.grossProfitMargin !== undefined) {
    qualityChecks.push({ label: "Gross margin above 35%", passed: ratios.grossProfitMargin > 0.35 });
  }
  if (ratios?.operatingProfitMargin !== undefined) {
    qualityChecks.push({ label: "Operating margin above 10%", passed: ratios.operatingProfitMargin > 0.1 });
  }
  if (ratios?.netProfitMargin !== undefined) {
    qualityChecks.push({ label: "Net margin above 5%", passed: ratios.netProfitMargin > 0.05 });
  }
  if (keyMetrics?.returnOnInvestedCapital !== undefined) {
    qualityChecks.push({ label: "ROIC above 10%", passed: keyMetrics.returnOnInvestedCapital > 0.1 });
    qualityChecks.push({
      label: "ROIC beats a ~8% cost of capital",
      passed: keyMetrics.returnOnInvestedCapital > 0.08,
    });
  }
  if (keyMetrics?.returnOnEquity !== undefined) {
    qualityChecks.push({ label: "ROE above 15%", passed: keyMetrics.returnOnEquity > 0.15 });
  }
  const quality = axis(qualityChecks);

  const financialHealthChecks: SnowflakeCheck[] = [];
  if (ratios?.currentRatio !== undefined) {
    financialHealthChecks.push({ label: "Current ratio above 1", passed: ratios.currentRatio > 1 });
  }
  if (ratios?.quickRatio !== undefined) {
    financialHealthChecks.push({ label: "Quick ratio above 1", passed: ratios.quickRatio > 1 });
  }
  if (ratios?.debtToEquityRatio !== undefined) {
    financialHealthChecks.push({ label: "Debt-to-equity under 1", passed: ratios.debtToEquityRatio < 1 });
  }
  if (ratios?.interestCoverageRatio !== undefined) {
    financialHealthChecks.push({ label: "Interest coverage above 3x", passed: ratios.interestCoverageRatio > 3 });
  }
  if (ratios?.cashRatio !== undefined) {
    financialHealthChecks.push({ label: "Cash ratio above 0.2", passed: ratios.cashRatio > 0.2 });
  }
  if (keyMetrics?.netDebtToEBITDA !== undefined) {
    financialHealthChecks.push({ label: "Net debt under 3x EBITDA", passed: keyMetrics.netDebtToEBITDA < 3 });
  }
  const financialHealth = axis(financialHealthChecks);

  const monthly = bundle.historicalMonthly;
  const ytdTrend =
    monthly.length >= 2 ? monthly[monthly.length - 1].price / monthly[0].price - 1 : null;

  // yearHigh/priceAvg50/priceAvg200 come from FMP's /quote, which is
  // blocked for some tickers regardless of size (e.g. RDDT, CRWD). Rather
  // than just dropping the check, fall back to our own SMA3/SMA6/trailing-
  // high computed from historicalMonthly (now populated via the Yahoo
  // fallback too) — real math on real closes, keeping the check count at
  // the same ceiling instead of silently thinning out to 1-2 checks.
  const technicals = computeTechnicals(monthly.map((p) => p.price));

  const momentumChecks: SnowflakeCheck[] = [
    { label: "Positive 1-day move", passed: quote.changePercentage > 0 },
  ];
  if (ytdTrend !== null) {
    momentumChecks.push({ label: "Positive trailing 12mo trend", passed: ytdTrend > 0 });
  }
  if (quote.priceAvg50 !== undefined) {
    momentumChecks.push({ label: "Price above 50-day average", passed: quote.price > quote.priceAvg50 });
  } else if (technicals) {
    momentumChecks.push({ label: "Price above 3-month average (SMA proxy)", passed: quote.price > technicals.sma3 });
  }
  if (quote.priceAvg200 !== undefined) {
    momentumChecks.push({ label: "Price above 200-day average", passed: quote.price > quote.priceAvg200 });
  } else if (technicals) {
    momentumChecks.push({ label: "Price above 6-month average (SMA proxy)", passed: quote.price > technicals.sma6 });
  }
  if (quote.priceAvg50 !== undefined && quote.priceAvg200 !== undefined) {
    momentumChecks.push({
      label: "50-day average above 200-day (uptrend)",
      passed: quote.priceAvg50 > quote.priceAvg200,
    });
  } else if (technicals) {
    momentumChecks.push({
      label: "Short-term trend above medium-term (uptrend)",
      passed: technicals.trend === "uptrend",
    });
  }
  if (quote.yearHigh !== undefined) {
    momentumChecks.push({ label: "Within 25% of 52-week high", passed: quote.price / quote.yearHigh > 0.75 });
  } else if (technicals) {
    momentumChecks.push({
      label: "Within 25% of trailing 12mo high",
      passed: 1 + technicals.pctFromHigh > 0.75,
    });
  }
  // Real trailing multi-week returns from Finnhub's free /stock/metric —
  // only populated via the Finnhub fallback path, but crucial there: it's
  // the difference between judging momentum on a sustained trend versus
  // only whether today happened to be green.
  if (keyMetrics?.thirteenWeekReturn !== undefined) {
    momentumChecks.push({ label: "Positive 13-week return", passed: keyMetrics.thirteenWeekReturn > 0 });
  }
  if (keyMetrics?.twentySixWeekReturn !== undefined) {
    momentumChecks.push({ label: "Positive 26-week return", passed: keyMetrics.twentySixWeekReturn > 0 });
  }
  if (keyMetrics?.relativeStrength13Week !== undefined) {
    momentumChecks.push({
      label: "Outperforming the S&P 500 over 13 weeks",
      passed: keyMetrics.relativeStrength13Week > 0,
    });
  }
  const momentum = axis(momentumChecks);

  return { valuation, growth, quality, financialHealth, momentum };
}
