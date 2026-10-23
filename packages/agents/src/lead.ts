import {
  advance,
  checkContentSafety,
  emitTrace,
  safetyText,
  type CaseState,
  type CriticResult,
  type Exhibit,
  type MemoryRecall,
  type SafetyResult,
} from "@exhibit-a/core";
import { recallMemory } from "@exhibit-a/engines";
import { NimClient } from "@exhibit-a/llm";
import {
  EDGAR_COMPANIES,
  bucketSql,
  canonicalFactsSql,
  canonicalSeries,
  catalogSearch,
  companyBucketsSql,
  compareToBaseline,
  counterfactual,
  describeObject,
  discoverSources,
  duplicationSql,
  emitComputedExhibit,
  inferLineage,
  metricHistory,
  readBuckets,
  readCoverage,
  readDuplication,
  runSql,
  secCompanyConceptArgs,
  secFramesArgs,
  secondChannel,
  type SecCompanyConceptResult,
  type SecFramesResult,
  type ToolRuntime,
} from "@exhibit-a/tools";
import { adjudicate } from "./adjudicate.ts";
import {
  SAMPLE_CRITIC_MODEL,
  runCritic,
  type CriticClient,
} from "./critic.ts";
import { assessHypotheses, draftHypotheses, type EvidenceRefs } from "./hypotheses.ts";
import { runRepair } from "./repair.ts";

const CIK_FILTER = EDGAR_COMPANIES.map((company) => company.cik);
const APPLE = EDGAR_COMPANIES[0];

export type InvestigationOptions = {
  root: string;
  state: CaseState;
  rt: ToolRuntime;
  viewSql: string;
  grain?: string;
  /** Test/recording hook. Omit to use the configured NIM client. */
  critic?: { client?: CriticClient | null; model?: string | null };
};

/**
 * Day-2 deterministic investigator. Tool activity drives every state
 * transition; no model prose can create an exhibit or a hypothesis status.
 * The NIM planner attaches at the hypothesis step later without changing this
 * evidence path.
 */
