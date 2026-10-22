import type { Exhibit, LineageColumn, LineageGraph, LineageSource, SqlResult } from "@exhibit-a/core";
import { ingestLineage } from "@exhibit-a/core";
import { executeSqlTool, type ToolRuntime } from "./runtime.ts";

export function lineageSourcesSql(viewSql: string): string {
  return `INFER SQLTABLE SOURCES SPEC ${viewSql}`;
}

export function lineageColumnsSql(viewSql: string): string {
  return `INFER SQLTABLE COLUMNS SPEC ${viewSql}`;
}

/**
 * `INFER SQLTABLE` parses a query, not a `CREATE SCHEMASTORE VIEW`
 * declaration. Keep the fixture and its cassette stable; for live mode,
 * extract the SELECT body and point the unqualified SIC table at the
 * schema-store copy that actually exists in the local instance.
 */
export function normalizeViewDeclaration(
  viewSql: string,
  sicTable = "edgar.sic_edgar_usl",
): string {
  const declaration = viewSql.match(
    /CREATE\s+(?:OR\s+REPLACE\s+)?SCHEMASTORE\s+VIEW\s+[^\n]+?\s+AS\s+([\s\S]+)$/i,
  );
  const query = (declaration?.[1] ?? viewSql).trim();
  return query.replace(/(?<!\.)\bsic_edgar_usl\b/g, sicTable);
}

export function parseLineageSources(result: SqlResult): LineageSource[] {
  const tableIndex = Math.max(
    result.columns.indexOf("source_table"),
    result.columns.indexOf("table"),
    result.columns.indexOf("datasource"),
  );
  const kindIndex = Math.max(
    result.columns.indexOf("source_kind"),
    result.columns.indexOf("source_type"),
  );
  if (tableIndex < 0) return [];
  return result.rows
    .map((row) => ({
      source_table: String(row[tableIndex] ?? ""),
      source_kind: kindIndex >= 0 ? String(row[kindIndex] ?? "table") : "table",
    }))
    .filter((source) => source.source_table.length > 0);
}

export function parseLineageColumns(result: SqlResult): LineageColumn[] {
  const target = result.columns.indexOf("target_column");
  const table = result.columns.indexOf("source_table");
  const column = result.columns.indexOf("source_column");
  if (target < 0 || table < 0 || column < 0) return [];
  return result.rows
    .map((row) => ({
      target_column: String(row[target] ?? ""),
      source_table: String(row[table] ?? ""),
      source_column: String(row[column] ?? ""),
    }))
    .filter((row) => row.target_column && row.source_table && row.source_column);
}

/**
 * INFER SQLTABLE SOURCES/COLUMNS for the metric view. Two read-only SQL calls,
 * two rerunnable exhibits, then an idempotent ingest into the case graph.
 */
export async function inferLineage(
  rt: ToolRuntime,
  view: string,
  viewSql: string,
): Promise<{ exhibits: Exhibit[]; graph: LineageGraph }> {
  const effectiveViewSql = rt.sampleMode
    ? viewSql
    : normalizeViewDeclaration(
        viewSql,
        process.env.ZETARIS_SIC_TABLE || "edgar.sic_edgar_usl",
      );
  const sourcesSql = lineageSourcesSql(effectiveViewSql);
  const columnsSql = lineageColumnsSql(effectiveViewSql);

  const sources = await executeSqlTool({
    rt,
    tool: "lineage_sources",
    kind: "lineage",
    title: `lineage sources ${view}`,
    sql: sourcesSql,
    args: { view, sql: sourcesSql },
  });
  const columns = await executeSqlTool({
    rt,
    tool: "lineage_columns",
    kind: "lineage",
    title: `lineage columns ${view}`,
    sql: columnsSql,
    args: { view, sql: columnsSql },
  });

  const graph: LineageGraph = {
    case_id: rt.caseId,
    view,
    built_at: new Date().toISOString(),
    nodes: [],
    edges: [],
    sources: [],
    columns: [],
  };
  const merged = ingestLineage(rt.root, graph, {
    sources: parseLineageSources(sources.result),
    columns: parseLineageColumns(columns.result),
  });

  return { exhibits: [sources.exhibit, columns.exhibit], graph: merged };
}
