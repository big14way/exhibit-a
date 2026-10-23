# Exhibit A — written sponsor explanation

**Track:** Solving Fragmented Intelligence

**One line:** Exhibit A puts every explanation for a dashboard movement on trial, then returns a verdict of data artifact, real change, mixed, or insufficient evidence — with an exhibit for every claim and a signed, operator-approved writeback.

Outputs are **data-quality findings on public filings, not investment advice.**

**Submission assets:** `deck/exhibit-a-deck.pdf` (editable `.pptx` alongside), `deck/exhibit-a-demo.mp4` (3:44 narrated walkthrough with a real sample CLI replay scene), `PRE_EXISTING_DECLARATION.md`, and the committed `evals/results/latest.md` claim checks.

## The problem and the user

A revenue dashboard moves. The analyst has seven fragmented SEC-derived tables, a naive metric view, and a meeting in an hour. The expensive question is not "what is the new number?" It is "is this number real, and which source caused it?" The common failure modes are duplication, a missing source, a concept/unit/schema change, an ingestion gap, or genuine growth. Most tools return a chart or a fluent explanation. Exhibit A returns an auditable adjudication.

The primary user is a data-quality or analytics engineer who has to explain a movement to a CFO, a data council, or an incident review. The secondary user is an AI agent that needs a trustworthy case record to reuse.

## What the workflow does

1. **Recall** prior closed cases through H-MEM. A cold case starts empty; a warm case gets the prior verdict, causes, and exhibit pointers.
2. **Discover the metric's sources** with Zetaris catalog and `INFER SQLTABLE` lineage, then Scout checks SEC companyfacts for a replacement revenue concept with a continuous annual 10-K chain.
3. **Baseline** the series and find the largest move outside the anomaly band.
4. **Draft and test five hypotheses**: filing-year duplication, concept switch/missing history, real change, short history, and ingestion gap.
5. **Build exhibits** for every claim: the SQL, the result, a content hash, and a rerun command. SEC frames/companyconcept is the independent second channel.
6. **Quantify** the artifact share with a counterfactual that deduplicates to one annual fact per `(cik, period_end)`.
7. **Critique** with a Nemotron Defense Counsel. Objections are advisory; they cannot promote a cause.
8. **Guard** generated prose with a deterministic content-safety check.
9. **Gate** the verdict in code: located, quantified, sufficient, timed, corroborated, and consistent.
10. **Propose a repair**, write only to an isolated shadow under a signed contract, and verify row preservation, uniqueness, SEC parity, original hash, metric sanity, and bad-repair rejection.
11. **Approve** as a separate operator action, then **write back** the corrected view and the `revenue_facts` USL with a composite `(cik, period_end)` key and the `annual_has_frame` DQ rule. Verify-after-write re-reads everything through a separate session.

## Zetaris integration

Zetaris is not decorative; every fact query goes through its REST SQL editor (`packages/tools/src/zetaris.ts`). The investigation uses:

- `SHOW LIGHTNING DATABASES`, `DESCRIBE`, and the metric view for catalog/schema context.
- `INFER SQLTABLE SOURCES` and `INFER SQLTABLE COLUMNS` to build the World Model lineage graph. In the live instance this resolves the `edgar.*` schema-store views to seven `SEC_DATA.*_revenue_facts` source tables.
- Read-only `SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN`/`LOAD USL`/`LIST DQ`/`RUN DQ`/`INFER` statements, enforced by a SQL guard.
- An isolated `exhibit_a_shadow.sector_revenue_by_year` write under a signed, scoped contract.
- The final `exhibit_a.sector_revenue_by_year_v2` view, the `lightning.metastore.exhibit_a.revenue_facts` USL, the composite primary key, the `annual_has_frame` rule, and a catalog description note.
- A separate Zetaris client/session for verify-after-write: final view, original reported view, `LOAD USL`, `LIST DQ`, both `RUN DQ` forms, and `SHOW DATASOURCE VIEWS`.

The reported `analytics.sector_revenue_by_year` is never named in a write statement. The only write scope is the corrected view plus the USL. The live close executed contract `contract_24227e473dae28c8` and passed **8/8** checks; the final view matched the verified shadow with 0 missing, 0 mismatched, 0 extra cells, and the original view hash was unchanged.

