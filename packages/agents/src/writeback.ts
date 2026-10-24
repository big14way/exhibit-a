import {
  advance,
  asSqlResult,
  emitTrace,
  executeWriteContract,
  verifyContract,
  type CaseState,
  type Exhibit,
  type HmemSummary,
  type SqlResult,
} from "@exhibit-a/core";
import { auditMemory, rememberCase } from "@exhibit-a/engines";
import {
  CORRECTED_METRIC,
  SHADOW_METRIC,
  USL_ROW_RULE,
  USL_TABLE_PATH,
  assertFinalContract,
  buildFinalWriteContract,
  emitComputedExhibit,
  executeSqlTool,
  finalReadSql,
  fromEnv,
  memoryNote,
  parseUslModel,
  repairContractSecret,
  showViewsSql,
  uslCompositeDqSql,
  uslListDqSql,
  uslLoadSql,
  uslRowDqSql,
  verifyWriteback,
  ZetarisClient,
  type ToolRuntime,
} from "@exhibit-a/tools";

export type ApprovalOptions = {
  root: string;
  state: CaseState;
  secret: string;
  sampleMode: boolean;
  approvedBy?: string;
};

/**
 * Operator approval is a state transition, not a write. It verifies the
 * shadow evidence, signs the exact final statement set, and stops at
 * AWAITING_APPROVAL. The writeback command is a separate deliberate action.
 */
export function approveWriteback(input: ApprovalOptions): CaseState {
  const state = input.state;
  const recovering = state.stage === "FAILED";
  if (recovering) {
    // Recovery is deliberately narrow: the core view and the reported view
    // already passed; only a catalog/verifier check may be repaired. A failed
    // final read or a changed original view is never recoverable this way.
    if (!state.writeback || state.writeback.ok) {
      throw new Error("FAILED case has no failed writeback result to recover");
    }
    if (!state.write_contract) {
      throw new Error("FAILED case has no prior write contract to recover");
    }
    const failed = state.writeback.checks
      .filter((check) => !check.ok)
      .map((check) => check.name);
    const recoverable = new Set(["usl_model", "view_catalog"]);
    const blocked = failed.filter((name) => !recoverable.has(name));
    if (blocked.length) {
      throw new Error(`cannot recover failed writeback checks: ${blocked.join(", ")}`);
    }
  } else if (state.stage !== "SHADOW_VERIFIED" && state.stage !== "AWAITING_APPROVAL") {
    throw new Error(
      `approval needs SHADOW_VERIFIED or AWAITING_APPROVAL; case is ${state.stage}`,
    );
  } else if (state.writeback) {
    throw new Error("case already has a writeback result; re-approval is not allowed");
  }
  if (!state.verification?.ok) {
    throw new Error("cannot approve a writeback whose shadow verifier did not pass");
  }
  if (!state.repair) {
    throw new Error("cannot approve a writeback without a repair plan");
  }
  if (state.contract) {
    verifyContract(state.contract, input.secret, {
      scope: SHADOW_METRIC,
      ignoreExpiry: true,
    });
  }
  const { contract, note } = buildFinalWriteContract({
    state,
    secret: input.secret,
    sampleMode: input.sampleMode,
    approvedBy: input.approvedBy,
  });
  verifyContract(contract, input.secret, {
    requireApproved: true,
    scope: CORRECTED_METRIC,
  });
  // FAILED is normally terminal. This is the one explicit recovery path: the
  // operator re-approves after a catalog-only verifier failure, and the
  // writeback re-executes the idempotent statements under a fresh contract.
  const next = recovering
    ? { ...state, stage: "AWAITING_APPROVAL" as const }
    : advance(state, "AWAITING_APPROVAL");
  emitTrace(input.root, {
    case_id: state.id,
    agent_name: "ScoutIntent",
    action: recovering ? "writeback.recover.approve" : "writeback.approve",
    input_summary: `shadow verifier ${state.verification.invariants.filter((row) => row.ok).length}/${state.verification.invariants.length}`,
    output_summary: `${recovering ? "recovery " : ""}operator-approved contract ${contract.id}; ${contract.statements.length} statements; awaiting writeback`,
    status: "success",
    latency_ms: 0,
    exhibit_ids: [],
  });
  return {
    ...next,
    write_contract: contract,
    writeback_note: note,
    writeback: recovering ? state.writeback : undefined,
    error: undefined,
    exhibits: state.exhibits,
  };
}

