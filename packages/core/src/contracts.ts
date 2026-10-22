import { createHmac, timingSafeEqual } from "node:crypto";
import { newId, sha256Json, stableStringify } from "./hash.ts";
import type { WriteContract } from "./models.ts";

export const DEFAULT_CONTRACT_TTL_MS = 15 * 60 * 1000;

export type ContractInput = {
  case_id: string;
  intent: string;
  scope: string[];
  statements: string[];
  cost_ceiling: number;
  ttl_ms?: number;
  signer?: string;
  approved?: boolean;
  approved_by?: string;
};

export type ContractVerifyOptions = {
  requireApproved?: boolean;
  scope?: string;
  statement?: string;
  ignoreExpiry?: boolean;
};

function signaturePayload(contract: WriteContract): Record<string, unknown> {
  return {
    id: contract.id,
    case_id: contract.case_id,
    intent: contract.intent,
    scope: contract.scope,
    statements: contract.statements,
    statements_sha256: contract.statements_sha256,
    cost_ceiling: contract.cost_ceiling,
    expires_at: contract.expires_at,
    signer: contract.signer,
    approved: contract.approved,
    approved_by: contract.approved_by ?? null,
    approved_at: contract.approved_at ?? null,
  };
}

function sign(contract: WriteContract, secret: string): string {
  if (!secret) throw new Error("contract secret is required");
  return createHmac("sha256", secret)
    .update(stableStringify(signaturePayload(contract)))
    .digest("hex");
}

export function signContract(input: ContractInput, secret: string): WriteContract {
  if (!input.statements.length) throw new Error("contract has no statements");
  const now = new Date();
  const contract: WriteContract = {
    id: newId("contract"),
    case_id: input.case_id,
    intent: input.intent,
    scope: [...input.scope],
    statements: [...input.statements],
    statements_sha256: sha256Json(input.statements),
    cost_ceiling: input.cost_ceiling,
    expires_at: new Date(now.getTime() + (input.ttl_ms ?? DEFAULT_CONTRACT_TTL_MS)).toISOString(),
    signer: input.signer ?? "ScoutIntent",
    signature: "",
    approved: input.approved ?? false,
    approved_by: input.approved_by,
    approved_at: input.approved ? now.toISOString() : undefined,
  };
  contract.signature = sign(contract, secret);
  return contract;
}

export function verifyContract(
  contract: WriteContract,
  secret: string,
  opts: ContractVerifyOptions = {},
): void {
  if (!secret) throw new Error("contract secret is required");
  if (sha256Json(contract.statements) !== contract.statements_sha256) {
    throw new Error("contract statement hash mismatch");
  }
  if (opts.scope && !contract.scope.includes(opts.scope)) {
    throw new Error(`contract scope does not include ${opts.scope}`);
  }
  if (opts.statement && !contract.statements.includes(opts.statement)) {
    throw new Error("statement is not part of the signed contract");
  }
  if (!opts.ignoreExpiry && Date.parse(contract.expires_at) <= Date.now()) {
    throw new Error(`contract expired at ${contract.expires_at}`);
  }
  if (opts.requireApproved && !contract.approved) {
    throw new Error("contract is not operator-approved");
  }
  const expected = Buffer.from(sign(contract, secret), "hex");
  const actual = Buffer.from(contract.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("contract signature mismatch");
  }
}

/**
 * Execute exactly the statements that were signed. A writer never adds a
 * statement or resolves a target dynamically; callers that need extra safety
 * can require approval and a scope before this function runs.
 */
export async function executeWriteContract(
  contract: WriteContract,
  secret: string,
  execute: (sql: string) => Promise<unknown>,
  opts: ContractVerifyOptions = {},
): Promise<void> {
  verifyContract(contract, secret, opts);
  for (const statement of contract.statements) {
    if (opts.statement && statement !== opts.statement) {
      throw new Error("contract contains an unexpected statement");
    }
    await execute(statement);
  }
}
