// Camera modes following a car pose. Frame-rate-independent smoothing: a = 1 - exp(-k * dt).
import * as THREE from 'three';
import type { CarPose } from '../types';
import { CAR_ANCHORS } from './carMesh';

export type CameraMode =
  | 'chase' | 'chaseFar' | 'chaseFixed' | 'chaseHigh' | 'heli'
  | 'tcam' | 'cockpit' | 'helmet' | 'nose' | 'wheel' | 'rear' | 'tv';

/** Cycle order and on-screen names. */
export const CAMERA_MODES: { mode: CameraMode; label: string }[] = [
  { mode: 'chase', label: 'Chase' },
  { mode: 'chaseFar', label: 'Chase (far)' },
  { mode: 'chaseFixed', label: 'Chase (locked)' },
  { mode: 'chaseHigh', label: 'Chase (high)' },
  { mode: 'heli', label: 'Helicopter' },
  { mode: 'tcam', label: 'T-cam' },
  { mode: 'cockpit', label: 'Cockpit' },
  { mode: 'helmet', label: 'Helmet' },
  { mode: 'nose', label: 'Nose' },
  { mode: 'wheel', label: 'Wheel' },
  { mode: 'rear', label: 'Rear-facing' },
  { mode: 'tv', label: 'TV' },
];

/** Spring-follow chase variants: distance back, height, look-ahead, yaw stiffness (Infinity = locked). */
const CHASE: Record<string, { back: number; up: number; ahead: number; lookUp: number; yawK: number; fov: number; fovGain: number }> = {
  chase: { back: 6.5, up: 2.2, ahead: 4, lookUp: 1.0, yawK: 4, fov: 62, fovGain: 22 },
  chaseFar: { back: 11, up: 3.4, ahead: 6, lookUp: 1.0, yawK: 3, fov: 58, fovGain: 16 },
  chaseFixed: { back: 7, up: 2.0, ahead: 6, lookUp: 0.9, yawK: Infinity, fov: 64, fovGain: 18 },
  chaseHigh: { back: 9, up: 6.5, ahead: 4, lookUp: 0.4, yawK: 4, fov: 60, fovGain: 10 },
  heli: { back: 14, up: 26, ahead: 10, lookUp: 0, yawK: 2, fov: 50, fovGain: 0 },
};

const TV_ASIDE = 15;
const TV_UP = 6;
const TV_LEAD = 110;      // how far ahead of the car a new spot is placed
const TV_REPLACE = 250;   // re-place when the car is further than this

const STORAGE_KEY = 'f1.camera';

