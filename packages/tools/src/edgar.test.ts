import assert from "node:assert/strict";
import { test } from "node:test";
import { annualFrame, canonicalAnnual, type CanonicalRow } from "./edgar.ts";

test("annualFrame labels a period by the calendar year holding most of it", () => {
  assert.equal(annualFrame("2018-09-29"), "CY2018");
  assert.equal(annualFrame("2019-01-31"), "CY2018");
  assert.equal(annualFrame("2017-05-31"), "CY2016");
  assert.equal(annualFrame("2018-12-31"), "CY2018");
});

test("canonicalAnnual keeps the last filed annual value per cik and period", () => {
  const base = {
    sic_division: "Manufacturing",
    cik: "0000320193",
    period_start: "2017-10-01",
    period_end: "2018-09-29",
    period_frame: null,
    value_usd: 100,
    filed_date: "2018-11-05",
  } satisfies CanonicalRow;
  const rows: CanonicalRow[] = [
    base,
    { ...base, value_usd: 110, filed_date: "2019-11-05" },
    { ...base, value_usd: 120, filed_date: "2018-01-01" },
    {
      ...base,
      sic_division: "Services",
      cik: "0000051143",
      period_start: "2018-01-01",
      period_end: "2018-03-31",
      value_usd: 55,
      filed_date: "2018-05-01",
    },
  ];
  const result = canonicalAnnual(rows);
  assert.deepEqual(result.rows, [["Manufacturing", "CY2018", 110]]);
  assert.equal(result.byCik.get("0000320193")?.get("CY2018"), 110);
  assert.equal(result.byCik.has("0000051143"), false, "quarterly rows are excluded");
});

test("canonicalAnnual prefers the SEC frame tag when present", () => {
  const rows: CanonicalRow[] = [
    {
      sic_division: "Services",
      cik: "0001341439",
      period_start: "2016-06-01",
      period_end: "2017-05-31",
      period_frame: "CY2016",
      value_usd: 37792,
      filed_date: "2019-06-21",
    },
  ];
  assert.deepEqual(canonicalAnnual(rows).rows, [["Services", "CY2016", 37792]]);
});
