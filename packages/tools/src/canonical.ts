import { asSqlResult, type Exhibit, type SqlResult } from "@exhibit-a/core";
import { canonicalAnnual, readCanonical } from "./edgar.ts";
import { emitComputedExhibit, type ToolRuntime } from "./runtime.ts";

export type CanonicalSeries = {
  columns: string[];
  rows: unknown[][];
  byCik: Map<string, Map<string, number>>;
};

/**
 * Deduplicate to one annual value per (cik, period_frame), last filed wins,
 * then sum by SIC division. This is the corrected series, computed in code
 * from a rerunnable fact query.
 */
export function canonicalSeries(
  rt: ToolRuntime,
  source: { exhibit: Exhibit; result: SqlResult },
): { exhibit: Exhibit; series: CanonicalSeries } {
  const canonical = canonicalAnnual(readCanonical(source.result));
  const series: CanonicalSeries = {
    columns: canonical.columns,
    rows: canonical.rows,
    byCik: canonical.byCik,
  };
  const result = asSqlResult(canonical.columns, canonical.rows) as SqlResult & {
    rule: string;
  };
  const exhibit = emitComputedExhibit({
    rt,
    tool: "canonical_series",
    kind: "baseline",
    title: "corrected annual series (one value per cik and period_frame)",
    args: {
      source_exhibit_id: source.exhibit.id,
      rule: "latest_filed_per_cik_frame",
    },
    result: {
      ...result,
      rule: "latest_filed_per_cik_frame",
      sources: canonical.rows.length,
    },
    sql: source.exhibit.sql,
  });
  return { exhibit, series };
}

export function seriesValue(
  series: CanonicalSeries,
  division: string,
  frame: string,
): number | undefined {
  const row = series.rows.find(
    (value) => value[0] === division && value[1] === frame,
  );
  return row ? Number(row[2]) : undefined;
}
