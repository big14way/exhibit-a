import assert from "node:assert/strict";
import { test } from "node:test";
import {
  executeWriteContract,
  signContract,
  verifyContract,
} from "./contracts.ts";
import type { WriteContract } from "./models.ts";

const secret = "test-contract-secret";
const statements = [
  "CREATE SCHEMASTORE CONTAINER exhibit_a_shadow",
  "CREATE OR REPLACE SCHEMASTORE VIEW sector_revenue_by_year WITH CONTAINER exhibit_a_shadow AS SELECT 1 AS one",
];

function signed(overrides: Partial<Parameters<typeof signContract>[0]> = {}): WriteContract {
  return signContract(
    {
      case_id: "case_test",
      intent: "shadow only",
      scope: ["exhibit_a_shadow.sector_revenue_by_year"],
      statements,
      cost_ceiling: 0,
      ttl_ms: 60_000,
      signer: "ScoutIntent",
      ...overrides,
    },
    secret,
  );
}

test("a signed contract verifies only its exact scope and statements", () => {
  const contract = signed();
  verifyContract(contract, secret, {
    scope: "exhibit_a_shadow.sector_revenue_by_year",
    statement: statements[0],
  });
  assert.throws(
    () => verifyContract(contract, secret, { scope: "analytics.sector_revenue_by_year" }),
    /scope/,
  );
  assert.throws(
    () => verifyContract(contract, secret, { statement: "DROP TABLE analytics.sector_revenue_by_year" }),
    /not part/,
  );
});

test("a tampered statement, expired contract, or unapproved write is rejected", () => {
  const contract = signed();
  const tampered: WriteContract = {
    ...contract,
    statements: [...contract.statements, "DROP TABLE analytics.sector_revenue_by_year"],
  };
  assert.throws(() => verifyContract(tampered, secret), /statement hash/);

  const expired = signed({ ttl_ms: -1_000 });
  assert.throws(() => verifyContract(expired, secret), /expired/);

  const unapproved = signed();
  assert.throws(
    () => verifyContract(unapproved, secret, { requireApproved: true }),
    /not operator-approved/,
  );
});

test("the writer executes exactly the signed statements", async () => {
  const contract = signed();
  const seen: string[] = [];
  await executeWriteContract(contract, secret, async (sql) => {
    seen.push(sql);
  });
  assert.deepEqual(seen, statements);

  await assert.rejects(
    executeWriteContract(
      { ...contract, statements: [...statements, "DROP TABLE analytics.sector_revenue_by_year"] },
      secret,
      async () => {},
    ),
    /statement hash/,
  );
});
