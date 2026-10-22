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

## Status (Day 1)

Working now, with `SAMPLE_MODE=true` (default):

```bash
npm install
npm run cli -- investigate "is the FY2018 jump real?" --metric analytics.sector_revenue_by_year
npm run cli -- rerun <exhibit_id>
npm run cli -- replay <case_id>
```

This prints a metric series and five exhibits (catalog, describe, SQL, profile, history). `rerun` re-executes stored SQL and diffs the result hash.

Live Zetaris + NVIDIA loops, lineage, evidence gates, writeback, memory, evals, and the case viewer land on later days.

The Day 1 cassette is a **labelled** replay of the same tool path. Replace it after the first live Zetaris recording. It is not a hardcoded verdict.

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
docker compose -f docker/compose.yml up
```

## Where each sponsor technology is used

| Technology | Where it is used |
|---|---|
| **Zetaris** | All fact queries go through the REST SQL editor (`packages/tools`). Lineage inference, USL keys/DQ, schemastore views, and writeback are Day 2–4. The naive metric fixture is `analytics/sector_revenue_by_year.sql`. |
| **Meterless** | World Model (lineage graph), H-MEM (case memory), Markovian (bounded context), Scout Intent (signed write contracts). Scaffolded under `packages/engines`. |
| **NVIDIA Nemotron** | Lead/repair, critic, scout/scribe, embeddings, content-safety guard. Client lands with the investigator loop. |
| **Cursor** | All implementation in Agent mode. Project rules live in `.cursor/rules/`. |

## Layout

```
apps/cli/            investigate | rerun | replay
apps/web/            case viewer (Day 5)
packages/core/       exhibits, traces, cassettes, state machine
packages/tools/      Zetaris client + SQL guard + D1 tools
packages/agents/     multi-agent loop (later)
packages/llm/        NIM + budget (later)
packages/engines/    Meterless engines (later)
analytics/           declared metric-view SQL
fixtures/cassettes/  labelled SAMPLE_MODE recordings
evals/
```

## Hygiene

- Secrets stay in `.env.local`
- `EXHIBIT_A_BLUEPRINT.md` is private planning notes and is gitignored
- Investigation SQL is read-only unless a signed, approved write contract exists
