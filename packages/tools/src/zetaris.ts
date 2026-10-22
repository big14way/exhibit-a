import { randomUUID } from "node:crypto";
import { assertReadOnly, guardSql, type GuardMode } from "./sqlguard.ts";

export type ZetarisConfig = {
  restUrl: string;
  apiKey: string;
  orgId?: string;
  userAgent?: string;
};

export type ZetarisRunResult = {
  columns: string[];
  rows: unknown[][];
  raw: unknown;
};

export class ZetarisClient {
  constructor(private readonly cfg: ZetarisConfig) {}

  async health(): Promise<unknown> {
    const res = await fetch(`${this.cfg.restUrl.replace(/\/$/, "")}/datasource/datasources`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`zetaris health ${res.status}`);
    }
    return res.json();
  }

  async runSql(sql: string, opts: { limit?: number; mode?: GuardMode } = {}): Promise<ZetarisRunResult> {
    const mode = opts.mode ?? "investigate";
    const guarded = guardSql(sql, mode);
    const url = `${this.cfg.restUrl.replace(/\/$/, "")}/sql-editor/sqls/run`;
    const body = {
      queryId: randomUUID(),
      sql: guarded,
      source: "SqlEditor",
      limit: opts.limit ?? 500,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...this.headers(),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`zetaris sql run ${res.status}: ${text.slice(0, 400)}`);
    }
    const raw = (await res.json()) as Record<string, unknown>;
    return normalizeRun(raw);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      "X-Request-ID": randomUUID(),
    };
    if (this.cfg.orgId) headers["X-Org-ID"] = this.cfg.orgId;
    if (this.cfg.userAgent) headers["user-agent"] = this.cfg.userAgent;
    return headers;
  }
}

export function fromEnv(): ZetarisConfig | null {
  const restUrl = process.env.ZETARIS_REST_URL;
  const apiKey = process.env.ZETARIS_API_KEY;
  if (!restUrl || !apiKey) return null;
  return {
    restUrl,
    apiKey,
    orgId: process.env.ZETARIS_ORG_ID,
    userAgent: process.env.ZETARIS_USER_AGENT,
  };
}

function normalizeRun(raw: Record<string, unknown>): ZetarisRunResult {
  const columns = extractColumns(raw);
  const rows = extractRows(raw, columns.length);
  return { columns, rows, raw };
}

function extractColumns(raw: Record<string, unknown>): string[] {
  const schema = raw.schema ?? raw.columns ?? raw.columnNames;
  if (Array.isArray(schema)) {
    return schema.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "name" in item) {
        return String((item as { name: unknown }).name);
      }
      return String(item);
    });
  }
  return [];
}

function extractRows(raw: Record<string, unknown>, width: number): unknown[][] {
  const data = raw.data ?? raw.rows ?? raw.result ?? raw.records;
  if (!Array.isArray(data)) return [];
  return data.map((row) => {
    if (Array.isArray(row)) return row;
    if (row && typeof row === "object") return Object.values(row as Record<string, unknown>);
    return width ? Array.from({ length: width }, () => row) : [row];
  });
}

export { assertReadOnly };
