#!/usr/bin/env npx tsx
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ANOMALY_BAND,
  buildVerdict,
  loadCassette,
  loadGraph,
  type CaseState,
} from "@exhibit-a/core";
import { approveWriteback, runInvestigation, runWriteback } from "@exhibit-a/agents";
import { createRuntime, repairContractSecret } from "@exhibit-a/tools";
import { checkClaims, claimsMarkdown, type ClaimCheck } from "./check_claims.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASSETTE = resolve(ROOT, "fixtures/cassettes/d2-edgar-investigation.json");
const VIEW_SQL = readFileSync(
  resolve(ROOT, "analytics/sector_revenue_by_year.sql"),
  "utf8",
).trim();
const RESULTS = resolve(ROOT, "evals/results");

process.env.EXHIBIT_A_QUIET = "1";
process.env.SAMPLE_MODE = "true";

function makeState(caseId: string, question: string): CaseState {
  return {
    id: caseId,
    reported_at: new Date().toISOString(),
    question,
    metric: "analytics.sector_revenue_by_year",
    stage: "REPORTED",
    sample_mode: true,
    exhibits: [],
    hypotheses: [],
  };
}

function summary(state: CaseState) {
  return {
    id: state.id,
    stage: state.stage,
    sample_mode: state.sample_mode,
    exhibits: state.exhibits.length,
    verdict: state.verdict?.kind ?? null,
    causes: state.verdict?.causes ?? [],
    gate_failures: state.verdict?.gate_failures ?? [],
    critic: state.critic
      ? {
          status: state.critic.status,
          model: state.critic.model,
          objections: state.critic.objections.length,
          cited_unknown: state.critic.cited_unknown.length,
          usage: state.critic.usage,
        }
      : null,
    safety: state.safety,
    discovery: state.discovery,
    memory: state.memory,
    hmem: state.hmem,
    verification: state.verification
      ? {
          ok: state.verification.ok,
          invariants: state.verification.invariants.map((row) => ({
            name: row.name,
            ok: row.ok,
            numbers: row.numbers,
          })),
        }
      : null,
    writeback: state.writeback
      ? {
          ok: state.writeback.ok,
          checks: state.writeback.checks,
          written_metric: state.writeback.written_metric,
        }
      : null,
    contract: state.write_contract
      ? {
          id: state.write_contract.id,
          statements: state.write_contract.statements.length,
          approved: state.write_contract.approved,
        }
      : null,
  };
}

/**
 * Random per-run identifiers (exhibit, hypothesis and contract ids, the temp
 * log directory) are replaced with stable placeholders. Every number in the
 * file is still the computed value; only the ids are masked.
 */
function stableJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2)
    .replace(/\b(ex|hyp|contract)_[0-9a-f]{16}\b/g, "$1_<id>")
    .replace(/"[^"\n]*exhibit-a-eval-[^"\n]*"/g, '"<temp log dir>"')
    .replace(/"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g, '"<timestamp>"');
}

async function main(): Promise<void> {
  const root = mkdtempSync(resolve(tmpdir(), "exhibit-a-eval-"));
  const cassette = loadCassette(CASSETTE);
  // Keep the question identical to the recorded sample so the committed NIM
  // response is a true replay, not a fabricated answer for a new prompt.
  const question = "is the FY2018 jump real?";
  const coldId = "case_eval_cold";
  const warmId = "case_eval_warm";
  try {
    const cold = await runInvestigation({
      root,
      state: makeState(coldId, question),
      rt: createRuntime({ root, caseId: coldId, sampleMode: true, cassette }),
      viewSql: VIEW_SQL,
      grain: "fiscal_year",
    });
    if (!cold.memory) throw new Error("cold investigation did not record H-MEM recall");

    const approved = approveWriteback({
      root,
      state: cold,
      secret: repairContractSecret(true),
      sampleMode: true,
      approvedBy: "eval-operator",
    });
    const written = await runWriteback({
      root,
      state: approved,
      rt: createRuntime({ root, caseId: coldId, sampleMode: true, cassette }),
    });
    const closed = written.state;

    const warm = await runInvestigation({
      root,
      state: makeState(warmId, question),
      rt: createRuntime({ root, caseId: warmId, sampleMode: true, cassette }),
      viewSql: VIEW_SQL,
      grain: "fiscal_year",
    });

    const graph = loadGraph(root, cold.id);
    const ablation = buildVerdict({
      causes: [
        {
          cause: "filing_year_duplication",
          kind: "artifact",
          blamed: ["edgar.apple_revenue_table", cold.metric],
          exhibit_ids: cold.exhibits
            .filter((exhibit) => exhibit.kind === "baseline" || exhibit.kind === "sql")
            .slice(0, 2)
            .map((exhibit) => exhibit.id),
          share: 1,
        },
      ],
      exhibits: cold.exhibits,
      graph,
      band: DEFAULT_ANOMALY_BAND,
      symptom: cold.baseline?.onset,
      notes: ["ablation: counterfactual and second channel removed"],
    }).verdict;

    const claims: ClaimCheck[] = checkClaims({
      cold,
      warm,
      closed,
      memory: cold.memory,
      ablation,
    });

    const payload = {
      // Dated by the cassette, not the clock, so a judge's `npm run eval`
      // reproduces the committed file byte for byte instead of dirtying it.
      generated_from: `cassette ${cassette.id} recorded ${cassette.recorded_at}`,
      mode: "SAMPLE_MODE replay from the committed cassette",
      cold: summary(cold),
      closed: summary(closed),
      warm: summary(warm),
      ablation: {
        kind: ablation.kind,
        gate_failures: ablation.gate_failures ?? [],
      },
      claims,
    };
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(resolve(RESULTS, "latest.json"), `${stableJson(payload)}\n`);
    writeFileSync(resolve(RESULTS, "latest.md"), claimsMarkdown(claims));

    console.log(claimsMarkdown(claims));
    const failed = claims.filter((claim) => !claim.ok);
    if (failed.length) {
      console.error(`${failed.length} claim check(s) failed: ${failed.map((row) => row.id).join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log(`\nAll ${claims.length} claim checks pass. Wrote evals/results/latest.json`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
