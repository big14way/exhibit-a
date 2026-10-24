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
import { createRuntime, repairContractSecret } from "@exhibit-a/tools";
import { approveWriteback, runInvestigation, runWriteback } from "@exhibit-a/agents";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASSETTE = resolve(ROOT, "fixtures/cassettes/d2-edgar-investigation.json");
const OUT = resolve(ROOT, "fixtures/cases/sample");
const VIEW_SQL = readFileSync(resolve(ROOT, "analytics/sector_revenue_by_year.sql"), "utf8").trim();
const QUESTION = "is the FY2018 jump real?";
const METRIC = "analytics.sector_revenue_by_year";

loadEnv(ROOT);
process.env.EXHIBIT_A_QUIET = "1";
process.env.SAMPLE_MODE = "true";

function makeState(id: string, cassetteId: string, recordedAt: string): CaseState {
  return {
    id,
    reported_at: new Date().toISOString(),
    question: QUESTION,
    metric: METRIC,
    stage: "REPORTED",
    sample_mode: true,
    cassette_id: cassetteId,
    cassette_recorded_at: recordedAt,
    exhibits: [],
    hypotheses: [],
  };
}

const root = mkdtempSync(resolve(tmpdir(), "exhibit-a-sample-cases-"));
try {
  const cassette = loadCassette(CASSETTE);
  const persist = (state: CaseState): void => {
    mkdirSync(join(root, "logs", state.id), { recursive: true });
    writeFileSync(join(root, "logs", state.id, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  };

  const coldId = "case_sample_closed";
  const cold = await runInvestigation({
    root,
    state: makeState(coldId, cassette.id, cassette.recorded_at),
    rt: createRuntime({ root, caseId: coldId, sampleMode: true, cassette }),
    viewSql: VIEW_SQL,
    grain: "fiscal_year",
  });
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
  persist(closed.state);
  console.log(`${coldId}: ${closed.state.stage}, ${closed.state.exhibits.length} exhibits`);

  const warmId = "case_sample_warm";
  const warm = await runInvestigation({
    root,
    state: makeState(warmId, cassette.id, cassette.recorded_at),
    rt: createRuntime({ root, caseId: warmId, sampleMode: true, cassette }),
    viewSql: VIEW_SQL,
    grain: "fiscal_year",
  });
  persist(warm);
  console.log(
    `${warmId}: ${warm.stage}, ${warm.exhibits.length} exhibits, ` +
      `recall ${warm.memory?.hits.length} hit(s) via ${warm.memory?.scoring} ` +
      `(${warm.memory?.embedding?.status})`,
  );

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const id of [coldId, warmId]) cpSync(join(root, "logs", id), join(OUT, id), { recursive: true });
  console.log(`wrote ${OUT}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
