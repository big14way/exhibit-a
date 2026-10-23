import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCassette, type CaseState } from "@exhibit-a/core";
import { createRuntime, rerunExhibit } from "@exhibit-a/tools";
import { runInvestigation } from "./lead.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CASSETTE = resolve(ROOT, "fixtures/cassettes/d2-edgar-investigation.json");
const VIEW_SQL = readFileSync(resolve(ROOT, "analytics/sector_revenue_by_year.sql"), "utf8").trim();

process.env.EXHIBIT_A_QUIET = "1";

function makeState(caseId: string): CaseState {
  return {
    id: caseId,
    reported_at: new Date().toISOString(),
    question: "is the FY2018 jump real?",
    metric: "analytics.sector_revenue_by_year",
    stage: "REPORTED",
    sample_mode: true,
    exhibits: [],
    hypotheses: [],
  };
}

test("the D2 sample path reaches a hypothesis table with exhibits", async () => {
  const root = mkdtempSync(join(tmpdir(), "exhibit-a-lead-"));
  const caseId = "case_d2_test";
  try {
    const cassette = loadCassette(CASSETTE);
    const state = await runInvestigation({
      root,
      state: makeState(caseId),
      rt: createRuntime({ root, caseId, sampleMode: true, cassette }),
      viewSql: VIEW_SQL,
      grain: "fiscal_year",
    });

    assert.equal(state.stage, "SHADOW_VERIFIED");
    assert.equal(state.exhibits.length, 23);
    assert.ok(state.exhibits.every((ex) => ex.case_id === caseId));
    assert.ok(state.exhibits.every((ex) => ex.transport === "cassette" || ex.transport === "code"));
    assert.equal(state.memory?.cold_start, true);
    assert.equal(state.discovery?.replacement_concept, "RevenueFromContractWithCustomerExcludingAssessedTax");
    assert.equal(state.critic?.status, "ran");
    assert.equal(state.critic?.objections.length, 5);
    assert.equal(state.critic?.cited_unknown.length, 0);
    assert.equal(state.safety?.ok, true);
    assert.equal(
      state.exhibits.filter((ex) => ["memory_recall", "discover_sources", "critic", "safety"].includes(ex.tool ?? "")).length,
      4,
    );
    assert.ok(state.repair);
    assert.ok(state.contract);
    assert.equal(state.contract.approved, false);
    assert.equal(state.verification?.ok, true);
    assert.equal(state.verification?.invariants.length, 7);
    assert.equal(
      state.verification?.invariants.find((row) => row.name === "second_channel_parity")?.numbers?.checked,
      12,
    );

    const byCause = new Map(state.hypotheses.map((row) => [row.cause, row]));
    assert.equal(byCause.get("filing_year_duplication")?.status, "confirmed");
    assert.equal(byCause.get("concept_switch_missing_history")?.status, "confirmed");
    assert.equal(byCause.get("real_change")?.status, "confirmed");
    assert.equal(byCause.get("tesla_short_history")?.status, "eliminated");
    assert.equal(byCause.get("ingestion_gap")?.status, "eliminated");

    const real = byCause.get("real_change");
    assert.ok(real?.share !== undefined && Math.abs(real.share - 0.0383) < 0.002);
    assert.match(real?.note ?? "", /SEC frames parity 12\/12/);

    assert.equal(state.baseline?.onset?.segment, "Manufacturing");
    assert.equal(state.baseline?.onset?.period, 2018);

    const verdict = state.verdict;
    assert.ok(verdict);
    assert.equal(verdict.kind, "MIXED");
    assert.equal(verdict.gate_failures, undefined);
    assert.equal(verdict.causes.length, 2);
    const artifact = verdict.causes.find((row) => row.cause === "filing_year_duplication");
    const realCause = verdict.causes.find((row) => row.cause === "real_change");
    assert.ok(Math.abs((artifact?.share ?? 0) - 0.96168) < 0.0001);
    assert.ok(Math.abs((realCause?.share ?? 0) - 0.03832) < 0.0001);
    assert.equal(verdict.unexplained_share, 0);
    assert.ok(state.exhibits.some((exhibit) => exhibit.tool === "counterfactual"));

    // Every hypothesis cites exhibits that are on file.
    const ids = new Set(state.exhibits.map((ex) => ex.id));
    for (const hypothesis of state.hypotheses) {
      assert.ok(hypothesis.exhibit_ids.length > 0);
      for (const id of hypothesis.exhibit_ids) assert.ok(ids.has(id), `missing ${id}`);
    }

    // Re-run every exhibit through its recorded tool.
    for (const exhibit of state.exhibits) {
      const rerun = await rerunExhibit(
        createRuntime({ root, caseId, sampleMode: true, cassette }),
        exhibit,
      );
      assert.equal(rerun.same, true, `drift for ${exhibit.tool} ${exhibit.id}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cassette miss fails loudly instead of fabricating evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "exhibit-a-lead-miss-"));
  try {
    const empty = { id: "empty", recorded_at: "2026-10-22", label: "empty", entries: [] };
    await assert.rejects(
      runInvestigation({
        root,
        state: makeState("case_miss"),
        rt: createRuntime({ root, caseId: "case_miss", sampleMode: true, cassette: empty }),
        viewSql: VIEW_SQL,
      }),
      /cassette miss/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
