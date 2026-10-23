import {
  checkContentSafety,
  type BaselineComparison,
  type CaseState,
  type CriticObjection,
  type CriticResult,
  type Exhibit,
  type Hypothesis,
  type MemoryRecall,
} from "@exhibit-a/core";
import { chunkContext } from "@exhibit-a/engines";
import type { ChatRequest, ChatResult } from "@exhibit-a/llm";
import {
  emitComputedExhibit,
  type CounterfactualResult,
  type ToolRuntime,
} from "@exhibit-a/tools";

/**
 * The sample critic is a verified JSON-capable Nemotron model. Ultra is a
 * configurable live critic, but its OpenAI-compatible route currently emits
 * chain-of-thought instead of strict JSON for this prompt, so it is not used
 * for the committed replay. Set NIM_CRITIC_MODEL to choose a live model.
 */
export const SAMPLE_CRITIC_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";

/** A narrow interface so tests can exercise the critic without a network. */
export type CriticClient = {
  chat(request: ChatRequest): Promise<ChatResult>;
  readonly spend: {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    spent_usd: number;
  };
};

export type CriticEvidence = {
  tool: string;
  kind: string;
  title: string;
  result_sha256: string;
  summary: string;
};

export type CriticInput = {
  rt: ToolRuntime;
  state: CaseState;
  baseline: BaselineComparison;
  hypotheses: Hypothesis[];
  counterfactual?: CounterfactualResult;
  exhibits: Exhibit[];
  memory?: MemoryRecall;
  client?: CriticClient | null;
  model?: string | null;
};

type CriticPayload = {
  task: string;
  constraints: string[];
  case: {
    question: string;
    metric: string;
    sample_mode: boolean;
    onset: BaselineComparison["onset"];
  };
  hypotheses: { cause: string; status: string; note: string }[];
  counterfactual: CounterfactualResult | null;
  memory: { cold_start: boolean; hits: { case_id: string; match: string[]; verdict: string }[] };
  evidence: CriticEvidence[];
};

const MAX_CONTEXT_CHARS = 2500;

function evidenceSummary(exhibit: Exhibit): string {
  const result = exhibit.result as Record<string, unknown>;
  if (typeof result.row_count === "number") return `${result.row_count} rows`;
  if (typeof result.count === "number") return `${result.count} records`;
  if (typeof result.explained_share === "number") {
    return `explained ${(result.explained_share * 100).toFixed(1)}%`;
  }
  if (typeof result.replacement_concept === "string") {
    return `replacement ${result.replacement_concept}`;
  }
  if (Array.isArray(result.rows)) return `${result.rows.length} rows`;
  return "computed result";
}

function evidenceFor(exhibits: Exhibit[]): CriticEvidence[] {
  const wanted = new Set([
    "metric_history",
    "compare_to_baseline",
    "run_sql",
    "canonical_series",
    "counterfactual",
    "second_channel",
    "discover_sources",
  ]);
  return exhibits
    .filter((exhibit) => exhibit.tool && wanted.has(exhibit.tool))
    .map((exhibit) => ({
      tool: exhibit.tool as string,
      kind: exhibit.kind,
      title: exhibit.title,
      result_sha256: exhibit.result_sha256,
      summary: evidenceSummary(exhibit),
    }))
    .sort((a, b) => a.tool.localeCompare(b.tool) || a.title.localeCompare(b.title));
}

export function buildCriticRequest(input: {
  state: CaseState;
  baseline: BaselineComparison;
  hypotheses: Hypothesis[];
  counterfactual?: CounterfactualResult;
  exhibits: Exhibit[];
  memory?: MemoryRecall;
  model: string;
}): ChatRequest {
  const evidence = evidenceFor(input.exhibits);
  const context = chunkContext({
    maxChars: MAX_CONTEXT_CHARS,
    items: evidence.map((item) => ({
      id: `${item.tool}:${item.result_sha256.slice(0, 8)}`,
      kind: item.kind,
      text: `${item.title} — ${item.summary} — sha256 ${item.result_sha256}`,
    })),
  });
  const payload: CriticPayload = {
    task:
      "Act as Defense Counsel. Attack each claimed cause in this data-quality " +
      "adjudication. A useful objection names a missing control, an alternative " +
      "explanation, a stale source, a unit mismatch, or a citation that does not " +
      "support the claim. Do not make an investment recommendation.",
    constraints: [
      "The code gate is final; your critique cannot promote or block a cause.",
      "Only cite result_sha256 values listed in evidence.",
      "Return JSON only: {objections:[{claim,severity,exhibit_sha256}], summary}.",
      "severity is low, medium, or high.",
      "Do not invent a new fact or a new exhibit.",
      "This is a data-quality finding on public filings, not investment advice.",
    ],
    case: {
      question: input.state.question,
      metric: input.state.metric,
      sample_mode: input.state.sample_mode,
      onset: input.baseline.onset,
    },
    hypotheses: input.hypotheses.map((hypothesis) => ({
      cause: hypothesis.cause,
      status: hypothesis.status,
      note: hypothesis.note ?? hypothesis.statement,
    })),
    counterfactual: input.counterfactual ?? null,
    memory: {
      cold_start: input.memory?.cold_start ?? true,
      hits: (input.memory?.hits ?? []).map((hit) => ({
        case_id: hit.case_id,
        match: hit.match,
        verdict: hit.verdict_kind,
      })),
    },
    evidence,
  };
  return {
    agent: "DefenseCounsel",
    model: input.model,
    messages: [
      {
        role: "system",
        content:
          "You are Exhibit A's Defense Counsel. You critique evidence for a " +
          "data-quality finding. You never give investment advice and you never " +
          "change the deterministic verdict. Return strict JSON.",
      },
      {
        role: "user",
        content:
          JSON.stringify(payload, null, 2) +
          "\n\nBounded context (Markovian windows; use only the evidence list above):\n" +
          JSON.stringify(
            context.chunks.map((chunk) => ({
              key: chunk.key,
              item_ids: chunk.item_ids,
              chars: chunk.chars,
              previous: chunk.previous,
              next: chunk.next,
            })),
            null,
            2,
          ),
      },
    ],
    // Nemotron Ultra's OpenAI-compatible endpoint returns malformed content
    // when response_format=json_object is set on this route. The prompt still
    // demands strict JSON and parseObjections rejects anything else.
    json: false,
    temperature: 0,
    max_tokens: 900,
  };
}

