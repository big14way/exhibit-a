import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createExhibit,
  sha256Json,
  type CaseState,
  type Exhibit,
} from "@exhibit-a/core";
import type { ChatRequest, ChatResult } from "@exhibit-a/llm";
import type { CounterfactualResult, ToolRuntime } from "@exhibit-a/tools";
import {
  buildCriticRequest,
  runCritic,
  type CriticClient,
} from "./critic.ts";

process.env.EXHIBIT_A_QUIET = "1";

function fixture() {
  const caseId = "case_critic_test";
  const exhibits: Exhibit[] = [
    createExhibit({
      kind: "profile",
      source: "code",
      transport: "code",
      title: "counterfactual Manufacturing 2018",
      tool: "counterfactual",
      args: {},
      result: {
        explained_share: 0.96168,
        unexplained_share: 0.03832,
    corrected_direction: "same",
      },
      case_id: caseId,
      agent: "LeadInvestigator",
    }),
    createExhibit({
      kind: "second_channel",
      source: "sec",
      transport: "sec-api",
      title: "SEC frames parity",
      tool: "second_channel",
      args: {},
      result: { rows: [] },
      case_id: caseId,
      agent: "SourceScout",
    }),
    createExhibit({
      kind: "discovery",
      source: "sec",
      transport: "sec-api",
      title: "discover replacement concept",
      tool: "discover_sources",
      args: {},
      result: {
        replacement_concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
      },
      case_id: caseId,
      agent: "SourceScout",
    }),
  ];
  const state: CaseState = {
    id: caseId,
    reported_at: "2026-10-22T00:00:00.000Z",
    question: "is the FY2018 jump real?",
    metric: "analytics.sector_revenue_by_year",
    stage: "EVIDENCE",
    sample_mode: true,
    exhibits,
    hypotheses: [],
  };
  const baseline = {
    metric: "analytics.sector_revenue_by_year",
    grain: "fiscal_year",
    band: { lo: -0.15, hi: 0.15 },
    onset: {
      segment: "Manufacturing",
      period: 2018,
      prior_period: 2017,
      value: 2750941773000,
      prior_value: 1455942689000,
      ratio: 1.889,
      delta: 1294999084000,
    },
    segments: 3,
    periods: 4,
    explanation: "Manufacturing moved 88.9%",
  };
  const counterfactual: CounterfactualResult = {
    metric: baseline.metric,
    segment: "Manufacturing",
    prior_period: 2017,
    onset_period: 2018,
    corrected_direction: "same",
    naive_delta: 1294999084000,
    corrected_prior: 1455942689000,
    corrected_now: 1511000000000,
    corrected_delta: 55057311000,
    explained_share: 0.96168,
    unexplained_share: 0.03832,
    rule: "explained share = 1 - corrected / reported",
  };
  const hypotheses = [
    {
      id: "h1",
      statement: "filing year duplication",
      cause: "filing_year_duplication",
      blamed: [],
      status: "confirmed" as const,
      exhibit_ids: [exhibits[0]!.id],
      note: "100 rows across 32 dates",
    },
  ];
  return { caseId, exhibits, state, baseline, counterfactual, hypotheses };
}

function rt(root: string, caseId: string): ToolRuntime {
  return { root, caseId, agent: "DefenseCounsel", sampleMode: true };
}

function client(content: string): CriticClient {
  return {
    async chat(request: ChatRequest): Promise<ChatResult> {
      return {
        content,
        tool_calls: [],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
        model: request.model,
      };
    },
    spend: { calls: 1, input_tokens: 100, output_tokens: 20, spent_usd: 0 },
  };
}

test("the critic request is deterministic and excludes ids/timestamps", () => {
  const f = fixture();
  const a = buildCriticRequest({
    state: f.state,
    baseline: f.baseline,
    hypotheses: f.hypotheses,
    counterfactual: f.counterfactual,
    exhibits: f.exhibits,
    model: "test-model",
  });
  const b = buildCriticRequest({
    state: f.state,
    baseline: f.baseline,
    hypotheses: f.hypotheses,
    counterfactual: f.counterfactual,
    exhibits: f.exhibits,
    model: "test-model",
  });
  assert.equal(sha256Json(a), sha256Json(b));
  assert.doesNotMatch(a.messages[1]!.content, /ex_[a-f0-9]{16}/);
  assert.doesNotMatch(a.messages[1]!.content, /2026-10-22T/);
  assert.equal(a.json, false);
});

test("a model critique records objections and unknown citations without changing the gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "exhibit-a-critic-"));
  const f = fixture();
  try {
    const result = await runCritic({
      rt: rt(root, f.caseId),
      state: f.state,
      baseline: f.baseline,
      hypotheses: f.hypotheses,
      counterfactual: f.counterfactual,
      exhibits: f.exhibits,
      client: client(
        JSON.stringify({
          objections: [
            {
              claim: "The counterfactual may miss a unit change.",
              severity: "high",
              exhibit_sha256: "deadbeef",
            },
          ],
          summary: "One control is missing.",
        }),
      ),
      model: "test-model",
    });
    assert.equal(result.result.status, "ran");
    assert.equal(result.result.objections.length, 1);
    assert.deepEqual(result.result.cited_unknown, ["deadbeef"]);
    assert.equal(result.result.unsafe, false);
    assert.equal(result.exhibit.kind, "critic");
    assert.equal(result.result.usage.completion_tokens, 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe model prose is blocked and its objections are discarded", async () => {
  const root = mkdtempSync(join(tmpdir(), "exhibit-a-critic-safety-"));
  const f = fixture();
  try {
    const result = await runCritic({
      rt: rt(root, f.caseId),
      state: f.state,
      baseline: f.baseline,
      hypotheses: f.hypotheses,
      counterfactual: f.counterfactual,
      exhibits: f.exhibits,
      client: client(
        JSON.stringify({
          objections: [{ claim: "This is a strong buy.", severity: "high" }],
          summary: "Buy the stock now.",
        }),
      ),
      model: "test-model",
    });
    assert.equal(result.result.status, "ran");
    assert.equal(result.result.unsafe, true);
    assert.equal(result.result.objections.length, 0);
    assert.ok(result.result.safety_findings.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the critic skips cleanly without a client", async () => {
  const root = mkdtempSync(join(tmpdir(), "exhibit-a-critic-skip-"));
  const f = fixture();
  try {
    const result = await runCritic({
      rt: rt(root, f.caseId),
      state: f.state,
      baseline: f.baseline,
      hypotheses: f.hypotheses,
      counterfactual: f.counterfactual,
      exhibits: f.exhibits,
      client: null,
      model: null,
    });
    assert.equal(result.result.status, "skipped");
    assert.match(result.result.detail, /code gate is final/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
