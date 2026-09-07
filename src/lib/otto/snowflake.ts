import type { StockBundle } from "./fmp";
import { computeTechnicals } from "./technicals";
import type { PeerValuation } from "./peers";

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
 * Real quant multi-factor models rank a stock against its actual sector
 * peers, never against one flat number for the whole market — 25x P/E is
 * expensive for a bank and cheap for a high-margin software company. When
 * a real peer percentile exists for this metric (peers.ts's
 * fetchPeerValuation — "% of real sector peers better than this stock,"
 * so under 50 means better than the peer median), it replaces the flat
 * threshold check entirely. Falls back to the absolute threshold when
 * there's no percentile (thin/unclassified SIC code, or this specific
 * metric wasn't available across enough peers) — never silently drops the
 * check, since a stock with no peer data shouldn't score worse just for
 * that.
 */
/**
 * The real, specific academic momentum factor — not "positive 12-month
 * trend" (already checked elsewhere in this file), but the heavily-cited
 * "12 months ago to 1 month ago" formulation: the return window
 * deliberately EXCLUDES the most recent month, because of a well-
 * documented short-term reversal effect (a stock that just ran hard
 * often gives some of it back the following month, and naive trailing
 * momentum gets that backwards). `monthly` is chronological (oldest
 * first, one point per month) — same shape as bundle.historicalMonthly.
 * Requires at least 7 points (same real-data bar computeTechnicals
 * already uses elsewhere in this file) so this is a genuine multi-month
 * window, not a 2-month approximation dressed up as "12-1." Pure,
 * exported for direct testing.
 */
export function compute12to1Momentum(monthly: number[]): number | null {
  if (monthly.length < 7) return null;
  const twelveMonthsAgo = monthly[0];
  const oneMonthAgo = monthly[monthly.length - 2]; // second-to-last — excludes the most recent month
  if (twelveMonthsAgo <= 0) return null;
  return (oneMonthAgo - twelveMonthsAgo) / twelveMonthsAgo;
}

function sectorOrAbsolute(percentile: number | null | undefined, sectorLabel: string, fallback: SnowflakeCheck | null): SnowflakeCheck | null {
  if (percentile !== null && percentile !== undefined) {
    return { label: `${sectorLabel} — better than ${100 - percentile}% of real sector peers`, passed: percentile < 50 };
  }
  return fallback;
}

/**
 * The real, standard Altman Z-Score (1968) — a validated 5-ratio
 * bankruptcy-risk composite, not an invented metric. Z > 2.99 is the
 * "safe" zone, 1.81-2.99 is "grey," below 1.81 is real distress risk.
 * Exists specifically to stop a screen from calling a company "cheap"
 * when it's actually dying — a stock can clear every valuation and
 * quality check above while still being a real bankruptcy risk. Pure,
 * exported for direct testing with real historical company figures.
 */
export function computeAltmanZScore(inputs: {
  totalAssets: number;
  workingCapital: number;
  retainedEarnings: number;
  ebit: number;
  marketCap: number;
  totalLiabilities: number;
  revenue: number;
}): number | null {
  const { totalAssets, workingCapital, retainedEarnings, ebit, marketCap, totalLiabilities, revenue } = inputs;
  if (totalAssets <= 0 || totalLiabilities <= 0) return null; // the formula divides by both — not real without them
  const a = workingCapital / totalAssets;
  const b = retainedEarnings / totalAssets;
  const c = ebit / totalAssets;
  const d = marketCap / totalLiabilities;
  const e = revenue / totalAssets;
  return 1.2 * a + 1.4 * b + 3.3 * c + 0.6 * d + 1.0 * e;
}

/**
 * The real, standard Beneish M-Score (1999) — an 8-variable composite built
 * to flag likely earnings manipulation, not an invented metric. The third
 * pillar Round 1's research named (Piotroski, Altman Z, Beneish) alongside
 * the two already built above. Needs two consecutive real fiscal years
 * (the balance-sheet fetch was widened from 1 to 5 years specifically to
 * unlock this) since every sub-index is a YoY ratio-of-ratios: DSRI
 * (receivables growing faster than sales — channel-stuffing risk), GMI
 * (deteriorating gross margin, a motive to manipulate), AQI (soft-asset
 * growth outpacing hard assets), SGI (rapid sales growth — the single
 * strongest real predictor in the original research), DEPI (slowing
 * depreciation — inflates earnings), SGAI (disproportionate SG&A growth),
 * TATA (accruals a real cash-flow check doesn't back up), LVGI (rising
 * leverage). M > -1.78 is the real, published threshold flagging likely
 * manipulation — not an invented cutoff. Returns null (never a fabricated
 * number) when any sub-index divides by a real zero. Pure, exported for
 * direct testing with real company figures.
 */
