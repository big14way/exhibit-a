#!/usr/bin/env npx tsx
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  advance,
  findExhibit,
  loadCassette,
  loadExhibits,
  newId,
  sampleBanner,
  type CaseState,
  type Cassette,
} from "@exhibit-a/core";
import {
  catalogSearch,
  createRuntime,
  describeObject,
  fromEnv,
  metricHistory,
  profileColumn,
  runSql,
  ZetarisClient,
} from "@exhibit-a/tools";
import { isSampleMode, loadEnv } from "./env.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_METRIC = "analytics.sector_revenue_by_year";
const DEFAULT_CASSETTE = resolve(ROOT, "fixtures/cassettes/d1-metric-series.json");

function usage(): never {
  console.error(`Exhibit A — data-quality findings, not investment advice.

Usage:
  exhibit-a investigate "<question>" [--metric <view>] [--cassette <path>]
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
  const question = argv.filter((a) => !a.startsWith("--")).join(" ").trim()
    || `is the movement in ${metric} real?`;
  const sampleMode = isSampleMode();
  const cassette: Cassette | undefined = sampleMode ? loadCassette(cassettePath) : undefined;

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

  let current = advance(state, "SCOPING");
  const catalog = await catalogSearch(rt, metric);
  const described = await describeObject(rt, metric);
  const adHoc = await runSql(rt, `SELECT * FROM ${metric}`);
  const profiled = await profileColumn(rt, metric, "revenue_usd", "fiscal_year");
  current = advance(current, "LINEAGE");
  current = advance(current, "BASELINED");
  const history = await metricHistory(rt, metric, "fiscal_year");

  current.exhibits = [catalog, described, adHoc, profiled, history].map((x) => x.exhibit);
  persistState(current);

  console.log(`\ncase ${current.id}  stage ${current.stage}  metric ${metric}`);
  console.log("metric series:");
  printTable(history.result.columns, history.result.rows as unknown[][]);
  console.log("\nexhibits:");
  for (const ex of current.exhibits) {
    console.log(`  ${ex.id}  ${ex.kind.padEnd(10)}  ${ex.title}  sha ${ex.result_sha256.slice(0, 12)}  ${ex.rerun}`);
  }
  console.log(`\n${current.exhibits.length} exhibits written to logs/${current.id}/`);
}

async function rerun(exhibitId?: string): Promise<void> {
  if (!exhibitId) usage();
  const exhibit = findExhibit(ROOT, exhibitId);
  if (!exhibit) {
    console.error(`exhibit not found: ${exhibitId}`);
    process.exit(1);
  }
  if (!exhibit.sql) {
    console.error("exhibit has no SQL to re-run");
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
  const again = await runSql(rt, exhibit.sql);
  const same = again.exhibit.result_sha256 === exhibit.result_sha256;
  console.log(`original ${exhibit.result_sha256}`);
  console.log(`rerun    ${again.exhibit.result_sha256}`);
  console.log(same ? "MATCH" : "DRIFT");
  process.exit(same ? 0 : 1);
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
