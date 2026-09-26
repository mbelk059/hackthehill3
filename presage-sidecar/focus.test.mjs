import assert from "node:assert/strict";
import test from "node:test";
import { interpretValidation } from "./focus.mjs";

test("a centered face is focused and looking away is distracted", () => {
  assert.equal(interpretValidation(0).state, "focused");
  assert.equal(interpretValidation(17).state, "focused");
  assert.equal(interpretValidation(5).state, "focused");
  assert.equal(interpretValidation(1).state, "distracted");
  assert.equal(interpretValidation(99).state, null);
});