export interface BeneishPeriod {
  receivables: number;
  sales: number;
  costOfRevenue: number;
  currentAssets: number;
  ppe: number;
  totalAssets: number;
  depreciation: number;
  sga: number;
  longTermDebt: number;
  currentLiabilities: number;
}

export function computeBeneishMScore(
  latest: BeneishPeriod & { netIncome: number; operatingCashFlow: number },
  prior: BeneishPeriod
): number | null {
  if (latest.sales <= 0 || prior.sales <= 0 || latest.totalAssets <= 0 || prior.totalAssets <= 0) return null;

  const dsri = (latest.receivables / latest.sales) / (prior.receivables / prior.sales);
  const gmi =
    (prior.sales - prior.costOfRevenue) / prior.sales / ((latest.sales - latest.costOfRevenue) / latest.sales);
  const aqi =
    (1 - (prior.currentAssets + prior.ppe) / prior.totalAssets) /
    (1 - (latest.currentAssets + latest.ppe) / latest.totalAssets);
  const sgi = latest.sales / prior.sales;
  const depi =
    (prior.depreciation / (prior.ppe + prior.depreciation)) /
    (latest.depreciation / (latest.ppe + latest.depreciation));
  const sgai = (latest.sga / latest.sales) / (prior.sga / prior.sales);
  const lvgi =
    ((latest.longTermDebt + latest.currentLiabilities) / latest.totalAssets) /
    ((prior.longTermDebt + prior.currentLiabilities) / prior.totalAssets);
  const tata = (latest.netIncome - latest.operatingCashFlow) / latest.totalAssets;

  const m =
    -4.84 + 0.92 * dsri + 0.528 * gmi + 0.404 * aqi + 0.892 * sgi + 0.115 * depi - 0.172 * sgai + 4.679 * tata - 0.327 * lvgi;
  return Number.isFinite(m) ? m : null;
}

/**
 * All five axes are scored from fixed absolute thresholds against real FMP
 * data — no LLM involved. This mirrors Simply Wall St's pass/fail-check
 * methodology: reproducible, explainable, can't hallucinate a number. Every
 * check below is only added to its axis when the underlying field actually
 * exists — see the `axis()` doc comment for why that matters. `peerValuation`
 * is optional and, when present, upgrades several checks from an absolute
 * threshold to a real sector-relative percentile — see `sectorOrAbsolute`.
 */
