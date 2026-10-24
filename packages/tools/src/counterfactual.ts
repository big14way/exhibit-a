import type { BaselineComparison, Exhibit } from "@exhibit-a/core";
import { seriesValue, type CanonicalSeries } from "./canonical.ts";
import { emitComputedExhibit, type ToolRuntime } from "./runtime.ts";

export type CounterfactualArgs = {
  view: string;
  segment: string;
  onset_period: number | string;
  prior_period: number | string;
  naive_delta: number;
  source_exhibit_id: string;
};

export type CounterfactualResult = {
  metric: string;
  segment: string;
  prior_period: number | string;
  onset_period: number | string;
  naive_delta: number;
  corrected_prior: number;
  corrected_now: number;
  corrected_delta: number;
  explained_share: number;
  unexplained_share: number;
  corrected_direction: "same" | "opposite";
  rule: string;
};

export function computeCounterfactual(
  series: CanonicalSeries,
  args: CounterfactualArgs,
): CounterfactualResult | null {
  const prior = seriesValue(series, args.segment, `CY${args.prior_period}`);
  const now = seriesValue(series, args.segment, `CY${args.onset_period}`);
  if (prior === undefined || now === undefined) return null;
  const correctedDelta = now - prior;
  // When the corrected series moves the other way (or not at all), the
  // reported move is entirely artifact: the share is clamped to 1 and the
  // direction is recorded so the finding can say the real move was a decline.
  const opposite = args.naive_delta !== 0 && correctedDelta * args.naive_delta <= 0;
  const explained =
    args.naive_delta === 0 ? 0 : opposite ? 1 : 1 - correctedDelta / args.naive_delta;
  const explainedShare = round(Math.max(0, Math.min(1, explained)));
  return {
    corrected_direction: opposite ? "opposite" : "same",
    metric: args.view,
    segment: args.segment,
    prior_period: args.prior_period,
    onset_period: args.onset_period,
    naive_delta: args.naive_delta,
    corrected_prior: prior,
    corrected_now: now,
    corrected_delta: correctedDelta,
    explained_share: explainedShare,
    unexplained_share: round(1 - explainedShare),
    rule: "explained share = 1 - (corrected period delta / reported period delta), clamped to [0, 1]; opposite-direction corrected moves count as fully explained",
  };
}

export function counterfactual(
  rt: ToolRuntime,
  input: {
    baseline: BaselineComparison;
    canonical: CanonicalSeries;
    canonicalExhibit: Exhibit;
  },
): { exhibit: Exhibit; result: CounterfactualResult } | null {
  const onset = input.baseline.onset;
  if (!onset) return null;
  const args: CounterfactualArgs = {
    view: input.baseline.metric,
    segment: onset.segment,
    onset_period: onset.period,
    prior_period: onset.prior_period,
    naive_delta: onset.delta,
    source_exhibit_id: input.canonicalExhibit.id,
  };
  const result = computeCounterfactual(input.canonical, args);
  if (!result) return null;
  const exhibit = emitComputedExhibit({
    rt,
    tool: "counterfactual",
    kind: "profile",
    title: `counterfactual ${onset.segment} ${onset.period}: one annual value per cik`,
    args,
    result: result as unknown as Record<string, unknown>,
    sql: input.canonicalExhibit.sql,
  });
  return { exhibit, result };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
