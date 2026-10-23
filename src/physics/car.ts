// Vehicle physics: rigid body + 4 raycast wheels + Pacejka tyres + aero + 2026 powertrain.
// Axes: +Y up, car local +X left, +Z forward. Wheel order FL FR RL RR. Allocation-free in step().

import { Quaternion, Vector3, Matrix4 } from 'three';
import type {
  CarPose, CarSetup, Controls, Environment, GroundQuery, GroundSample, SurfaceType, Telemetry,
  TeamPerformance, TyreCompound, TyreState,
} from '../types';
import {
  longitudinalStiffness, newTyre, stepTyre, surfaceGrip, surfaceRollingDrag, tyreForce, wetnessGrip,
} from './tyre';

export interface CarParams {
  massKg: number;
  wheelbaseM: number;
  trackFrontM: number;
  trackRearM: number;
  cgHeightM: number;
  weightDistFront: number;
  inertia: [number, number, number]; // about local X (pitch), Y (yaw), Z (roll)
  wheelRadiusM: number;
  maxSteerDeg: number;
  icePowerKw: number;
  ersPowerKw: number;
  ersCapacityMJ: number;
  maxRpm: number;
  gearRatios: number[];
  finalDrive: number;
  dragCoef: number;
  dragCoefStraight: number;
  liftCoef: number;
  liftCoefStraight: number;
  aeroBalanceFront: number;
}

export const DEFAULT_CAR_PARAMS: CarParams = {
  massKg: 768,
  wheelbaseM: 3.4,
  trackFrontM: 1.60,
  trackRearM: 1.55,
  cgHeightM: 0.28,
  weightDistFront: 0.445,
  inertia: [1050, 1150, 320],
  wheelRadiusM: 0.36,
  maxSteerDeg: 17,
  icePowerKw: 400,
  ersPowerKw: 350,
  ersCapacityMJ: 4,
  maxRpm: 11500,
  gearRatios: [4.26, 3.58, 3.01, 2.53, 2.12, 1.78, 1.50, 1.26],
  finalDrive: 3.5,
  dragCoef: 1.10,
  dragCoefStraight: 0.75,
  liftCoef: 3.5,
  liftCoefStraight: 1.9,
  aeroBalanceFront: 0.40,
};

export function defaultSetup(): CarSetup {
  return {
    frontWing: 5, rearWing: 5, frontArb: 6, rearArb: 6, frontSpring: 6, rearSpring: 6,
    frontRideHeightMm: 25, rearRideHeightMm: 47,
    frontCamberDeg: -3.0, rearCamberDeg: -1.5, frontToeDeg: 0.1, rearToeDeg: 0.3,
    brakeBias: 0.56, brakePressure: 0.9, diffOnThrottle: 0.55, diffOffThrottle: 0.4,
    tyrePressurePsi: 23, fuelKg: 60, startCompound: 'medium',
  };
}

// ---------------------------------------------------------------- constants
const G = 9.81;
const RHO = 1.2;
const IDLE_RPM = 4500;
const LAUNCH_RPM = 7500;
const SHIFT_TIME = 0.04;
const SUSP_FREE = 0.10;        // free suspension length (ray start to hub), m
const TRAVEL = 0.032;          // bump-stop engages beyond this compression, m
const BUMP_K = 2.5e6;
const WHEEL_INERTIA = 1.6;     // kg m^2 incl. rotating driveline share
const V_MIN_SLIP = 4.0;        // slip denominator floor, m/s
const BRAKE_TORQUE_MAX = 25000; // total wheel brake torque at pressure 1.0, Nm
const ERS_HARVEST_MAX_W = 350e3;
const BODY_E = 0.2;

const DEG = Math.PI / 180;

// scratch (module-level; physics is single-threaded)
const _m4 = new Matrix4();

interface Wheel {
  lx: number; lz: number; ay: number; front: boolean; left: number;
  omega: number; spin: number;
  comp: number; compRate: number; load: number;
  slip: number; surf: SurfaceType; contact: boolean;
  hint: { idx: number };
  // per-step scratch
  nx: number; ny: number; nz: number;
  cpx: number; cpy: number; cpz: number;
  fn: number; surfMul: number; roll: number;
  tdrive: number; tbrake: number; heat: number; slipPower: number;
}

function makeWheel(front: boolean, left: number): Wheel {
  return {
    lx: 0, lz: 0, ay: 0, front, left, omega: 0, spin: 0, comp: 0, compRate: 0, load: 0, slip: 0,
    surf: 'asphalt', contact: false, hint: { idx: 0 },
    nx: 0, ny: 1, nz: 0, cpx: 0, cpy: 0, cpz: 0, fn: 0, surfMul: 1, roll: 0, tdrive: 0, tbrake: 0,
    heat: 0, slipPower: 0,
  };
}

function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }

export class Car {
  readonly pose: CarPose;
  readonly telemetry: Telemetry;
  tyres: TyreState[];
  fuelKg: number;
  ersSoc = 0.6;
  setup: CarSetup;
  hold = false;
  pitLimitKmh = 80;
  tyreWearMul = 1;

  private p: CarParams;
  private perf: TeamPerformance;
  private wheels: Wheel[] = [makeWheel(true, 1), makeWheel(true, -1), makeWheel(false, 1), makeWheel(false, -1)];

