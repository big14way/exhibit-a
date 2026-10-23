import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertReadOnly,
  assertWriteStatement,
  SqlGuardError,
} from "./sqlguard.ts";

test("allows SELECT and strips a trailing semicolon", () => {
  assert.equal(assertReadOnly("select 1;"), "select 1");
});

test("rejects writes in investigation mode", () => {
  assert.throws(() => assertReadOnly("CREATE VIEW x AS SELECT 1"), SqlGuardError);
});

test("rejects stacked statements", () => {
  assert.throws(() => assertReadOnly("SELECT 1; DROP TABLE t"), SqlGuardError);
});

test("allows INFER SQLTABLE", () => {
  assert.equal(
    assertReadOnly("INFER SQLTABLE SOURCES SPEC SELECT a FROM t"),
    "INFER SQLTABLE SOURCES SPEC SELECT a FROM t",
  );
});

test("write mode keeps COMPILE USL newlines and internal semicolons", () => {
  const sql = `COMPILE USL revenue_facts DEPLOY NAMESPACE lightning.metastore.exhibit_a DDL
CREATE TABLE fact (
  cik varchar(10) NOT NULL,
  period_end date NOT NULL,
  PRIMARY KEY (cik, period_end)
);
CREATE TABLE other (
  id int NOT NULL PRIMARY KEY
);`;
  const guarded = assertWriteStatement(sql);
  assert.match(guarded, /\nCREATE TABLE fact/);
  assert.match(guarded, /PRIMARY KEY \(cik, period_end\)/);
  assert.match(guarded, /CREATE TABLE other/);
  assert.ok(!guarded.endsWith(";"));
});

test("write mode still rejects stacked top-level statements", () => {
  assert.throws(
    () => assertWriteStatement("CREATE VIEW x AS SELECT 1; DROP TABLE t"),
    SqlGuardError,
  );
});
