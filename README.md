# Exhibit A

A number in a dashboard moved, and someone asks: **is this real?**

Exhibit A finds the fragmented sources behind that number, puts every possible explanation on trial, and returns one of:

- **data artifact** (duplication, a missing source, a concept/unit/schema change, or an ingestion gap)
- **real change**
- **mixed**, with each cause's share
- **insufficient evidence**

Every claim carries an *exhibit*: the exact SQL that ran, its result hash, and a one-command re-run. Code, not the model, decides whether the evidence is enough. When the verdict is an artifact, Exhibit A proves the fix on an isolated shadow view, waits for an operator to approve a signed contract, writes the corrected view and a keyed USL back into Zetaris, and re-reads what it wrote through a separate session.

**Track:** Solving Fragmented Intelligence · **Team:** Exhibit A (solo) · **Open Agent Hackathon 2026**

Outputs are **data-quality findings on public filings, not investment advice.**

## Why this matters

In October 2020, 15,841 positive COVID tests were left out of England's daily case numbers for eight days because the case file hit a spreadsheet size limit. The patients were told; an estimated 48,000–50,000 of their close contacts were never traced ([The Register](https://www.theregister.com/2020/10/05/excel_england_coronavirus_contact_error/), [The Conversation](https://theconversation.com/why-you-should-never-use-excel-to-count-coronavirus-cases-147681)). The number on the dashboard was wrong, nobody could tell from the chart, and people acted on it.

Analytics teams meet the same failure every week at smaller stakes. Dana is an analytics engineer. Her revenue dashboard runs on seven SEC filing tables behind one naive metric view, and Manufacturing revenue just doubled. The CFO meeting is in an hour. Duplication, a missing source, a concept switch, an ingestion gap and real growth look identical on a chart, and a confident paragraph cannot be re-run. Exhibit A gives her a verdict she can defend: the share of the move that is an artifact, the share that is real, the SQL behind each claim, and a proven, approved fix.

## Quick start (no keys, no GPU)

```bash
npm install
npm run eval      # cold + warm replay, 18/18 claim checks
npm run web       # case viewer: http://127.0.0.1:4173 (ships with a live close and a closed sample)
npm run cli -- investigate "is the FY2018 jump real?" --metric analytics.sector_revenue_by_year
npm run cli -- approve <case_id>
npm run cli -- writeback <case_id>
npm run cli -- rerun <exhibit_id>
npm test && npm run typecheck
```

`SAMPLE_MODE=true` (default) replays the committed cassette: recorded Zetaris tool results built from a committed SEC sample plus **recorded** responses from three NVIDIA Nemotron roles. No Zetaris, NVIDIA key or network is required, and every exhibit is labelled as a replay. `SAMPLE_MODE=false` runs the same investigator against a local Zetaris instance and live NIM.

## What a case looks like

On the committed sample (`fixtures/cases/sample/case_sample_closed`):

| Finding | Exhibit |
|---|---|
| Reported Manufacturing FY2018 is **1.89x** FY2017 (+$1.29T), outside the 0.67–1.5x band | metric history + baseline |
| **322 duplicate rows** across the seven `edgar.*_revenue_table` sources; FY2018 holds 100 rows over 32 distinct period-end dates | duplication + bucket profile |
| The filer whose facts all land in the onset year is **Apple Inc.** (11 `Revenues` facts, $1.21T of the $1.29T jump); the filer whose history stops before the window is **Target Corporation** (last fact FY2014) — both selected from the coverage rows, not named in code | per-company coverage + SEC companyconcept |
| Scout discovers the replacement Apple concept `RevenueFromContractWithCustomerExcludingAssessedTax`: 9 continuous annual 10-K facts through 2025, so the missing history is a concept switch, not a lost source | SEC companyfacts discovery exhibit |
| Counterfactual: one annual value per `(cik, period_end)` removes **96.2%** of the jump, leaving **3.8%** real | counterfactual exhibit |
| Corrected Manufacturing is **1.125x** (+$49.6B), with **12/12** SEC frames parity within 0.5% | corrected series + SEC frames |
| The fastest-growing filer in the segment (**Tesla, Inc.**, 1.74x) is **4.3%** of the jump: eliminated, not blamed | coverage exhibits |
| Shadow verifier passes **7/7** invariants, including rejection of two bad-repair probes | shadow verifier exhibit |
| Operator-approved writeback reaches `CLOSED` with **8/8** readback checks | writeback exhibits |

