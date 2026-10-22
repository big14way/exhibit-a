import assert from "node:assert/strict";
import { test } from "node:test";
import type { SqlResult } from "@exhibit-a/core";
import { compareMetricSeries } from "./baseline.ts";

const series: SqlResult = {
  columns: ["sic_division", "fiscal_year", "revenue_usd"],
  rows: [
    ["Manufacturing", 2016, 1_384_761_882_000],
    ["Retail Trade", 2016, 4_295_094_000_000],
    ["Services", 2016, 826_571_000_000],
    ["Manufacturing", 2017, 1_455_942_689_000],
    ["Retail Trade", 2017, 4_308_270_000_000],
    ["Services", 2017, 801_304_000_000],
    ["Manufacturing", 2018, 2_750_941_773_000],
    ["Retail Trade", 2018, 4_370_243_000_000],
    ["Services", 2018, 805_895_000_000],
    ["Manufacturing", 2019, 1_603_783_244_000],
    ["Retail Trade", 2019, 4_486_360_000_000],
    ["Services", 2019, 655_377_000_000],
  ],
  row_count: 12,
  truncated: false,
};

test("compareMetricSeries picks the largest move outside the band", () => {
  const comparison = compareMetricSeries({
    metric: "analytics.sector_revenue_by_year",
    grain: "fiscal_year",
    result: series,
  });
  assert.ok(comparison.onset);
  assert.equal(comparison.onset.segment, "Manufacturing");
  assert.equal(comparison.onset.period, 2018);
  assert.equal(comparison.onset.prior_period, 2017);
  assert.ok(Math.abs(comparison.onset.ratio - 1.8895) < 0.001);
  assert.equal(comparison.onset.delta, 1_294_999_084_000);
  assert.match(comparison.explanation, /1\.89x 2017/);
});

test("compareMetricSeries reports no onset when every move is inside the band", () => {
  const flat: SqlResult = {
    columns: ["segment", "year", "value"],
    rows: [
      ["a", 2020, 100],
      ["a", 2021, 110],
      ["b", 2020, 200],
      ["b", 2021, 190],
    ],
    row_count: 4,
    truncated: false,
  };
  const comparison = compareMetricSeries({ metric: "m", grain: "year", result: flat });
  assert.equal(comparison.onset, undefined);
  assert.match(comparison.explanation, /no period moved/);
});

test("compareMetricSeries ignores a zero prior value instead of dividing by zero", () => {
  const zero: SqlResult = {
    columns: ["segment", "year", "value"],
    rows: [
      ["a", 2020, 0],
      ["a", 2021, 100],
    ],
    row_count: 2,
    truncated: false,
  };
  const comparison = compareMetricSeries({ metric: "m", grain: "year", result: zero });
  assert.equal(comparison.onset, undefined);
});
