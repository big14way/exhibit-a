import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCounterfactual, type CounterfactualArgs } from "./counterfactual.ts";
import type { CanonicalSeries } from "./canonical.ts";

const series: CanonicalSeries = {
  columns: ["sic_division", "period_frame", "revenue_usd"],
  rows: [
    ["Manufacturing", "CY2017", 397_769_000_000],
    ["Manufacturing", "CY2018", 447_394_000_000],
  ],
  byCik: new Map(),
};

const args: CounterfactualArgs = {
  view: "analytics.sector_revenue_by_year",
  segment: "Manufacturing",
  onset_period: 2018,
  prior_period: 2017,
  naive_delta: 1_294_999_084_000,
  source_exhibit_id: "ex_test",
};

test("counterfactual splits the reported delta into explained and residual shares", () => {
  const result = computeCounterfactual(series, args);
  assert.ok(result);
  assert.equal(result.corrected_prior, 397_769_000_000);
  assert.equal(result.corrected_now, 447_394_000_000);
  assert.equal(result.corrected_delta, 49_625_000_000);
  assert.equal(result.explained_share, 0.96168);
  assert.equal(result.unexplained_share, 0.03832);
});

test("counterfactual refuses to guess when the corrected frame is missing", () => {
  const result = computeCounterfactual(
    { ...series, rows: [["Manufacturing", "CY2017", 1]] },
    args,
  );
  assert.equal(result, null);
});
