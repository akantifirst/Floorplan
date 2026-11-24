import assert from "node:assert/strict";
import { test } from "node:test";
import { sleepTurnAt } from "./avatar.ts";

const deg = (t: number) => Math.round((sleepTurnAt(t).roll * 180) / Math.PI);

test("asleep it turns over every 20 s: back, left side, back, right side, back …", () => {
  assert.deepEqual([10, 30, 50, 70, 90, 110].map(deg), [0, 95, 0, -95, 0, 95]);
});

test("a turn takes about 3 s and only then needs frames; at rest it says when the next one starts", () => {
  assert.equal(sleepTurnAt(10).turning, false);
  assert.equal(sleepTurnAt(10).next, 10);
  const mid = deg(21.5);
  assert.ok(mid > 0 && mid < 95, String(mid));
  assert.equal(sleepTurnAt(21.5).turning, true);
  assert.equal(sleepTurnAt(24).turning, false);
  assert.equal(deg(23.2), 95);
});
