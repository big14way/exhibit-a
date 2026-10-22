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

## Status (Day 3 verdict layer)

Working now, with `SAMPLE_MODE=true` (default):

```bash
npm install
npm run cli -- investigate "is the FY2018 jump real?" --metric analytics.sector_revenue_by_year
npm run cli -- rerun <exhibit_id>
npm run cli -- replay <case_id>
```

The investigator walks: catalog → describe → `INFER SQLTABLE` lineage → baseline onset → five hypotheses → evidence → counterfactual → critic checkpoint → adjudication. It writes 15 exhibits, runs the code gate, and prints a verdict.

On the committed sample:

| Finding | Exhibit |
|---|---|
| Reported Manufacturing FY2018 is **1.89x** FY2017 (+$1.3T), outside the 0.67–1.5x band | metric history + baseline |
| **322 duplicate rows** across the seven `edgar.*_revenue_table` tables; FY2018 holds 100 rows over 32 distinct period-end dates | duplication + bucket profile |
| Apple's 11 `Revenues` facts all land in **fiscal_year 2018**, contributing **$1.21T of the $1.30T jump**; Target's `Revenues` concept stops in 2014 | per-company coverage + SEC companyconcept |
| Counterfactual: one annual value per `(cik, period)` removes **96.2%** of the jump, leaving **3.8%** real | counterfactual exhibit |
| Corrected Manufacturing is **1.125x** (+$49.6B), with **12/12** SEC frames parity within 0.5% | corrected series + SEC frames |
| Tesla's short history and an ingestion gap are **eliminated**, not blamed | coverage + SEC count |

**Verdict: `MIXED (filing_year_duplication=96.2%, real_change=3.8%)`, gate pass, unexplained 0.0%.**

The model critic is skipped without a NIM key, and the code gate is final: no model prose can promote a cause. The verifier, repair proposal and shadow view land next. The output is an adjudication on data quality, not investment advice.

The `SAMPLE_MODE` cassette is a **labelled replay** built from the committed SEC companyconcept/frames sample in `fixtures/edgar/`; replace it after the first live Zetaris recording. It is not a hardcoded verdict. The planner is deterministic when no NIM key is set.

## Setup

- Node 20+
- Copy `.env.example` to `.env.local` for live mode (`SAMPLE_MODE=false`, Zetaris URL and key)
- Zetaris runs separately; this repo does not embed the platform
- No local GPU

```bash
SAMPLE_MODE=true npm run cli -- investigate "is this jump real?"
```

Docker (SAMPLE_MODE):

```bash
docker compose -f docker/compose.yml up --build
```

## Where each sponsor technology is used

| Technology | Where it is used |
|---|---|
| **Zetaris** | All fact queries go through the REST SQL editor (`packages/tools`). `INFER SQLTABLE SOURCES/COLUMNS` builds the case lineage graph. USL keys/DQ, schemastore views, and writeback are later. The naive metric fixture is `analytics/sector_revenue_by_year.sql`. |
| **Meterless** | World Model (lineage graph), H-MEM (case memory), Markovian (bounded context), Scout Intent (signed write contracts). `packages/core/src/world-model.ts` is a local implementation of the node/edge contract; the vendored engines land under `packages/engines`. |
| **NVIDIA Nemotron** | NIM client with retries, typed tool calls, and a per-case spend ledger (`packages/llm`). Model IDs are configured, never guessed. The deterministic evidence path runs without a key; the model planner attaches at the hypothesis step. |
| **SEC EDGAR** | Independent second channel (`packages/tools/src/second-channel.ts`): companyconcept and frames APIs, rate-limited, with a contact User-Agent. |
| **Cursor** | All implementation in Agent mode. Project rules live in `.cursor/rules/`. |

## Layout

```
apps/cli/            investigate | rerun | replay
apps/web/            case viewer (Day 5)
packages/core/       exhibits, traces, cassettes, state machine, world-model
packages/tools/      Zetaris client, SQL guard, lineage, SEC second channel
packages/agents/     deterministic investigator + hypothesis evidence rules
packages/llm/        NIM client + spend budget
packages/engines/    Meterless engines (later)
analytics/           declared metric-view SQL
fixtures/edgar/      small SEC companyconcept/frames sample
fixtures/cassettes/  labelled SAMPLE_MODE recordings
```

## Hygiene

- Secrets stay in `.env.local`
- `EXHIBIT_A_BLUEPRINT.md` is private planning notes and is gitignored
- Investigation SQL is read-only unless a signed, approved write contract exists
- `npm test` and `npm run typecheck` must pass before a push