**Verdict: `MIXED (filing_year_duplication=96.2%, real_change=3.8%)`, gate pass, unexplained 0.0%.**

The investigator walks: H-MEM recall → catalog → describe → `INFER SQLTABLE` lineage → baseline onset → five hypotheses → evidence (coverage, duplication, buckets, canonical facts) → filer selection from the evidence → Scout discovery → SEC second channel → counterfactual → Defense Counsel critique → two-layer content safety → code-gate adjudication → repair plan → signed shadow write → shadow verifier. It writes **23 exhibits**; the close adds the writeback/readback exhibits for **33**.

## A second metric, same code

Generality is demonstrated, not claimed. `analytics.sector_net_income_by_year` sums SEC `NetIncomeLoss` facts the same naive way, from its own fixture (`fixtures/edgar/netincome-facts.json`, `sec-frames-netincome.json`, `ibm-netincome-discovery.json`) and cassette (`fixtures/cassettes/d3-netincome-investigation.json`). The investigator, hypotheses, gate, repair and verifier are unchanged; only the metric spec (`packages/tools/src/metrics.ts`) differs.

```bash
npm run cli -- investigate "is the FY2017 Services net income jump real?" --metric analytics.sector_net_income_by_year
```

| Finding | Exhibit |
|---|---|
| Services FY2017 is **1.97x** FY2016 (+$63.2B), outside the band | metric history + baseline |
| The filer that first appears in the onset period is **IBM** (39 facts, none in FY2016); Scout finds its earlier periods under `ProfitLoss` (16 annual 10-K facts), so the history is a concept switch, not a lost source | coverage + SEC companyfacts |
| The corrected Services series **fell** 0.438x (−$12.0B): the reported jump has no real component; real change is **eliminated** | corrected series + SEC frames 10/10 |
| Oracle, the fastest-growing filer in the segment, is 7.3% of the jump: eliminated | coverage |
| Shadow verifier **7/7** | shadow verifier |

**Verdict: `DATA_ARTIFACT (filing_year_duplication=100.0%)`, gate pass.** The same five hypotheses produce a different suspect, a different discovery relation (prior history rather than a forward replacement) and a different verdict, because the suspects are selected from the coverage rows and the shares come from the counterfactual.

## The viewer

`npm run web` opens a read-only case viewer. It reads cases from `logs/` (your runs) and from the committed `fixtures/cases/` (the recorded live Zetaris close and the generated sample), and shows:

- the **symptom**: reported series against the corrected series, with the onset highlighted and the artifact/real split;
- the **verdict** with cause shares, the gate result and the adjudication notes;
- the **model roles**: H-MEM recall (with embedding similarity on a warm case), Scout discovery, the critic's objections, and both content-safety layers;
- the **hypothesis table** with the filers the evidence selected;
- the **repair** (shadow verifier invariants, corrected SQL) and the **writeback** (signed statements, verify-after-write checks);
- the **lineage graph**, an **exhibit explorer** (SQL, arguments, tabular results, re-run with hash drift detection) and the **agent timeline**.

Approval and writeback stay in the CLI on purpose, so the operator gate cannot be clicked away.

## Live Zetaris verification

The same investigation was run end to end with `SAMPLE_MODE=false` against a local Zetaris 2.4.3.1 instance. The full case log is committed under `fixtures/cases/live/case_797df0a52bd53bc6` (39 exhibits, trace, world model) and is the first case in the viewer:

