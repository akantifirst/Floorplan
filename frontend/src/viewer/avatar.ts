// An animated person (a rigged glTF model with its own animations, e.g. Quaternius' CC0 characters) who lives in the
// flat: an activity sensor says what they do ("desk_sit_80", "kitchen_sink", "sleep", "away"), the pack's spot items say
// where that happens and in which pose, and the avatar walks there through the doors and settles into the pose.
//
// Walking, idling, punching and the like are the model's own clips; sitting, typing, lying, squatting, reaching and
// looking at a phone are put on top of them by turning bones towards target directions (so it works with any rig whose
// bones are named like Hips / UpperLeg.L / LowerArm.R …, whatever way its bones point).

import {
  AnimationMixer,
  Box3,
  BoxGeometry,
  Group,
  LoopOnce,
  LoopRepeat,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type AnimationAction,
  type AnimationClip,
  type Bone,
  type Material,
  type SkinnedMesh,
  type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Vec2 } from "../model.ts";
import { getMeshSource } from "../packs.ts";
import { alongPath, pathLength, spotFor, type AvatarSpotInfo, type NavGrid } from "./avatar-nav.ts";

// ------------------------------------------------------------------ the model file

interface AvatarModel {
  scene: Object3D;
  clips: AnimationClip[];
}

const models = new Map<string, Promise<AvatarModel | null>>();

/** Load a rigged model with its animations (once per page); null when the host has none or it is broken. */
export function loadAvatarModel(id: string): Promise<AvatarModel | null> {
  let p = models.get(id);
  if (!p) {
    const source = getMeshSource();
    if (!source) return Promise.resolve(null);
    p = source(id)
      .then(
        (data) =>
          data &&
          new Promise<AvatarModel | null>((resolve) => {
            new GLTFLoader().parse(
              data,
              "",
              (gltf) => resolve({ scene: gltf.scene, clips: gltf.animations ?? [] }),
              () => resolve(null),
            );
          }),
      )
      .catch(() => null);
    models.set(id, p);
    // a failed load may work later (the login can change)
    void p.then((m) => {
      if (!m) models.delete(id);
    });
  }
  return p;
}

// ------------------------------------------------------------------ the rig

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

type Side = 0 | 1; // 0 = left (+x of the body), 1 = right
const SIGN = [1, -1] as const;

interface Rig {
  hips: Bone | null;
  spine: Bone | null;
  chest: Bone | null;
  neck: Bone | null;
  head: Bone | null;
  upperArm: (Bone | null)[];
  lowerArm: (Bone | null)[];
  hand: (Bone | null)[];
  /** Second joints of the middle, index and little fingers: which way the hand points and how it is rolled. */
  middle: (Bone | null)[];
  index: (Bone | null)[];
  pinky: (Bone | null)[];
  upperLeg: (Bone | null)[];
  lowerLeg: (Bone | null)[];
  foot: (Bone | null)[];
}

