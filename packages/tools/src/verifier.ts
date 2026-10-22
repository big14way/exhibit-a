import {
  asSqlResult,
  sha256Json,
  type BaselineComparison,
  type Exhibit,
  type SqlResult,
  type VerificationResult,
  type VerifierInvariant,
} from "@exhibit-a/core";
import type { CanonicalSeries } from "./canonical.ts";
import type { CounterfactualResult } from "./counterfactual.ts";
import { canonicalAnnual, readCanonical, type CanonicalRow } from "./edgar.ts";
import type { SecFramesResult } from "./second-channel.ts";
import { seriesValue } from "./canonical.ts";
import type { WriteContract } from "@exhibit-a/core";

export type VerifierRerunArgs = {
  metric: string;
  shadow_metric: string;
  corrected_metric: string;
  corrected_sql: string;
  contract: WriteContract;
  contract_id: string;
  baseline: BaselineComparison;
  counterfactual: CounterfactualResult;
  history_exhibit_id: string;
  history_reread_exhibit_id: string;
  canonical_facts_exhibit_id: string;
  shadow_exhibit_id: string;
  frame_exhibits: { period: string; exhibit_id: string }[];
};

export type VerifierInput = {
  metric: string;
  shadowMetric: string;
  correctedMetric: string;
  correctedSql: string;
  contractId: string;
  contractOk: boolean;
  baseline: BaselineComparison;
  counterfactual: CounterfactualResult;
  originalHistory: { exhibit: Exhibit; result: SqlResult };
  historyReread: { exhibit: Exhibit; result: SqlResult };
  canonicalFacts: { exhibit: Exhibit; result: SqlResult };
  canonicalSeries: CanonicalSeries;
  shadow: { exhibit: Exhibit; result: SqlResult };
  frames: { period: string; result: SecFramesResult }[];
};

type ShadowRow = { division: string; year: number; value: number };
type ShadowShape = {
  rows: ShadowRow[];
  map: Map<string, number>;
  duplicateKeys: number;
  columnsOk: boolean;
};

const SHADOW_COLUMNS = ["sic_division", "fiscal_year", "revenue_usd"];
const FRAME_TOLERANCE = 0.005;

export function verifyRepair(input: VerifierInput): VerificationResult {
  const windowYears = reportYears(input.originalHistory.result, input.baseline.grain);
  const facts = readCanonical(input.canonicalFacts.result);
  const annualFacts = facts.filter((row) => {
    const days = durationDays(row.period_start, row.period_end);
    return days >= 330 && days <= 400 && windowYears.has(yearOf(row.period_end));
  });
  const uniqueAnnual = new Set(annualFacts.map((row) => `${row.cik}|${row.period_end}`));
  const declaredDuplicates = annualFacts.length - uniqueAnnual.size;
  const expected = expectedCells(input.canonicalSeries, windowYears);
  const shadow = readShadow(input.shadow.result);
  const rowPreservation = checkCells(expected, shadow);
  const uniqueness = {
    ok: shadow.columnsOk && shadow.rows.length > 0 && shadow.duplicateKeys === 0 &&
      shadow.map.size === shadow.rows.length && uniqueAnnual.size <= annualFacts.length,
    detail:
      shadow.columnsOk
        ? `${shadow.rows.length} shadow rows; ${uniqueAnnual.size} unique cik/period facts from ${annualFacts.length} annual facts (${declaredDuplicates} declared duplicates); ${shadow.duplicateKeys} duplicate shadow cells`
        : `shadow result is missing ${SHADOW_COLUMNS.join(", ")}`,
    numbers: {
      annual_facts: annualFacts.length,
      unique_annual_facts: uniqueAnnual.size,
      declared_duplicates: declaredDuplicates,
      shadow_rows: shadow.rows.length,
      duplicate_shadow_cells: shadow.duplicateKeys,
    },
  };
  const parity = checkFrames(input.frames, input.canonicalSeries);
  const historyImmutable =
    sha256Json(input.originalHistory.result) === sha256Json(input.historyReread.result);
  const sanity = metricSanity(input);
  const badRepair = badRepairRejected(annualFacts, expected, windowYears, shadow);
  const contractOk = input.contractOk;

  const invariants: VerifierInvariant[] = [
    {
      name: "row_preservation",
      ok: rowPreservation.ok,
      detail: rowPreservation.detail,
      numbers: rowPreservation.numbers,
    },
    {
      name: "uniqueness",
      ok: uniqueness.ok,
      detail: uniqueness.detail,
      numbers: uniqueness.numbers,
    },
    {
      name: "second_channel_parity",
      ok: parity.checked > 0 && parity.matched === parity.checked,
      detail: `SEC frames parity ${parity.matched}/${parity.checked}; max relative diff ${(parity.max_diff * 100).toFixed(3)}%`,
      numbers: { checked: parity.checked, matched: parity.matched, max_diff: parity.max_diff },
    },
    {
      name: "history_immutability",
      ok: historyImmutable,
      detail: historyImmutable
        ? `reported view re-read hash ${sha256Json(input.originalHistory.result).slice(0, 12)} is unchanged`
        : "reported view changed after the shadow write",
    },
    {
      name: "metric_sanity",
      ok: sanity.ok,
      detail: sanity.detail,
      numbers: sanity.numbers,
    },
    {
      name: "shadow_contract",
      ok: contractOk,
      detail: contractOk
        ? `signed contract ${input.contractId} scopes ${input.shadowMetric}`
        : `contract ${input.contractId} did not verify`,
    },
    {
      name: "bad_repair_rejected",
      ok: badRepair.ok,
      detail: badRepair.detail,
    },
  ];

  const result: VerificationResult = {
    ok: invariants.every((invariant) => invariant.ok),
    shadow_metric: input.shadowMetric,
    corrected_metric: input.correctedMetric,
    invariants,
    corrected_prior: sanity.correctedPrior,
    corrected_now: sanity.correctedNow,
    corrected_delta: sanity.correctedDelta,
    corrected_ratio: sanity.correctedRatio,
  };
  return result;
}

