import {
  sha256Json,
  signContract,
  type CaseState,
  type SqlResult,
  type VerifierInvariant,
  type WriteContract,
  type WritebackResult,
} from "@exhibit-a/core";
import {
  CORRECTED_CONTAINER,
  CORRECTED_METRIC,
  CORRECTED_VIEW_NAME,
  USL_NAMESPACE,
  USL_ROW_RULE,
  USL_TABLE_PATH,
  finalReadSql,
  finalViewStatement,
  memoryNote,
  uslActivationStatement,
  uslCompositeDqSql,
  uslDdlStatement,
  uslDescriptionStatement,
  uslLoadSql,
  uslRowDqSql,
} from "./repair.ts";

export const FINAL_WRITEBACK_TTL_MS = 15 * 60 * 1000;
export const SAMPLE_WRITEBACK_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** The exact statements shown to the operator at approval time. */
export function finalWriteStatements(input: {
  state: CaseState;
  sicTable?: string;
  note?: string;
}): { statements: string[]; note: string } {
  if (!input.state.repair) {
    throw new Error("cannot approve writeback without a repair plan");
  }
  const sicTable = input.sicTable ?? process.env.ZETARIS_SIC_TABLE ?? "edgar.sic_edgar_usl";
  const note =
    input.note ??
    memoryNote({
      caseId: input.state.id,
      verdict: input.state.verdict,
      exhibitIds: input.state.verdict?.exhibit_ids ?? input.state.exhibits.map((row) => row.id),
    });
  const statements = [
    `CREATE SCHEMASTORE CONTAINER ${CORRECTED_CONTAINER}`,
    finalViewStatement(input.state.repair.corrected_sql),
    `CREATE NAMESPACE IF NOT EXISTS ${USL_NAMESPACE}`,
    uslDdlStatement(),
    uslActivationStatement(sicTable),
    `REGISTER DQ ${USL_ROW_RULE} TABLE ${USL_TABLE_PATH} AS period_frame IS NOT NULL`,
    uslDescriptionStatement(note),
  ];
  return { statements, note };
}

export function buildFinalWriteContract(input: {
  state: CaseState;
  secret: string;
  sampleMode: boolean;
  approvedBy?: string;
}): { contract: WriteContract; note: string } {
  const { statements, note } = finalWriteStatements({ state: input.state });
  const contract = signContract(
    {
      case_id: input.state.id,
      intent:
        `Write the verified deduplicating repair to ${CORRECTED_METRIC}, ` +
        `create the ${USL_TABLE_PATH} composite-key duplicate detector, ` +
        "and record the case in the USL table description. Never touch the reported analytics view.",
      scope: [CORRECTED_METRIC, USL_NAMESPACE, USL_TABLE_PATH],
      statements,
      cost_ceiling: 0,
      ttl_ms: input.sampleMode ? SAMPLE_WRITEBACK_TTL_MS : FINAL_WRITEBACK_TTL_MS,
      signer: "ScoutIntent",
      approved: true,
      approved_by: input.approvedBy ?? "operator:cli",
    },
    input.secret,
  );
  assertFinalContract(contract);
  return { contract, note };
}

/**
 * The final contract may only write the corrected container/view and the
 * Exhibit A USL. The reported analytics view must never appear in a statement.
 */
