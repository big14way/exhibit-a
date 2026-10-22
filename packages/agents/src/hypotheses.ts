import { newId, type BaselineComparison, type Hypothesis } from "@exhibit-a/core";
import {
  EDGAR_COMPANIES,
  type BucketRow,
  type CanonicalSeries,
  type CoverageRow,
  type DuplicationRow,
  type SecCompanyConceptResult,
  type SecFramesResult,
  seriesValue,
} from "@exhibit-a/tools";

export type EvidenceRefs = {
  lineageSources: string;
  lineageColumns: string;
  history: string;
  baseline: string;
  companyBuckets: string;
  duplication: string;
  buckets: string;
  canonical: string;
  frames: Record<string, string>;
  appleConcept: string;
};

export type Evidence = {
  baseline: BaselineComparison;
  coverage: CoverageRow[];
  duplication: DuplicationRow[];
  buckets: BucketRow[];
  canonical: CanonicalSeries;
  frames: { period: string; result: SecFramesResult }[];
  appleConcept: SecCompanyConceptResult;
  refs: EvidenceRefs;
};

const APPLE = EDGAR_COMPANIES[0];
const TESLA = EDGAR_COMPANIES[6];
const TARGET = EDGAR_COMPANIES[4];

export function draftHypotheses(
  metric: string,
  baseline: BaselineComparison,
): Hypothesis[] {
  const onset = baseline.onset;
  const segment = onset?.segment ?? "the metric";
  const period = onset?.period ?? "the latest period";
  const prior = onset?.prior_period ?? "the prior period";
  return [
    {
      id: newId("hyp"),
      cause: "filing_year_duplication",
      statement:
        `The ${period} movement in ${segment} is inflated because ${metric} sums value_usd grouped by the filing's fiscal_year, so prior-year comparatives, quarterly facts and year-to-date facts are counted again under the later filing year.`,
      blamed: ["edgar.*_revenue_table", metric],
      status: "open",
      exhibit_ids: [],
    },
    {
      id: newId("hyp"),
      cause: "concept_switch_missing_history",
      statement:
        `The ${period} bucket gains a company that is absent from ${prior}, because a filer's Revenues concept stops after one filing and its whole fact history lands in a single fiscal_year.`,
      blamed: [`${APPLE.table}`, `${TARGET.table}`],
      status: "open",
      exhibit_ids: [],
    },
    {
      id: newId("hyp"),
      cause: "real_change",
      statement:
        `Revenue in ${segment} genuinely grew between ${prior} and ${period}; the increase should survive deduplication and agree with an independent SEC frames value.`,
      blamed: [metric, "edgar.*_revenue_table"],
      status: "open",
      exhibit_ids: [],
    },
    {
      id: newId("hyp"),
      cause: "tesla_short_history",
      statement:
        `Tesla's short filing history explains the ${period} movement in ${segment}.`,
      blamed: [`${TESLA.table}`],
      status: "open",
      exhibit_ids: [],
    },
    {
      id: newId("hyp"),
      cause: "ingestion_gap",
      statement:
        `The artifact is an ingestion gap: Zetaris lost facts that the SEC endpoint still returns, so the naive series is missing rows rather than duplicating them.`,
      blamed: [`${APPLE.table}`, "zetaris.ingest"],
      status: "open",
      exhibit_ids: [],
    },
  ];
}

