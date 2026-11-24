// The way an avatar walks through a flat: a grid of 10 cm cells over the rooms, where walls (but not their doors and
// open edges) and the furniture standing on the floor block the way. Pure logic, no three.js, so it is tested on its own.

import { pointInPolygon, type Vec2 } from "../model.ts";

export interface NavRoom {
  points: Vec2[];
  /** Wall height per edge as in the plan: 0 = no wall on that edge (an open passage to the next room); a list = per piece. */
  wallHeights?: (number | null | undefined | (number | null)[])[];
}

export interface NavInput {
  rooms: NavRoom[];
  /** Door spans (both ends on a room edge or a free wall): the wall is open there. */
  doors: [Vec2, Vec2][];
  /** Free-standing walls. */
  walls: [Vec2, Vec2][];
  /** Footprints of the furniture standing on the floor. */
  obstacles: Vec2[][];
}

const distToSegment = (p: Vec2, a: Vec2, b: Vec2): number => {
  const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
  const l2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t);
};

/** The parts of the segment a–b that no cutter lying on it (a door, an open edge of the next room) covers. */
export function cutSegment(a: Vec2, b: Vec2, cutters: [Vec2, Vec2][], tolerance = 0.08): [Vec2, Vec2][] {
  const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return [];
  const along = (p: Vec2) => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len;
  const off = (p: Vec2) => Math.abs((p[0] - a[0]) * dz - (p[1] - a[1]) * dx) / len;
  const gaps: [number, number][] = [];
  for (const [c0, c1] of cutters) {
    if (off(c0) > tolerance || off(c1) > tolerance) continue;
    const [t0, t1] = [along(c0), along(c1)].sort((x, y) => x - y);
    if (t1 <= 0 || t0 >= len) continue;
    gaps.push([Math.max(0, t0), Math.min(len, t1)]);
  }
  gaps.sort((x, y) => x[0] - y[0]);
  const out: [Vec2, Vec2][] = [];
  const at = (t: number): Vec2 => [a[0] + (dx * t) / len, a[1] + (dz * t) / len];
  let from = 0;
  for (const [g0, g1] of gaps) {
    if (g0 > from + 1e-3) out.push([at(from), at(g0)]);
    from = Math.max(from, g1);
  }
  if (from < len - 1e-3) out.push([at(from), at(len)]);
  return out;
}

/** Every piece of wall that blocks the way: room edges without their open edges and doors, and the free walls. */
export function blockingWalls(input: NavInput): [Vec2, Vec2][] {
  const open: [Vec2, Vec2][] = [...input.doors];
  for (const r of input.rooms)
    r.points.forEach((p, i) => {
      if (r.wallHeights?.[i] === 0) open.push([p, r.points[(i + 1) % r.points.length]]);
    });
  const out: [Vec2, Vec2][] = [];
  for (const r of input.rooms)
    r.points.forEach((p, i) => {
      if (r.wallHeights?.[i] === 0) return;
      out.push(...cutSegment(p, r.points[(i + 1) % r.points.length], open));
    });
  for (const [a, b] of input.walls) out.push(...cutSegment(a, b, input.doors));
  return out;
}

export class NavGrid {
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  readonly cell: number;
  private free: Uint8Array;

