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
  | "discovery"
  | "critic"
  | "safety"
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
  tool?: string;
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
  cause: string;
  blamed: string[];
  status: "open" | "confirmed" | "eliminated";
  exhibit_ids: string[];
  note?: string;
  share?: number;
  /** Filers the evidence selected for this hypothesis, by CIK. */
  subjects?: { cik: string; entity_name: string; role: string }[];
};

export type LineageSource = {
  source_table: string;
  source_kind: string;
};

export type LineageColumn = {
  target_column: string;
  source_table: string;
  source_column: string;
};

export type LineageEdge = {
  from: string;
  to: string;
  kind: "source" | "column";
  column?: string;
};

export type LineageGraph = {
  case_id: string;
  view: string;
  built_at: string;
  nodes: string[];
  edges: LineageEdge[];
  sources: LineageSource[];
  columns: LineageColumn[];
};

export type BaselinePoint = {
  segment: string;
  period: number | string;
  value: number;
};

export type BaselineComparison = {
  metric: string;
  grain: string;
  band: { lo: number; hi: number };
  onset?: {
    segment: string;
    period: number | string;
    prior_period: number | string;
    value: number;
    prior_value: number;
    ratio: number;
    delta: number;
  };
  segments: number;
  periods: number;
  explanation: string;
};

export type CauseShare = {
  cause: string;
  kind: "artifact" | "real";
  share: number;
  exhibit_ids: string[];
};

export type Verdict = {
  kind: VerdictKind;
  causes: CauseShare[];
  unexplained_share?: number;
  exhibit_ids: string[];
  notes?: string[];
  gate_failures?: { rule: string; detail: string }[];
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

export type WriteContract = {
  id: string;
  case_id: string;
  intent: string;
  scope: string[];
  statements: string[];
  statements_sha256: string;
  cost_ceiling: number;
  expires_at: string;
  signer: string;
  signature: string;
  approved: boolean;
  approved_by?: string;
  approved_at?: string;
};

export type RepairPlan = {
  metric: string;
  shadow_metric: string;
  corrected_metric: string;
  corrected_sql: string;
  statements: string[];
  created_at: string;
};

export type VerifierInvariant = {
  name: string;
  ok: boolean;
  detail: string;
  numbers?: Record<string, number | string>;
};

export type VerificationResult = {
  ok: boolean;
  shadow_metric: string;
  corrected_metric: string;
  invariants: VerifierInvariant[];
  corrected_prior?: number;
  corrected_now?: number;
  corrected_delta?: number;
  corrected_ratio?: number;
};

export type WritebackResult = {
  ok: boolean;
  contract_id: string;
  written_metric: string;
  checks: VerifierInvariant[];
  readback_sha256?: string;
  usl_model?: string;
  memory_note?: string;
};

export type MemoryHit = {
  case_id: string;
  metric: string;
  question: string;
  verdict_kind: string;
  causes: string[];
  closed_at: string;
  score: number;
  match: string[];
  excerpt: string;
  /** Cosine similarity from the Nemotron embedding role, when it ran. */
  similarity?: number;
};

export type ModelRoleStatus = "ran" | "skipped" | "error";

export type EmbeddingSummary = {
  status: ModelRoleStatus;
  model: string | null;
  dims: number;
  texts: number;
  detail: string;
  usage: { prompt_tokens: number };
};

export type MemoryRecall = {
  storage: string;
  cold_start: boolean;
  query: { metric: string; question: string };
  records: number;
  hits: MemoryHit[];
  audit: { valid: number; malformed: number; duplicates: number };
  scoring: "lexical" | "lexical+embedding";
  embedding?: EmbeddingSummary;
};

export type MemoryRecord = {
  version: 1;
  case_id: string;
  metric: string;
  question: string;
  verdict_kind: string;
  causes: string[];
  stage: string;
  closed_at: string;
  exhibits: number;
  exhibit_ids: string[];
  sample_mode: boolean;
  note: string;
};

export type SafetyFinding = {
  rule: string;
  match: string;
  detail: string;
};

export type SafetyModelResult = {
  status: ModelRoleStatus;
  model: string | null;
  user_safety: string | null;
  response_safety: string | null;
  categories: string[];
  detail: string;
  raw: string;
  usage: { prompt_tokens: number; completion_tokens: number };
};

export type SafetyResult = {
  ok: boolean;
  policy: string;
  findings: SafetyFinding[];
  checked_chars: number;
  action: "allow" | "block";
  /** Second layer: the Nemotron content-safety model, when configured. */
  model?: SafetyModelResult;
};

export type ContextWindowSummary = {
  mode: string;
  max_chars: number;
  total_chars: number;
  item_count: number;
  chunk_count: number;
  dropped: number;
  chunks: {
    key: string;
    item_ids: string[];
    chars: number;
    previous: string | null;
    next: string | null;
  }[];
};

export type CriticObjection = {
  claim: string;
  severity: "low" | "medium" | "high";
  exhibit_sha256?: string;
  resolved?: boolean;
  resolution?: string;
};

export type CriticResult = {
  status: "ran" | "skipped" | "error";
  model: string | null;
  detail: string;
  content: string;
  objections: CriticObjection[];
  cited_unknown: string[];
  unresolved: number;
  unsafe: boolean;
  safety_findings: SafetyFinding[];
  context_chunks: number;
  context_chars: number;
  /** The exact Markovian windows that were sent to the model. */
  context?: ContextWindowSummary;
  usage: { prompt_tokens: number; completion_tokens: number };
  spend: { calls: number; input_tokens: number; output_tokens: number; spent_usd: number };
};

export type DiscoveryCandidate = {
  concept: string;
  annual_facts: number;
  first_period: string | null;
  last_period: string | null;
  continuous: boolean;
  latest_forms: string[];
  score: number;
};

export type DiscoveryResult = {
  company: string;
  cik: string;
  current_concept: string;
  current_annual_facts: number;
  replacement_concept: string | null;
  replacement_relation?: "replacement" | "prior_history" | null;
  replacement_reason: string;
  candidates: DiscoveryCandidate[];
  peers: { ticker: string; table: string; sic_division: string }[];
  source_url: string;
  rule: string;
};

export type HmemSummary = {
  record_id: string;
  records: number;
  valid: number;
  malformed: number;
  duplicates: number;
  storage: string;
  recalled: number;
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
  memory?: MemoryRecall;
  discovery?: DiscoveryResult;
  critic?: CriticResult;
  safety?: SafetyResult;
  hmem?: HmemSummary;
  baseline?: BaselineComparison;
  verdict?: Verdict;
  repair?: RepairPlan;
  contract?: WriteContract;
  verification?: VerificationResult;
  write_contract?: WriteContract;
  writeback_note?: string;
  writeback?: WritebackResult;
  error?: string;
};

export const DEFAULT_ANOMALY_BAND = { lo: 0.67, hi: 1.5 } as const;
