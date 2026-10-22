import {
  advance,
  emitTrace,
  verifyContract,
  type BaselineComparison,
  type CaseState,
  type Exhibit,
  type SqlResult,
} from "@exhibit-a/core";
import {
  buildRepairPlan,
  emitComputedExhibit,
  ensureShadowView,
  executeSqlTool,
  metricHistory,
  repairContractSecret,
  shadowReadSql,
  verifyRepair,
  type CanonicalSeries,
  type CounterfactualResult,
  type SecFramesResult,
  type ToolRuntime,
} from "@exhibit-a/tools";

export type RepairOptions = {
  root: string;
  state: CaseState;
  rt: ToolRuntime;
  metric: string;
  baseline: BaselineComparison;
  counterfactual: CounterfactualResult;
  history: { exhibit: Exhibit; result: SqlResult };
  canonicalFacts: { exhibit: Exhibit; result: SqlResult };
  canonicalSeries: CanonicalSeries;
  frames: { period: string; result: SecFramesResult; exhibit: Exhibit }[];
};

export type RepairRun = {
  state: CaseState;
  exhibits: Exhibit[];
};

/**
 * Propose a deduplicating replacement, write it only to an isolated shadow
 * container under a signed contract, then run invariants against the shadow.
 * The reported view is read again and must hash identically after the write.
 */
export async function runRepair(input: RepairOptions): Promise<RepairRun> {
  const rt = input.rt;
  const secret = repairContractSecret(rt.sampleMode);
  const { plan, contract } = buildRepairPlan({
    stateId: input.state.id,
    metric: input.metric,
    baseline: input.baseline,
    sampleMode: rt.sampleMode,
    secret,
  });

  let state = advance(input.state, "REPAIR_PROPOSED");
  state = { ...state, repair: plan, contract };
  emitTrace(input.root, {
    case_id: state.id,
    agent_name: "RepairEngineer",
    action: "repair.propose",
    input_summary: `${input.metric} -> ${plan.corrected_metric}`,
    output_summary: `shadow ${plan.shadow_metric}; contract ${contract.id}`,
    status: "success",
    latency_ms: 0,
    exhibit_ids: [],
  });

  rt.agent = "RepairEngineer";
  await ensureShadowView({ rt, plan, contract, secret });

  const contractExhibit = emitComputedExhibit({
    rt,
    tool: "write_contract",
    kind: "writeback",
    title: `signed shadow contract ${contract.id}`,
    args: { contract, sample_mode: rt.sampleMode },
    result: {
      contract_id: contract.id,
      scope: contract.scope,
      statements_sha256: contract.statements_sha256,
      mode: rt.sampleMode ? "sample-replay" : "live-write",
      executed: !rt.sampleMode,
      original_view_touched: false,
      approval: "shadow-only; operator approval still required for writeback",
    },
  });

  rt.agent = "Verifier";
  const shadowRead = shadowReadSql(plan.shadow_metric);
  const shadow = await executeSqlTool({
    rt,
    tool: "repair_shadow",
    kind: "test",
    title: `shadow metric ${plan.shadow_metric}`,
    sql: shadowRead,
    args: { sql: shadowRead },
  });
  const historyReread = await metricHistory(rt, input.metric, input.baseline.grain);

  let contractOk = true;
  try {
    verifyContract(contract, secret, {
      scope: plan.shadow_metric,
      // A verifier re-run is read-only; it still checks the signature, but an
      // old shadow contract must not make an old case un-replayable.
      ignoreExpiry: true,
    });
  } catch {
    contractOk = false;
  }

  const verification = verifyRepair({
    metric: input.metric,
    shadowMetric: plan.shadow_metric,
    correctedMetric: plan.corrected_metric,
    correctedSql: plan.corrected_sql,
    contractId: contract.id,
    contractOk,
    baseline: input.baseline,
    counterfactual: input.counterfactual,
    originalHistory: input.history,
    historyReread,
    canonicalFacts: input.canonicalFacts,
    canonicalSeries: input.canonicalSeries,
    shadow,
    frames: input.frames,
  });

  const verifierExhibit = emitComputedExhibit({
    rt,
    tool: "verifier",
    kind: "test",
    title: `shadow verifier ${plan.shadow_metric}`,
    args: {
      metric: input.metric,
      shadow_metric: plan.shadow_metric,
      corrected_metric: plan.corrected_metric,
      corrected_sql: plan.corrected_sql,
      contract,
      contract_id: contract.id,
      baseline: input.baseline,
      counterfactual: input.counterfactual,
      history_exhibit_id: input.history.exhibit.id,
      history_reread_exhibit_id: historyReread.exhibit.id,
      canonical_facts_exhibit_id: input.canonicalFacts.exhibit.id,
      shadow_exhibit_id: shadow.exhibit.id,
      frame_exhibits: input.frames.map((frame) => ({
        period: frame.period,
        exhibit_id: frame.exhibit.id,
      })),
    },
    result: verification as unknown as Record<string, unknown>,
    sql: plan.corrected_sql,
  });

  emitTrace(input.root, {
    case_id: state.id,
    agent_name: "Verifier",
    action: "repair.verify",
    input_summary: `${plan.shadow_metric}, ${verification.invariants.length} invariants`,
    output_summary: verification.ok
      ? `SHADOW_VERIFIED ${verification.invariants.filter((row) => row.ok).length}/${verification.invariants.length}`
      : `verifier failed: ${verification.invariants.filter((row) => !row.ok).map((row) => row.name).join(", ")}`,
    status: verification.ok ? "success" : "error",
    latency_ms: 0,
    exhibit_ids: [verifierExhibit.id],
  });

  if (!verification.ok) {
    state = advance(state, "FAILED");
    state = {
      ...state,
      verification,
      error: `shadow verifier failed: ${verification.invariants
        .filter((row) => !row.ok)
        .map((row) => row.name)
        .join(", ")}`,
    };
  } else {
    state = advance(state, "SHADOW_VERIFIED");
    state = { ...state, verification };
  }

  return {
    state: { ...state, exhibits: [...state.exhibits, contractExhibit, shadow.exhibit, historyReread.exhibit, verifierExhibit] },
    exhibits: [contractExhibit, shadow.exhibit, historyReread.exhibit, verifierExhibit],
  };
}
