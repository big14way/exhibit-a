export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
};

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/**
 * Per-case spend ledger. Prices are per million tokens and come from env, so
 * the cap is honest: with no prices configured we track tokens but cannot
 * claim a dollar figure.
 */
export class Budget {
  private spentUsd = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private calls = 0;

  constructor(
    readonly capUsd: number,
    private readonly inputPerM: number,
    private readonly outputPerM: number,
  ) {}

  spend(usage: Usage): void {
    this.calls += 1;
    this.inputTokens += usage.prompt_tokens;
    this.outputTokens += usage.completion_tokens;
    this.spentUsd +=
      (usage.prompt_tokens * this.inputPerM) / 1_000_000 +
      (usage.completion_tokens * this.outputPerM) / 1_000_000;
    if (this.spentUsd > this.capUsd) {
      throw new BudgetExceededError(
        `case spend ${this.spentUsd.toFixed(4)} USD exceeds cap ${this.capUsd.toFixed(2)} USD`,
      );
    }
  }

  get spent(): number {
    return this.spentUsd;
  }

  get remaining(): number {
    return Math.max(0, this.capUsd - this.spentUsd);
  }

  get summary(): { calls: number; input_tokens: number; output_tokens: number; spent_usd: number } {
    return {
      calls: this.calls,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      spent_usd: this.spentUsd,
    };
  }
}

export function budgetFromEnv(): Budget {
  const cap = Number(process.env.SPEND_CAP_USD ?? "8");
  const input = Number(process.env.NIM_PRICE_INPUT_PER_M ?? "0");
  const output = Number(process.env.NIM_PRICE_OUTPUT_PER_M ?? "0");
  return new Budget(Number.isFinite(cap) ? cap : 8, input, output);
}
