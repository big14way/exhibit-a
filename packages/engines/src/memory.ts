import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  CaseState,
  MemoryHit,
  MemoryRecall,
  MemoryRecord,
} from "@exhibit-a/core";

/**
 * H-MEM reference implementation.
 *
 * The real Meterless H-MEM engine is an external backend. This module keeps the
 * same contract (recall / mine / audit / remember) locally so the investigator
 * can use institutional memory in a clean clone, in SAMPLE_MODE, and in tests.
 * The store is a JSON index under logs/memory; it contains no secrets and is
 * gitignored with the rest of logs/.
 */
export function memoryPath(root: string): string {
  return join(root, "logs", "memory", "index.json");
}

type MemoryIndex = {
  version: 1;
  updated_at: string;
  records: MemoryRecord[];
};

const EMPTY: MemoryIndex = {
  version: 1,
  updated_at: new Date(0).toISOString(),
  records: [],
};

function readIndex(root: string): { index: MemoryIndex; malformed: number } {
  const path = memoryPath(root);
  if (!existsSync(path)) return { index: { ...EMPTY, records: [] }, malformed: 0 };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MemoryIndex>;
    const records = Array.isArray(raw.records) ? raw.records : [];
    return {
      index: {
        version: 1,
        updated_at: String(raw.updated_at ?? EMPTY.updated_at),
        records: records.filter(isRecord),
      },
      malformed: records.length - records.filter(isRecord).length,
    };
  } catch {
    return { index: { ...EMPTY, records: [] }, malformed: 1 };
  }
}

function isRecord(value: unknown): value is MemoryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<MemoryRecord>;
  return (
    record.version === 1 &&
    typeof record.case_id === "string" &&
    typeof record.metric === "string" &&
    typeof record.verdict_kind === "string" &&
    Array.isArray(record.causes)
  );
}

export function auditMemory(root: string): {
  storage: string;
  records: number;
  valid: number;
  malformed: number;
  duplicates: number;
} {
  const read = readIndex(root);
  const seen = new Set<string>();
  let duplicates = 0;
  for (const record of read.index.records) {
    if (seen.has(record.case_id)) duplicates += 1;
    seen.add(record.case_id);
  }
  return {
    storage: memoryPath(root),
    records: read.index.records.length,
    valid: read.index.records.length,
    malformed: read.malformed,
    duplicates,
  };
}

