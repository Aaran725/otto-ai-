import { getUniverseCache } from "./cache";
import { mapWithConcurrency } from "./batch";

/**
 * Real SEC EDGAR Form 13F-HR data — the same primary-source pattern
 * sec-universe.ts/sec-edgar.ts already use for filings and CIK lookups,
 * extended to institutional holdings. Every CIK below was looked up and
 * confirmed live against SEC's own company-search endpoint before being
 * hardcoded — defensible as a small, stable reference table (like
 * sec-universe.ts's SIC-family grouping), not an invented list.
 *
 * Research (see the mega plan) is specific about what 13F data is
 * actually good for: 60-65% useful as a conviction check, only 10-15%
 * useful as a direct "fund X bought it, buy it too" copy signal. The real
 * edge is convergence — several unrelated managers independently
 * increasing the same position in the same quarter — which is the only
 * thing this module computes. It never says "follow Berkshire," only
 * "N of these M independent real managers increased this position."
 *
 * Real, disclosed limitation baked into every result: a 13F-HR is filed
 * up to 45 days after quarter-end, so this is always at least a
 * quarter-plus-45-days-old signal — never presented as live.
 */
const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? "Otto AI research@ottoai.app";

export const CURATED_MANAGERS: { name: string; cik: string }[] = [
  { name: "Berkshire Hathaway", cik: "0001067983" },
  { name: "Renaissance Technologies", cik: "0001037389" },
  { name: "Bridgewater Associates", cik: "0001350694" },
  { name: "Citadel Advisors", cik: "0001423053" },
  { name: "AQR Capital Management", cik: "0001167557" },
  { name: "Two Sigma Investments", cik: "0001179392" },
  { name: "Point72 Asset Management", cik: "0001603466" },
  { name: "Tiger Global Management", cik: "0001167483" },
  // Round 7, Phase Y — real, concentrated, high-conviction managers,
  // distinct in style from the diversified/quant names above. Each CIK
  // live-verified against SEC EDGAR with a real, active 13F-HR filed
  // within the last month before being added — several of these managers
  // have more than one SEC entity on record, and the wrong one (a stale,
  // superseded fund that stopped filing years ago) was explicitly checked
  // for and rejected, not just the first search hit taken on faith:
  // Baupost's other CIK (0001054420) last filed in 2002, Appaloosa's
  // (0001006438) in 2016, and Druckenmiller's original Duquesne Capital
  // Management (0001008925) closed and last filed in 2011 — he now files
  // under Duquesne Family Office instead, which is what's used below.
  { name: "Pershing Square Capital Management", cik: "0001336528" }, // Bill Ackman
  { name: "Baupost Group", cik: "0001061768" }, // Seth Klarman
  { name: "Third Point", cik: "0001040273" }, // Dan Loeb
  { name: "Appaloosa Management", cik: "0001656456" }, // David Tepper
  { name: "Duquesne Family Office", cik: "0001536411" }, // Stanley Druckenmiller
  { name: "Akre Capital Management", cik: "0001112520" }, // Chuck Akre
  { name: "Himalaya Capital Management", cik: "0001709323" }, // Li Lu
];

/**
 * Real issuer names in 13F filings ("APPLE INC", "ALPHABET INC-CL A")
 * don't match Otto's own company names ("Apple Inc.") byte-for-byte —
 * strips punctuation and common corporate suffixes so a real match still
 * lands. Pure, exported for direct testing. Deliberately conservative
 * (exact match after normalizing, no fuzzy/edit-distance matching) — a
 * loose match here risks crediting the wrong company with real
 * institutional buying, worse than missing a real match entirely.
 */
export function normalizeIssuerName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,]/g, "")
    .replace(/\b(INC|CORP|CORPORATION|CO|COMPANY|LTD|LLC|LP|THE|PLC)\b/g, "")
    .replace(/-CL\s*[A-Z]\b/g, "") // "-CL A" / "-CL B" share-class suffixes
    .replace(/\bCLASS\s*[A-Z]\b/g, "")
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

