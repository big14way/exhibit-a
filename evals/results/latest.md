# Exhibit A claim checks

Generated from the committed SAMPLE_MODE cassette. 20/20 claims pass.

| claim | result | evidence |
| --- | --- | --- |
| SAMPLE_MODE is labelled replay, not live inference | PASS | 23 exhibits; transport values code, cassette |
| The FY2018 sample verdict is MIXED with two causes | PASS | MIXED; 2 causes |
| Artifact share is 96.168% and real share is 3.832% | PASS | artifact 96.168%, real 3.832%, unexplained 0.000% |
| The deterministic gate passes without failures | PASS | 0 failures |
| Shadow repair passes 7/7 invariants and 12/12 second-channel cells | PASS | 7/7; parity 12/12 |
| The sample writeback reaches CLOSED with 8/8 readback checks | PASS | CLOSED; 8/8 checks |
| No write statement names the reported analytics view | PASS | no statement names the reported view |
| H-MEM starts cold and recalls the closed case on the warm run | PASS | cold 0 hit(s); warm 1 hit(s); recalled case_eval_cold |
| The closed case is written to the H-MEM index and audits cleanly | PASS | record case_eval_cold; 1 valid, 0 malformed |
| Scout discovers the replacement Apple revenue concept from SEC companyfacts | PASS | Revenues -> RevenueFromContractWithCustomerExcludingAssessedTax; 3 candidates |
| The recorded Nemotron critic runs in replay with grounded objections on both the cold and warm case | PASS | cold ran, 3 objections (1 citing an unknown exhibit, flagged), 2657 prompt tokens; warm ran, 5 objections |
| The critic exhibit records the exact Markovian windows that built the prompt | PASS | 1 window(s), 1606 chars, 12 items |
| The content-safety guard passes generated finding prose | PASS | cold true; warm true |
| The recorded Nemotron content-safety model labels the finding safe as a second layer | PASS | cold ran (nvidia/nemotron-3.5-content-safety: user safe, response safe); warm ran |
| The warm H-MEM recall is re-scored with recorded Nemotron embeddings | PASS | cold skipped; warm ran (nvidia/nemotron-3.5-embed-1b, 2048 dims, similarity 0.7224) |
| Hypothesis subjects are selected from the coverage rows, not named in code | PASS | concept_switch_missing_history: Apple Inc. (first appears in onset period); Target Corporation (history stops) | single_filer_growth: Tesla, Inc. (fastest-growing filer in segment) | ingestion_gap: Apple Inc. (largest contributor to the delta) |
| Removing the counterfactual/second channel downgrades the verdict | PASS | INSUFFICIENT_EVIDENCE; 2 gate failures |
| A second metric (sector net income, NetIncomeLoss) is adjudicated by the same code with a different verdict | PASS | DATA_ARTIFACT; 7/7 invariants; stage SHADOW_VERIFIED |
| The second metric selects a different newcomer (IBM) and eliminates real change because the corrected series fell | PASS | newcomer International Business Machines Corporation; real_change eliminated; discovery ProfitLoss (prior_history); critic ran; safety model ran |
| The sample investigation and close have the expected exhibit counts | PASS | 23 investigate; 33 close |
