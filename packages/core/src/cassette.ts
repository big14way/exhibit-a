import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sha256Json } from "./hash.ts";

export type CassetteEntry = {
  tool: string;
  args_sha256: string;
  result: unknown;
};

export type CassetteModelEntry = {
  agent: string;
  request_sha256: string;
  response: unknown;
};

export type Cassette = {
  id: string;
  recorded_at: string;
  label: string;
  entries: CassetteEntry[];
  models?: CassetteModelEntry[];
};

export function cassetteKey(tool: string, args: unknown): string {
  return `${tool}:${sha256Json(args)}`;
}

export function loadCassette(path: string): Cassette {
  if (!existsSync(path)) {
    throw new Error(`cassette not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Cassette;
}

export function lookupCassette(cassette: Cassette, tool: string, args: unknown): unknown {
  const args_sha256 = sha256Json(args);
  const hit = cassette.entries.find(
    (entry) => entry.tool === tool && entry.args_sha256 === args_sha256,
  );
  if (!hit) {
    throw new Error(`cassette miss for ${tool} ${args_sha256}`);
  }
  return hit.result;
}

export function lookupModel(
  cassette: Cassette,
  agent: string,
  request: unknown,
): unknown {
  const request_sha256 = sha256Json(request);
  const hit = (cassette.models ?? []).find(
    (entry) => entry.agent === agent && entry.request_sha256 === request_sha256,
  );
  if (!hit) {
    throw new Error(`model cassette miss for ${agent} ${request_sha256}`);
  }
  return hit.response;
}

export class CassetteRecorder {
  readonly entries: CassetteEntry[] = [];
  readonly models: CassetteModelEntry[] = [];

  record(tool: string, args: unknown, result: unknown): void {
    this.entries.push({
      tool,
      args_sha256: sha256Json(args),
      result,
    });
  }

  recordModel(agent: string, request: unknown, response: unknown): void {
    this.models.push({
      agent,
      request_sha256: sha256Json(request),
      response,
    });
  }

  save(path: string, meta: { id: string; recorded_at: string; label: string }): void {
    mkdirSync(dirname(path), { recursive: true });
    const cassette: Cassette = { ...meta, entries: this.entries, models: this.models };
    writeFileSync(path, `${JSON.stringify(cassette, null, 2)}\n`, "utf8");
  }
}

export function sampleBanner(cassette: Cassette): string {
  return `REPLAYED FROM RECORDED RUN ${cassette.id} on ${cassette.recorded_at}`;
}
