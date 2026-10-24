import {
  newId,
  type BaselineComparison,
  type DiscoveryResult,
  type Hypothesis,
} from "@exhibit-a/core";
import {
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
  concept?: string;
  discovery?: string;
};

export type Evidence = {
  baseline: BaselineComparison;
  coverage: CoverageRow[];
  duplication: DuplicationRow[];
  buckets: BucketRow[];
  canonical: CanonicalSeries;
  frames: { period: string; result: SecFramesResult }[];
  /** SEC companyconcept for the focus filer, when one was selected. */
  concept?: SecCompanyConceptResult;
  discovery?: DiscoveryResult;
  /** cik -> sic_division, read from the canonical fact rows. */
  segmentOf: Map<string, string>;
  refs: EvidenceRefs;
};

/** One filer's coverage across fiscal years, derived from the coverage rows. */
export type FilerProfile = {
  cik: string;
  entity_name: string;
  years: number[];
  first_year: number;
  last_year: number;
  rows_total: number;
  revenue_by_year: Map<number, number>;
};

export function profileFilers(coverage: CoverageRow[]): FilerProfile[] {
  const byCik = new Map<string, FilerProfile>();
  for (const row of coverage) {
    const profile = byCik.get(row.cik) ?? {
      cik: row.cik,
      entity_name: row.entity_name,
      years: [],
      first_year: row.fiscal_year,
      last_year: row.fiscal_year,
      rows_total: 0,
      revenue_by_year: new Map<number, number>(),
    };
    profile.years.push(row.fiscal_year);
    profile.first_year = Math.min(profile.first_year, row.fiscal_year);
    profile.last_year = Math.max(profile.last_year, row.fiscal_year);
    profile.rows_total += row.rows_n;
    profile.revenue_by_year.set(
      row.fiscal_year,
      (profile.revenue_by_year.get(row.fiscal_year) ?? 0) + row.revenue_usd,
    );
    byCik.set(row.cik, profile);
  }
  return [...byCik.values()].sort((a, b) => a.cik.localeCompare(b.cik));
}

export type FilerSelection = {
  /** The filer first appears in the onset period (absent from the prior one). */
  newcomer?: FilerProfile;
  /** The filer's history stops before the prior period. */
  stopped?: FilerProfile;
  /** The filer that contributes most to the reported delta. */
  focus?: FilerProfile;
};

/**
 * Pick the filers the evidence points at. No company is named in code: the
 * newcomer is whoever first appears in the onset period, the stopped filer is
 * whoever disappears before the prior period, and the focus filer is the
 * largest contributor to the reported delta.
 */
export function selectFilers(
  filers: FilerProfile[],
  onsetYear: number,
  priorYear: number,
): FilerSelection {
  const revenueAt = (filer: FilerProfile, year: number): number =>
    filer.revenue_by_year.get(year) ?? 0;
  const newcomer = filers
    .filter((filer) => filer.first_year === onsetYear && filer.years.includes(onsetYear))
    .sort((a, b) => Math.abs(revenueAt(b, onsetYear)) - Math.abs(revenueAt(a, onsetYear)))[0];
  const stopped = filers
    .filter((filer) => filer.last_year < priorYear)
    .sort((a, b) => b.last_year - a.last_year)[0];
  const focus =
    newcomer ??
    [...filers].sort(
      (a, b) =>
        Math.abs(revenueAt(b, onsetYear) - revenueAt(b, priorYear)) -
        Math.abs(revenueAt(a, onsetYear) - revenueAt(a, priorYear)),
    )[0];
  return { newcomer, stopped, focus };
}

/**
 * The fastest-growing filer in the moved segment that is present in both
 * periods. This is the honest version of "one company's growth explains it".
 */