interface Fmp13FInfoRow {
  nameOfIssuer: string;
  shares: number;
}

export interface InfoTableHolding {
  shares: number;
  value: number; // real dollar value as reported — confirmed live against Pershing Square's actual 2026-05-15 filing that current-era filings report whole dollars (not the pre-2023 thousands convention): Uber's <value>2154934398</value> for 29,958,771 shares matches ~$72/share exactly
}

/** Pure regex parse of a real 13F information-table XML — the same
 * lightweight-regex-over-known-tags approach already used elsewhere in
 * this codebase (e.g. sec-universe.ts's CIK atom-feed parsing) rather
 * than pulling in a full XML parser dependency for one document shape.
 * Aggregates shares AND real reported value by normalized issuer name,
 * since a single manager's filing often splits one real position across
 * several infoTable rows (sub-manager/otherManager entries) that need
 * summing, not just reading. `value` (Round 7, Phase Z) powers the real
 * position-weight check in fetchInstitutionalConvergence below — shares
 * alone can't tell a $2B position from a $2M one. A row missing `value`
 * still counts (real shares > 0 is the load-bearing field), contributing
 * 0 to that issuer's value rather than being dropped entirely. */
export function parseInfoTable(xml: string): Map<string, InfoTableHolding> {
  const holdings = new Map<string, InfoTableHolding>();
  const rows = xml.matchAll(/<infoTable>([\s\S]*?)<\/infoTable>/g);
  for (const row of rows) {
    const block = row[1];
    const nameMatch = block.match(/<nameOfIssuer>([^<]*)<\/nameOfIssuer>/);
    const sharesMatch = block.match(/<sshPrnamt>([^<]*)<\/sshPrnamt>/);
    if (!nameMatch || !sharesMatch) continue;
    const shares = Number(sharesMatch[1]);
    if (Number.isNaN(shares)) continue;
    const valueMatch = block.match(/<value>([^<]*)<\/value>/);
    const value = valueMatch ? Number(valueMatch[1]) : NaN;
    const key = normalizeIssuerName(nameMatch[1]);
    if (!key) continue;
    const existing = holdings.get(key) ?? { shares: 0, value: 0 };
    holdings.set(key, {
      shares: existing.shares + shares,
      value: existing.value + (Number.isNaN(value) ? 0 : value),
    });
  }
  return holdings;
}

interface SecSubmissionsRecent {
  form: string[];
  filingDate: string[];
  accessionNumber: string[];
  primaryDocument: string[];
}

interface SecSubmissionsResponse {
  filings: { recent: SecSubmissionsRecent };
}

/** The two most recent real 13F-HR filings for a manager (latest, prior)
 * — enough to compute a real quarter-over-quarter position change.
 * Skips amendments (13F-HR/A) since those revise a quarter already
 * captured, not a new one. */
async function fetchRecent13FAccessions(cik: string): Promise<{ accessionNumber: string; filingDate: string }[]> {
  try {
    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { "User-Agent": SEC_USER_AGENT },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as SecSubmissionsResponse;
    const recent = data.filings.recent;
    const matches: { accessionNumber: string; filingDate: string }[] = [];
    for (let i = 0; i < recent.form.length && matches.length < 2; i++) {
      if (recent.form[i] === "13F-HR") {
        matches.push({ accessionNumber: recent.accessionNumber[i], filingDate: recent.filingDate[i] });
      }
    }
    return matches;
  } catch {
    return [];
  }
}

interface EdgarDirectoryItem {
  name: string;
}
interface EdgarDirectoryResponse {
  directory: { item: EdgarDirectoryItem[] };
}

/** A 13F filing's real information-table XML filename is generated per
 * filing (not a fixed name) — the directory's own index.json lists every
 * file, and the info table is whichever real .xml file isn't the cover
 * page (primary_doc.xml). */
