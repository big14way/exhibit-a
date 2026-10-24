#!/usr/bin/env npx tsx
/**
 * Build the labelled SAMPLE_MODE cassette for a metric from its committed SEC
 * sample. The SQL strings and argument objects are imported from the same
 * modules the investigator uses, so a cassette miss fails the run instead of
 * fabricating evidence. Recorded model responses in an existing cassette are
 * kept.
 *
 *   npm run cassette -- analytics.sector_revenue_by_year
 *   npm run cassette -- analytics.sector_net_income_by_year
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asSqlResult, sha256Json, type Cassette } from "../packages/core/src/index.ts";
import {
  REVENUE_METRIC,
  bucketSql,
  canonicalFactsSql,
  companyBucketsSql,
  duplicationSql,
  lineageColumnsSql,
  lineageSourcesSql,
  metricNames,
  metricSpec,
  secCompanyConceptArgs,
  secFramesArgs,
  shadowReadSql,
  shadowResultFromFacts,
  type MetricSpec,
} from "../packages/tools/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GRAIN = "fiscal_year";

type Fact = {
  cik: string;
  ticker: string;
  entity_name: string;
  concept: string;
  period_start: string;
  period_end: string;
  value_usd: number;
  accession_number: string;
  fiscal_year: number | null;
  fiscal_period: string;
  period_frame: string | null;
  form_type: string;
  filed_date: string;
};

type Company = {
  cik: string;
  ticker: string;
  entity_name: string;
  table: string;
  sic: string;
  sic_division: string;
};

type Fixture = { companies: Company[]; facts: Fact[] };
type FramesFixture = {
  frames: {
    frame: string;
    concept: string;
    unit: string;
    source_url: string;
    count: number;
    rows: { cik: string; entity_name: string; value_usd: number }[];
  }[];
};

export function buildCassette(spec: MetricSpec): Cassette {
  const names = metricNames(spec);
  const out = resolve(ROOT, spec.paths.cassette);
  const fixture = JSON.parse(readFileSync(resolve(ROOT, spec.paths.facts), "utf8")) as Fixture;
  const framesFixture = JSON.parse(
    readFileSync(resolve(ROOT, spec.paths.frames), "utf8"),
  ) as FramesFixture;
  const discoveryFixture = JSON.parse(
    readFileSync(resolve(ROOT, spec.paths.discovery), "utf8"),
  ) as Record<string, unknown> & { cik: string; company: string };
  const viewSql = readFileSync(resolve(ROOT, spec.paths.viewSql), "utf8").trim();

  const companies = new Map(fixture.companies.map((company) => [company.cik, company]));
  // Facts without a fiscal year cannot be bucketed by the naive view; the live
  // tables carry the same gap, so the sample keeps them out of fiscal_year sums.
  const facts = fixture.facts.filter((fact) => fact.fiscal_year !== null);
  const divisionOf = (cik: string): string => companies.get(cik)?.sic_division ?? "Unknown";
  const { from, to } = spec.window;

  // --- metric view: the declared window, SUM by division and filing year ---
  const series = new Map<string, number>();
  for (const fact of facts) {
    const year = fact.fiscal_year as number;
    if (year < from || year > to) continue;
    const key = `${divisionOf(fact.cik)}|${year}`;
    series.set(key, (series.get(key) ?? 0) + fact.value_usd);
  }
  const seriesRows = [...series.entries()]
    .map(([key, value]) => {
      const [division, year] = key.split("|");
      return [division, Number(year), value] as unknown[];
    })
    .sort((a, b) => Number(a[1]) - Number(b[1]) || String(a[0]).localeCompare(String(b[0])));
  const seriesResult = asSqlResult(["sic_division", GRAIN, spec.valueColumn], seriesRows);

  const profileRows = [...new Set(seriesRows.map((row) => Number(row[1])))]
    .sort((a, b) => a - b)
    .map((year) => {
      const values = seriesRows.filter((row) => Number(row[1]) === year).map((row) => Number(row[2]));
      return [year, values.length, values.length, Math.min(...values), Math.max(...values)];
    });
  const profileResult = asSqlResult(["segment", "n", "non_null", "min_v", "max_v"], profileRows);

  const catalogResult = asSqlResult(["database"], [["analytics"], ["edgar"], ["sic_edgar_usl"]]);
  const describeResult = asSqlResult(
    ["col_name", "data_type"],
    [
      ["sic_division", "string"],
      [GRAIN, "int"],
      [spec.valueColumn, "double"],
    ],
  );

  const lineageSources = asSqlResult(
    ["source_table", "source_kind"],
    [...spec.tables.map((company) => [company.table, "table"]), ["sic_edgar_usl", "table"]],
  );
  const lineageColumns = asSqlResult(
    ["target_column", "source_table", "source_column"],
    [
      [spec.valueColumn, "sic_edgar_usl", "sic_division"],
      [GRAIN, "sic_edgar_usl", "cik"],
      ...spec.tables.flatMap((company) => [
        [spec.valueColumn, company.table, "value_usd"],
        [GRAIN, company.table, GRAIN],
        ["sic_division", "sic_edgar_usl", "sic_division"],
      ]),
    ],
  );

  // --- per-company coverage, all fixture years ---
  const buckets = new Map<
    string,
    { cik: string; entity: string; year: number; rows: number; periods: Set<string>; total: number }
  >();
  for (const fact of facts) {
    const year = fact.fiscal_year as number;
    const key = `${fact.cik}|${year}`;
    const row =
      buckets.get(key) ??
      { cik: fact.cik, entity: fact.entity_name, year, rows: 0, periods: new Set<string>(), total: 0 };
    row.rows += 1;
    row.periods.add(fact.period_end);
    row.total += fact.value_usd;
    buckets.set(key, row);
  }
  const coverageResult = asSqlResult(
    ["cik", "entity_name", GRAIN, "rows_n", "distinct_periods", "revenue_usd"],
    [...buckets.values()]
      .sort((a, b) => a.cik.localeCompare(b.cik) || a.year - b.year)
      .map((row) => [row.cik, row.entity, row.year, row.rows, row.periods.size, row.total]),
  );

  const duplicateResult = asSqlResult(
    ["cik", "rows_total", "distinct_periods", "duplicate_rows"],
    [...new Set(facts.map((fact) => fact.cik))].sort().map((cik) => {
      const rows = facts.filter((fact) => fact.cik === cik);
      const periods = new Set(rows.map((row) => row.period_end));
      return [cik, rows.length, periods.size, rows.length - periods.size];
    }),
  );

  const bucketTotals = new Map<number, { rows: number; periods: Set<string>; total: number }>();
  for (const fact of facts) {
    const year = fact.fiscal_year as number;
    if (year < from || year > to) continue;
    const row = bucketTotals.get(year) ?? { rows: 0, periods: new Set<string>(), total: 0 };
    row.rows += 1;
    row.periods.add(fact.period_end);
    row.total += fact.value_usd;
    bucketTotals.set(year, row);
  }
  const bucketResult = asSqlResult(
    ["fiscal_year", "rows_n", "distinct_periods", "revenue_usd"],
    [...bucketTotals.entries()]
      .sort(([a], [b]) => a - b)
      .map(([year, row]) => [year, row.rows, row.periods.size, row.total]),
  );

  const canonicalRows = [...facts]
    .sort(
      (a, b) =>
        a.cik.localeCompare(b.cik) ||
        a.period_end.localeCompare(b.period_end) ||
        a.filed_date.localeCompare(b.filed_date),
    )
    .map((fact) => [
      divisionOf(fact.cik),
      fact.cik,
      fact.period_start,
      fact.period_end,
      fact.period_frame,
      fact.value_usd,
      fact.filed_date,
    ]);
  const canonicalResult = asSqlResult(
    ["sic_division", "cik", "period_start", "period_end", "period_frame", "value_usd", "filed_date"],
    canonicalRows,
    1000,
  );
  const shadowResult = shadowResultFromFacts(canonicalResult, from, to, spec.valueColumn);

  // The companyconcept exhibit for the focus filer, consistent with the
  // facts the sample tables hold.
  const focusCik = discoveryFixture.cik;
  const focusFacts = facts.filter((fact) => fact.cik === focusCik);
  const conceptResult = {
    cik: focusCik,
    concept: spec.concept,
    entity_name: discoveryFixture.company,
    count: focusFacts.length,
    first_period: focusFacts.map((fact) => fact.period_start).sort()[0] ?? null,
    last_period: focusFacts.map((fact) => fact.period_end).sort().at(-1) ?? null,
    forms: [...new Set(focusFacts.map((fact) => fact.form_type))].sort(),
    source_url: `https://data.sec.gov/api/xbrl/companyconcept/CIK${focusCik}/us-gaap/${spec.concept}.json`,
  };
  const focusCompany = companies.get(focusCik);
  if (!focusCompany) throw new Error(`discovery fixture company ${focusCik} is not in the facts fixture`);
  const discoveryArgs = {
    kind: "sec_companyfacts",
    cik: focusCik,
    entity_name: focusCompany.entity_name,
    concept: spec.concept,
    sic_division: focusCompany.sic_division,
    ...(spec.concept === "Revenues" ? {} : { concept_family: spec.concept }),
  };

  const catalogSql = "SHOW LIGHTNING DATABASES";
  const describeSql = `DESCRIBE DATASOURCE TABLE ${spec.view}`;
  const historySql = `SELECT * FROM ${spec.view} ORDER BY ${GRAIN}`;
  const profileSql = `SELECT ${GRAIN} AS segment, COUNT(*) AS n, COUNT(${spec.valueColumn}) AS non_null, MIN(${spec.valueColumn}) AS min_v, MAX(${spec.valueColumn}) AS max_v FROM ${spec.view} GROUP BY ${GRAIN}`;
  const coverageSqlText = companyBucketsSql(spec.tables);
  const duplicationSqlText = duplicationSql(spec.tables);
  const bucketSqlText = bucketSql(from, to, spec.tables);
  const canonicalSqlText = canonicalFactsSql(undefined, spec.tables);
  const shadowSqlText = shadowReadSql(names.shadowMetric, spec.valueColumn);
  const sourcesSqlText = lineageSourcesSql(viewSql);
  const columnsSqlText = lineageColumnsSql(viewSql);

  const entries: { tool: string; args_sha256: string; result: unknown }[] = [
    { tool: "catalog_search", args: { q: spec.view, sql: catalogSql }, result: catalogResult },
    { tool: "describe", args: { obj: spec.view, sql: describeSql }, result: describeResult },
    { tool: "metric_history", args: { view: spec.view, grain: GRAIN, sql: historySql }, result: seriesResult },
    {
      tool: "profile",
      args: { table: spec.view, col: spec.valueColumn, segmentBy: GRAIN, sql: profileSql },
      result: profileResult,
    },
    { tool: "lineage_sources", args: { view: spec.view, sql: sourcesSqlText }, result: lineageSources },
    { tool: "lineage_columns", args: { view: spec.view, sql: columnsSqlText }, result: lineageColumns },
    { tool: "discover_sources", args: discoveryArgs, result: discoveryFixture },
    { tool: "run_sql", args: { sql: coverageSqlText }, result: coverageResult },
    { tool: "run_sql", args: { sql: duplicationSqlText }, result: duplicateResult },
    { tool: "run_sql", args: { sql: bucketSqlText }, result: bucketResult },
    { tool: "run_sql", args: { sql: canonicalSqlText }, result: canonicalResult },
    { tool: "repair_shadow", args: { sql: shadowSqlText }, result: shadowResult },
    // re-run paths for earlier SQL exhibits
    { tool: "run_sql", args: { sql: catalogSql }, result: catalogResult },
    { tool: "run_sql", args: { sql: describeSql }, result: describeResult },
    { tool: "run_sql", args: { sql: historySql }, result: seriesResult },
    { tool: "run_sql", args: { sql: profileSql }, result: profileResult },
  ].map((entry: { tool: string; args: unknown; result: unknown }) => ({
    tool: entry.tool,
    args_sha256: sha256Json(entry.args),
    result: entry.result,
  }));

  // The investigator derives the frames filter from the coverage rows, sorted
  // by CIK; the cassette key must match that order exactly.
  const cikFilter = [...new Set(facts.map((fact) => fact.cik))].sort();
  for (const frame of framesFixture.frames) {
    const args = secFramesArgs(frame.frame, cikFilter, spec.concept);
    entries.push({ tool: "second_channel", args_sha256: sha256Json(args), result: frame });
  }
  const conceptArgs = secCompanyConceptArgs(focusCik, spec.concept);
  entries.push({ tool: "second_channel", args_sha256: sha256Json(conceptArgs), result: conceptResult });

  const existingModels = existsSync(out)
    ? ((JSON.parse(readFileSync(out, "utf8")) as Cassette).models ?? [])
    : [];
  const id = spec === REVENUE_METRIC ? "cassette_d2_edgar" : `cassette_${names.viewName}`;
  return {
    id,
    recorded_at: new Date().toISOString().slice(0, 10),
    label:
      `labelled SAMPLE_MODE cassette for ${spec.view}, built from a committed SEC companyconcept/frames sample (${spec.concept}) plus recorded Nemotron responses for the critic, content-safety and embedding roles`,
    entries,
    models: existingModels,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const view = process.argv[2] ?? REVENUE_METRIC.view;
  const spec = metricSpec(view);
  const cassette = buildCassette(spec);
  const out = resolve(ROOT, spec.paths.cassette);
  writeFileSync(out, `${JSON.stringify(cassette, null, 2)}\n`);
  console.log(`wrote ${out} (${cassette.entries.length} entries, ${cassette.models?.length ?? 0} model responses kept)`);
}