## Meterless integration

The Meterless engine contracts are implemented locally under `packages/engines` and `packages/core`:

- **H-MEM** (`packages/engines/src/memory.ts`): recall before an investigation, remember at `CLOSED`, audit malformed/duplicate records, and mine closed case logs. The store is a JSON index under `logs/memory/index.json`. The eval runs the same case cold and warm; warm recall returns the prior closed case.
- **Markovian** (`packages/engines/src/markovian.ts`): packs evidence into bounded chunks with explicit previous/next transition keys. The critic request records the chunk keys and item ids, so the context bound is inspectable.
- **World Model** (`packages/core/src/world-model.ts`): an append-only, idempotent lineage graph. The gate uses it to check that an artifact is located upstream of the symptom view.
- **Scout Intent** (`packages/core/src/contracts.ts`): HMAC-signed, scoped statements with expiry and approval. The writer executes only the signed statements; a tampered, expired, or out-of-scope contract is rejected.

These are original reference implementations of the documented engine contracts, not a vendored Meterless runtime. The local implementations keep the product runnable in a clean clone and in `SAMPLE_MODE` without pretending to run a hosted engine.

## NVIDIA contribution

NVIDIA Nemotron is used where a model can add adversarial review without owning the verdict:

- `packages/agents/src/critic.ts` builds a deterministic Defense Counsel request from the evidence list, hypotheses, counterfactual, and H-MEM hits. The request excludes exhibit ids and timestamps, so it can be replayed exactly.
- The committed cassette contains a real recorded response from `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`: 5 objections, 2,599 prompt tokens, and 5,562 completion tokens. `SAMPLE_MODE` replays it; `npm run record:nim` records a fresh response.
- Objections are parsed, unknown exhibit citations are flagged, and unsafe prose is blocked. The critic cannot change a cause share or promote a cause.
- A deterministic content-safety guard runs even when no model is configured. The output is a data-quality finding, not investment advice.

Ultra is configurable for live runs, but its current OpenAI-compatible route emits chain-of-thought instead of strict JSON for this prompt, so the committed replay uses the verified JSON-capable Nano model. This is documented rather than hidden.

## Cursor usage

The project was developed in Cursor Agent mode. The repository keeps `.cursor/rules/` for project rules. Cursor was used to implement the monorepo, iterate on the Zetaris SQL guard and read/write paths, build the exhibit/trace store, implement the H-MEM/Markovian reference contracts, write the evals, and debug the live readback shapes. The commit history is the development record; the generated `logs/` are gitignored because live and sample SQL forms differ.

## What is unique

- **Adjudication, not summarization.** A model can object; code decides. The verdict has shares, onset timing, and a gate result.
- **The independent second channel is part of the verdict.** SEC frames/companyconcept must corroborate the corrected series, or the artifact claim is downgraded.
- **The repair is proven before it is written.** A shadow view, signed contract, verifier invariants, and bad-repair probes come before operator approval.
- **The writeback is auditable.** The final view and USL are re-read through a separate session, and the original reported view hash must be unchanged.
- **Memory is real.** The warm run reuses a closed case; it does not pretend to remember.
- **The demo is reproducible without keys.** `SAMPLE_MODE=true` replays a labelled cassette and passes 14/14 claim checks.

## Reproduce

```bash
npm install
npm run eval
npm run web
# open http://127.0.0.1:4173

npm run cli -- investigate "is the FY2018 jump real?" --metric analytics.sector_revenue_by_year
npm run cli -- approve <case_id>
npm run cli -- writeback <case_id>
```

Live mode requires a local Zetaris instance, `SAMPLE_MODE=false`, the EDGAR tables and metric view, and the environment values in `.env.example`.

## Limits

- The sample is a replay of a committed cassette, not live inference; it is labelled everywhere.
- The live case was closed against a local Zetaris instance. The current sample path adds H-MEM, discovery, critic, safety, and the viewer; the recorded live close predates those additions.
- The critic is advisory and optional. The deterministic gate and verifier are the safety boundary.
- The output is a data-quality finding on public filings, not investment advice.
