import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asSqlResult,
  verifyContract,
  type CaseState,
  type WriteContract,
} from "@exhibit-a/core";
import {
  assertFinalContract,
  buildFinalWriteContract,
  checkUslModel,
  compareFinalRead,
  verifyWriteback,
} from "./writeback.ts";
import { CORRECTED_METRIC, USL_TABLE_PATH } from "./repair.ts";

const secret = "writeback-test-secret";

function state(): CaseState {
  return {
    id: "case_writeback_test",
    reported_at: "2026-10-22T12:00:00.000Z",
    question: "is the jump real?",
    metric: "analytics.sector_revenue_by_year",
    stage: "SHADOW_VERIFIED",
    sample_mode: true,
    exhibits: [],
    hypotheses: [],
    verdict: {
      kind: "MIXED",
      causes: [
        { cause: "filing_year_duplication", kind: "artifact", share: 0.96168, exhibit_ids: ["ex_1"] },
        { cause: "real_change", kind: "real", share: 0.03832, exhibit_ids: ["ex_2"] },
      ],
      exhibit_ids: ["ex_1", "ex_2"],
    },
    repair: {
      metric: "analytics.sector_revenue_by_year",
      shadow_metric: "exhibit_a_shadow.sector_revenue_by_year",
      corrected_metric: CORRECTED_METRIC,
      corrected_sql: "SELECT 1 AS fiscal_year, 1 AS revenue_usd, 'Manufacturing' AS sic_division",
      statements: [],
      created_at: "2026-10-22T12:00:00.000Z",
    },
    verification: {
      ok: true,
      shadow_metric: "exhibit_a_shadow.sector_revenue_by_year",
      corrected_metric: CORRECTED_METRIC,
      invariants: [],
    },
  };
}

test("the final contract is approved, scoped, and never names the reported view", () => {
  const { contract, note } = buildFinalWriteContract({
    state: state(),
    secret,
    sampleMode: true,
  });
  verifyContract(contract, secret, {
    requireApproved: true,
    scope: CORRECTED_METRIC,
  });
  assert.equal(contract.approved, true);
  assert.equal(contract.approved_by, "operator:cli");
  assert.ok(contract.scope.includes(USL_TABLE_PATH));
  assert.equal(contract.statements.length, 7);
  assert.ok(contract.statements.some((row) => row.includes(CORRECTED_METRIC) || row.includes("sector_revenue_by_year_v2")));
  assert.ok(contract.statements.some((row) => /PRIMARY KEY \(cik, period_end\)/.test(row)));
  assert.ok(contract.statements.some((row) => row.startsWith("ACTIVATE USL TABLE")));
  assert.ok(contract.statements.some((row) => row.startsWith("REGISTER DQ annual_has_frame")));
  assert.ok(contract.statements.some((row) => row.startsWith("UPDATE USL")));
  assert.ok(note.includes("case_writeback_test"));
  assert.ok(!contract.statements.some((row) => /analytics\./i.test(row)));
  assertFinalContract(contract);
});

test("the final contract rejects unapproved or analytics-touching statements", () => {
  const { contract } = buildFinalWriteContract({
    state: state(),
    secret,
    sampleMode: true,
  });
  assert.throws(
    () => assertFinalContract({ ...contract, approved: false }),
    /not operator-approved/,
  );
  const tampered: WriteContract = {
    ...contract,
    statements: [...contract.statements, "DROP TABLE analytics.sector_revenue_by_year"],
  };
  assert.throws(() => assertFinalContract(tampered), /reported analytics view/);
});

test("the final read is compared cell-by-cell to the verified shadow", () => {
  const shadow = asSqlResult(
    ["sic_division", "fiscal_year", "revenue_usd"],
    [
      ["Manufacturing", 2017, 100],
      ["Manufacturing", 2018, 120],
    ],
  );
  const finalRead = asSqlResult(
    ["sic_division", "fiscal_year", "revenue_usd"],
    [
      ["Manufacturing", 2017, 100],
      ["Manufacturing", 2018, 120],
    ],
  );
  assert.equal(compareFinalRead(shadow, finalRead).ok, true);
  const drifted = asSqlResult(
    ["sic_division", "fiscal_year", "revenue_usd"],
    [["Manufacturing", 2017, 100]],
  );
  assert.equal(compareFinalRead(shadow, drifted).ok, false);
});

test("the USL model readback checks the composite key, rule, and catalog note", () => {
  const model = {
    description: "Exhibit A case_writeback_test verdict MIXED",
    tables: [
      {
        name: "fact",
        primaryKey: { columns: ["cik", "period_end"] },
        dqAnnotations: [{ name: "annual_has_frame", expression: "period_frame IS NOT NULL" }],
        activateQuery: "SELECT 1",
      },
    ],
  };
  assert.equal(
    checkUslModel(model, { caseId: "case_writeback_test", note: "" }).ok,
    true,
  );
  assert.equal(
    checkUslModel({ tables: [] }, { caseId: "case_writeback_test", note: "" }).ok,
    false,
  );
});

test("verifyWriteback requires every readback, not just the core view", () => {
  const shadow = asSqlResult(
    ["sic_division", "fiscal_year", "revenue_usd"],
    [["Manufacturing", 2017, 100]],
  );
  const dq = asSqlResult(
    ["name", "table", "type", "total_record", "valid_record", "invalid_record"],
    [["cik,period_end", "fact", "Primary Key Constraint", "1", "1", "0"]],
  );
  const dqList = asSqlResult(
    ["name", "table", "type", "expression"],
    [
      ["cik,period_end", "fact", "Primary key constraints", ""],
      ["annual_has_frame", "fact", "Custom Data Quality", "period_frame IS NOT NULL"],
    ],
  );
  const views = asSqlResult(["name", "type"], [["sector_revenue_by_year_v2", "view"]]);
  const model = {
    description: "Exhibit A case_writeback_test",
    tables: [
      {
        name: "fact",
        primaryKey: { columns: ["cik", "period_end"] },
        dqAnnotations: [{ name: "annual_has_frame" }],
        activateQuery: "SELECT 1",
      },
    ],
  };
  const base = {
    contractId: "contract_test",
    writtenMetric: CORRECTED_METRIC,
    contractOk: true,
    writeExecuted: true,
    caseId: "case_writeback_test",
    note: "Exhibit A case_writeback_test",
    shadow,
    finalRead: shadow,
    originalHistory: shadow,
    originalReread: shadow,
    uslModel: model,
    dqList,
    compositeDq: dq,
    rowDq: dq,
    views,
  };
  const result = verifyWriteback(base);
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 8);
  const missing = verifyWriteback({ ...base, views: undefined });
  assert.equal(missing.ok, false);
  assert.equal(missing.checks.find((row) => row.name === "view_catalog")?.ok, false);
});
