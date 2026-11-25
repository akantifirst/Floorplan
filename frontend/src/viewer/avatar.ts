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
    // Quaternius, Mixamo, Character Creator and Daz (Genesis: hip, abdomenLower, chestUpper, lShldrBend, lThighBend …) names
    hips: one("hips", "hip", "pelvis"),
    spine: one("abdomen", "spine", "spine1", "abdomenlower"),
    chest: one("chest", "torso", "spine2", "upperchest", "chestupper", "chestlower"),
    neck: one("neck", "necklower"),
    head: one("head"),
    upperArm: sided("upperarm", "arm", "shldrbend"),
    lowerArm: sided("lowerarm", "forearm", "forearmbend"),
    hand: sided("wrist", "hand"),
    middle: sided("middle2", "handmiddle2", "mid2"),
    index: sided("index2", "handindex2"),
    pinky: sided("pinky2", "handpinky2"),
    upperLeg: sided("upperleg", "thigh", "upleg", "thighbend"),
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
/** Lying on the back: the hand's fingers (body frame, before the sign of the side), see the sleep pose. */
const BACK_HAND_DIR = [0.12, -1, -0.08] as const;
/** On the toilet with the phone: how far it leans (radians, per bone), where the elbows rest and the phone is held. */
const PHONE_LEAN = { spine: 0.8, chest: 0.3, neck: -0.45, head: 0.25 };
/** The elbow, from the knee (body frame, m): on top of the thigh, a little behind the knee. */
const PHONE_ELBOW = new Vector3(0, 0.07, -0.08);
/** The phone, from the knees: above them and a little ahead (scaled with the person). */
const PHONE_AT = { y: 0.06, z: 0.26 };
/** How far in front of the palms the phone lies, towards the face (m). */
const PHONE_GAP = 0.045;
const UP = new Vector3(0, 1, 0);
/**
 * An armchair ("sit"), half lying: the hips this far above the seat and back from the spot (m; negative: slid forward,
 * so the knees rest on the front of a deep seat), the pelvis, spine and chest leant back onto the backrest, the trunk
 * then brought to `lean` (radians from upright, about 54°) and the head to `head`, the hands `handUp` above the thighs,
 * the feet stretched out this far ahead of the spot and this much wider than standing.
 */
/**
 * The backrest of an armchair spot (the pack's floor lounge chair), in the spot's frame: its face starts at `z` behind the
 * spot at height `from` and leans back by `slope` (m back per m up) up to `to`.
 */
const BACKREST = { z: -0.22, from: 0.12, to: 0.67, slope: 0.364 };
/** ...and its seat cushion: its top and its front edge (m, same frame). */
const SEAT = { top: 0.27, front: 0.5 };
const LOUNGE = { hips: 0.15, back: -0.12, pelvis: 0.8, recline: 0.2, chest: 0.1, lean: 0.94, head: 0.07, handUp: 0.07, feet: 0.92, feetApart: 1.5, tuck: 0.06 };
/** How far the toes turn out when the pose sets the feet (radians). */
const TOE_OUT = (10 * Math.PI) / 180;

/** The index-to-little-finger line that gives a hand of side s the palm normal `palm` with the fingers along `fingers`. */
function palmAcross(s: 0 | 1, palm: Vector3, fingers: Vector3): Vector3 {
  // the palm faces -(fingers x across) on the left hand and +(fingers x across) on the right one (this rig's hands)
  const n = palm.clone().normalize().multiplyScalar(s === 0 ? -1 : 1);
  return n.cross(fingers.clone().normalize());
}

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

/**
 * Sleep: each position is held this long (s), a turn takes SLEEP_TURN (s). It lies down on the left side (the right leg
 * drawn up), then turns onto the back, onto the right side (the left leg up), onto the back, and so on.
 */
const SLEEP_EACH = 20;
const SLEEP_TURN = 3;
const SLEEP_ORDER = [1, 0, -1, 0] as const;
/** How far it rolls onto a side (a little past 90°, a touch onto the belly as people lie). */
const SIDE_ROLL = (95 * Math.PI) / 180;
/** Asleep, the elbows rest this high above the mattress (m, for a person whose hips are 0.92 m up). */
const SLEEP_REST = { elbow: 0.05 };
/** ...and lying on a side, the lowest part of it sinks this far into the mattress (m, same scale). */
const SLEEP_SINK = 0.01;

const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