export function selectGrowthFiler(
  filers: FilerProfile[],
  segmentOf: Map<string, string>,
  segment: string,
  onsetYear: number,
  priorYear: number,
  excludeCik?: string,
): (FilerProfile & { ratio: number; delta: number }) | undefined {
  const candidates = filers
    .filter((filer) => filer.cik !== excludeCik)
    .filter((filer) => segmentOf.size === 0 || segmentOf.get(filer.cik) === segment)
    .map((filer) => {
      const prior = filer.revenue_by_year.get(priorYear) ?? 0;
      const now = filer.revenue_by_year.get(onsetYear) ?? 0;
      return { ...filer, ratio: prior > 0 ? now / prior : 0, delta: now - prior };
    })
    .filter((filer) => filer.ratio > 0 && filer.years.includes(onsetYear));
  return candidates.sort((a, b) => b.ratio - a.ratio)[0];
}

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
        `The ${period} bucket gains a filer that is absent from ${prior}, because a filer's Revenues concept stops after one filing and its whole fact history lands in a single fiscal_year.`,
      blamed: ["edgar.*_revenue_table"],
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
      cause: "single_filer_growth",
      statement:
        `One fast-growing filer in ${segment} explains the ${period} movement on its own.`,
      blamed: ["edgar.*_revenue_table"],
      status: "open",
      exhibit_ids: [],
    },
    {
      id: newId("hyp"),
      cause: "ingestion_gap",
      statement:
        `The artifact is an ingestion gap: Zetaris lost facts that the SEC endpoint still returns, so the naive series is missing rows rather than duplicating them.`,
      blamed: ["edgar.*_revenue_table", "zetaris.ingest"],
      status: "open",
      exhibit_ids: [],
    },
  ];
}

function subject(filer: FilerProfile | undefined, role: string) {
  return filer ? [{ cik: filer.cik, entity_name: filer.entity_name, role }] : [];
}

