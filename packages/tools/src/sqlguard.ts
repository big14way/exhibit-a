const READ_PREFIXES = [
  "SELECT",
  "WITH",
  "SHOW",
  "DESCRIBE",
  "EXPLAIN",
  "LOAD USL",
  "LIST DQ",
  "RUN DQ",
  "SHOW DQ",
  "INFER SQLTABLE",
];

const READ_PREFIX_PATTERN = new RegExp(
  `^(?:${READ_PREFIXES.map((prefix) => prefix.replace(/\s+/g, "\\s+")).join("|")})\\b`,
  "i",
);

/**
 * Statement forms that change platform state. A read-only statement may not
 * contain any of these anywhere, not just at the start: Spark SQL accepts a
 * CTE before INSERT, and `EXPLAIN`/`WITH` would otherwise smuggle a write
 * past a prefix check. String literals are blanked before the scan so a
 * quoted value such as 'create' is not a false positive.
 */
const WRITE_FORMS: RegExp[] = [
  /\bINSERT\s+(?:INTO|OVERWRITE)\b/i,
  /\bUPDATE\s+[A-Za-z_"`[]/i,
  /\bDELETE\s+FROM\b/i,
  /\bMERGE\s+INTO\b/i,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:SCHEMASTORE\s+|LIGHTNING\s+|EXTERNAL\s+)?(?:VIEW|TABLE|DATABASE|SCHEMA|CONTAINER|NAMESPACE|FUNCTION|INDEX|DATASOURCE)\b/i,
  /\bDROP\s+(?:SCHEMASTORE\s+|LIGHTNING\s+)?(?:VIEW|TABLE|DATABASE|SCHEMA|CONTAINER|NAMESPACE|FUNCTION|INDEX|DATASOURCE|USL)\b/i,
  /\bALTER\s+(?:VIEW|TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bREPLACE\s+(?:INTO|TABLE)\b/i,
  /\bLOAD\s+DATA\b/i,
  /\b(?:CACHE|UNCACHE)\s+TABLE\b/i,
  /\bREFRESH\s+TABLE\b/i,
  /\b(?:COMPILE|ACTIVATE|UPDATE|REMOVE|DEACTIVATE)\s+USL\b/i,
  /\b(?:REGISTER|REMOVE|DELETE)\s+DQ\b/i,
  /\b(?:GRANT|REVOKE)\b/i,
  /\bSET\s+[A-Za-z_.]+\s*=/i,
  /\b(?:CALL|EXEC(?:UTE)?)\s+[A-Za-z_]/i,
];

export type GuardMode = "investigate" | "write";

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGuardError";
  }
}

function stripComments(sql: string, collapseWhitespace = true): string {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  return collapseWhitespace ? stripped.replace(/\s+/g, " ").trim() : stripped.trim();
}

function blankStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function isCompileUsl(sql: string): boolean {
  return /^COMPILE\s+USL\b/i.test(sql);
}

export function normalizeSql(sql: string): string {
  const stripped = stripComments(sql);
  if (!stripped) throw new SqlGuardError("empty SQL");
  return stripped.replace(/;+\s*$/g, "").trim();
}

/**
 * Writes are normally single statements, so internal semicolons are rejected.
 * `COMPILE USL ... DDL` is the exception: its CREATE TABLE definitions are
 * semicolon-separated and the platform requires the newlines to be preserved.
 */
export function normalizeWriteSql(sql: string): string {
  const raw = stripComments(sql, false);
  if (!raw) throw new SqlGuardError("empty SQL");
  if (isCompileUsl(raw)) {
    return raw.replace(/;+\s*$/g, "").trim();
  }
  return normalizeSql(raw);
}

export function assertWriteStatement(sql: string): string {
  const normalized = normalizeWriteSql(sql);
  if (!isCompileUsl(normalized) && normalized.includes(";")) {
    throw new SqlGuardError("only one statement per call; no extra semicolons");
  }
  return normalized;
}

export function assertSingleStatement(sql: string): string {
  const normalized = normalizeSql(sql);
  if (normalized.includes(";")) {
    throw new SqlGuardError("only one statement per call; no extra semicolons");
  }
  return normalized;
}

/** The first write form found in a statement, or undefined when it is clean. */
export function findWriteForm(sql: string): string | undefined {
  const scan = blankStringLiterals(sql);
  for (const form of WRITE_FORMS) {
    const hit = scan.match(form);
    if (hit) return hit[0].replace(/\s+/g, " ").toUpperCase();
  }
  return undefined;
}

export function assertReadOnly(sql: string): string {
  const normalized = assertSingleStatement(sql);
  if (!READ_PREFIX_PATTERN.test(normalized)) {
    throw new SqlGuardError(
      `investigation mode allows only: ${READ_PREFIXES.join(" | ")}`,
    );
  }
  const writeForm = findWriteForm(normalized);
  if (writeForm) {
    throw new SqlGuardError(
      `investigation mode is read-only; statement contains ${writeForm}`,
    );
  }
  return normalized;
}

export function guardSql(sql: string, mode: GuardMode): string {
  if (mode === "investigate") return assertReadOnly(sql);
  return assertWriteStatement(sql);
}
