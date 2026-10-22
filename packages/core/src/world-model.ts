import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LineageEdge, LineageGraph, LineageSource, LineageColumn } from "./models.ts";

/**
 * Local World Model reference: an append-only, idempotent lineage graph per case.
 * The Meterless engine is the intended backend; this file keeps the same
 * node/edge contract so the investigator and gates do not change when it lands.
 */
export function worldModelPath(root: string, caseId: string): string {
  return join(root, "logs", caseId, "world-model.json");
}

export function emptyGraph(caseId: string, view: string): LineageGraph {
  return {
    case_id: caseId,
    view,
    built_at: new Date().toISOString(),
    nodes: [],
    edges: [],
    sources: [],
    columns: [],
  };
}

function edgeKey(edge: LineageEdge): string {
  return `${edge.kind}:${edge.from}->${edge.to}:${edge.column ?? ""}`;
}

function sourceKey(source: LineageSource): string {
  return `${source.source_table}:${source.source_kind}`;
}

function columnKey(column: LineageColumn): string {
  return `${column.target_column}:${column.source_table}.${column.source_column}`;
}

export function mergeGraph(
  graph: LineageGraph,
  input: { sources?: LineageSource[]; columns?: LineageColumn[]; view: string },
): LineageGraph {
  const nodes = new Set(graph.nodes);
  const edges = new Map(graph.edges.map((edge) => [edgeKey(edge), edge]));
  const sources = new Map(graph.sources.map((source) => [sourceKey(source), source]));
  const columns = new Map(graph.columns.map((column) => [columnKey(column), column]));

  nodes.add(input.view);
  for (const source of input.sources ?? []) {
    sources.set(sourceKey(source), source);
    nodes.add(source.source_table);
    const edge: LineageEdge = {
      from: source.source_table,
      to: input.view,
      kind: "source",
    };
    edges.set(edgeKey(edge), edge);
  }
  for (const column of input.columns ?? []) {
    columns.set(columnKey(column), column);
    nodes.add(column.source_table);
    nodes.add(`${column.source_table}.${column.source_column}`);
    nodes.add(`${input.view}.${column.target_column}`);
    const edge: LineageEdge = {
      from: `${column.source_table}.${column.source_column}`,
      to: `${input.view}.${column.target_column}`,
      kind: "column",
    };
    edges.set(edgeKey(edge), edge);
  }

  return {
    ...graph,
    view: input.view,
    nodes: [...nodes].sort(),
    edges: [...edges.values()],
    sources: [...sources.values()],
    columns: [...columns.values()],
  };
}

export function ingestLineage(
  root: string,
  graph: LineageGraph,
  input: { sources?: LineageSource[]; columns?: LineageColumn[] },
): LineageGraph {
  const path = worldModelPath(root, graph.case_id);
  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as LineageGraph)
    : graph;
  const next = mergeGraph(existing, { ...input, view: graph.view });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function loadGraph(root: string, caseId: string): LineageGraph | undefined {
  const path = worldModelPath(root, caseId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as LineageGraph;
}

/** True when `objectName` is upstream of `target` in the graph built for this case. */
export function isUpstream(graph: LineageGraph, objectName: string, target: string): boolean {
  const start = [...graph.nodes].find(
    (node) => node === objectName || node.endsWith(`.${objectName}`),
  );
  if (!start) return false;
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    if (node === target) return true;
    for (const next of adjacency.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}
