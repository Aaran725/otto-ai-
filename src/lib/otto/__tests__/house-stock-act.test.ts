import { describe, it, expect } from "vitest";
import { parsePtrTransactions } from "../house-stock-act";

// Real text confirmed live via pdf-parse against an actual House PTR PDF
// (disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034201.pdf) —
// not a synthetic fixture. Kept as a trimmed excerpt (2 of the filing's
// real transaction rows) since the full document repeats the same
// boilerplate description block per line.
const REAL_PTR_EXCERPT = `
P        T           R
Clerk of the House of Representatives • Legislative Resource Center • B81 Cannon Building • Washington, DC 20515
F     I
Name: 	Hon. Mark Alford
Status: 	Member
State/District: MO04
T
ID 	Owner Asset 	Transaction
Type
Date 	Notification
Date
Amount 	Cap.
Gains >
$200?
Amazon.com, Inc. - Common Stock
(AMZN) [ST]
S (partial) 	03/16/2026 03/16/2026 $1,001 - $15,000
F      S     : New
Apple Inc. - Common Stock (AAPL)
[ST]
S (partial) 	03/16/2026 03/16/2026 $1,001 - $15,000
F      S     : New
`;

describe("parsePtrTransactions — real House PTR text, confirmed live via pdf-parse", () => {
  it("extracts real ticker, transaction type, and date from a real filing's text", () => {
    const transactions = parsePtrTransactions(REAL_PTR_EXCERPT);
    expect(transactions).toEqual([
      { symbol: "AMZN", transactionType: "sale", transactionDate: "03/16/2026" },
      { symbol: "AAPL", transactionType: "sale", transactionDate: "03/16/2026" },
    ]);
  });

  it("recognizes a real purchase (P) distinctly from a sale", () => {
    const text = `Tesla, Inc. - Common Stock (TSLA) [ST]\nP \t01/05/2026 01/10/2026 $15,001 - $50,000`;
    expect(parsePtrTransactions(text)).toEqual([{ symbol: "TSLA", transactionType: "purchase", transactionDate: "01/05/2026" }]);
  });

  it("skips a real exchange (E) transaction — not a clean buy/sell signal", () => {
    const text = `Some Fund (ABCD) [ST]\nE \t01/05/2026 01/10/2026 $15,001 - $50,000`;
    expect(parsePtrTransactions(text)).toEqual([]);
  });

  it("returns an empty array for text with no matching real transaction rows", () => {
    expect(parsePtrTransactions("No transactions on this page.")).toEqual([]);
  });

  it("handles the ticker-and-type on the same line as the asset name (real variant seen live)", () => {
    const text = `AT&T Inc. (T) [ST] \tS (partial) \t03/16/2026 03/16/2026 $1,001 - $15,000`;
    expect(parsePtrTransactions(text)).toEqual([{ symbol: "T", transactionType: "sale", transactionDate: "03/16/2026" }]);
  });

  it("handles a real share-class ticker with a period (e.g. BRK.B)", () => {
    const text = `Berkshire Hathaway Inc. Common Stock (BRK.B) [ST]\nP \t01/05/2026 01/10/2026 $1,001 - $15,000`;
    expect(parsePtrTransactions(text)).toEqual([{ symbol: "BRK.B", transactionType: "purchase", transactionDate: "01/05/2026" }]);
  });
});
