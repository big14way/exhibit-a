import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeViewDeclaration, parseLineageSources } from "./lineage.ts";

test("normalizeViewDeclaration extracts the live query and qualifies the SIC table", () => {
  const fixture =
    "CREATE OR REPLACE SCHEMASTORE VIEW analytics.sector_revenue_by_year AS\nSELECT f.cik FROM edgar.ford_revenue_table f LEFT JOIN sic_edgar_usl s ON s.cik = f.cik;";
  const normalized = normalizeViewDeclaration(fixture);
  assert.ok(normalized.startsWith("SELECT f.cik"));
  assert.match(normalized, /JOIN edgar\.sic_edgar_usl s/);
  assert.doesNotMatch(normalized, /CREATE/);
});

test("normalizeViewDeclaration leaves a SELECT and an already-qualified table alone", () => {
  const live =
    "SELECT f.cik FROM edgar.ford_revenue_table f LEFT JOIN edgar.sic_edgar_usl s ON s.cik = f.cik;";
  assert.equal(normalizeViewDeclaration(live), live);
});

test("parseLineageSources accepts the live INFER datasource/alias shape", () => {
  const sources = parseLineageSources({
    columns: ["datasource", "alias"],
    rows: [["SEC_DATA.apple_revenue_facts", "apple_revenue_facts"]],
    row_count: 1,
    truncated: false,
  });
  assert.deepEqual(sources, [
    { source_table: "SEC_DATA.apple_revenue_facts", source_kind: "table" },
  ]);
});