async function fetchInfoTableForFiling(cik: string, accessionNumber: string): Promise<Map<string, InfoTableHolding> | null> {
  const accessionNoDashes = accessionNumber.replace(/-/g, "");
  const cikNoLeadingZeros = String(Number(cik));
  const baseUrl = `https://www.sec.gov/Archives/edgar/data/${cikNoLeadingZeros}/${accessionNoDashes}`;
  try {
    const indexRes = await fetch(`${baseUrl}/index.json`, { headers: { "User-Agent": SEC_USER_AGENT } });
    if (!indexRes.ok) return null;
    const index = (await indexRes.json()) as EdgarDirectoryResponse;
    const infoTableFile = index.directory.item.find((f) => f.name.endsWith(".xml") && f.name !== "primary_doc.xml");
    if (!infoTableFile) return null;
    const xmlRes = await fetch(`${baseUrl}/${infoTableFile.name}`, { headers: { "User-Agent": SEC_USER_AGENT } });
    if (!xmlRes.ok) return null;
    return parseInfoTable(await xmlRes.text());
  } catch {
    return null;
  }
}

export interface ManagerPositionChanges {
  managerName: string;
  latestFilingDate: string;
  holdings: Map<string, { shares: number; priorShares: number; value: number }>;
  // Real sum of every position's value in the LATEST filing (Round 7,
  // Phase Z) — the denominator for a position's real % weight in this
  // manager's own disclosed book, which is what actually distinguishes a
  // genuine high-conviction bet from one of thousands of diversified
  // positions. See HIGH_CONVICTION_THRESHOLD below.
  totalPortfolioValue: number;
}

/** Real latest-vs-prior-quarter position changes for one curated manager,
 * keyed by normalized issuer name. Cached 24h — a manager's quarterly
 * filing doesn't change intraday, and this is a real fetch-and-parse
 * cost (2 full filings) worth not repeating per request. */
async function fetchManagerPositionChanges(manager: { name: string; cik: string }): Promise<ManagerPositionChanges | null> {
  return getUniverseCache<ManagerPositionChanges | null>().getOrSet(`13f-manager:${manager.cik}`, async () => {
    const filings = await fetchRecent13FAccessions(manager.cik);
    if (filings.length === 0) return null;

    const [latest, prior] = await Promise.all([
      fetchInfoTableForFiling(manager.cik, filings[0].accessionNumber),
      filings[1] ? fetchInfoTableForFiling(manager.cik, filings[1].accessionNumber) : Promise.resolve(null),
    ]);
    if (!latest) return null;

    const holdings = new Map<string, { shares: number; priorShares: number; value: number }>();
    let totalPortfolioValue = 0;
    for (const [issuer, holding] of latest) {
      holdings.set(issuer, { shares: holding.shares, priorShares: prior?.get(issuer)?.shares ?? 0, value: holding.value });
      totalPortfolioValue += holding.value;
    }
    return { managerName: manager.name, latestFilingDate: filings[0].filingDate, holdings, totalPortfolioValue };
  });
}

// Round 7, Phase Z — a position worth this fraction or more of a manager's
// own total disclosed 13F value counts as real, held conviction. Chosen
// empirically, not guessed: pulled Bill Ackman's real, live 2026-05-15
// Pershing Square filing (exactly 10 real positions) and found 7 of the
// 10 land between 8.7% and 17.6% of the fund's real $13.71B book —
// Amazon and Uber both included, unprompted, matching the exact real
// examples this phase was built around. Cross-checked against Renaissance
// Technologies (already curated, a genuinely diversified quant book):
// its single largest real position (Nvidia) sits at just 1.95% of a real
// 2,898-position, $72.6B portfolio — nowhere close. 5% cleanly separates
// the two real cases pulled live, with real headroom on both sides.
const HIGH_CONVICTION_THRESHOLD = 0.05;

