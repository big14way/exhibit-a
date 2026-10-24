import type { SafetyFinding, SafetyModelResult, SafetyResult } from "./models.ts";

/**
 * Deterministic content-safety guard for the human-readable finding. This is
 * deliberately narrow: the product reports data-quality findings on public
 * filings, so it must never turn evidence into a recommendation to trade.
 *
 * The guard is lexical and fail-closed only for clear advice/guarantee
 * language. It is not a general profanity or moderation filter; the optional
 * NIM safety model can add a second layer, while this check always runs.
 */
const RULES: { rule: string; pattern: RegExp; detail: string }[] = [
  {
    rule: "investment_advice",
    pattern:
      /\b(?:investment\s+advice|financial\s+advice|you\s+should\s+(?:buy|sell|hold|short)|we\s+recommend\s+(?:buying|selling|holding)|our\s+recommendation|price\s+target|target\s+price)\b/i,
    detail: "The finding may not contain investment advice or a price target.",
  },
  {
    rule: "trade_instruction",
    pattern:
      /\b(?:buy|sell|short)\s+(?:the\s+)?(?:stock|shares?|security|equity|position)\b/i,
    detail: "The finding may not instruct a reader to trade a security.",
  },
  {
    rule: "rating_language",
    pattern:
      /\b(?:outperform|underperform|overweight|underweight|strong\s+buy|strong\s+sell|market\s+perform)\b/i,
    detail: "The finding may not use analyst rating language.",
  },
  {
    rule: "return_guarantee",
    pattern:
      /\b(?:guarantee(?:d|s)?|assure(?:d|s)?)\s+(?:a\s+)?(?:return|profit|gain|upside)\b/i,
    detail: "The finding may not guarantee a financial return.",
  },
];

const NEGATED = /\b(?:not|no|never|without|n't|isn't|doesn't|don't)\b[^.!?\n]{0,48}$/i;
const DISCLAIMER =
  "Data-quality finding on public filings, not investment advice.";

export function checkContentSafety(text: string): SafetyResult {
  const findings: SafetyFinding[] = [];
  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      const prefix = text.slice(Math.max(0, index - 64), index);
      // "This is not investment advice" is the required disclaimer, not a
      // recommendation. A negation directly before the phrase clears it.
      if (NEGATED.test(prefix)) continue;
      findings.push({
        rule: rule.rule,
        match: match[0],
        detail: rule.detail,
      });
    }
  }
  return {
    ok: findings.length === 0,
    policy: "data-quality-finding-no-investment-advice",
    findings,
    checked_chars: text.length,
    action: findings.length === 0 ? "allow" : "block",
  };
}

/**
 * Apply the guard to generated prose. The disclaimer itself is appended only
 * after the check, so a finding cannot hide behind "not investment advice".
 */
export function safeFindingText(text: string): { text: string; safety: SafetyResult } {
  const safety = checkContentSafety(text);
  if (!safety.ok) {
    const rules = [...new Set(safety.findings.map((finding) => finding.rule))].join(", ");
    return {
      text:
        "The generated finding was withheld by the content-safety guard " +
        `(${rules}). The exhibits remain available for operator review. ${DISCLAIMER}`,
      safety,
    };
  }
  return { text: `${text.trim()} ${DISCLAIMER}`.trim(), safety };
}

/**
 * Merge the deterministic lexical result with the Nemotron content-safety
 * model's labels. The model can only add a block: a lexical block stands even
 * when the model says safe, and a model "unsafe" withholds the finding even
 * when the lexical rules found nothing.
 */
export function combineSafety(lexical: SafetyResult, model: SafetyModelResult): SafetyResult {
  const modelBlocks = model.status === "ran" && model.response_safety === "unsafe";
  const ok = lexical.ok && !modelBlocks;
  return {
    ...lexical,
    ok,
    action: ok ? "allow" : "block",
    findings: modelBlocks
      ? [
          ...lexical.findings,
          {
            rule: "nemotron_content_safety",
            match: model.categories.join(", ") || "unsafe",
            detail: `The content-safety model labelled the finding ${model.response_safety}.`,
          },
        ]
      : lexical.findings,
    model,
  };
}

export function safetyText(...parts: unknown[]): string {
  return parts
    .map((part) => {
      if (part === undefined || part === null) return "";
      if (typeof part === "string") return part;
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}
