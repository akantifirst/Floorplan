// A sit/stand desk whose top follows an entity with its current height (#214): sensor, number or input_number,
// in cm, mm, m or inches by its unit; the piece is drawn at that height, the plan's own `h` stays as it is.
// Fork: also pack desks with a `lift` (their legs stretch, their top and what stands on it move up), and the pieces fixed
// under or on the desk's top (LED strips, a presence sensor, given a mount height) move with it.
import type { Building, Furniture } from "../model.ts";
import { packItem } from "../packs.ts";
import type { HomeAssistant } from "../types.ts";

/** Lowest and highest top a desk can be drawn with (m). */
const MIN_H = 0.4;
const MAX_H = 1.6;
/** Pieces with their own mount height this far below the desk's top (or this far above) are fixed to it and move with it (m). */
const UNDER = 0.15;
const OVER = 0.05;

/** The current height of the desk's top from its height entity (m, to the centimetre), or null without a usable value. */
export function deskHeight(hass: HomeAssistant | undefined, item: Pick<Furniture, "type" | "height_entity">): number | null {
  const id = item.height_entity;
  if ((item.type !== "desk" && !packItem(item.type)?.lift) || !id || !hass) return null;
  const st = hass.states[id];
  const v = st ? Number.parseFloat(String(st.state).replace(",", ".")) : Number.NaN;
  if (!Number.isFinite(v)) return null;
  const unit = String(st?.attributes?.unit_of_measurement ?? "").trim().toLowerCase();
  // no unit: a desk's height in metres is below 2, in centimetres above 10
  const factor = unit === "mm" ? 0.001 : unit === "cm" ? 0.01 : unit === "m" ? 1 : unit === "in" || unit === '"' ? 0.0254 : v > 10 ? 0.01 : 1;
  const m = Math.round(v * factor * 100) / 100;
  return Math.min(MAX_H, Math.max(MIN_H, m));
}

/** The plan height of a desk's top (m): its height for the built-in desk, the lift's `top` of a pack desk. */
function planTop(f: Furniture): number {
  const lift = packItem(f.type)?.lift;
  return lift ? lift.top * f.h : f.h;
}

/** How far a desk's top is drawn above (or below) its plan height (m), 0 without a live height. */
function deskDelta(hass: HomeAssistant | undefined, f: Furniture): number {
  const h = deskHeight(hass, f);
  return h === null ? 0 : Math.round((h - planTop(f)) * 100) / 100;
}

/** "id=height" of every desk drawn at a live height, for telling when the shown building must be rebuilt. */
export function deskHeightKey(hass: HomeAssistant | undefined, b: Building): string[] {
  const out: string[] = [];
  for (const floor of b.floors) for (const f of floor.furniture) {
    if (deskDelta(hass, f) !== 0) out.push(`desk:${f.id}=${deskHeight(hass, f)}`);
  }
  return out;
}

/** Whether a point of the plan lies on a desk's footprint. */
function onDesk(desk: Furniture, x: number, z: number): boolean {
  const a = (-desk.rotation * Math.PI) / 180;
  const [dx, dz] = [x - desk.x, z - desk.z];
  const [u, v] = [dx * Math.cos(a) - dz * Math.sin(a), dx * Math.sin(a) + dz * Math.cos(a)];
  return Math.abs(u) <= desk.w / 2 + 0.01 && Math.abs(v) <= desk.d / 2 + 0.01;
}

/** The building with each desk at its live height (the same object when none differs), and what is fixed to it moved along. */
export function withDeskHeights(hass: HomeAssistant | undefined, b: Building): Building {
  if (!deskHeightKey(hass, b).length) return b;
  return {
    ...b,
    floors: b.floors.map((floor) => {
      const desks = floor.furniture.map((f) => ({ f, delta: deskDelta(hass, f) })).filter((d) => d.delta !== 0);
      if (!desks.length) return floor;
      return {
        ...floor,
        furniture: floor.furniture.map((f) => {
          const own = desks.find((d) => d.f === f);
          // the built-in desk is drawn at its top's height, a pack desk stretches by the difference
          if (own) return f.type === "desk" ? { ...f, h: deskHeight(hass, f)! } : { ...f, h: Math.max(0.05, Math.round((f.h + own.delta) * 1000) / 1000) };
          if (f.mount_y == null) return f;
          const under = desks.find(({ f: d }) => onDesk(d, f.x, f.z) && f.mount_y! >= planTop(d) - UNDER && f.mount_y! <= planTop(d) + OVER);
          return under ? { ...f, mount_y: Math.round((f.mount_y + under.delta) * 1000) / 1000 } : f;
        }),
      };
    }),
  };
}