const damp = (k: number, dt: number): number => 1 - Math.exp(-k * dt);

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class CameraRig {
  mode: CameraMode = 'chase';

  private camera: THREE.PerspectiveCamera;
  private snap = true;
  private chaseYaw = 0;
  private lookBackAmt = 0;           // 0..1 smoothed
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private fov = 65;
  private tvSpot = new THREE.Vector3();
  private tvHas = false;
  private tvSide = 1;
  private headSway = new THREE.Vector3();   // helmet cam g-force lean
  private lastVel = new THREE.Vector3();

  private fwd = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private flipQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  private lbQ = new THREE.Quaternion();
  private invQ = new THREE.Quaternion();

  // Local (car-frame) mount points: +X left, +Y up, +Z forward.
  private tcamEye = new THREE.Vector3(0, CAR_ANCHORS.airbox.y + 0.15, CAR_ANCHORS.airbox.z - 0.1);
  private cockpitEye = new THREE.Vector3(0, 0.9, 0.02);       // just ahead of the helmet, over the halo
  private helmetEye = new THREE.Vector3(0, 0.84, -0.06);      // inside the helmet: sees the halo and mirrors
  private noseEye = new THREE.Vector3(0, CAR_ANCHORS.nose.y + 0.1, CAR_ANCHORS.nose.z + 0.1);
  private wheelEye = new THREE.Vector3(0.62, 0.55, 0.55);     // left sidepod, looking at the front-left tyre
  private rearEye = new THREE.Vector3(0, 0.95, -2.05);        // on the rear wing, facing backwards

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as CameraMode | null;
      if (saved && CAMERA_MODES.some((m) => m.mode === saved)) this.mode = saved;
    } catch { /* storage unavailable */ }
  }

  get label(): string {
    return CAMERA_MODES.find((m) => m.mode === this.mode)?.label ?? this.mode;
  }

  /** Next (dir 1) or previous (dir -1) camera. Returns the new camera's label. */
  cycle(dir: 1 | -1 = 1): string {
    const i = CAMERA_MODES.findIndex((m) => m.mode === this.mode);
    const n = CAMERA_MODES.length;
    this.setMode(CAMERA_MODES[(i + dir + n) % n].mode);
    return this.label;
  }

  setMode(m: CameraMode): void {
    this.mode = m;
    this.snap = true;
    this.tvHas = false;
    try { localStorage.setItem(STORAGE_KEY, m); } catch { /* storage unavailable */ }
  }

  /** Force the next update to jump straight to the target (e.g. after a teleport / restart). */
  reset(): void {
    this.snap = true;
    this.tvHas = false;
  }

  update(dt: number, pose: CarPose, lookBack: boolean, speedKmh: number): void {
    dt = Math.min(Math.max(dt, 0), 0.25);
    const snap = this.snap;
    this.snap = false;

    // car heading (yaw about +Y) from its forward axis
    this.fwd.set(0, 0, 1).applyQuaternion(pose.quaternion);
    const carYaw = Math.atan2(this.fwd.x, this.fwd.z);

    this.lookBackAmt += ((lookBack ? 1 : 0) - this.lookBackAmt) * (snap ? 1 : damp(12, dt));
    const lb = this.lookBackAmt;
    const speed01 = Math.min(Math.max(speedKmh, 0), 350) / 350;
    let targetFov = 70;

    switch (this.mode) {
      case 'chase':
      case 'chaseFar':
      case 'chaseFixed':
      case 'chaseHigh':
      case 'heli': {
        const c = CHASE[this.mode];
        this.chaseFollow(dt, pose, carYaw, lb, snap, c);
        targetFov = c.fov + speed01 * c.fovGain;
        break;
      }
      case 'tcam':
        this.rigid(pose, this.tcamEye, lb);
        targetFov = 80 + speed01 * 8;
        break;
      case 'cockpit':
        this.rigid(pose, this.cockpitEye, lb);
        targetFov = 88;
        break;
      case 'helmet':
        this.helmet(dt, pose, lb, snap);
        targetFov = 92;
        break;
      case 'nose':
        this.rigid(pose, this.noseEye, lb);
        targetFov = 85;
        break;
      case 'wheel':
        this.rigid(pose, this.wheelEye, lb);
        targetFov = 78;
        break;
      case 'rear':
        // Mounted facing backwards; "look back" turns it to face forwards.
        this.rigid(pose, this.rearEye, 1 - lb);
        targetFov = 75;
        break;
      case 'tv':
        this.updateTv(dt, pose, snap);
        targetFov = this.fov; // set by tv logic
        break;
    }

    // FOV smoothing
    const f = snap || this.mode === 'tv' ? targetFov : this.camera.fov + (targetFov - this.camera.fov) * damp(5, dt);
    if (Math.abs(f - this.camera.fov) > 0.01) {
      this.camera.fov = f;
      this.camera.updateProjectionMatrix();
    }
  }

  private chaseFollow(dt: number, pose: CarPose, carYaw: number, lb: number, snap: boolean,
                      c: { back: number; up: number; ahead: number; lookUp: number; yawK: number }): void {
    const locked = !Number.isFinite(c.yawK);
    if (snap || locked) this.chaseYaw = carYaw;
    else this.chaseYaw = carYaw - wrapPi(carYaw - this.chaseYaw) * Math.exp(-c.yawK * dt);
    const yaw = this.chaseYaw + Math.PI * lb;
    const sx = Math.sin(yaw), cz = Math.cos(yaw);
    // desired camera spot: behind the (smoothed) heading, above the car
    this.tmp.set(pose.position.x - sx * c.back, pose.position.y + c.up, pose.position.z - cz * c.back);
    if (snap || locked) this.pos.copy(this.tmp);
    else this.pos.lerp(this.tmp, damp(14, dt));
    this.pos.y = Math.max(this.pos.y, pose.position.y + 0.5);
    this.tmp2.set(pose.position.x + sx * c.ahead, pose.position.y + c.lookUp, pose.position.z + cz * c.ahead);
    if (snap || locked) this.look.copy(this.tmp2);
    else this.look.lerp(this.tmp2, damp(18, dt));
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  /** Driver's-eye view with the head leaning against braking/cornering g-forces. */
  private helmet(dt: number, pose: CarPose, lb: number, snap: boolean): void {
    // Acceleration in the car frame from the velocity change.
    const acc = this.tmp2.copy(pose.velocity).sub(this.lastVel).divideScalar(Math.max(dt, 1e-3));
    this.lastVel.copy(pose.velocity);
    this.invQ.copy(pose.quaternion).invert();
    acc.applyQuaternion(this.invQ);
    // Head moves opposite to the acceleration (~1 cm per g, capped).
    const g = 9.81;
    const target = this.tmp.set(
      THREE.MathUtils.clamp(-acc.x / g * 0.012, -0.05, 0.05),
      0,
      THREE.MathUtils.clamp(-acc.z / g * 0.01, -0.05, 0.05),
    );
    if (snap) this.headSway.set(0, 0, 0);
    else this.headSway.lerp(target, damp(6, dt));
    this.tmp.copy(this.helmetEye).add(this.headSway);
    this.rigid(pose, this.tmp, lb);
  }

  /** Camera rigidly attached to the car at a local offset (looking forward, or back when lookBack). */
  private rigid(pose: CarPose, local: THREE.Vector3, lb: number): void {
    const p = this.tmp.copy(local).applyQuaternion(pose.quaternion).add(pose.position);
    this.camera.position.copy(p);
    // camera looks along -Z; car forward is +Z -> flip 180 about Y, plus lookBack blend
    this.lbQ.identity().slerp(this.flipQ, lb);
    this.tmpQ.copy(pose.quaternion).multiply(this.flipQ).multiply(this.lbQ);
    this.camera.quaternion.copy(this.tmpQ);
  }

  private updateTv(dt: number, pose: CarPose, snap: boolean): void {
    const p = pose.position;
    const dist = this.tvHas ? this.tvSpot.distanceTo(p) : Infinity;
    if (!this.tvHas || dist > TV_REPLACE) {
      const v = this.tmp.copy(pose.velocity);
      v.y = 0;
      if (v.lengthSq() < 4) v.copy(this.fwd).setY(0);
      v.normalize();
      // side vector (left of travel)
      const left = this.tmp2.set(-v.z, 0, v.x);
      this.tvSide = -this.tvSide;
      this.tvSpot.set(
        p.x + v.x * TV_LEAD + left.x * TV_ASIDE * this.tvSide,
        p.y + TV_UP,
        p.z + v.z * TV_LEAD + left.z * TV_ASIDE * this.tvSide,
      );
      this.tvHas = true;
      this.look.copy(p);
      this.pos.copy(this.tvSpot);
    }
    this.pos.copy(this.tvSpot);
    this.tmp.copy(p).y += 0.6;
    if (snap) this.look.copy(this.tmp);
    else this.look.lerp(this.tmp, damp(10, dt));
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    // zoom: keep ~10 m of scene framed around the car
    const d = Math.max(10, this.pos.distanceTo(p));
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(6 / d));
    this.fov += (THREE.MathUtils.clamp(fov, 8, 55) - this.fov) * (snap ? 1 : damp(6, dt));
  }
}
