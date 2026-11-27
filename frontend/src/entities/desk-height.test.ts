import assert from "node:assert/strict";
import { test } from "node:test";
import type { Building } from "../model.ts";
import type { HomeAssistant } from "../types.ts";
import { deskHeight, deskHeightKey, withDeskHeights } from "./desk-height.ts";

const hass = (state: string, unit?: string) => ({ states: { "sensor.desk": { entity_id: "sensor.desk", state, attributes: unit ? { unit_of_measurement: unit } : {} } } }) as unknown as HomeAssistant;
const desk = { type: "desk", height_entity: "sensor.desk" };

test("a desk's height comes from its entity in cm, mm, m or inches", () => {
  assert.equal(deskHeight(hass("112", "cm"), desk), 1.12);
  assert.equal(deskHeight(hass("745", "mm"), desk), 0.75);
  assert.equal(deskHeight(hass("1.05", "m"), desk), 1.05);
  assert.equal(deskHeight(hass("40", "in"), desk), 1.02);
  // no unit: above 10 is centimetres
  assert.equal(deskHeight(hass("72"), desk), 0.72);
  assert.equal(deskHeight(hass("0,9"), desk), 0.9);
});

test("no value, no entity or no desk: no live height; out of range is clamped", () => {
  assert.equal(deskHeight(hass("unavailable", "cm"), desk), null);
  assert.equal(deskHeight(hass("112", "cm"), { type: "desk", height_entity: null }), null);
  assert.equal(deskHeight(hass("112", "cm"), { type: "table", height_entity: "sensor.desk" }), null);
  assert.equal(deskHeight(hass("400", "cm"), desk), 1.6);
});

test("the shown building takes the live height, the plan stays", () => {
  const b = { floors: [{ id: "f", furniture: [{ id: "d1", type: "desk", h: 0.75, height_entity: "sensor.desk" }, { id: "t", type: "table", h: 0.75 }] }] } as unknown as Building;
  const shown = withDeskHeights(hass("118", "cm"), b);
  assert.equal(shown.floors[0].furniture[0].h, 1.18);
  assert.equal(shown.floors[0].furniture[1], b.floors[0].furniture[1]);
  assert.equal(b.floors[0].furniture[0].h, 0.75);
  assert.deepEqual(deskHeightKey(hass("118", "cm"), b), ["desk:d1=1.18"]);
  // at the plan's own height nothing changes
  assert.equal(withDeskHeights(hass("75", "cm"), b), b);
});

test("fork: a pack desk with a lift stretches by the difference, and what is fixed under its top moves along", async () => {
  const { setPacks, fittedParts, packItem } = await import("../packs.ts");
  setPacks([
    {
      format: "nfpack", version: 1, id: "t.desk", name: "T", items: [
        {
          id: "lifter", name: { en: "Lifter" }, size: [1.8, 0.9, 1.0], lift: { from: 0.1, to: 0.6, top: 0.7 },
          parts: [
            { shape: "box", x: 0, z: 0, w: 1, d: 1, y: 0, h: 0.1, color: "dark" },
            { shape: "box", x: 0, z: 0, w: 0.1, d: 0.1, y: 0.1, h: 0.5, color: "metal" },
            { shape: "box", x: 0, z: 0, w: 1, d: 1, y: 0.68, h: 0.02, color: "white" },
            { shape: "box", x: 0, z: 0, w: 0.4, d: 0.1, y: 0.7, h: 0.3, color: "dark" },
          ],
        },
      ],
    },
  ] as never);
  const b = {
    floors: [{ id: "f", furniture: [
      { id: "d", type: "pack:t.desk:lifter", x: 0, z: 0, rotation: 0, w: 1.8, d: 0.9, h: 1.0, height_entity: "sensor.desk" },
      { id: "strip", type: "led_strip", x: 0.3, z: 0, rotation: 0, w: 1.5, d: 0.02, h: 0.006, mount_y: 0.66 },
      { id: "far", type: "led_strip", x: 3, z: 0, rotation: 0, w: 1.5, d: 0.02, h: 0.006, mount_y: 0.66 },
      { id: "lamp", type: "led_strip", x: 0.3, z: 0, rotation: 0, w: 1.5, d: 0.02, h: 0.006, mount_y: 2.2 },
    ] }],
  } as unknown as Building;
  const shown = withDeskHeights(hass("120", "cm"), b);
  const [d, strip, far, lamp] = shown.floors[0].furniture;
  assert.equal(d.h, 1.5);
  assert.equal(strip.mount_y, 1.16);
  assert.equal(far.mount_y, 0.66);
  assert.equal(lamp.mount_y, 2.2);
  const parts = fittedParts(packItem("pack:t.desk:lifter")!, 1.8, 0.9, 1.5);
  const ys = parts.map((p) => [+(p.y * 1.5).toFixed(3), +((p.y + p.h) * 1.5).toFixed(3)]);
  // the foot stays, the leg stretches from 0.1 to 1.1, the top and the monitor move up by 0.5 m
  assert.deepEqual(ys, [[0, 0.1], [0.1, 1.1], [1.18, 1.2], [1.2, 1.5]]);
  setPacks([]);
});
