/**
 * The pad a robot has driven on, drawn flat on the floor: a ribbon along its trail, with a disc at every
 * bend so the turns do not fray. The robot's own app draws the same thing, and it is what makes "where has
 * it been" readable in the plan rather than a hairline.
 */
import { BufferGeometry, Float32BufferAttribute } from "three";
import type { Vec2 } from "../model.ts";

/** How long the pad stays after the robot stopped cleaning: ten minutes, then it fades. */
export const TRAIL_HOLD_MS = 10 * 60 * 1000;
/** How long the fade itself takes. */
export const TRAIL_FADE_MS = 3000;

/**
 * How strongly the pad still shows, 1 while it drives and for ten minutes after it stopped, then fading to
 * 0. The timeline is where the day's cleans stay, so the floor does not keep last night's pad forever.
 */
export function trailOpacity(settledAt: number | null | undefined, now: number): number {
  if (settledAt == null) return 1;
  const settled = now - settledAt;
  if (!(settled > TRAIL_HOLD_MS)) return 1;
  return Math.max(0, 1 - (settled - TRAIL_HOLD_MS) / TRAIL_FADE_MS);
}

/**
 * The robot's trail as it is reported is a chain of noisy points a few centimetres apart: drawn as is, the pad zigzags
 * and every little kink shows. Points closer than `minStep` to the last kept one are dropped, then each run is rounded
 * off with Chaikin's corner cutting (`rounds` times; every corner is replaced by two points a quarter of the way
 * along its sides), which turns the polyline into a smooth curve through the same area. The ends stay where they are.
 */
export function smoothTrail(segments: readonly (readonly Vec2[])[], minStep = 0.03, rounds = 2): Vec2[][] {
  return segments.map((line) => {
    let pts: Vec2[] = [];
    for (const p of line) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minStep) pts.push([p[0], p[1]]);
    }
    const end = line[line.length - 1];
    if (end && pts.length > 1) {
      const last = pts[pts.length - 1]!;
      if (last[0] !== end[0] || last[1] !== end[1]) pts[pts.length - 1] = [end[0], end[1]];
    }
    for (let r = 0; r < rounds && pts.length > 2; r++) {
      const next: Vec2[] = [pts[0]!];
      for (let i = 0; i + 1 < pts.length; i++) {
        const [a, b] = [pts[i]!, pts[i + 1]!];
        next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      }
      next.push(pts[pts.length - 1]!);
      pts = next;
    }
    return pts;
  });
}

/** Sides of the round ends and sharp turns: enough that a 16 cm pad shows no corners. */
const DISC_STEPS = 16;
/** A turn sharper than this (the sine between the steps, about 50°) gets a round disc; gentler ones bend the ribbon. */
const SHARP_TURN = 0.75;

/**
 * A flat ribbon along `segments`, `width` metres wide, lying at height `y`: one continuous strip whose edges are offset
 * along the mean direction at each point (a mitred joint, so a smoothed curve has no notches and no overlaps), with
 * round discs at both ends and at the few sharp turns. Where discs overlap the strip, the view draws the pad through
 * the stencil, so it stays one even sheet. A trail shorter than a millimetre leaves an empty geometry.
 */
export function trailGeometry(segments: readonly (readonly Vec2[])[], width: number, y: number): BufferGeometry {
  const half = width / 2;
  const pos: number[] = [];
  const tri = (a: Vec2, b: Vec2, c: Vec2) => pos.push(a[0], y, a[1], b[0], y, b[1], c[0], y, c[1]);
  const disc = ([cx, cz]: Vec2) => {
    for (let k = 0; k < DISC_STEPS; k++) {
      const [a0, a1] = [(k / DISC_STEPS) * Math.PI * 2, ((k + 1) / DISC_STEPS) * Math.PI * 2];
      tri([cx, cz], [cx + Math.cos(a0) * half, cz + Math.sin(a0) * half], [cx + Math.cos(a1) * half, cz + Math.sin(a1) * half]);
    }
  };
  for (const raw of segments) {
    // steps shorter than a tenth of a millimetre have no direction
    const line: Vec2[] = [];
    for (const p of raw) {
      const last = line[line.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1e-4) line.push(p as Vec2);
    }
    if (line.length < 2) continue;
    // the unit direction of every step
    const dirs: Vec2[] = [];
    for (let i = 0; i + 1 < line.length; i++) {
      const [dx, dz] = [line[i + 1]![0] - line[i]![0], line[i + 1]![1] - line[i]![1]];
      const len = Math.hypot(dx, dz);
      dirs.push([dx / len, dz / len]);
    }
    // the left and right edge at every point: along the normal of the mean direction, lengthened so the ribbon keeps
    // its width through the bend (at most twice, a sharp turn gets its disc instead)
    const left: Vec2[] = [];
    const right: Vec2[] = [];
    const sharp: boolean[] = [];
    for (let i = 0; i < line.length; i++) {
      const a = dirs[Math.max(0, i - 1)]!;
      const b = dirs[Math.min(dirs.length - 1, i)]!;
      const isSharp = i > 0 && i + 1 < line.length && (Math.abs(a[0] * b[1] - a[1] * b[0]) > SHARP_TURN || a[0] * b[0] + a[1] * b[1] < 0);
      // a sharp turn keeps the plain width (a long mitre would stick out as a spike); its disc rounds it off
      let [mx, mz] = isSharp ? b : [a[0] + b[0], a[1] + b[1]];
      const m = Math.hypot(mx, mz);
      [mx, mz] = m < 1e-6 ? b : [mx / m, mz / m];
      const scale = isSharp ? half : half / Math.max(0.5, mx * b[0] + mz * b[1]);
      const [nx, nz] = [-mz * scale, mx * scale];
      const [px, pz] = line[i]!;
      left.push([px + nx, pz + nz]);
      right.push([px - nx, pz - nz]);
      sharp.push(isSharp);
    }
    for (let i = 0; i + 1 < line.length; i++) {
      tri(left[i]!, right[i]!, left[i + 1]!);
      tri(right[i]!, right[i + 1]!, left[i + 1]!);
    }
    // round ends, like the robot's own brush leaves them, and round sharp turns
    disc(line[0]!);
    disc(line[line.length - 1]!);
    for (let i = 1; i + 1 < line.length; i++) if (sharp[i]) disc(line[i]!);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(pos, 3));
  return geometry;
}
