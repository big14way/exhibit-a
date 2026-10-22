import {
  CassetteRecorder,
  asSqlResult,
  createExhibit,
  appendExhibit,
  emitTrace,
  lookupCassette,
  type Cassette,
  type Exhibit,
  type ExhibitKind,
  type SqlResult,
} from "@exhibit-a/core";
import { fromEnv, ZetarisClient } from "./zetaris.ts";

export type ToolRuntime = {
  root: string;
  caseId: string;
  agent: string;
  sampleMode: boolean;
  cassette?: Cassette;
  recorder?: CassetteRecorder;
  zetaris?: ZetarisClient;
};

export function createRuntime(input: {
  root: string;
  caseId: string;
  sampleMode: boolean;
  cassette?: Cassette;
  recorder?: CassetteRecorder;
}): ToolRuntime {
  const cfg = fromEnv();
  return {
    ...input,
    agent: "LeadInvestigator",
    zetaris: !input.sampleMode && cfg ? new ZetarisClient(cfg) : undefined,
  };
}

export async function executeSqlTool(input: {
  rt: ToolRuntime;
  tool: string;
  kind: ExhibitKind;
  title: string;
  sql: string;
  args?: unknown;
  source?: string;
}): Promise<{ exhibit: Exhibit; result: SqlResult }> {
  const started = Date.now();
  const args = input.args ?? { sql: input.sql };
  let result: SqlResult;
  let transport = "cassette";
  let source = input.source ?? "zetaris";

  try {
    if (input.rt.sampleMode) {
      if (!input.rt.cassette) throw new Error("SAMPLE_MODE requires a cassette");
      const replayed = lookupCassette(input.rt.cassette, input.tool, args);
      result = replayed as SqlResult;
      transport = "cassette";
    } else if (input.rt.zetaris) {
      const run = await input.rt.zetaris.runSql(input.sql);
      result = asSqlResult(run.columns, run.rows);
      transport = "zetaris-rest";
      input.rt.recorder?.record(input.tool, args, result);
    } else {
      throw new Error("live mode needs ZETARIS_REST_URL and ZETARIS_API_KEY");
    }

    const exhibit = createExhibit({
      kind: input.kind,
      source,
      transport,
      title: input.title,
      tool: input.tool,
      sql: input.sql,
      args,
      result,
      case_id: input.rt.caseId,
      agent: input.rt.agent,
    });
    appendExhibit(input.rt.root, exhibit);
    emitTrace(input.rt.root, {
      case_id: input.rt.caseId,
      agent_name: input.rt.agent,
      action: input.tool,
      input_summary: input.title,
      output_summary: `${result.row_count} rows` + (result.truncated ? " (truncated)" : ""),
      status: "success",
      exhibit_ids: [exhibit.id],
      latency_ms: Date.now() - started,
    });
    return { exhibit, result };
  } catch (err) {
    emitTrace(input.rt.root, {
      case_id: input.rt.caseId,
      agent_name: input.rt.agent,
      action: input.tool,
      input_summary: input.title,
      output_summary: err instanceof Error ? err.message : String(err),
      status: "error",
      exhibit_ids: [],
      latency_ms: Date.now() - started,
    });
    throw err;
  }
}

/**
 * Generic tool wrapper for non-SQL fact tools. SAMPLE_MODE replays the recorded
 * result for (tool, args); live mode runs `execute` and records it.
 */
export async function executeFactTool<T>(input: {
  rt: ToolRuntime;
  tool: string;
  kind: ExhibitKind;
  title: string;
  args: unknown;
  source: string;
  execute: () => Promise<T>;
  transport?: string;
}): Promise<{ exhibit: Exhibit; result: T }> {
  const started = Date.now();
  try {
    let result: T;
    let transport = input.transport ?? "live";
    if (input.rt.sampleMode) {
      if (!input.rt.cassette) throw new Error("SAMPLE_MODE requires a cassette");
      result = lookupCassette(input.rt.cassette, input.tool, input.args) as T;
      transport = "cassette";
    } else {
      result = await input.execute();
      input.rt.recorder?.record(input.tool, input.args, result);
    }
    const exhibit = createExhibit({
      kind: input.kind,
      source: input.source,
      transport,
      title: input.title,
      tool: input.tool,
      args: input.args,
      result: result as Record<string, unknown>,
      case_id: input.rt.caseId,
      agent: input.rt.agent,
    });
    appendExhibit(input.rt.root, exhibit);
    emitTrace(input.rt.root, {
      case_id: input.rt.caseId,
      agent_name: input.rt.agent,
      action: input.tool,
      input_summary: input.title,
      output_summary: summarize(input.tool, result),
      status: "success",
      exhibit_ids: [exhibit.id],
      latency_ms: Date.now() - started,
    });
    return { exhibit, result };
  } catch (err) {
    emitTrace(input.rt.root, {
      case_id: input.rt.caseId,
      agent_name: input.rt.agent,
      action: input.tool,
      input_summary: input.title,
      output_summary: err instanceof Error ? err.message : String(err),
      status: "error",
      exhibit_ids: [],
      latency_ms: Date.now() - started,
    });
    throw err;
  }
}

/** Create an exhibit whose result is computed in code (no extra SQL call). */
export function emitComputedExhibit(input: {
  rt: ToolRuntime;
  tool: string;
  kind: ExhibitKind;
  title: string;
  args: unknown;
  result: Record<string, unknown>;
  sql?: string;
  source?: string;
}): Exhibit {
  const exhibit = createExhibit({
    kind: input.kind,
    source: input.source ?? "code",
    transport: "code",
    title: input.title,
    tool: input.tool,
    sql: input.sql,
    args: input.args,
    result: input.result,
    case_id: input.rt.caseId,
    agent: input.rt.agent,
  });
  appendExhibit(input.rt.root, exhibit);
  emitTrace(input.rt.root, {
    case_id: input.rt.caseId,
    agent_name: input.rt.agent,
    action: input.tool,
    input_summary: input.title,
    output_summary: summarize(input.tool, input.result),
    status: "success",
    exhibit_ids: [exhibit.id],
    latency_ms: 0,
  });
  return exhibit;
}

function summarize(tool: string, result: unknown): string {
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.row_count === "number") {
      return `${record.row_count} rows` + (record.truncated ? " (truncated)" : "");
    }
    if (typeof record.count === "number") return `${record.count} records`;
    if (Array.isArray(record.rows)) return `${record.rows.length} rows`;
    if (Array.isArray(record.sources)) return `${record.sources.length} sources`;
    if (typeof record.explanation === "string") return record.explanation;
    return `${tool} ok`;
  }
  return `${tool} ok`;
}
