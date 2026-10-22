#!/usr/bin/env npx tsx
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findExhibit,
  loadCassette,
  loadExhibits,
  newId,
  sampleBanner,
  summarizeVerdict,
  type CaseState,
  type Cassette,
} from "@exhibit-a/core";
import { createRuntime, fromEnv, rerunExhibit, ZetarisClient } from "@exhibit-a/tools";
import { runInvestigation } from "@exhibit-a/agents";
import { isSampleMode, loadEnv } from "./env.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_METRIC = "analytics.sector_revenue_by_year";
const DEFAULT_CASSETTE = resolve(ROOT, "fixtures/cassettes/d2-edgar-investigation.json");
const DEFAULT_VIEW_SQL = resolve(ROOT, "analytics/sector_revenue_by_year.sql");

function usage(): never {
  console.error(`Exhibit A — data-quality findings, not investment advice.

Usage:
  exhibit-a investigate "<question>" [--metric <view>] [--cassette <path>] [--grain <column>]
  exhibit-a rerun <exhibit_id>
  exhibit-a replay <case_id>
  exhibit-a bootstrap-metric
`);
  process.exit(2);
}

async function main(): Promise<void> {
  loadEnv(ROOT);
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  if (cmd === "investigate") await investigate(rest);
  else if (cmd === "rerun") await rerun(rest[0]);
  else if (cmd === "replay") await replay(rest[0]);
  else if (cmd === "bootstrap-metric") await bootstrapMetric();
  else usage();
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

async function investigate(argv: string[]): Promise<void> {
  const metric = takeFlag(argv, "--metric") ?? DEFAULT_METRIC;
  const cassettePath = takeFlag(argv, "--cassette") ?? DEFAULT_CASSETTE;
  const grain = takeFlag(argv, "--grain") ?? "fiscal_year";
  const question = argv.filter((a) => !a.startsWith("--")).join(" ").trim()
    || `is the movement in ${metric} real?`;
  const sampleMode = isSampleMode();
  const cassette: Cassette | undefined = sampleMode ? loadCassette(cassettePath) : undefined;
  const viewSql = readFileSync(DEFAULT_VIEW_SQL, "utf8").trim();

  const state: CaseState = {
    id: newId("case"),
    reported_at: new Date().toISOString(),
    question,
    metric,
    stage: "REPORTED",
    sample_mode: sampleMode,
    cassette_id: cassette?.id,
    cassette_recorded_at: cassette?.recorded_at,
    exhibits: [],
    hypotheses: [],
  };

  if (cassette) {
    console.log(sampleBanner(cassette));
  }
  console.log("Caveat: data-quality findings on public filings; not investment advice.");

  const rt = createRuntime({
    root: ROOT,
    caseId: state.id,
    sampleMode,
    cassette,
  });

  const current = await runInvestigation({
    root: ROOT,
    state,
    rt,
    viewSql,
    grain,
  });
  persistState(current);

  console.log(`\ncase ${current.id}  stage ${current.stage}  metric ${metric}`);
  if (current.baseline?.onset) {
    const onset = current.baseline.onset;
    console.log(`symptom: ${current.baseline.explanation}`);
    console.log(
      `walked:  ${onset.prior_period} ${formatUsd(onset.prior_value)} -> ${onset.period} ${formatUsd(onset.value)}`,
    );
  } else {
    console.log(`symptom: ${current.baseline?.explanation ?? "not baselined"}`);
  }

  console.log("\nmetric series:");
  const table = metricTable(current);
  printTable(table.columns, table.rows);

  console.log("\nhypotheses:");
  for (const hypothesis of current.hypotheses) {
    const share = hypothesis.share === undefined ? "" : `  share ${(hypothesis.share * 100).toFixed(1)}%`;
    console.log(`  [${hypothesis.status.padEnd(10)}] ${hypothesis.cause}${share}`);
    console.log(`      ${hypothesis.note ?? hypothesis.statement}`);
    console.log(`      exhibits: ${hypothesis.exhibit_ids.join(", ")}`);
  }

  console.log("\nverdict:");
  if (current.verdict) {
    console.log(`  ${summarizeVerdict(current.verdict)}`);
    if (current.verdict.unexplained_share !== undefined) {
      console.log(`  unexplained ${(current.verdict.unexplained_share * 100).toFixed(1)}%`);
    }
    for (const note of current.verdict.notes ?? []) console.log(`  note: ${note}`);
    if (current.verdict.gate_failures?.length) {
      for (const failure of current.verdict.gate_failures) {
        console.log(`  GATE FAIL ${failure.rule}: ${failure.detail}`);
      }
    } else {
      console.log("  gate: pass");
    }
  } else {
    console.log("  not adjudicated");
  }

  if (current.repair) {
    console.log("\nrepair:");
    console.log(`  shadow:    ${current.repair.shadow_metric}`);
    console.log(`  corrected: ${current.repair.corrected_metric} (not written)`);
    console.log(`  rule:      one annual fact per cik/period_end, last filed wins`);
    if (current.contract) {
      console.log(
        `  contract:  ${current.contract.id} scope ${current.contract.scope.join(", ")} ` +
          `approved ${current.contract.approved ? "yes" : "no (shadow only)"}`,
      );
    }
    if (current.verification) {
      console.log(`  verifier:  ${current.verification.ok ? "PASS" : "FAIL"}`);
      for (const invariant of current.verification.invariants) {
        console.log(`    [${invariant.ok ? "pass" : "FAIL"}] ${invariant.name}: ${invariant.detail}`);
      }
    }
    if (current.stage === "SHADOW_VERIFIED") {
      console.log("  next:      operator approval required before writeback; reported view untouched");
    }
    if (current.error) console.log(`  error:     ${current.error}`);
  }

  console.log("\nexhibits:");
  for (const ex of current.exhibits) {
    console.log(`  ${ex.id}  ${ex.kind.padEnd(14)}  ${ex.title}  sha ${ex.result_sha256.slice(0, 12)}  ${ex.rerun}`);
  }
  console.log(`\n${current.exhibits.length} exhibits written to logs/${current.id}/`);

  const confirmed = current.hypotheses.filter((row) => row.status === "confirmed").length;
  const eliminated = current.hypotheses.filter((row) => row.status === "eliminated").length;
  console.log(`${confirmed} confirmed, ${eliminated} eliminated, ${current.hypotheses.filter((row) => row.status === "open").length} open.`);
}

async function rerun(exhibitId?: string): Promise<void> {
  if (!exhibitId) usage();
  const exhibit = findExhibit(ROOT, exhibitId);
  if (!exhibit) {
    console.error(`exhibit not found: ${exhibitId}`);
    process.exit(1);
  }
  const sampleMode = isSampleMode();
  const cassette = sampleMode ? loadCassette(DEFAULT_CASSETTE) : undefined;
  const rt = createRuntime({
    root: ROOT,
    caseId: exhibit.case_id,
    sampleMode,
    cassette,
  });
  rt.agent = "Rerun";
  const again = await rerunExhibit(rt, exhibit);
  console.log(`original ${again.original}`);
  console.log(`rerun    ${again.rerun}`);
  console.log(again.same ? "MATCH" : "DRIFT");
  process.exit(again.same ? 0 : 1);
}

async function replay(caseId?: string): Promise<void> {
  if (!caseId) usage();
  const path = resolve(ROOT, "logs", caseId, "trace.jsonl");
  if (!existsSync(path)) {
    console.error(`no trace for ${caseId}`);
    process.exit(1);
  }
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const ev = JSON.parse(line) as {
      timestamp: string;
      agent_name: string;
      action: string;
      output_summary: string;
      status: string;
    };
    console.log(`${ev.timestamp}  ${ev.agent_name}  ${ev.action}  ${ev.status}  ${ev.output_summary}`);
  }
  const exhibits = loadExhibits(ROOT, caseId);
  console.log(`\n${exhibits.length} exhibits on file`);
}

