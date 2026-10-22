import { DEFAULT_ANOMALY_BAND, type Exhibit, type Verdict, type VerdictKind } from "./models.ts";

export type GateFailure = { rule: string; detail: string };

export type GateResult = {
  ok: boolean;
  failures: GateFailure[];
};

function hasKind(exhibits: Exhibit[], kinds: Exhibit["kind"][]): boolean {
  return exhibits.some((ex) => kinds.includes(ex.kind));
}

/**
 * Day-1 stub. Full rules (located / quantified / sufficient / timed /
 * second-channel) land on Day 3. Callers must not treat a passing stub as
 * adjudication.
 */
export function confirmCause(input: {
  verdict: VerdictKind;
  blamed: string;
  exhibits: Exhibit[];
  explainedShare?: number;
}): GateResult {
  const failures: GateFailure[] = [];
  if (input.exhibits.length === 0) {
    failures.push({ rule: "cited", detail: "at least one exhibit is required" });
  }
  if (input.verdict === "DATA_ARTIFACT" && !hasKind(input.exhibits, ["second_channel", "sql", "profile", "baseline"])) {
    failures.push({
      rule: "artifact-evidence",
      detail: "DATA_ARTIFACT needs quantitative or second-channel exhibits",
    });
  }
  if (
    input.explainedShare !== undefined &&
    input.explainedShare < 0.8 &&
    input.verdict !== "MIXED" &&
    input.verdict !== "INSUFFICIENT_EVIDENCE"
  ) {
    failures.push({
      rule: "sufficient",
      detail: `explained share ${input.explainedShare} < 0.8 for a sole cause`,
    });
  }
  void DEFAULT_ANOMALY_BAND;
  void input.blamed;
  return { ok: failures.length === 0, failures };
}

export function summarizeVerdict(verdict: Verdict): string {
  const shares = verdict.causes
    .map((c) => `${c.cause}=${(c.share * 100).toFixed(1)}%`)
    .join(", ");
  return `${verdict.kind}${shares ? ` (${shares})` : ""}`;
}