export function rememberCase(root: string, state: CaseState, note?: string): MemoryRecord {
  const read = readIndex(root);
  const causes = (state.verdict?.causes ?? []).map(
    (cause) => `${cause.cause}=${(cause.share * 100).toFixed(1)}%`,
  );
  const record: MemoryRecord = {
    version: 1,
    case_id: state.id,
    metric: state.metric,
    question: state.question,
    verdict_kind: state.verdict?.kind ?? "UNKNOWN",
    causes,
    stage: state.stage,
    closed_at: new Date().toISOString(),
    exhibits: state.exhibits.length,
    exhibit_ids: state.exhibits.slice(-12).map((exhibit) => exhibit.id),
    sample_mode: state.sample_mode,
    note:
      note ??
      `Case ${state.id}: ${state.verdict?.kind ?? "UNKNOWN"} on ${state.metric}; ` +
        `${causes.join(", ") || "no causes"}.`,
  };
  const records = read.index.records.filter((row) => row.case_id !== state.id);
  records.push(record);
  const next: MemoryIndex = {
    version: 1,
    updated_at: new Date().toISOString(),
    records,
  };
  const path = memoryPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return record;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

function overlap(a: string[], b: Set<string>): number {
  return a.reduce((sum, token) => sum + (b.has(token) ? 1 : 0), 0);
}

export function recallMemory(
  root: string,
  query: { metric: string; question: string; limit?: number },
): MemoryRecall {
  const read = readIndex(root);
  const audit = auditMemory(root);
  const queryTokens = tokens(query.question);
  const limit = query.limit ?? 5;
  const hits: MemoryHit[] = [];
  for (const record of read.index.records) {
    const recordTokens = new Set(tokens(`${record.question} ${record.causes.join(" ")}`));
    const match: string[] = [];
    let score = 0;
    if (record.metric === query.metric) {
      score += 10;
      match.push("same metric");
    }
    const shared = overlap(queryTokens, recordTokens);
    if (shared > 0) {
      score += Math.min(6, shared);
      match.push(`${shared} shared terms`);
    }
    if (record.verdict_kind) {
      match.push(record.verdict_kind);
    }
    if (score === 0) continue;
    hits.push({
      case_id: record.case_id,
      metric: record.metric,
      question: record.question,
      verdict_kind: record.verdict_kind,
      causes: record.causes,
      closed_at: record.closed_at,
      score,
      match,
      excerpt: record.note,
    });
  }
  hits.sort((a, b) => b.score - a.score || b.closed_at.localeCompare(a.closed_at));
  return {
    storage: memoryPath(root),
    cold_start: read.index.records.length === 0,
    query: { metric: query.metric, question: query.question },
    records: read.index.records.length,
    hits: hits.slice(0, limit),
    audit: {
      valid: audit.valid,
      malformed: audit.malformed,
      duplicates: audit.duplicates,
    },
    scoring: "lexical",
  };
}

/** A narrow embedding client so the engine does not depend on the NIM package. */
export type MemoryEmbedder = {
  model: string;
  embed(request: {
    agent: string;
    model: string;
    input: string[];
    input_type?: "query" | "passage";
  }): Promise<{ model: string; embeddings: number[][]; usage: { prompt_tokens: number } }>;
};

export const HMEM_EMBED_AGENT = "HMemEmbed";

/**
 * The text that represents a memory record for embedding. It deliberately
 * excludes the case id and timestamps so the same closed case embeds to the
 * same vector in every run, which keeps the SAMPLE_MODE replay exact.
 */
export function memoryRecordText(record: Pick<MemoryRecord, "metric" | "question" | "verdict_kind" | "causes">): string {
  return `${record.metric}\n${record.question}\n${record.verdict_kind}: ${record.causes.join(", ") || "no causes"}`;
}

export function memoryQueryText(query: { metric: string; question: string }): string {
  return `${query.metric}\n${query.question}`;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Lexical recall, re-scored with Nemotron embeddings when an embedder is
 * available. The lexical pass always runs, so a missing key, a cassette miss
 * or a model error degrades to the deterministic result and says so in the
 * `embedding` summary rather than failing the investigation.
 */
export async function recallMemorySemantic(
  root: string,
  query: { metric: string; question: string; limit?: number },
  embedder?: MemoryEmbedder | null,
): Promise<MemoryRecall> {
  const lexical = recallMemory(root, query);
  const skipped = (detail: string, model: string | null): MemoryRecall => ({
    ...lexical,
    embedding: { status: "skipped", model, dims: 0, texts: 0, detail, usage: { prompt_tokens: 0 } },
  });
  if (!embedder) return skipped("no embedding model configured; lexical recall only", null);
  const records = readIndex(root).index.records;
  if (records.length === 0) {
    return skipped("cold start; nothing to embed", embedder.model);
  }
  try {
    const queryVector = await embedder.embed({
      agent: HMEM_EMBED_AGENT,
      model: embedder.model,
      input: [memoryQueryText(query)],
      input_type: "query",
    });
    const passages = await embedder.embed({
      agent: HMEM_EMBED_AGENT,
      model: embedder.model,
      input: records.map((record) => memoryRecordText(record)),
      input_type: "passage",
    });
    const q = queryVector.embeddings[0] ?? [];
    const byCase = new Map(lexical.hits.map((hit) => [hit.case_id, hit]));
    const hits: MemoryHit[] = records.map((record, index) => {
      const similarity = Math.round(cosine(q, passages.embeddings[index] ?? []) * 1e4) / 1e4;
      const base = byCase.get(record.case_id);
      const semantic = Math.round(similarity * 10);
      return {
        case_id: record.case_id,
        metric: record.metric,
        question: record.question,
        verdict_kind: record.verdict_kind,
        causes: record.causes,
        closed_at: record.closed_at,
        score: (base?.score ?? 0) + semantic,
        match: [...(base?.match ?? []), `embedding similarity ${similarity.toFixed(2)}`],
        excerpt: record.note,
        similarity,
      };
    });
    hits.sort((a, b) => b.score - a.score || b.closed_at.localeCompare(a.closed_at));
    return {
      ...lexical,
      hits: hits.filter((hit) => hit.score > 0).slice(0, query.limit ?? 5),
      scoring: "lexical+embedding",
      embedding: {
        status: "ran",
        model: passages.model || embedder.model,
        dims: q.length,
        texts: records.length + 1,
        detail: `query and ${records.length} record(s) embedded; cosine similarity added to the lexical score`,
        usage: {
          prompt_tokens: queryVector.usage.prompt_tokens + passages.usage.prompt_tokens,
        },
      },
    };
  } catch (err) {
    return {
      ...lexical,
      embedding: {
        status: "error",
        model: embedder.model,
        dims: 0,
        texts: 0,
        detail: `embedding unavailable, lexical recall kept: ${err instanceof Error ? err.message : String(err)}`,
        usage: { prompt_tokens: 0 },
      },
    };
  }
}

/**
 * Mine closed case directories into the index. This is the cold-start repair
 * path: a clean clone can rebuild H-MEM from the gitignored case logs without
 * replaying the investigations. It is idempotent by case id.
 */
export function mineMemory(root: string): { mined: number; audit: ReturnType<typeof auditMemory> } {
  const logs = join(root, "logs");
  if (!existsSync(logs)) return { mined: 0, audit: auditMemory(root) };
  let mined = 0;
  for (const name of readdirSync(logs)) {
    if (!name.startsWith("case_")) continue;
    const path = join(logs, name, "state.json");
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    try {
      const state = JSON.parse(readFileSync(path, "utf8")) as CaseState;
      if (state.stage !== "CLOSED") continue;
      rememberCase(root, state);
      mined += 1;
    } catch {
      // A malformed case log is counted by auditMemory's malformed field, not
      // allowed to break the mining pass.
    }
  }
  return { mined, audit: auditMemory(root) };
}

export type { MemoryRecord, MemoryRecall, MemoryHit };
