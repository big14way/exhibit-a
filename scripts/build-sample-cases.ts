#!/usr/bin/env npx tsx
/**
 * Build the committed sample cases under fixtures/cases/sample from the
 * labelled cassette: a cold case that is investigated, operator-approved and
 * written back (CLOSED), then a warm case whose H-MEM recall finds it through
 * the recorded Nemotron embeddings. Both are SAMPLE_MODE replays and are
 * labelled as such in every exhibit.
 *
 * Usage: npm run fixture:cases
 */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../apps/cli/src/env.ts";
import { loadCassette, type CaseState } from "@exhibit-a/core";
import { METRICS, createRuntime, repairContractSecret, type MetricSpec } from "@exhibit-a/tools";
import { approveWriteback, runInvestigation, runWriteback } from "@exhibit-a/agents";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "fixtures/cases/sample");

loadEnv(ROOT);
process.env.EXHIBIT_A_QUIET = "1";
process.env.SAMPLE_MODE = "true";

function makeState(id: string, spec: MetricSpec, cassetteId: string, recordedAt: string): CaseState {
  return {
    id,
    reported_at: new Date().toISOString(),
    question: spec.sampleQuestion,
    metric: spec.view,
    stage: "REPORTED",
    sample_mode: true,
    cassette_id: cassetteId,
    cassette_recorded_at: recordedAt,
    exhibits: [],
    hypotheses: [],
  };
}

const roots: string[] = [];
try {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  for (const spec of METRICS) {
    // One log directory per metric: each metric's warm case recalls its own
    // closed case, exactly as the recorded embeddings were captured.
    const root = mkdtempSync(resolve(tmpdir(), "exhibit-a-sample-cases-"));
    roots.push(root);
    const persist = (state: CaseState): void => {
      mkdirSync(join(root, "logs", state.id), { recursive: true });
      writeFileSync(join(root, "logs", state.id, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    };
    const cassette = loadCassette(resolve(ROOT, spec.paths.cassette));
    const viewSql = readFileSync(resolve(ROOT, spec.paths.viewSql), "utf8").trim();
    const suffix = spec.view.split(".").pop()?.replace(/^sector_/, "").replace(/_by_year$/, "") ?? "metric";
    const coldId = `case_sample_${suffix}_closed`;
    const cold = await runInvestigation({
      root,
      state: makeState(coldId, spec, cassette.id, cassette.recorded_at),
      rt: createRuntime({ root, caseId: coldId, sampleMode: true, cassette }),
      viewSql,
      grain: "fiscal_year",
    });
    let closedState = cold;
    if (cold.stage === "SHADOW_VERIFIED") {
      const approved = approveWriteback({
        root,
        state: cold,
        secret: repairContractSecret(true),
        sampleMode: true,
        approvedBy: "operator:cli",
      });
      const closed = await runWriteback({
        root,
        state: approved,
        rt: createRuntime({ root, caseId: coldId, sampleMode: true, cassette }),
      });
      closedState = closed.state;
    }
    persist(closedState);
    console.log(`${coldId}: ${closedState.stage}, ${closedState.exhibits.length} exhibits, ${closedState.verdict?.kind}`);

    const warmId = `case_sample_${suffix}_warm`;
    const warm = await runInvestigation({
      root,
      state: makeState(warmId, spec, cassette.id, cassette.recorded_at),
      rt: createRuntime({ root, caseId: warmId, sampleMode: true, cassette }),
      viewSql,
      grain: "fiscal_year",
    });
    persist(warm);
    console.log(
      `${warmId}: ${warm.stage}, ${warm.exhibits.length} exhibits, ` +
        `recall ${warm.memory?.hits.length} hit(s) via ${warm.memory?.scoring} (${warm.memory?.embedding?.status})`,
    );
    for (const id of [coldId, warmId]) cpSync(join(root, "logs", id), join(OUT, id), { recursive: true });
  }
  console.log(`wrote ${OUT}`);
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
