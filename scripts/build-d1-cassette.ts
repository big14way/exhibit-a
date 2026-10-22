import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Json, asSqlResult, type Cassette } from "../packages/core/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metric = "analytics.sector_revenue_by_year";

const catalog = asSqlResult(
  ["database"],
  [["lightning"], ["analytics"], ["edgar"]],
);
const described = asSqlResult(
  ["col_name", "data_type"],
  [
    ["sic_division", "string"],
    ["fiscal_year", "int"],
    ["revenue_usd", "double"],
  ],
);
const series = asSqlResult(
  ["sic_division", "fiscal_year", "revenue_usd"],
  [
    ["Retail Trade", 2017, 480_000_000_000],
    ["Retail Trade", 2018, 510_000_000_000],
    ["Manufacturing", 2017, 220_000_000_000],
    ["Manufacturing", 2018, 390_000_000_000],
    ["Manufacturing", 2019, 405_000_000_000],
  ],
);
const profile = asSqlResult(
  ["segment", "n", "non_null", "min_v", "max_v"],
  [
    [2017, 2, 2, 220_000_000_000, 480_000_000_000],
    [2018, 2, 2, 390_000_000_000, 510_000_000_000],
    [2019, 1, 1, 405_000_000_000, 405_000_000_000],
  ],
);

const catalogSql = "SHOW LIGHTNING DATABASES";
const describeSql = `DESCRIBE DATASOURCE TABLE ${metric}`;
const selectSql = `SELECT * FROM ${metric}`;
const profileSql = `SELECT fiscal_year AS segment, COUNT(*) AS n, COUNT(revenue_usd) AS non_null, MIN(revenue_usd) AS min_v, MAX(revenue_usd) AS max_v FROM ${metric} GROUP BY fiscal_year`;
const historySql = `SELECT * FROM ${metric} ORDER BY fiscal_year`;

const cassette: Cassette = {
  id: "cassette_d1_bootstrap",
  recorded_at: "2026-10-22",
  label: "labelled SAMPLE_MODE cassette from the D1 tool path (replace after first live Zetaris recording)",
  entries: [
    {
      tool: "catalog_search",
      args_sha256: sha256Json({ q: metric, sql: catalogSql }),
      result: catalog,
    },
    {
      tool: "describe",
      args_sha256: sha256Json({ obj: metric, sql: describeSql }),
      result: described,
    },
    {
      tool: "run_sql",
      args_sha256: sha256Json({ sql: selectSql }),
      result: series,
    },
    {
      tool: "profile",
      args_sha256: sha256Json({
        table: metric,
        col: "revenue_usd",
        segmentBy: "fiscal_year",
        sql: profileSql,
      }),
      result: profile,
    },
    {
      tool: "metric_history",
      args_sha256: sha256Json({ view: metric, grain: "fiscal_year", sql: historySql }),
      result: series,
    },
    // rerun always goes through run_sql with the stored statement
    { tool: "run_sql", args_sha256: sha256Json({ sql: catalogSql }), result: catalog },
    { tool: "run_sql", args_sha256: sha256Json({ sql: describeSql }), result: described },
    { tool: "run_sql", args_sha256: sha256Json({ sql: profileSql }), result: profile },
    { tool: "run_sql", args_sha256: sha256Json({ sql: historySql }), result: series },
  ],
};

const out = resolve(ROOT, "fixtures/cassettes/d1-metric-series.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(cassette, null, 2)}\n`);
console.log(`wrote ${out}`);
