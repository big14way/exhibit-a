# Pre-existing work declaration

**Event:** Exhibit A submission, deadline 2026-10-27 23:45 UTC
**Repository:** this repository
**Declaration date:** 2026-10-23

This declaration lists work that existed before the event build window or that was not written as Exhibit A application code. It is intentionally conservative: if a reviewer would reasonably ask whether something was pre-existing, it is listed here.

## Event-window code

All Exhibit A application code in this repository was written and committed on or after **2026-10-22 00:00 UTC**. The first commit is `81ce63a` at 2026-10-22 08:09 UTC (`2026-10-22 09:09 +0100`). The implementation commits, tests, fixtures, evals, viewer, Docker packaging, and documentation are part of the event build.

No Exhibit A source file was copied from a pre-existing product or another team's repository. The monorepo, Zetaris tool layer, SQL guard, exhibit/trace store, investigator, hypothesis rules, counterfactual, gate, signed repair contract, shadow verifier, writeback, H-MEM/Markovian reference implementations, critic, safety guard, discovery tool, viewer, and evals were written for this submission.

## Pre-existing planning material

- `EXHIBIT_A_BLUEPRINT.md` is a private planning/research document dated **2026-10-21**. It is intentionally gitignored and is **not** part of the submitted repository. It contains product notes, judging criteria, and a research plan. No application code was generated from it before the event window.
- Public hackathon rules, FAQs, sponsor documentation, Zetaris documentation, Meterless engine contract descriptions, NVIDIA NIM documentation, and SEC EDGAR API documentation were read before and during the event. These are public references, not copied source code.

## Pre-existing environment and onboarding

- A local Zetaris Docker stack was already installed and running before the event window for environment familiarization. Onboarding/recipe SQL supplied by Zetaris may have been run against that local instance before the window. No Exhibit A application code, schema, view, contract, or submission asset existed at that point.
- The local machine already had Node.js, Docker, Python, and standard developer tooling installed.
- An NVIDIA API key and access to the NVIDIA NIM endpoint were already available. No model output was pre-recorded before the window; the committed critic response was recorded during the event and is stored in `fixtures/cassettes/d2-edgar-investigation.json`.

## Third-party code and data

- Runtime and development dependencies are installed from `package-lock.json` (npm). They are third-party open-source packages under their own licenses; they are not claimed as original work.
- **No Meterless runtime or engine source code is vendored.** `packages/engines/src/memory.ts` (H-MEM), `packages/engines/src/markovian.ts` (Markovian bounded context), `packages/core/src/world-model.ts` (World Model lineage graph), and `packages/core/src/contracts.ts` (Scout Intent signed contracts) are original reference implementations of the documented engine contracts, written during the event.
- SEC companyconcept, companyfacts, and frames data in `fixtures/edgar/` is public-domain U.S. government filing data retrieved during the event. The SEC API terms and declared User-Agent/contact are respected.
- The committed `fixtures/cassettes/d2-edgar-investigation.json` is a labelled SAMPLE_MODE recording produced during the event. It includes tool results and one recorded NVIDIA Nemotron critic response. It is not live inference and is labelled as replay in the README, CLI, exhibits, viewer, and evals.

## AI-assisted development

- Cursor Agent mode was the development environment. Cursor was used for implementation, refactoring, debugging, tests, and documentation.
- NVIDIA Nemotron is used at runtime as an advisory critic in live mode and as the recorded critic replay in SAMPLE_MODE. It does not decide the verdict.
- No generated application code was imported from a separate pre-existing project. AI assistance produced code inside this repository during the event window.

## What is not claimed

- This is not investment advice. Outputs are data-quality findings on public filings.
- SAMPLE_MODE is not live inference. It is a deterministic replay of committed cassette entries.
- The local H-MEM, Markovian, World Model, and Scout Intent implementations are not a hosted Meterless deployment. They implement the same contracts locally so the product is runnable and testable in a clean clone.
- The recorded live close predates the Day-5 H-MEM/discovery/critic/safety/viewer additions. The current sample path is the reproducible path; the live close is evidence from the live Zetaris instance at the time it was run.

## Signature

Name: ______________________
Date: ______________________
