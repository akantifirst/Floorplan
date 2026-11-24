import assert from "node:assert/strict";
import { test } from "node:test";
import { smoothTrail, TRAIL_FADE_MS, TRAIL_HOLD_MS, trailGeometry, trailOpacity } from "./robot-trail.ts";

const positions = (g: ReturnType<typeof trailGeometry>) => Array.from(g.getAttribute("position").array as ArrayLike<number>);

test("a straight trail of one segment is a quad with round ends, at the given width and height", () => {
  const g = trailGeometry([[[0, 0], [2, 0]]], 0.16, 0.01);
  const p = positions(g);
  assert.equal(p.length / 3, 6 + 2 * 16 * 3, "two triangles and two 16-sided end discs");
  // a float32 buffer, so every comparison here allows for its rounding
  assert.ok(p.filter((_, i) => i % 3 === 1).every((y) => Math.abs(y - 0.01) < 1e-6), "every vertex at the given height");
  const zs = p.filter((_, i) => i % 3 === 2);
  assert.ok(Math.abs(Math.min(...zs) + 0.08) < 1e-3 && Math.abs(Math.max(...zs) - 0.08) < 1e-3, "0.16 m wide");
  const xs = p.filter((_, i) => i % 3 === 0);
  assert.ok(Math.abs(Math.min(...xs) + 0.08) < 1e-6 && Math.abs(Math.max(...xs) - 2.08) < 1e-6, "rounded past both ends");
});

test("a bend gets a round disc, a joint that does not turn does not", () => {
  const straight = positions(trailGeometry([[[0, 0], [1, 0], [2, 0]]], 0.16, 0)).length;
  const bent = trailGeometry([[[0, 0], [1, 0], [1, 1]]], 0.16, 0);
  assert.equal(positions(bent).length, straight + 16 * 9, "a real bend adds the disc that fills the notch");
  const slight = trailGeometry([[[0, 0], [1, 0], [2, 0.01]]], 0.16, 0);
  assert.equal(positions(slight).length, straight, "half a degree is not a notch worth a disc");
});

test("the trail is smoothed: noise below 3 cm is dropped and corners are cut into a curve", () => {
  const [line] = smoothTrail([[[0, 0], [0.01, 0.005], [1, 0], [1, 1]]]);
  assert.deepEqual(line![0], [0, 0], "the start stays");
  assert.deepEqual(line![line!.length - 1], [1, 1], "the end stays");
  assert.ok(!line!.some((p) => p[0] === 0.01), "the 1-cm jitter is gone");
  assert.ok(!line!.some((p) => p[0] === 1 && p[1] === 0), "the sharp corner itself is cut off");
  // every turn along the curve is gentle now, where the raw trail turned by 90° at once
  for (let i = 1; i + 1 < line!.length; i++) {
    const [a, b, c] = [line![i - 1]!, line![i]!, line![i + 1]!];
    const turn = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]));
    assert.ok(turn < Math.PI / 4 + 1e-9, `turn ${(turn * 180) / Math.PI}° at ${i}`);
  }
  assert.deepEqual(smoothTrail([[[0, 0], [1, 0]]]), [[[0, 0], [1, 0]]], "a single step stays as it is");
});

test("a trail of dots leaves nothing to draw", () => {
  assert.equal(positions(trailGeometry([[[0, 0], [0, 0]]], 0.16, 0)).length, 0, "a zero-length step");
  assert.equal(positions(trailGeometry([], 0.16, 0)).length, 0, "no segments at all");
  assert.equal(positions(trailGeometry([[[1, 1]]], 0.16, 0)).length, 0, "one point is no way");
});

test("several segments are drawn one after another", () => {
  const one = positions(trailGeometry([[[0, 0], [1, 0]]], 0.16, 0)).length;
  const two = positions(trailGeometry([[[0, 0], [1, 0]], [[2, 0], [3, 0]]], 0.16, 0)).length;
  assert.equal(two, one * 2);
});

test("the pad stays full for ten minutes after the robot stops, then fades", () => {
  const docked = 1_000_000;
  assert.equal(trailOpacity(null, docked), 1, "still cleaning: full");
  assert.equal(trailOpacity(docked, docked), 1, "just docked");
  assert.equal(trailOpacity(docked, docked + TRAIL_HOLD_MS - 1), 1, "one millisecond before the hold ends");
  assert.equal(trailOpacity(docked, docked + TRAIL_HOLD_MS), 1, "the hold ends where the fade starts");
  const half = trailOpacity(docked, docked + TRAIL_HOLD_MS + TRAIL_FADE_MS / 2);
  assert.ok(Math.abs(half - 0.5) < 1e-9, `halfway through the fade: ${half}`);
  assert.equal(trailOpacity(docked, docked + TRAIL_HOLD_MS + TRAIL_FADE_MS), 0, "gone at the end");
  assert.equal(trailOpacity(docked, docked + 10 * TRAIL_HOLD_MS), 0, "and stays gone");
});
