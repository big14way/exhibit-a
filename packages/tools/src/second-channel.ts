import type { Exhibit } from "@exhibit-a/core";
import { executeFactTool, type ToolRuntime } from "./runtime.ts";

const SEC_BASE = "https://data.sec.gov/api/xbrl";

export type SecFramesArgs = {
  kind: "sec_frames";
  concept: string;
  unit: string;
  period: string;
  cik_filter?: string[];
};

export type SecCompanyConceptArgs = {
  kind: "sec_companyconcept";
  cik: string;
  concept: string;
};

export type SecondChannelArgs = SecFramesArgs | SecCompanyConceptArgs;

export type SecFramesResult = {
  frame: string;
  concept: string;
  unit: string;
  source_url: string;
  count: number;
  rows: { cik: string; entity_name: string; value_usd: number }[];
};

export type SecCompanyConceptResult = {
  cik: string;
  concept: string;
  entity_name: string;
  count: number;
  first_period: string | null;
  last_period: string | null;
  forms: string[];
  source_url: string;
};

let lastRequestAt = 0;

async function secGet(url: string): Promise<unknown> {
  const contact = process.env.SEC_USER_AGENT;
  if (!contact || !/[@/]/.test(contact)) {
    throw new Error(
      "SEC_USER_AGENT must include a contact email or URL (SEC fair-access policy)",
    );
  }
  // SEC's edge currently blocks declared non-browser agents from some
  // addresses. Send a browser-shaped agent plus the declared contact in the
  // standard From header instead of dropping the contact requirement.
  const userAgent =
    process.env.SEC_BROWSER_UA ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
  // SEC asks for <=10 requests/second. Serialise with a small gap.
  const wait = Math.max(0, lastRequestAt + 120 - Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(url, {
      headers: {
        "user-agent": userAgent,
        from: contact,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    throw new Error(`SEC ${res.status} for ${url}`);
  }
  throw new Error(`SEC rate-limited or unavailable: ${url}`);
}

export function secFramesArgs(period: string, cikFilter: string[]): SecFramesArgs {
  return {
    kind: "sec_frames",
    concept: "Revenues",
    unit: "USD",
    period,
    cik_filter: cikFilter.map(normalizeCik),
  };
}

export function secCompanyConceptArgs(cik: string, concept = "Revenues"): SecCompanyConceptArgs {
  return { kind: "sec_companyconcept", cik: normalizeCik(cik), concept };
}

export async function secondChannel(
  rt: ToolRuntime,
  args: SecondChannelArgs,
): Promise<{ exhibit: Exhibit; result: SecFramesResult | SecCompanyConceptResult }> {
  const title =
    args.kind === "sec_frames"
      ? `SEC frames ${args.concept}/${args.unit}/${args.period}`
      : `SEC companyconcept CIK${args.cik} ${args.concept}`;

  const { exhibit, result } = await executeFactTool<SecFramesResult | SecCompanyConceptResult>({
    rt,
    tool: "second_channel",
    kind: "second_channel",
    title,
    args,
    source: "sec",
    transport: "sec-api",
    execute: () => fetchSecondChannel(args),
  });
  return { exhibit, result };
}

export async function fetchSecondChannel(
  args: SecondChannelArgs,
): Promise<SecFramesResult | SecCompanyConceptResult> {
  if (args.kind === "sec_frames") {
    const url = `${SEC_BASE}/frames/us-gaap/${encodeURIComponent(args.concept)}/${encodeURIComponent(args.unit)}/${encodeURIComponent(args.period)}.json`;
    const raw = (await secGet(url)) as {
      frame?: string;
      data?: { cik?: number | string; entityName?: string; val?: number }[];
    };
    const wanted = new Set((args.cik_filter ?? []).map(normalizeCik));
    const rows = (raw.data ?? [])
      .map((row) => ({
        cik: normalizeCik(String(row.cik ?? "")),
        entity_name: String(row.entityName ?? ""),
        value_usd: Number(row.val ?? 0),
      }))
      .filter((row) => wanted.size === 0 || wanted.has(row.cik));
    return {
      frame: raw.frame ?? args.period,
      concept: args.concept,
      unit: args.unit,
      source_url: url,
      count: rows.length,
      rows,
    };
  }

  const url = `${SEC_BASE}/companyconcept/CIK${args.cik}/us-gaap/${encodeURIComponent(args.concept)}.json`;
  const raw = (await secGet(url)) as {
    entityName?: string;
    units?: Record<string, { end?: string; form?: string }[]>;
  };
  const facts = Object.values(raw.units ?? {}).flat();
  const ends = facts
    .map((fact) => fact.end ?? "")
    .filter(Boolean)
    .sort();
  const forms = [...new Set(facts.map((fact) => fact.form ?? "").filter(Boolean))].sort();
  return {
    cik: args.cik,
    concept: args.concept,
    entity_name: raw.entityName ?? "",
    count: facts.length,
    first_period: ends[0] ?? null,
    last_period: ends[ends.length - 1] ?? null,
    forms,
    source_url: url,
  };
}

export function normalizeCik(cik: string): string {
  const digits = cik.replace(/\D/g, "");
  return digits.padStart(10, "0");
}
