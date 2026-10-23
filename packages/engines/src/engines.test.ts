import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { CaseState } from "@exhibit-a/core";
import { auditMemory, memoryPath, mineMemory, recallMemory, rememberCase } from "./memory.ts";
import { chunkContext } from "./markovian.ts";

function closedCase(id: string): CaseState {
  return {
    id,
    reported_at: "2026-10-22T00:00:00.000Z",
    question: "is the FY2018 jump real?",
    metric: "analytics.sector_revenue_by_year",
    stage: "CLOSED",
    sample_mode: true,
    exhibits: [],
    hypotheses: [],
    verdict: {
      kind: "MIXED",
      causes: [
        {
          cause: "filing_year_duplication",
          kind: "artifact",
          exhibit_ids: [],
          share: 0.96168,
        },
        {
          cause: "real_change",
          kind: "real",
          exhibit_ids: [],
          share: 0.03832,
        },
      ],
      exhibit_ids: [],
      notes: [],
    },
  };
}

test("H-MEM is cold, then recalls a remembered case with its cause shares", () => {
  const root = mkdtempSync(join(tmpdir(), "exhibit-a-hmem-"));
  try {
    const cold = recallMemory(root, {
      metric: "analytics.sector_revenue_by_year",
      question: "is the FY2018 jump real?",
    });
    assert.equal(cold.cold_start, true);
    assert.equal(cold.hits.length, 0);

    const record = rememberCase(root, closedCase("case_prior"));
    assert.equal(record.case_id, "case_prior");
    const warm = recallMemory(root, {
      metric: "analytics.sector_revenue_by_year",
      question: "is the FY2018 jump in Manufacturing real?",
    });
    assert.equal(warm.cold_start, false);
    assert.equal(warm.hits.length, 1);
    assert.equal(warm.hits[0]?.case_id, "case_prior");
    assert.match(warm.hits[0]?.excerpt ?? "", /MIXED/);
    assert.ok(warm.hits[0]?.match.includes("same metric"));
    assert.deepEqual(auditMemory(root), {
      storage: memoryPath(root),
      records: 1,
      valid: 1,
      malformed: 0,
      duplicates: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H-MEM audit reports malformed records and mining is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "exhibit-a-hmem-audit-"));
  try {
    const path = memoryPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ version: 1, records: [{ bad: true }] }),
      "utf8",
    );
    const malformed = auditMemory(root);
    assert.equal(malformed.records, 0);
    assert.equal(malformed.malformed, 1);

    const caseDir = join(root, "logs", "case_mined");
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(
      join(caseDir, "state.json"),
      JSON.stringify(closedCase("case_mined")),
      "utf8",
    );
    const first = mineMemory(root);
    const second = mineMemory(root);
    assert.equal(first.mined, 1);
    assert.equal(second.mined, 1);
    assert.equal(second.audit.records, 1);
    assert.equal(second.audit.valid, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Markovian context is bounded and exposes previous/next transitions", () => {
  const pack = chunkContext({
    maxChars: 200,
    items: [
      { id: "a", kind: "baseline", text: "onset Manufacturing 2018 ".repeat(5) },
      { id: "b", kind: "sql", text: "100 rows, 32 dates ".repeat(5) },
      { id: "c", kind: "second_channel", text: "SEC parity 12/12 ".repeat(5) },
    ],
  });
  assert.equal(pack.mode, "markovian-bounded");
  assert.equal(pack.item_count, 3);
  assert.ok(pack.chunk_count >= 2);
  assert.equal(pack.chunks[0]?.previous, null);
  assert.equal(pack.chunks.at(-1)?.next, null);
  assert.equal(pack.chunks[0]?.next, pack.chunks[1]?.key);
  assert.equal(pack.chunks[1]?.previous, pack.chunks[0]?.key);
});