export type WritebackRun = {
  state: CaseState;
  exhibits: Exhibit[];
};

type ReadResult = {
  exhibit?: Exhibit;
  result?: SqlResult;
  error?: string;
};

export async function runWriteback(input: {
  root: string;
  state: CaseState;
  rt: ToolRuntime;
}): Promise<WritebackRun> {
  const { root, rt } = input;
  const state = input.state;
  const contract = state.write_contract;
  const secret = repairContractSecret(rt.sampleMode);
  if (!contract) throw new Error("case has no approved final write contract");
  if (state.stage !== "AWAITING_APPROVAL") {
    throw new Error(`writeback needs AWAITING_APPROVAL; case is ${state.stage}`);
  }
  if (!state.repair) throw new Error("case has no repair plan");
  assertFinalContract(contract);
  verifyContract(contract, secret, {
    requireApproved: true,
    scope: CORRECTED_METRIC,
  });

  const note =
    state.writeback_note ??
    memoryNote({
      caseId: state.id,
      verdict: state.verdict,
      exhibitIds: state.verdict?.exhibit_ids ?? state.exhibits.map((row) => row.id),
    });

  let writeExecuted = false;
  if (!rt.sampleMode) {
    if (!rt.zetaris) {
      throw new Error("live writeback needs a Zetaris client");
    }
    try {
      await executeWriteContract(
        contract,
        secret,
        async (sql) => {
          try {
            await rt.zetaris!.runSql(sql, { mode: "write" });
          } catch (err) {
            if (isIgnorableWriteError(sql, err)) return;
            throw err;
          }
        },
        { requireApproved: true, scope: CORRECTED_METRIC },
      );
      writeExecuted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = advance(state, "FAILED");
      emitTrace(root, {
        case_id: state.id,
        agent_name: "Writer",
        action: "writeback.execute",
        input_summary: `contract ${contract.id}`,
        output_summary: `write failed: ${message}`,
        status: "error",
        latency_ms: 0,
        exhibit_ids: [],
      });
      return {
        state: { ...failed, error: `writeback failed: ${message}` },
        exhibits: [],
      };
    }
  }

  let next = advance(state, "WRITTEN");
  const exhibits: Exhibit[] = [];

  const contractExhibit = emitComputedExhibit({
    rt,
    tool: "writeback",
    kind: "writeback",
    title: `operator-approved writeback ${contract.id}`,
    args: { contract, sample_mode: rt.sampleMode, note },
    result: {
      contract_id: contract.id,
      scope: contract.scope,
      statements_sha256: contract.statements_sha256,
      statements_count: contract.statements.length,
      mode: rt.sampleMode ? "sample-replay" : "live-write",
      executed: writeExecuted,
      original_view_touched: false,
      approval: "operator-approved",
    },
  });
  exhibits.push(contractExhibit);

  const shadowExhibit = state.exhibits.find((row) => row.tool === "repair_shadow");
  const historyExhibit = state.exhibits.find((row) => row.tool === "metric_history");
  if (!shadowExhibit) throw new Error("case has no shadow read exhibit");
  if (!historyExhibit) throw new Error("case has no original metric history exhibit");
  const shadow = shadowExhibit.result as SqlResult;
  const originalHistory = historyExhibit.result as SqlResult;
  const uniqueFacts = Number(
    state.verification?.invariants.find((row) => row.name === "uniqueness")?.numbers
      ?.unique_annual_facts ?? shadow.row_count,
  );

  const readbacks: {
    finalRead: ReadResult;
    originalReread: ReadResult;
    uslLoad: ReadResult;
    dqList: ReadResult;
    compositeDq: ReadResult;
    rowDq: ReadResult;
    views: ReadResult;
  } = rt.sampleMode
    ? sampleReadbacks({ shadow, originalHistory, note, uniqueFacts })
    : await liveReadbacks(rt);

  if (rt.sampleMode) {
    emitSampleReadbacks(rt, readbacks);
  }
  for (const read of Object.values(readbacks)) {
    if (read.exhibit) exhibits.push(read.exhibit);
  }

  const uslModel = readbacks.uslLoad.result
    ? safeParseUsl(readbacks.uslLoad.result)
    : undefined;

  const verification = verifyWriteback({
    contractId: contract.id,
    writtenMetric: CORRECTED_METRIC,
    contractOk: true,
    writeExecuted: rt.sampleMode || writeExecuted,
    caseId: state.id,
    note,
    shadow,
    finalRead: readbacks.finalRead.result,
    finalReadError: readbacks.finalRead.error,
    originalHistory,
    originalReread: readbacks.originalReread.result,
    originalError: readbacks.originalReread.error,
    uslModel,
    uslError: readbacks.uslLoad.error,
    dqList: readbacks.dqList.result,
    dqListError: readbacks.dqList.error,
    compositeDq: readbacks.compositeDq.result,
    rowDq: readbacks.rowDq.result,
    dqRunError: readbacks.compositeDq.error ?? readbacks.rowDq.error,
    views: readbacks.views.result,
    viewsError: readbacks.views.error,
  });

  const verifiedExhibit = emitComputedExhibit({
    rt,
    tool: "write_verified",
    kind: "test",
    title: `writeback verifier ${CORRECTED_METRIC}`,
    args: {
      contract_id: contract.id,
      note,
      write_executed: rt.sampleMode || writeExecuted,
      shadow_exhibit_id: shadowExhibit.id,
      final_read_exhibit_id: readbacks.finalRead.exhibit?.id,
      usl_load_exhibit_id: readbacks.uslLoad.exhibit?.id,
      dq_list_exhibit_id: readbacks.dqList.exhibit?.id,
      composite_dq_exhibit_id: readbacks.compositeDq.exhibit?.id,
      row_dq_exhibit_id: readbacks.rowDq.exhibit?.id,
      views_exhibit_id: readbacks.views.exhibit?.id,
      original_exhibit_id: historyExhibit.id,
      original_reread_exhibit_id: readbacks.originalReread.exhibit?.id,
    },
    result: verification as unknown as Record<string, unknown>,
    sql: contract.statements.find((statement) => statement.includes("CREATE OR REPLACE SCHEMASTORE VIEW")),
  });
  exhibits.push(verifiedExhibit);

  let hmem: HmemSummary | undefined;
  if (verification.ok) {
    const record = rememberCase(
      root,
      {
        ...state,
        stage: "CLOSED",
        verdict: state.verdict,
        exhibits: [...state.exhibits, ...exhibits],
      },
      note,
    );
    const audit = auditMemory(root);
    hmem = {
      record_id: record.case_id,
      records: audit.records,
      valid: audit.valid,
      malformed: audit.malformed,
      duplicates: audit.duplicates,
      storage: audit.storage,
      recalled: state.memory?.hits.length ?? 0,
    };
  }

  const memoryExhibit = emitComputedExhibit({
    rt,
    tool: "memory",
    kind: "memory",
    title: `catalog memory ${USL_TABLE_PATH}`,
    args: {
      case_id: state.id,
      verdict: state.verdict,
      exhibit_ids: state.verdict?.exhibit_ids ?? [],
      note,
    },
    result: {
      table: USL_TABLE_PATH,
      description: note,
      readback: verification.ok ? "verified" : "failed",
      memory_kind: "USL table description",
      original_view_touched: false,
      hmem,
    },
  });
  exhibits.push(memoryExhibit);

  const allExhibits = [...state.exhibits, ...exhibits];
  if (verification.ok) {
    next = advance(next, "WRITE_VERIFIED");
    next = advance(next, "MEMORISED");
    next = advance(next, "CLOSED");
  } else {
    next = advance(next, "FAILED");
  }

  emitTrace(root, {
    case_id: state.id,
    agent_name: "Verifier",
    action: "writeback.verify",
    input_summary: `${CORRECTED_METRIC}, ${verification.checks.length} checks`,
    output_summary: verification.ok
      ? `WRITE_VERIFIED ${verification.checks.filter((row) => row.ok).length}/${verification.checks.length}`
      : `writeback failed: ${verification.checks.filter((row) => !row.ok).map((row) => row.name).join(", ")}`,
    status: verification.ok ? "success" : "error",
    latency_ms: 0,
    exhibit_ids: [verifiedExhibit.id, memoryExhibit.id],
  });

  return {
    state: {
      ...next,
      writeback: verification,
      exhibits: allExhibits,
      hmem,
      error: verification.ok
        ? undefined
        : `writeback verifier failed: ${verification.checks
            .filter((row) => !row.ok)
            .map((row) => row.name)
            .join(", ")}`,
    },
    exhibits,
  };
}

