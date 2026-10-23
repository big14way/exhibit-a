import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaseState, Verdict } from "@exhibit-a/core";
import type { MemoryRecall } from "@exhibit-a/core";

export type ClaimCheck = {
  id: string;
  claim: string;
  ok: boolean;
  evidence: string;
};

export type ClaimInput = {
  cold: CaseState;
  warm: CaseState;
  closed: CaseState;
  memory: MemoryRecall;
  ablation: Verdict;
};

function check(id: string, claim: string, ok: boolean, evidence: string): ClaimCheck {
  return { id, claim, ok, evidence };
}

export function checkClaims(input: ClaimInput): ClaimCheck[] {
  const cold = input.cold;
  const warm = input.warm;
  const closed = input.closed;
  const verdict = closed.verdict;
  const artifact = verdict?.causes.find((cause) => cause.cause === "filing_year_duplication");
  const real = verdict?.causes.find((cause) => cause.cause === "real_change");
  const checks = closed.writeback?.checks ?? [];
  const statements = closed.write_contract?.statements ?? [];
  const reportedWrite = statements.find((statement) =>
    statement.includes("analytics.sector_revenue_by_year"),
  );

  return [
    check(
      "sample_labelled",
      "SAMPLE_MODE is labelled replay, not live inference",
      cold.sample_mode === true &&
        cold.exhibits.every((exhibit) => exhibit.transport !== "zetaris") &&
        (closed.writeback?.checks ?? []).some(
          (row) => row.name === "original_untouched" && row.ok,
        ),
      `${cold.exhibits.length} exhibits; transport values ${[
        ...new Set(cold.exhibits.map((exhibit) => exhibit.transport)),
      ].join(", ")}`,
    ),
    check(
      "verdict_mixed",
      "The FY2018 sample verdict is MIXED with two causes",
      verdict?.kind === "MIXED" && verdict.causes.length === 2,
      `${verdict?.kind ?? "missing"}; ${verdict?.causes.length ?? 0} causes`,
    ),
    check(
      "artifact_share",
      "Artifact share is 96.168% and real share is 3.832%",
      Math.abs((artifact?.share ?? 0) - 0.96168) < 0.0001 &&
        Math.abs((real?.share ?? 0) - 0.03832) < 0.0001 &&
        (verdict?.unexplained_share ?? -1) === 0,
      `artifact ${((artifact?.share ?? 0) * 100).toFixed(3)}%, real ${(
        (real?.share ?? 0) * 100
      ).toFixed(3)}%, unexplained ${((verdict?.unexplained_share ?? 0) * 100).toFixed(3)}%`,
    ),
    check(
      "gate_pass",
      "The deterministic gate passes without failures",
      (verdict?.gate_failures ?? []).length === 0,
      `${verdict?.gate_failures?.length ?? 0} failures`,
    ),
    check(
      "shadow_verified",
      "Shadow repair passes 7/7 invariants and 12/12 second-channel cells",
      closed.verification?.ok === true &&
        closed.verification.invariants.length === 7 &&
        closed.verification.invariants.every((row) => row.ok) &&
        closed.verification.invariants.find((row) => row.name === "second_channel_parity")
          ?.numbers?.checked === 12,
      `${closed.verification?.invariants.filter((row) => row.ok).length ?? 0}/7; ` +
        `parity ${closed.verification?.invariants.find((row) => row.name === "second_channel_parity")?.numbers?.checked ?? 0}/12`,
    ),
    check(
      "sample_close",
      "The sample writeback reaches CLOSED with 8/8 readback checks",
      closed.stage === "CLOSED" &&
        closed.writeback?.ok === true &&
        checks.length === 8 &&
        checks.every((row) => row.ok),
      `${closed.stage}; ${checks.filter((row) => row.ok).length}/${checks.length} checks`,
    ),
    check(
      "reported_view_untouched",
      "No write statement names the reported analytics view",
      reportedWrite === undefined &&
        closed.writeback?.checks.some(
          (row) => row.name === "original_untouched" && row.ok,
        ) === true,
      reportedWrite ? `write named ${reportedWrite.slice(0, 120)}` : "no statement names the reported view",
    ),
    check(
      "hmem_cold_warm",
      "H-MEM starts cold and recalls the closed case on the warm run",
      input.memory.cold_start === true &&
        (warm.memory?.hits.length ?? 0) >= 1 &&
        (warm.memory?.hits[0]?.case_id ?? "") === cold.id,
      `cold ${input.memory.hits.length} hit(s); warm ${warm.memory?.hits.length ?? 0} hit(s); recalled ${warm.memory?.hits[0]?.case_id ?? "none"}`,
    ),
    check(
      "hmem_persisted",
      "The closed case is written to the H-MEM index and audits cleanly",
      closed.hmem?.record_id === cold.id &&
        (closed.hmem?.valid ?? 0) >= 1 &&
        (closed.hmem?.malformed ?? 1) === 0,
      `record ${closed.hmem?.record_id ?? "none"}; ${closed.hmem?.valid ?? 0} valid, ${closed.hmem?.malformed ?? 0} malformed`,
    ),
    check(
      "discovery",
      "Scout discovers the replacement Apple revenue concept from SEC companyfacts",
      cold.discovery?.replacement_concept ===
        "RevenueFromContractWithCustomerExcludingAssessedTax" &&
        (cold.discovery?.candidates.length ?? 0) > 0,
      `${cold.discovery?.current_concept ?? "none"} -> ${cold.discovery?.replacement_concept ?? "none"}; ${cold.discovery?.candidates.length ?? 0} candidates`,
    ),
    check(
      "nim_critic",
      "The recorded Nemotron critic runs in replay with five grounded objections",
      cold.critic?.status === "ran" &&
        cold.critic.objections.length === 5 &&
        cold.critic.cited_unknown.length === 0 &&
        cold.critic.usage.prompt_tokens > 0,
      `${cold.critic?.status ?? "missing"}; ${cold.critic?.objections.length ?? 0} objections; ${cold.critic?.usage.prompt_tokens ?? 0} prompt tokens`,
    ),
    check(
      "content_safety",
      "The content-safety guard passes generated finding prose",
      cold.safety?.ok === true && warm.safety?.ok === true,
      `cold ${cold.safety?.ok ?? false}; warm ${warm.safety?.ok ?? false}`,
    ),
    check(
      "ablation",
      "Removing the counterfactual/second channel downgrades the verdict",
      input.ablation.kind === "INSUFFICIENT_EVIDENCE" &&
        (input.ablation.gate_failures?.length ?? 0) > 0,
      `${input.ablation.kind}; ${input.ablation.gate_failures?.length ?? 0} gate failures`,
    ),
    check(
      "exhibit_counts",
      "The sample investigation and close have the expected exhibit counts",
      cold.exhibits.length === 23 && closed.exhibits.length === 33,
      `${cold.exhibits.length} investigate; ${closed.exhibits.length} close`,
    ),
  ];
}

export function claimsMarkdown(checks: ClaimCheck[]): string {
  const lines = [
    "# Exhibit A claim checks",
    "",
    `Generated from the committed SAMPLE_MODE cassette. ${checks.filter((row) => row.ok).length}/${checks.length} claims pass.`,
    "",
    "| claim | result | evidence |",
    "| --- | --- | --- |",
  ];
  for (const row of checks) {
    lines.push(`| ${row.claim} | ${row.ok ? "PASS" : "FAIL"} | ${row.evidence} |`);
  }
  return `${lines.join("\n")}\n`;
}

const HERE = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(HERE, "results/latest.json");
  if (!existsSync(path)) {
    console.error(`no eval result at ${path}; run npm run eval first`);
    process.exit(1);
  }
  const result = JSON.parse(readFileSync(path, "utf8")) as { claims: ClaimCheck[] };
  console.log(claimsMarkdown(result.claims));
  process.exit(result.claims.every((row) => row.ok) ? 0 : 1);
}