export interface SleepTurn {
  /** Roll about the spine, radians (+ = the left side down). */
  roll: number;
  /** Turning over right now (frames needed). */
  turning: boolean;
  /** Seconds until the next turn starts. */
  next: number;
}

/** Turning over in sleep, `elapsed` seconds after lying down: left side, back, right side, back …, each SLEEP_EACH s. */
export function sleepTurnAt(elapsed: number): SleepTurn {
  const el = Math.max(0, elapsed);
  const seg = Math.floor(el / SLEEP_EACH);
  const into = el - seg * SLEEP_EACH;
  const from = SLEEP_ORDER[(seg + SLEEP_ORDER.length - 1) % SLEEP_ORDER.length]!;
  const to = SLEEP_ORDER[seg % SLEEP_ORDER.length]!;
  const k = seg === 0 ? 1 : smooth(into / SLEEP_TURN);
  return { roll: (from + (to - from) * k) * SIDE_ROLL, turning: seg > 0 && into < SLEEP_TURN + 0.1, next: SLEEP_EACH - into };
}

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
   * The trunk (hips to head, with the shoulders) as the model is built: straight and symmetric. The idle clip turns the
   * chest and shoulders like a standing person shifting weight; lying down that twist made the back pose lopsided and
   * sent an arm into the body on one side, so asleep the trunk goes back to this.
   */
  private trunkRest: [Bone, Quaternion, Vector3][] = [];
  /**
   * The rest pose may stand in a stride: the bone the legs hang from is turned (this model: the right hip 11 cm ahead).
   * Where the pose sets the legs (sitting, squatting, lying) that bone turns back by `strideYaw` so the hips are level,
   * and the trunk above it (`strideTrunk`) turns the other way so it stays as it was.
   */
  private strideYaw = 0;
  private strideRoot: Bone | null = null;
  private strideTrunk: Bone | null = null;
  /** How far levelling the stride moves the hips sideways (body frame); the figure is moved back by it. */
  private strideShift = new Vector3();
  private innerAt = new Vector3();
  /**
   * The ankle at the end of each shin, carried by the shin. In IK rigs (Quaternius and the like) the foot is not a child of
   * the shin but of the root, so it stays where the clip put it when the body sits down: the shin's skin would stretch to
   * it. The legs aim with these, and a detached foot is moved onto them.
   */
  private ankles: (Object3D | null)[] = [null, null];
  private detachedFeet: boolean[] = [false, false];
  /** How far back the seated body slides to lean on the backrest (measured once). */
  private loungeShift: number | null = null;

  /** The gap between the back's skin and the armchair's backrest (m; negative: it presses into it), from the trunk. */
  private backrestGap(): number {
    this.group.updateMatrixWorld(true);
    const limbs = new Set<Object3D>();
    for (const b of [...this.rig.upperArm, ...this.rig.upperLeg, this.rig.head]) b?.traverse((x) => void limbs.add(x));
    let gap = Infinity;
    const v = new Vector3();
    this.inner.traverse((o) => {
      const m = o as SkinnedMesh;
      if (!m.isSkinnedMesh || !m.visible) return;
      m.skeleton.update();
      const { skinIndex, skinWeight } = m.geometry.attributes;
      if (!skinIndex || !skinWeight) return;
      for (let i = 0; i < m.geometry.attributes.position.count; i += 2) {
        let main = 0;
        for (let k = 1; k < 4; k++) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, main)) main = k;
        if (limbs.has(m.skeleton.bones[skinIndex.getComponent(i, main)]!)) continue;
        m.getVertexPosition(i, v);
        const p = this.group.worldToLocal(m.localToWorld(v));
        if (p.y < BACKREST.from || p.y > BACKREST.to || Math.abs(p.x) > 0.2) continue;
        gap = Math.min(gap, p.z - (BACKREST.z - (p.y - BACKREST.from) * BACKREST.slope));
      }
    });
    return Number.isFinite(gap) ? Math.max(-0.05, Math.min(0.25, gap - 0.01)) : 0;
  }

  /** How far up a side-sleeping body goes so its lowest part rests on the mattress, per side down (measured once). */
  private sideLift: (number | null)[] = [null, null];

  /** The bones of both hands and their fingers (they never carry the body: long fingers hanging down propped it up). */
  private handBones: Set<Object3D> | null = null;

  /** How far the lowest point of the skin is above `seat` (group frame), from every third vertex, hands and `skip` left out. */
  private lowestAbove(seat: number, skip: Object3D | null = null): number {
    this.group.updateMatrixWorld(true);
    if (!this.handBones) {
      const set = new Set<Object3D>();
      for (const h of this.rig.hand) h?.traverse((b) => void set.add(b));
      this.handBones = set;
    }
    const hands = this.handBones;
    const skipped = new Set<Object3D>();
    skip?.traverse((b) => void skipped.add(b));
    let low = Infinity;
    const v = new Vector3();
    this.inner.traverse((o) => {
      const m = o as SkinnedMesh;
      if (!m.isSkinnedMesh || !m.visible) return;
      m.skeleton.update();
      const { skinIndex, skinWeight } = m.geometry.attributes;
      const bones = m.skeleton.bones;
      const n = m.geometry.attributes.position.count;
      for (let i = 0; i < n; i += 3) {
        if (skinIndex && skinWeight) {
          let main = 0;
          for (let k = 1; k < 4; k++) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, main)) main = k;
          const bone = bones[skinIndex.getComponent(i, main)]!;
          if (hands.has(bone) || skipped.has(bone)) continue;
        }
        m.getVertexPosition(i, v);
        low = Math.min(low, this.group.worldToLocal(m.localToWorld(v)).y);
      }
    });
    return Number.isFinite(low) ? low - seat : 0;
  }

  /** The tip of the toes in each foot's own frame (the foot's farthest skinned point), to turn the toes forward. */
  private toeTips: (Vector3 | null)[] = [null, null];
  /** The foot's turn relative to the shin in the rest pose: lying down, a detached foot keeps this angle at the ankle. */
  private ankleTurn: (Quaternion | null)[] = [null, null];
  private rest = { hipY: 0.95, ankleY: 0.08, footX: 0.1, thigh: 0.45, shin: 0.45, upperArm: 0.28, foreArm: 0.26, hipsApart: 0.2 };
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
  /** Wall clock (s): the frames stop while nobody moves, so turning over in sleep cannot use the frame time. */
  clock = (): number => performance.now() / 1000;
  /** When it lay down to sleep (clock time). */
  private sleepSince = 0;
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
    const trunk = /^(hips?|pelvis|abdomen(lower|upper)?|spine\d*|torso|chest(lower|upper)?|upperchest|neck(lower|upper)?|head|shoulder(l|r|left|right)|(left|right)shoulder|clavicle(l|r)|(l|r)collar)$/;
    inst.traverse((o) => {
      const name = norm(o.name).replace(/^(mixamorig|characterarmature)/, "");
      if ((o as Bone).isBone && trunk.test(name)) this.trunkRest.push([o as Bone, (o as Bone).quaternion.clone(), (o as Bone).position.clone()]);
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
      this.ankleTurn[s] = lower.getWorldQuaternion(new Quaternion()).invert().multiply(foot.getWorldQuaternion(new Quaternion()));
    }
    this.normalise(height);
    this.innerAt.copy(this.inner.position);
    this.measureStride();
    this.measureToes();
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
    // which way it faces, from the line between the shoulders (between the hips when it has no arms): the hips of a rest
    // pose may stand in a stride (this model's right hip is 11 cm ahead of the left), which turned the whole figure by 27°
    const [sideL, sideR] = r.upperArm[0] && r.upperArm[1] ? r.upperArm : r.upperLeg;
    if (sideL && sideR) {
      const left = sideL.getWorldPosition(new Vector3()).sub(sideR.getWorldPosition(new Vector3()));
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
        upperArm: this.rest.upperArm,
        foreArm: this.rest.foreArm,
        hipsApart: r.upperLeg[1] ? hip.distanceTo(p(r.upperLeg[1])!) : this.rest.hipsApart,
      };
    } else this.rest.hipY = height * 0.52;
    const shoulder = p(r.upperArm[0]);
    const elbow = p(r.lowerArm[0]);
    const wrist = p(r.hand[0]);
    if (shoulder && elbow && wrist) {
      this.rest.upperArm = shoulder.distanceTo(elbow);
      this.rest.foreArm = elbow.distanceTo(wrist);
    }
  }

  /** Where the toes end, per foot (see toeTips); in the rest pose. */
  private measureToes(): void {
    measure(this.inner);
    for (const s of [0, 1] as Side[]) {
      const foot = this.rig.foot[s];
      if (!foot) continue;
      const ankle = foot.getWorldPosition(new Vector3());
      let tip: Vector3 | null = null;
      let far = 0;
      const v = new Vector3();
      this.inner.traverse((o) => {
        const m = o as SkinnedMesh;
        if (!m.isSkinnedMesh) return;
        const { skinIndex, skinWeight, position } = m.geometry.attributes;
        // the foot and the bones below it: a Daz foot carries only the heel, its toes hang from Metatarsals / Toe
        const own = new Set<number>();
        foot.traverse((b) => {
          const i = m.skeleton.bones.indexOf(b as Bone);
          if (i >= 0) own.add(i);
        });
        if (!own.size || !skinIndex || !skinWeight) return;
        for (let i = 0; i < position.count; i++) {
          let main = 0;
          for (let k = 1; k < 4; k++) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, main)) main = k;
          if (!own.has(skinIndex.getComponent(i, main))) continue;
          m.getVertexPosition(i, v);
          m.localToWorld(v);
          const d = Math.hypot(v.x - ankle.x, v.z - ankle.z);
          if (d > far) [far, tip] = [d, v.clone()];
        }
      });
      if (tip) this.toeTips[s] = foot.worldToLocal(tip);
    }
  }

  /** Turn a foot about the vertical so its toes point `yaw` (radians, + = to the person's left) from straight ahead. */
  private toesTo(s: Side, yaw: number, w: number): void {
    const foot = this.rig.foot[s];
    const tip = this.toeTips[s];
    if (!foot || !tip || w <= 0.001) return;
    const a = this.body.worldToLocal(foot.getWorldPosition(new Vector3()));
    const b = this.body.worldToLocal(foot.localToWorld(tip.clone()));
    const now = Math.atan2(b.x - a.x, b.z - a.z);
    let d = yaw - now;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    turn(foot, UP, d * w, this.body);
  }

  /** Find the stride of the rest pose (see strideYaw); call after normalise, in the rest pose. */
  private measureStride(): void {
    const r = this.rig;
    const root = r.upperLeg[0]?.parent as Bone | undefined;
    if (!root?.isBone || root !== r.upperLeg[1]?.parent) return;
    const p = (b: Bone) => this.body.worldToLocal(b.getWorldPosition(new Vector3()));
    const left = p(r.upperLeg[0]!).sub(p(r.upperLeg[1]!));
    const yaw = Math.atan2(left.z, left.x);
    if (Math.abs(yaw) < 0.03) return;
    // the child of the leg root that carries the trunk (when the legs hang from the hips themselves, there is none to
    // turn back and the stride stays)
    const up = r.spine ?? r.chest;
    let trunk: Object3D | null = up;
    while (trunk && trunk.parent !== root) trunk = trunk.parent;
    if (!trunk || !(trunk as Bone).isBone) return;
    this.strideYaw = yaw;
    this.strideRoot = root;
    this.strideTrunk = trunk as Bone;
    // try the levelling once in the rest pose to see how far it moves the middle of the trunk, then undo it
    const mid = () => p(r.upperLeg[0]!).add(p(r.upperLeg[1]!)).multiplyScalar(0.5).add(r.neck ? p(r.neck) : p(this.strideTrunk!)).multiplyScalar(0.5);
    const [q0, q1] = [root.quaternion.clone(), this.strideTrunk.quaternion.clone()];
    const before = mid();
    turn(root, UP, yaw, this.body);
    turn(this.strideTrunk, UP, -yaw, this.body);
    this.strideShift.copy(before.sub(mid())).setY(0);
    root.quaternion.copy(q0);
    this.strideTrunk.quaternion.copy(q1);
    this.group.updateMatrixWorld(true);
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
  /** Whether a spot is free of the other people (set by the view); taken spots are passed over while another fits. */
  free: (spot: AvatarSpot) => boolean = () => true;

  /** The spot it is in or on its way to (none while away). */
  claim(): AvatarSpot | null {
    return this.phase === "hidden" ? null : (this.target ?? this.spot);
  }

  /** Asleep, or on its way to bed. */
  asleep(): boolean {
    return this.claim()?.pose === "sleep";
  }

  /** The plan was drawn anew: take the new spot objects, keep doing what it does (no sensor to choose by). */
  respot(spots: AvatarSpot[], nav: (floorId: string) => NavGrid | null): void {
    this.navFor = nav;
    if (spots === this.spots) return;
    const same = (x: AvatarSpot | null) => (x ? (spots.find((p) => p.id === x.id) ?? null) : null);
    this.spot = same(this.spot);
    this.target = same(this.target);
    if (this.phase === "posed" && !this.spot && this.w > 0) this.phase = "rising";
    this.spots = spots;
  }

  /** Go to this spot (a person without a sensor, sent by the view). */
  visit(spot: AvatarSpot, spots: AvatarSpot[], nav: (floorId: string) => NavGrid | null): void {
    this.respot(spots, nav);
    const there = this.spots.find((p) => p.id === spot.id) ?? spot;
    this.state = `@${there.id}`;
    if (this.claim() === there) return;
    this.goTo(there);
  }

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
    let want = spotFor(this.spots, s, next ? null : current, this.wander, this.free);
    if (next && want === current) want = spotFor(this.spots, s, null, ++this.wander, this.free);
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
          this.sleepSince = this.clock();
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
        moving = this.spot?.pose !== "sleep" || this.sleepTurn().turning;
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
    this.inner.position.copy(this.innerAt);
    this.phone.visible = false;
    if (!spot || w <= 0.001) {
      this.group.updateMatrixWorld(true);
      return;
    }
    const t = this.t;
    // feet as the clip has them, to keep them flat after the legs moved
    const feetWorld = r.foot.map((f) => (f ? f.getWorldQuaternion(new Quaternion()) : null));
    let squat = 0;
    // sleeping on a side: how far (0 on the back … 1 on the side) and which side is down (0 = left)
    let side = 0;
    let onSide = 0;
    let down: Side = 0;
    if (pose === "sleep") {
      // tip over backwards onto the bed: the head towards the spot's back, the hips over its middle
      // and every 20 s it turns over about its spine: on the back, the left side, the back, the right side …
      const th = (-Math.PI / 2) * w;
      const roll = this.sleepTurn().roll * w;
      // the arms and legs follow the turn late (cubed): drawn up while the body still lies half on its back, the
      // upper knee would go through the mattress
      onSide = Math.abs(Math.sin(roll));
      side = onSide ** 3;
      down = roll > 0 ? 0 : 1;
      // on its side the shoulder and hip carry it: lifted onto them once the limbs are set (see the end)
      const hipsTo = rest.hipY + (spot.seat + 0.12 - rest.hipY) * w;
      body.rotation.set(th, roll, 0);
      body.position.set(0, hipsTo - rest.hipY * Math.cos(th), -rest.hipY * Math.sin(th));
    } else if (pose === "sit") {
      // an armchair: back into it, the hips by the backrest
      const k = rest.hipY / 0.92;
      body.position.y = (spot.seat + LOUNGE.hips * k - rest.hipY) * w;
      body.position.z = -LOUNGE.back * k * w;
    } else if (pose === "sit_type" || pose === "phone") {
      body.position.y = (spot.seat + 0.1 - rest.hipY) * w;
      body.position.z = -0.04 * w;
    } else if (pose === "squat") {
      squat = ((1 - Math.cos((2 * Math.PI * t) / 3.2)) / 2) * w;
      body.position.set(0, -0.42 * squat, -0.12 * squat);
    }
    // the turns and the place (a Mixamo idle sways the hips sideways onto one leg, which tipped one side into the bed;
    // a Daz idle sways them 12 cm, which slid a seated figure across the chair and back once per loop)
    if (pose === "sleep" || pose === "sit")
      for (const [bone, q, at] of this.trunkRest) {
        bone.quaternion.slerp(q, w);
        bone.position.lerp(at, w);
      }
    else if (pose === "sit_type" || pose === "phone") for (const [bone, , at] of this.trunkRest) bone.position.lerp(at, w);
    this.group.updateMatrixWorld(true);
    if (this.strideRoot && (pose === "sit" || pose === "sit_type" || pose === "phone" || pose === "squat" || pose === "sleep")) {
      // level the hips of a rest pose in a stride; the trunk keeps its turn, the figure stays centred
      this.inner.position.copy(this.innerAt).addScaledVector(this.strideShift, w);
      this.group.updateMatrixWorld(true);
      turn(this.strideRoot, UP, this.strideYaw * w, body);
      turn(this.strideTrunk, UP, -this.strideYaw * w, body);
    }
    const sit = pose === "sit" || pose === "sit_type" || pose === "phone";

    // ---- spine and head
    if (pose === "sit_type" || pose === "stand_type") turn(r.chest ?? r.spine, LEFT, 0.12 * w, body);
    if (pose === "sit") {
      // leaning back against the backrest (the pelvis tips back with the trunk), the head up again to look ahead
      turn(r.hips, LEFT, -LOUNGE.pelvis * w, body);
      turn(r.spine, LEFT, -LOUNGE.recline * w, body);
      if (r.chest !== r.spine) turn(r.chest, LEFT, -LOUNGE.chest * w, body);
      // spines differ (a Mixamo one has three bones): measure the trunk's lean and tip the pelvis by what is missing,
      // then bend the neck until the head is upright again
      const backward = (from: Object3D | null, to: Object3D | null) => {
        if (!from || !to) return null;
        const a = body.worldToLocal(from.getWorldPosition(new Vector3()));
        const b = body.worldToLocal(to.getWorldPosition(new Vector3()));
        return Math.atan2(a.z - b.z, b.y - a.y);
      };
      const lean = backward(r.hips, r.neck);
      if (lean !== null) turn(r.hips, LEFT, -(LOUNGE.lean * w - lean), body);
      const tilt = backward(r.neck, r.head);
      if (tilt !== null) turn(r.neck, LEFT, tilt - LOUNGE.head * w, body);
    }
    // an armchair: slide back until the back rests against the backrest (a slim figure was left well in front of it);
    // the skin is measured once per person (before the legs, which then reach the same place on the floor)
    if (pose === "sit" && w > 0.01) {
      let shift = this.loungeShift;
      if (shift === null) {
        shift = this.backrestGap();
        if (w > 0.999 && this.phase === "posed") this.loungeShift = shift;
      }
      body.position.z -= shift * w;
      this.group.updateMatrixWorld(true);
    }

    if (pose === "phone") {
      // leaning forward, the elbows on the knees; the head looks down at the phone in the hands
      turn(r.spine, LEFT, PHONE_LEAN.spine * w, body);
      if (r.chest !== r.spine) turn(r.chest, LEFT, PHONE_LEAN.chest * w, body);
      turn(r.neck, LEFT, PHONE_LEAN.neck * w, body);
      turn(r.head, LEFT, PHONE_LEAN.head * w, body);
    }
    if (pose === "squat") turn(r.spine, LEFT, 0.45 * squat, body);
    if (pose === "interact") turn(r.chest ?? r.spine, LEFT, 0.1 * w, body);

    // ---- legs
    for (const s of [0, 1] as Side[]) {
      const sign = SIGN[s];
      if (sit) {
        const floorY = -body.position.y;
        if (pose === "sit") {
          // an armchair: the legs stretched out, the feet on the floor well beyond the front of the seat, a little apart;
          // legs too short for that from the backrest (the seat is deeper than the thighs) come up onto the seat instead
          const k = rest.hipY / 0.92;
          const onFloor = v3(sign * rest.footX * LOUNGE.feetApart, rest.ankleY + floorY, (LOUNGE.feet * k - body.position.z) * w);
          const hipAt = r.upperLeg[s] ? body.worldToLocal(r.upperLeg[s]!.getWorldPosition(new Vector3())) : null;
          if (hipAt && hipAt.distanceTo(onFloor) > (rest.thigh + rest.shin) * 0.97) {
            // the knees together and tipped to one side, the feet side by side (spread apart, the legs looked like a frog's)
            const onSeat = v3(sign * rest.footX * 0.9 + LOUNGE.tuck * k, SEAT.top + rest.ankleY - body.position.y, SEAT.front - 0.1 - body.position.z);
            this.legTo(s, onFloor.lerp(onSeat, w), v3(-0.5, 1, 0.1), w);
          } else this.legTo(s, onFloor, v3(sign * 0.2, 1, 0.3), w);
        } else {
          // thighs forward, shins down to the floor in front of the seat
          this.legTo(s, v3(sign * rest.footX * 1.15, rest.ankleY + floorY, (rest.thigh * 0.95 + 0.06) * w), v3(0, 0.3, 1), w);
        }
      } else if (pose === "squat") {
        this.legTo(s, v3(sign * rest.footX * (1 + 0.4 * w), rest.ankleY - body.position.y, -body.position.z), v3(sign * 0.25, 0.2, 1), w);
      } else if (pose === "sleep") {
        // on the back the legs lie straight; on a side the upper thigh is drawn up past a right angle and falls forward
        // onto the mattress, its shin lying along it, and the lower leg is bent a little
        const top = s !== down;
        // the upper knee drops onto the mattress about as far as the hips are apart (lower: it would carry the body)
        const fall = Math.min(0.8, Math.max(0.2, rest.hipsApart / rest.thigh));
        const thigh = top ? v3(-sign * fall, 0.1, Math.sqrt(Math.max(0.05, 1 - fall * fall - 0.01))) : v3(sign * 0.04, -0.95, 0.3);
        const shin = top ? v3(sign * 0.05, -0.95, -0.25) : v3(sign * 0.02, -0.95, -0.3);
        aim(r.upperLeg[s], r.lowerLeg[s], v3(sign * 0.06, -1, 0.02).lerp(thigh, side), body, w);
        aim(r.lowerLeg[s], this.ankles[s], v3(sign * 0.02, -1, 0).lerp(shin, side), body, w);
      }
      // a foot of an IK rig goes along with the shin it no longer follows by itself
      const foot = r.foot[s];
      const ankle = this.ankles[s];
      if ((sit || pose === "squat" || pose === "sleep") && this.detachedFeet[s] && foot?.parent && ankle) {
        foot.position.copy(foot.parent.worldToLocal(ankle.getWorldPosition(_a)));
        foot.updateMatrixWorld(true);
      }
      if (pose !== "sleep") holdWorld(foot, feetWorld[s]!, w);
      // sitting or squatting the toes point ahead, a little out (the idle clip's stance turned the left foot 58° out)
      if (sit || pose === "squat") this.toesTo(s, sign * TOE_OUT, w);
      else if (this.detachedFeet[s] && foot && r.lowerLeg[s] && this.ankleTurn[s]) {
        // asleep the foot goes along with the shin (the clip's standing foot pointed into the mattress on one side)
        holdWorld(foot, r.lowerLeg[s]!.getWorldQuaternion(new Quaternion()).multiply(this.ankleTurn[s]!), w);
      }
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
          // the elbows rest on the thighs just behind the knees, the forearms rise to the phone; both hands hold it
          // from behind, the palms towards the face and the fingers up its back; the right thumb scrolls now and then
          const scroll = s === 1 ? 0.06 * Math.max(0, Math.sin(t * 1.7)) ** 8 : 0;
          const knee = r.lowerLeg[s] ? body.worldToLocal(r.lowerLeg[s]!.getWorldPosition(new Vector3())) : null;
          const shoulder = up ? body.worldToLocal(up.getWorldPosition(new Vector3())) : null;
          const at = this.phoneAt(knee);
          const { facing, along } = this.phoneFrame(at);
          if (knee && shoulder) aim(up, low, knee.clone().add(PHONE_ELBOW).setX(knee.x - sign * 0.02).sub(shoulder), body, w);
          else aim(up, low, v3(sign * 0.1, -0.9, 0.42), body, w);
          const elbow = low ? body.worldToLocal(low.getWorldPosition(new Vector3())) : null;
          const wrist = at.clone().addScaledVector(along, -0.06 + scroll * 0.15).addScaledVector(facing, -0.035).setX(at.x + sign * 0.05);
          if (elbow) aim(low, hand, wrist.sub(elbow), body, w);
          orient(hand, r.middle[s], r.index[s], r.pinky[s], along.clone().setX(-sign * 0.15), palmAcross(s, facing.clone().setX(-sign * 0.25), along), body, w);
          break;
        }
        case "sit": {
          // an armchair: the arms relaxed, the hands lying on top of the thighs, the elbows a little out
          const k = rest.hipY / 0.92;
          const at = (b: Object3D | null) => (b ? body.worldToLocal(b.getWorldPosition(new Vector3())) : null);
          const [hip, knee, shoulder] = [at(r.upperLeg[s]), at(r.lowerLeg[s]), at(up)];
          if (hip && knee && shoulder) {
            const onThigh = hip.lerp(knee, 0.55).add(v3(0, LOUNGE.handUp * k, 0));
            const elbowAt = shoulder.clone().lerp(onThigh, 0.5).add(v3(sign * 0.08 * k, -0.04 * k, -0.04 * k));
            aim(up, low, elbowAt.sub(shoulder), body, w);
            const elbow = at(low);
            if (elbow) aim(low, hand, onThigh.sub(elbow), body, w);
          }
          break;
        }
        case "sleep": {
          // on the back the arms lie relaxed on the mattress beside the body (the shoulders lie higher than the
          // mattress, so the arms slope down to it); on a side the lower one is under the pillow and the upper one is
          // bent at the elbow (about 100°): the elbow down on the mattress in front of the chest, the hand on the pillow
          const top = s !== down;
          const upper = top ? v3(-sign * 0.7, 0.05, 0.7) : v3(sign * 0.35, 0.85, 0.35);
          const fore = top ? v3(-sign * 0.55, 0.75, -0.35) : v3(-sign * 0.45, 0.55, 0.6);
          // on the back the upper arm slopes from the shoulder down so the elbow lies on the mattress
          const k = rest.hipY / 0.92;
          const shoulderUp = up ? this.group.worldToLocal(up.getWorldPosition(_a)).y - spot.seat : 0;
          const sine = -Math.min(0.75, Math.max(0, shoulderUp - SLEEP_REST.elbow * k) / Math.max(0.05, rest.upperArm));
          const slope = (sine * Math.hypot(0.3, 1)) / Math.sqrt(1 - sine * sine);
          aim(up, low, v3(sign * 0.3, -1, slope).lerp(upper, side).normalize(), body, w);
          aim(low, hand, v3(sign * 0.12, -1, -0.05).lerp(fore, side).normalize(), body, w);
          // on the back the hands lie flat on the mattress, the fingers along the forearm
          const flat = v3(sign * BACK_HAND_DIR[0], BACK_HAND_DIR[1], BACK_HAND_DIR[2]);
          orient(hand, r.middle[s], r.index[s], r.pinky[s], flat, palmAcross(s, v3(0, 0, -1), flat), body, w * (1 - side));
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

    // ---- asleep on a side: it rests on whatever part of it touches the mattress first. The skin is measured (any model's
    // build: broad shoulders, wide hips, thick thighs) while it turns, and remembered per side once it lies there
    if (pose === "sleep" && onSide > 0.01) {
      const k = rest.hipY / 0.92;
      let lift = this.sideLift[down];
      if (lift === null) {
        lift = SLEEP_SINK * k - this.lowestAbove(spot.seat);
        if (onSide > 0.999 && this.phase === "posed") this.sideLift[down] = lift;
      }
      body.position.y += lift * onSide;
      this.group.updateMatrixWorld(true);
    }

    // ---- the phone, in both hands and turned to the face: put where the hands really are, a little in front of the
    // palms (towards the face) so they hold it from behind and never cover it
    if (pose === "phone" && w > 0.6) {
      const knee = r.lowerLeg[0] ? body.worldToLocal(r.lowerLeg[0].getWorldPosition(new Vector3())) : null;
      const { facing, along } = this.phoneFrame(this.phoneAt(knee));
      const palms = r.middle[0] && r.middle[1] ? [r.middle[0], r.middle[1]] : r.hand[0] && r.hand[1] ? [r.hand[0], r.hand[1]] : null;
      if (palms) {
        const mid = body.worldToLocal(palms[0]!.getWorldPosition(_a)).add(body.worldToLocal(palms[1]!.getWorldPosition(_b))).multiplyScalar(0.5);
        this.phone.position.copy(mid).addScaledVector(facing, PHONE_GAP).addScaledVector(along, 0.01);
      } else this.phone.position.copy(this.phoneAt(knee));
      this.phone.visible = true;
      if (r.head) this.phone.lookAt(r.head.getWorldPosition(_d));
    }
  }

  /**
   * Turning over in sleep, by the clock: 20 s on the left side (right leg up), then on the back, on the right side, on
   * the back and so on; each turn takes SLEEP_TURN seconds. The roll (radians, + = left side down), whether it turns.
   */
  sleepTurn(): SleepTurn {
    return sleepTurnAt(this.clock() - this.sleepSince);
  }

  /** Seconds until it needs frames again while it rests (the next turn in sleep), or null. */
  wakeIn(): number | null {
    return this.phase === "posed" && this.spot?.pose === "sleep" ? this.sleepTurn().next : null;
  }

  /** Where the phone is held (body frame): above the knees, where the forearms rising from them meet. */
  private phoneAt(knee: Vector3 | null): Vector3 {
    const k = this.rest.hipY / 0.92;
    if (!knee) return new Vector3(0, 1.3 * k, 0.3 * k);
    return new Vector3(0, knee.y + PHONE_AT.y * k, knee.z + PHONE_AT.z * k);
  }

  /** The phone's frame (body frame): `facing` from it to the eyes, `along` up its face. */
  private phoneFrame(at: Vector3): { facing: Vector3; along: Vector3 } {
    const head = this.rig.head ? this.body.worldToLocal(this.rig.head.getWorldPosition(new Vector3())) : at.clone().add(v3(0, 0.4, -0.2));
    const facing = head.add(v3(0, 0.06, 0.1)).sub(at).normalize();
    const along = v3(0, 1, 0).addScaledVector(facing, -facing.y).normalize();
    return { facing, along };
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