function emitSampleReadbacks(
  rt: ToolRuntime,
  readbacks: Record<string, ReadResult>,
): void {
  const emit = (
    key: string,
    tool: string,
    kind: "writeback" | "test" | "metadata",
    title: string,
    result: SqlResult | undefined,
  ): void => {
    if (!result) return;
    readbacks[key]!.exhibit = emitComputedExhibit({
      rt,
      tool,
      kind,
      title: `SAMPLE_MODE replay: ${title}`,
      args: { sample_mode: true },
      result: result as unknown as Record<string, unknown>,
      source: "sample-replay",
    });
  };
  emit(
    "finalRead",
    "write_read",
    "writeback",
    `final view ${CORRECTED_METRIC}`,
    readbacks.finalRead?.result,
  );
  emit(
    "originalReread",
    "write_original",
    "test",
    "reported view reread",
    readbacks.originalReread?.result,
  );
  emit(
    "uslLoad",
    "write_usl",
    "metadata",
    `LOAD USL ${USL_TABLE_PATH}`,
    readbacks.uslLoad?.result,
  );
  emit(
    "dqList",
    "write_dq_list",
    "test",
    "LIST DQ",
    readbacks.dqList?.result,
  );
  emit(
    "compositeDq",
    "write_dq_composite",
    "test",
    "RUN DQ composite key",
    readbacks.compositeDq?.result,
  );
  emit(
    "rowDq",
    "write_dq_row",
    "test",
    "RUN DQ row rule",
    readbacks.rowDq?.result,
  );
  emit(
    "views",
    "write_views",
    "metadata",
    "SHOW DATASOURCE VIEWS",
    readbacks.views?.result,
  );
}

