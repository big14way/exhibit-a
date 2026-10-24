import {
  advance,
  checkContentSafety,
  combineSafety,
  emitTrace,
  safetyText,
  summarizeVerdict,
  type CaseState,
  type Exhibit,
  type MemoryRecall,
  type SafetyResult,
  type SqlResult,
} from "@exhibit-a/core";
import { recallMemorySemantic, type MemoryEmbedder } from "@exhibit-a/engines";
import { NimClient, SAMPLE_SAFETY_MODEL, runSafetyModel } from "@exhibit-a/llm";
import {
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
  metricSpec,
  nimClientFor,
  readBuckets,
  readCoverage,
  readDuplication,
  runSql,
  secCompanyConceptArgs,
  secFramesArgs,
  secondChannel,
  segmentsByCik,
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
import {
  assessHypotheses,
  draftHypotheses,
  profileFilers,
  selectFilers,
  type EvidenceRefs,
} from "./hypotheses.ts";
import { runRepair } from "./repair.ts";

export const SAMPLE_EMBED_MODEL = "nvidia/nemotron-3.5-embed-1b";


export type ModelRole = "critic" | "safety" | "embed";

export type InvestigationOptions = {
  root: string;
  state: CaseState;
  rt: ToolRuntime;
  viewSql: string;
  grain?: string;
  /** Test/recording hook. Omit to use the configured NIM client. */
  critic?: { client?: CriticClient | null; model?: string | null };
  /** Test/recording hook for the content-safety role. */
  safety?: { client?: CriticClient | null; model?: string | null };
  /** Test/recording hook for the H-MEM embedding role. */
  embed?: { client?: MemoryEmbedder | null };
};

/**
 * Deterministic investigator. Tool activity drives every state transition;
 * no model prose can create an exhibit or a hypothesis status. The three
 * Nemotron roles (embedding recall, Defense Counsel, content safety) attach
 * at the edges and are replayed from the cassette in SAMPLE_MODE.
 */
export async function runInvestigation(
  input: InvestigationOptions,
): Promise<CaseState> {
  const rt = input.rt;
  const grain = input.grain ?? "fiscal_year";
  const spec = metricSpec(input.state.metric);
  const exhibits: Exhibit[] = [];
  let state = advance(input.state, "SCOPING");

  rt.agent = "LeadInvestigator";
  const embedder = input.embed ? input.embed.client ?? null : embedderFor(rt);
  const memory = await recallMemorySemantic(
    input.root,
    { metric: state.metric, question: state.question, limit: 5 },
    embedder,
  );
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
      (memory.cold_start ? " (cold start)" : "") +
      (memory.embedding?.status === "ran"
        ? `; ${memory.embedding.model} embeddings (${memory.embedding.dims} dims)`
        : memory.embedding
          ? `; embeddings ${memory.embedding.status}`
          : ""),
    status: "success",
    latency_ms: 0,
    exhibit_ids: [memoryExhibit.id],
    model: memory.embedding?.status === "ran" ? memory.embedding.model : null,
    tokens_in: memory.embedding?.usage.prompt_tokens ?? 0,
  });

  const catalog = await catalogSearch(rt, state.metric);
  const described = await describeObject(rt, state.metric);
  exhibits.push(catalog.exhibit, described.exhibit);

  state = advance(state, "LINEAGE");
  rt.agent = "SourceScout";
  const lineage = await inferLineage(rt, state.metric, input.viewSql);
  exhibits.push(...lineage.exhibits);

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
  const coverageResult = await runSql(rt, companyBucketsSql(spec.tables), "company coverage by fiscal year");
  const duplicationResult = await runSql(rt, duplicationSql(spec.tables), "duplicate rows per company");
  const bucketResult = await runSql(
    rt,
    bucketSql(spec.window.from, spec.window.to, spec.tables),
    "fiscal-year bucket profile",
  );
  const canonicalResult = await runSql(
    rt,
    canonicalFactsSql(
      rt.sampleMode ? undefined : process.env.ZETARIS_SIC_TABLE || undefined,
      spec.tables,
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

  // The filers the evidence points at. Nothing here names a company: the
  // selection is a function of the coverage rows and the onset period.
  const onset = baseline.comparison.onset;
  const coverage = readCoverage(coverageResult.result);
  const filers = profileFilers(coverage);
  const periods = onset
    ? [`CY${onset.prior_period}`, `CY${onset.period}`]
    : lastTwoPeriods(history.result, grain).map((period) => `CY${period}`);
  const selection = onset
    ? selectFilers(filers, Number(onset.period), Number(onset.prior_period))
    : selectFilers(filers, Number(periods[1]?.slice(2)), Number(periods[0]?.slice(2)));
  const focus = selection.focus;
  emitTrace(input.root, {
    case_id: state.id,
    agent_name: rt.agent,
    action: "evidence.select_filers",
    input_summary: `${filers.length} filers in coverage; onset ${onset?.period ?? "none"}`,
    output_summary:
      `focus ${focus?.entity_name ?? "none"}` +
      (selection.newcomer ? ` (first appears in ${onset?.period})` : "") +
      (selection.stopped ? `; history stops: ${selection.stopped.entity_name} (${selection.stopped.last_year})` : ""),
    status: "success",
    latency_ms: 0,
    exhibit_ids: [coverageResult.exhibit.id],
  });

  rt.agent = "SourceScout";
  const discovery =
    focus && onset
      ? await discoverSources(rt, {
          kind: "sec_companyfacts",
          cik: focus.cik,
          entity_name: focus.entity_name,
          concept: spec.concept,
          sic_division: onset.segment,
          ...(spec.concept === "Revenues" ? {} : { concept_family: spec.concept }),
        })
      : undefined;
  if (discovery) {
    state = { ...state, discovery: discovery.result };
    exhibits.push(discovery.exhibit);
  }

  const frames: { period: string; result: SecFramesResult; exhibit: Exhibit }[] = [];
  const cikFilter = filers.map((filer) => filer.cik);
  for (const period of periods) {
    const channel = await secondChannel(rt, secFramesArgs(period, cikFilter, spec.concept));
    frames.push({
      period,
      result: channel.result as SecFramesResult,
      exhibit: channel.exhibit,
    });
    exhibits.push(channel.exhibit);
  }
  const concept = focus
    ? await secondChannel(rt, secCompanyConceptArgs(focus.cik, spec.concept))
    : undefined;
  if (concept) exhibits.push(concept.exhibit);

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
    concept: concept?.exhibit.id,
    discovery: discovery?.exhibit.id,
  };

  hypotheses = assessHypotheses(hypotheses, {
    baseline: baseline.comparison,
    coverage,
    duplication: readDuplication(duplicationResult.result),
    buckets: readBuckets(bucketResult.result),
    canonical: canonical.series,
    frames: frames.map((frame) => ({ period: frame.period, result: frame.result })),
    concept: concept?.result as SecCompanyConceptResult | undefined,
    discovery: discovery?.result,
    segmentOf: segmentsByCik(canonicalResult.result),
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
  const criticTarget = input.critic ?? modelRoleFor(rt, "critic");
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

  // Content safety runs twice over the generated finding: the deterministic
  // lexical guard always, and the Nemotron content-safety model when it is
  // configured or recorded. Either layer can withhold the finding.
  rt.agent = "SafetyGuard";
  const finding = findingText({
    verdict: summarizeVerdict(verdict),
    hypotheses: hypotheses.map((hypothesis) => hypothesis.note ?? hypothesis.statement),
    notes: verdict.notes ?? [],
  });
  const safetyInput = safetyText(state.question, finding, critique.result.content);
  const lexical = checkContentSafety(safetyInput);
  const safetyTarget = input.safety ?? modelRoleFor(rt, "safety");
  const model = await runSafetyModel({
    client: safetyTarget.client ?? null,
    model: safetyTarget.model ?? null,
    question: state.question,
    finding,
  });
  const safety = combineSafety(lexical, model);
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
  const safetyExhibit = emitComputedSafetyExhibit(rt, safety, {
    text: safetyInput,
    question: state.question,
    finding,
  });
  exhibits.push(safetyExhibit);
  emitTrace(input.root, {
    case_id: state.id,
    agent_name: rt.agent,
    action: "safety.guard",
    input_summary: `${safetyInput.length} chars`,
    output_summary:
      `lexical ${lexical.ok ? "pass" : "block"}; model ${model.status}` +
      (model.status === "ran" ? ` (${model.detail})` : ""),
    status: safety.ok ? "success" : "error",
    latency_ms: 0,
    exhibit_ids: [safetyExhibit.id],
    model: model.status === "ran" ? model.model : null,
    tokens_in: model.usage.prompt_tokens,
    tokens_out: model.usage.completion_tokens,
  });
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

/** The human-readable finding that the safety layers check. Deterministic. */
export function findingText(input: {
  verdict: string;
  hypotheses: string[];
  notes: string[];
}): string {
  return [
    `Verdict: ${input.verdict}`,
    ...input.hypotheses.map((note) => `- ${note}`),
    ...input.notes.map((note) => `Note: ${note}`),
  ].join("\n");
}

function lastTwoPeriods(history: SqlResult, grain: string): (string | number)[] {
  const index = history.columns.indexOf(grain);
  if (index < 0) return [];
  const periods = [...new Set(history.rows.map((row) => String(row[index])))].sort();
  return periods.slice(-2);
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
      embedding_model: memory.embedding?.model ?? null,
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
  checked: { text: string; question: string; finding: string },
): Exhibit {
  return emitComputedExhibit({
    rt,
    tool: "safety",
    kind: "safety",
    title: safety.ok ? "content-safety guard pass" : "content-safety guard blocked prose",
    args: {
      policy: safety.policy,
      text: checked.text,
      model: safety.model?.status === "ran" ? safety.model.model : null,
      question: checked.question,
      finding: checked.finding,
    },
    result: safety as unknown as Record<string, unknown>,
    source: safety.model?.status === "ran" ? "safety+nvidia-nim" : "safety",
  });
}

/**
 * Model ids are configured, never guessed. SAMPLE_MODE replays the recorded
 * responses for the three roles; live mode reads each role's env variable.
 */
export function modelRoleFor(
  rt: ToolRuntime,
  role: ModelRole,
): { client: CriticClient | null; model: string | null } {
  if (rt.sampleMode) {
    const client = nimClientFor(rt);
    const model =
      role === "critic" ? SAMPLE_CRITIC_MODEL : role === "safety" ? SAMPLE_SAFETY_MODEL : SAMPLE_EMBED_MODEL;
    return { client, model: client ? model : null };
  }
  const model =
    role === "critic"
      ? process.env.NIM_CRITIC_MODEL ?? process.env.NIM_LEAD_MODEL ?? null
      : role === "safety"
        ? process.env.NIM_SAFETY_MODEL ?? null
        : process.env.NIM_EMBED_MODEL ?? null;
  const client = model ? nimClientFor(rt) : null;
  return { client, model: client ? model : null };
}

function embedderFor(rt: ToolRuntime): MemoryEmbedder | null {
  const { client, model } = modelRoleFor(rt, "embed");
  if (!client || !model) return null;
  const nim = client as NimClient;
  return { model, embed: (request) => nim.embed(request) };
}
