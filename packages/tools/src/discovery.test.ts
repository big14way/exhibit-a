import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDiscoveryResult } from "./discovery.ts";
import type { CompanyFacts } from "./second-channel.ts";

function fact(start: string, end: string, value: number, form = "10-K") {
  return { start, end, val: value, form, filed: end, fy: Number(end.slice(0, 4)), fp: "FY" };
}

const facts: CompanyFacts = {
  cik: "0000320193",
  entityName: "Apple Inc.",
  source_url: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
  facts: {
    "us-gaap": {
      Revenues: {
        label: "Revenues",
        units: {
          USD: [
            fact("2015-09-27", "2016-09-24", 100),
            fact("2016-09-25", "2017-09-30", 110),
            fact("2017-10-01", "2018-09-29", 120),
          ],
        },
      },
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        label: "Revenue from Contract with Customer, Excluding Assessed Tax",
        units: {
          USD: [
            fact("2016-09-25", "2017-09-30", 110),
            fact("2017-10-01", "2018-09-29", 120),
            fact("2018-09-30", "2019-09-28", 130),
            fact("2019-09-29", "2020-09-26", 140),
            fact("2020-09-27", "2021-09-25", 150),
          ],
        },
      },
      ContractWithCustomerLiabilityRevenueRecognized: {
        label: "Contract with Customer, Liability, Revenue Recognized",
        units: {
          USD: [
            fact("2017-10-01", "2018-09-29", 5),
            fact("2018-09-30", "2019-09-28", 6),
            fact("2019-09-29", "2020-09-26", 7),
          ],
        },
      },
    },
  },
};

test("source discovery prefers a continuous revenue concept over a liability concept", () => {
  const result = buildDiscoveryResult(facts, {
    cik: "0000320193",
    entity_name: "Apple Inc.",
    concept: "Revenues",
    sic_division: "Manufacturing",
  });
  assert.equal(result.current_annual_facts, 3);
  assert.equal(
    result.replacement_concept,
    "RevenueFromContractWithCustomerExcludingAssessedTax",
  );
  assert.match(result.replacement_reason, /continuous chain/);
  assert.ok(
    result.candidates.every(
      (candidate) => !candidate.concept.includes("Liability"),
    ),
  );
  assert.ok(result.peers.length > 0);
  assert.ok(result.peers.every((peer) => peer.sic_division === "Manufacturing"));
});

test("source discovery returns no replacement when the current chain is longest", () => {
  const onlyCurrent: CompanyFacts = {
    ...facts,
    facts: {
      "us-gaap": {
        Revenues: facts.facts["us-gaap"]!.Revenues!,
      },
    },
  };
  const result = buildDiscoveryResult(onlyCurrent, {
    cik: "0000320193",
    entity_name: "Apple Inc.",
    concept: "Revenues",
    sic_division: "Manufacturing",
  });
  assert.equal(result.replacement_concept, null);
});
