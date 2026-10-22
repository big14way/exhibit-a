import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Json } from "./hash.ts";

test("sha256Json is key-order invariant", () => {
  assert.equal(sha256Json({ b: 1, a: 2 }), sha256Json({ a: 2, b: 1 }));
});
