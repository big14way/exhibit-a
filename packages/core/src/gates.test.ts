import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildVerdict,
  createExhibit,
  emptyGraph,
  mergeGraph,
  summarizeVerdict,
  type CauseClaim,
  type Exhibit,
} from "@exhibit-a/core";

const GRAPH = mergeGraph(emptyGraph("case_gate", "analytics.sector_revenue_by_year"), {
  view: "analytics.sector_revenue_by_year",
  sources: [
    { source_table: "edgar.apple_revenue_table", source_kind: "table" },
    { source_table: "sic_edgar_usl", source_kind: "table" },
  ],
});

function exhibit(input: {
  kind: Exhibit["kind"];
  tool: string;
  title: string;
}): Exhibit {
  return createExhibit({
    kind: input.kind,
    source: "test",
    transport: "code",
    title: input.title,
    tool: input.tool,
    result: { ok: true },
    case_id: "case_gate",
    agent: "test",
  });
}

const counterfactual = exhibit({ kind: "profile", tool: "counterfactual", title: "cf" });
const canonical = exhibit({ kind: "baseline", tool: "canonical_series", title: "corrected" });
const secondChannel = exhibit({ kind: "second_channel", tool: "second_channel", title: "sec" });
const history = exhibit({ kind: "baseline", tool: "metric_history", title: "history" });

function claim(overrides: Partial<CauseClaim> = {}): CauseClaim {
  return {
    cause: "filing_year_duplication",
    kind: "artifact",
    blamed: ["edgar.apple_revenue_table", "analytics.sector_revenue_by_year"],
    exhibit_ids: [counterfactual.id, secondChannel.id, history.id],
    share: 0.96,
    onset_period: 2018,
    prior_period: 2017,
    ...overrides,
  };
}

function symptom() {
  return {
    segment: "Manufacturing",
    period: 2018,
    prior_period: 2017,
    value: 2750941773000,
    prior_value: 1455942689000,
    ratio: 1.8895,
    delta: 1294999084000,
  };
}

test("a mixed verdict passes when both causes carry the right evidence", () => {
  const real: CauseClaim = {
    cause: "real_change",
    kind: "real",
    blamed: ["analytics.sector_revenue_by_year"],
    exhibit_ids: [canonical.id, secondChannel.id, counterfactual.id],
    share: 0.04,
    onset_period: 2018,
    prior_period: 2017,
  };
  const { verdict, gate } = buildVerdict({
    causes: [claim(), real],
    exhibits: [counterfactual, canonical, secondChannel, history],
    graph: GRAPH,
    band: { lo: 0.67, hi: 1.5 },
    symptom: symptom(),
  });
  assert.equal(gate.ok, true);
  assert.equal(verdict.kind, "MIXED");
  assert.equal(verdict.gate_failures, undefined);
  assert.equal(summarizeVerdict(verdict), "MIXED (filing_year_duplication=96.0%, real_change=4.0%)");
});

test("an artifact without a second channel is downgraded, never accepted", () => {
  const { verdict, gate } = buildVerdict({
    causes: [claim({ exhibit_ids: [counterfactual.id, history.id] })],
    exhibits: [counterfactual, history],
    graph: GRAPH,
    band: { lo: 0.67, hi: 1.5 },
    symptom: symptom(),
  });
  assert.equal(gate.ok, false);
  assert.equal(verdict.kind, "INSUFFICIENT_EVIDENCE");
  assert.ok(gate.failures.some((failure) => failure.rule.endsWith("second-channel")));
});

test("an artifact with no lineage graph is downgraded", () => {
  const { gate } = buildVerdict({
    causes: [claim()],
    exhibits: [counterfactual, secondChannel, history],
    band: { lo: 0.67, hi: 1.5 },
    symptom: symptom(),
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.failures.some((failure) => failure.rule.endsWith("located")));
});

test("an artifact that blames only the symptom view fails the located rule", () => {
  const { gate } = buildVerdict({
    causes: [claim({ blamed: ["analytics.sector_revenue_by_year"] })],
    exhibits: [counterfactual, secondChannel, history],
    graph: GRAPH,
    band: { lo: 0.67, hi: 1.5 },
    symptom: symptom(),
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.failures.some((failure) => failure.rule.endsWith("located")));
});

test("an artifact blamed on an unrelated table fails the located rule", () => {
  const { gate } = buildVerdict({
    causes: [claim({ blamed: ["edgar.unknown_table"] })],
    exhibits: [counterfactual, secondChannel, history],
    graph: GRAPH,
    band: { lo: 0.67, hi: 1.5 },
    symptom: symptom(),
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.failures.some((failure) => failure.rule.endsWith("located")));
});

test("a sole cause below 80% is insufficient", () => {
  const { verdict, gate } = buildVerdict({
    causes: [claim({ share: 0.5 })],
    exhibits: [counterfactual, secondChannel, history],
    graph: GRAPH,
    band: { lo: 0.67, hi: 1.5 },
    symptom: symptom(),
  });
  assert.equal(gate.ok, false);
  assert.equal(verdict.kind, "INSUFFICIENT_EVIDENCE");
});

test("multi-cause shares outside 90-110% are flagged", () => {
  const real: CauseClaim = {
    cause: "real_change",
    kind: "real",
    blamed: ["analytics.sector_revenue_by_year"],
    exhibit_ids: [canonical.id, secondChannel.id],
    share: 0.2,
    onset_period: 2018,
    prior_period: 2017,
  };
  const { verdict, gate } = buildVerdict({
    causes: [claim({ share: 0.5 }), real],
    exhibits: [counterfactual, canonical, secondChannel, history],
    graph: GRAPH,
    band: { lo: 0.67, hi: 1.5 },
    symptom: symptom(),
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.failures.some((failure) => failure.rule === "shares"));
  assert.equal(verdict.kind, "INSUFFICIENT_EVIDENCE");
});

test("a real change without the corrected series is downgraded", () => {
  const { gate } = buildVerdict({
    causes: [
      {
        cause: "real_change",
        kind: "real",
        blamed: ["analytics.sector_revenue_by_year"],
        exhibit_ids: [secondChannel.id, history.id],
        share: 1,
      },
    ],
    exhibits: [secondChannel, history],
    graph: GRAPH,
    band: { lo: 0.67, hi: 1.5 },
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.failures.some((failure) => failure.rule.endsWith("corrected-series")));
});

test("a cause timed to a different period is downgraded", () => {
  const { gate } = buildVerdict({
    causes: [claim({ onset_period: 2017 })],
    exhibits: [counterfactual, secondChannel, history],
    graph: GRAPH,
    band: { lo: 0.67, hi: 1.5 },
    symptom: symptom(),
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.failures.some((failure) => failure.rule.endsWith("timed")));
});
