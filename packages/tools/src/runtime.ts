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
