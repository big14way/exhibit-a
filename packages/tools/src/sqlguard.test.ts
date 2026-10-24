import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertReadOnly,
  assertWriteStatement,
  findWriteForm,
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

test("a CTE cannot smuggle a write past the read-only guard", () => {
  assert.throws(
    () =>
      assertReadOnly(
        "WITH t AS (SELECT 1) INSERT INTO analytics.sector_revenue_by_year SELECT * FROM t",
      ),
    /INSERT INTO/,
  );
  assert.throws(
    () =>
      assertReadOnly(
        "with t as (select 1) create or replace schemastore view analytics.sector_revenue_by_year as select * from t",
      ),
    /CREATE OR REPLACE SCHEMASTORE VIEW/,
  );
  assert.throws(
    () => assertReadOnly("EXPLAIN DELETE FROM edgar.apple_revenue_table"),
    /DELETE FROM/,
  );
  assert.throws(
    () => assertReadOnly("SELECT 1 UNION ALL SELECT 2 FROM t MERGE INTO x USING y ON 1=1"),
    /MERGE INTO/,
  );
  assert.throws(() => assertReadOnly("SELECT * FROM t; -- c\n REGISTER DQ r ON x"), SqlGuardError);
});

test("read prefixes must be whole words", () => {
  assert.throws(() => assertReadOnly("SHOWDATASOURCE VIEWS"), SqlGuardError);
  assert.throws(() => assertReadOnly("SELECTED FROM t"), SqlGuardError);
  assert.equal(assertReadOnly("SHOW DATASOURCE VIEWS"), "SHOW DATASOURCE VIEWS");
  assert.equal(assertReadOnly("LOAD USL lightning.metastore.exhibit_a.revenue_facts"),
    "LOAD USL lightning.metastore.exhibit_a.revenue_facts");
});

test("write keywords inside string literals are not writes", () => {
  const sql = "SELECT 'create view x' AS note, \"drop table\" AS other FROM t WHERE k = 'insert into'";
  assert.equal(findWriteForm(sql), undefined);
  assert.equal(assertReadOnly(sql), sql);
});

test("the generated investigation SQL stays read-only under the stricter guard", () => {
  const statements = [
    "SHOW LIGHTNING DATABASES",
    "DESCRIBE DATASOURCE TABLE analytics.sector_revenue_by_year",
    "SELECT * FROM analytics.sector_revenue_by_year ORDER BY fiscal_year",
    "SELECT s.sic_division, f.cik, f.period_start, f.period_end, f.period_frame, f.value_usd, f.filed_date FROM (SELECT * FROM edgar.apple_revenue_table UNION ALL SELECT * FROM edgar.ibm_revenue_table) f LEFT JOIN sic_edgar_usl s ON s.cik = f.cik ORDER BY f.cik, f.period_end, f.filed_date",
    "SELECT COALESCE(CAST(period_year AS int), 0) AS y, COUNT(*) - COUNT(DISTINCT period_end) AS duplicate_rows FROM t GROUP BY 1",
    "LIST DQ lightning.metastore.exhibit_a.revenue_facts.fact",
    "RUN DQ cik,period_end lightning.metastore.exhibit_a.revenue_facts.fact",
    "INFER SQLTABLE COLUMNS SPEC SELECT s.sic_division, f.fiscal_year, SUM(f.value_usd) AS revenue_usd FROM (SELECT * FROM edgar.apple_revenue_table) f LEFT JOIN sic_edgar_usl s ON s.cik = f.cik WHERE f.fiscal_year BETWEEN 2016 AND 2019 GROUP BY s.sic_division, f.fiscal_year",
  ];
  for (const sql of statements) assert.equal(assertReadOnly(sql), sql);
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