  constructor(input: NavInput, cell = 0.1, wallMargin = 0.2, furnitureMargin = 0.12) {
    this.cell = cell;
    const pts = input.rooms.flatMap((r) => r.points);
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    this.x0 = Math.min(...xs, 0) - cell;
    this.z0 = Math.min(...zs, 0) - cell;
    this.nx = Math.max(1, Math.ceil((Math.max(...xs, 1) + cell - this.x0) / cell));
    this.nz = Math.max(1, Math.ceil((Math.max(...zs, 1) + cell - this.z0) / cell));
    this.free = new Uint8Array(this.nx * this.nz);
    const walls = blockingWalls(input);
    const near = (p: Vec2, poly: Vec2[], m: number) => pointInPolygon(p, poly) || poly.some((q, i) => distToSegment(p, q, poly[(i + 1) % poly.length]) < m);
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        const p = this.center(i, j);
        if (!input.rooms.some((r) => r.points.length >= 3 && pointInPolygon(p, r.points))) continue;
        if (walls.some(([a, b]) => distToSegment(p, a, b) < wallMargin)) continue;
        if (input.obstacles.some((o) => o.length >= 3 && near(p, o, furnitureMargin))) continue;
        this.free[j * this.nx + i] = 1;
      }
  }

  center(i: number, j: number): Vec2 {
    return [this.x0 + (i + 0.5) * this.cell, this.z0 + (j + 0.5) * this.cell];
  }

  private index(p: Vec2): [number, number] {
    return [Math.floor((p[0] - this.x0) / this.cell), Math.floor((p[1] - this.z0) / this.cell)];
  }

  isFree(p: Vec2): boolean {
    const [i, j] = this.index(p);
    return i >= 0 && j >= 0 && i < this.nx && j < this.nz && this.free[j * this.nx + i] === 1;
  }

  /** The free cell nearest to p (within 1.5 m), or null. */
  nearestFree(p: Vec2): [number, number] | null {
    const [ci, cj] = this.index(p);
    const reach = Math.ceil(1.5 / this.cell);
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let j = cj - reach; j <= cj + reach; j++)
      for (let i = ci - reach; i <= ci + reach; i++) {
        if (i < 0 || j < 0 || i >= this.nx || j >= this.nz || !this.free[j * this.nx + i]) continue;
        const c = this.center(i, j);
        const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
        if (d < bestD) [best, bestD] = [[i, j], d];
      }
    return best;
  }

  /** A straight walk from a to b stays on free cells. */
  lineFree(a: Vec2, b: Vec2): boolean {
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (this.cell / 2)));
    for (let s = 0; s <= steps; s++) if (!this.isFree([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps])) return false;
    return true;
  }

  /**
   * The way from a to b: corner points to walk along, from a to b (both included). The ends may stand inside furniture
   * (a chair under the desk, the bed): the walk leaves and reaches them straight from the nearest free cell.
   * Null when there is no way (b in a closed room).
   */
  path(a: Vec2, b: Vec2): Vec2[] | null {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.05) return [a, b];
    const s = this.nearestFree(a);
    const g = this.nearestFree(b);
    if (!s || !g) return null;
    const { nx, nz } = this;
    const start = s[1] * nx + s[0];
    const goal = g[1] * nx + g[0];
    const cost = new Float64Array(nx * nz).fill(Infinity);
    const from = new Int32Array(nx * nz).fill(-1);
    const done = new Uint8Array(nx * nz);
    const h = (k: number) => Math.hypot((k % nx) - g[0], Math.floor(k / nx) - g[1]);
    // a small binary heap of [priority, cell]
    const heap: [number, number][] = [];
    const push = (e: [number, number]) => {
      heap.push(e);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const [l, r] = [2 * i + 1, 2 * i + 2];
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    cost[start] = 0;
    push([h(start), start]);
    while (heap.length) {
      const [, k] = pop();
      if (done[k]) continue;
      done[k] = 1;
      if (k === goal) break;
      const [i, j] = [k % nx, Math.floor(k / nx)];
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const [ni, nj] = [i + di, j + dj];
          if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
          const n = nj * nx + ni;
          if (!this.free[n] || done[n]) continue;
          // no cutting round a blocked corner
          if (di && dj && (!this.free[j * nx + ni] || !this.free[nj * nx + i])) continue;
          const c = cost[k] + (di && dj ? Math.SQRT2 : 1);
          if (c < cost[n]) {
            cost[n] = c;
            from[n] = k;
            push([c + h(n), n]);
          }
        }
    }
    if (!done[goal]) return null;
    const cells: Vec2[] = [];
    for (let k = goal; k !== -1; k = from[k]) cells.push(this.center(k % nx, Math.floor(k / nx)));
    cells.reverse();
    // pull the string: keep only the corners a straight walk cannot skip
    const corners: Vec2[] = [cells[0]];
    let i = 0;
    while (i < cells.length - 1) {
      let j = cells.length - 1;
      while (j > i + 1 && !this.lineFree(cells[i], cells[j])) j--;
      corners.push(cells[j]);
      i = j;
    }
    const out: Vec2[] = [a];
    // the ends: skip the snapped cell when a straight walk from a (or to b) is free anyway
    const inner = corners.slice();
    while (inner.length > 1 && this.isFree(a) && this.lineFree(a, inner[1])) inner.shift();
    while (inner.length > 1 && this.isFree(b) && this.lineFree(inner[inner.length - 2], b)) inner.pop();
    for (const c of inner) if (Math.hypot(c[0] - out[out.length - 1][0], c[1] - out[out.length - 1][1]) > 0.02) out.push(c);
    if (Math.hypot(b[0] - out[out.length - 1][0], b[1] - out[out.length - 1][1]) > 0.02) out.push(b);
    else out[out.length - 1] = b;
    return out;
  }
}

