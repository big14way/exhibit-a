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

export function assertReadOnly(sql: string): string {
  const normalized = assertSingleStatement(sql);
  const upper = normalized.toUpperCase();
  const ok = READ_PREFIXES.some((prefix) => upper.startsWith(prefix));
  if (!ok) {
    throw new SqlGuardError(
      `investigation mode allows only: ${READ_PREFIXES.join(" | ")}`,
    );
  }
  return normalized;
}

export function guardSql(sql: string, mode: GuardMode): string {
  if (mode === "investigate") return assertReadOnly(sql);
  return assertWriteStatement(sql);
}
