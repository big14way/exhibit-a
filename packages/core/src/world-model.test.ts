import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  emptyGraph,
  ingestLineage,
  isUpstream,
  loadGraph,
  mergeGraph,
  type LineageColumn,
  type LineageSource,
} from "./index.ts";

test("lineage ingest is idempotent and supports upstream checks", () => {
  const root = mkdtempSync(join(tmpdir(), "exhibit-a-world-model-"));
  try {
    const sources: LineageSource[] = [
      { source_table: "edgar.apple_revenue_table", source_kind: "table" },
      { source_table: "sic_edgar_usl", source_kind: "table" },
    ];
    const columns: LineageColumn[] = [
      {
        target_column: "revenue_usd",
        source_table: "edgar.apple_revenue_table",
        source_column: "value_usd",
      },
    ];
    const graph = emptyGraph("case_test", "analytics.sector_revenue_by_year");
    const first = ingestLineage(root, graph, { sources, columns });
    const second = ingestLineage(root, graph, { sources, columns });
    assert.equal(first.edges.length, 3);
    assert.equal(second.edges.length, 3, "re-ingest does not duplicate edges");
    assert.ok(isUpstream(second, "edgar.apple_revenue_table", "analytics.sector_revenue_by_year"));
    assert.ok(isUpstream(second, "value_usd", "analytics.sector_revenue_by_year.revenue_usd"));
    assert.equal(isUpstream(second, "sic_edgar_usl", "analytics.sector_revenue_by_year.revenue_usd"), false);

    const loaded = loadGraph(root, "case_test");
    assert.ok(loaded);
    assert.equal(loaded.edges.length, 3);
    const raw = JSON.parse(readFileSync(join(root, "logs", "case_test", "world-model.json"), "utf8"));
    assert.equal(raw.nodes.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mergeGraph keeps distinct column edges", () => {
  const graph = emptyGraph("case_test", "v");
  const merged = mergeGraph(graph, {
    view: "v",
    sources: [{ source_table: "a", source_kind: "table" }],
    columns: [
      { target_column: "x", source_table: "a", source_column: "c1" },
      { target_column: "y", source_table: "a", source_column: "c2" },
    ],
  });
  assert.equal(merged.edges.length, 3);
  assert.equal(new Set(merged.edges.map((edge) => edge.to)).size, 3);
});
