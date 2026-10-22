import { advance, emitTrace, type CaseState, type Exhibit } from "@exhibit-a/core";
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
  duplicationSql,
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
import { assessHypotheses, draftHypotheses, type EvidenceRefs } from "./hypotheses.ts";

const CIK_FILTER = EDGAR_COMPANIES.map((company) => company.cik);
const APPLE = EDGAR_COMPANIES[0];

export type InvestigationOptions = {
  root: string;
  state: CaseState;
  rt: ToolRuntime;
  viewSql: string;
  grain?: string;
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
  };

  hypotheses = assessHypotheses(hypotheses, {
    baseline: baseline.comparison,
    coverage: readCoverage(coverageResult.result),
    duplication: readDuplication(duplicationResult.result),
    buckets: readBuckets(bucketResult.result),
    canonical: canonical.series,
    frames: frames.map((frame) => ({ period: frame.period, result: frame.result })),
    appleConcept: appleConcept.result as SecCompanyConceptResult,
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
  const critiqueConfigured = Boolean(
    process.env.NVIDIA_API_KEY &&
      (process.env.NIM_CRITIC_MODEL ?? process.env.NIM_LEAD_MODEL),
  );
  emitTrace(input.root, {
    case_id: state.id,
    agent_name: "DefenseCounsel",
    action: "critic.review",
    input_summary: cf
      ? `counterfactual explains ${(cf.result.explained_share * 100).toFixed(1)}%`
      : "no counterfactual available",
    output_summary: critiqueConfigured
      ? "model critique configured; code gate is final"
      : "model critique skipped (no key or model); code gate is final",
    status: "success",
    latency_ms: 0,
    exhibit_ids: cf ? [cf.exhibit.id] : [],
  });

  const adjudication = cf
    ? adjudicate({
        root: input.root,
        state: { ...state, hypotheses, exhibits },
        baseline: baseline.comparison,
        exhibits,
        counterfactual: cf.result,
      })
    : undefined;
  state = advance(state, "ADJUDICATED");

  emitTrace(input.root, {
    case_id: state.id,
    agent_name: "LeadInvestigator",
    action: "adjudicate",
    input_summary: `${hypotheses.length} hypotheses, ${exhibits.length} exhibits`,
    output_summary: adjudication
      ? `${adjudication.verdict.kind} ${adjudication.verdict.causes
          .map((row) => `${row.cause}=${(row.share * 100).toFixed(1)}%`)
          .join(", ")}`
      : "INSUFFICIENT_EVIDENCE (no counterfactual)",
    status: "success",
    latency_ms: 0,
    exhibit_ids: adjudication?.verdict.exhibit_ids ?? [],
  });

  return {
    ...state,
    exhibits,
    hypotheses,
    baseline: baseline.comparison,
    verdict:
      adjudication?.verdict ??
      {
        kind: "INSUFFICIENT_EVIDENCE",
        causes: [],
        exhibit_ids: [],
        notes: ["no onset outside the baseline band; nothing to adjudicate"],
      },
  };
}
