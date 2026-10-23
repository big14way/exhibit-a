import type { Exhibit, SqlResult, WriteContract } from "@exhibit-a/core";
import { loadExhibits, sha256Json, verifyContract } from "@exhibit-a/core";
import { compareMetricSeries, type Band } from "./baseline.ts";
import { canonicalSeries } from "./canonical.ts";
import {
  computeCounterfactual,
  type CounterfactualArgs,
} from "./counterfactual.ts";
import { executeSqlTool, emitComputedExhibit, type ToolRuntime } from "./runtime.ts";
import { secondChannel, type SecondChannelArgs, type SecFramesResult } from "./second-channel.ts";
import {
  CORRECTED_METRIC,
  repairContractSecret,
} from "./repair.ts";
import {
  assertFinalContract,
  parseUslModel,
  verifyWriteback,
} from "./writeback.ts";
import {
  seriesFromCanonicalFacts,
  verifyRepair,
  type VerifierRerunArgs,
} from "./verifier.ts";

export type RerunResult = {
  exhibit: Exhibit;
  same: boolean;
  original: string;
  rerun: string;
};

const SQL_TOOLS = new Set([
  "catalog_search",
  "describe",
  "profile",
  "metric_history",
  "lineage_sources",
  "lineage_columns",
  "repair_shadow",
  "write_read",
  "write_original",
  "write_usl",
  "write_dq_list",
  "write_dq_composite",
  "write_dq_row",
  "write_views",
]);

/**
 * Re-execute an exhibit through the tool that produced it and diff the result
 * hash. Computed exhibits are recomputed from their stored inputs.
 */
