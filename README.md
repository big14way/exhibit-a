# Exhibit A

A number in a dashboard moved, and someone asks: **is this real?**

Exhibit A finds the fragmented sources behind that number, puts every possible explanation on trial, and returns one of:

- **data artifact** (duplication, a missing source, a concept/unit/schema change, or an ingestion gap)
- **real change**
- **mixed**, with each cause's share
- **insufficient evidence**

Every claim carries an *exhibit*: the exact SQL that ran, its result hash, and a one-command re-run. Code, not the model, decides whether the evidence is enough.

**Track:** Solving Fragmented Intelligence.

Outputs are **data-quality findings on public filings, not investment advice.**

## Status (Day 4 repair + shadow verifier + live writeback)

Working in two modes:

- `SAMPLE_MODE=true` (default) replays the committed cassette; no Zetaris, NVIDIA, or GPU required.
- `SAMPLE_MODE=false` runs the same investigator against a local Zetaris instance.

```bash
npm install
npm run cli -- investigate "is the FY2018 jump real?" --metric analytics.sector_revenue_by_year
npm run cli -- approve <case_id>
npm run cli -- writeback <case_id>
npm run cli -- rerun <exhibit_id>
npm run cli -- replay <case_id>
```

The investigator walks: catalog → describe → `INFER SQLTABLE` lineage → baseline onset → five hypotheses → evidence → counterfactual → critic checkpoint → adjudication → repair plan → signed shadow write → shadow verifier. It writes 19 exhibits, runs the code gate, and prints a verdict plus the repair evidence. The reported view is never replaced in place.

The repair path then stops at `SHADOW_VERIFIED`. `approve <case_id>` verifies the shadow result, signs the exact final statement set, and moves the case to `AWAITING_APPROVAL`; it performs no write. `writeback <case_id>` executes only that approved contract, creates `exhibit_a.sector_revenue_by_year_v2`, activates the `revenue_facts` USL with a composite `(cik, period_end)` key, registers the `annual_has_frame` rule, writes the case note into the USL table description, then re-reads the view and catalog through a separate Zetaris session. It reaches `WRITE_VERIFIED → MEMORISED → CLOSED` only when all eight checks pass.

On the committed sample:

| Finding | Exhibit |
|---|---|
| Reported Manufacturing FY2018 is **1.89x** FY2017 (+$1.3T), outside the 0.67–1.5x band | metric history + baseline |
| **322 duplicate rows** across the seven `edgar.*_revenue_table` tables; FY2018 holds 100 rows over 32 distinct period-end dates | duplication + bucket profile |
| Apple's 11 `Revenues` facts all land in **fiscal_year 2018**, contributing **$1.21T of the $1.30T jump**; Target's `Revenues` concept stops in 2014 | per-company coverage + SEC companyconcept |
| Counterfactual: one annual value per `(cik, period)` removes **96.2%** of the jump, leaving **3.8%** real | counterfactual exhibit |
| Corrected Manufacturing is **1.125x** (+$49.6B), with **12/12** SEC frames parity within 0.5% | corrected series + SEC frames |
| Repair plan deduplicates to one annual fact per `(cik, period_end)`, last filed wins, then sums by period year; the write targets only `exhibit_a_shadow.sector_revenue_by_year` | signed contract + shadow SQL |
| Shadow verifier passes **7/7** invariants: row preservation (11 cells), uniqueness, SEC parity 12/12, original hash unchanged, metric sanity, signed contract, and rejection of two bad-repair probes | shadow verifier exhibit |
| Tesla's short history and an ingestion gap are **eliminated**, not blamed | coverage + SEC count |

**Sample verdict: `MIXED (filing_year_duplication=96.2%, real_change=3.8%)`, gate pass, unexplained 0.0%; shadow verifier 7/7.**

### Writeback and memory

The final write is split into two deliberate commands:

1. `approve` verifies the shadow contract and the seven shadow invariants, then signs a seven-statement contract: corrected container, corrected view, `exhibit_a` USL namespace, `COMPILE USL revenue_facts` with `PRIMARY KEY (cik, period_end)`, `ACTIVATE USL TABLE ... AS` the canonical-period select, `REGISTER DQ annual_has_frame`, and `UPDATE USL ... SET TABLE DESCRIPTION` with the case id, verdict, exhibit ids and date.
2. `writeback` refuses an unapproved, expired, out-of-scope or tampered contract. It executes exactly those statements and re-reads every write through a separate Zetaris client/session: the final view, the original reported view, `LOAD USL`, `LIST DQ`, both `RUN DQ` forms, and `SHOW DATASOURCE VIEWS`.

