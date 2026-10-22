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
import { repairContractSecret } from "./repair.ts";
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
