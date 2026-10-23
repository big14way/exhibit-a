#!/usr/bin/env npx tsx
/**
 * Build the labelled SAMPLE_MODE cassette for the Day-2 tool path from the
 * committed SEC sample. The SQL strings and argument objects are imported from
 * the same modules the investigator uses, so a cassette miss fails the run.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asSqlResult, sha256Json, type Cassette } from "../packages/core/src/index.ts";
import {
  bucketSql,
  canonicalFactsSql,
  companyBucketsSql,
  duplicationSql,
  lineageColumnsSql,
  lineageSourcesSql,
  secCompanyConceptArgs,
  secFramesArgs,
  shadowReadSql,
  shadowResultFromFacts,
} from "../packages/tools/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const METRIC = "analytics.sector_revenue_by_year";
const GRAIN = "fiscal_year";
const OUT = resolve(ROOT, "fixtures/cassettes/d2-edgar-investigation.json");

type Fact = {
  cik: string;
  ticker: string;
  entity_name: string;
  concept: string;
  period_start: string;
  period_end: string;
  value_usd: number;
  accession_number: string;
  fiscal_year: number;
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

const fixture = JSON.parse(
  readFileSync(resolve(ROOT, "fixtures/edgar/revenue-facts.json"), "utf8"),
) as Fixture;
const framesFixture = JSON.parse(
  readFileSync(resolve(ROOT, "fixtures/edgar/sec-frames.json"), "utf8"),
) as FramesFixture;
const discoveryFixture = JSON.parse(
  readFileSync(resolve(ROOT, "fixtures/edgar/apple-discovery.json"), "utf8"),
) as Record<string, unknown>;
const viewSql = readFileSync(resolve(ROOT, "analytics/sector_revenue_by_year.sql"), "utf8").trim();

const companies = new Map(fixture.companies.map((company) => [company.cik, company]));
const facts = fixture.facts;
const divisionOf = (cik: string): string => companies.get(cik)?.sic_division ?? "Unknown";

// --- metric view: the declared FY2016-FY2019 window, SUM by division and filing year ---
const series = new Map<string, number>();
for (const fact of facts) {
  if (fact.fiscal_year < 2016 || fact.fiscal_year > 2019) continue;
  const key = `${divisionOf(fact.cik)}|${fact.fiscal_year}`;
  series.set(key, (series.get(key) ?? 0) + fact.value_usd);
}
const seriesRows = [...series.entries()]
  .map(([key, value]) => {
    const [division, year] = key.split("|");
    return [division, Number(year), value] as unknown[];
  })
  .sort((a, b) => Number(a[1]) - Number(b[1]) || String(a[0]).localeCompare(String(b[0])));
const seriesResult = asSqlResult(["sic_division", "fiscal_year", "revenue_usd"], seriesRows);

const profileRows = [...new Set(seriesRows.map((row) => Number(row[1])))]
  .sort((a, b) => a - b)
  .map((year) => {
    const values = seriesRows.filter((row) => Number(row[1]) === year).map((row) => Number(row[2]));
    return [year, values.length, values.length, Math.min(...values), Math.max(...values)];
  });
const profileResult = asSqlResult(
  ["segment", "n", "non_null", "min_v", "max_v"],
  profileRows,
);

const catalogResult = asSqlResult(
  ["database"],
  [["analytics"], ["edgar"], ["sic_edgar_usl"]],
);
const describeResult = asSqlResult(
  ["col_name", "data_type"],
  [
    ["sic_division", "string"],
    ["fiscal_year", "int"],
    ["revenue_usd", "double"],
  ],
);

const lineageSources = asSqlResult(
  ["source_table", "source_kind"],
  [
    ...fixture.companies.map((company) => [company.table, "table"]),
    ["sic_edgar_usl", "table"],
  ],
);
const lineageColumns = asSqlResult(
  ["target_column", "source_table", "source_column"],
  [
    ["revenue_usd", "sic_edgar_usl", "sic_division"],
    ["fiscal_year", "sic_edgar_usl", "cik"],
    ...fixture.companies.flatMap((company) => [
      ["revenue_usd", company.table, "value_usd"],
      ["fiscal_year", company.table, "fiscal_year"],
      ["sic_division", "sic_edgar_usl", "sic_division"],
    ]),
  ],
);

// --- per-company coverage, all fixture years (Target keeps its old history) ---
const buckets = new Map<
  string,
  { cik: string; entity: string; year: number; rows: number; periods: Set<string>; total: number }
>();
for (const fact of facts) {
  const key = `${fact.cik}|${fact.fiscal_year}`;
  const row =
    buckets.get(key) ??
    {
      cik: fact.cik,
      entity: fact.entity_name,
      year: fact.fiscal_year,
      rows: 0,
      periods: new Set<string>(),
      total: 0,
    };
  row.rows += 1;
  row.periods.add(fact.period_end);
  row.total += fact.value_usd;
  buckets.set(key, row);
}
const coverageResult = asSqlResult(
  ["cik", "entity_name", "fiscal_year", "rows_n", "distinct_periods", "revenue_usd"],
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
  if (fact.fiscal_year < 2016 || fact.fiscal_year > 2019) continue;
  const row = bucketTotals.get(fact.fiscal_year) ?? { rows: 0, periods: new Set<string>(), total: 0 };
  row.rows += 1;
  row.periods.add(fact.period_end);
  row.total += fact.value_usd;
  bucketTotals.set(fact.fiscal_year, row);
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
const shadowResult = shadowResultFromFacts(canonicalResult);

const apple = fixture.companies.find((company) => company.ticker === "AAPL");
if (!apple) throw new Error("Apple missing from fixture");
const appleFacts = facts.filter((fact) => fact.cik === apple.cik);
const appleConcept = {
  cik: apple.cik,
  concept: "Revenues",
  entity_name: apple.entity_name,
  count: appleFacts.length,
  first_period: appleFacts.map((fact) => fact.period_start).sort()[0] ?? null,
  last_period: appleFacts.map((fact) => fact.period_end).sort().at(-1) ?? null,
  forms: [...new Set(appleFacts.map((fact) => fact.form_type))].sort(),
  source_url: `https://data.sec.gov/api/xbrl/companyconcept/CIK${apple.cik}/us-gaap/Revenues.json`,
};

const discoveryArgs = {
  kind: "sec_companyfacts",
  cik: apple.cik,
  entity_name: apple.entity_name,
  concept: "Revenues",
  sic_division: apple.sic_division,
};

const catalogSql = "SHOW LIGHTNING DATABASES";
const describeSql = `DESCRIBE DATASOURCE TABLE ${METRIC}`;
const historySql = `SELECT * FROM ${METRIC} ORDER BY ${GRAIN}`;
const profileSql = `SELECT ${GRAIN} AS segment, COUNT(*) AS n, COUNT(revenue_usd) AS non_null, MIN(revenue_usd) AS min_v, MAX(revenue_usd) AS max_v FROM ${METRIC} GROUP BY ${GRAIN}`;
const coverageSqlText = companyBucketsSql();
const duplicationSqlText = duplicationSql();
const bucketSqlText = bucketSql();
const canonicalSqlText = canonicalFactsSql();
const shadowSqlText = shadowReadSql();
const sourcesSqlText = lineageSourcesSql(viewSql);
const columnsSqlText = lineageColumnsSql(viewSql);

const entries = [
  { tool: "catalog_search", args: { q: METRIC, sql: catalogSql }, result: catalogResult },
  { tool: "describe", args: { obj: METRIC, sql: describeSql }, result: describeResult },
  {
    tool: "metric_history",
    args: { view: METRIC, grain: GRAIN, sql: historySql },
    result: seriesResult,
  },
  {
    tool: "profile",
    args: { table: METRIC, col: "revenue_usd", segmentBy: GRAIN, sql: profileSql },
    result: profileResult,
  },
  { tool: "lineage_sources", args: { view: METRIC, sql: sourcesSqlText }, result: lineageSources },
  { tool: "lineage_columns", args: { view: METRIC, sql: columnsSqlText }, result: lineageColumns },
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
].map((entry) => ({
  tool: entry.tool,
  args_sha256: sha256Json(entry.args),
  result: entry.result,
}));

const cikFilter = fixture.companies.map((company) => company.cik);
for (const frame of framesFixture.frames) {
  const args = secFramesArgs(frame.frame, cikFilter);
  entries.push({
    tool: "second_channel",
    args_sha256: sha256Json(args),
    result: frame,
  });
}
const conceptArgs = secCompanyConceptArgs(apple.cik);
entries.push({
  tool: "second_channel",
  args_sha256: sha256Json(conceptArgs),
  result: appleConcept,
});

const existingModels = existsSync(OUT)
  ? ((JSON.parse(readFileSync(OUT, "utf8")) as Cassette).models ?? [])
  : [];
const cassette: Cassette = {
  id: "cassette_d2_edgar",
  recorded_at: new Date().toISOString().slice(0, 10),
  label:
    "labelled SAMPLE_MODE cassette built from a committed SEC companyconcept/frames sample and a recorded Nemotron critic response; replace after the first live Zetaris recording",
  entries,
  models: existingModels,
};

writeFileSync(OUT, `${JSON.stringify(cassette, null, 2)}\n`);
console.log(`wrote ${OUT} (${entries.length} entries)`);
