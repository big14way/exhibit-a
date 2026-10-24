#!/usr/bin/env npx tsx
/**
 * Record the real NVIDIA NIM responses for every Nemotron role into the
 * labelled SAMPLE_MODE cassette: Defense Counsel (critic), the content-safety
 * model, and the H-MEM embedding role.
 *
 * The recorder is a write-through cache. The sample investigation runs cold,
 * closes (approve + writeback), then runs warm; every model request that is
 * not already in the cassette is sent to NIM once and stored keyed by the
 * deterministic request hash. Re-running the script with a full cassette
 * makes no network calls.
 *
 * Usage: npm run record:nim
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../apps/cli/src/env.ts";
import {
  loadCassette,
  lookupModel,
  sha256Json,
  type Cassette,
  type CaseState,
} from "@exhibit-a/core";
import type { MemoryEmbedder } from "@exhibit-a/engines";
import { NimClient, SAMPLE_SAFETY_MODEL, type ChatRequest, type EmbedRequest } from "@exhibit-a/llm";
import { createRuntime, repairContractSecret } from "@exhibit-a/tools";
import {
  SAMPLE_CRITIC_MODEL,
  SAMPLE_EMBED_MODEL,
  approveWriteback,
  runInvestigation,
  runWriteback,
  type CriticClient,
} from "../packages/agents/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASSETTE_PATH = resolve(ROOT, "fixtures/cassettes/d2-edgar-investigation.json");
const VIEW_SQL = readFileSync(resolve(ROOT, "analytics/sector_revenue_by_year.sql"), "utf8").trim();
const QUESTION = "is the FY2018 jump real?";
const METRIC = "analytics.sector_revenue_by_year";

loadEnv(ROOT);
process.env.EXHIBIT_A_QUIET = "1";
process.env.SAMPLE_MODE = "true";
const apiKey = process.env.NVIDIA_API_KEY;
if (!apiKey) throw new Error("NVIDIA_API_KEY is required to record model responses");

const nim = new NimClient({
  apiKey,
  baseUrl: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  timeoutMs: 180_000,
});

let recorded = 0;
let replayed = 0;

function saveModel(agent: string, request: unknown, response: unknown): void {
  const latest = loadCassette(CASSETTE_PATH);
  const hash = sha256Json(request);
  latest.models = [
    ...(latest.models ?? []).filter(
      (entry) => !(entry.agent === agent && entry.request_sha256 === hash),
    ),
    { agent, request_sha256: hash, response },
  ];
  latest.recorded_at = new Date().toISOString().slice(0, 10);
  writeFileSync(CASSETTE_PATH, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
}

function cassette(): Cassette {
  return loadCassette(CASSETTE_PATH);
}

/** Chat roles (critic, safety): replay when recorded, otherwise call and store. */
const writeThroughChat: CriticClient = {
  async chat(request: ChatRequest) {
    try {
      const hit = lookupModel(cassette(), request.agent, request) as Awaited<
        ReturnType<NimClient["chat"]>
      >;
      replayed += 1;
      return hit;
    } catch {
      console.log(
        `recording ${request.agent} ${request.model} (${request.messages
          .map((message) => message.content.length)
          .reduce((a, b) => a + b, 0)} chars)...`,
      );
      const response = await nim.chat(request);
      if (request.agent === "DefenseCounsel") {
        // The critic must parse as JSON or the replay is useless.
        const cleaned = response.content
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "");
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        const jsonText = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
        try {
          const parsed = JSON.parse(jsonText) as { objections?: unknown[] };
          console.log(
            `  ${response.model}: ${parsed.objections?.length ?? 0} objection(s), ` +
              `${response.usage.prompt_tokens}+${response.usage.completion_tokens} tokens`,
          );
          response.content = jsonText;
        } catch {
          writeFileSync(resolve(tmpdir(), "exhibit-a-nim-critic-raw.txt"), response.content, "utf8");
          throw new Error("critic response was not JSON; raw content saved to temp");
        }
      } else {
        console.log(`  ${response.model}: ${response.content.replace(/\n/g, " | ").slice(0, 120)}`);
      }
      saveModel(request.agent, request, response);
      recorded += 1;
      return response;
    }
  },
  get spend() {
    return nim.spend;
  },
};

const writeThroughEmbed: MemoryEmbedder = {
  model: SAMPLE_EMBED_MODEL,
  async embed(request: EmbedRequest) {
    try {
      const hit = lookupModel(cassette(), request.agent, request) as Awaited<
        ReturnType<NimClient["embed"]>
      >;
      replayed += 1;
      return hit;
    } catch {
      console.log(`recording ${request.agent} ${request.model} (${request.input.length} text(s))...`);
      const response = await nim.embed(request);
      console.log(`  ${response.model}: ${response.embeddings[0]?.length ?? 0} dims, ${response.usage.prompt_tokens} tokens`);
      saveModel(request.agent, request, response);
      recorded += 1;
      return response;
    }
  },
};

function makeState(id: string): CaseState {
  const current = cassette();
  return {
    id,
    reported_at: new Date().toISOString(),
    question: QUESTION,
    metric: METRIC,
    stage: "REPORTED",
    sample_mode: true,
    cassette_id: current.id,
    cassette_recorded_at: current.recorded_at,
    exhibits: [],
    hypotheses: [],
  };
}

const root = mkdtempSync(resolve(tmpdir(), "exhibit-a-record-nim-"));
try {
  const hooks = {
    critic: { client: writeThroughChat, model: SAMPLE_CRITIC_MODEL },
    safety: { client: writeThroughChat, model: SAMPLE_SAFETY_MODEL },
    embed: { client: writeThroughEmbed },
  };
  // Cold case: critic + safety requests. H-MEM is empty, so no embedding call.
  const coldId = "case_eval_cold";
  const cold = await runInvestigation({
    root,
    state: makeState(coldId),
    rt: createRuntime({ root, caseId: coldId, sampleMode: true, cassette: cassette() }),
    viewSql: VIEW_SQL,
    grain: "fiscal_year",
    ...hooks,
  });
  console.log(`cold: ${cold.stage}; critic ${cold.critic?.status}; safety model ${cold.safety?.model?.status}`);

  // Close it so H-MEM has one record, exactly as the eval and the CLI do.
  const approved = approveWriteback({
    root,
    state: cold,
    secret: repairContractSecret(true),
    sampleMode: true,
    approvedBy: "record-operator",
  });
  const closed = await runWriteback({
    root,
    state: approved,
    rt: createRuntime({ root, caseId: coldId, sampleMode: true, cassette: cassette() }),
  });
  console.log(`closed: ${closed.state.stage}`);

  // Warm case: embedding requests (query + one passage), then the warm critic
  // and safety requests, which differ from the cold ones because H-MEM hits
  // are part of the critic prompt.
  const warmId = "case_eval_warm";
  const warm = await runInvestigation({
    root,
    state: makeState(warmId),
    rt: createRuntime({ root, caseId: warmId, sampleMode: true, cassette: cassette() }),
    viewSql: VIEW_SQL,
    grain: "fiscal_year",
    ...hooks,
  });
  console.log(
    `warm: ${warm.stage}; recall ${warm.memory?.hits.length} hit(s) via ${warm.memory?.scoring}; ` +
      `critic ${warm.critic?.status}; safety model ${warm.safety?.model?.status}`,
  );
  console.log(`recorded ${recorded} new model response(s), replayed ${replayed}; cassette ${CASSETTE_PATH}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
