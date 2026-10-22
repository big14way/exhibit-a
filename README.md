# Exhibit A

A number in a dashboard moved, and someone asks **is this real?**

Exhibit A finds the fragmented sources behind that number, puts every possible explanation on trial, and returns one of:

- **data artifact** — duplication, a missing source, a concept/unit/schema change, or an ingestion gap
- **real change**
- **mixed**, with each cause's share
- **insufficient evidence**

Every claim carries an *exhibit*: the exact SQL that ran, its result hash, and a one-command re-run. Code, not the model, decides whether the evidence is enough.

Findings are **data-quality results on public filings**, not investment advice.

## Track

Primary track: **Solving Fragmented Intelligence**. The agent infers which federated tables and columns a metric is built from, finds an independent second source, and resolves the same entity across sources.

## Quick start (no keys)

```bash
pnpm install
SAMPLE_MODE=true pnpm exhibit-a investigate "is the FY2019 jump real?" --metric analytics.sector_revenue_by_year
```

Or:

```bash
SAMPLE_MODE=true docker compose -f docker/compose.yaml up --build
```

`SAMPLE_MODE=true` replays a recorded run. The CLI prints a replay banner. This is not live inference.

Re-run any exhibit:

```bash
SAMPLE_MODE=true pnpm exhibit-a rerun ex_<id>
```

Replay a captured trace:

```bash
SAMPLE_MODE=true pnpm exhibit-a replay <case_id>
```

## Live mode (Zetaris + NVIDIA)

Copy `.env.example` to `.env.local`, set keys, then run the same commands without `SAMPLE_MODE`.

- Zetaris REST: `POST $ZETARIS_REST_URL/sql-editor/sqls/run` (one statement per call, no trailing semicolon, qualified names).
- User-Agent values must include a contact email or URL.

Apply the declared analyst fixture (naive sector revenue view) only against a Zetaris workspace you control:

```bash
pnpm exhibit-a bootstrap-metric
```

## Where each sponsor technology is used

| Technology | Where it is used |
|---|---|
| **Zetaris federated SQL** | Every fact query (`catalog_search`, `describe`, `run_sql`, `profile`, `metric_history`) goes through the sql-editor REST API. |
| **Zetaris lineage inference** | `INFER SQLTABLE SOURCES/COLUMNS` builds column-level lineage for a metric view (investigator loop). |
| **Zetaris USL** | `LOAD USL` / `LIST DQ` / `RUN DQ` for keys and duplicate detection; catalog `UPDATE USL … SET DESCRIPTION` as case memory after approval. |
| **Zetaris schemastore views** | Shadow and corrected views. The original analyst view is never overwritten. |
| **Meterless World Model** | Lineage and entity graph with bitemporal edges (concept superseded-by). |
| **Meterless H-MEM** | Case memory: recall before investigating, mine lessons on close, trust-ledger audit. |
| **Meterless Markovian** | Bounded-context chunks for long investigations. |
| **Meterless Scout Intent** | Minimal Sense → Guard → Route → signed execution contract. The writer refuses unsigned writes. |
| **NVIDIA Nemotron** | Super 120B: lead + repair. Ultra 550B: critic. Lightning: scout/scribe. Embed: catalog/concept discovery. Content Safety: user report and untrusted REST text. |
| **Cursor** | All implementation in Cursor Agent mode, with committed `.cursor/rules`. |

## CLI

```
exhibit-a investigate "<report>" --metric <view>
exhibit-a rerun <exhibit_id>
exhibit-a replay <case_id>
exhibit-a bootstrap-metric
exhibit-a eval
```

## Layout

```
apps/cli/            CLI
apps/web/            case viewer (later)
packages/core/       models, state machine, evidence gates, exhibits, traces, cassettes
packages/tools/      Zetaris client, SQL guard, SEC / company_dns clients
packages/agents/     lead, scout, critic, repair, scribe
packages/llm/        NIM + budget
packages/engines/    Meterless engine integrations
analytics/           declared naive metric view (the fixture under investigation)
evals/               scenarios graded from state JSON and traces
fixtures/cassettes/  recorded live runs for SAMPLE_MODE
```

## Development

Requires Node 20+. Install with `pnpm install`. Secrets stay in `.env.local` (gitignored).
