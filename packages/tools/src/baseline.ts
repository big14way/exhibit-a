import type { BaselineComparison, Exhibit, SqlResult } from "@exhibit-a/core";
import { DEFAULT_ANOMALY_BAND } from "@exhibit-a/core";
import { emitComputedExhibit, type ToolRuntime } from "./runtime.ts";

export type Band = { lo: number; hi: number };

export function compareMetricSeries(input: {
  metric: string;
  grain: string;
  result: SqlResult;
  band?: Band;
}): BaselineComparison {
  const band = input.band ?? DEFAULT_ANOMALY_BAND;
  const { columns, rows } = input.result;
  const grainIndex = columns.indexOf(input.grain);
  const valueIndex = pickValueIndex(columns, input.grain);
  const segmentIndexes = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column !== input.grain && column !== columns[valueIndex])
    .map(({ index }) => index);

  const segments = new Map<string, { period: number | string; value: number }[]>();
  if (grainIndex >= 0 && valueIndex >= 0) {
    for (const row of rows) {
      const segment = segmentIndexes.length
        ? segmentIndexes.map((index) => String(row[index])).join(" / ")
        : "all";
      const period = row[grainIndex] as number | string;
      const value = Number(row[valueIndex]);
      if (!Number.isFinite(value)) continue;
      const points = segments.get(segment) ?? [];
      points.push({ period, value });
      segments.set(segment, points);
    }
  }

  const comparison: BaselineComparison = {
    metric: input.metric,
    grain: input.grain,
    band,
    segments: segments.size,
    periods: new Set(rows.map((row) => String(row[grainIndex]))).size,
    explanation: "no period moved outside the baseline band",
  };

  let best:
    | {
        segment: string;
        period: number | string;
        prior_period: number | string;
        value: number;
        prior_value: number;
        ratio: number;
        delta: number;
      }
    | undefined;
  let bestScore = 0;

  for (const [segment, points] of segments) {
    const sorted = [...points].sort((a, b) => comparePeriods(a.period, b.period));
    for (let i = 1; i < sorted.length; i += 1) {
      const prior = sorted[i - 1];
      const current = sorted[i];
      if (!prior || !current || prior.value === 0) continue;
      const ratio = current.value / prior.value;
      if (ratio >= band.lo && ratio <= band.hi) continue;
      const score = Math.abs(ratio - 1);
      if (score <= bestScore) continue;
      bestScore = score;
      best = {
        segment,
        period: current.period,
        prior_period: prior.period,
        value: current.value,
        prior_value: prior.value,
        ratio,
        delta: current.value - prior.value,
      };
    }
  }

  if (best) {
    comparison.onset = best;
    comparison.explanation =
      `${best.segment} ${best.period} is ${best.ratio.toFixed(2)}x ${best.prior_period} ` +
      `(${formatSigned(best.delta)}), outside the ${band.lo}-${band.hi}x band`;
  }
  return comparison;
}

export function compareToBaseline(
  rt: ToolRuntime,
  input: {
    view: string;
    grain: string;
    history: { exhibit: Exhibit; result: SqlResult };
    band?: Band;
  },
): { exhibit: Exhibit; comparison: BaselineComparison } {
  const comparison = compareMetricSeries({
    metric: input.view,
    grain: input.grain,
    result: input.history.result,
    band: input.band,
  });
  const exhibit = emitComputedExhibit({
    rt,
    tool: "compare_to_baseline",
    kind: "baseline",
    title: `baseline onset ${input.view} by ${input.grain}`,
    args: {
      view: input.view,
      grain: input.grain,
      band: input.band ?? DEFAULT_ANOMALY_BAND,
      source_exhibit_id: input.history.exhibit.id,
    },
    result: comparison as unknown as Record<string, unknown>,
    sql: input.history.exhibit.sql,
  });
  return { exhibit, comparison };
}

function pickValueIndex(columns: string[], grain: string): number {
  const preferred = columns.findIndex((column) => /revenue|income|value|amount|metric|usd/i.test(column));
  if (preferred >= 0) return preferred;
  const last = columns.length - 1;
  return columns[last] === grain ? last - 1 : last;
}

function comparePeriods(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function formatSigned(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  return `${sign}${abs.toFixed(0)}`;
}
