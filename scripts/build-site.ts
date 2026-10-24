#!/usr/bin/env npx tsx
/**
 * Export the case viewer as a static site under docs/ (GitHub Pages). The
 * page is the same viewer; the API is replaced by JSON files generated from
 * the committed fixtures/cases. Exhibit re-runs need the local viewer and are
 * labelled as such on the static page.
 *
 * Usage: npm run site
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaseState, Exhibit, TraceLine } from "@exhibit-a/core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = resolve(ROOT, "apps/web/public");
const OUT = resolve(ROOT, "docs");
const DATA = join(OUT, "data");

type CaseSource = { id: string; dir: string; source: string };

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

function caseSources(): CaseSource[] {
  const fixtures = resolve(ROOT, "fixtures/cases");
  const found: CaseSource[] = [];
  for (const source of readdirSync(fixtures)) {
    const base = join(fixtures, source);
    if (!statSync(base).isDirectory()) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (name.startsWith("case_") && existsSync(join(dir, "state.json"))) found.push({ id: name, dir, source });
    }
  }
  return found;
}

mkdirSync(OUT, { recursive: true });
for (const name of readdirSync(OUT)) {
  // docs/video is the local video scratch area; everything else is regenerated.
  if (name === "video") continue;
  rmSync(join(OUT, name), { recursive: true, force: true });
}
for (const file of ["index.html", "app.js", "style.css", "favicon.svg"]) {
  cpSync(join(PUBLIC, file), join(OUT, file));
}
mkdirSync(DATA, { recursive: true });

const summaries = [];
for (const source of caseSources()) {
  const state = JSON.parse(readFileSync(join(source.dir, "state.json"), "utf8")) as CaseState;
  const exhibits = state.exhibits.length ? state.exhibits : readJsonl<Exhibit>(join(source.dir, "exhibits.jsonl"));
  const trace = readJsonl<TraceLine>(join(source.dir, "trace.jsonl"));
  const graphPath = join(source.dir, "world-model.json");
  const graph = existsSync(graphPath) ? JSON.parse(readFileSync(graphPath, "utf8")) : null;
  writeFileSync(
    join(DATA, `${state.id}.json`),
    JSON.stringify({ source: source.source, state: { ...state, exhibits }, trace, graph }),
  );
  summaries.push({
    id: state.id,
    source: source.source,
    reported_at: state.reported_at,
    question: state.question,
    metric: state.metric,
    stage: state.stage,
    sample_mode: state.sample_mode,
    verdict: state.verdict?.kind ?? null,
    causes: (state.verdict?.causes ?? []).map((cause) => ({ cause: cause.cause, share: cause.share })),
    exhibits: exhibits.length,
    writeback_ok: state.writeback?.ok ?? null,
    contract_id: state.write_contract?.id ?? null,
    updated_at: state.reported_at,
  });
}
summaries.sort((a, b) => b.reported_at.localeCompare(a.reported_at));
writeFileSync(join(DATA, "cases.json"), JSON.stringify({ cases: summaries }));

// The page detects the static build through this flag and reads data/ instead
// of /api/. Paths are relative so the site works under a repository subpath.
const html = readFileSync(join(OUT, "index.html"), "utf8")
  .replace('<script type="module" src="/app.js"></script>', '<script>window.EXHIBIT_A_STATIC = true;</script>\n    <script type="module" src="./app.js"></script>')
  .replace('href="/style.css"', 'href="./style.css"')
  .replace('href="/favicon.svg"', 'href="./favicon.svg"')
  .replace('href="/api/cases"', 'href="./data/cases.json"');
writeFileSync(join(OUT, "index.html"), html);
writeFileSync(join(OUT, ".nojekyll"), "");
console.log(`wrote ${OUT}: ${summaries.length} cases`);