async function liveReadbacks(rt: ToolRuntime): Promise<{
  finalRead: ReadResult;
  originalReread: ReadResult;
  uslLoad: ReadResult;
  dqList: ReadResult;
  compositeDq: ReadResult;
  rowDq: ReadResult;
  views: ReadResult;
}> {
  const cfg = fromEnv();
  if (!cfg) throw new Error("live writeback needs ZETARIS_REST_URL and ZETARIS_API_KEY");
  // A separate client instance is a separate session; every read below is also
  // constrained by the investigation-mode read guard.
  const readRt: ToolRuntime = {
    ...rt,
    agent: "Verifier",
    zetaris: new ZetarisClient(cfg),
  };
  const read = async (tool: string, title: string, sql: string): Promise<ReadResult> => {
    try {
      const got = await executeSqlTool({
        rt: readRt,
        tool,
        kind: "writeback",
        title,
        sql,
        args: { sql },
      });
      return { exhibit: got.exhibit, result: got.result };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    finalRead: await read(
      "write_read",
      `verify-after-write ${CORRECTED_METRIC}`,
      finalReadSql(CORRECTED_METRIC),
    ),
    originalReread: await read(
      "write_original",
      `reported view reread ${rt.caseId}`,
      "SELECT * FROM analytics.sector_revenue_by_year ORDER BY fiscal_year",
    ),
    uslLoad: await read("write_usl", `LOAD USL ${USL_TABLE_PATH}`, uslLoadSql()),
    dqList: await read("write_dq_list", `LIST DQ ${USL_TABLE_PATH}`, uslListDqSql()),
    compositeDq: await read(
      "write_dq_composite",
      `RUN DQ composite key ${USL_TABLE_PATH}`,
      uslCompositeDqSql(),
    ),
    rowDq: await read(
      "write_dq_row",
      `RUN DQ ${USL_ROW_RULE} ${USL_TABLE_PATH}`,
      uslRowDqSql(),
    ),
    views: await read("write_views", "SHOW DATASOURCE VIEWS", showViewsSql()),
  };
}

/**
 * SAMPLE_MODE has no platform to read from. These are explicitly labelled
 * replay results built from the already-verified shadow and canonical counts;
 * the writeback exhibit records executed=false.
 */
function sampleReadbacks(input: {
  shadow: SqlResult;
  originalHistory: SqlResult;
  note: string;
  uniqueFacts: number;
}): {
  finalRead: ReadResult;
  originalReread: ReadResult;
  uslLoad: ReadResult;
  dqList: ReadResult;
  compositeDq: ReadResult;
  rowDq: ReadResult;
  views: ReadResult;
} {
  const rows = input.uniqueFacts;
  const finalRead = asSqlResult(input.shadow.columns, input.shadow.rows);
  const originalReread = asSqlResult(
    input.originalHistory.columns,
    input.originalHistory.rows,
  );
  const uslModel = {
    namespace: ["metastore", "exhibit_a"],
    name: "revenue_facts",
    description: input.note,
    tables: [
      {
        name: "fact",
        columnSpecs: [
          { name: "cik", dataType: '"varchar(10)"', notNull: { columns: [] } },
          { name: "period_end", dataType: '"date"', notNull: { columns: [] } },
          { name: "period_frame", dataType: '"varchar(16)"' },
          { name: "sic_division", dataType: '"varchar(200)"' },
          { name: "period_year", dataType: '"int"', notNull: { columns: [] } },
          { name: "value_usd", dataType: '"double"' },
          { name: "filed_date", dataType: '"date"' },
        ],
        primaryKey: { columns: ["cik", "period_end"] },
        dqAnnotations: [
          { name: USL_ROW_RULE, expression: "period_frame IS NOT NULL" },
        ],
        activateQuery: "sample replay: canonical-period select",
      },
    ],
  };
  return {
    finalRead: { result: finalRead },
    originalReread: { result: originalReread },
    uslLoad: {
      result: asSqlResult(["json"], [[JSON.stringify(uslModel)]]),
    },
    dqList: {
      result: asSqlResult(
        ["name", "table", "type", "expression"],
        [
          ["cik,period_end", "fact", "Primary key constraints", ""],
          [
            USL_ROW_RULE,
            "fact",
            "Custom Data Quality",
            "period_frame IS NOT NULL",
          ],
        ],
      ),
    },
    compositeDq: {
      result: asSqlResult(
        ["name", "table", "type", "total_record", "valid_record", "invalid_record"],
        [["cik,period_end", "fact", "Primary Key Constraint", String(rows), String(rows), "0"]],
      ),
    },
    rowDq: {
      result: asSqlResult(
        ["name", "table", "type", "total_record", "valid_record", "invalid_record"],
        [[USL_ROW_RULE, "fact", "Custom Data Quality", String(rows), String(rows), "0"]],
      ),
    },
    views: {
      result: asSqlResult(
        ["name", "type", "container"],
        [["sector_revenue_by_year_v2", "view", "exhibit_a"]],
      ),
    },
  };
}

function safeParseUsl(result: SqlResult): unknown {
  try {
    return parseUslModel(result);
  } catch {
    return undefined;
  }
}

function isIgnorableWriteError(sql: string, err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Only the idempotent "already exists" case is skipped; "does not exist" or
  // any other failure must surface so a half-applied contract cannot close.
  if (!/already\s+exists/i.test(message)) return false;
  if (/CREATE\s+SCHEMASTORE\s+CONTAINER/i.test(sql)) return true;
  if (/CREATE\s+NAMESPACE\s+IF\s+NOT\s+EXISTS/i.test(sql)) return true;
  if (/COMPILE\s+USL/i.test(sql)) return true;
  if (/REGISTER\s+DQ/i.test(sql)) return true;
  return false;
}
