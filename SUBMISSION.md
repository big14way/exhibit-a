# Exhibit A — written sponsor explanation

**Track:** Solving Fragmented Intelligence · **Team:** Exhibit A (solo, Godswill Idolor)

**One line:** Exhibit A puts every explanation for a dashboard movement on trial, then returns a verdict of data artifact, real change, mixed, or insufficient evidence — with an exhibit for every claim and a signed, operator-approved writeback into Zetaris.

Outputs are **data-quality findings on public filings, not investment advice.**

**Submission assets:** `deck/exhibit-a-deck.pdf` (editable `.pptx` alongside), `deck/exhibit-a-demo.mp4` (YouTube: https://youtu.be/ij--TZQ0H4Y), the read-only viewer at https://big14way.github.io/exhibit-a/, `README.md`, `PRE_EXISTING_DECLARATION.md`, `evals/results/latest.md` (20/20 claim checks), `fixtures/cases/live/` (the recorded live Zetaris close).

## The problem and the user

In October 2020, 15,841 positive COVID tests were left out of England's daily numbers because the case file hit a spreadsheet size limit; an estimated 48,000–50,000 close contacts were never traced. A wrong number on a dashboard is not an abstract risk.

Dana, an analytics engineer, watches Manufacturing revenue double on a dashboard built from seven fragmented SEC-derived tables behind a naive metric view. The CFO meeting is in an hour. Last quarter a number like this went into the board deck; it was a duplicate, and trust in the dashboard has not recovered. The expensive question is not "what is the new number?" It is "is this number real, and which source caused it?" The usual failure modes are duplication, a missing source, a concept/unit/schema change, an ingestion gap, or genuine growth. Most tools return a chart or a fluent paragraph. Exhibit A returns an auditable adjudication and, when the number is wrong, a proven and approved fix.

The primary user is a data-quality or analytics engineer who has to explain a movement to a CFO, a data council, or an incident review. The secondary user is an agent that needs a trustworthy case record to reuse.

## What the workflow does

1. **Recall** prior closed cases through H-MEM. A cold case starts empty; a warm case gets the prior verdict, causes and exhibit pointers, re-scored with Nemotron embeddings.
2. **Discover the metric's sources** with the Zetaris catalog and `INFER SQLTABLE` lineage.
3. **Baseline** the series and find the largest move outside the anomaly band.
4. **Draft five hypotheses** in code: filing-year duplication, concept switch / missing history, real change, single-filer growth, ingestion gap.
5. **Pull evidence** as rerunnable SQL exhibits and **select the filers under suspicion from the evidence**: the filer whose facts all land in the onset year, the filer whose history stops before the prior period, the fastest-growing filer in the moved segment. No company is named in code.
6. **Scout** checks SEC companyfacts for a replacement revenue concept with a continuous annual 10-K chain, and the SEC frames/companyconcept APIs serve as an independent second channel.
7. **Quantify** the artifact share with a counterfactual that deduplicates to one annual fact per `(cik, period_end)`.
8. **Critique** with a Nemotron Defense Counsel. Objections are advisory and logged with the exact Markovian windows that built the prompt.
9. **Guard** the generated finding with two content-safety layers: deterministic lexical rules and the Nemotron content-safety model.
10. **Gate** the verdict in code: located, quantified, sufficient, timed, corroborated, consistent shares.
11. **Propose a repair**, write only to an isolated shadow under a signed contract, and verify row preservation, uniqueness, SEC parity, original hash, metric sanity and bad-repair rejection.
12. **Approve** as a separate operator action, then **write back** the corrected view and the `revenue_facts` USL with a composite key and a DQ rule. Verify-after-write re-reads everything through a separate session.

## Zetaris integration

Zetaris is the fact path, not a badge; every fact query goes through its REST SQL editor (`packages/tools/src/zetaris.ts`).

- `SHOW LIGHTNING DATABASES`, `DESCRIBE`, and the metric view for catalog/schema context.
- `INFER SQLTABLE SOURCES` and `INFER SQLTABLE COLUMNS` build the World Model lineage graph. Live, this resolves the `edgar.*` schema-store views to seven `SEC_DATA.*_revenue_facts` source tables.
- A read-only guard allows `SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN`/`LOAD USL`/`LIST DQ`/`RUN DQ`/`INFER` and rejects any write form anywhere in a statement (a CTE cannot smuggle an `INSERT`).
- An isolated `exhibit_a_shadow.sector_revenue_by_year` write under a signed, scoped contract.
- The final `exhibit_a.sector_revenue_by_year_v2` view, the `lightning.metastore.exhibit_a.revenue_facts` USL with `PRIMARY KEY (cik, period_end)`, the `annual_has_frame` rule, and a catalog description note that records the case, verdict and exhibit ids.
- A separate Zetaris client/session for verify-after-write: final view, original reported view, `LOAD USL`, `LIST DQ`, both `RUN DQ` forms, and `SHOW DATASOURCE VIEWS`.

The reported `analytics.sector_revenue_by_year` is never named in a write statement. The live close executed contract `contract_24227e473dae28c8` and passed **8/8** checks; the final view matched the verified shadow with 0 missing, 0 mismatched, 0 extra cells, and the original view hash was unchanged. The full live case log is committed under `fixtures/cases/live/`.

## Meterless integration

The Meterless engine contracts are implemented locally under `packages/engines` and `packages/core`:

- **H-MEM** (`packages/engines/src/memory.ts`): recall before an investigation, remember at `CLOSED`, audit malformed/duplicate records, mine closed case logs. The store is a JSON index under `logs/memory/index.json`. Recall is lexical and, when an embedding role is available, re-scored by cosine similarity; the warm sample case recalls the closed case with similarity 0.72 from recorded `nemotron-3.5-embed-1b` vectors.
- **Markovian** (`packages/engines/src/markovian.ts`): evidence is packed into bounded windows with explicit previous/next transition keys. The critic exhibit records the exact pack that built the prompt (`context.chunks`), so the bound is inspectable rather than asserted.
- **World Model** (`packages/core/src/world-model.ts`): an append-only, idempotent lineage graph. The gate's "located" rule and the adjudication's blamed objects come from it.
- **Scout Intent** (`packages/core/src/contracts.ts`): HMAC-signed, scoped statements with expiry and operator approval. The writer executes only the signed statements; a tampered, expired, unapproved or out-of-scope contract is rejected.

These are original reference implementations of the documented engine contracts, not a vendored Meterless runtime. They keep the product runnable in a clean clone and in `SAMPLE_MODE` without pretending to run a hosted engine.

## NVIDIA contribution

Nemotron is used in three roles, each where a model adds something without owning the verdict (`packages/llm`, `packages/agents/src/critic.ts`):

| Role | Model | What it does | Boundary |
|---|---|---|---|
| Defense Counsel | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | Attacks each claimed cause from the evidence list, hypotheses, counterfactual and H-MEM hits; returns JSON objections with severity and exhibit citations | Cannot promote or block a cause; unknown citations are flagged; unsafe prose is discarded |
| Content safety | `nvidia/nemotron-3.5-content-safety` | Labels the operator's question and the generated finding (`User Safety` / `Response Safety`) | Can only add a block on top of the deterministic lexical guard, never lift one |
| H-MEM recall | `nvidia/nemotron-3.5-embed-1b` | Embeds the query and the memory records; cosine similarity is added to the lexical score | Falls back to lexical recall with a recorded status when the model is unavailable |

The committed cassette holds six real recorded responses (critic, safety and embeddings for both the cold and the warm case: 5 objections each, 2,620+5,051 and 2,682+6,790 tokens for the critic). `SAMPLE_MODE` replays them keyed by the deterministic request hash; `npm run record:nim` is a write-through recorder that only sends missing requests. Live mode reads `NIM_CRITIC_MODEL`, `NIM_SAFETY_MODEL` and `NIM_EMBED_MODEL`; spend is metered per case with a cap. Ultra is configurable as the critic, but its current OpenAI-compatible route emits chain-of-thought instead of strict JSON for this prompt, so the recorded critic is the JSON-capable Nano model. This is documented rather than hidden.

## Cursor usage

The project was developed in Cursor Agent mode with project rules in `.cursor/rules/`. Cursor was used to implement the monorepo, iterate on the Zetaris SQL guard and read/write paths, build the exhibit/trace store, implement the H-MEM/Markovian reference contracts, write the evals and the viewer, and debug the live readback shapes. The commit history is the development record.

## What is unique

- **Adjudication, not summarization.** A model can object; code decides. The verdict has shares, onset timing and a gate result.
- **Suspects come from the data, and it is shown.** The filers blamed or cleared are selected from the coverage rows. A second metric, sector net income from SEC `NetIncomeLoss`, runs on the same investigator and reaches a different verdict (`DATA_ARTIFACT`, IBM as the late-starting source whose earlier periods were filed under `ProfitLoss`, real change eliminated because the corrected series fell). Only the metric spec differs; the eval checks it.
- **The independent second channel is part of the verdict.** SEC frames/companyconcept must corroborate the corrected series, or the artifact claim is downgraded.
- **The repair is proven before it is written.** Shadow view, signed contract, seven verifier invariants and two bad-repair probes come before operator approval.
- **The writeback is auditable.** The final view and the USL are re-read through a separate session and the original reported view hash must be unchanged; the live close is committed as evidence.
- **Three Nemotron roles, all bounded.** Critic, content safety and embeddings each have a documented boundary and a recorded fallback.
- **Reproducible without keys.** `npm run eval` passes 20/20 claim checks and reproduces its result file byte for byte.

## Reproduce

```bash
npm install
npm run eval
npm run web          # http://127.0.0.1:4173
npm run cli -- investigate "is the FY2018 jump real?" --metric analytics.sector_revenue_by_year
npm run cli -- approve <case_id>
npm run cli -- writeback <case_id>
```

Live mode requires a local Zetaris instance, `SAMPLE_MODE=false`, the EDGAR tables and metric view, and the environment values in `.env.example`.

## Limits

- The sample is a replay of a committed cassette, not live inference; it is labelled everywhere. The live close is committed as a case log and is evidence from the local Zetaris instance at the time it was run; it predates the embedding/critic/safety additions.
- The sample writeback readbacks are synthesized from the verified shadow and labelled `executed: false`; the real readbacks are in the live case.
- The critic is advisory and optional. The deterministic gate and verifier are the safety boundary.
- The investigation is scoped to SEC revenue facts summed by filing year; other metrics need their own evidence SQL, though the hypothesis selection and gate are generic.
- The output is a data-quality finding on public filings, not investment advice.
