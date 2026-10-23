import type { DiscoveryCandidate, DiscoveryResult, Exhibit } from "@exhibit-a/core";
import { EDGAR_COMPANIES } from "./edgar.ts";
import { executeFactTool, type ToolRuntime } from "./runtime.ts";
import { fetchCompanyFacts, type CompanyFacts, type CompanyFact } from "./second-channel.ts";

export type DiscoverSourcesArgs = {
  kind: "sec_companyfacts";
  cik: string;
  entity_name: string;
  concept: string;
  sic_division: string;
};

const REVENUE_CONCEPT = /revenue|salesrevenue|contractwithcustomer/i;
const NOT_REVENUE_CONCEPT =
  /liability|deferred|increase|decrease|cost|obligation|remainingperformance|allowance/i;
const ANNUAL_MIN_DAYS = 330;
const ANNUAL_MAX_DAYS = 400;
const STALE_DAYS = 421;

function annualRows(facts: CompanyFact[]): CompanyFact[] {
  const latest = new Map<string, CompanyFact>();
  for (const fact of facts) {
    if (!fact.start || !fact.end || !Number.isFinite(Number(fact.val))) continue;
    const days =
      (new Date(fact.end).getTime() - new Date(fact.start).getTime()) / 86_400_000;
    if (days < ANNUAL_MIN_DAYS || days > ANNUAL_MAX_DAYS) continue;
    if (fact.form && !fact.form.startsWith("10-K")) continue;
    const current = latest.get(fact.end);
    if (!current || String(fact.filed ?? "") > String(current.filed ?? "")) {
      latest.set(fact.end, fact);
    }
  }
  return [...latest.values()].sort((a, b) => String(a.end).localeCompare(String(b.end)));
}

function continuous(rows: CompanyFact[], reference: string | null): boolean {
  if (rows.length < 2 || !reference) return false;
  const last = rows[rows.length - 1]?.end;
  if (!last) return false;
  const gap = (new Date(reference).getTime() - new Date(last).getTime()) / 86_400_000;
  return gap <= STALE_DAYS;
}

/**
 * Scout's replacement-concept discovery. This is code over the SEC
 * companyfacts payload, not a model guess: a candidate must be a US-GAAP
 * revenue concept with annual 10-K facts, a continuous period chain, and a
 * period chain that extends beyond the concept that stopped.
 */
export function buildDiscoveryResult(
  facts: CompanyFacts,
  args: Omit<DiscoverSourcesArgs, "kind">,
): DiscoveryResult {
  const usGaap = facts.facts["us-gaap"] ?? {};
  const revenueFacts = Object.entries(usGaap)
    .filter(
      ([concept, item]) =>
        REVENUE_CONCEPT.test(item.label ?? "") &&
        REVENUE_CONCEPT.test(concept) &&
        !NOT_REVENUE_CONCEPT.test(concept),
    )
    .flatMap(([, item]) =>
      Object.entries(item.units ?? {})
        .filter(([unit]) => unit === "USD")
        .flatMap(([, rows]) => rows),
    );
  const reference = annualRows(revenueFacts)
    .map((row) => row.end)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  const currentRows = annualRows(
    (usGaap[args.concept]?.units?.USD ?? []) as CompanyFact[],
  );
  const currentLast = currentRows.at(-1)?.end ?? null;

  const candidates: DiscoveryCandidate[] = [];
  for (const [concept, item] of Object.entries(usGaap)) {
    if (
      !REVENUE_CONCEPT.test(item.label ?? "") ||
      !REVENUE_CONCEPT.test(concept) ||
      NOT_REVENUE_CONCEPT.test(concept)
    ) {
      continue;
    }
    const rows = annualRows((item.units?.USD ?? []) as CompanyFact[]);
    if (rows.length === 0) continue;
    const last = rows.at(-1)?.end ?? null;
    const first = rows[0]?.end ?? null;
    const forms = [...new Set(rows.map((row) => row.form ?? "").filter(Boolean))].sort();
    const extendsChain =
      last !== null &&
      (currentLast === null || new Date(last).getTime() >= new Date(currentLast).getTime());
    const score =
      rows.length * 2 +
      (continuous(rows, reference) ? 5 : 0) +
      (extendsChain ? 4 : 0) +
      (concept.startsWith("Revenue") ? 3 : 0) +
      (concept === args.concept ? 1 : 0);
    candidates.push({
      concept,
      annual_facts: rows.length,
      first_period: first,
      last_period: last,
      continuous: continuous(rows, reference),
      latest_forms: forms.slice(-3),
      score,
    });
  }
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      String(b.last_period ?? "").localeCompare(String(a.last_period ?? "")) ||
      a.concept.localeCompare(b.concept),
  );

  const replacement =
    candidates.find(
      (candidate) =>
        candidate.concept !== args.concept &&
        candidate.continuous &&
        candidate.last_period !== null &&
        (currentLast === null ||
          new Date(candidate.last_period).getTime() > new Date(currentLast).getTime()),
    ) ?? null;

  const peers = EDGAR_COMPANIES.filter(
    (company) =>
      company.sic_division === args.sic_division && company.cik !== args.cik,
  ).map((company) => ({
    ticker: company.ticker,
    table: company.table,
    sic_division: company.sic_division,
  }));

  const reason =
    replacement && currentLast
      ? `${args.concept} has ${currentRows.length} annual 10-K facts ending ${currentLast}; ` +
        `${replacement.concept} has ${replacement.annual_facts} annual 10-K facts ending ${replacement.last_period} ` +
        `and a continuous chain, so the missing history is a concept switch, not a lost source.`
      : currentLast
        ? `${args.concept} has annual 10-K facts ending ${currentLast}; no replacement concept with a longer continuous chain was found.`
        : `No annual 10-K facts found for ${args.concept}.`;

  return {
    company: args.entity_name,
    cik: args.cik,
    current_concept: args.concept,
    current_annual_facts: currentRows.length,
    replacement_concept: replacement?.concept ?? null,
    replacement_reason: reason,
    candidates: candidates.slice(0, 8),
    peers,
    source_url: facts.source_url,
    rule:
      "revenue concept must have USD annual 10-K facts (330-400 days), a chain ending within 421 days, and extend the stopped concept",
  };
}

export async function discoverSources(
  rt: ToolRuntime,
  args: DiscoverSourcesArgs,
): Promise<{ exhibit: Exhibit; result: DiscoveryResult }> {
  return executeFactTool<DiscoveryResult>({
    rt,
    tool: "discover_sources",
    kind: "discovery",
    title: `discover replacement concept for ${args.entity_name} ${args.concept}`,
    args,
    source: "sec",
    transport: "sec-api",
    execute: async () => buildDiscoveryResult(await fetchCompanyFacts(args.cik), args),
  });
}
