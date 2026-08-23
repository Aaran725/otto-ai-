import type { StockBundle } from "./fmp";

/**
 * Groq no longer needs to echo price history or fundamentals back in its
 * output (those are merged in server-side from the same source data), so it
 * doesn't need the raw arrays as input either — just enough qualitative
 * context to write catalysts/risks/synthesis. This keeps the whole request
 * well under the free-tier 8000 TPM ceiling on gpt-oss-120b.
 */
export function summarizeBundleForPrompt(bundle: StockBundle) {
  const { quote, profile, ratios, keyMetrics, income, cashFlow, historicalMonthly } = bundle;

  const latestIncome = income.at(-1);
  const oldestIncome = income[0];
  const latestCashFlow = cashFlow.at(-1);
  const revenueCagr =
    latestIncome && oldestIncome && income.length > 1
      ? Math.pow(latestIncome.revenue / Math.max(oldestIncome.revenue, 1), 1 / (income.length - 1)) - 1
      : null;

  const first12mo = historicalMonthly[0];
  const last12mo = historicalMonthly.at(-1);
  const twelveMonthReturnPct =
    first12mo && last12mo && first12mo.price !== 0
      ? ((last12mo.price - first12mo.price) / first12mo.price) * 100
      : null;

  return {
    symbol: bundle.symbol,
    companyName: profile?.companyName ?? quote.name,
    sector: profile?.sector,
    industry: profile?.industry,
    price: quote.price,
    changePercentage: quote.changePercentage,
    currency: profile?.currency ?? "USD",
    ratios: ratios && {
      peRatio: ratios.priceToEarningsRatio,
      pfcfRatio: ratios.priceToFreeCashFlowRatio,
      debtToEquity: ratios.debtToEquityRatio,
      grossMargin: ratios.grossProfitMargin,
      operatingMargin: ratios.operatingProfitMargin,
      netMargin: ratios.netProfitMargin,
    },
    keyMetrics: keyMetrics && {
      roic: keyMetrics.returnOnInvestedCapital,
      fcfYield: keyMetrics.freeCashFlowYield,
    },
    fundamentalsSummary: {
      latestRevenue: latestIncome?.revenue ?? null,
      latestNetIncome: latestIncome?.netIncome ?? null,
      latestFreeCashFlow: latestCashFlow?.freeCashFlow ?? null,
      fiveYearRevenueCagrPct: revenueCagr !== null ? Math.round(revenueCagr * 1000) / 10 : null,
    },
    twelveMonthReturnPct: twelveMonthReturnPct !== null ? Math.round(twelveMonthReturnPct * 10) / 10 : null,
  };
}
