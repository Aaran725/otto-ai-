import { describe, it, expect } from "vitest";
import { groupSicCodesByFamily } from "../sec-universe";

describe("groupSicCodesByFamily — the real basis for Phase A3's sibling-SIC widening", () => {
  it("groups 4-digit codes by their 3-digit prefix", () => {
    // Real SEC codes, confirmed live: banks split across adjacent 4-digit
    // codes under the same "602" family.
    const families = groupSicCodesByFamily(["6021", "6022", "6029", "7372"]);
    expect(families["602"]).toEqual(["6021", "6022", "6029"]);
    expect(families["737"]).toEqual(["7372"]);
  });

  it("a code with no real siblings ends up alone in its own family", () => {
    const families = groupSicCodesByFamily(["1040"]);
    expect(families["104"]).toEqual(["1040"]);
  });

  it("a bare 3-digit code is its own prefix, not truncated further", () => {
    const families = groupSicCodesByFamily(["100", "200"]);
    expect(families["100"]).toEqual(["100"]);
    expect(families["200"]).toEqual(["200"]);
  });

  it("preserves input order within a family — matters for reproducible peer selection", () => {
    const families = groupSicCodesByFamily(["6029", "6021", "6022"]);
    expect(families["602"]).toEqual(["6029", "6021", "6022"]);
  });
});