The sample replay reaches `CLOSED` with **29 exhibits** and **8/8** writeback checks:

| Check | Sample evidence |
|---|---|
| `write_contract` | operator-approved contract, 7 signed statements |
| `final_view_readback` | 11 final cells match the verified shadow; 0 missing, 0 mismatched, 0 extra |
| `usl_model` | `LOAD USL` shows `(cik, period_end)`, `annual_has_frame`, activation query, catalog note |
| `usl_dq_catalog` | `LIST DQ` shows the composite key and the row rule |
| `usl_duplicate_detector` | 21 records, 21 valid, **0 invalid** |
| `usl_row_rule` | 21 records, 21 valid, **0 invalid** |
| `view_catalog` | `SHOW DATASOURCE VIEWS` lists `sector_revenue_by_year_v2` |
| `original_untouched` | reported view hash unchanged |

The sample path is a labelled replay: it uses the verified shadow and canonical counts, writes nothing, and records `executed: false` in the writeback exhibit. A disposable live USL probe separately confirmed that Zetaris 2.4.3.1 accepts the composite primary key, the `COALESCE`/`CAST` activation select, both `RUN DQ` forms, and the table-description update; the probe was removed. The live case is now `CLOSED` after operator approval; the live evidence is below.

### Live Zetaris verification

The same investigation has been run end to end with `SAMPLE_MODE=false` against a local Zetaris instance:

- 19 exhibits, 3 confirmed, 2 eliminated, 0 open.
- Live metric values match the sample: Manufacturing FY2017 **$1,455.9B** → FY2018 **$2,750.9B**.
- The live canonical query returns **1,298 fact rows**. The seven `SEC_DATA.*_revenue_facts` inputs hold **936 duplicate rows** across full history; FY2018 holds **100 rows over 32 period ends**.
- SEC frames parity is **12/12** within 0.5%.
- Live verdict: **`MIXED (filing_year_duplication=96.2%, real_change=3.8%)`**, gate pass, unexplained 0.0%.
- The live shadow write created `exhibit_a_shadow.sector_revenue_by_year` through a signed contract. The shadow has **12 cells**; the verifier passes **7/7** (60 annual facts in the 2016–2019 period window, 22 unique `(cik, period_end)` facts, 38 declared duplicate facts). The reported `analytics.sector_revenue_by_year` re-read hash is unchanged.
- The operator-approved live writeback executed contract `contract_24227e473dae28c8` (7 signed statements) and reached `CLOSED`. The final `exhibit_a.sector_revenue_by_year_v2` re-read has **12 cells**, matching the shadow with **0 missing, 0 mismatched, 0 extra, max relative diff 0.000%**. The `revenue_facts` USL has the `(cik, period_end)` key and `annual_has_frame` rule; both `RUN DQ` forms return **102 records, 102 valid, 0 invalid**. `LOAD USL` carries the case/verdict/date catalog note, `SHOW DATASOURCE VIEWS` lists the final view, and the reported `analytics.sector_revenue_by_year` re-read hash is unchanged. Final: **8/8 checks, 39 exhibits**.
- Verify-after-write caught two readback issues before close: Zetaris returns the USL description on the table (not the model root) and the first `UPDATE USL` stored SQL quote characters; `SHOW DATASOURCE VIEWS` also upper-cases view names. The verifier now handles both shapes and is case-insensitive, the description statement sends unquoted text, and a narrow recovery re-approval re-executed the idempotent contract under a fresh signature. The failed attempt remains in the exhibit/trace log; the final result is 8/8.
- The reported view is never named in a write statement. The only write scope is `exhibit_a.sector_revenue_by_year_v2` plus the `lightning.metastore.exhibit_a.revenue_facts` USL.

Live `INFER SQLTABLE` resolves the `edgar.*` schema-store views down to seven `SEC_DATA.*_revenue_facts` source tables; the world model has 8 nodes / 7 edges. Column-level lineage from the live parser is coarser (`parent` is null), so the gate uses source-level lineage.

The NIM client and spend ledger are in `packages/llm`, but the deterministic evidence path does not call a model yet. Without `NVIDIA_API_KEY` plus `NIM_CRITIC_MODEL`/`NIM_LEAD_MODEL`, the critic checkpoint is marked skipped; the code gate is final either way. The repair proposal and shadow verifier are deterministic: code decides whether the shadow is safe. The output is an adjudication on data quality, not investment advice.

