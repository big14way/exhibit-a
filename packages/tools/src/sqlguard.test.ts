import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReadOnly, SqlGuardError } from "./sqlguard.ts";

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