function parseObjections(content: string): { objections: CriticObjection[]; summary: string } {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const raw = JSON.parse(cleaned) as {
    objections?: unknown;
    summary?: unknown;
  };
  const list = Array.isArray(raw.objections) ? raw.objections : [];
  const objections: CriticObjection[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      objections.push({ claim: item, severity: "medium" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as {
      claim?: unknown;
      severity?: unknown;
      exhibit_sha256?: unknown;
    };
    const claim = typeof row.claim === "string" ? row.claim.trim() : "";
    if (!claim) continue;
    const severity =
      row.severity === "low" || row.severity === "high" ? row.severity : "medium";
    objections.push({
      claim,
      severity,
      exhibit_sha256:
        typeof row.exhibit_sha256 === "string" ? row.exhibit_sha256 : undefined,
      resolved: false,
    });
  }
  return {
    objections,
    summary: typeof raw.summary === "string" ? raw.summary : "",
  };
}

function skipped(
  input: CriticInput,
  detail: string,
  status: "skipped" | "error",
): CriticResult {
  return {
    status,
    model: input.model ?? null,
    detail,
    content: "",
    objections: [],
    cited_unknown: [],
    unresolved: 0,
    unsafe: false,
    safety_findings: [],
    context_chunks: 0,
    context_chars: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    spend: input.client?.spend ?? {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      spent_usd: 0,
    },
  };
}

/**
 * Optional Nemotron critic. It is deliberately not on the fact path: a model
 * failure or an unsafe completion is logged and the deterministic gate still
 * decides. In SAMPLE_MODE the whole request is replayed from the cassette.
 */
export async function runCritic(input: CriticInput): Promise<{
  result: CriticResult;
  exhibit: Exhibit;
}> {
  const model = input.model ?? null;
  if (!input.client || !model) {
    const result = skipped(
      input,
      "model critique skipped (no NVIDIA_API_KEY/NIM model or no recorded model); code gate is final",
      "skipped",
    );
    const exhibit = emitCriticExhibit(input.rt, result, input);
    return { result, exhibit };
  }

  let request: ChatRequest;
  try {
    request = buildCriticRequest({
      state: input.state,
      baseline: input.baseline,
      hypotheses: input.hypotheses,
      counterfactual: input.counterfactual,
      exhibits: input.exhibits,
      memory: input.memory,
      model,
    });
  } catch (err) {
    const result = skipped(
      input,
      `model critique could not be prepared: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    const exhibit = emitCriticExhibit(input.rt, result, input);
    return { result, exhibit };
  }

  try {
    const reply = await input.client.chat(request);
    const parsed = parseObjections(reply.content);
    const known = new Set(evidenceFor(input.exhibits).map((item) => item.result_sha256));
    const citedUnknown = parsed.objections
      .map((objection) => objection.exhibit_sha256)
      .filter((sha): sha is string => Boolean(sha) && !known.has(sha!));
    const safety = checkContentSafety(reply.content);
    const result: CriticResult = {
      status: "ran",
      model: reply.model || model,
      detail:
        `${parsed.objections.length} objection(s)` +
        (parsed.summary ? `: ${parsed.summary.slice(0, 240)}` : "") +
        (citedUnknown.length ? `; ${citedUnknown.length} unknown citation(s)` : "") +
        (safety.ok ? "" : "; critique blocked by content-safety guard"),
      content: reply.content,
      objections: safety.ok ? parsed.objections : [],
      cited_unknown: citedUnknown,
      unresolved: safety.ok ? parsed.objections.length : 0,
      unsafe: !safety.ok,
      safety_findings: safety.findings,
      context_chunks: chunkContext({
        maxChars: MAX_CONTEXT_CHARS,
        items: evidenceFor(input.exhibits).map((item) => ({
          id: `${item.tool}:${item.result_sha256.slice(0, 8)}`,
          kind: item.kind,
          text: item.title,
        })),
      }).chunk_count,
      context_chars: evidenceFor(input.exhibits).reduce(
        (sum, item) => sum + item.title.length,
        0,
      ),
      usage: reply.usage,
      spend: input.client.spend,
    };
    const exhibit = emitCriticExhibit(input.rt, result, input);
    return { result, exhibit };
  } catch (err) {
    const result = skipped(
      input,
      `model critique failed; code gate is final: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    const exhibit = emitCriticExhibit(input.rt, result, input);
    return { result, exhibit };
  }
}

function emitCriticExhibit(rt: ToolRuntime, result: CriticResult, input: CriticInput): Exhibit {
  return emitComputedExhibit({
    rt,
    tool: "critic",
    kind: "critic",
    title: `Defense Counsel critique (${result.status})`,
    args: {
      model: input.model ?? null,
      sample_mode: rt.sampleMode,
      evidence_sha256: evidenceFor(input.exhibits).map((item) => item.result_sha256),
    },
    result: result as unknown as Record<string, unknown>,
    source: "nvidia-nim",
  });
}