function withIds(ids: (string | undefined)[]): string[] {
  return ids.filter((id): id is string => Boolean(id));
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
  const filers = profileFilers(evidence.coverage);
  const { newcomer, stopped, focus } = selectFilers(filers, onsetYear, priorYear);
  const grower = selectGrowthFiler(
    filers,
    evidence.segmentOf,
    onset.segment,
    onsetYear,
    priorYear,
    newcomer?.cik,
  );
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
  const sourceTables = [...new Set(evidence.coverage.map((row) => row.cik))].length;

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
            ? `FY${onsetYear} holds ${bucket?.rows_n} rows across ${bucket?.distinct_periods} distinct period_end dates; ${duplicateTotal} duplicate rows across the ${sourceTables} source tables.`
            : "no duplicate rows or no bucket inflation detected",
        };
      }
      case "concept_switch_missing_history": {
        const confirmed = newcomer !== undefined;
        const replacement = evidence.discovery?.replacement_concept;
        const relation = evidence.discovery?.replacement_relation ?? null;
        const replacementFacts = evidence.discovery?.candidates.find(
          (candidate) => candidate.concept === replacement,
        )?.annual_facts;
        return {
          ...hypothesis,
          status: confirmed ? "confirmed" : "open",
          blamed: withIds([
            ...hypothesis.blamed,
            ...(newcomer ? [`cik:${newcomer.cik}`] : []),
            ...(stopped ? [`cik:${stopped.cik}`] : []),
          ]),
          subjects: [...subject(newcomer, "first appears in onset period"), ...subject(stopped, "history stops")],
          exhibit_ids: withIds([
            evidence.refs.companyBuckets,
            evidence.refs.concept,
            evidence.refs.discovery,
          ]),
          note: confirmed
            ? `${newcomer.entity_name} first appears in fiscal_year ${onsetYear} (${newcomer.rows_total} facts across ${newcomer.years.length} fiscal year${newcomer.years.length === 1 ? "" : "s"}, none in FY${priorYear}); that contributes ${formatUsd(
                (newcomer.revenue_by_year.get(onsetYear) ?? 0) -
                  (newcomer.revenue_by_year.get(priorYear) ?? 0),
              )} of the ${formatUsd(onset.delta)} jump.` +
              (stopped
                ? ` ${stopped.entity_name} has no fact after fiscal_year ${stopped.last_year}.`
                : "") +
              (replacement
                ? relation === "prior_history"
                  ? ` Scout found the earlier periods under ${replacement} (${replacementFacts ?? "more"} annual 10-K facts).`
                  : ` Scout found the replacement concept ${replacement} with ${replacementFacts ?? "more"} annual 10-K facts.`
                : evidence.discovery
                  ? " Scout found no related concept covering the missing periods."
                  : "")
            : "no filer first appears in the onset period",
        };
      }
      case "real_change": {
        const parityOk = parity.checked > 0 && parity.matched === parity.checked;
        const confirmed =
          correctedDelta !== undefined &&
          correctedDelta > 0 &&
          correctedRatio !== undefined &&
          parityOk;
        const eliminated =
          !confirmed && correctedDelta !== undefined && correctedDelta <= 0 && parityOk;
        return {
          ...hypothesis,
          status: confirmed ? "confirmed" : eliminated ? "eliminated" : "open",
          share: confirmed ? realShare : eliminated ? 0 : realShare,
          exhibit_ids: [
            evidence.refs.canonical,
            ...Object.values(evidence.refs.frames),
            evidence.refs.baseline,
          ],
          note: confirmed
            ? `Corrected ${onset.segment} is ${correctedRatio?.toFixed(3)}x (${formatUsd(correctedDelta)}); that is ${(100 * (realShare ?? 0)).toFixed(1)}% of the reported jump. SEC frames parity ${parity.matched}/${parity.checked}.`
            : eliminated
              ? `Corrected ${onset.segment} moved the other way (${formatUsd(correctedDelta)}, ${correctedRatio?.toFixed(3)}x); the reported jump has no real component. SEC frames parity ${parity.matched}/${parity.checked}.`
              : "corrected series did not survive with SEC frames parity",
        };
      }
      case "single_filer_growth": {
        if (!grower) {
          return {
            ...hypothesis,
            status: "open",
            exhibit_ids: [evidence.refs.companyBuckets, evidence.refs.buckets],
            note: `no filer in ${onset.segment} is present in both FY${priorYear} and FY${onsetYear}`,
          };
        }
        const share = Math.abs(grower.delta / (onset.delta || 1));
        const eliminated = share < 0.1;
        return {
          ...hypothesis,
          status: eliminated ? "eliminated" : "open",
          blamed: [...hypothesis.blamed, `cik:${grower.cik}`],
          subjects: subject(grower, "fastest-growing filer in segment"),
          exhibit_ids: [evidence.refs.companyBuckets, evidence.refs.buckets],
          note: eliminated
            ? `${grower.entity_name} is the fastest-growing filer in ${onset.segment} (${grower.ratio.toFixed(3)}x FY${priorYear} to FY${onsetYear}), but its ${formatUsd(grower.delta)} is only ${(100 * share).toFixed(1)}% of the reported jump.`
            : `${grower.entity_name} grew ${grower.ratio.toFixed(3)}x and accounts for ${(100 * share).toFixed(1)}% of the reported jump; still a candidate`,
        };
      }
      case "ingestion_gap": {
        if (!focus || !evidence.concept) {
          return {
            ...hypothesis,
            status: "open",
            exhibit_ids: withIds([evidence.refs.companyBuckets]),
            note: "no SEC companyconcept comparison available",
          };
        }
        const countMatches = focus.rows_total === evidence.concept.count;
        const eliminated = countMatches && parity.checked > 0 && parity.matched === parity.checked;
        return {
          ...hypothesis,
          status: eliminated ? "eliminated" : "open",
          blamed: [...hypothesis.blamed, `cik:${focus.cik}`],
          subjects: subject(focus, "largest contributor to the delta"),
          exhibit_ids: withIds([
            evidence.refs.concept,
            evidence.refs.companyBuckets,
            ...Object.values(evidence.refs.frames),
          ]),
          note: eliminated
            ? `Zetaris holds ${focus.rows_total} ${focus.entity_name} facts; the SEC companyconcept endpoint returns ${evidence.concept.count}. Nothing is missing.`
            : `row counts disagree: Zetaris ${focus.rows_total}, SEC ${evidence.concept.count}`,
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
      const diff = Math.abs(value - row.value_usd) / Math.abs(row.value_usd);
      maxDiff = Math.max(maxDiff, diff);
      checked += 1;
      if (diff <= 0.005) matched += 1;
    }
  }
  return { checked, matched, max_diff: maxDiff };
}

export function formatUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}