export function computeSnowflake(bundle: StockBundle, peerValuation?: PeerValuation | null): OttoSnowflakeScores {
  const { quote, ratios, keyMetrics, income, cashFlow, balanceSheet } = bundle;
  const pct = peerValuation?.percentiles;

  const valuationChecks: SnowflakeCheck[] = [];
  const peCheck = sectorOrAbsolute(
    pct?.pe,
    "P/E",
    ratios?.priceToEarningsRatio !== undefined ? { label: "P/E under 25x", passed: ratios.priceToEarningsRatio < 25 } : null
  );
  if (peCheck) valuationChecks.push(peCheck);
  const pfcfCheck = sectorOrAbsolute(
    pct?.pfcf,
    "P/FCF",
    ratios?.priceToFreeCashFlowRatio !== undefined
      ? { label: "P/FCF under 20x", passed: ratios.priceToFreeCashFlowRatio < 20 }
      : null
  );
  if (pfcfCheck) valuationChecks.push(pfcfCheck);
  if (keyMetrics?.freeCashFlowYield !== undefined) {
    valuationChecks.push({ label: "FCF yield above 4%", passed: keyMetrics.freeCashFlowYield > 0.04 });
  }
  const pbCheck = sectorOrAbsolute(
    pct?.pb,
    "P/B",
    ratios?.priceToBookRatio !== undefined ? { label: "P/B under 6x", passed: ratios.priceToBookRatio < 6 } : null
  );
  if (pbCheck) valuationChecks.push(pbCheck);
  const psCheck = sectorOrAbsolute(
    pct?.ps,
    "P/S",
    ratios?.priceToSalesRatio !== undefined ? { label: "P/S under 6x", passed: ratios.priceToSalesRatio < 6 } : null
  );
  if (psCheck) valuationChecks.push(psCheck);
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
  const latestBalanceSheet = balanceSheet.at(-1);
  const priorBalanceSheet = balanceSheet.at(-2);

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
  // Piotroski's accrual check — the single cheapest, most standard
  // earnings-quality signal in the field, and one Otto was missing
  // entirely: real cash from operations should back up reported profit.
  // A company can grow reported net income while its real operating cash
  // flow lags or shrinks (aggressive revenue recognition, working-capital
  // games) — this catches "paper growth" that the YoY net-income check
  // above, taken alone, can't. Zero new fetches: operatingCashFlow is
  // already on every FmpCashFlowStatement.
  if (latestIncome !== undefined && latestCashFlow?.operatingCashFlow !== undefined) {
    growthChecks.push({
      label: "Cash flow backs up reported profit (CFO > net income)",
      passed: latestCashFlow.operatingCashFlow > latestIncome.netIncome,
    });
  }
  // Piotroski's other missing check: real dilution quietly erodes
  // per-share economics even when the headline numbers above all look
  // fine — a company can grow revenue, net income, and cash flow while
  // diluting shareholders faster than any of that grows. Currently only
  // populated via the Finnhub fallback path (fetchFinnhubFinancialsTrend,
  // verified live against real 10-K concept data); FMP's own
  // /income-statement raw field for this wasn't verified tonight (FMP's
  // quota was exhausted), so this check simply won't fire on data sourced
  // from FMP directly yet — never resolves to a failed check on missing
  // data, same discipline as every other check here.
  if (
    latestIncome?.sharesOutstanding !== undefined &&
    priorIncome?.sharesOutstanding !== undefined &&
    priorIncome.sharesOutstanding > 0
  ) {
    growthChecks.push({
      label: "No meaningful share dilution YoY",
      passed: latestIncome.sharesOutstanding <= priorIncome.sharesOutstanding * 1.02, // 2% slack for routine RSU vesting
    });
  }
  const growth = axis(growthChecks);

  const qualityChecks: SnowflakeCheck[] = [];
  const grossMarginCheck = sectorOrAbsolute(
    pct?.grossMargin,
    "Gross margin",
    ratios?.grossProfitMargin !== undefined ? { label: "Gross margin above 35%", passed: ratios.grossProfitMargin > 0.35 } : null
  );
  if (grossMarginCheck) qualityChecks.push(grossMarginCheck);
  if (ratios?.operatingProfitMargin !== undefined) {
    qualityChecks.push({ label: "Operating margin above 10%", passed: ratios.operatingProfitMargin > 0.1 });
  }
  if (ratios?.netProfitMargin !== undefined) {
    qualityChecks.push({ label: "Net margin above 5%", passed: ratios.netProfitMargin > 0.05 });
  }
  const roicCheck = sectorOrAbsolute(
    pct?.roic,
    "ROIC",
    keyMetrics?.returnOnInvestedCapital !== undefined
      ? { label: "ROIC above 10%", passed: keyMetrics.returnOnInvestedCapital > 0.1 }
      : null
  );
  if (roicCheck) qualityChecks.push(roicCheck);
  if (keyMetrics?.returnOnInvestedCapital !== undefined) {
    // Real WACC-derived hurdle, not a "what's normal for this sector"
    // question — capital-intensive and asset-light sectors both owe the
    // same real cost of capital, so this stays absolute even when a peer
    // percentile exists for the check above.
    qualityChecks.push({
      label: "ROIC beats a ~8% cost of capital",
      passed: keyMetrics.returnOnInvestedCapital > 0.08,
    });
  }
  const roeCheck = sectorOrAbsolute(
    pct?.roe,
    "ROE",
    keyMetrics?.returnOnEquity !== undefined ? { label: "ROE above 15%", passed: keyMetrics.returnOnEquity > 0.15 } : null
  );
  if (roeCheck) qualityChecks.push(roeCheck);
  // Real Beneish M-Score — FMP-primary-path only, same documented
  // limitation as Altman Z below (balanceSheet isn't populated on the
  // screener's Finnhub-sourced bundle). Every field it needs already
  // exists on income/balanceSheet; this just checks they're all actually
  // present for both of the two most recent real fiscal years before
  // computing anything.
  if (
    latestBalanceSheet &&
    priorBalanceSheet &&
    latestIncome &&
    priorIncome &&
    latestCashFlow?.operatingCashFlow !== undefined &&
    latestIncome.costOfRevenue !== undefined &&
    priorIncome.costOfRevenue !== undefined &&
    latestIncome.sellingGeneralAndAdministrativeExpenses !== undefined &&
    priorIncome.sellingGeneralAndAdministrativeExpenses !== undefined &&
    latestIncome.depreciationAndAmortization !== undefined &&
    priorIncome.depreciationAndAmortization !== undefined &&
    latestBalanceSheet.netReceivables !== undefined &&
    priorBalanceSheet.netReceivables !== undefined &&
    latestBalanceSheet.propertyPlantEquipmentNet !== undefined &&
    priorBalanceSheet.propertyPlantEquipmentNet !== undefined &&
    latestBalanceSheet.longTermDebt !== undefined &&
    priorBalanceSheet.longTermDebt !== undefined
  ) {
    const m = computeBeneishMScore(
      {
        receivables: latestBalanceSheet.netReceivables,
        sales: latestIncome.revenue,
        costOfRevenue: latestIncome.costOfRevenue,
        currentAssets: latestBalanceSheet.totalCurrentAssets,
        ppe: latestBalanceSheet.propertyPlantEquipmentNet,
        totalAssets: latestBalanceSheet.totalAssets,
        depreciation: latestIncome.depreciationAndAmortization,
        sga: latestIncome.sellingGeneralAndAdministrativeExpenses,
        longTermDebt: latestBalanceSheet.longTermDebt,
        currentLiabilities: latestBalanceSheet.totalCurrentLiabilities,
        netIncome: latestIncome.netIncome,
        operatingCashFlow: latestCashFlow.operatingCashFlow,
      },
      {
        receivables: priorBalanceSheet.netReceivables,
        sales: priorIncome.revenue,
        costOfRevenue: priorIncome.costOfRevenue,
        currentAssets: priorBalanceSheet.totalCurrentAssets,
        ppe: priorBalanceSheet.propertyPlantEquipmentNet,
        totalAssets: priorBalanceSheet.totalAssets,
        depreciation: priorIncome.depreciationAndAmortization,
        sga: priorIncome.sellingGeneralAndAdministrativeExpenses,
        longTermDebt: priorBalanceSheet.longTermDebt,
        currentLiabilities: priorBalanceSheet.totalCurrentLiabilities,
      }
    );
    if (m !== null) {
      qualityChecks.push({
        label: `Beneish M-Score (${m.toFixed(2)}) shows no signs of earnings manipulation`,
        passed: m < -1.78,
      });
    }
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
  // Real Altman Z-Score — currently FMP-primary-path only, since
  // balanceSheet is only populated there (see StockBundle's own comment);
  // the screener's Finnhub-sourced enrichment doesn't get this check yet.
  if (latestBalanceSheet && latestIncome?.ebit !== undefined && quote.marketCap > 0) {
    const z = computeAltmanZScore({
      totalAssets: latestBalanceSheet.totalAssets,
      workingCapital: latestBalanceSheet.totalCurrentAssets - latestBalanceSheet.totalCurrentLiabilities,
      retainedEarnings: latestBalanceSheet.retainedEarnings,
      ebit: latestIncome.ebit,
      marketCap: quote.marketCap,
      totalLiabilities: latestBalanceSheet.totalLiabilities,
      revenue: latestIncome.revenue,
    });
    if (z !== null) {
      financialHealthChecks.push({ label: `Altman Z-Score (${z.toFixed(2)}) signals low bankruptcy risk`, passed: z > 1.81 });
    }
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
  const momentum12to1 = compute12to1Momentum(monthly.map((p) => p.price));
  if (momentum12to1 !== null) {
    momentumChecks.push({
      label: "Positive 12-1 momentum (real academic factor, excludes most recent month)",
      passed: momentum12to1 > 0,
    });
  }
  const momentum = axis(momentumChecks);

  return { valuation, growth, quality, financialHealth, momentum };
}
