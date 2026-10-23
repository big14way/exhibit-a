import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCassette, type CaseState } from "@exhibit-a/core";
import {
  createRuntime,
  repairContractSecret,
  rerunExhibit,
} from "@exhibit-a/tools";
import { runInvestigation } from "./lead.ts";
import { approveWriteback, runWriteback } from "./writeback.ts";

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

async function verifiedCase(root: string, caseId: string): Promise<CaseState> {
  const cassette = loadCassette(CASSETTE);
  return runInvestigation({
    root,
    state: makeState(caseId),
    rt: createRuntime({ root, caseId, sampleMode: true, cassette }),
    viewSql: VIEW_SQL,
    grain: "fiscal_year",
  });
}

test("sample writeback is operator-approved, re-read, memorised, and closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "exhibit-a-writeback-"));
  const caseId = "case_writeback_sample";
  try {
    const state = await verifiedCase(root, caseId);
    assert.equal(state.stage, "SHADOW_VERIFIED");

    const secret = repairContractSecret(true);
    const approved = approveWriteback({
      root,
      state,
      secret,
      sampleMode: true,
    });
    assert.equal(approved.stage, "AWAITING_APPROVAL");
    assert.equal(approved.write_contract?.approved, true);
    assert.equal(approved.write_contract?.statements.length, 7);
    assert.ok(approved.write_contract?.scope.includes("exhibit_a.sector_revenue_by_year_v2"));

    // Re-approval is allowed from AWAITING_APPROVAL after expiry, but only
    // before any writeback result exists.
    const reapproved = approveWriteback({
      root,
      state: approved,
      secret,
      sampleMode: true,
    });
    assert.equal(reapproved.stage, "AWAITING_APPROVAL");
    assert.equal(reapproved.write_contract?.approved, true);
    assert.notEqual(reapproved.write_contract?.id, approved.write_contract?.id);

    const failed: CaseState = {
      ...reapproved,
      stage: "FAILED",
      writeback: {
        ok: false,
        contract_id: reapproved.write_contract!.id,
        written_metric: "exhibit_a.sector_revenue_by_year_v2",
        checks: [
          { name: "usl_model", ok: false, detail: "catalog description missing" },
          { name: "view_catalog", ok: false, detail: "uppercase view name" },
        ],
      },
    };
    const recovered = approveWriteback({
      root,
      state: failed,
      secret,
      sampleMode: true,
    });
    assert.equal(recovered.stage, "AWAITING_APPROVAL");
    assert.equal(recovered.writeback?.ok, false);
    const blocked: CaseState = {
      ...failed,
      writeback: {
        ...failed.writeback!,
        checks: [{ name: "original_untouched", ok: false, detail: "changed" }],
      },
    };
    assert.throws(
      () => approveWriteback({ root, state: blocked, secret, sampleMode: true }),
      /cannot recover failed writeback checks/,
    );

    const run = await runWriteback({
      root,
      state: reapproved,
      rt: createRuntime({
        root,
        caseId,
        sampleMode: true,
        cassette: loadCassette(CASSETTE),
      }),
    });

    assert.equal(run.state.stage, "CLOSED");
    assert.equal(run.state.writeback?.ok, true);
    assert.equal(run.state.writeback?.checks.length, 8);
    assert.equal(
      run.state.writeback?.checks.filter((check) => check.ok).length,
      8,
    );
    assert.equal(run.state.error, undefined);
    assert.equal(run.state.exhibits.length, 33);
    assert.ok(run.state.exhibits.some((exhibit) => exhibit.tool === "write_verified"));
    assert.ok(run.state.exhibits.some((exhibit) => exhibit.tool === "memory"));
    assert.ok(run.state.writeback?.memory_note?.includes(caseId));
    assert.equal(run.state.hmem?.record_id, caseId);
    assert.equal(run.state.hmem?.valid, 1);
    assert.equal(run.state.hmem?.malformed, 0);

    const writebackExhibit = run.state.exhibits.find((exhibit) => exhibit.tool === "writeback");
    assert.ok(writebackExhibit);
    assert.equal(
      (writebackExhibit.result as { executed: boolean }).executed,
      false,
    );
    assert.equal(
      (writebackExhibit.result as { original_view_touched: boolean }).original_view_touched,
      false,
    );

    const rt = createRuntime({
      root,
      caseId,
      sampleMode: true,
      cassette: loadCassette(CASSETTE),
    });
    for (const tool of ["writeback", "write_verified", "memory"]) {
      const exhibit = run.state.exhibits.find((row) => row.tool === tool);
      assert.ok(exhibit, `missing ${tool}`);
      const again = await rerunExhibit(rt, exhibit);
      assert.equal(again.same, true, `drift for ${tool}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approval refuses a case whose shadow verifier failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "exhibit-a-writeback-bad-"));
  const caseId = "case_writeback_bad";
  try {
    const state = await verifiedCase(root, caseId);
    const failed: CaseState = {
      ...state,
      verification: state.verification
        ? { ...state.verification, ok: false }
        : undefined,
    };
    assert.throws(
      () =>
        approveWriteback({
          root,
          state: failed,
          secret: repairContractSecret(true),
          sampleMode: true,
        }),
      /shadow verifier did not pass/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeback refuses an unapproved contract or the wrong stage", async () => {
  const root = mkdtempSync(join(tmpdir(), "exhibit-a-writeback-refuse-"));
  const caseId = "case_writeback_refuse";
  try {
    const state = await verifiedCase(root, caseId);
    const approved = approveWriteback({
      root,
      state,
      secret: repairContractSecret(true),
      sampleMode: true,
    });
    const rt = createRuntime({
      root,
      caseId,
      sampleMode: true,
      cassette: loadCassette(CASSETTE),
    });
    assert.ok(approved.write_contract);
    const unapproved: CaseState = {
      ...approved,
      write_contract: { ...approved.write_contract, approved: false },
    };
    await assert.rejects(
      runWriteback({ root, state: unapproved, rt }),
      /not operator-approved/,
    );
    await assert.rejects(
      runWriteback({ root, state: { ...approved, stage: "SHADOW_VERIFIED" }, rt }),
      /needs AWAITING_APPROVAL/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
