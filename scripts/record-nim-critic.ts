#!/usr/bin/env npx tsx
/**
 * Record one real NVIDIA NIM Defense Counsel response into the labelled
 * SAMPLE_MODE cassette. The request is deterministic (no ids or timestamps),
 * so the sample path can replay it later without a key or network.
 *
 * Usage: npm run record:nim
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../apps/cli/src/env.ts";
import { loadCassette, sha256Json, type CaseState } from "@exhibit-a/core";
import { NimClient, type ChatRequest, type ChatResult } from "@exhibit-a/llm";
import { createRuntime } from "@exhibit-a/tools";
import {
  SAMPLE_CRITIC_MODEL,
  runInvestigation,
  type CriticClient,
} from "../packages/agents/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASSETTE_PATH = resolve(ROOT, "fixtures/cassettes/d2-edgar-investigation.json");
const VIEW_SQL = readFileSync(resolve(ROOT, "analytics/sector_revenue_by_year.sql"), "utf8").trim();

loadEnv(ROOT);
const apiKey = process.env.NVIDIA_API_KEY;
if (!apiKey) throw new Error("NVIDIA_API_KEY is required to record a critic response");

let captured: ChatRequest | undefined;
const capture: CriticClient = {
  async chat(request) {
    captured = request;
    const result: ChatResult = {
      content: JSON.stringify({ objections: [], summary: "recording capture" }),
      tool_calls: [],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      model: request.model,
    };
    return result;
  },
  spend: { calls: 0, input_tokens: 0, output_tokens: 0, spent_usd: 0 },
};

const root = mkdtempSync(resolve(tmpdir(), "exhibit-a-record-nim-"));
const caseId = "case_record_nim";
try {
  const cassette = loadCassette(CASSETTE_PATH);
  const state: CaseState = {
    id: caseId,
    reported_at: new Date().toISOString(),
    question: "is the FY2018 jump real?",
    metric: "analytics.sector_revenue_by_year",
    stage: "REPORTED",
    sample_mode: true,
    cassette_id: cassette.id,
    cassette_recorded_at: cassette.recorded_at,
    exhibits: [],
    hypotheses: [],
  };
  await runInvestigation({
    root,
    state,
    rt: createRuntime({ root, caseId, sampleMode: true, cassette }),
    viewSql: VIEW_SQL,
    grain: "fiscal_year",
    critic: { client: capture, model: SAMPLE_CRITIC_MODEL },
  });
  if (!captured) throw new Error("critic request was not captured");

  const nim = new NimClient({
    apiKey,
    baseUrl: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    timeoutMs: 120_000,
  });
  console.log(`calling ${captured.model} (${captured.messages[1]?.content.length ?? 0} chars)...`);
  const response = await nim.chat(captured);
  writeFileSync(
    resolve(tmpdir(), "exhibit-a-nim-critic-raw.txt"),
    response.content,
    "utf8",
  );
  const cleaned = response.content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const jsonText = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  let parsed: { objections?: unknown[]; summary?: string };
  try {
    parsed = JSON.parse(jsonText) as { objections?: unknown[]; summary?: string };
  } catch {
    console.error(`non-JSON critic response (${response.content.length} chars):`);
    console.error(response.content.slice(0, 500));
    console.error("...");
    console.error(response.content.slice(-800));
    throw new Error("critic response was not JSON; raw content saved to temp");
  }
  console.log(
    `recorded ${response.model}: ${parsed.objections?.length ?? 0} objection(s), ` +
      `${response.usage.prompt_tokens}+${response.usage.completion_tokens} tokens`,
  );

  const latest = loadCassette(CASSETTE_PATH);
  latest.models = [
    ...(latest.models ?? []).filter(
      (entry) =>
        !(
          entry.agent === captured!.agent &&
          entry.request_sha256 === sha256Json(captured)
        ),
    ),
    {
      agent: captured.agent,
      request_sha256: sha256Json(captured),
      response,
    },
  ];
  latest.recorded_at = new Date().toISOString().slice(0, 10);
  writeFileSync(CASSETTE_PATH, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
  console.log(`wrote model entry to ${CASSETTE_PATH}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
