import assert from "node:assert/strict";
import { test } from "node:test";
import type { HomeAssistant } from "./types.ts";
import { controlHass, withoutControl } from "./view-only.ts";

const hass = (calls: string[]) => ({ language: "de", states: {}, callService: async (d: string, s: string) => void calls.push(`${d}.${s}`) }) as unknown as HomeAssistant;

test("view only turns every service call into a no-op and keeps everything else", async () => {
  const calls: string[] = [];
  const real = hass(calls);
  const quiet = withoutControl(real);
  await quiet.callService("light", "toggle", {});
  assert.deepEqual(calls, []);
  assert.equal(quiet.language, "de");
  await real.callService("light", "toggle", {});
  assert.deepEqual(calls, ["light.toggle"]);
});

test("the quiet copy is the same object for the same hass, so nothing re-renders for nothing", () => {
  const real = hass([]);
  assert.equal(withoutControl(real), withoutControl(real));
  assert.notEqual(withoutControl(hass([])), withoutControl(real));
});

test("controlHass hands out the real hass unless view only is on", () => {
  const real = hass([]);
  assert.equal(controlHass(real, false), real);
  assert.notEqual(controlHass(real, true), real);
  assert.equal(controlHass(undefined, true), undefined);
});

test("demo mode lays the demo's states over the real ones, sends nothing, and is off without the switch", async () => {
  const calls: string[] = [];
  const states = {
    "light.desk": { entity_id: "light.desk", state: "off", attributes: { friendly_name: "Desk" } },
    "sensor.nextfloor_demo": { entity_id: "sensor.nextfloor_demo", state: "on", attributes: { states: { "light.desk": { state: "on", attributes: { brightness: 200 } }, "sensor.desk_position": "120" } } },
  };
  const real = { ...hass(calls), states } as unknown as HomeAssistant;
  const demo = controlHass(real, false);
  assert.equal(demo.states["light.desk"].state, "on");
  assert.equal(demo.states["light.desk"].attributes.brightness, 200);
  assert.equal(demo.states["light.desk"].attributes.friendly_name, "Desk");
  assert.equal(demo.states["sensor.desk_position"].state, "120");
  assert.equal(controlHass(real, false), demo);
  await demo.callService("light", "toggle", {});
  assert.deepEqual(calls, []);
  const off = { ...real, states: { ...states, "sensor.nextfloor_demo": { ...states["sensor.nextfloor_demo"], state: "off" } } } as unknown as HomeAssistant;
  assert.equal(controlHass(off, false), off);
});
