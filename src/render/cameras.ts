// Camera modes following a car pose. Frame-rate-independent smoothing: a = 1 - exp(-k * dt).
import * as THREE from 'three';
import type { CarPose } from '../types';
import { CAR_ANCHORS } from './carMesh';

export type CameraMode = 'chase' | 'tcam' | 'cockpit' | 'nose' | 'tv';

const MODES: CameraMode[] = ['chase', 'tcam', 'cockpit', 'nose', 'tv'];

const CHASE_BACK = 6.5;
const CHASE_UP = 2.2;
const TV_ASIDE = 15;
const TV_UP = 6;
const TV_LEAD = 110;      // how far ahead of the car a new spot is placed
const TV_REPLACE = 250;   // re-place when the car is further than this

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

  private fwd = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private flipQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  private lbQ = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  cycle(): void {
    this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]);
  }

  setMode(m: CameraMode): void {
    this.mode = m;
    this.snap = true;
    this.tvHas = false;
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
    let targetFov = 70;

    switch (this.mode) {
      case 'chase': {
        if (snap) this.chaseYaw = carYaw;
        else this.chaseYaw = carYaw - wrapPi(carYaw - this.chaseYaw) * Math.exp(-4 * dt);
        const yaw = this.chaseYaw + Math.PI * lb;
        const sx = Math.sin(yaw), cz = Math.cos(yaw);
        // desired camera spot: behind the (smoothed) heading, above the car
        this.tmp.set(
          pose.position.x - sx * CHASE_BACK,
          pose.position.y + CHASE_UP,
          pose.position.z - cz * CHASE_BACK,
        );
        if (snap) this.pos.copy(this.tmp);
        else this.pos.lerp(this.tmp, damp(14, dt));
        this.pos.y = Math.max(this.pos.y, pose.position.y + 0.5);
        this.tmp2.set(pose.position.x + sx * 4, pose.position.y + 1.0, pose.position.z + cz * 4);
        if (snap) this.look.copy(this.tmp2);
        else this.look.lerp(this.tmp2, damp(18, dt));
        this.camera.position.copy(this.pos);
        this.camera.lookAt(this.look);
        targetFov = 62 + Math.min(Math.max(speedKmh, 0), 350) / 350 * 22;
        break;
      }
      case 'tcam': {
        this.rigid(pose, new THREE.Vector3(0, CAR_ANCHORS.airbox.y + 0.15, CAR_ANCHORS.airbox.z - 0.1), lb);
        targetFov = 80 + Math.min(Math.max(speedKmh, 0), 350) / 350 * 8;
        break;
      }
      case 'cockpit': {
        this.rigid(pose, this.cockpitEye, lb);
        targetFov = 88;
        break;
      }
      case 'nose': {
        this.rigid(pose, this.noseEye, lb);
        targetFov = 85;
        break;
      }
      case 'tv': {
        this.updateTv(dt, pose, snap);
        targetFov = this.fov; // set by tv logic
        break;
      }
    }

    // FOV smoothing
    const f = snap || this.mode === 'tv' ? targetFov : this.camera.fov + (targetFov - this.camera.fov) * damp(5, dt);
    if (Math.abs(f - this.camera.fov) > 0.01) {
      this.camera.fov = f;
      this.camera.updateProjectionMatrix();
    }
  }

  // Cockpit eye: just ahead of the helmet (helmet centre z=-0.14, r=0.12), looking over the halo.
  private cockpitEye = new THREE.Vector3(0, 0.9, 0.02);
  // Nose camera sits above the nose, behind the tip.
  private noseEye = new THREE.Vector3(0, CAR_ANCHORS.nose.y + 0.1, CAR_ANCHORS.nose.z + 0.1);

  /** Camera rigidly attached to the car at a local offset (looking forward, or back when lookBack). */
  private rigid(pose: CarPose, local: THREE.Vector3, lb: number): void {
    this.tmp.copy(local).applyQuaternion(pose.quaternion).add(pose.position);
    this.camera.position.copy(this.tmp);
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
