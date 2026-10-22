import { mkdirSync, appendFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId, sha256, sha256Json } from "./hash.ts";
import type { Exhibit, ExhibitKind, SqlResult } from "./models.ts";

export function caseDir(root: string, caseId: string): string {
  return join(root, "logs", caseId);
}

export function exhibitsPath(root: string, caseId: string): string {
  return join(caseDir(root, caseId), "exhibits.jsonl");
}

export function createExhibit(input: {
  kind: ExhibitKind;
  source: string;
  transport: string;
  title: string;
  tool?: string;
  sql?: string;
  args?: unknown;
  result: SqlResult | Record<string, unknown>;
  case_id: string;
  agent: string;
}): Exhibit {
  const id = newId("ex");
  const sql_sha256 = input.sql ? sha256(input.sql) : undefined;
  return {
    id,
    ts: new Date().toISOString(),
    kind: input.kind,
    source: input.source,
    transport: input.transport,
    title: input.title,
    tool: input.tool,
    sql: input.sql,
    sql_sha256,
    args: input.args,
    result: input.result,
    result_sha256: sha256Json(input.result),
    rerun: `exhibit-a rerun ${id}`,
    case_id: input.case_id,
    agent: input.agent,
  };
}

export function appendExhibit(root: string, exhibit: Exhibit): void {
  const path = exhibitsPath(root, exhibit.case_id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(exhibit)}\n`, "utf8");
}

export function loadExhibits(root: string, caseId: string): Exhibit[] {
  const path = exhibitsPath(root, caseId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Exhibit);
}

export function findExhibit(root: string, exhibitId: string): Exhibit | undefined {
  if (!existsSync(join(root, "logs"))) return undefined;
  for (const name of readdirSync(join(root, "logs"))) {
    const dir = join(root, "logs", name);
    if (!statSync(dir).isDirectory()) continue;
    const hit = loadExhibits(root, name).find((ex) => ex.id === exhibitId);
    if (hit) return hit;
  }
  return undefined;
}

export function asSqlResult(
  columns: string[],
  rows: unknown[][],
  // The live canonical fact query spans the full company history (~1.3k
  // rows). A 500-row cap would silently feed a truncated series into the
  // counterfactual while claiming the query succeeded.
  cap = 5000,
): SqlResult {
  const truncated = rows.length > cap;
  const sliced = truncated ? rows.slice(0, cap) : rows;
  return {
    columns,
    rows: sliced,
    row_count: rows.length,
    truncated,
  };
}