- Live metric values match the sample: Manufacturing FY2017 **$1,455.9B** → FY2018 **$2,750.9B**.
- `INFER SQLTABLE` resolves the `edgar.*` schema-store views to seven `SEC_DATA.*_revenue_facts` source tables (8 nodes / 7 edges).
- The canonical query returns **1,298 fact rows**; the seven sources hold **936 duplicate rows** across full history; SEC frames parity is **12/12**.
- Live verdict: **`MIXED (filing_year_duplication=96.2%, real_change=3.8%)`**, gate pass.
- The shadow write created `exhibit_a_shadow.sector_revenue_by_year` under a signed contract; the verifier passed **7/7**.
- The operator-approved writeback executed contract `contract_24227e473dae28c8` (7 signed statements). The final `exhibit_a.sector_revenue_by_year_v2` re-read matched the shadow with **0 missing, 0 mismatched, 0 extra**; the `revenue_facts` USL has the `(cik, period_end)` key and the `annual_has_frame` rule; both `RUN DQ` forms return **102 records, 102 valid, 0 invalid**; `LOAD USL` carries the case note; `SHOW DATASOURCE VIEWS` lists the final view; the reported view hash is unchanged. **8/8 checks.**
- Verify-after-write caught two readback issues before close (USL description location, quoted description text); the failed attempt stays in the trace and a narrow re-approval re-executed the idempotent contract.

The live close predates the H-MEM embedding, discovery, critic, safety and viewer additions, which is why its case has no model-role panel. The reported `analytics.sector_revenue_by_year` view is never named in a write statement; the only write scope is `exhibit_a.sector_revenue_by_year_v2` plus the `lightning.metastore.exhibit_a.revenue_facts` USL.

## Where each sponsor technology is used

| Technology | Where it is used |
|---|---|
| **Zetaris** | Every fact query goes through the REST SQL editor (`packages/tools/src/zetaris.ts`) behind a read-only guard that rejects write forms anywhere in a statement. `INFER SQLTABLE SOURCES/COLUMNS` builds the case lineage graph. The repair creates an isolated `exhibit_a_shadow` schema-store view and verifies it. The approved writeback creates `exhibit_a.sector_revenue_by_year_v2`, a `revenue_facts` USL with a composite `(cik, period_end)` key, the `annual_has_frame` DQ rule, and a USL table description as catalog memory; verify-after-write re-reads all of it (`LOAD USL`, `LIST DQ`, both `RUN DQ` forms, `SHOW DATASOURCE VIEWS`) through a separate session. |
| **Meterless** | **H-MEM** (`packages/engines/src/memory.ts`): recall before a case, remember at `CLOSED`, audit, mine; lexical scoring re-scored with Nemotron embeddings. **Markovian** (`packages/engines/src/markovian.ts`): the critic prompt is packed into bounded windows with previous/next keys, and the exact windows are recorded on the critic exhibit. **World Model** (`packages/core/src/world-model.ts`): append-only, idempotent lineage graph; the gate's "located" rule and the adjudication's blamed objects come from it. **Scout Intent** (`packages/core/src/contracts.ts`): HMAC-signed, scoped, expiring write contracts; the writer executes only signed statements. These are original reference implementations of the documented engine contracts, not a vendored Meterless runtime. |
| **NVIDIA Nemotron** | Three roles through the NIM client (`packages/llm`): `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` as the **Defense Counsel** critic (JSON objections, advisory), `nvidia/nemotron-3.5-content-safety` as the **second content-safety layer** over the generated finding, and `nvidia/nemotron-3.5-embed-1b` for **H-MEM semantic recall**. The cassette holds recorded responses for all three (cold and warm); live mode uses `NIM_CRITIC_MODEL`, `NIM_SAFETY_MODEL`, `NIM_EMBED_MODEL`. The critic cannot promote or block a cause; the safety model can only add a block; a missing key degrades each role to a recorded "skipped" status. Spend is metered per case. |
| **SEC EDGAR** | Independent second channel (`packages/tools/src/second-channel.ts`): companyconcept and frames APIs, rate-limited, declared `From` contact. Scout discovery (`packages/tools/src/discovery.ts`) reads companyfacts and requires a continuous annual 10-K chain before proposing a replacement concept. |
| **Cursor** | Implementation in Agent mode; project rules in `.cursor/rules/`. |

## How the verdict is decided

