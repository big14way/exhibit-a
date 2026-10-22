import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asSqlResult,
  createExhibit,
  type BaselineComparison,
  type Exhibit,
  type SqlResult,
} from "@exhibit-a/core";
import type { CanonicalSeries } from "./canonical.ts";
import type { CounterfactualResult } from "./counterfactual.ts";
import { canonicalAnnual, type CanonicalRow } from "./edgar.ts";
import type { SecFramesResult } from "./second-channel.ts";
import { verifyRepair, type VerifierInput } from "./verifier.ts";

const CIK = "0000320193";

const canonicalRows: CanonicalRow[] = [
  {
    sic_division: "Manufacturing",
    cik: CIK,
    period_start: "2017-01-01",
    period_end: "2017-12-31",
    period_frame: "CY2017",
    value_usd: 100,
    filed_date: "2018-02-01",
  },
  {
    sic_division: "Manufacturing",
    cik: CIK,
    period_start: "2017-01-01",
    period_end: "2017-12-31",
    period_frame: "CY2017",
    value_usd: 100,
    filed_date: "2019-02-01",
  },
  {
    sic_division: "Manufacturing",
    cik: CIK,
    period_start: "2018-01-01",
    period_end: "2018-12-31",
    period_frame: "CY2018",
    value_usd: 110,
    filed_date: "2019-02-01",
  },
];

function canonicalFactsResult(): SqlResult {
  return asSqlResult(
    ["sic_division", "cik", "period_start", "period_end", "period_frame", "value_usd", "filed_date"],
    canonicalRows.map((row) => [
      row.sic_division,
      row.cik,
      row.period_start,
      row.period_end,
      row.period_frame,
      row.value_usd,
      row.filed_date,
    ]),
  );
}

function series(): CanonicalSeries {
  const value = canonicalAnnual(canonicalRows);
  return { columns: value.columns, rows: value.rows, byCik: value.byCik };
}

function history(): SqlResult {
  return asSqlResult(
    ["sic_division", "fiscal_year", "revenue_usd"],
    [
      ["Manufacturing", 2017, 200],
      ["Manufacturing", 2018, 220],
    ],
  );
}

function shadow(rows: unknown[][] = [["Manufacturing", 2017, 100], ["Manufacturing", 2018, 110]]): SqlResult {
  return asSqlResult(["sic_division", "fiscal_year", "revenue_usd"], rows);
}

function frame(period: string, value: number): SecFramesResult {
  return {
    frame: period,
    concept: "Revenues",
    unit: "USD",
    source_url: "",
    count: 1,
    rows: [{ cik: CIK, entity_name: "Apple Inc.", value_usd: value }],
  };
}

function exhibit(result: SqlResult, title: string): Exhibit {
  return createExhibit({
    kind: "test",
    source: "test",
    transport: "code",
    title,
    result,
    case_id: "case_verifier",
    agent: "Verifier",
  });
}

const baseline: BaselineComparison = {
  metric: "m",
  grain: "fiscal_year",
  band: { lo: 0.67, hi: 1.5 },
  onset: {
    segment: "Manufacturing",
    period: 2018,
    prior_period: 2017,
    value: 220,
    prior_value: 200,
    ratio: 1.1,
    delta: 20,
  },
  segments: 1,
  periods: 2,
  explanation: "test onset",
};

const counterfactual: CounterfactualResult = {
  metric: "m",
  segment: "Manufacturing",
  prior_period: 2017,
  onset_period: 2018,
  naive_delta: 20,
  corrected_prior: 100,
  corrected_now: 110,
  corrected_delta: 10,
  explained_share: 0.5,
  unexplained_share: 0.5,
  rule: "test",
};

function input(overrides: Partial<VerifierInput> = {}): VerifierInput {
  const historyResult = history();
  const facts = canonicalFactsResult();
  return {
    metric: "m",
    shadowMetric: "exhibit_a_shadow.sector_revenue_by_year",
    correctedMetric: "exhibit_a.sector_revenue_by_year_v2",
    correctedSql: "SELECT 1",
    contractId: "contract_test",
    contractOk: true,
    baseline,
    counterfactual,
    originalHistory: { exhibit: exhibit(historyResult, "history"), result: historyResult },
    historyReread: { exhibit: exhibit(historyResult, "history reread"), result: historyResult },
    canonicalFacts: { exhibit: exhibit(facts, "facts"), result: facts },
    canonicalSeries: series(),
    shadow: { exhibit: exhibit(shadow(), "shadow"), result: shadow() },
    frames: [
      { period: "CY2017", result: frame("CY2017", 100) },
      { period: "CY2018", result: frame("CY2018", 110) },
    ],
    ...overrides,
  };
}

function invariant(result: ReturnType<typeof verifyRepair>, name: string) {
  return result.invariants.find((row) => row.name === name);
}

test("the verifier accepts a deduplicated shadow with second-channel parity", () => {
  const result = verifyRepair(input());
  assert.equal(result.ok, true);
  assert.equal(result.invariants.length, 7);
  assert.equal(result.corrected_delta, 10);
  assert.equal(result.corrected_ratio, 1.1);
  assert.equal(invariant(result, "row_preservation")?.ok, true);
  assert.equal(invariant(result, "uniqueness")?.ok, true);
  assert.equal(invariant(result, "second_channel_parity")?.ok, true);
  assert.equal(invariant(result, "bad_repair_rejected")?.ok, true);
  assert.equal(invariant(result, "second_channel_parity")?.numbers?.checked, 2);
});

test("the verifier rejects a repair that silently drops a segment", () => {
  const dropped = shadow([["Manufacturing", 2017, 100]]);
  const result = verifyRepair(input({ shadow: { exhibit: exhibit(dropped, "dropped"), result: dropped } }));
  assert.equal(result.ok, false);
  assert.equal(invariant(result, "row_preservation")?.ok, false);
});

test("the verifier rejects duplicate shadow cells", () => {
  const duplicated = shadow([
    ["Manufacturing", 2017, 100],
    ["Manufacturing", 2018, 110],
    ["Manufacturing", 2018, 110],
  ]);
  const result = verifyRepair(input({ shadow: { exhibit: exhibit(duplicated, "duplicated"), result: duplicated } }));
  assert.equal(result.ok, false);
  assert.equal(invariant(result, "uniqueness")?.ok, false);
});

test("the verifier rejects a shadow outside the signed contract and a changed original", () => {
  const changed = asSqlResult(
    ["sic_division", "fiscal_year", "revenue_usd"],
    [["Manufacturing", 2017, 999], ["Manufacturing", 2018, 220]],
  );
  const result = verifyRepair(
    input({
      contractOk: false,
      historyReread: { exhibit: exhibit(changed, "changed"), result: changed },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(invariant(result, "shadow_contract")?.ok, false);
  assert.equal(invariant(result, "history_immutability")?.ok, false);
});