The `SAMPLE_MODE` cassette is a **labelled replay** built from the committed SEC companyconcept/frames sample in `fixtures/edgar/`. It remains the deterministic fixture replay; the live run is kept in gitignored `logs/` because live and sample SQL forms differ. It is not a hardcoded verdict. The planner is deterministic when no NIM model is configured.

## Setup

- Node 20+
- `SAMPLE_MODE=true` needs no external services.
- For live mode, copy `.env.example` to `.env.local` (gitignored, mode 600), set `SAMPLE_MODE=false`, and fill `ZETARIS_REST_URL`, `ZETARIS_API_KEY`, `ZETARIS_ORG_ID`, `ZETARIS_SIC_TABLE`, `EXHIBIT_A_CONTRACT_SECRET`, and `SEC_USER_AGENT`.
- Live Zetaris needs the EDGAR tables loaded and the `analytics.sector_revenue_by_year` / `edgar.sic_edgar_usl` schema-store views created. The onboarding recipe is in Zetaris `getting-started`. `npm run cli -- bootstrap-metric` applies the declared metric view as an operator-approved, signed bootstrap write; the repair path never modifies it.
- Zetaris runs separately; this repo does not embed the platform.
- No local GPU.

```bash
SAMPLE_MODE=true npm run cli -- investigate "is this jump real?"
SAMPLE_MODE=false npm run cli -- investigate "is the FY2018 jump real?"
```

SEC's edge currently rejects some declared non-browser agents. The live second channel sends a browser-shaped `SEC_BROWSER_UA` (or a default) and keeps the required contact in the `From` header from `SEC_USER_AGENT`.

Docker (SAMPLE_MODE):

```bash
docker compose -f docker/compose.yml up --build
```

## Where each sponsor technology is used

| Technology | Where it is used |
|---|---|
| **Zetaris** | All fact queries go through the REST SQL editor (`packages/tools`). `INFER SQLTABLE SOURCES/COLUMNS` builds the case lineage graph; live `INFER` resolves schema-store views to `SEC_DATA.*`. The repair path creates an isolated `exhibit_a_shadow` schema-store view and verifies it. The approved writeback creates `exhibit_a.sector_revenue_by_year_v2`, a `revenue_facts` USL with a composite `(cik, period_end)` key, the `annual_has_frame` DQ rule, and a USL table description as catalog memory; verify-after-write re-reads all of it through a separate session. The naive metric fixture is `analytics/sector_revenue_by_year.sql`. |
| **Meterless** | World Model (lineage graph), H-MEM (case memory), Markovian (bounded context), Scout Intent (signed write contracts). `packages/core/src/contracts.ts` implements HMAC-signed statements and scope enforcement; `packages/core/src/world-model.ts` is a local implementation of the node/edge contract. The vendored engines land under `packages/engines`. |
| **NVIDIA Nemotron** | NIM client with retries, typed tool calls, and a per-case spend ledger (`packages/llm`). Model IDs are configured, never guessed. The deterministic evidence path runs without a key; model critique is optional and not required for a verdict. |
| **SEC EDGAR** | Independent second channel (`packages/tools/src/second-channel.ts`): companyconcept and frames APIs, rate-limited, with a browser-shaped User-Agent and declared `From` contact. |
| **Cursor** | All implementation in Agent mode. Project rules live in `.cursor/rules/`. |

## Layout

```
apps/cli/            investigate | approve | writeback | rerun | replay
apps/web/            case viewer (Day 5)
packages/core/       exhibits, traces, cassettes, state machine, contracts, world-model
packages/tools/      Zetaris client, SQL guard, lineage, repair/verifier, SEC second channel
packages/agents/     deterministic investigator + hypothesis evidence rules + repair orchestration
packages/llm/        NIM client + spend budget
packages/engines/    Meterless engines (later)
analytics/           declared metric-view SQL
fixtures/edgar/      small SEC companyconcept/frames sample
fixtures/cassettes/  labelled SAMPLE_MODE recordings
```

## Hygiene

- Secrets stay in `.env.local` (gitignored, mode 600)
- `EXHIBIT_A_BLUEPRINT.md` is private planning notes and is gitignored
- Investigation SQL is read-only. Writes go through an HMAC-signed contract; the shadow is isolated, `approve` is a separate operator gate, and `writeback` executes only the approved final statements. The reported analytics view is never named in a write statement
- `npm test` and `npm run typecheck` must pass before a push