/** Length of a walk along the corner points. */
export function pathLength(path: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < path.length; i++) l += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return l;
}

/** The point and heading reached after walking `dist` metres along the path (heading as atan2(dx, dz)). */
export function alongPath(path: Vec2[], dist: number): { pos: Vec2; heading: number; done: boolean } {
  let left = dist;
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    const heading = Math.atan2(b[0] - a[0], b[1] - a[1]);
    if (left <= l) return { pos: [a[0] + ((b[0] - a[0]) * left) / l, a[1] + ((b[1] - a[1]) * left) / l], heading, done: false };
    left -= l;
  }
  const last = path[path.length - 1];
  const prev = path.length > 1 ? path[path.length - 2] : last;
  return { pos: [last[0], last[1]], heading: Math.atan2(last[0] - prev[0], last[1] - prev[1]), done: true };
}

export interface AvatarSpotInfo {
  id: string;
  floorId: string;
  /** States of the activity sensor that send the avatar here. */
  states: string[];
  pose: string;
}

/**
 * The spot for a state of the activity sensor: the one that lists it; several listing it (idle corners) are taken in turn
 * with `pick`. The current spot is kept while it still fits, so a state that only changes its name does not make it walk.
 */
export function spotFor<T extends AvatarSpotInfo>(spots: T[], state: string | null, current: T | null, pick: number): T | null {
  if (!state) return null;
  const s = state.trim().toLowerCase();
  const fitting = spots.filter((p) => p.states.includes(s));
  if (!fitting.length) return null;
  if (current && fitting.includes(current)) return current;
  return fitting[Math.abs(Math.floor(pick)) % fitting.length];
}

/** The states a spot lists ("desk_sit_69, desk_sit_80" -> two names). */
export const spotStates = (text: string): string[] =>
  text
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

interface PlanFloor {
  rooms: { id: string; points: Vec2[]; wall_heights?: (number | null | (number | null)[])[] | null }[];
  openings: { room_id: string; edge: number; offset: number; wall?: string | null; width: number; type: string }[];
  walls?: { id: string; a: Vec2; b: Vec2; height?: number | null }[] | null;
}

/** What a floor of the plan gives the walk: its rooms with their open edges, the doors and the free walls. */
export function navFromFloor(floor: PlanFloor, obstacles: Vec2[][]): NavInput {
  const doors: [Vec2, Vec2][] = [];
  for (const o of floor.openings) {
    if (o.type === "window") continue;
    let a: Vec2 | undefined;
    let b: Vec2 | undefined;
    if (o.wall) {
      const w = floor.walls?.find((x) => x.id === o.wall);
      if (w) [a, b] = [w.a, w.b];
    } else {
      const r = floor.rooms.find((x) => x.id === o.room_id);
      if (r && r.points.length >= 3) [a, b] = [r.points[o.edge % r.points.length], r.points[(o.edge + 1) % r.points.length]];
    }
    if (!a || !b) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const [ux, uz] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const [t0, t1] = [o.offset - o.width / 2, o.offset + o.width / 2];
    doors.push([
      [a[0] + ux * t0, a[1] + uz * t0],
      [a[0] + ux * t1, a[1] + uz * t1],
    ]);
  }
  return {
    rooms: floor.rooms.filter((r) => r.points.length >= 3).map((r) => ({ points: r.points, wallHeights: r.wall_heights ?? undefined })),
    doors,
    walls: (floor.walls ?? []).filter((w) => w.height !== 0).map((w) => [w.a, w.b] as [Vec2, Vec2]),
    obstacles,
  };
}