export function assessHypotheses(hypotheses: Hypothesis[], evidence: Evidence): Hypothesis[] {
  const onset = evidence.baseline.onset;
  if (!onset) {
    return hypotheses.map((hypothesis) => ({
      ...hypothesis,
      status: "open",
      note: "no onset outside the baseline band",
    }));
  }
  const onsetYear = Number(onset.period);
  const priorYear = Number(onset.prior_period);
  const bucket = evidence.buckets.find((row) => row.fiscal_year === onsetYear);
  const duplicateTotal = evidence.duplication.reduce((sum, row) => sum + row.duplicate_rows, 0);
  const appleRows = evidence.coverage.filter((row) => row.cik === APPLE.cik);
  const appleYears = appleRows.map((row) => row.fiscal_year);
  const appleOnset = appleRows.find((row) => row.fiscal_year === onsetYear);
  const applePrior = appleRows.find((row) => row.fiscal_year === priorYear);
  const appleDelta = (appleOnset?.revenue_usd ?? 0) - (applePrior?.revenue_usd ?? 0);
  const targetLast = Math.max(
    ...evidence.coverage
      .filter((row) => row.cik === TARGET.cik)
      .map((row) => row.fiscal_year),
  );
  const teslaYears = evidence.coverage
    .filter((row) => row.cik === TESLA.cik)
    .map((row) => row.fiscal_year);
  const teslaDelta =
    (evidence.coverage.find((row) => row.cik === TESLA.cik && row.fiscal_year === onsetYear)
      ?.revenue_usd ?? 0) -
    (evidence.coverage.find((row) => row.cik === TESLA.cik && row.fiscal_year === priorYear)
      ?.revenue_usd ?? 0);

  const correctedNow = seriesValue(evidence.canonical, onset.segment, `CY${onsetYear}`);
  const correctedPrior = seriesValue(evidence.canonical, onset.segment, `CY${priorYear}`);
  const correctedDelta =
    correctedNow !== undefined && correctedPrior !== undefined
      ? correctedNow - correctedPrior
      : undefined;
  const correctedRatio =
    correctedNow !== undefined && correctedPrior !== undefined && correctedPrior !== 0
      ? correctedNow / correctedPrior
      : undefined;
  const realShare =
    correctedDelta !== undefined && onset.delta !== 0 ? correctedDelta / onset.delta : undefined;

  const parity = checkParity(evidence.frames, evidence.canonical);

  return hypotheses.map((hypothesis) => {
    switch (hypothesis.cause) {
      case "filing_year_duplication": {
        const confirmed = duplicateTotal > 0 && (bucket?.rows_n ?? 0) > (bucket?.distinct_periods ?? 0);
        return {
          ...hypothesis,
          status: confirmed ? "confirmed" : "open",
          exhibit_ids: [
            evidence.refs.duplication,
            evidence.refs.buckets,
            evidence.refs.companyBuckets,
            evidence.refs.history,
          ],
          note: confirmed
            ? `FY${onsetYear} holds ${bucket?.rows_n} rows across ${bucket?.distinct_periods} distinct period_end dates; ${duplicateTotal} duplicate rows across the seven tables.`
            : "no duplicate rows or no bucket inflation detected",
        };
      }
      case "concept_switch_missing_history": {
        const appleOnlyOnset =
          appleYears.length > 0 && appleYears.every((year) => year === onsetYear);
        const confirmed = appleOnlyOnset && targetLast < priorYear;
        return {
          ...hypothesis,
          status: confirmed ? "confirmed" : "open",
          exhibit_ids: [evidence.refs.companyBuckets, evidence.refs.appleConcept],
          note: confirmed
            ? `${APPLE.entity_name} has ${appleRows.reduce((sum, row) => sum + row.rows_n, 0)} Revenues facts, all in fiscal_year ${onsetYear}; that contributes ${formatUsd(appleDelta)} of the ${formatUsd(onset.delta)} jump. ${TARGET.entity_name} has no Revenues fact after fiscal_year ${targetLast}.`
            : "no single-year concentration found",
        };
      }
      case "real_change": {
        const confirmed =
          correctedDelta !== undefined &&
          correctedDelta > 0 &&
          correctedRatio !== undefined &&
          parity.checked > 0 &&
          parity.matched === parity.checked;
        return {
          ...hypothesis,
          status: confirmed ? "confirmed" : "open",
          share: realShare,
          exhibit_ids: [
            evidence.refs.canonical,
            ...Object.values(evidence.refs.frames),
            evidence.refs.baseline,
          ],
          note: confirmed
            ? `Corrected ${onset.segment} is ${correctedRatio?.toFixed(3)}x (${formatUsd(correctedDelta)}); that is ${(100 * (realShare ?? 0)).toFixed(1)}% of the reported jump. SEC frames parity ${parity.matched}/${parity.checked}.`
            : "corrected series did not survive with SEC frames parity",
        };
      }
      case "tesla_short_history": {
        const presentInBoth =
          teslaYears.includes(onsetYear) && teslaYears.includes(priorYear);
        const small = Math.abs(teslaDelta / (onset.delta || 1)) < 0.1;
        const eliminated = presentInBoth && small;
        return {
          ...hypothesis,
          status: eliminated ? "eliminated" : "open",
          exhibit_ids: [evidence.refs.companyBuckets, evidence.refs.buckets],
          note: eliminated
            ? `${TESLA.entity_name} has rows in both FY${priorYear} and FY${onsetYear}; its share of the reported jump is ${(100 * Math.abs(teslaDelta / (onset.delta || 1))).toFixed(1)}%.`
            : "short history could still move the bucket",
        };
      }
      case "ingestion_gap": {
        const appleRowsTotal = appleRows.reduce((sum, row) => sum + row.rows_n, 0);
        const countMatches = appleRowsTotal === evidence.appleConcept.count;
        const eliminated = countMatches && parity.checked > 0 && parity.matched === parity.checked;
        return {
          ...hypothesis,
          status: eliminated ? "eliminated" : "open",
          exhibit_ids: [evidence.refs.appleConcept, evidence.refs.companyBuckets, ...Object.values(evidence.refs.frames)],
          note: eliminated
            ? `Zetaris holds ${appleRowsTotal} ${APPLE.entity_name} facts; the SEC companyconcept endpoint returns ${evidence.appleConcept.count}. Nothing is missing.`
            : `row counts disagree: Zetaris ${appleRowsTotal}, SEC ${evidence.appleConcept.count}`,
        };
      }
      default:
        return hypothesis;
    }
  });
}

export type ParityResult = { checked: number; matched: number; max_diff: number };

export function checkParity(
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
      if (diff <= 0.005) matched += 1;
    }
  }
  return { checked, matched, max_diff: maxDiff };
}

function formatUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}