export async function runInvestigation(
  input: InvestigationOptions,
): Promise<CaseState> {
  const rt = input.rt;
  const grain = input.grain ?? "fiscal_year";
  const exhibits: Exhibit[] = [];
  let state = advance(input.state, "SCOPING");

  rt.agent = "LeadInvestigator";
  const memory = recallMemory(input.root, {
    metric: state.metric,
    question: state.question,
    limit: 5,
  });
  state = { ...state, memory };
  const memoryExhibit = emitMemoryExhibit(rt, memory);
  exhibits.push(memoryExhibit);
  emitTrace(input.root, {
    case_id: state.id,
    agent_name: rt.agent,
    action: "hmem.recall",
    input_summary: `${state.metric}: ${state.question}`,
    output_summary:
      `${memory.records} memories, ${memory.hits.length} hit(s)` +
      (memory.cold_start ? " (cold start)" : ""),
    status: "success",
    latency_ms: 0,
    exhibit_ids: [memoryExhibit.id],
  });

  const catalog = await catalogSearch(rt, state.metric);
  const described = await describeObject(rt, state.metric);
  exhibits.push(catalog.exhibit, described.exhibit);

  state = advance(state, "LINEAGE");
  rt.agent = "SourceScout";
  const lineage = await inferLineage(rt, state.metric, input.viewSql);
  exhibits.push(...lineage.exhibits);

  const discovery = await discoverSources(rt, {
    kind: "sec_companyfacts",
    cik: APPLE.cik,
    entity_name: APPLE.entity_name,
    concept: "Revenues",
    sic_division: APPLE.sic_division,
  });
  state = { ...state, discovery: discovery.result };
  exhibits.push(discovery.exhibit);

  state = advance(state, "BASELINED");
  rt.agent = "LeadInvestigator";
  const history = await metricHistory(rt, state.metric, grain);
  const baseline = compareToBaseline(rt, { view: state.metric, grain, history });
  exhibits.push(history.exhibit, baseline.exhibit);

  state = advance(state, "HYPOTHESES");
  let hypotheses = draftHypotheses(state.metric, baseline.comparison);
  emitTrace(input.root, {
    case_id: state.id,
    agent_name: rt.agent,
    action: "hypotheses.draft",
    input_summary: `${state.metric} onset ${baseline.comparison.onset?.period ?? "none"}`,
    output_summary: `${hypotheses.length} hypotheses`,
    status: "success",
    latency_ms: 0,
    exhibit_ids: [baseline.exhibit.id],
  });

  state = advance(state, "EVIDENCE");
  const coverageResult = await runSql(rt, companyBucketsSql(), "company coverage by fiscal year");
  const duplicationResult = await runSql(rt, duplicationSql(), "duplicate rows per company");
  const bucketResult = await runSql(rt, bucketSql(), "fiscal-year bucket profile");
  const canonicalResult = await runSql(
    rt,
    canonicalFactsSql(
      rt.sampleMode ? undefined : process.env.ZETARIS_SIC_TABLE || undefined,
    ),
    "annual fact rows for the corrected series",
  );
  const canonical = canonicalSeries(rt, canonicalResult);
  exhibits.push(
    coverageResult.exhibit,
    duplicationResult.exhibit,
    bucketResult.exhibit,
    canonicalResult.exhibit,
    canonical.exhibit,
  );

  const onset = baseline.comparison.onset;
  const periods = onset
    ? [`CY${onset.prior_period}`, `CY${onset.period}`]
    : ["CY2017", "CY2018"];
  const frames: { period: string; result: SecFramesResult; exhibit: Exhibit }[] = [];
  for (const period of periods) {
    rt.agent = "SourceScout";
    const channel = await secondChannel(rt, secFramesArgs(period, [...CIK_FILTER]));
    frames.push({
      period,
      result: channel.result as SecFramesResult,
      exhibit: channel.exhibit,
    });
    exhibits.push(channel.exhibit);
  }
  const appleConcept = await secondChannel(rt, secCompanyConceptArgs(APPLE.cik));
  exhibits.push(appleConcept.exhibit);

  const refs: EvidenceRefs = {
    lineageSources: lineage.exhibits[0]?.id ?? "",
    lineageColumns: lineage.exhibits[1]?.id ?? "",
    history: history.exhibit.id,
    baseline: baseline.exhibit.id,
    companyBuckets: coverageResult.exhibit.id,
    duplication: duplicationResult.exhibit.id,
    buckets: bucketResult.exhibit.id,
    canonical: canonical.exhibit.id,
    frames: Object.fromEntries(frames.map((frame) => [frame.period, frame.exhibit.id])),
    appleConcept: appleConcept.exhibit.id,
    discovery: discovery.exhibit.id,
  };

  hypotheses = assessHypotheses(hypotheses, {
    baseline: baseline.comparison,
    coverage: readCoverage(coverageResult.result),
    duplication: readDuplication(duplicationResult.result),
    buckets: readBuckets(bucketResult.result),
    canonical: canonical.series,
    frames: frames.map((frame) => ({ period: frame.period, result: frame.result })),
    appleConcept: appleConcept.result as SecCompanyConceptResult,
    discovery: discovery.result,
    refs,
  });

  rt.agent = "LeadInvestigator";
  emitTrace(input.root, {
    case_id: state.id,
    agent_name: rt.agent,
    action: "hypotheses.assess",
    input_summary: `${hypotheses.length} hypotheses, ${exhibits.length} exhibits`,
    output_summary: hypotheses.map((row) => `${row.cause}:${row.status}`).join(", "),
    status: "success",
    latency_ms: 0,
    exhibit_ids: hypotheses.flatMap((row) => row.exhibit_ids),
  });

  const cf = counterfactual(rt, {
    baseline: baseline.comparison,
    canonical: canonical.series,
    canonicalExhibit: canonical.exhibit,
  });
  if (cf) exhibits.push(cf.exhibit);

  state = advance(state, "CRITIQUED");
  const criticTarget = input.critic ?? criticClientFor(rt);
  const critique = await runCritic({
    rt,
    state: { ...state, hypotheses, exhibits, memory },
    baseline: baseline.comparison,
    hypotheses,
    counterfactual: cf?.result,
    exhibits,
    memory,
    client: criticTarget.client,
    model: criticTarget.model,
  });
  state = { ...state, critic: critique.result };
  exhibits.push(critique.exhibit);
  emitTrace(input.root, {
    case_id: state.id,
    agent_name: "DefenseCounsel",
    action: "critic.review",
    input_summary: cf
      ? `counterfactual explains ${(cf.result.explained_share * 100).toFixed(1)}%`
      : "no counterfactual available",
    output_summary: critique.result.detail,
    status: critique.result.status === "error" ? "error" : "success",
    latency_ms: 0,
    exhibit_ids: [critique.exhibit.id],
    model: critique.result.model,
    tokens_in: critique.result.usage.prompt_tokens,
    tokens_out: critique.result.usage.completion_tokens,
  });

  const adjudication = cf
    ? adjudicate({
        root: input.root,
        state: { ...state, hypotheses, exhibits },
        baseline: baseline.comparison,
        exhibits,
        counterfactual: cf.result,
        critic: critique.result,
      })
    : undefined;

  let verdict =
    adjudication?.verdict ??
    {
      kind: "INSUFFICIENT_EVIDENCE" as const,
      causes: [],
      exhibit_ids: [],
      notes: ["no onset outside the baseline band; nothing to adjudicate"],
    };

  rt.agent = "SafetyGuard";
  const safetyInput = safetyText(
    state.question,
    ...hypotheses.map((hypothesis) => hypothesis.note ?? hypothesis.statement),
    ...(verdict.notes ?? []),
    critique.result.content,
  );
  const safety = checkContentSafety(safetyInput);
  if (!safety.ok) {
    verdict = {
      ...verdict,
      kind: "INSUFFICIENT_EVIDENCE",
      notes: [
        ...(verdict.notes ?? []),
        "Content-safety guard blocked generated prose: " +
          safety.findings.map((finding) => finding.rule).join(", "),
      ],
    };
  }
  const safetyExhibit = emitComputedSafetyExhibit(rt, safety, safetyInput);
  exhibits.push(safetyExhibit);
  state = { ...state, safety, verdict };
  state = advance(state, "ADJUDICATED");

  emitTrace(input.root, {
    case_id: state.id,
    agent_name: "LeadInvestigator",
    action: "adjudicate",
    input_summary: `${hypotheses.length} hypotheses, ${exhibits.length} exhibits`,
    output_summary: adjudication
      ? `${verdict.kind} ${verdict.causes
          .map((row) => `${row.cause}=${(row.share * 100).toFixed(1)}%`)
          .join(", ")}`
      : "INSUFFICIENT_EVIDENCE (no counterfactual)",
    status: "success",
    latency_ms: 0,
    exhibit_ids: adjudication?.verdict.exhibit_ids ?? [],
  });

  // Only an artifact-bearing verdict has a repair to test. A real-change or
  // insufficient-evidence case stops at adjudication; it must not invent a fix.
  if (
    cf &&
    adjudication &&
    (verdict.kind === "DATA_ARTIFACT" || verdict.kind === "MIXED")
  ) {
    const repairRun = await runRepair({
      root: input.root,
      state: { ...state, hypotheses, exhibits },
      rt,
      metric: state.metric,
      baseline: baseline.comparison,
      counterfactual: cf.result,
      history,
      canonicalFacts: canonicalResult,
      canonicalSeries: canonical.series,
      frames,
    });
    state = repairRun.state;
    exhibits.push(...repairRun.exhibits);
  }

  return {
    ...state,
    exhibits,
    hypotheses,
    baseline: baseline.comparison,
    verdict,
  };
}