export function assertFinalContract(contract: WriteContract): void {
  if (!contract.approved) throw new Error("final write contract is not operator-approved");
  if (!contract.scope.includes(CORRECTED_METRIC)) {
    throw new Error(`final contract does not scope ${CORRECTED_METRIC}`);
  }
  if (!contract.scope.includes(USL_TABLE_PATH)) {
    throw new Error(`final contract does not scope ${USL_TABLE_PATH}`);
  }
  const finalView = contract.statements.some((statement) =>
    new RegExp(
      `CREATE\\s+(OR\\s+REPLACE\\s+)?SCHEMASTORE\\s+VIEW\\s+${CORRECTED_VIEW_NAME}\\b`,
      "i",
    ).test(statement),
  );
  if (!finalView) throw new Error(`final contract does not create ${CORRECTED_METRIC}`);
  if (!contract.statements.some((statement) => /COMPILE\s+USL\b/i.test(statement))) {
    throw new Error("final contract does not compile the revenue_facts USL");
  }
  if (
    !contract.statements.some((statement) =>
      /PRIMARY\s+KEY\s*\(\s*cik\s*,\s*period_end\s*\)/i.test(statement),
    )
  ) {
    throw new Error("final contract does not declare the (cik, period_end) key");
  }
  for (const statement of contract.statements) {
    if (/\banalytics\s*\./i.test(statement)) {
      throw new Error("final contract must not touch the reported analytics view");
    }
    if (
      new RegExp(
        `CREATE\\s+(OR\\s+REPLACE\\s+)?SCHEMASTORE\\s+VIEW\\s+sector_revenue_by_year(?!_)\\b`,
        "i",
      ).test(statement)
    ) {
      throw new Error("final contract must not replace the original sector_revenue_by_year view");
    }
  }
}

type SeriesShape = {
  rows: { division: string; year: number; value: number }[];
  map: Map<string, number>;
  duplicateKeys: number;
  columnsOk: boolean;
};

function readSeries(result: SqlResult): SeriesShape {
  const division = result.columns.indexOf("sic_division");
  const year = result.columns.indexOf("fiscal_year");
  const value = result.columns.indexOf("revenue_usd");
  if (division < 0 || year < 0 || value < 0) {
    return { rows: [], map: new Map(), duplicateKeys: 0, columnsOk: false };
  }
  const rows: SeriesShape["rows"] = [];
  const map = new Map<string, number>();
  let duplicateKeys = 0;
  for (const row of result.rows) {
    const item = {
      division: String(row[division] ?? ""),
      year: Number(row[year]),
      value: Number(row[value]),
    };
    if (!Number.isFinite(item.year) || !Number.isFinite(item.value)) continue;
    const key = `${item.division}|${item.year}`;
    if (map.has(key)) duplicateKeys += 1;
    map.set(key, item.value);
    rows.push(item);
  }
  return { rows, map, duplicateKeys, columnsOk: true };
}

export function compareFinalRead(
  shadow: SqlResult,
  finalRead: SqlResult,
): { ok: boolean; detail: string; numbers: Record<string, number | string> } {
  const expected = readSeries(shadow);
  const actual = readSeries(finalRead);
  if (!expected.columnsOk || !actual.columnsOk) {
    return {
      ok: false,
      detail: "shadow or final read is missing sic_division, fiscal_year, revenue_usd",
      numbers: {},
    };
  }
  let missing = 0;
  let mismatched = 0;
  let maxDiff = 0;
  for (const [key, value] of expected.map) {
    const found = actual.map.get(key);
    if (found === undefined) {
      missing += 1;
      continue;
    }
    const diff = Math.abs(found - value) / Math.max(1, Math.abs(value));
    maxDiff = Math.max(maxDiff, diff);
    if (diff > 0.005) mismatched += 1;
  }
  let extra = 0;
  for (const key of actual.map.keys()) {
    if (!expected.map.has(key)) extra += 1;
  }
  const ok =
    actual.duplicateKeys === 0 &&
    missing === 0 &&
    mismatched === 0 &&
    extra === 0 &&
    actual.map.size === expected.map.size;
  return {
    ok,
    detail:
      `final view re-read via a separate Zetaris session: ${actual.map.size} cells; ` +
      `${missing} missing, ${mismatched} mismatched, ${extra} extra, ` +
      `max relative diff ${(maxDiff * 100).toFixed(3)}%`,
    numbers: {
      expected_cells: expected.map.size,
      final_cells: actual.map.size,
      missing,
      mismatched,
      extra,
      max_diff: maxDiff,
    },
  };
}

export function parseUslModel(result: SqlResult): unknown {
  const index = result.columns.indexOf("json");
  const value = index >= 0 ? result.rows[0]?.[index] : result.rows[0]?.[0];
  if (typeof value === "string") return JSON.parse(value) as unknown;
  return value;
}

