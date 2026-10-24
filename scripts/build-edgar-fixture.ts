#!/usr/bin/env npx tsx
/**
 * Refresh the committable EDGAR sample used by the SAMPLE_MODE cassette.
 * Not used at runtime. Requires SEC_USER_AGENT with a real contact, per the
 * SEC fair-access policy.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EDGAR_COMPANIES, secGet } from "../packages/tools/src/index.ts";
import { loadEnv } from "../apps/cli/src/env.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(ROOT);
const OUT_DIR = resolve(ROOT, "fixtures/edgar");
const SEC_BASE = "https://data.sec.gov/api/xbrl";
const WINDOW = { from: 2016, to: 2019 };
// Concept and output names are parameters so a second metric can be built from
// the same script: CONCEPT=NetIncomeLoss OUT=netincome npm run fixture:edgar
const CONCEPT = process.env.CONCEPT ?? "Revenues";
const OUT = process.env.OUT ?? "revenue";

type SecFact = {
  start: string;
  end: string;
  val: number;
  accn: string;
  fy: number;
  fp: string;
  form: string;
  filed: string;
  frame?: string;
};

async function get(url: string): Promise<unknown> {
  // Same transport as the live second channel: declared contact in From,
  // browser-shaped agent because SEC's edge blocks declared non-browser agents.
  const raw = await secGet(url);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return raw;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const facts: Record<string, unknown>[] = [];
  const coverage: Record<string, unknown>[] = [];

  for (const company of EDGAR_COMPANIES) {
    const url = `${SEC_BASE}/companyconcept/CIK${company.cik}/us-gaap/${CONCEPT}.json`;
    const raw = (await get(url)) as {
      entityName?: string;
      units?: { USD?: SecFact[] };
    };
    const all = raw.units?.USD ?? [];
    // Target keeps its full history so the stopped concept is visible.
    // Other companies keep the four dashboard years; comparatives in those
    // filings carry the facts a corrected annual view needs.
    const kept =
      company.ticker === "TGT"
        ? all
        : all.filter((fact) => fact.fy >= WINDOW.from && fact.fy <= WINDOW.to);
    coverage.push({
      cik: company.cik,
      entity_name: company.entity_name,
      facts_all: all.length,
      facts_kept: kept.length,
      first_filed: all[0]?.filed ?? null,
      last_filed: all[all.length - 1]?.filed ?? null,
    });
    for (const fact of kept) {
      facts.push({
        cik: company.cik,
        ticker: company.ticker,
        entity_name: company.entity_name,
        concept: CONCEPT,
        period_start: fact.start,
        period_end: fact.end,
        value_usd: fact.val,
        accession_number: fact.accn,
        fiscal_year: fact.fy,
        fiscal_period: fact.fp,
        period_frame: fact.frame ?? null,
        form_type: fact.form,
        filed_date: fact.filed,
      });
    }
    console.log(`${company.ticker}: ${kept.length}/${all.length} facts`);
  }

  facts.sort(
    (a, b) =>
      String(a.cik).localeCompare(String(b.cik)) ||
      String(a.period_end).localeCompare(String(b.period_end)) ||
      String(a.filed_date).localeCompare(String(b.filed_date)),
  );

  const frames: Record<string, unknown>[] = [];
  for (const period of (process.env.FRAMES ?? "CY2017,CY2018").split(",")) {
    const url = `${SEC_BASE}/frames/us-gaap/${CONCEPT}/USD/${period}.json`;
    const raw = (await get(url)) as {
      frame?: string;
      data?: { cik?: number; entityName?: string; val?: number }[];
    };
    const wanted = new Set<string>(EDGAR_COMPANIES.map((company) => company.cik));
    const rows = (raw.data ?? [])
      .filter((row) => wanted.has(String(row.cik ?? "").padStart(10, "0")))
      .map((row) => ({
        cik: String(row.cik ?? "").padStart(10, "0"),
        entity_name: String(row.entityName ?? ""),
        value_usd: Number(row.val ?? 0),
      }));
    frames.push({
      frame: raw.frame ?? period,
      concept: CONCEPT,
      unit: "USD",
      source_url: url,
      count: rows.length,
      rows,
    });
    console.log(`${period}: ${rows.length} companies`);
  }

  const payload = {
    source: `SEC XBRL companyconcept API, us-gaap/${CONCEPT}, USD`,
    retrieved_at: new Date().toISOString().slice(0, 10),
    window: WINDOW,
    companies: EDGAR_COMPANIES,
    coverage,
    facts,
  };
  writeFileSync(resolve(OUT_DIR, `${OUT}-facts.json`), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(resolve(OUT_DIR, OUT === "revenue" ? "sec-frames.json" : `sec-frames-${OUT}.json`), `${JSON.stringify({ frames }, null, 2)}\n`);
  console.log(`wrote fixtures/edgar/${OUT}-facts.json (${facts.length} facts)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
