import type { Exhibit } from "@exhibit-a/core";
import { sha256Json } from "@exhibit-a/core";
import { compareMetricSeries, type Band } from "./baseline.ts";
import { canonicalSeries } from "./canonical.ts";
import {
  computeCounterfactual,
  type CounterfactualArgs,
} from "./counterfactual.ts";
import { executeSqlTool, emitComputedExhibit, type ToolRuntime } from "./runtime.ts";
import { secondChannel, type SecondChannelArgs } from "./second-channel.ts";

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