function readShadow(result: SqlResult): ShadowShape {
  const division = result.columns.indexOf("sic_division");
  const year = result.columns.indexOf("fiscal_year");
  const value = result.columns.indexOf("revenue_usd");
  if (division < 0 || year < 0 || value < 0) {
    return { rows: [], map: new Map(), duplicateKeys: 0, columnsOk: false };
  }
  const rows: ShadowRow[] = [];
  const map = new Map<string, number>();
  let duplicateKeys = 0;
  for (const row of result.rows) {
    const item = {
      division: String(row[division] ?? ""),
      year: Number(row[year]),
      value: Number(row[value]),
    };
    if (!Number.isFinite(item.year) || !Number.isFinite(item.value)) continue;
    const key = cellKey(item.division, item.year);
    if (map.has(key)) duplicateKeys += 1;
    map.set(key, item.value);
    rows.push(item);
  }
  return { rows, map, duplicateKeys, columnsOk: true };
}

function expectedCells(
  series: CanonicalSeries,
  windowYears: Set<number>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of series.rows) {
    const division = String(row[0]);
    const year = Number(String(row[1]).replace(/^CY/, ""));
    if (!windowYears.has(year)) continue;
    map.set(cellKey(division, year), Number(row[2]));
  }
  return map;
}

function checkCells(
  expected: Map<string, number>,
  shadow: ShadowShape,
): { ok: boolean; detail: string; numbers: Record<string, number | string> } {
  if (expected.size === 0) {
    return { ok: false, detail: "canonical series has no cells in the reported window", numbers: {} };
  }
  if (!shadow.columnsOk) {
    return { ok: false, detail: `shadow result is missing ${SHADOW_COLUMNS.join(", ")}`, numbers: {} };
  }
  let missing = 0;
  let mismatched = 0;
  let maxDiff = 0;
  for (const [key, value] of expected) {
    const actual = shadow.map.get(key);
    if (actual === undefined) {
      missing += 1;
      continue;
    }
    const diff = Math.abs(actual - value) / Math.max(1, Math.abs(value));
    maxDiff = Math.max(maxDiff, diff);
    if (diff > FRAME_TOLERANCE) mismatched += 1;
  }
  let extra = 0;
  for (const key of shadow.map.keys()) {
    if (!expected.has(key)) extra += 1;
  }
  const ok = shadow.duplicateKeys === 0 && missing === 0 && mismatched === 0 && extra === 0;
  return {
    ok,
    detail:
      `canonical ${expected.size} cells vs shadow ${shadow.rows.length} rows; ` +
      `${missing} missing, ${mismatched} mismatched, ${extra} extra, ` +
      `max relative diff ${(maxDiff * 100).toFixed(3)}%`,
    numbers: {
      expected_cells: expected.size,
      missing,
      mismatched,
      extra,
      max_diff: maxDiff,
    },
  };
}