export async function rerunExhibit(rt: ToolRuntime, exhibit: Exhibit): Promise<RerunResult> {
  const tool = exhibit.tool ?? (exhibit.sql ? "run_sql" : undefined);
  if (!tool) {
    throw new Error(`exhibit ${exhibit.id} has no recorded tool`);
  }

  let again: Exhibit;
  if (tool === "second_channel") {
    again = (await secondChannel(rt, exhibit.args as SecondChannelArgs)).exhibit;
  } else if (tool === "compare_to_baseline") {
    if (!exhibit.sql) throw new Error("baseline exhibit has no source SQL");
    const args = exhibit.args as { view: string; grain: string; band: Band };
    const history = await executeSqlTool({
      rt,
      tool: "run_sql",
      kind: "baseline",
      title: "rerun baseline source",
      sql: exhibit.sql,
      args: { sql: exhibit.sql },
    });
    const comparison = compareMetricSeries({
      metric: args.view,
      grain: args.grain,
      result: history.result,
      band: args.band,
    });
    again = emitComputedExhibit({
      rt,
      tool,
      kind: "baseline",
      title: exhibit.title,
      args: exhibit.args,
      result: comparison as unknown as Record<string, unknown>,
      sql: exhibit.sql,
    });
  } else if (tool === "counterfactual") {
    if (!exhibit.sql) throw new Error("counterfactual exhibit has no source SQL");
    const source = await executeSqlTool({
      rt,
      tool: "run_sql",
      kind: "sql",
      title: "rerun counterfactual source",
      sql: exhibit.sql,
      args: { sql: exhibit.sql },
    });
    const series = canonicalSeries(rt, source).series;
    const result = computeCounterfactual(series, exhibit.args as CounterfactualArgs);
    if (!result) throw new Error("counterfactual cannot be recomputed from stored args");
    again = emitComputedExhibit({
      rt,
      tool,
      kind: "profile",
      title: exhibit.title,
      args: exhibit.args,
      result: result as unknown as Record<string, unknown>,
      sql: exhibit.sql,
    });
  } else if (tool === "canonical_series") {
    if (!exhibit.sql) throw new Error("canonical exhibit has no source SQL");
    const source = await executeSqlTool({
      rt,
      tool: "run_sql",
      kind: "sql",
      title: "rerun canonical source",
      sql: exhibit.sql,
      args: { sql: exhibit.sql },
    });
    again = canonicalSeries(rt, source).exhibit;
  } else if (tool === "write_contract") {
    const args = exhibit.args as { contract: WriteContract; sample_mode: boolean };
    verifyContract(args.contract, repairContractSecret(args.sample_mode), {
      ignoreExpiry: true,
    });
    again = emitComputedExhibit({
      rt,
      tool,
      kind: "writeback",
      title: exhibit.title,
      args: exhibit.args,
      result: {
        contract_id: args.contract.id,
        scope: args.contract.scope,
        statements_sha256: args.contract.statements_sha256,
        mode: args.sample_mode ? "sample-replay" : "live-write",
        executed: !args.sample_mode,
        original_view_touched: false,
        approval: "shadow-only; operator approval still required for writeback",
      },
    });
  } else if (tool === "writeback") {
    const args = exhibit.args as {
      contract: WriteContract;
      sample_mode: boolean;
      note?: string;
    };
    verifyContract(args.contract, repairContractSecret(args.sample_mode), {
      requireApproved: true,
      scope: CORRECTED_METRIC,
    });
    assertFinalContract(args.contract);
    again = emitComputedExhibit({
      rt,
      tool: "writeback",
      kind: "writeback",
      title: exhibit.title,
      args: exhibit.args,
      result: {
        contract_id: args.contract.id,
        scope: args.contract.scope,
        statements_sha256: args.contract.statements_sha256,
        statements_count: args.contract.statements.length,
        mode: args.sample_mode ? "sample-replay" : "live-write",
        executed: !args.sample_mode,
        original_view_touched: false,
        approval: "operator-approved",
      },
    });
  } else if (tool === "write_verified") {
    const args = exhibit.args as {
      contract_id: string;
      note: string;
      final_read_exhibit_id?: string;
      usl_load_exhibit_id?: string;
      dq_list_exhibit_id?: string;
      composite_dq_exhibit_id?: string;
      row_dq_exhibit_id?: string;
      views_exhibit_id?: string;
      original_exhibit_id: string;
      original_reread_exhibit_id?: string;
      shadow_exhibit_id?: string;
      write_executed?: boolean;
    };
    if (!args.shadow_exhibit_id) {
      throw new Error("write_verified exhibit has no shadow exhibit id");
    }
    const byId = new Map(
      loadExhibits(rt.root, exhibit.case_id).map((item) => [item.id, item]),
    );
    const get = (id?: string): Exhibit | undefined => (id ? byId.get(id) : undefined);
    const resultOf = (id?: string): SqlResult | undefined =>
      get(id)?.result as SqlResult | undefined;
    const uslLoad = resultOf(args.usl_load_exhibit_id);
    const verification = verifyWriteback({
      contractId: args.contract_id,
      writtenMetric: CORRECTED_METRIC,
      contractOk: true,
      writeExecuted: args.write_executed ?? true,
      caseId: exhibit.case_id,
      note: args.note,
      shadow: resultOf(args.shadow_exhibit_id)!,
      finalRead: resultOf(args.final_read_exhibit_id),
      originalHistory: resultOf(args.original_exhibit_id),
      originalReread: resultOf(args.original_reread_exhibit_id),
      uslModel: uslLoad ? parseUslModel(uslLoad) : undefined,
      dqList: resultOf(args.dq_list_exhibit_id),
      compositeDq: resultOf(args.composite_dq_exhibit_id),
      rowDq: resultOf(args.row_dq_exhibit_id),
      views: resultOf(args.views_exhibit_id),
    });
    again = emitComputedExhibit({
      rt,
      tool: "write_verified",
      kind: "test",
      title: exhibit.title,
      args: exhibit.args,
      result: verification as unknown as Record<string, unknown>,
      sql: exhibit.sql,
    });
  } else if (tool === "memory") {
    again = emitComputedExhibit({
      rt,
      tool: "memory",
      kind: "memory",
      title: exhibit.title,
      args: exhibit.args,
      result: exhibit.result as Record<string, unknown>,
    });
  } else if (tool === "verifier") {
    const args = exhibit.args as VerifierRerunArgs;
    const byId = new Map(
      loadExhibits(rt.root, exhibit.case_id).map((item) => [item.id, item]),
    );
    const get = (id: string): Exhibit => {
      const found = byId.get(id);
      if (!found) throw new Error(`verifier input exhibit missing: ${id}`);
      return found;
    };
    const canonicalFacts = get(args.canonical_facts_exhibit_id);
    const canonicalResult = canonicalFacts.result as SqlResult;
    const history = get(args.history_exhibit_id);
    const historyReread = get(args.history_reread_exhibit_id);
    const shadow = get(args.shadow_exhibit_id);
    const frames = args.frame_exhibits.map((frame) => ({
      period: frame.period,
      result: get(frame.exhibit_id).result as SecFramesResult,
    }));
    let contractOk = true;
    try {
      verifyContract(args.contract, repairContractSecret(rt.sampleMode), {
        scope: args.shadow_metric,
        ignoreExpiry: true,
      });
    } catch {
      contractOk = false;
    }
    const verification = verifyRepair({
      metric: args.metric,
      shadowMetric: args.shadow_metric,
      correctedMetric: args.corrected_metric,
      correctedSql: args.corrected_sql,
      contractId: args.contract_id,
      contractOk,
      baseline: args.baseline,
      counterfactual: args.counterfactual,
      originalHistory: { exhibit: history, result: history.result as SqlResult },
      historyReread: { exhibit: historyReread, result: historyReread.result as SqlResult },
      canonicalFacts: { exhibit: canonicalFacts, result: canonicalResult },
      canonicalSeries: seriesFromCanonicalFacts(canonicalResult),
      shadow: { exhibit: shadow, result: shadow.result as SqlResult },
      frames,
    });
    again = emitComputedExhibit({
      rt,
      tool,
      kind: "test",
      title: exhibit.title,
      args: exhibit.args,
      result: verification as unknown as Record<string, unknown>,
      sql: exhibit.sql,
    });
  } else if (tool === "run_sql" || SQL_TOOLS.has(tool)) {
    if (!exhibit.sql) throw new Error(`exhibit ${exhibit.id} has no SQL to re-run`);
    const result = await executeSqlTool({
      rt,
      tool,
      kind: exhibit.kind,
      title: exhibit.title,
      sql: exhibit.sql,
      args: exhibit.args ?? { sql: exhibit.sql },
    });
    again = result.exhibit;
  } else {
    throw new Error(`no re-run path for tool ${tool}`);
  }

  const original = sha256Json(exhibit.result);
  const rerun = sha256Json(again.result);
  return { exhibit: again, same: original === rerun, original, rerun };
}
