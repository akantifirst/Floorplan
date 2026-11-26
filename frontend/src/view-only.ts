// "View only": the 3D view, the room panel and the menus show everything but send nothing to Home Assistant. A wall tablet is easy to
// touch by accident; this makes it safe to leave open (#156). Home Assistant's own more-info dialog stays as it is.

import type { HassEntity, HomeAssistant } from "./types.ts";

const cache = new WeakMap<HomeAssistant, HomeAssistant>();

/** `hass` with every service call turned into a no-op; the same object for the same `hass`, so lit sees no change. */
export function withoutControl(hass: HomeAssistant): HomeAssistant {
  let quiet = cache.get(hass);
  if (!quiet) {
    quiet = { ...hass, callService: async () => undefined };
    cache.set(hass, quiet);
  }
  return quiet;
}

/**
 * Demo mode (fork): while `sensor.nextfloor_demo` is "on", its `states` attribute ({ entity_id: state } or
 * { entity_id: { state, attributes } }) is laid over Home Assistant's states, so the 3D view shows a made-up day – the figure,
 * the desk, the lamps – without touching a device. Nothing is sent to Home Assistant meanwhile (a tap on a lamp must not
 * switch the real one).
 */
export const DEMO_ENTITY = "sensor.nextfloor_demo";
const demoCache = new WeakMap<HomeAssistant, HomeAssistant>();

type Overlay = Record<string, unknown>;

/** `hass` with the demo's states laid over it, or `hass` itself while the demo is off; the same object for the same `hass`. */
export function withDemo(hass: HomeAssistant): HomeAssistant {
  const demo = hass.states?.[DEMO_ENTITY];
  const overlay = demo?.state === "on" ? (demo.attributes.states as Overlay | undefined) : undefined;
  if (!overlay || typeof overlay !== "object") return hass;
  let shown = demoCache.get(hass);
  if (!shown) {
    const states = { ...hass.states };
    for (const [id, value] of Object.entries(overlay)) {
      const real = states[id];
      const base: HassEntity = real ?? { entity_id: id, state: "", attributes: {}, last_changed: demo!.last_changed, last_updated: demo!.last_updated };
      const own = value && typeof value === "object" ? (value as { state?: unknown; attributes?: Record<string, unknown> }) : { state: value };
      states[id] = { ...base, state: String(own.state ?? base.state), attributes: { ...base.attributes, ...(own.attributes ?? {}) } };
    }
    shown = { ...hass, states, callService: async () => undefined };
    demoCache.set(hass, shown);
  }
  return shown;
}

/** The `hass` to hand to the parts that control devices: the real one, or (view only) the quiet copy; in demo mode the demo's. */
export const controlHass = <T extends HomeAssistant | undefined>(hass: T, viewOnly: boolean): T => {
  if (!hass) return hass;
  const shown = withDemo(hass);
  if (shown !== hass) return shown as T;
  return viewOnly ? (withoutControl(hass) as T) : hass;
};
