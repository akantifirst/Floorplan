import assert from "node:assert/strict";
import { test } from "node:test";
import type { Vec2 } from "../model.ts";
import { alongPath, blockingWalls, cutSegment, NavGrid, pathLength, spotFor, spotStates } from "./avatar-nav.ts";

// two rooms side by side (4 × 3 m each), a 0.9 m door in the middle of the shared wall
const left: Vec2[] = [[0, 0], [4, 0], [4, 3], [0, 3]];
const right: Vec2[] = [[4, 0], [8, 0], [8, 3], [4, 3]];
const door: [Vec2, Vec2] = [[4, 1.05], [4, 1.95]];

test("a door cuts its span out of the wall", () => {
  const parts = cutSegment([4, 0], [4, 3], [door]);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0][1], [4, 1.05]);
  assert.deepEqual(parts[1][0], [4, 1.95]);
});

test("an edge without a wall on either side leaves no wall", () => {
  const walls = blockingWalls({ rooms: [{ points: left, wallHeights: [null, 0, null, null] }, { points: right }], doors: [], walls: [], obstacles: [] });
  // the shared edge x = 4 is open from the left room's side, so the right room's edge there is cut away as well
  assert.ok(!walls.some(([a, b]) => a[0] === 4 && b[0] === 4 && Math.abs(a[1] - b[1]) > 0.01));
});

test("the walk goes through the door", () => {
  const nav = new NavGrid({ rooms: [{ points: left }, { points: right }], doors: [door], walls: [], obstacles: [] });
  const path = nav.path([1, 0.5], [7, 0.5]);
  assert.ok(path);
  assert.deepEqual(path[0], [1, 0.5]);
  assert.deepEqual(path[path.length - 1], [7, 0.5]);
  // somewhere it crosses x = 4 inside the door
  const crossing = path.some((p, i) => {
    if (i === 0 || (path[i - 1][0] - 4) * (p[0] - 4) > 0) return false;
    const q = path[i - 1];
    const z = q[1] + ((p[1] - q[1]) * (4 - q[0])) / (p[0] - q[0] || 1e-9);
    return z > 1.05 && z < 1.95;
  });
  assert.ok(crossing, JSON.stringify(path));
});

test("no door, no way", () => {
  const nav = new NavGrid({ rooms: [{ points: left }, { points: right }], doors: [], walls: [], obstacles: [] });
  assert.equal(nav.path([1, 0.5], [7, 0.5]), null);
});

test("the walk goes round furniture but reaches a chair inside it", () => {
  const table: Vec2[] = [[1.5, 0.8], [2.5, 0.8], [2.5, 2.2], [1.5, 2.2]];
  const nav = new NavGrid({ rooms: [{ points: left }], doors: [], walls: [], obstacles: [table] });
  const path = nav.path([0.6, 1.5], [3.4, 1.5]);
  assert.ok(path && path.length > 2);
  for (let i = 1; i < path.length; i++) {
    const mid: Vec2 = [(path[i][0] + path[i - 1][0]) / 2, (path[i][1] + path[i - 1][1]) / 2];
    assert.ok(!(mid[0] > 1.5 && mid[0] < 2.5 && mid[1] > 0.8 && mid[1] < 2.2));
  }
  const toChair = nav.path([0.6, 0.4], [2, 2.0]);
  assert.ok(toChair);
  assert.deepEqual(toChair[toChair.length - 1], [2, 2.0]);
});

test("walking along a path", () => {
  const path: Vec2[] = [[0, 0], [0, 2], [3, 2]];
  assert.equal(pathLength(path), 5);
  const mid = alongPath(path, 3);
  assert.deepEqual(mid.pos, [1, 2]);
  assert.ok(Math.abs(mid.heading - Math.PI / 2) < 1e-9);
  assert.equal(alongPath(path, 9).done, true);
});

test("spots by state", () => {
  const spots = [
    { id: "a", floorId: "f", states: spotStates("desk_sit_69, desk_sit_80"), pose: "sit_type" },
    { id: "b", floorId: "f", states: spotStates("idle"), pose: "idle" },
    { id: "c", floorId: "f", states: spotStates("idle"), pose: "idle" },
  ];
  assert.equal(spotFor(spots, "DESK_SIT_80", null, 0)?.id, "a");
  assert.equal(spotFor(spots, "away", null, 0), null);
  assert.equal(spotFor(spots, "idle", null, 3)?.id, "c");
  assert.equal(spotFor(spots, "idle", spots[1], 3)?.id, "b");
});
