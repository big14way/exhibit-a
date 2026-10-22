import type { BaselineComparison, Exhibit, LineageGraph, Verdict, VerdictKind } from "./models.ts";
import { isUpstream as graphUpstream } from "./world-model.ts";

export type GateFailure = { rule: string; detail: string };

export type GateResult = {
  ok: boolean;
  failures: GateFailure[];
};

export type CauseClaim = {
  cause: string;
  kind: "artifact" | "real";
  blamed: string[];
  exhibit_ids: string[];
  share: number;
  onset_period?: number | string;
  prior_period?: number | string;
};

export type GateContext = {
  exhibits: Exhibit[];
  graph?: LineageGraph;
  band: { lo: number; hi: number };
  symptom?: BaselineComparison["onset"];
  causeCount: number;
};

const QUANT_KINDS: Exhibit["kind"][] = ["profile", "baseline", "sql", "second_channel"];

function citedExhibits(claim: CauseClaim, exhibits: Exhibit[]): Exhibit[] {
  const ids = new Set(claim.exhibit_ids);
  return exhibits.filter((exhibit) => ids.has(exhibit.id));
}

function expandWildcard(name: string, graph: LineageGraph): string[] {
  if (!name.includes("*")) return [name];
  const pattern = new RegExp(`^${name.split("*").map(escapeRegExp).join(".*")}$`);
  return graph.nodes.filter((node) => pattern.test(node));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rule 4.5, enforced in code. A cause is accepted only when it is located in
 * this case's lineage graph, quantified by a citeable exhibit, timed to the
 * symptom, and backed by the right independent evidence for its kind.
 */
export function confirmCause(claim: CauseClaim, ctx: GateContext): GateResult {
  const failures: GateFailure[] = [];
  const cited = citedExhibits(claim, ctx.exhibits);
  if (cited.length === 0) {
    failures.push({ rule: "cited", detail: "at least one existing exhibit is required" });
  }
  if (claim.exhibit_ids.length !== cited.length) {
    const found = new Set(cited.map((exhibit) => exhibit.id));
    const missing = claim.exhibit_ids.filter((id) => !found.has(id));
    failures.push({ rule: "cited", detail: `unknown exhibit ids: ${missing.join(", ")}` });
  }

  if (claim.kind === "artifact") {
    if (!ctx.graph) {
      failures.push({ rule: "located", detail: "no lineage graph was built for this case" });
    } else {
      const located = claim.blamed.some((name) =>
        expandWildcard(name, ctx.graph as LineageGraph).some(
          (node) => node === ctx.graph?.view || graphUpstream(ctx.graph as LineageGraph, node, ctx.graph?.view ?? ""),
        ),
      );
      if (!located) {
        failures.push({
          rule: "located",
          detail: `none of ${claim.blamed.join(", ")} is upstream of ${ctx.graph.view}`,
        });
      }
    }
  }

  const quantified = cited.some((exhibit) => QUANT_KINDS.includes(exhibit.kind));
  if (!quantified) {
    failures.push({
      rule: "quantified",
      detail: "needs a profile, baseline, SQL or second-channel exhibit",
    });
  }

  if (claim.kind === "artifact") {
    if (!cited.some((exhibit) => exhibit.tool === "counterfactual")) {
      failures.push({ rule: "sufficient", detail: "artifact cause needs a counterfactual exhibit" });
    }
    if (!cited.some((exhibit) => exhibit.kind === "second_channel")) {
      failures.push({
        rule: "second-channel",
        detail: "DATA_ARTIFACT/MIXED needs an independent second-channel exhibit",
      });
    }
  } else {
    if (!cited.some((exhibit) => exhibit.tool === "canonical_series")) {
      failures.push({
        rule: "corrected-series",
        detail: "REAL_CHANGE needs a deduplicated series exhibit",
      });
    }
    if (!cited.some((exhibit) => exhibit.kind === "second_channel")) {
      failures.push({
        rule: "second-channel",
        detail: "REAL_CHANGE needs corroboration from an independent source",
      });
    }
  }

  if (ctx.causeCount === 1 && claim.share < 0.8) {
    failures.push({
      rule: "sufficient",
      detail: `sole cause explains ${(claim.share * 100).toFixed(1)}% (< 80%)`,
    });
  }
  if (!Number.isFinite(claim.share) || claim.share < 0 || claim.share > 1.0001) {
    failures.push({ rule: "share", detail: `invalid share ${claim.share}` });
  }

  if (ctx.symptom && claim.onset_period !== undefined) {
    if (String(claim.onset_period) !== String(ctx.symptom.period)) {
      failures.push({
        rule: "timed",
        detail: `cause onset ${claim.onset_period} does not overlap symptom ${ctx.symptom.period}`,
      });
    }
  }

  return { ok: failures.length === 0, failures };
}

export function verdictKindFor(causes: CauseClaim[]): VerdictKind {
  if (causes.length === 0) return "INSUFFICIENT_EVIDENCE";
  const artifact = causes.some((cause) => cause.kind === "artifact" && cause.share > 0);
  const real = causes.some((cause) => cause.kind === "real" && cause.share > 0);
  if (artifact && real) return "MIXED";
  if (artifact) return "DATA_ARTIFACT";
  if (real) return "REAL_CHANGE";
  return "NO_ANOMALY";
}

/**
 * The code gate is final. A failing cause downgrades the verdict to
 * INSUFFICIENT_EVIDENCE; it never silently disappears from the record.
 */
export function buildVerdict(input: {
  causes: CauseClaim[];
  exhibits: Exhibit[];
  graph?: LineageGraph;
  band: { lo: number; hi: number };
  symptom?: BaselineComparison["onset"];
  notes?: string[];
}): { verdict: Verdict; gate: GateResult } {
  const kind = verdictKindFor(input.causes);
  const totalShare = input.causes.reduce((sum, cause) => sum + cause.share, 0);
  const failures: GateFailure[] = [];

  if (input.causes.length > 1 && (totalShare < 0.9 || totalShare > 1.1)) {
    failures.push({
      rule: "shares",
      detail: `cause shares sum to ${(totalShare * 100).toFixed(1)}%, outside 90-110%`,
    });
  }
  for (const cause of input.causes) {
    const result = confirmCause(cause, {
      exhibits: input.exhibits,
      graph: input.graph,
      band: input.band,
      symptom: input.symptom,
      causeCount: input.causes.length,
    });
    failures.push(...result.failures.map((failure) => ({ ...failure, rule: `${cause.cause}:${failure.rule}` })));
  }

  const verdict: Verdict = {
    kind: failures.length === 0 ? kind : "INSUFFICIENT_EVIDENCE",
    causes: input.causes.map((cause) => ({
      cause: cause.cause,
      kind: cause.kind,
      share: cause.share,
      exhibit_ids: cause.exhibit_ids,
    })),
    unexplained_share: Math.max(0, Math.round((1 - totalShare) * 1e6) / 1e6),
    exhibit_ids: [...new Set(input.causes.flatMap((cause) => cause.exhibit_ids))],
    notes: input.notes,
    gate_failures: failures.length > 0 ? failures : undefined,
  };
  return { verdict, gate: { ok: failures.length === 0, failures } };
}

export function summarizeVerdict(verdict: Verdict): string {
  const shares = verdict.causes
    .map((c) => `${c.cause}=${(c.share * 100).toFixed(1)}%`)
    .join(", ");
  return `${verdict.kind}${shares ? ` (${shares})` : ""}`;
}
