import assert from "node:assert/strict";
import { test } from "node:test";
import { checkContentSafety, safeFindingText } from "./safety.ts";

test("the required data-quality disclaimer is allowed", () => {
  const result = checkContentSafety(
    "Data-quality finding on public filings, not investment advice.",
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, "allow");
});

test("the guard blocks trade instructions and analyst ratings", () => {
  for (const text of [
    "You should buy the stock before the next filing.",
    "Our price target is $250.",
    "This is a strong buy.",
    "We guarantee a return of 20%.",
  ]) {
    const result = checkContentSafety(text);
    assert.equal(result.ok, false, text);
    assert.equal(result.action, "block");
    assert.ok(result.findings.length > 0);
  }
});

test("the guard does not confuse ordinary row language with advice", () => {
  const result = checkContentSafety(
    "The table holds 11 facts and 100 rows across 32 period_end dates.",
  );
  assert.equal(result.ok, true);
});

test("safeFindingText withholds unsafe prose and appends the disclaimer", () => {
  const result = safeFindingText("Buy the stock now.");
  assert.equal(result.safety.ok, false);
  assert.match(result.text, /withheld by the content-safety guard/);
  assert.match(result.text, /not investment advice/);
  assert.doesNotMatch(result.text, /Buy the stock now/);
});