  // rigid body state (CG)
  private px = 0; private py = 1; private pz = 0;
  private qx = 0; private qy = 0; private qz = 0; private qw = 1;
  private vx = 0; private vy = 0; private vz = 0;
  private wx = 0; private wy = 0; private wz = 0;
  // rotation matrix columns (ex left, ey up, ez fwd)
  private exx = 1; private exy = 0; private exz = 0;
  private eyx = 0; private eyy = 1; private eyz = 0;
  private ezx = 0; private ezy = 0; private ezz = 1;
  // force accumulators
  private fx = 0; private fy = 0; private fz = 0;
  private tx = 0; private ty = 0; private tz = 0;
  private sumLat = 0; private sumLong = 0;

  // suspension params
  private kF = 330e3; private kR = 330e3; private arbF = 90e3; private arbR = 90e3;
  private csF = 0.006; private csR = 0.006;
  private pivotDrop = 0.3; // CG height + average ride height (pose origin offset)

  // drivetrain
  private gear = 1;
  private shiftTimer = 0;
  private rpm = IDLE_RPM;
  private steerAngle = 0;
  private aeroMode = 0; // 0 corner mode .. 1 straight mode
  private ersDeployW = 0;
  private lastLatG = 0; private lastLongG = 0;
  private lastGround: GroundSample | null = null;

  constructor(opts: { setup: CarSetup; performance: TeamPerformance; params?: Partial<CarParams> }) {
    this.p = { ...DEFAULT_CAR_PARAMS, ...(opts.params ?? {}) };
    this.perf = opts.performance;
    this.setup = { ...opts.setup };
    this.fuelKg = opts.setup.fuelKg;
    this.tyres = [0, 1, 2, 3].map(() => newTyre(opts.setup.startCompound, opts.setup.tyrePressurePsi));
    this.pose = {
      position: new Vector3(), quaternion: new Quaternion(), velocity: new Vector3(), steerAngle: 0,
      wheelSpin: [0, 0, 0, 0], wheelCompression: [0, 0, 0, 0],
    };
    this.telemetry = {
      speedKmh: 0, rpm: IDLE_RPM, gear: 1, throttle: 0, brake: 0, steer: 0, latG: 0, longG: 0, ersSoc: this.ersSoc,
      ersDeployKw: 0, fuelKg: this.fuelKg, straightMode: false, tyres: this.tyres, wheelSlip: [0, 0, 0, 0],
      wheelLoadN: [0, 0, 0, 0], surface: ['asphalt', 'asphalt', 'asphalt', 'asphalt'], pitLimiter: false,
    };
    this.rebuildGeometry();
    this.refreshOutputs();
  }

  get massKg(): number { return this.p.massKg + this.fuelKg; }

  forwardSpeed(): number { return this.vx * this.ezx + this.vy * this.ezy + this.vz * this.ezz; }

  // ------------------------------------------------------------------ public API

  setSetup(s: CarSetup): void {
    this.setup = { ...s };
    this.rebuildGeometry();
  }

  fitTyres(compound: TyreCompound): void {
    for (const t of this.tyres) {
      t.compound = compound; t.wear = 0; t.tempC = 70; t.pressurePsi = this.setup.tyrePressurePsi;
    }
  }

  addFuel(kg: number): void {
    this.fuelKg = clamp(this.fuelKg + kg, 0, 110);
  }

  reset(x: number, z: number, heading: number, ground: GroundQuery): void {
    this.rebuildGeometry();
    const w = this.wheels;
    for (const wh of w) { wh.omega = 0; wh.comp = this.csOf(wh); wh.compRate = 0; wh.hint.idx = 0; wh.load = 0; wh.slip = 0; }
    const g = ground.sample(x, z, w[0].hint);
    this.orient(Math.sin(heading), Math.cos(heading), g.normal.x, g.normal.y, g.normal.z);
    const h = (this.p.cgHeightM + 0.5 * (this.setup.frontRideHeightMm + this.setup.rearRideHeightMm) * 0.001);
    this.px = x + this.eyx * h; this.py = g.height + this.eyy * h; this.pz = z + this.eyz * h;
    this.vx = this.vy = this.vz = 0; this.wx = this.wy = this.wz = 0;
    this.gear = 1; this.shiftTimer = 0; this.rpm = IDLE_RPM; this.aeroMode = 0; this.steerAngle = 0;
    this.ersDeployW = 0;
    this.refreshOutputs();
  }

  translate(dx: number, dy: number, dz: number): void {
    this.px += dx; this.py += dy; this.pz += dz;
    this.refreshOutputs();
  }

  /**
   * Apply an impulse (N s) at a world point. A point equal to `pose.position` (the reference origin the
   * renderer uses) is treated as acting through the centre of mass (pure linear impulse).
   */
  applyImpulse(impulse: Vector3, worldPoint: Vector3): void {
    const pp = this.pose.position;
    let rx = worldPoint.x - this.px, ry = worldPoint.y - this.py, rz = worldPoint.z - this.pz;
    if (Math.abs(worldPoint.x - pp.x) + Math.abs(worldPoint.y - pp.y) + Math.abs(worldPoint.z - pp.z) < 1e-6) {
      rx = 0; ry = 0; rz = 0;
    }
    this.impulseAt(impulse.x, impulse.y, impulse.z, rx, ry, rz);
    // keep wheel speeds consistent with a sudden velocity change (avoid huge slip)
    const f = this.forwardSpeed() / this.p.wheelRadiusM;
    for (const wh of this.wheels) wh.omega = f;
    this.refreshOutputs();
  }

