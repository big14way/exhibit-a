import { STAGE_ORDER, type CaseState, type Stage } from "./models.ts";

const FORWARD: Record<string, Stage[]> = {
  REPORTED: ["SCOPING", "FAILED"],
  SCOPING: ["LINEAGE", "FAILED"],
  LINEAGE: ["BASELINED", "FAILED"],
  BASELINED: ["HYPOTHESES", "FAILED"],
  HYPOTHESES: ["EVIDENCE", "FAILED"],
  EVIDENCE: ["CRITIQUED", "FAILED"],
  CRITIQUED: ["ADJUDICATED", "FAILED"],
  ADJUDICATED: ["BRIEFED", "REPAIR_PROPOSED", "FAILED"],
  BRIEFED: ["CLOSED", "FAILED"],
  REPAIR_PROPOSED: ["SHADOW_VERIFIED", "FAILED"],
  SHADOW_VERIFIED: ["AWAITING_APPROVAL", "FAILED"],
  AWAITING_APPROVAL: ["WRITTEN", "FAILED"],
  WRITTEN: ["WRITE_VERIFIED", "FAILED"],
  WRITE_VERIFIED: ["MEMORISED", "FAILED"],
  MEMORISED: ["CLOSED", "FAILED"],
  CLOSED: [],
  FAILED: [],
};

export function canAdvance(from: Stage, to: Stage): boolean {
  if (from === to) return true;
  return (FORWARD[from] ?? []).includes(to);
}

export function advance(state: CaseState, to: Stage): CaseState {
  if (!canAdvance(state.stage, to)) {
    throw new Error(`illegal stage move ${state.stage} → ${to}`);
  }
  return { ...state, stage: to };
}

export function stageIndex(stage: Stage): number {
  return STAGE_ORDER.indexOf(stage);
}