function emitMemoryExhibit(rt: ToolRuntime, memory: MemoryRecall): Exhibit {
  return emitComputedExhibit({
    rt,
    tool: "memory_recall",
    kind: "memory",
    title: memory.cold_start
      ? "H-MEM recall (cold start)"
      : `H-MEM recall (${memory.hits.length} hit${memory.hits.length === 1 ? "" : "s"})`,
    args: {
      metric: memory.query.metric,
      question: memory.query.question,
      implementation: "packages/engines H-MEM reference",
    },
    result: {
      ...memory,
      implementation: "H-MEM reference (Meterless contract; local JSON index)",
    } as unknown as Record<string, unknown>,
    source: "hmem",
  });
}

function emitComputedSafetyExhibit(
  rt: ToolRuntime,
  safety: SafetyResult,
  checkedText: string,
): Exhibit {
  return emitComputedExhibit({
    rt,
    tool: "safety",
    kind: "safety",
    title: safety.ok ? "content-safety guard pass" : "content-safety guard blocked prose",
    args: { policy: safety.policy, text: checkedText },
    result: safety as unknown as Record<string, unknown>,
    source: "safety",
  });
}

function criticClientFor(rt: ToolRuntime): {
  client: CriticClient | null;
  model: string | null;
} {
  if (rt.sampleMode) {
    if (!rt.cassette?.models?.length) return { client: null, model: null };
    return {
      client: new NimClient({
        apiKey: "sample-replay",
        baseUrl: "https://sample.invalid/v1",
        cassette: rt.cassette,
      }),
      model: SAMPLE_CRITIC_MODEL,
    };
  }
  const model = process.env.NIM_CRITIC_MODEL ?? process.env.NIM_LEAD_MODEL ?? null;
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey || !model) return { client: null, model };
  return {
    client: new NimClient({
      apiKey,
      baseUrl: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    }),
    model,
  };
}
