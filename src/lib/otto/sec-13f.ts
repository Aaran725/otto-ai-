import { getUniverseCache } from "./cache";

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

/** Pure regex parse of a real 13F information-table XML — the same
 * lightweight-regex-over-known-tags approach already used elsewhere in
 * this codebase (e.g. sec-universe.ts's CIK atom-feed parsing) rather
 * than pulling in a full XML parser dependency for one document shape.
 * Aggregates shares by normalized issuer name, since a single manager's
 * filing often splits one real position across several infoTable rows
 * (sub-manager/otherManager entries) that need summing, not just reading. */
export function parseInfoTable(xml: string): Map<string, number> {
  const holdings = new Map<string, number>();
  const rows = xml.matchAll(/<infoTable>([\s\S]*?)<\/infoTable>/g);
  for (const row of rows) {
    const block = row[1];
    const nameMatch = block.match(/<nameOfIssuer>([^<]*)<\/nameOfIssuer>/);
    const sharesMatch = block.match(/<sshPrnamt>([^<]*)<\/sshPrnamt>/);
    if (!nameMatch || !sharesMatch) continue;
    const shares = Number(sharesMatch[1]);
    if (Number.isNaN(shares)) continue;
    const key = normalizeIssuerName(nameMatch[1]);
    if (!key) continue;
    holdings.set(key, (holdings.get(key) ?? 0) + shares);
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
async function fetchInfoTableForFiling(cik: string, accessionNumber: string): Promise<Map<string, number> | null> {
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
  holdings: Map<string, { shares: number; priorShares: number }>;
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

    const holdings = new Map<string, { shares: number; priorShares: number }>();
    for (const [issuer, shares] of latest) {
      holdings.set(issuer, { shares, priorShares: prior?.get(issuer) ?? 0 });
    }
    return { managerName: manager.name, latestFilingDate: filings[0].filingDate, holdings };
  });
}

export interface InstitutionalConvergence {
  increasedCount: number;
  totalManagersChecked: number;
  managerNames: string[]; // the real managers that increased this specific position
  asOfFilingDate: string; // the most recent real filing date behind this read — always dated, never implied live
}

/**
 * Real convergence check for one company: how many of the curated,
 * independent managers each increased their own position in it, per
 * their own most recent real 13F-HR filing. Never a "fund X bought it"
 * signal — only ever a count of real, independent agreement. Returns
 * null when zero managers hold or increased a position (the common case
 * — most stocks aren't held by any of these 8, which is "not applicable,"
 * not a bad sign).
 */
export async function fetchInstitutionalConvergence(companyName: string): Promise<InstitutionalConvergence | null> {
  const target = normalizeIssuerName(companyName);
  if (!target) return null;

  const results = await Promise.all(CURATED_MANAGERS.map((m) => fetchManagerPositionChanges(m).catch(() => null)));

  const managerNames: string[] = [];
  let latestFilingDate = "";
  for (const result of results) {
    if (!result) continue;
    const position = result.holdings.get(target);
    if (position && position.shares > position.priorShares) {
      managerNames.push(result.managerName);
      if (result.latestFilingDate > latestFilingDate) latestFilingDate = result.latestFilingDate;
    }
  }
  if (managerNames.length === 0) return null;

  return {
    increasedCount: managerNames.length,
    totalManagersChecked: CURATED_MANAGERS.length,
    managerNames,
    asOfFilingDate: latestFilingDate,
  };
}