function metricSanity(input: VerifierInput): {
  ok: boolean;
  detail: string;
  numbers: Record<string, number | string>;
  correctedPrior?: number;
  correctedNow?: number;
  correctedDelta?: number;
  correctedRatio?: number;
} {
  const onset = input.baseline.onset;
  if (!onset) {
    return { ok: false, detail: "no onset to sanity-check", numbers: {} };
  }
  const prior = seriesValue(input.canonicalSeries, onset.segment, `CY${onset.prior_period}`);
  const now = seriesValue(input.canonicalSeries, onset.segment, `CY${onset.period}`);
  if (prior === undefined || now === undefined || prior <= 0 || now <= 0) {
    return { ok: false, detail: "corrected onset or prior value is missing or non-positive", numbers: {} };
  }
  const delta = now - prior;
  const ratio = now / prior;
  const counterfactualDelta = input.counterfactual.corrected_delta;
  const deltaAgrees = Math.abs(delta - counterfactualDelta) <= 1;
  const shareValid =
    Number.isFinite(input.counterfactual.unexplained_share) &&
    input.counterfactual.unexplained_share >= 0 &&
    input.counterfactual.unexplained_share <= 1;
  const ok = Number.isFinite(ratio) && ratio > 0.1 && ratio < 10 && deltaAgrees && shareValid;
  return {
    ok,
    detail:
      `corrected ${onset.segment} ${onset.prior_period}->${onset.period} is ${ratio.toFixed(3)}x ` +
      `(${formatUsd(delta)}); counterfactual delta ${formatUsd(counterfactualDelta)}`,
    numbers: {
      corrected_prior: prior,
      corrected_now: now,
      corrected_delta: delta,
      corrected_ratio: ratio,
      counterfactual_delta: counterfactualDelta,
    },
    correctedPrior: prior,
    correctedNow: now,
    correctedDelta: delta,
    correctedRatio: ratio,
  };
}

export type ParityResult = { checked: number; matched: number; max_diff: number };

export function checkFrames(
  frames: { period: string; result: SecFramesResult }[],
  canonical: CanonicalSeries,
): ParityResult {
  let checked = 0;
  let matched = 0;
  let maxDiff = 0;
  for (const frame of frames) {
    for (const row of frame.result.rows) {
      const value = canonical.byCik.get(row.cik)?.get(frame.result.frame);
      if (value === undefined || row.value_usd === 0) continue;
      const diff = Math.abs(value - row.value_usd) / row.value_usd;
      maxDiff = Math.max(maxDiff, diff);
      checked += 1;
      if (diff <= FRAME_TOLERANCE) matched += 1;
    }
  }
  return { checked, matched, max_diff: maxDiff };
}

function badRepairRejected(
  annualFacts: CanonicalRow[],
  expected: Map<string, number>,
  windowYears: Set<number>,
  actual: ShadowShape,
): { ok: boolean; detail: string } {
  // A 10-K-only filter is not enough: comparatives are also filed on 10-Ks.
  // This candidate keeps every raw annual fact, including duplicates.
  const formRows = annualFacts
    .map((row) => {
      const year = yearOf(row.period_end);
      return [row.sic_division, year, row.value_usd] as unknown[];
    })
    .filter((row) => windowYears.has(Number(row[1])));
  const formCandidate = readShadow(
    asSqlResult(SHADOW_COLUMNS, formRows),
  );
  const formCheck = checkCells(expected, formCandidate);

  // Dropping a company might make a pretty chart, but it silently deletes
  // legitimate facts. The row-preservation check must catch it.
  const dropCandidate = new Map(expected);
  const dropDivision = actual.rows[0]?.division;
  if (dropDivision) {
    for (const key of dropCandidate.keys()) {
      if (key.startsWith(`${dropDivision}|`)) dropCandidate.delete(key);
    }
  }
  const dropShadow: ShadowShape = {
    rows: [...dropCandidate.entries()].map(([key, value]) => {
      const [division, year] = key.split("|");
      return { division, year: Number(year), value };
    }),
    map: dropCandidate,
    duplicateKeys: 0,
    columnsOk: true,
  };
  const dropCheck = checkCells(expected, dropShadow);
  const ok = !formCheck.ok && !dropCheck.ok;
  return {
    ok,
    detail: ok
      ? "naive 10-K-only filter and company-drop candidate both fail the invariants"
      : "verifier accepted a bad-repair probe",
  };
}

function reportYears(result: SqlResult, grain: string): Set<number> {
  const index = result.columns.indexOf(grain);
  const years = new Set<number>();
  if (index >= 0) {
    for (const row of result.rows) {
      const year = Number(row[index]);
      if (Number.isFinite(year)) years.add(year);
    }
  }
  if (years.size === 0) {
    for (let year = 2016; year <= 2019; year += 1) years.add(year);
  }
  return years;
}

function yearOf(periodEnd: string): number {
  const date = new Date(periodEnd);
  return date.getUTCMonth() + 1 <= 6 ? date.getUTCFullYear() - 1 : date.getUTCFullYear();
}

function durationDays(start: string, end: string): number {
  return (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000;
}

function cellKey(division: string, year: number): string {
  return `${division}|${year}`;
}

function formatUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Recompute the series the same way the canonical tool does, for reruns. */
export function seriesFromCanonicalFacts(result: SqlResult): CanonicalSeries {
  const series = canonicalAnnual(readCanonical(result));
  return { columns: series.columns, rows: series.rows, byCik: series.byCik };
}
