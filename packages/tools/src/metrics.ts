import { EDGAR_COMPANIES, type EdgarCompany } from "./edgar.ts";

/**
 * A metric spec is everything the investigator needs to know about a reported
 * view that is not in the data itself: which SEC concept its source tables
 * carry, which tables those are, what the value column is called, and where
 * the repair may write. Nothing about the outcome lives here; the suspects,
 * shares and verdict come from the evidence.
 */
export type MetricSpec = {
  /** Reported view, e.g. analytics.sector_revenue_by_year. */
  view: string;
  /** Human label used in titles. */
  label: string;
  /** The question the committed sample asks; recorded model requests key on it. */
  sampleQuestion: string;
  /** us-gaap concept behind the source tables. */
  concept: string;
  /** Regex for concepts in the same family, for Scout discovery. */
  conceptFamily: RegExp;
  /** Regex for family look-alikes that are not the measure itself. */
  conceptExclude: RegExp;
  /** The view's value column. */
  valueColumn: string;
  /** Source tables, one per filer. */
  tables: readonly EdgarCompany[];
  /** Reported window. */
  window: { from: number; to: number };
  /** USL name for the canonical fact table the writeback creates. */
  uslName: string;
  /** Repo-relative paths used by the CLI and the fixture scripts. */
  paths: {
    viewSql: string;
    cassette: string;
    facts: string;
    frames: string;
    discovery: string;
  };
};

export type MetricNames = {
  view: string;
  viewName: string;
  valueColumn: string;
  shadowContainer: string;
  shadowViewName: string;
  shadowMetric: string;
  correctedContainer: string;
  correctedViewName: string;
  correctedMetric: string;
  uslNamespace: string;
  uslName: string;
  uslPath: string;
  uslTablePath: string;
  uslRowRule: string;
};

function tablesFor(suffix: string): readonly EdgarCompany[] {
  return EDGAR_COMPANIES.map((company) => ({
    ...company,
    table: company.table.replace(/_revenue_table$/, `_${suffix}_table`),
  }));
}

export const REVENUE_METRIC: MetricSpec = {
  view: "analytics.sector_revenue_by_year",
  label: "sector revenue by filing year",
  sampleQuestion: "is the FY2018 jump real?",
  concept: "Revenues",
  conceptFamily: /revenue|salesrevenue|contractwithcustomer/i,
  conceptExclude: /liability|deferred|increase|decrease|cost|obligation|remainingperformance|allowance/i,
  valueColumn: "revenue_usd",
  tables: EDGAR_COMPANIES,
  window: { from: 2016, to: 2019 },
  uslName: "revenue_facts",
  paths: {
    viewSql: "analytics/sector_revenue_by_year.sql",
    cassette: "fixtures/cassettes/d2-edgar-investigation.json",
    facts: "fixtures/edgar/revenue-facts.json",
    frames: "fixtures/edgar/sec-frames.json",
    discovery: "fixtures/edgar/apple-discovery.json",
  },
};

export const NET_INCOME_METRIC: MetricSpec = {
  view: "analytics.sector_net_income_by_year",
  label: "sector net income by filing year",
  sampleQuestion: "is the FY2017 Services net income jump real?",
  concept: "NetIncomeLoss",
  conceptFamily: /netincome|profitloss/i,
  conceptExclude: /noncontrolling|pershare|comprehensive|available|attributable|continuing|discontinued|tax|before/i,
  valueColumn: "net_income_usd",
  tables: tablesFor("netincome"),
  window: { from: 2016, to: 2019 },
  uslName: "net_income_facts",
  paths: {
    viewSql: "analytics/sector_net_income_by_year.sql",
    cassette: "fixtures/cassettes/d3-netincome-investigation.json",
    facts: "fixtures/edgar/netincome-facts.json",
    frames: "fixtures/edgar/sec-frames-netincome.json",
    discovery: "fixtures/edgar/ibm-netincome-discovery.json",
  },
};

export const METRICS: readonly MetricSpec[] = [REVENUE_METRIC, NET_INCOME_METRIC];

export function metricSpec(view: string): MetricSpec {
  const spec = METRICS.find((item) => item.view === view);
  if (!spec) {
    throw new Error(
      `unknown metric ${view}; known metrics: ${METRICS.map((item) => item.view).join(", ")}`,
    );
  }
  return spec;
}

export function metricNames(spec: MetricSpec): MetricNames {
  const viewName = spec.view.split(".").pop() ?? spec.view;
  const uslNamespace = "lightning.metastore.exhibit_a";
  return {
    view: spec.view,
    viewName,
    valueColumn: spec.valueColumn,
    shadowContainer: "exhibit_a_shadow",
    shadowViewName: viewName,
    shadowMetric: `exhibit_a_shadow.${viewName}`,
    correctedContainer: "exhibit_a",
    correctedViewName: `${viewName}_v2`,
    correctedMetric: `exhibit_a.${viewName}_v2`,
    uslNamespace,
    uslName: spec.uslName,
    uslPath: `${uslNamespace}.${spec.uslName}`,
    uslTablePath: `${uslNamespace}.${spec.uslName}.fact`,
    uslRowRule: "annual_has_frame",
  };
}

/** Find the spec whose corrected view or shadow view is in a contract scope. */
export function specForScope(scope: readonly string[]): MetricSpec | undefined {
  return METRICS.find((spec) => {
    const names = metricNames(spec);
    return scope.includes(names.correctedMetric) || scope.includes(names.shadowMetric);
  });
}

/** Concept family regexes for Scout discovery; defaults to the revenue family. */
export function conceptFamily(concept: string): { family: RegExp; exclude: RegExp } {
  const spec = METRICS.find((item) => item.concept === concept) ?? REVENUE_METRIC;
  return { family: spec.conceptFamily, exclude: spec.conceptExclude };
}
