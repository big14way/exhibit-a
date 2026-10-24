import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../apps/cli/src/env.ts";
import {
  EDGAR_COMPANIES,
  buildDiscoveryResult,
  fetchCompanyFacts,
} from "@exhibit-a/tools";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// TICKER/CONCEPT/OUT parameters allow a discovery fixture per metric.
const TICKER = process.env.TICKER ?? "AAPL";
const CONCEPT = process.env.CONCEPT ?? "Revenues";
const OUT = resolve(ROOT, process.env.OUT ?? "fixtures/edgar/apple-discovery.json");
loadEnv(ROOT);

const apple = EDGAR_COMPANIES.find((company) => company.ticker === TICKER);
if (!apple) throw new Error(`unknown ticker ${TICKER}`);
const facts = await fetchCompanyFacts(apple.cik);
const result = buildDiscoveryResult(facts, {
  cik: apple.cik,
  entity_name: apple.entity_name,
  concept: CONCEPT,
  concept_family: CONCEPT === "Revenues" ? undefined : CONCEPT,
  sic_division: apple.sic_division,
});
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(
  `wrote ${OUT} — ${result.candidates.length} candidates, replacement ${result.replacement_concept ?? "none"}`,
);