type UslTable = {
  name?: string;
  primaryKey?: { columns?: string[] };
  dqAnnotations?: { name?: string; expression?: string }[];
  activateQuery?: string;
};

export function checkUslModel(
  model: unknown,
  input: { caseId: string; note: string },
): VerifierInvariant {
  const record = model as {
    tables?: UslTable[];
    description?: string;
    name?: string;
  } | null;
  const table = record?.tables?.find((row) => row.name === "fact") ?? record?.tables?.[0];
  const key = table?.primaryKey?.columns ?? [];
  const rules = table?.dqAnnotations?.map((row) => row.name) ?? [];
  const description = record?.description ?? "";
  const keyOk = key.includes("cik") && key.includes("period_end");
  const ruleOk = rules.includes(USL_ROW_RULE);
  const activationOk = Boolean(table?.activateQuery);
  const memoryOk = description.includes(input.caseId) || description.includes("Exhibit A");
  const ok = Boolean(record) && keyOk && ruleOk && activationOk && memoryOk;
  return {
    name: "usl_model",
    ok,
    detail:
      `LOAD USL ${USL_TABLE_PATH}: key (${key.join(", ") || "missing"}); ` +
      `DQ rules ${rules.join(", ") || "missing"}; ` +
      `activation ${activationOk ? "present" : "missing"}; ` +
      `catalog description ${memoryOk ? "contains the case" : "missing"}`,
    numbers: {
      key_columns: key.length,
      dq_rules: rules.length,
      description_chars: description.length,
    },
  };
}

export function checkDqList(result: SqlResult): VerifierInvariant {
  const nameIndex = result.columns.indexOf("name");
  const names = result.rows.map((row) => String(row[nameIndex >= 0 ? nameIndex : 0] ?? ""));
  const composite = names.some((name) => /cik\s*,\s*period_end/i.test(name));
  const rowRule = names.includes(USL_ROW_RULE);
  const ok = composite && rowRule;
  return {
    name: "usl_dq_catalog",
    ok,
    detail: `LIST DQ shows ${composite ? "composite key cik,period_end" : "no composite key"}; ` +
      `${rowRule ? USL_ROW_RULE : "no row rule"}`,
    numbers: { rules: names.length },
  };
}

function dqNumbers(result: SqlResult): {
  total: number;
  valid: number;
  invalid: number;
  name: string;
} {
  const index = (name: string) => result.columns.indexOf(name);
  const row = result.rows[0] ?? [];
  return {
    name: String(row[index("name")] ?? ""),
    total: Number(row[index("total_record")] ?? 0),
    valid: Number(row[index("valid_record")] ?? 0),
    invalid: Number(row[index("invalid_record")] ?? 0),
  };
}

export function checkDqRun(
  result: SqlResult,
  expectedName: string,
): VerifierInvariant {
  const numbers = dqNumbers(result);
  const ok = numbers.total > 0 && numbers.invalid === 0;
  return {
    name: expectedName === USL_ROW_RULE ? "usl_row_rule" : "usl_duplicate_detector",
    ok,
    detail:
      `${numbers.name || expectedName}: ${numbers.total} records, ` +
      `${numbers.valid} valid, ${numbers.invalid} invalid`,
    numbers: {
      total_record: numbers.total,
      valid_record: numbers.valid,
      invalid_record: numbers.invalid,
    },
  };
}

export function checkViewCatalog(result: SqlResult): VerifierInvariant {
  const text = result.rows.flat().map((cell) => String(cell ?? "")).join(" ");
  const found = text.includes(CORRECTED_VIEW_NAME);
  return {
    name: "view_catalog",
    ok: found,
    detail: found
      ? `SHOW DATASOURCE VIEWS lists ${CORRECTED_VIEW_NAME}`
      : `SHOW DATASOURCE VIEWS does not list ${CORRECTED_VIEW_NAME}`,
  };
}

