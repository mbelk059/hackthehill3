import assert from "node:assert/strict";
import test from "node:test";
import { createMoodDebouncer, takeSentences } from "./session-logic.mjs";

test("sentence splitter keeps a partial sentence until flush", () => {
  const first = takeSentences("", "Look at the loop", false);
  assert.deepEqual(first.sentences, []);
  assert.equal(first.buffer, "Look at the loop");

  const second = takeSentences(first.buffer, ". What changes each pass? Done", false);
  assert.deepEqual(second.sentences, ["Look at the loop.", "What changes each pass?"]);
  assert.equal(second.buffer, "Done");

  const third = takeSentences(second.buffer, "", true);
  assert.deepEqual(third.sentences, ["Done"]);
  assert.equal(third.buffer, "");
});

test("mood waits 8s to get strict and 5s to calm back down", () => {
  const mood = createMoodDebouncer();
  assert.equal(mood.push("distracted", 0).changed, false);
  assert.equal(mood.push("distracted", 7999).mood, "calm");
  assert.equal(mood.push("distracted", 8000).changed, true);
  assert.equal(mood.mood, "strict");

  assert.equal(mood.push("focused", 8000).changed, false);
  assert.equal(mood.push("distracted", 9000).mood, "strict");
  assert.equal(mood.push("focused", 9000).changed, false);
  assert.equal(mood.push("focused", 14000).changed, true);
  assert.equal(mood.mood, "calm");
});