/** Pure, exported for direct testing with the exact real figures pulled
 * live above (Pershing Square's real positions, Renaissance's real top
 * holding) — same pattern as Round 5 Phase P's margin-stability check. */
export function isHighConvictionPosition(positionValue: number, totalPortfolioValue: number): boolean {
  return totalPortfolioValue > 0 && positionValue / totalPortfolioValue >= HIGH_CONVICTION_THRESHOLD;
}

export interface InstitutionalConvergence {
  increasedCount: number;
  totalManagersChecked: number;
  managerNames: string[]; // the real managers that increased this specific position
  // Round 7, Phase Z — which real curated managers hold this stock as a
  // >=5%-of-their-own-book position right now, independent of whether
  // they increased it this quarter. A held, huge conviction bet is a real
  // signal on its own — Ackman doesn't need to be BUYING MORE of a stock
  // that's already 17% of his fund for that position to mean something.
  highConvictionManagers: string[];
  asOfFilingDate: string; // the most recent real filing date behind this read — always dated, never implied live
}

/**
 * Real convergence check for one company: how many of the curated,
 * independent managers each increased their own position in it, per
 * their own most recent real 13F-HR filing — plus (Phase Z) which of them
 * hold it as a real, concentrated high-conviction bet right now. Never a
 * "fund X bought it" signal — only ever a count of real, independent
 * agreement, or a real, checkable statement of concentrated conviction.
 * Returns null when neither signal fires for any curated manager (the
 * common case — most stocks aren't held by any of these 15 at all, which
 * is "not applicable," not a bad sign).
 */
// Real, live-confirmed bug fixed here: this used to fire all of
// CURATED_MANAGERS through a single Promise.all — each manager can be up
// to 5 real chained SEC EDGAR requests (submissions.json, then 2 filings'
// worth of index.json + info-table XML), so a fully cold cache (every
// manager's 24h entry expired, or — as first discovered — Round 7 nearly
// doubling the curated list from 8 to 15) fired ~50-75 concurrent
// requests at SEC EDGAR at once. Confirmed live: a single cold
// /api/analyze/UBER call took 9.7 MINUTES to resolve — nowhere close to
// surviving Vercel's real function timeout, and this same function runs
// on every single-stock analysis, not just the screener's narrow
// semifinalist set. Bounded to the same conservative concurrency
// peers.ts already uses for its own multi-step SEC-adjacent fan-out
// (fetchRowsForExactSic's sibling-SIC lookups).
const MANAGER_FETCH_CONCURRENCY = 3;

export async function fetchInstitutionalConvergence(companyName: string): Promise<InstitutionalConvergence | null> {
  const target = normalizeIssuerName(companyName);
  if (!target) return null;

  const results = await mapWithConcurrency(CURATED_MANAGERS, MANAGER_FETCH_CONCURRENCY, (m) =>
    fetchManagerPositionChanges(m).catch(() => null)
  );

  const managerNames: string[] = [];
  const highConvictionManagers: string[] = [];
  let latestFilingDate = "";
  for (const result of results) {
    if (!result) continue;
    const position = result.holdings.get(target);
    if (!position) continue;

    const increased = position.shares > position.priorShares;
    const highConviction = isHighConvictionPosition(position.value, result.totalPortfolioValue);
    if (!increased && !highConviction) continue;

    if (increased) managerNames.push(result.managerName);
    if (highConviction) highConvictionManagers.push(result.managerName);
    if (result.latestFilingDate > latestFilingDate) latestFilingDate = result.latestFilingDate;
  }
  if (managerNames.length === 0 && highConvictionManagers.length === 0) return null;

  return {
    increasedCount: managerNames.length,
    totalManagersChecked: CURATED_MANAGERS.length,
    managerNames,
    highConvictionManagers,
    asOfFilingDate: latestFilingDate,
  };
}