export type WritebackVerificationInput = {
  contractId: string;
  writtenMetric: string;
  contractOk: boolean;
  writeExecuted: boolean;
  caseId: string;
  note: string;
  shadow: SqlResult;
  finalRead?: SqlResult;
  finalReadError?: string;
  originalHistory?: SqlResult;
  originalReread?: SqlResult;
  originalError?: string;
  uslModel?: unknown;
  uslError?: string;
  dqList?: SqlResult;
  dqListError?: string;
  compositeDq?: SqlResult;
  rowDq?: SqlResult;
  dqRunError?: string;
  views?: SqlResult;
  viewsError?: string;
};

export function verifyWriteback(input: WritebackVerificationInput): WritebackResult {
  const checks: VerifierInvariant[] = [];
  checks.push({
    name: "write_contract",
    ok: input.contractOk && input.writeExecuted,
    detail:
      input.contractOk && input.writeExecuted
        ? `operator-approved contract ${input.contractId} executed exactly its signed statements`
        : "final write contract did not execute",
  });

  if (!input.finalRead) {
    checks.push({
      name: "final_view_readback",
      ok: false,
      detail: input.finalReadError ?? "final view was not re-read",
    });
  } else {
    const comparison = compareFinalRead(input.shadow, input.finalRead);
    checks.push({ name: "final_view_readback", ...comparison });
  }

  if (input.uslError || !input.uslModel) {
    checks.push({
      name: "usl_model",
      ok: false,
      detail: input.uslError ?? "LOAD USL returned no model",
    });
  } else {
    checks.push(checkUslModel(input.uslModel, { caseId: input.caseId, note: input.note }));
  }

  if (input.dqListError || !input.dqList) {
    checks.push({
      name: "usl_dq_catalog",
      ok: false,
      detail: input.dqListError ?? "LIST DQ returned no result",
    });
  } else {
    checks.push(checkDqList(input.dqList));
  }

  if (input.dqRunError || !input.compositeDq) {
    checks.push({
      name: "usl_duplicate_detector",
      ok: false,
      detail: input.dqRunError ?? "RUN DQ composite key returned no result",
    });
  } else {
    checks.push(checkDqRun(input.compositeDq, "cik,period_end"));
  }

  if (input.dqRunError || !input.rowDq) {
    checks.push({
      name: "usl_row_rule",
      ok: false,
      detail: input.dqRunError ?? "RUN DQ row rule returned no result",
    });
  } else {
    checks.push(checkDqRun(input.rowDq, USL_ROW_RULE));
  }

  if (input.viewsError || !input.views) {
    checks.push({
      name: "view_catalog",
      ok: false,
      detail: input.viewsError ?? "SHOW DATASOURCE VIEWS returned no result",
    });
  } else {
    checks.push(checkViewCatalog(input.views));
  }

  if (input.originalError || !input.originalHistory || !input.originalReread) {
    checks.push({
      name: "original_untouched",
      ok: false,
      detail: input.originalError ?? "reported view was not re-read",
    });
  } else {
    const same = sha256Json(input.originalHistory) === sha256Json(input.originalReread);
    checks.push({
      name: "original_untouched",
      ok: same,
      detail: same
        ? `reported view re-read hash ${sha256Json(input.originalHistory).slice(0, 12)} is unchanged`
        : "reported view changed during writeback",
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    contract_id: input.contractId,
    written_metric: input.writtenMetric,
    checks,
    readback_sha256: input.finalRead ? sha256Json(input.finalRead) : undefined,
    usl_model: input.uslModel ? JSON.stringify(input.uslModel) : undefined,
    memory_note: input.note,
  };
}

export function writebackReadSql(): {
  finalRead: string;
  uslLoad: string;
  uslCompositeDq: string;
  uslRowDq: string;
} {
  return {
    finalRead: finalReadSql(CORRECTED_METRIC),
    uslLoad: uslLoadSql(),
    uslCompositeDq: uslCompositeDqSql(),
    uslRowDq: uslRowDqSql(),
  };
}
