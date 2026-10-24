import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ClaimCheck } from "./check_claims.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULT = resolve(ROOT, "evals/results/latest.json");

test("the committed eval result has 20 passing claim checks", () => {
  const result = JSON.parse(readFileSync(RESULT, "utf8")) as {
    mode: string;
    cold: { exhibits: number; sample_mode: boolean };
    closed: { exhibits: number; stage: string };
    claims: ClaimCheck[];
  };
  assert.match(result.mode, /SAMPLE_MODE/);
  assert.equal(result.cold.sample_mode, true);
  assert.equal(result.cold.exhibits, 23);
  assert.equal(result.closed.exhibits, 33);
  assert.equal(result.closed.stage, "CLOSED");
  assert.equal(result.claims.length, 20);
  assert.deepEqual(
    result.claims.filter((claim) => !claim.ok).map((claim) => claim.id),
    [],
  );
});
