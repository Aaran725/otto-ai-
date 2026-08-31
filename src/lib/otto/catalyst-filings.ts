import { fetchCikForSymbol } from "./sec-universe";
import { withinSecEdgarBudget } from "./rate-limit";
import type { CatalystEvent } from "./catalyst-bus";

const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? "Otto AI research@ottoai.app";

// Real, structured 8-K item codes worth a genuine flag — excludes routine
// ones that fire constantly and don't represent a real change in the
// business (2.02 earnings results — already has its own callout via
// EarningsRecord; 9.01 exhibits and 7.01 Reg FD — near-always boilerplate
// riding along with another item, not news on their own).
const MATERIAL_ITEM_LABELS: Record<string, string> = {
  "1.01": "New material agreement filed",
  "1.03": "Bankruptcy or receivership",
  "2.01": "Acquisition or disposition completed",
  "2.04": "Triggering event under a financial obligation",
  "2.05": "Exit or disposal costs",
  "2.06": "Material impairment",
  "3.01": "Delisting or failure to meet listing requirements",
  "4.01": "Change in auditor",
  "5.02": "Officer or director change",
};

const LOOKBACK_DAYS = 2; // this runs daily — only genuinely fresh filings matter

interface SecSubmissionsResponse {
  filings?: {
    recent?: {
      form: string[];
      items?: string[]; // parallel to `form`, comma-joined item codes, e.g. "2.02,9.01"
      filingDate: string[];
      accessionNumber: string[];
      primaryDocument: string[];
    };
  };
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Real, structured 8-K item codes — SEC's own filing index already tags
 * each 8-K with which items it covers, so this never has to parse or
 * interpret filing text: no LLM guessing at deal terms, just a real,
 * dated, linked-out flag the moment a genuinely material event gets
 * filed. Deliberately NOT full merger-arb (no deal price/terms
 * extraction) — that stays out of scope; this is the honest, structured
 * slice of it.
 */
export async function detectMaterialFilings(symbol: string): Promise<CatalystEvent[]> {
  if (!(await withinSecEdgarBudget())) return [];
  const cik = await fetchCikForSymbol(symbol);
  if (!cik) return [];

  const data = await fetchJson<SecSubmissionsResponse>(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const recent = data?.filings?.recent;
  if (!recent?.items) return [];

  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const events: CatalystEvent[] = [];

  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] !== "8-K") continue;
    if (new Date(recent.filingDate[i]).getTime() < cutoff) continue;

    const itemCodes = (recent.items[i] ?? "").split(",").map((s) => s.trim());
    const matched = itemCodes.filter((code) => MATERIAL_ITEM_LABELS[code]);
    if (matched.length === 0) continue;

    const accession = recent.accessionNumber[i].replace(/-/g, "");
    events.push({
      symbol,
      type: "material_filing",
      detail: matched.map((code) => MATERIAL_ITEM_LABELS[code]).join("; "),
      detectedAt: new Date(recent.filingDate[i]).toISOString(),
      sourceUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/${recent.primaryDocument[i]}`,
    });
  }

  return events;
}
