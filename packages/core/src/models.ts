export const STAGE_ORDER = [
  "REPORTED",
  "SCOPING",
  "LINEAGE",
  "BASELINED",
  "HYPOTHESES",
  "EVIDENCE",
  "CRITIQUED",
  "ADJUDICATED",
  "BRIEFED",
  "REPAIR_PROPOSED",
  "SHADOW_VERIFIED",
  "AWAITING_APPROVAL",
  "WRITTEN",
  "WRITE_VERIFIED",
  "MEMORISED",
  "CLOSED",
  "FAILED",
] as const;

export type Stage = (typeof STAGE_ORDER)[number];

export type VerdictKind =
  | "DATA_ARTIFACT"
  | "REAL_CHANGE"
  | "MIXED"
  | "NO_ANOMALY"
  | "INSUFFICIENT_EVIDENCE";

export type ExhibitKind =
  | "metadata"
  | "lineage"
  | "baseline"
  | "profile"
  | "sql"
  | "second_channel"
  | "memory"
  | "test"
  | "writeback";

export type SqlResult = {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
};

export type Exhibit = {
  id: string;
  ts: string;
  kind: ExhibitKind;
  source: string;
  transport: string;
  title: string;
  sql?: string;
  sql_sha256?: string;
  args?: unknown;
  result: SqlResult | Record<string, unknown>;
  result_sha256: string;
  rerun: string;
  case_id: string;
  agent: string;
};

export type Hypothesis = {
  id: string;
  statement: string;
  status: "open" | "confirmed" | "eliminated";
  exhibit_ids: string[];
};

export type CauseShare = {
  cause: string;
  share: number;
  exhibit_ids: string[];
};

export type Verdict = {
  kind: VerdictKind;
  causes: CauseShare[];
  unexplained_share?: number;
  exhibit_ids: string[];
};

export type TraceLine = {
  timestamp: string;
  case_id: string;
  agent_name: string;
  action: string;
  input_summary: string;
  output_summary: string;
  target_agent?: string;
  confidence?: number;
  retry_count: number;
  status: "success" | "error";
  exhibit_ids: string[];
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  chunk?: number;
};

export type CaseState = {
  id: string;
  reported_at: string;
  question: string;
  metric: string;
  stage: Stage;
  sample_mode: boolean;
  cassette_id?: string;
  cassette_recorded_at?: string;
  exhibits: Exhibit[];
  hypotheses: Hypothesis[];
  verdict?: Verdict;
  error?: string;
};

export const DEFAULT_ANOMALY_BAND = { lo: 0.67, hi: 1.5 } as const;
