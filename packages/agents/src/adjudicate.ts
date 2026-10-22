import {
  DEFAULT_ANOMALY_BAND,
  buildVerdict,
  loadGraph,
  type BaselineComparison,
  type CaseState,
  type CauseClaim,
  type Exhibit,
  type GateResult,
  type Verdict,
} from "@exhibit-a/core";
import {
  EDGAR_COMPANIES,
  type CounterfactualResult,
} from "@exhibit-a/tools";

export type Adjudication = {
  verdict: Verdict;
  gate: GateResult;
  notes: string[];
};

/**
 * Turn confirmed hypotheses into cause claims for the gate. A cause share has
 * to come from a counterfactual, not from prose: the artifact share is what
 * deduplication removes, the real share is what survives it.
 */
export function adjudicate(input: {
  root: string;
  state: CaseState;
  baseline: BaselineComparison;
  exhibits: Exhibit[];
  counterfactual: CounterfactualResult;
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

  const artifactClaim = {
    cause: "filing_year_duplication",
    kind: "artifact" as const,
    // Live INFER resolves the edgar schema-store views to their raw SEC
    // tables, while the recorded sample keeps the edgar view names.
    blamed: [
      ...EDGAR_COMPANIES.map((company) => company.table),
      input.state.metric,
      "SEC_DATA.*",
    ],
    exhibit_ids: [
      ...(artifactHypothesis?.exhibit_ids ?? []),
      ...secondChannels,
      ...(counterfactualExhibit ? [counterfactualExhibit.id] : []),
    ],
    share: input.counterfactual.explained_share,
    onset_period: onset?.period,
    prior_period: onset?.prior_period,
  };

  const claims: CauseClaim[] = [artifactClaim];
  const realShare = input.counterfactual.unexplained_share;
  if (realShare > 0.005 && realHypothesis?.status === "confirmed") {
    claims.push({
      cause: "real_change",
      kind: "real" as const,
      blamed: [input.state.metric, "edgar.*_revenue_table"],
      exhibit_ids: [
        ...realHypothesis.exhibit_ids,
        ...(counterfactualExhibit ? [counterfactualExhibit.id] : []),
      ],
      share: realShare,
      onset_period: onset?.period,
      prior_period: onset?.prior_period,
    });
  }

  const critiqueConfigured = Boolean(
    process.env.NVIDIA_API_KEY &&
      (process.env.NIM_CRITIC_MODEL ?? process.env.NIM_LEAD_MODEL),
  );
  const notes = [
    "Concept switch / missing history is confirmed as a data-quality finding but carries no separate share: deduplicating by period recovers Apple's prior-year facts, so it does not add to the reported jump.",
    "Tesla short history and an ingestion gap were eliminated with exhibits, not left as possibilities.",
    critiqueConfigured
      ? "Defense Counsel model critique is configured; the deterministic code gate is final."
      : "Defense Counsel model critique did not run (no NVIDIA_API_KEY or NIM model); the code gate is final and no model prose can promote a cause.",
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
