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
  loadCassette,
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

/**
 * Cases come from two places: the gitignored `logs/` directory (what the
 * operator ran on this machine) and the committed `fixtures/cases/<source>/`
 * directories (the recorded live Zetaris close and the curated sample). The
 * viewer never writes a case; it only reads them and re-runs exhibits.
 */
type CaseSource = { id: string; dir: string; source: string };

type CaseSummary = {
  id: string;
  source: string;
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

function safeCaseId(value: string): string {
  if (!/^case_[a-z0-9_]+$/i.test(value)) throw new Error("invalid case id");
  return value;
}

function caseDirsUnder(base: string, source: string): CaseSource[] {
  if (!existsSync(base)) return [];
  const found: CaseSource[] = [];
  for (const name of readdirSync(base)) {
    if (!name.startsWith("case_")) continue;
    const dir = join(base, name);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, "state.json"))) continue;
    found.push({ id: name, dir, source });
  }
  return found;
}

function caseSources(): CaseSource[] {
  // Committed fixtures win over a local copy with the same id, so the
  // recorded live close is always labelled as what it is.
  const byId = new Map<string, CaseSource>();
  for (const source of caseDirsUnder(join(ROOT, "logs"), "local")) byId.set(source.id, source);
  const fixtures = join(ROOT, "fixtures", "cases");
  if (existsSync(fixtures)) {
    for (const name of readdirSync(fixtures)) {
      const dir = join(fixtures, name);
      if (!statSync(dir).isDirectory()) continue;
      for (const source of caseDirsUnder(dir, name)) byId.set(source.id, source);
    }
  }
  return [...byId.values()];
}

function findCase(caseId: string): CaseSource {
  const id = safeCaseId(caseId);
  const hit = caseSources().find((source) => source.id === id);
  if (!hit) throw new Error(`case not found: ${id}`);
  return hit;
}

function readState(source: CaseSource): CaseState {
  return JSON.parse(readFileSync(join(source.dir, "state.json"), "utf8")) as CaseState;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function readGraph(source: CaseSource): unknown {
  const path = join(source.dir, "world-model.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function exhibitsFor(source: CaseSource, state: CaseState): Exhibit[] {
  if (state.exhibits.length) return state.exhibits;
  return readJsonl<Exhibit>(join(source.dir, "exhibits.jsonl"));
}

function listCases(): CaseSummary[] {
  const rows: CaseSummary[] = [];
  for (const source of caseSources()) {
    try {
      const state = readState(source);
      rows.push({
        id: state.id,
        source: source.source,
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
        exhibits: exhibitsFor(source, state).length,
        writeback_ok: state.writeback?.ok ?? null,
        contract_id: state.write_contract?.id ?? null,
        updated_at: statSync(join(source.dir, "state.json")).mtime.toISOString(),
      });
    } catch {
      // A half-written or malformed case log is skipped rather than breaking
      // the whole case list.
    }
  }
  return rows.sort((a, b) => b.reported_at.localeCompare(a.reported_at));
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
    const source = findCase(caseMatch[1]!);
    const state = readState(source);
    json(res, 200, {
      source: source.source,
      state: { ...state, exhibits: exhibitsFor(source, state) },
      trace: readJsonl<TraceLine>(join(source.dir, "trace.jsonl")),
      graph: readGraph(source),
    });
    return;
  }

  const rerunMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/rerun\/([^/]+)$/);
  if (rerunMatch && req.method === "POST") {
    const source = findCase(rerunMatch[1]!);
    const state = readState(source);
    const exhibit = exhibitsFor(source, state).find((row) => row.id === rerunMatch[2]);
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
    rt.agent = "Rerun";
    const result = await rerunExhibit(rt, exhibit);
    json(res, 200, {
      same: result.same,
      mode: state.sample_mode ? "cassette replay" : "live Zetaris",
      expected_sha256: exhibit.result_sha256,
      rerun_sha256: result.exhibit.result_sha256,
      exhibit: result.exhibit,
    });
    return;
  }

  json(res, 404, { error: "not found" });
}

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
};

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
  text(res, 200, readFileSync(path, "utf8"), TYPES[extname(path)] ?? "text/plain; charset=utf-8");
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
  console.log(`cases: ${join(ROOT, "logs")} + ${join(ROOT, "fixtures", "cases")}`);
});
