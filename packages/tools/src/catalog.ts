import type { Exhibit, SqlResult } from "@exhibit-a/core";
import { executeSqlTool, type ToolRuntime } from "./runtime.ts";

export async function catalogSearch(
  rt: ToolRuntime,
  q: string,
): Promise<{ exhibit: Exhibit; result: SqlResult }> {
  const sql = "SHOW LIGHTNING DATABASES";
  return executeSqlTool({
    rt,
    tool: "catalog_search",
    kind: "metadata",
    title: `catalog search ${q}`,
    sql,
    args: { q, sql },
  });
}

export async function describeObject(
  rt: ToolRuntime,
  obj: string,
): Promise<{ exhibit: Exhibit; result: SqlResult }> {
  // The fixture cassette was recorded with Zetaris's datasource-table form.
  // Live schema-store views are described with plain Spark DESCRIBE.
  const sql = rt.sampleMode ? `DESCRIBE DATASOURCE TABLE ${obj}` : `DESCRIBE ${obj}`;
  return executeSqlTool({
    rt,
    tool: "describe",
    kind: "metadata",
    title: `describe ${obj}`,
    sql,
    args: { obj, sql },
  });
}

export async function runSql(
  rt: ToolRuntime,
  sql: string,
  title = "ad hoc SQL",
): Promise<{ exhibit: Exhibit; result: SqlResult }> {
  return executeSqlTool({
    rt,
    tool: "run_sql",
    kind: "sql",
    title,
    sql,
    args: { sql },
  });
}

export async function profileColumn(
  rt: ToolRuntime,
  table: string,
  col: string,
  segmentBy?: string,
): Promise<{ exhibit: Exhibit; result: SqlResult }> {
  const sql = segmentBy
    ? `SELECT ${segmentBy} AS segment, COUNT(*) AS n, COUNT(${col}) AS non_null, MIN(${col}) AS min_v, MAX(${col}) AS max_v FROM ${table} GROUP BY ${segmentBy}`
    : `SELECT COUNT(*) AS n, COUNT(${col}) AS non_null, MIN(${col}) AS min_v, MAX(${col}) AS max_v FROM ${table}`;
  return executeSqlTool({
    rt,
    tool: "profile",
    kind: "profile",
    title: `profile ${table}.${col}`,
    sql,
    args: { table, col, segmentBy, sql },
  });
}

export async function metricHistory(
  rt: ToolRuntime,
  view: string,
  grain: string,
): Promise<{ exhibit: Exhibit; result: SqlResult }> {
  const sql = `SELECT * FROM ${view} ORDER BY ${grain}`;
  return executeSqlTool({
    rt,
    tool: "metric_history",
    kind: "baseline",
    title: `metric history ${view} by ${grain}`,
    sql,
    args: { view, grain, sql },
  });
}