async function bootstrapMetric(): Promise<void> {
  const sqlPath = resolve(ROOT, "analytics/sector_revenue_by_year.sql");
  const sql = readFileSync(sqlPath, "utf8");
  if (isSampleMode()) {
    console.log("SAMPLE_MODE: not applying the view. Fixture SQL:\n");
    console.log(sql.trim());
    return;
  }
  const cfg = fromEnv();
  if (!cfg) {
    throw new Error("live bootstrap needs ZETARIS_REST_URL and ZETARIS_API_KEY");
  }
  const client = new ZetarisClient(cfg);
  await client.runSql(sql, { mode: "write" });
  console.log("applied analytics.sector_revenue_by_year");
}

function persistState(state: CaseState): void {
  const path = resolve(ROOT, "logs", state.id, "state.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function printTable(columns: string[], rows: unknown[][]): void {
  console.log(columns.join("\t"));
  for (const row of rows) console.log(row.map((c) => String(c)).join("\t"));
}

function metricTable(state: CaseState): { columns: string[]; rows: unknown[][] } {
  const exhibit = state.exhibits.find((row) => row.tool === "metric_history");
  if (!exhibit) return { columns: [], rows: [] };
  const result = exhibit.result as { columns?: string[]; rows?: unknown[][] };
  return { columns: result.columns ?? [], rows: result.rows ?? [] };
}

function formatUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