function findRig(root: Object3D): Rig {
  const bones = new Map<string, Bone>();
  root.traverse((o) => {
    if ((o as Bone).isBone && !bones.has(norm(o.name))) bones.set(norm(o.name), o as Bone);
  });
  const one = (...names: string[]) => {
    for (const n of names) {
      const b = bones.get(n);
      if (b) return b;
    }
    // names like "mixamorig:Hips" or "CharacterArmature_Hips"
    for (const n of names) for (const [k, b] of bones) if (k.endsWith(n)) return b;
    return null;
  };
  const sided = (...bases: string[]) =>
    ([0, 1] as const).map((s) => {
      const [short, long] = s === 0 ? ["l", "left"] : ["r", "right"];
      return one(...bases.flatMap((b) => [`${b}${short}`, `${b}${long}`, `${long}${b}`, `${short}${b}`]));
    });
  return {
    hips: one("hips", "pelvis"),
    spine: one("abdomen", "spine", "spine1"),
    chest: one("chest", "torso", "spine2", "upperchest"),
    neck: one("neck"),
    head: one("head"),
    upperArm: sided("upperarm", "arm"),
    lowerArm: sided("lowerarm", "forearm"),
    hand: sided("wrist", "hand"),
    middle: sided("middle2", "handmiddle2"),
    index: sided("index2", "handindex2"),
    pinky: sided("pinky2", "handpinky2"),
    upperLeg: sided("upperleg", "thigh", "upleg"),
    lowerLeg: sided("lowerleg", "shin", "calf", "leg"),
    foot: sided("foot", "ankle"),
  };
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _q = new Quaternion();
const _qb = new Quaternion();
const _qp = new Quaternion();
const _qr = new Quaternion();

/** Turn a bone so that the way to its child joint points along `dir` (given in the frame of `ref`), by the share w. */
function aim(bone: Bone | null, child: Object3D | null, dir: Vector3, ref: Object3D, w: number): void {
  if (!bone || !child || !bone.parent || w <= 0.001) return;
  ref.getWorldQuaternion(_qr);
  const want = _c.copy(dir).applyQuaternion(_qr).normalize();
  bone.getWorldPosition(_a);
  child.getWorldPosition(_b);
  const now = _b.sub(_a);
  if (now.lengthSq() < 1e-12) return;
  now.normalize();
  _q.setFromUnitVectors(now, want);
  bone.getWorldQuaternion(_qb);
  _q.multiply(_qb);
  bone.parent.getWorldQuaternion(_qp);
  _qp.invert().multiply(_q);
  bone.quaternion.slerp(_qp, Math.min(1, w));
  bone.updateMatrixWorld(true);
}

/** Turn a bone about an axis given in the frame of `ref` (radians). */
function turn(bone: Bone | null, axis: Vector3, angle: number, ref: Object3D): void {
  if (!bone || !bone.parent || Math.abs(angle) < 1e-4) return;
  ref.getWorldQuaternion(_qr);
  _q.setFromAxisAngle(_c.copy(axis).applyQuaternion(_qr).normalize(), angle);
  bone.getWorldQuaternion(_qb);
  _q.multiply(_qb);
  bone.parent.getWorldQuaternion(_qp);
  bone.quaternion.copy(_qp.invert().multiply(_q));
  bone.updateMatrixWorld(true);
}

/** Keep a bone's world turn as it was before the bones above it moved (feet stay flat, hands stay level). */
function holdWorld(bone: Bone | null, world: Quaternion, w: number): void {
  if (!bone || !bone.parent || w <= 0.001) return;
  bone.parent.getWorldQuaternion(_qp);
  bone.quaternion.slerp(_qp.invert().multiply(world), Math.min(1, w));
  bone.updateMatrixWorld(true);
}

const _e = new Vector3();
const _f = new Vector3();
const _m1 = new Matrix4();
const _m2 = new Matrix4();

/**
 * Turn a bone so that `tip` (a joint it carries) lies along `dir` and the line from `a` to `b` (index to little finger:
 * the roll of the hand) along `across`, both given in the frame of `ref`, by the share w. With `keepAim` the bone keeps
 * the way it points and only rolls about it (the forearm turning the palm down).
 */
function orient(bone: Bone | null, tip: Object3D | null, a: Object3D | null, b: Object3D | null, dir: Vector3 | null, across: Vector3, ref: Object3D, w: number): void {
  if (!bone || !tip || !a || !b || !bone.parent || w <= 0.001) return;
  ref.getWorldQuaternion(_qr);
  const f0 = tip.getWorldPosition(_a).sub(bone.getWorldPosition(_b));
  if (f0.lengthSq() < 1e-12) return;
  f0.normalize();
  const a0 = b.getWorldPosition(_c).sub(a.getWorldPosition(_d));
  a0.addScaledVector(f0, -a0.dot(f0));
  if (a0.lengthSq() < 1e-12) return;
  a0.normalize();
  const f1 = dir ? _e.copy(dir).applyQuaternion(_qr).normalize() : _e.copy(f0);
  const a1 = _f.copy(across).applyQuaternion(_qr);
  a1.addScaledVector(f1, -a1.dot(f1));
  if (a1.lengthSq() < 1e-12) return;
  a1.normalize();
  _m1.makeBasis(f0, a0, f0.clone().cross(a0));
  _m2.makeBasis(f1, a1, f1.clone().cross(a1));
  _q.setFromRotationMatrix(_m2.multiply(_m1.transpose()));
  bone.getWorldQuaternion(_qb);
  _q.multiply(_qb);
  bone.parent.getWorldQuaternion(_qp);
  _qp.invert().multiply(_q);
  bone.quaternion.slerp(_qp, Math.min(1, w));
  bone.updateMatrixWorld(true);
}

const LEFT = new Vector3(1, 0, 0);

/** Bounds of a rigged model as it stands now (the skinned vertices, so the bone matrices first). */
function measure(o: Object3D): Box3 {
  o.updateMatrixWorld(true);
  o.traverse((x) => (x as SkinnedMesh).skeleton?.update());
  return new Box3().setFromObject(o, true);
}
const v3 = (x: number, y: number, z: number) => new Vector3(x, y, z);

// ------------------------------------------------------------------ poses

/** The poses a spot can ask for. */
export const AVATAR_POSES = ["stand", "idle", "stand_type", "sit", "sit_type", "phone", "sleep", "squat", "box", "reach", "interact", "wave", "away"] as const;
export type AvatarPose = (typeof AVATAR_POSES)[number];

export interface AvatarSpot extends AvatarSpotInfo {
  pose: AvatarPose;
  pos: Vec2;
  /** Which way the person faces there (atan2(dx, dz) of the front). */
  heading: number;
  /** Height of what they sit or lie on above the spot's floor (the spot item's height), m. */
  seat: number;
  /** Height of the floor under the spot (a spot put on a bed stands on it). */
  base: number;
  /** Where the walk ends, next to the furniture the spot is in (the chair is pulled out from there). */
  stand: Vec2;
}

const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

type Phase = "posed" | "rising" | "walking" | "settling" | "hidden";

export class Avatar {
  readonly group = new Group();
  /** Lowered, pushed and tipped over by the pose (sitting, lying). */
  private body = new Group();
  private inner = new Group();
  private mixer: AnimationMixer;
  private clips: AnimationClip[];
  private actions = new Map<string, AnimationAction>();
  private base: AnimationAction | null = null;
  private rig: Rig;
  /**
   * Every bone as the clips left it in the last frame, before the pose went on top. The clips do not key every bone (this
   * one has no track for the spine or the neck) and the mixer only writes a value that changed since its last frame, so
   * a bone it does not write would keep the pose's turn and the turns would add up frame by frame (the body spins).
   * Each frame first puts the bones back as the clips had them; resetting them to the rest pose instead would make the
   * torso snap back to it whenever a keyed value holds still for a frame.
   */
  private clipPose: [Bone, Quaternion, Vector3][] = [];
  /**
   * The ankle at the end of each shin, carried by the shin. In IK rigs (Quaternius and the like) the foot is not a child of
   * the shin but of the root, so it stays where the clip put it when the body sits down: the shin's skin would stretch to
   * it. The legs aim with these, and a detached foot is moved onto them.
   */
  private ankles: (Object3D | null)[] = [null, null];
  private detachedFeet: boolean[] = [false, false];
  private rest = { hipY: 0.95, ankleY: 0.08, footX: 0.1, thigh: 0.45, shin: 0.45 };
  private phone: Mesh;
  private own: Material[] = [];

  // where it is and what it does
  private pos: Vec2;
  private heading: number;
  private y = 0;
  private spot: AvatarSpot | null = null;
  private target: AvatarSpot | null = null;
  private phase: Phase = "posed";
  /** Share of the spot's pose, 0 (standing, as the clip has it) … 1. */
  private w = 0;
  private path: Vec2[] = [];
  private walked = 0;
  private t = 0;
  private cue = 0;
  private wander = 0;
  private stroll = 60;
  private state: string | null = null;
  private settleFrom: { pos: Vec2; heading: number } | null = null;
  floorId: string;
  private readonly speed: number;

  constructor(
    model: AvatarModel,
    height: number,
    at: { pos: Vec2; heading: number; floorId: string },
    speed = 1.0,
  ) {
    this.speed = speed;
    this.pos = [...at.pos] as Vec2;
    this.heading = at.heading;
    this.floorId = at.floorId;
    const inst = cloneSkinned(model.scene);
    inst.traverse((o) => {
      const m = o as SkinnedMesh;
      if (!m.isMesh) return;
      // a lying or sitting person leaves the bounds of the standing one: never cull them
      m.frustumCulled = false;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => {
        const c = (x as MeshStandardMaterial).clone();
        c.metalness = Math.min(c.metalness ?? 0, 0.1);
        c.roughness = Math.max(c.roughness ?? 0.7, 0.55);
        this.own.push(c);
        return c;
      });
      m.material = Array.isArray(m.material) ? mats : mats[0];
    });
    this.inner.add(inst);
    this.body.add(this.inner);
    this.group.add(this.body);
    this.rig = findRig(inst);
    inst.traverse((o) => {
      if ((o as Bone).isBone) this.clipPose.push([o as Bone, (o as Bone).quaternion.clone(), (o as Bone).position.clone()]);
    });
    inst.updateMatrixWorld(true);
    for (const s of [0, 1] as Side[]) {
      const lower = this.rig.lowerLeg[s];
      const foot = this.rig.foot[s];
      if (!lower || !foot) continue;
      const ankle = new Object3D();
      ankle.position.copy(lower.worldToLocal(foot.getWorldPosition(new Vector3())));
      lower.add(ankle);
      this.ankles[s] = ankle;
      let up: Object3D | null = foot.parent;
      while (up && up !== lower) up = up.parent;
      this.detachedFeet[s] = up !== lower;
    }
    this.normalise(height);
    this.mixer = new AnimationMixer(inst);
    this.clips = model.clips;
    this.mixer.addEventListener("finished", () => this.clipFinished());
    // the phone looked at on the toilet (or anywhere a spot says "phone")
    const phoneMat = new MeshStandardMaterial({ color: 0x15171c, emissive: 0x2a3550, emissiveIntensity: 0.6, roughness: 0.4 });
    this.own.push(phoneMat);
    this.phone = new Mesh(new BoxGeometry(0.072, 0.15, 0.009), phoneMat);
    this.phone.visible = false;
    this.body.add(this.phone);
    this.setBase("idle", 0);
    this.place();
  }

  /** Face +z, stand on y = 0 with the hips over the origin, and be `height` metres tall; then measure the legs. */
  private normalise(height: number): void {
    const r = this.rig;
    this.group.updateMatrixWorld(true);
    if (r.upperLeg[0] && r.upperLeg[1]) {
      const left = r.upperLeg[0].getWorldPosition(new Vector3()).sub(r.upperLeg[1].getWorldPosition(new Vector3()));
      // forward = left × up
      const [fx, fz] = [-left.z, left.x];
      if (Math.hypot(fx, fz) > 1e-6) this.inner.rotation.y = -Math.atan2(fx, fz);
    }
    const box = measure(this.inner);
    const tall = Math.max(1e-3, box.max.y - box.min.y);
    this.inner.scale.multiplyScalar(height / tall);
    box.copy(measure(this.inner));
    const hips = r.hips ? r.hips.getWorldPosition(new Vector3()) : box.getCenter(new Vector3());
    this.inner.position.set(-hips.x, -box.min.y, -hips.z);
    this.group.updateMatrixWorld(true);
    const p = (b: Bone | null) => (b ? this.body.worldToLocal(b.getWorldPosition(new Vector3())) : null);
    const hip = p(r.upperLeg[0]);
    const knee = p(r.lowerLeg[0]);
    const ankle = p(r.foot[0]);
    if (hip && knee && ankle) {
      this.rest = {
        hipY: hip.y,
        ankleY: Math.max(0.02, ankle.y),
        footX: Math.max(0.05, Math.abs(ankle.x)),
        thigh: hip.distanceTo(knee),
        shin: knee.distanceTo(ankle),
      };
    } else this.rest.hipY = height * 0.52;
  }

  // ---------------------------------------------------------------- clips

  private clip(name: string): AnimationClip | null {
    const want = norm(name);
    return this.clips.find((c) => norm(c.name.split("|").pop() ?? c.name) === want) ?? this.clips.find((c) => norm(c.name).endsWith(want)) ?? null;
  }

  private action(name: string): AnimationAction | null {
    let a = this.actions.get(name);
    if (!a) {
      const c = this.clip(name);
      if (!c) return null;
      a = this.mixer.clipAction(c);
      this.actions.set(name, a);
    }
    return a;
  }

  /** Cross-fade to a clip (looping, or once and then the next one picked by clipFinished). */
  private setBase(name: string, fade = 0.35, once = false): void {
    const a = this.action(name) ?? this.action("idle");
    if (!a || (a === this.base && !once)) return;
    a.reset();
    a.setLoop(once ? LoopOnce : LoopRepeat, Infinity);
    a.clampWhenFinished = once;
    a.enabled = true;
    a.setEffectiveTimeScale(1);
    a.setEffectiveWeight(1);
    if (this.base && this.base !== a) a.crossFadeFrom(this.base, fade, false);
    else if (fade > 0) a.fadeIn(fade);
    a.play();
    this.base = a;
  }

  private clipFinished(): void {
    const pose = this.posed()?.pose;
    if (pose === "box") this.setBase(this.base === this.action("punchl") ? "punchr" : "punchl", 0.15, true);
    else this.setBase("idle", 0.4);
  }

  // ---------------------------------------------------------------- what to do

  /** The spot the avatar is in (or settling into). */
  private posed(): AvatarSpot | null {
    return this.phase === "posed" || this.phase === "settling" ? this.spot : null;
  }

  private spots: AvatarSpot[] = [];
  private navFor: (floorId: string) => NavGrid | null = () => null;

  /**
   * The activity sensor's state and the spots of the plan. A new spot makes the avatar stand up, walk there and settle;
   * a state without a spot ("away") sends it to the spot with the pose "away" (the front door) and hides it there.
   */
  update(state: string | null, spots: AvatarSpot[], nav: (floorId: string) => NavGrid | null): void {
    this.navFor = nav;
    // the plan was drawn anew: the same spots are new objects
    const same = (x: AvatarSpot | null) => (x ? (spots.find((p) => p.id === x.id) ?? null) : null);
    if (spots !== this.spots) {
      this.spot = same(this.spot);
      this.target = same(this.target);
      if (this.phase === "posed" && !this.spot) this.phase = "rising";
      this.spots = spots;
    }
    const s = state?.trim().toLowerCase() || null;
    if (s === this.state) return;
    this.state = s;
    this.choose();
  }

  private choose(next = false): void {
    const s = this.state;
    const current = this.target ?? this.spot;
    let want = spotFor(this.spots, s, next ? null : current, this.wander);
    if (next && want === current) want = spotFor(this.spots, s, null, ++this.wander);
    if (!want) {
      if (s === null || ["away", "not_home", "unavailable", "unknown", "off"].includes(s)) {
        const exit = this.spots.find((p) => p.pose === "away" && p.floorId === this.floorId) ?? this.spots.find((p) => p.pose === "away");
        if (exit && this.phase !== "hidden") this.goTo(exit);
        else {
          this.target = null;
          this.spot = null;
          this.phase = "hidden";
          this.w = 0;
        }
      }
      return;
    }
    if (want === current && this.phase !== "hidden") return;
    this.goTo(want);
  }

  private goTo(spot: AvatarSpot): void {
    this.target = spot;
    if (this.phase === "hidden") {
      // back home: it comes in at the "away" spot (the front door) when there is one, else it turns up at the spot
      const door = this.spots.find((p) => p.pose === "away" && p.floorId === spot.floorId);
      const from = door ?? spot;
      this.pos = [...from.stand] as Vec2;
      this.heading = from.heading + Math.PI;
      this.floorId = from.floorId;
      this.spot = null;
      this.w = 0;
      this.setBase("idle", 0);
      this.startWalk();
    } else if (this.phase === "posed" || this.phase === "settling") this.phase = "rising";
    else if (this.phase === "walking") this.startWalk();
  }

  private startWalk(): void {
    const to = this.target;
    if (!to) return;
    if (to.floorId !== this.floorId) {
      // another floor: no stairs to walk, it simply turns up there
      this.floorId = to.floorId;
      this.pos = [...to.stand] as Vec2;
    }
    const grid = this.navFor(this.floorId);
    const way = grid?.path(this.pos, to.stand) ?? null;
    this.path = way ?? [this.pos, to.stand];
    this.walked = 0;
    this.phase = "walking";
    if (pathLength(this.path) > 0.05) this.setBase("walk", 0.25);
  }

  // ---------------------------------------------------------------- every frame

  /** One frame; true while it moves visibly (walking, settling, an animation of the pose). */
  step(dt: number): boolean {
    if (this.phase === "hidden") {
      this.group.visible = false;
      return false;
    }
    this.group.visible = true;
    dt = Math.max(0, Math.min(0.1, dt));
    this.t += dt;
    let moving = true;
    switch (this.phase) {
      case "rising": {
        // stand up out of the pose (lying down takes longer)
        const slow = this.spot?.pose === "sleep" ? 1.6 : 0.8;
        this.w = Math.max(0, this.w - dt / slow);
        if (this.spot && this.settleFrom) this.blendPlace(this.spot, this.settleFrom);
        if (this.w <= 0) {
          if (this.spot) this.pos = [...this.spot.stand] as Vec2;
          this.spot = null;
          this.settleFrom = null;
          this.setBase("idle", 0.3);
          if (this.target) this.startWalk();
          else this.phase = "posed";
        }
        break;
      }
      case "walking": {
        this.walked += this.speed * dt;
        const at = alongPath(this.path, this.walked);
        this.pos = at.pos;
        let d = at.heading - this.heading;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this.heading += Math.max(-6 * dt, Math.min(6 * dt, d));
        if (at.done) {
          this.spot = this.target;
          this.target = null;
          if (this.spot?.pose === "away") {
            this.phase = "hidden";
            this.spot = null;
            this.setBase("idle", 0);
            break;
          }
          this.phase = "settling";
          this.settleFrom = { pos: [...this.pos] as Vec2, heading: this.heading };
          this.cue = 3 + Math.random() * 4;
          this.setBase(this.spot?.pose === "box" ? "punchl" : this.spot?.pose === "wave" ? "wave" : "idle", 0.3, this.spot?.pose === "box");
        }
        break;
      }
      case "settling": {
        const slow = this.spot?.pose === "sleep" ? 1.8 : 0.9;
        this.w = Math.min(1, this.w + dt / slow);
        if (this.spot && this.settleFrom) this.blendPlace(this.spot, this.settleFrom);
        if (this.w >= 1) this.phase = "posed";
        break;
      }
      case "posed": {
        // a few spots for the same state (the armchairs, the window): now and then it moves on to the next one
        this.stroll -= dt;
        if (this.stroll <= 0) {
          this.stroll = 40 + Math.random() * 80;
          if (this.spots.filter((p) => p.states.includes(this.state ?? "")).length > 1) this.choose(true);
        }
        // kitchen work: now and then a real reach into the cupboards (the model's own clip)
        if (this.spot?.pose === "interact") {
          this.cue -= dt;
          if (this.cue <= 0) {
            this.setBase("interact", 0.25, true);
            this.cue = 6 + Math.random() * 6;
          }
        }
        moving = this.spot?.pose !== "sleep";
        break;
      }
    }
    for (const [bone, q, at] of this.clipPose) {
      bone.quaternion.copy(q);
      bone.position.copy(at);
    }
    this.mixer.update(dt);
    for (const [bone, q, at] of this.clipPose) {
      q.copy(bone.quaternion);
      at.copy(bone.position);
    }
    this.place();
    this.pose(this.spot, this.spot ? smooth(this.w) : 0);
    return moving;
  }

  /** While settling or rising: slide from where the walk ended into the spot (the chair, the bed) and turn its way. */
  private blendPlace(spot: AvatarSpot, from: { pos: Vec2; heading: number }): void {
    const k = smooth(this.w);
    this.pos = [from.pos[0] + (spot.pos[0] - from.pos[0]) * k, from.pos[1] + (spot.pos[1] - from.pos[1]) * k];
    let d = spot.heading - from.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading = from.heading + d * Math.min(1, k * 1.6);
    this.y = spot.base * k;
  }

  private place(): void {
    this.group.position.set(this.pos[0], this.y, this.pos[1]);
    this.group.rotation.y = this.heading;
  }

  /** The pose on top of the clip, by the share w (0 = only the clip). */
  private pose(spot: AvatarSpot | null, w: number): void {
    const r = this.rig;
    const rest = this.rest;
    const pose = spot?.pose ?? "stand";
    const body = this.body;
    body.position.set(0, 0, 0);
    body.rotation.set(0, 0, 0);
    this.phone.visible = false;
    if (!spot || w <= 0.001) {
      this.group.updateMatrixWorld(true);
      return;
    }
    const t = this.t;
    // feet as the clip has them, to keep them flat after the legs moved
    const feetWorld = r.foot.map((f) => (f ? f.getWorldQuaternion(new Quaternion()) : null));
    let squat = 0;
    if (pose === "sleep") {
      // tip over backwards onto the bed: the head towards the spot's back, the hips over its middle
      const th = (-Math.PI / 2) * w;
      const hipsTo = rest.hipY + (spot.seat + 0.12 - rest.hipY) * w;
      body.rotation.x = th;
      body.position.set(0, hipsTo - rest.hipY * Math.cos(th), -rest.hipY * Math.sin(th));
    } else if (pose === "sit" || pose === "sit_type" || pose === "phone") {
      body.position.y = (spot.seat + 0.1 - rest.hipY) * w;
      body.position.z = -0.04 * w;
    } else if (pose === "squat") {
      squat = ((1 - Math.cos((2 * Math.PI * t) / 3.2)) / 2) * w;
      body.position.set(0, -0.42 * squat, -0.12 * squat);
    }
    this.group.updateMatrixWorld(true);
    const sit = pose === "sit" || pose === "sit_type" || pose === "phone";

    // ---- spine and head
    if (pose === "sit_type" || pose === "stand_type") turn(r.chest ?? r.spine, LEFT, 0.12 * w, body);
    if (pose === "sit") turn(r.spine, LEFT, -0.12 * w, body);
    if (pose === "phone") {
      // the back straight, only the head bowed to the phone (leaning in brought the face right onto it)
      turn(r.neck, LEFT, 0.25 * w, body);
      turn(r.head, LEFT, 0.2 * w, body);
    }
    if (pose === "squat") turn(r.spine, LEFT, 0.45 * squat, body);
    if (pose === "interact") turn(r.chest ?? r.spine, LEFT, 0.1 * w, body);

    // ---- legs
    for (const s of [0, 1] as Side[]) {
      const sign = SIGN[s];
      if (sit) {
        // thighs forward, shins down to the floor in front of the seat
        const floorY = -body.position.y;
        this.legTo(s, v3(sign * rest.footX * 1.15, rest.ankleY + floorY, (rest.thigh * 0.95 + 0.06) * w), v3(0, 0.3, 1), w);
      } else if (pose === "squat") {
        this.legTo(s, v3(sign * rest.footX * (1 + 0.4 * w), rest.ankleY - body.position.y, -body.position.z), v3(sign * 0.25, 0.2, 1), w);
      } else if (pose === "sleep") {
        aim(r.upperLeg[s], r.lowerLeg[s], v3(sign * 0.06, -1, 0.02), body, w);
        aim(r.lowerLeg[s], this.ankles[s], v3(sign * 0.02, -1, 0), body, w);
      }
      // a foot of an IK rig goes along with the shin it no longer follows by itself
      const foot = r.foot[s];
      const ankle = this.ankles[s];
      if ((sit || pose === "squat" || pose === "sleep") && this.detachedFeet[s] && foot?.parent && ankle) {
        foot.position.copy(foot.parent.worldToLocal(ankle.getWorldPosition(_a)));
        foot.updateMatrixWorld(true);
      }
      if (pose !== "sleep") holdWorld(foot, feetWorld[s]!, w);
    }

    // ---- arms
    for (const s of [0, 1] as Side[]) {
      const sign = SIGN[s];
      const up = r.upperArm[s];
      const low = r.lowerArm[s];
      const hand = r.hand[s];
      switch (pose) {
        case "sit_type":
        case "stand_type": {
          // palms flat over the keyboard; one paw and then the other lifts a couple of centimetres, like a cat typing
          const tap = Math.max(0, Math.sin(t * 6.5 + s * Math.PI)) ** 2;
          const flat = v3(sign, 0, 0);
          aim(up, low, v3(sign * 0.14, -0.8, 0.55), body, w);
          aim(low, hand, v3(-sign * 0.22, 0.02 + 0.03 * tap, 1), body, w);
          orient(low, hand, r.index[s], r.pinky[s], null, flat, body, w);
          orient(hand, r.middle[s], r.index[s], r.pinky[s], v3(-sign * 0.08, -0.22 + 0.1 * tap, 1), flat, body, w);
          break;
        }
        case "phone": {
          // both hands hold the phone in front of the chest, the right thumb scrolls now and then
          const scroll = s === 1 ? 0.06 * Math.max(0, Math.sin(t * 1.7)) ** 8 : 0;
          // the phone some 35 cm from the eyes, below them: the forearms reach forward, not up to the face
          aim(up, low, v3(sign * 0.1, -0.9, 0.42), body, w);
          aim(low, hand, v3(-sign * 0.26, 0.15 + scroll, 1), body, w);
          break;
        }
        case "sleep": {
          aim(up, low, v3(sign * 0.2, -1, 0.06), body, w);
          aim(low, hand, v3(sign * 0.06, -1, 0.18), body, w);
          break;
        }
        case "squat": {
          // arms forward when down, for balance
          aim(up, low, v3(sign * 0.12, -1 + squat, squat), body, Math.min(1, w));
          aim(low, hand, v3(sign * 0.04, -1 + squat, squat), body, Math.min(1, w));
          break;
        }
        case "reach": {
          // one arm up into the shelf, then the other
          const share = Math.max(0, Math.sin((t * Math.PI) / 2.6 + s * Math.PI)) * w;
          aim(up, low, v3(sign * 0.15, 0.92, 0.45), body, share);
          aim(low, hand, v3(0, 0.95, 0.35), body, share);
          break;
        }
        case "interact": {
          // hands on the counter, working (the clip takes over when it reaches into a cupboard)
          const k = this.base === this.action("interact") ? 0 : w;
          const stir = s === 1 ? 0.18 : 0.06;
          aim(up, low, v3(sign * 0.16, -0.85, 0.5), body, k);
          aim(low, hand, v3(-sign * 0.12 + stir * Math.cos(t * 2.6 + s), -0.3, 1 + stir * Math.sin(t * 2.6 + s)), body, k);
          break;
        }
      }
    }

    // ---- the phone, between the hands and turned to the face
    if (pose === "phone" && w > 0.6 && r.hand[0] && r.hand[1]) {
      const a = body.worldToLocal(r.hand[0].getWorldPosition(_a));
      const b = body.worldToLocal(r.hand[1].getWorldPosition(_b));
      this.phone.position.copy(a).add(b).multiplyScalar(0.5);
      this.phone.position.y += 0.05;
      this.phone.position.z += 0.02;
      this.phone.visible = true;
      if (r.head) this.phone.lookAt(r.head.getWorldPosition(_d));
    }
  }

  /** Two-bone leg: the ankle to a point (body frame), the knee bending towards `pole`. */
  private legTo(s: Side, ankle: Vector3, pole: Vector3, w: number): void {
    const r = this.rig;
    const upper = r.upperLeg[s];
    const lower = r.lowerLeg[s];
    const foot = this.ankles[s];
    if (!upper || !lower || !foot) return;
    const hip = this.body.worldToLocal(upper.getWorldPosition(new Vector3()));
    const { thigh: a, shin: b } = this.rest;
    const d = ankle.clone().sub(hip);
    const dist = Math.max(0.05, Math.min(a + b - 0.002, d.length()));
    const u = d.normalize();
    const x = (a * a - b * b + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, a * a - x * x));
    const k = pole.clone().sub(u.clone().multiplyScalar(pole.dot(u)));
    if (k.lengthSq() < 1e-8) k.set(0, 0, 1);
    k.normalize();
    const knee = hip.clone().add(u.clone().multiplyScalar(x)).add(k.multiplyScalar(h));
    const end = hip.clone().add(u.clone().multiplyScalar(dist));
    aim(upper, lower, knee.clone().sub(hip), this.body, w);
    aim(lower, foot, end.sub(knee), this.body, w);
  }

  /** Reflections like the other owned models. */
  setEnvironment(env: Texture | null): void {
    for (const m of this.own as MeshStandardMaterial[]) {
      m.envMap = env;
      m.envMapIntensity = 0.8;
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.group.removeFromParent();
    this.phone.geometry.dispose();
    for (const m of this.own) m.dispose();
  }
}
