#!/usr/bin/env npx tsx
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findExhibit,
  loadCassette,
  loadExhibits,
  type CaseState,
  type Exhibit,
  type TraceLine,
} from "@exhibit-a/core";
import { createRuntime, rerunExhibit } from "@exhibit-a/tools";
import { loadEnv } from "../../cli/src/env.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const PUBLIC = resolve(HERE, "../public");
const CASSETTE = resolve(ROOT, "fixtures/cassettes/d2-edgar-investigation.json");
const PORT = Number(process.env.WEB_PORT ?? 4173);

loadEnv(ROOT);

type CaseSummary = {
  id: string;
  reported_at: string;
  question: string;
  metric: string;
  stage: string;
  sample_mode: boolean;
  verdict: string | null;
  causes: { cause: string; share: number }[];
  exhibits: number;
  writeback_ok: boolean | null;
  contract_id: string | null;
  updated_at: string;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function caseDir(caseId: string): string {
  return join(ROOT, "logs", caseId);
}

function safeCaseId(value: string): string {
  if (!/^case_[a-z0-9_]+$/i.test(value)) throw new Error("invalid case id");
  return value;
}

function readState(caseId: string): CaseState {
  const id = safeCaseId(caseId);
  const path = join(caseDir(id), "state.json");
  if (!existsSync(path)) throw new Error(`case not found: ${id}`);
  return JSON.parse(readFileSync(path, "utf8")) as CaseState;
}

function readTrace(caseId: string): TraceLine[] {
  const path = join(caseDir(safeCaseId(caseId)), "trace.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceLine);
}

function readGraph(caseId: string): unknown {
  const path = join(caseDir(safeCaseId(caseId)), "world-model.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function listCases(): CaseSummary[] {
  const logs = join(ROOT, "logs");
  if (!existsSync(logs)) return [];
  const rows: CaseSummary[] = [];
  for (const name of readdirSync(logs)) {
    if (!name.startsWith("case_")) continue;
    const dir = join(logs, name);
    if (!statSync(dir).isDirectory()) continue;
    const path = join(dir, "state.json");
    if (!existsSync(path)) continue;
    try {
      const state = JSON.parse(readFileSync(path, "utf8")) as CaseState;
      rows.push({
        id: state.id,
        reported_at: state.reported_at,
        question: state.question,
        metric: state.metric,
        stage: state.stage,
        sample_mode: state.sample_mode,
        verdict: state.verdict?.kind ?? null,
        causes: (state.verdict?.causes ?? []).map((cause) => ({
          cause: cause.cause,
          share: cause.share,
        })),
        exhibits: state.exhibits.length,
        writeback_ok: state.writeback?.ok ?? null,
        contract_id: state.write_contract?.id ?? null,
        updated_at: statSync(path).mtime.toISOString(),
      });
    } catch {
      // A half-written or malformed case log is skipped rather than breaking
      // the whole case list.
    }
  }
  return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function exhibitsFor(state: CaseState): Exhibit[] {
  if (state.exhibits.length) return state.exhibits;
  return loadExhibits(ROOT, state.id);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === "/api/health") {
    json(res, 200, { ok: true, mode: "local-viewer", cases: listCases().length });
    return;
  }
  if (url.pathname === "/api/cases") {
    json(res, 200, { cases: listCases() });
    return;
  }

  const caseMatch = url.pathname.match(/^\/api\/cases\/([^/]+)$/);
  if (caseMatch) {
    const state = readState(caseMatch[1]!);
    json(res, 200, {
      state: { ...state, exhibits: exhibitsFor(state) },
      trace: readTrace(state.id),
      graph: readGraph(state.id),
    });
    return;
  }

  const rerunMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/rerun\/([^/]+)$/);
  if (rerunMatch && req.method === "POST") {
    const state = readState(rerunMatch[1]!);
    const exhibit = findExhibit(ROOT, rerunMatch[2]!);
    if (!exhibit) {
      json(res, 404, { error: `exhibit not found: ${rerunMatch[2]}` });
      return;
    }
    const cassette = state.sample_mode ? loadCassette(CASSETTE) : undefined;
    const rt = createRuntime({
      root: ROOT,
      caseId: state.id,
      sampleMode: state.sample_mode,
      cassette,
    });
    const result = await rerunExhibit(rt, exhibit);
    json(res, 200, {
      same: result.same,
      expected_sha256: exhibit.result_sha256,
      rerun_sha256: result.exhibit.result_sha256,
      exhibit: result.exhibit,
    });
    return;
  }

  const exhibitMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/exhibits\/([^/]+)$/);
  if (exhibitMatch) {
    const state = readState(exhibitMatch[1]!);
    const exhibit = exhibitsFor(state).find((row) => row.id === exhibitMatch[2]);
    if (!exhibit) {
      json(res, 404, { error: "exhibit not found" });
      return;
    }
    json(res, 200, { exhibit });
    return;
  }

  json(res, 404, { error: "not found" });
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const file = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (file.includes("..")) {
    text(res, 400, "bad path", "text/plain");
    return;
  }
  const path = resolve(PUBLIC, file);
  if (!path.startsWith(PUBLIC) || !existsSync(path) || !statSync(path).isFile()) {
    text(res, 404, "not found", "text/plain");
    return;
  }
  const type =
    extname(path) === ".js"
      ? "text/javascript; charset=utf-8"
      : extname(path) === ".css"
        ? "text/css; charset=utf-8"
        : "text/html; charset=utf-8";
  text(res, 200, readFileSync(path, "utf8"), type);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((error) => {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Exhibit A viewer: http://127.0.0.1:${PORT}`);
  console.log(`cases: ${join(ROOT, "logs")}`);
});