1. `compareToBaseline` finds the largest move outside the anomaly band.
2. Five hypotheses are drafted in code: filing-year duplication, concept switch / missing history, real change, single-filer growth, ingestion gap.
3. Evidence is pulled as rerunnable SQL exhibits. The **filers under suspicion are selected from the coverage rows** (`packages/agents/src/hypotheses.ts`): the filer whose facts all land in the onset year, the filer whose history stops before the prior period, and the fastest-growing filer in the moved segment.
4. The counterfactual (one annual fact per `(cik, period_end)`) splits the reported delta into artifact and real shares.
5. The Defense Counsel critic attacks the causes; its objections are logged with their Markovian context and never change a share.
6. `buildVerdict` applies the gate: located in the lineage graph, quantified by an exhibit, sufficient (counterfactual), corroborated (SEC second channel), timed to the symptom, shares within 90–110%. A failing rule downgrades to `INSUFFICIENT_EVIDENCE`; it never silently drops a cause.
7. Both content-safety layers run over the finding; either can withhold it.

`npm run eval` runs the sample cold, closes it, runs it warm, and runs a deliberate ablation (counterfactual + second channel removed → `INSUFFICIENT_EVIDENCE`). The 18 claim checks are committed in `evals/results/latest.md`, and the JSON is byte-stable across runs.

## Submission assets

- `SUBMISSION.md` — written sponsor explanation.
- `PRE_EXISTING_DECLARATION.md` — declaration of pre-window material.
- `deck/exhibit-a-deck.pdf` (+ editable `.pptx`) and `deck/exhibit-a-demo.mp4`.
- `evals/results/latest.md` — 18/18 claim checks.
- `fixtures/cases/live/` — the recorded live Zetaris close; `fixtures/cases/sample/` — generated with `npm run fixture:cases`.

## Setup

- Node 20+. `SAMPLE_MODE=true` needs nothing else.
- Live mode: copy `.env.example` to `.env.local` (gitignored), set `SAMPLE_MODE=false`, `ZETARIS_REST_URL`, `ZETARIS_API_KEY`, `ZETARIS_ORG_ID`, `ZETARIS_SIC_TABLE`, `EXHIBIT_A_CONTRACT_SECRET`, `SEC_USER_AGENT`, and for the model roles `NVIDIA_API_KEY` plus `NIM_CRITIC_MODEL` / `NIM_SAFETY_MODEL` / `NIM_EMBED_MODEL`.
- Live Zetaris needs the EDGAR tables and the `analytics.sector_revenue_by_year` / `edgar.sic_edgar_usl` schema-store views (onboarding recipe in Zetaris `getting-started`). `npm run cli -- bootstrap-metric` applies the declared metric view as an operator-approved, signed bootstrap write; the repair path never modifies it.
- `npm run record:nim` re-records the three Nemotron roles into the cassette (write-through: only missing requests hit the network). `npm run cassette:d2` rebuilds the tool entries from the committed SEC sample.

Docker (SAMPLE_MODE):

```bash
docker build -f docker/Dockerfile -t exhibit-a:local .
docker run --rm exhibit-a:local
```

## Layout

```
apps/cli/            investigate | approve | writeback | rerun | replay | bootstrap-metric
apps/web/            read-only case viewer with exhibit re-run
packages/core/       exhibits, traces, cassettes, state machine, contracts, gate, world model, safety
packages/tools/      Zetaris client + SQL guard, lineage, baseline, canonical series, repair/verifier,
                     writeback, SEC second channel, discovery, rerun
packages/agents/     investigator, data-driven hypotheses, critic, adjudication, repair/writeback flow
packages/llm/        NIM client (chat + embeddings), spend ledger, content-safety role
packages/engines/    H-MEM (lexical + embedding recall) and Markovian reference implementations
evals/               cold/warm run, ablation, 18 claim checks, committed results
fixtures/cassettes/  labelled SAMPLE_MODE recording incl. six Nemotron responses
fixtures/cases/      live Zetaris close + generated sample cases for the viewer
fixtures/edgar/      SEC companyconcept/frames/companyfacts sample
scripts/             cassette, fixture and NIM recorders
```

## Hygiene

- Secrets stay in `.env.local` (gitignored). The repo contains no keys; the live case log was checked before commit.
- Investigation SQL is read-only and guarded in code. Writes go through an HMAC-signed, scoped, expiring contract; the shadow is isolated, `approve` is a separate operator action, and `writeback` executes only the approved statements and verifies through a separate session.
- `npm test` (69 tests) and `npm run typecheck` pass; `npm run eval` reproduces the committed result file byte for byte.