  /** Velocity of a world point attached to the body. */
  pointVelocity(px: number, py: number, pz: number, out: Vector3): Vector3 {
    const rx = px - this.px, ry = py - this.py, rz = pz - this.pz;
    return out.set(
      this.vx + this.wy * rz - this.wz * ry,
      this.vy + this.wz * rx - this.wx * rz,
      this.vz + this.wx * ry - this.wy * rx,
    );
  }

  /** 1/m + angular term for an impulse along unit n at a world point. */
  invMassAlong(px: number, py: number, pz: number, nx: number, ny: number, nz: number): number {
    const rx = px - this.px, ry = py - this.py, rz = pz - this.pz;
    // t = r x n (world), to local, scale by 1/I, back, then (t_w)·(r x n)
    const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx;
    const lx = cx * this.exx + cy * this.exy + cz * this.exz;
    const ly = cx * this.eyx + cy * this.eyy + cz * this.eyz;
    const lz = cx * this.ezx + cy * this.ezy + cz * this.ezz;
    const I = this.p.inertia;
    return 1 / this.massKg + (lx * lx / I[0] + ly * ly / I[1] + lz * lz / I[2]);
  }

  get quaternionXYZW(): [number, number, number, number] { return [this.qx, this.qy, this.qz, this.qw]; }

  // ------------------------------------------------------------------ internals

  private csOf(w: Wheel): number { return w.front ? this.csF : this.csR; }

  private rebuildGeometry(): void {
    const p = this.p, s = this.setup;
    this.kF = 180e3 + 30e3 * (s.frontSpring - 1);
    this.kR = 180e3 + 30e3 * (s.rearSpring - 1);
    this.arbF = 15e3 * s.frontArb;
    this.arbR = 15e3 * s.rearArb;
    const m = this.massKg;
    this.csF = (m * G * p.weightDistFront * 0.5) / this.kF;
    this.csR = (m * G * (1 - p.weightDistFront) * 0.5) / this.kR;
    const rhF = s.frontRideHeightMm * 0.001, rhR = s.rearRideHeightMm * 0.001;
    const zf = p.wheelbaseM * (1 - p.weightDistFront), zr = -p.wheelbaseM * p.weightDistFront;
    const w = this.wheels;
    for (let i = 0; i < 4; i++) {
      const wh = w[i];
      wh.lx = wh.left * 0.5 * (wh.front ? p.trackFrontM : p.trackRearM);
      wh.lz = wh.front ? zf : zr;
      const rh = wh.front ? rhF : rhR;
      wh.ay = (p.wheelRadiusM - (p.cgHeightM + rh)) + SUSP_FREE - (wh.front ? this.csF : this.csR);
    }
    this.pivotDrop = p.cgHeightM + 0.5 * (rhF + rhR);
  }

  /** Set orientation: forward direction (fx,fz horizontal) and up vector n. */
  private orient(fxh: number, fzh: number, nx: number, ny: number, nz: number): void {
    // forward projected onto plane with normal n
    let fx = fxh, fy = 0, fz = fzh;
    const d = fx * nx + fy * ny + fz * nz;
    fx -= nx * d; fy -= ny * d; fz -= nz * d;
    const l = Math.hypot(fx, fy, fz) || 1;
    fx /= l; fy /= l; fz /= l;
    // left = up x forward
    const lx = ny * fz - nz * fy, ly = nz * fx - nx * fz, lz = nx * fy - ny * fx;
    _m4.set(
      lx, nx, fx, 0,
      ly, ny, fy, 0,
      lz, nz, fz, 0,
      0, 0, 0, 1,
    );
    const q = _tmpQ.setFromRotationMatrix(_m4);
    this.qx = q.x; this.qy = q.y; this.qz = q.z; this.qw = q.w;
    this.updateBasis();
  }

  private updateBasis(): void {
    const x = this.qx, y = this.qy, z = this.qz, w = this.qw;
    const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
    this.exx = 1 - 2 * (yy + zz); this.exy = 2 * (xy + wz); this.exz = 2 * (xz - wy);
    this.eyx = 2 * (xy - wz); this.eyy = 1 - 2 * (xx + zz); this.eyz = 2 * (yz + wx);
    this.ezx = 2 * (xz + wy); this.ezy = 2 * (yz - wx); this.ezz = 1 - 2 * (xx + yy);
  }

  private addForce(fx: number, fy: number, fz: number, px: number, py: number, pz: number): void {
    this.fx += fx; this.fy += fy; this.fz += fz;
    const rx = px - this.px, ry = py - this.py, rz = pz - this.pz;
    this.tx += ry * fz - rz * fy;
    this.ty += rz * fx - rx * fz;
    this.tz += rx * fy - ry * fx;
  }

