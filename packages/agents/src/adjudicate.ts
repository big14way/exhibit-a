import {
  DEFAULT_ANOMALY_BAND,
  buildVerdict,
  loadGraph,
  type BaselineComparison,
  type CaseState,
  type CauseClaim,
  type Exhibit,
  type GateResult,
  type CriticResult,
  type Verdict,
} from "@exhibit-a/core";
import { type CounterfactualResult } from "@exhibit-a/tools";

export type Adjudication = {
  verdict: Verdict;
  gate: GateResult;
  notes: string[];
};

/**
 * Turn confirmed hypotheses into cause claims for the gate. A cause share has
 * to come from a counterfactual, not from prose: the artifact share is what
 * deduplication removes, the real share is what survives it. The blamed
 * objects come from the case's own lineage graph, so the "located" rule is
 * checked against what INFER SQLTABLE actually returned.
 */
export function adjudicate(input: {
  root: string;
  state: CaseState;
  baseline: BaselineComparison;
  exhibits: Exhibit[];
  counterfactual: CounterfactualResult;
  critic?: CriticResult;
}): Adjudication {
  const onset = input.baseline.onset;
  const graph = loadGraph(input.root, input.state.id);
  const counterfactualExhibit = input.exhibits.find(
    (exhibit) => exhibit.tool === "counterfactual",
  );
  const secondChannels = input.exhibits
    .filter((exhibit) => exhibit.kind === "second_channel")
    .map((exhibit) => exhibit.id);
  const byCause = new Map(input.state.hypotheses.map((row) => [row.cause, row]));
  const artifactHypothesis = byCause.get("filing_year_duplication");
  const realHypothesis = byCause.get("real_change");
  const upstream = (graph?.sources ?? []).map((source) => source.source_table);

  const claims: CauseClaim[] = [];
  if (artifactHypothesis?.status === "confirmed") {
    claims.push({
      cause: "filing_year_duplication",
      kind: "artifact",
      blamed: [...upstream, ...artifactHypothesis.blamed, input.state.metric],
      exhibit_ids: [
        ...artifactHypothesis.exhibit_ids,
        ...secondChannels,
        ...(counterfactualExhibit ? [counterfactualExhibit.id] : []),
      ],
      share: input.counterfactual.explained_share,
      onset_period: onset?.period,
      prior_period: onset?.prior_period,
    });
  }
  const realShare = input.counterfactual.unexplained_share;
  if (realShare > 0.005 && realHypothesis?.status === "confirmed") {
    claims.push({
      cause: "real_change",
      kind: "real",
      blamed: [input.state.metric, ...realHypothesis.blamed],
      exhibit_ids: [
        ...realHypothesis.exhibit_ids,
        ...(counterfactualExhibit ? [counterfactualExhibit.id] : []),
      ],
      share: realShare,
      onset_period: onset?.period,
      prior_period: onset?.prior_period,
    });
  }

  const critic = input.critic;
  const criticNote =
    critic?.status === "ran"
      ? `Defense Counsel raised ${critic.objections.length} objection(s)` +
        (critic.cited_unknown.length
          ? `, ${critic.cited_unknown.length} citing an unknown exhibit`
          : "") +
        "; the deterministic code gate is final."
      : critic?.status === "error"
        ? `Defense Counsel critique failed safely (${critic.detail}); the deterministic code gate is final.`
        : "Defense Counsel model critique was skipped (no NVIDIA_API_KEY/NIM model or no recorded response); the code gate is final and no model prose can promote a cause.";

  // Notes are built from the hypothesis table, never typed in by hand, so a
  // different metric produces different notes.
  const claimed = new Set(claims.map((claim) => claim.cause));
  const confirmedWithoutShare = input.state.hypotheses.filter(
    (row) => row.status === "confirmed" && !claimed.has(row.cause),
  );
  const eliminated = input.state.hypotheses.filter((row) => row.status === "eliminated");
  const open = input.state.hypotheses.filter((row) => row.status === "open");
  const notes = [
    ...confirmedWithoutShare.map((row) => {
      const who = row.subjects?.map((item) => item.entity_name).join(" and ");
      return (
        `${row.cause} is confirmed as a data-quality finding but carries no separate share: ` +
        `deduplicating to one annual fact per (cik, period_end) recovers ${who ? `${who}'s` : "the affected filer's"} prior-year facts, so it does not add to the reported jump.`
      );
    }),
    ...(eliminated.length
      ? [
          `Eliminated with exhibits, not left as possibilities: ${eliminated
            .map((row) => row.cause)
            .join(", ")}.`,
        ]
      : []),
    ...(open.length
      ? [`Still open after the evidence pass: ${open.map((row) => row.cause).join(", ")}.`]
      : []),
    criticNote,
    input.state.sample_mode
      ? "SAMPLE_MODE: tool results replayed from the labelled cassette; no live inference."
      : "Live mode.",
  ];

  const { verdict, gate } = buildVerdict({
    causes: claims,
    exhibits: input.exhibits,
    graph,
    band: DEFAULT_ANOMALY_BAND,
    symptom: onset,
    notes,
  });
  return { verdict, gate, notes };
}
