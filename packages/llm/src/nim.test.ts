import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Json } from "@exhibit-a/core";
import { Budget, BudgetExceededError } from "./budget.ts";
import { NimClient, type ChatRequest } from "./nim.ts";

const request: ChatRequest = {
  agent: "LeadInvestigator",
  model: "configured-model",
  messages: [{ role: "user", content: "propose hypotheses" }],
  json: true,
};

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      model: "configured-model",
      choices: [
        {
          message: {
            content: "{\"ok\":true}",
            tool_calls: [
              {
                id: "call_1",
                function: { name: "run_sql", arguments: "{\"sql\":\"SELECT 1\"}" },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("NimClient sends an OpenAI-compatible request and parses tool calls", async () => {
  let seenUrl = "";
  let seenBody = "";
  const client = new NimClient({
    apiKey: "test-key",
    baseUrl: "https://nim.test/v1/",
    budget: new Budget(1, 1, 2),
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body ?? "");
      return okResponse();
    }) as typeof fetch,
  });
  const result = await client.chat(request);
  assert.equal(seenUrl, "https://nim.test/v1/chat/completions");
  const body = JSON.parse(seenBody);
  assert.equal(body.model, "configured-model");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(result.content, "{\"ok\":true}");
  assert.equal(result.tool_calls[0]?.name, "run_sql");
  assert.deepEqual(result.tool_calls[0]?.arguments, { sql: "SELECT 1" });
  assert.equal(client.spend.spent_usd, 0.002);
});

test("NimClient retries a 429 and then succeeds", async () => {
  let calls = 0;
  const client = new NimClient({
    apiKey: "test-key",
    baseUrl: "https://nim.test/v1",
    budget: new Budget(1, 0, 0),
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) return new Response("busy", { status: 429 });
      return okResponse();
    }) as typeof fetch,
  });
  const result = await client.chat(request);
  assert.equal(calls, 2);
  assert.equal(result.tool_calls.length, 1);
});

test("NimClient rejects a tool call with non-JSON arguments", async () => {
  const client = new NimClient({
    apiKey: "test-key",
    baseUrl: "https://nim.test/v1",
    budget: new Budget(1, 0, 0),
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [{ id: "x", function: { name: "run_sql", arguments: "not-json" } }],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      )) as typeof fetch,
  });
  await assert.rejects(client.chat(request), /non-JSON arguments/);
});

test("SAMPLE_MODE replays the recorded model response keyed by the request", async () => {
  const cassette = {
    id: "c",
    recorded_at: "2026-10-22",
    label: "test",
    entries: [],
    models: [
      {
        agent: request.agent,
        request_sha256: sha256Json(request),
        response: {
          content: "recorded",
          tool_calls: [],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
          model: request.model,
        },
      },
    ],
  };
  const client = new NimClient({ apiKey: "unused", baseUrl: "https://nim.test", cassette });
  const result = await client.chat(request);
  assert.equal(result.content, "recorded");
});

test("Budget refuses a case that exceeds its cap", () => {
  const budget = new Budget(0.001, 1, 1);
  assert.throws(
    () => budget.spend({ prompt_tokens: 1000, completion_tokens: 1000 }),
    BudgetExceededError,
  );
});