  private impulseAt(jx: number, jy: number, jz: number, rx: number, ry: number, rz: number): void {
    const im = 1 / this.massKg;
    this.vx += jx * im; this.vy += jy * im; this.vz += jz * im;
    const cx = ry * jz - rz * jy, cy = rz * jx - rx * jz, cz = rx * jy - ry * jx;
    const I = this.p.inertia;
    const lx = (cx * this.exx + cy * this.exy + cz * this.exz) / I[0];
    const ly = (cx * this.eyx + cy * this.eyy + cz * this.eyz) / I[1];
    const lz = (cx * this.ezx + cy * this.ezy + cz * this.ezz) / I[2];
    this.wx += lx * this.exx + ly * this.eyx + lz * this.ezx;
    this.wy += lx * this.exy + ly * this.eyy + lz * this.ezy;
    this.wz += lx * this.exz + ly * this.eyz + lz * this.ezz;
  }

  /** Called by collision code / barrier. Public so collisions.ts can use it with a world-space impulse. */
  impulseWorld(jx: number, jy: number, jz: number, px: number, py: number, pz: number): void {
    this.impulseAt(jx, jy, jz, px - this.px, py - this.py, pz - this.pz);
    this.refreshOutputs();
  }

  private refreshOutputs(): void {
    const pose = this.pose;
    const d = this.pivotDrop;
    pose.position.set(this.px - this.eyx * d, this.py - this.eyy * d, this.pz - this.eyz * d);
    pose.quaternion.set(this.qx, this.qy, this.qz, this.qw);
    pose.velocity.set(this.vx, this.vy, this.vz);
    pose.steerAngle = this.steerAngle;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      pose.wheelSpin[i] = w.spin;
      pose.wheelCompression[i] = w.comp - this.csOf(w);
    }
  }

  // ------------------------------------------------------------------ main step

  step(dt: number, c: Controls, ground: GroundQuery, env: Environment, straightModeAllowed: boolean): void {
    const p = this.p, s = this.setup, W = this.wheels;
    const R = p.wheelRadiusM;
    const mass = this.massKg;

    // ---- inputs
    const steer = clamp(c.steer, -1, 1);
    let throttle = clamp(c.throttle, 0, 1);
    let brake = clamp(c.brake, 0, 1);
    this.steerAngle = steer * p.maxSteerDeg * DEG;
    const speed = Math.hypot(this.vx, this.vy, this.vz);

    if (this.hold) {
      this.holdStep(ground);
      this.fillTelemetry(c, 0, 0, 0, false);
      return;
    }

    // pit limiter
    if (c.pitLimiter) {
      const vlim = this.pitLimitKmh / 3.6;
      const fwd = this.forwardSpeed();
      throttle = Math.min(throttle, clamp(0.25 + (vlim - fwd) * 0.5, 0, 1));
      if (fwd > vlim + 1) brake = Math.max(brake, clamp((fwd - vlim - 1) * 0.12, 0, 0.5));
    }

    // ---- gearbox
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    const fwdSpeed = this.forwardSpeed();
    if (c.shiftUp) {
      if (this.gear === -1) { this.gear = 0; }
      else if (this.gear === 0) { this.gear = 1; }
      else if (this.gear < 8) { this.gear++; this.shiftTimer = SHIFT_TIME; }
    } else if (c.shiftDown) {
      if (this.gear > 1) { this.gear--; this.shiftTimer = SHIFT_TIME; }
      else if (this.gear === 1 && Math.abs(fwdSpeed) < 2) this.gear = 0;
      else if (this.gear === 0 && Math.abs(fwdSpeed) < 2) this.gear = -1;
    }

    // ---- active aero
    const wantStraight = straightModeAllowed && throttle > 0.95 && Math.abs(steer) < 0.15 && brake < 0.02;
    if (!wantStraight) this.aeroMode = 0;
    else this.aeroMode = Math.min(1, this.aeroMode + dt / 0.2);
    const am = this.aeroMode;

    // ---- basis, ground sampling, suspension
    this.updateBasis();
    this.fx = this.fy = this.fz = 0; this.tx = this.ty = this.tz = 0;
    this.sumLat = 0; this.sumLong = 0;
    const exx = this.exx, exy = this.exy, exz = this.exz;
    const eyx = this.eyx, eyy = this.eyy, eyz = this.eyz;
    const ezx = this.ezx, ezy = this.ezy, ezz = this.ezz;

    let nContact = 0;
    for (let i = 0; i < 4; i++) {
      const w = W[i];
      const ax = this.px + exx * w.lx + eyx * w.ay + ezx * w.lz;
      const ay = this.py + exy * w.lx + eyy * w.ay + ezy * w.lz;
      const az = this.pz + exz * w.lx + eyz * w.ay + ezz * w.lz;
      const g = ground.sample(ax, az, w.hint);
      this.lastGround = g;
      const n = g.normal;
      w.nx = n.x; w.ny = n.y; w.nz = n.z;
      w.surf = g.surface;
      const nUp = n.x * eyx + n.y * eyy + n.z * eyz;
      // velocity of attach point
      const rx = ax - this.px, ry = ay - this.py, rz = az - this.pz;
      const vax = this.vx + this.wy * rz - this.wz * ry;
      const vay = this.vy + this.wz * rx - this.wx * rz;
      const vaz = this.vz + this.wx * ry - this.wy * rx;
      if (nUp < 0.25) { w.contact = false; w.comp = 0; w.compRate = 0; w.fn = 0; continue; }
      const d = (n.y * (ay - g.height)) / nUp;
      let comp = SUSP_FREE - (d - R);
      if (comp <= 0) { w.contact = false; w.comp = 0; w.compRate = 0; w.fn = 0; continue; }
      if (comp > 0.09) comp = 0.09;
      w.contact = true;
      w.comp = comp;
      w.compRate = -(vax * n.x + vay * n.y + vaz * n.z) / nUp;
      w.cpx = ax - eyx * d; w.cpy = ay - eyy * d; w.cpz = az - eyz * d;
      nContact++;
    }

    // forces from springs / dampers / bump / ARB
    for (let i = 0; i < 4; i++) {
      const w = W[i];
      if (!w.contact) continue;
      const k = w.front ? this.kF : this.kR;
      const cs = Math.sqrt(k / 330e3);
      let f = k * w.comp;
      f += (w.compRate > 0 ? 9000 : 14000) * cs * w.compRate;
      if (w.comp > TRAVEL) f += BUMP_K * (w.comp - TRAVEL) + (w.compRate > 0 ? 6000 * w.compRate : 0);
      // anti-roll: opposite wheel on the same axle
      const o = W[i ^ 1];
      const oc = o.contact ? o.comp : 0;
      f += (w.front ? this.arbF : this.arbR) * (w.comp - oc);
      w.fn = f > 0 ? f : 0;
    }

    // ---- aero
    const vx = this.vx, vy = this.vy, vz = this.vz;
    const v2 = vx * vx + vy * vy + vz * vz;
    const vmag = Math.sqrt(v2);
    const perf = this.perf;
    const rhFront = clamp(s.frontRideHeightMm * 0.001 - this.avgComp(true) + this.csF, -0.01, 0.06);
    const rhRear = clamp(s.rearRideHeightMm * 0.001 - this.avgComp(false) + this.csR, -0.01, 0.08);
    const wingCl = 1 + 0.02 * (s.frontWing - 5) + 0.03 * (s.rearWing - 5);
    const wingCd = 1 + 0.015 * (s.frontWing - 5) + 0.025 * (s.rearWing - 5);
    const clA = (p.liftCoef + (p.liftCoefStraight - p.liftCoef) * am) * wingCl * perf.downforce;
    const cdA = (p.dragCoef + (p.dragCoefStraight - p.dragCoef) * am) * wingCd * perf.drag;
    let balF = p.aeroBalanceFront + 0.012 * (s.frontWing - 5) - 0.012 * (s.rearWing - 5);
    balF = clamp(balF, 0.25, 0.55);
    const q = 0.5 * RHO * v2;
    const dfFront = q * clA * balF * rideHeightFactor(rhFront);
    const dfRear = q * clA * (1 - balF) * rideHeightFactor(rhRear);
    const zf = W[0].lz, zr = W[2].lz;
    {
      const ypt = -0.05;
      this.addForce(-eyx * dfFront, -eyy * dfFront, -eyz * dfFront,
        this.px + ezx * zf + eyx * ypt, this.py + ezy * zf + eyy * ypt, this.pz + ezz * zf + eyz * ypt);
      this.addForce(-eyx * dfRear, -eyy * dfRear, -eyz * dfRear,
        this.px + ezx * zr + eyx * ypt, this.py + ezy * zr + eyy * ypt, this.pz + ezz * zr + eyz * ypt);
      if (vmag > 0.01) {
        const dr = q * cdA / vmag;
        this.addForce(-vx * dr, -vy * dr, -vz * dr, this.px + eyx * 0.12, this.py + eyy * 0.12, this.pz + eyz * 0.12);
        this.sumLong += -(vx * ezx + vy * ezy + vz * ezz) * dr;
        this.sumLat += -(vx * exx + vy * exy + vz * exz) * dr;
      }
    }

    // ---- powertrain
    const fuelOk = this.fuelKg > 0;
    const ratio = this.gear === 0 ? 0 : (this.gear > 0 ? p.gearRatios[this.gear - 1] : -p.gearRatios[0] * 0.9) * p.finalDrive;
    const wRear = 0.5 * (W[2].omega + W[3].omega);
    let wheelRpm = Math.abs(wRear * ratio) * 9.5493;
    const clutchFloor = IDLE_RPM + (LAUNCH_RPM - IDLE_RPM) * throttle;
    this.rpm = ratio === 0 ? IDLE_RPM + throttle * 6000 : Math.max(wheelRpm, clutchFloor);
    // direction-correct drive: wheels must turn the way the gear points, otherwise slip the clutch
    let shaftTorque = 0; // engine+ERS torque on the crank, Nm
    let deployW = 0;
    const vKmh = vmag * 3.6;
    if (ratio !== 0 && this.shiftTimer <= 0 && fuelOk) {
      const rpm = this.rpm;
      const wEng = Math.max(rpm, 3000) * 0.10472;
      let limiter = 1;
      if (wheelRpm > p.maxRpm - 200) limiter = clamp((p.maxRpm - wheelRpm) / 200, 0, 1);
      const pIce = p.icePowerKw * 1000 * perf.power * icePowerShape(rpm);
      // ERS deployment
      let taper = 1;
      if (!c.boost) taper = clamp((355 - vKmh) / (355 - 290), 0, 1);
      else taper = clamp((372 - vKmh) / (372 - 320), 0, 1);
      const socFade = clamp(this.ersSoc * 20, 0, 1);
      deployW = p.ersPowerKw * 1000 * throttle * taper * socFade;
      if (this.gear < 0) deployW = 0;
      const pTot = (pIce * throttle + deployW);
      shaftTorque = (pTot / wEng) * limiter;
      // engine braking when off throttle
      const eb = (1 - throttle) * (20 + 0.008 * this.rpm);
      shaftTorque -= eb * (wheelRpm > IDLE_RPM ? 1 : 0);
    } else if (ratio !== 0 && this.shiftTimer <= 0 && !fuelOk) {
      shaftTorque = 0;
    }
    this.ersDeployW = deployW;
    const driveline = 0.93;
    let wheelTorqueTotal = shaftTorque * ratio * (shaftTorque > 0 ? driveline : 1);
    // torque limiter in low gears (keeps launches controllable; cap grows with rear downforce)
    const driveCap = 3900 + 1.6 * dfRear * R;
    if (wheelTorqueTotal > driveCap) wheelTorqueTotal = driveCap;
    else if (wheelTorqueTotal < -driveCap * 1.5) wheelTorqueTotal = -driveCap * 1.5;
    // limited-slip differential
    {
      const lock = throttle > 0.05 ? s.diffOnThrottle : s.diffOffThrottle;
      const half = wheelTorqueTotal * 0.5;
      const dw = W[2].omega - W[3].omega;
      const lim = 0.15 * Math.abs(wheelTorqueTotal) * lock + 250 * lock;
      const tl = clamp(60 * lock * dw, -lim, lim);
      W[0].tdrive = 0; W[1].tdrive = 0;
      W[2].tdrive = half - tl;
      W[3].tdrive = half + tl;
    }
    // fuel
    if (fuelOk) {
      const rate = 0.11 * (0.12 + 0.88 * throttle * clamp(this.rpm / 10500, 0.4, 1));
      this.fuelKg = Math.max(0, this.fuelKg - rate * dt);
    }

    // ---- brakes (torque per wheel) + ERS harvest
    {
      const bt = BRAKE_TORQUE_MAX * s.brakePressure * brake;
      W[0].tbrake = bt * s.brakeBias * 0.5; W[1].tbrake = W[0].tbrake;
      W[2].tbrake = bt * (1 - s.brakeBias) * 0.5; W[3].tbrake = W[2].tbrake;
      let harvest = 0;
      if (brake > 0.05 && throttle < 0.05 && this.forwardSpeed() > 3) {
        harvest = ERS_HARVEST_MAX_W * brake * clamp(this.forwardSpeed() / 40, 0, 1);
        // small extra rear retarding torque from the MGU-K
        const th = harvest / Math.max(this.forwardSpeed(), 10) * R * 0.5;
        W[2].tbrake += th; W[3].tbrake += th;
      }
      const dSoc = (harvest * 0.85 - deployW) * dt / (p.ersCapacityMJ * 1e6);
      this.ersSoc = clamp(this.ersSoc + dSoc, 0, 1);
    }

    // ---- tyres
    const camberF = s.frontCamberDeg * DEG, camberR = s.rearCamberDeg * DEG;
    const toeF = s.frontToeDeg * DEG, toeR = -s.rearToeDeg * DEG;
    for (let i = 0; i < 4; i++) {
      const w = W[i];
      const tyre = this.tyres[i];
      w.slipPower = 0; w.slip = 0; w.load = w.fn;
      if (!w.contact) {
        // airborne: wheel just spins down with the brake
        const dwb = dt * w.tbrake / WHEEL_INERTIA;
        w.omega = Math.abs(w.omega) <= dwb ? 0 : w.omega - Math.sign(w.omega) * dwb;
        w.omega += dt * w.tdrive / WHEEL_INERTIA;
        w.spin += w.omega * dt;
        continue;
      }
      const nx = w.nx, ny = w.ny, nz = w.nz;
      // forward projected on ground plane
      let fx = ezx, fy = ezy, fz = ezz;
      const dn = fx * nx + fy * ny + fz * nz;
      fx -= nx * dn; fy -= ny * dn; fz -= nz * dn;
      const fl = 1 / (Math.hypot(fx, fy, fz) || 1);
      fx *= fl; fy *= fl; fz *= fl;
      const lx = ny * fz - nz * fy, ly = nz * fx - nx * fz, lz = nx * fy - ny * fx;
      const ang = (w.front ? this.steerAngle : 0) + w.left * (w.front ? toeF : toeR);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const wfx = fx * ca + lx * sa, wfy = fy * ca + ly * sa, wfz = fz * ca + lz * sa;
      const wlx = -fx * sa + lx * ca, wly = -fy * sa + ly * ca, wlz = -fz * sa + lz * ca;
      // contact velocity
      const rx = w.cpx - this.px, ry = w.cpy - this.py, rz = w.cpz - this.pz;
      const vcx = this.vx + this.wy * rz - this.wz * ry;
      const vcy = this.vy + this.wz * rx - this.wx * rz;
      const vcz = this.vz + this.wx * ry - this.wy * rx;
      const vlong = vcx * wfx + vcy * wfy + vcz * wfz;
      const vlat = vcx * wlx + vcy * wly + vcz * wlz;
      const denom = Math.max(Math.abs(vlong), V_MIN_SLIP);
      // surface and wetness grip
      const surf = w.surf;
      const asph = surf === 'asphalt' || surf === 'kerb' || surf === 'pitlane';
      let mulG = surfaceGrip(surf);
      if (asph) mulG *= wetnessGrip(tyre.compound, env.wetness) * (1 + 0.04 * env.rubber);
      else mulG *= 1 - 0.25 * env.wetness;
      w.surfMul = mulG;
      const N = w.fn;
      const camber = w.front ? camberF : camberR;
      const alpha = Math.atan(vlat / denom);

      // implicit wheel spin update
      const kappa0 = (w.omega * R - vlong) / denom;
      const f0 = tyreForce(kappa0, alpha, N, tyre, mulG, camber);
      const K = longitudinalStiffness(N, tyre, mulG);
      const den = 1 + dt * R * R * K / (denom * WHEEL_INERTIA);
      let om = w.omega + dt * (w.tdrive - R * f0.fx) / WHEEL_INERTIA / den;
      const dwb = dt * w.tbrake / WHEEL_INERTIA;
      om = Math.abs(om) <= dwb ? 0 : om - Math.sign(om) * dwb;
      w.omega = om;
      w.spin += om * dt;
      const kappa = (om * R - vlong) / denom;
      const f = tyreForce(kappa, alpha, N, tyre, mulG, camber);
      // wheel force on body
      let tfx = wfx * f.fx + wlx * f.fy;
      let tfy = wfy * f.fx + wly * f.fy;
      let tfz = wfz * f.fx + wlz * f.fy;
      // rolling resistance + off-track drag
      const hs = Math.hypot(vcx - nx * (vcx * nx + vcy * ny + vcz * nz), vcy - ny * (vcx * nx + vcy * ny + vcz * nz), vcz - nz * (vcx * nx + vcy * ny + vcz * nz));
      if (hs > 1e-3) {
        const rr = (0.012 + surfaceRollingDrag(surf)) * N * Math.min(1, hs / 1.0) / hs;
        tfx -= vcx * rr; tfy -= vcy * rr; tfz -= vcz * rr;
      }
      // normal force
      tfx += nx * N; tfy += ny * N; tfz += nz * N;
      this.addForce(tfx, tfy, tfz, w.cpx, w.cpy, w.cpz);
      this.sumLat += tfx * exx + tfy * exy + tfz * exz;
      this.sumLong += tfx * ezx + tfy * ezy + tfz * ezz;

      const slipVelX = om * R - vlong;
      w.slipPower = Math.abs(f.fx * slipVelX) + Math.abs(f.fy * vlat);
      // combined slip metric for UI (1 = at peak)
      w.slip = Math.hypot(kappa / 0.11, alpha / 0.115);
      stepTyre(tyre, w.slipPower, N, vmag, dt, env.airTempC, env.trackTempC, env.wetness, this.tyreWearMul * perf.tyreWear);
    }

    // ---- gravity
    this.fy -= mass * G;

    // ---- barrier collisions (push-out + impulses) are applied after integration
    // ---- integrate (semi-implicit Euler)
    const im = 1 / mass;
    this.vx += this.fx * im * dt; this.vy += this.fy * im * dt; this.vz += this.fz * im * dt;
    {
      const I = p.inertia;
      const lwx = this.wx * exx + this.wy * exy + this.wz * exz;
      const lwy = this.wx * eyx + this.wy * eyy + this.wz * eyz;
      const lwz = this.wx * ezx + this.wy * ezy + this.wz * ezz;
      const ltx = this.tx * exx + this.ty * exy + this.tz * exz;
      const lty = this.tx * eyx + this.ty * eyy + this.tz * eyz;
      const ltz = this.tx * ezx + this.ty * ezy + this.tz * ezz;
      // gyroscopic: w x (I w)
      const gx = lwy * I[2] * lwz - lwz * I[1] * lwy;
      const gy = lwz * I[0] * lwx - lwx * I[2] * lwz;
      const gz = lwx * I[1] * lwy - lwy * I[0] * lwx;
      const ax = (ltx - gx) / I[0] * dt, ay = (lty - gy) / I[1] * dt, az = (ltz - gz) / I[2] * dt;
      this.wx += ax * exx + ay * eyx + az * ezx;
      this.wy += ax * exy + ay * eyy + az * ezy;
      this.wz += ax * exz + ay * eyz + az * ezz;
    }
    // safety clamps
    const wl = Math.hypot(this.wx, this.wy, this.wz);
    if (wl > 30) { const k = 30 / wl; this.wx *= k; this.wy *= k; this.wz *= k; }
    const vl = Math.hypot(this.vx, this.vy, this.vz);
    if (vl > 160) { const k = 160 / vl; this.vx *= k; this.vy *= k; this.vz *= k; }

    this.px += this.vx * dt; this.py += this.vy * dt; this.pz += this.vz * dt;
    {
      const wx = this.wx, wy = this.wy, wz = this.wz;
      const qx = this.qx, qy = this.qy, qz = this.qz, qw = this.qw;
      const h = 0.5 * dt;
      this.qx += h * (wx * qw + wy * qz - wz * qy);
      this.qy += h * (wy * qw + wz * qx - wx * qz);
      this.qz += h * (wz * qw + wx * qy - wy * qx);
      this.qw += h * (-wx * qx - wy * qy - wz * qz);
      const inv = 1 / Math.hypot(this.qx, this.qy, this.qz, this.qw);
      this.qx *= inv; this.qy *= inv; this.qz *= inv; this.qw *= inv;
    }

    // ---- barriers
    this.barriers(ground);

    // ---- rest damping (kills micro-creep when parked)
    if (nContact === 4 && throttle < 0.01 && Math.hypot(this.vx, this.vz) < 0.05 && Math.abs(this.wy) < 0.02) {
      this.vx = 0; this.vz = 0; this.wy = 0;
    }

    const g = 1 / (mass * G);
    this.lastLatG = this.sumLat * g;
    this.lastLongG = this.sumLong * g;
    this.updateBasis();
    this.fillTelemetry(c, throttle, brake, deployW, wantStraight);
  }

  private avgComp(front: boolean): number {
    const a = this.wheels[front ? 0 : 2], b = this.wheels[front ? 1 : 3];
    return 0.5 * (a.comp + b.comp);
  }

  private holdStep(ground: GroundQuery): void {
    this.vx = this.vy = this.vz = 0; this.wx = this.wy = this.wz = 0;
    for (const w of this.wheels) { w.omega = 0; }
    // keep on the ground: follow ground height/normal at the CG, keep heading
    const g = ground.sample(this.px, this.pz, this.wheels[0].hint);
    const hy = this.ezx, hz = this.ezz;
    const hl = Math.hypot(hy, hz);
    const h = this.p.cgHeightM + 0.5 * (this.setup.frontRideHeightMm + this.setup.rearRideHeightMm) * 0.001;
    this.orient(hl > 1e-3 ? hy / hl : 0, hl > 1e-3 ? hz / hl : 1, g.normal.x, g.normal.y, g.normal.z);
    this.px += this.eyx * 0; // x/z unchanged
    this.py = g.height + this.eyy * h;
    for (const w of this.wheels) { w.comp = this.csOf(w); w.contact = true; w.load = this.massKg * G * 0.25; w.slip = 0; w.surf = g.surface; }
    this.refreshOutputs();
    this.lastLatG = 0; this.lastLongG = 0;
  }

  private barriers(ground: GroundQuery): void {
    const p = this.p;
    const hx = 0.95;
    const zFront = p.wheelbaseM * (1 - p.weightDistFront) + 0.55;
    const zRear = -p.wheelbaseM * p.weightDistFront - 0.55;
    for (let k = 0; k < 4; k++) {
      const lx = (k & 1) ? -hx : hx;
      const lz = (k & 2) ? zRear : zFront;
      const wx = this.px + this.exx * lx + this.ezx * lz;
      const wy = this.py + this.exy * lx + this.ezy * lz;
      const wz = this.pz + this.exz * lx + this.ezz * lz;
      const hit = ground.barrier(wx, wz, 0.1, this.wheels[k].hint);
      if (!hit || hit.depth <= 0) continue;
      const nx = hit.nx, nz = hit.nz;
      this.px += nx * hit.depth; this.pz += nz * hit.depth;
      const rx = wx - this.px, ry = wy - this.py, rz = wz - this.pz;
      const vpx = this.vx + this.wy * rz - this.wz * ry;
      const vpy = this.vy + this.wz * rx - this.wx * rz;
      const vpz = this.vz + this.wx * ry - this.wy * rx;
      const vn = vpx * nx + vpz * nz;
      if (vn >= 0) continue;
      const invM = this.invMassAlong(wx, wy, wz, nx, 0, nz);
      const jn = -(1 + BODY_E) * vn / invM;
      this.impulseAt(nx * jn, 0, nz * jn, rx, ry, rz);
      // friction scrub along the wall
      const tx = vpx - nx * vn, tz = vpz - nz * vn;
      const tl = Math.hypot(tx, tz);
      if (tl > 1e-3) {
        const tux = tx / tl, tuz = tz / tl;
        const invT = this.invMassAlong(wx, wy, wz, tux, 0, tuz);
        const jt = Math.min(0.4 * jn, tl / invT);
        this.impulseAt(-tux * jt, 0, -tuz * jt, rx, ry, rz);
      }
    }
  }

  private fillTelemetry(c: Controls, throttle: number, brake: number, deployW: number, straight: boolean): void {
    const t = this.telemetry;
    t.speedKmh = Math.hypot(this.vx, this.vy, this.vz) * 3.6;
    t.rpm = this.rpm;
    t.gear = this.gear;
    t.throttle = throttle;
    t.brake = brake;
    t.steer = c.steer;
    t.latG = this.lastLatG;
    t.longG = this.lastLongG;
    t.ersSoc = this.ersSoc;
    t.ersDeployKw = deployW * 0.001;
    t.fuelKg = this.fuelKg;
    t.straightMode = straight && this.aeroMode > 0.5;
    t.tyres = this.tyres;
    t.pitLimiter = c.pitLimiter;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      t.wheelSlip[i] = w.slip;
      t.wheelLoadN[i] = w.load;
      t.surface[i] = w.surf;
    }
    this.refreshOutputs();
  }
}

const _tmpQ = new Quaternion();

function icePowerShape(rpm: number): number {
  const d = (rpm - 10500) / 7500;
  return Math.max(0.3, 1 - d * d);
}

function rideHeightFactor(rh: number): number {
  let f = 1 + 4 * (0.03 - rh);
  f = clamp(f, 0.85, 1.25);
  if (rh < 0.008) f *= 1 - 0.35 * clamp((0.008 - rh) / 0.008, 0, 1.5);
  return f;
}
