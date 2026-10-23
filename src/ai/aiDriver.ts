// AI driver: drives a real physics car purely through Controls.
import type { CarPose, Controls, Driver, ITrack, SessionPhase, Telemetry } from '../types';

export interface AIPerception {
  s: number; lateral: number; speed: number;            // self, from Track.project
  pose: CarPose; telemetry: Telemetry;
  others: { id: string; s: number; lateral: number; speed: number }[];  // nearby cars
  phase: SessionPhase;
  wantPit: boolean;                                      // strategy decided to box this lap
  pitLimitKmh: number;
}

/** Optional grip assumptions. Defaults suit the shared 2026 car model; tests and tuning may override. */
export interface AIDriverOptions {
  /** Peak lateral grip in g with no downforce. */
  mu?: number;
  /** Downforce factor: extra vertical load as a fraction of weight per (m/s)^2. */
  downforceFactor?: number;
}

const G = 9.81;
const V_CAP = 95;
const MAX_STEER = (17 * Math.PI) / 180;
const WHEELBASE = 3.4;
const DEFAULT_MU = 1.8;
const DEFAULT_DFF = 0.00011;

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ speed profile

/** Longitudinal acceleration available from the powertrain at speed v (m/s^2): ~12 at low speed, ~2 at 90 m/s. */
function powerAccel(v: number): number {
  return clamp(12 - (10 * v) / 90, 1.5, 12);
}

/** Grip-limited target speed per track sample (m/s) for the racing line; mu ~ peak lateral g. */
export function computeSpeedProfile(track: ITrack, mu: number, downforceFactor: number): Float32Array {
  const n = track.sampleCount;
  const sp = track.length / n;
  // Racing line points (XZ).
  const px = new Float64Array(n), pz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * sp;
    const f = track.frameAt(s);
    const off = track.racingLineOffset(s);
    px[i] = f.position.x + f.left.x * off;
    pz[i] = f.position.z + f.left.z * off;
  }
  // Curvature by the circumscribed circle over ~8 m chords.
  const step = Math.max(1, Math.round(4 / sp));
  const kappa = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - step + n) % n, c = (i + step) % n;
    const abx = px[i] - px[a], abz = pz[i] - pz[a];
    const bcx = px[c] - px[i], bcz = pz[c] - pz[i];
    const acx = px[c] - px[a], acz = pz[c] - pz[a];
    const cross = abx * bcz - abz * bcx;
    const d = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz);
    kappa[i] = d > 1e-9 ? Math.abs(2 * cross) / d : 0;
  }
  // Light smoothing.
  const ks = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = -2; j <= 2; j++) sum += kappa[(i + j + n) % n];
    ks[i] = sum / 5;
  }
  const v = new Float64Array(n);
  const gm = G * mu;
  for (let i = 0; i < n; i++) {
    const denom = ks[i] - gm * downforceFactor;
    v[i] = denom > 1e-6 ? Math.min(V_CAP, Math.sqrt(gm / denom)) : V_CAP;
  }
  // Available longitudinal accel given the friction circle at speed vv with curvature k.
  const grip = (vv: number) => gm * (1 + downforceFactor * vv * vv);
  const longAvail = (vv: number, k: number, cap: number) => {
    const A = grip(vv);
    const lat = vv * vv * k;
    const a = Math.sqrt(Math.max(0, A * A - lat * lat));
    return Math.min(cap, Math.max(0.1 * Math.min(A, cap), a));
  };
  // Backward braking pass (two laps so the wrap resolves).
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const nx = (i + 1) % n;
      const a = longAvail(v[nx], ks[i], 5 * G);
      const lim = Math.sqrt(v[nx] * v[nx] + 2 * a * sp);
      if (lim < v[i]) v[i] = lim;
    }
  }
  // Forward acceleration pass.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const pv = v[(i - 1 + n) % n];
      const a = longAvail(pv, ks[i], powerAccel(pv));
      const lim = Math.sqrt(pv * pv + 2 * a * sp);
      if (lim < v[i]) v[i] = lim;
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = v[i];
  return out;
}

const profileCache = new WeakMap<ITrack, Map<string, Float32Array>>();
function cachedProfile(track: ITrack, mu: number, dff: number): Float32Array {
  let m = profileCache.get(track);
  if (!m) { m = new Map(); profileCache.set(track, m); }
  const key = `${mu}:${dff}`;
  let p = m.get(key);
  if (!p) { p = computeSpeedProfile(track, mu, dff); m.set(key, p); }
  return p;
}

// ------------------------------------------------------------------ driver

type PitState = 'none' | 'approach' | 'lane' | 'box' | 'exit';

export class AIDriver {
  private readonly track: ITrack;
  private readonly driver: Driver;
  private readonly rng: () => number;
  private readonly profile: Float32Array;
  private readonly skillFactor: number;
  private readonly aggression: number;
  private readonly L: number;

  private lapVar = 1;
  private prevS: number | null = null;
  private prevPhase: SessionPhase | null = null;
  private steerSmooth = 0;
  private integ = 0;
  private shiftTimer = 1;
  private reactT = 0;

  // racecraft
  private tactical = 0;
  private overtakeSide = 0;
  private overtakeId = '';
  private overtakeHold = 0;

  // recovery
  private slowT = 0;
  private stuckT = 0;
  private recovering = false;
  private recT = 0;
  private hasMoved = false;

  // pit
  private pitBoxIdx = 0;
  private pitState: PitState = 'none';
  private pitT = 0;
  private pitCooldown = 0;
  private boxT = 0;
  private boxStartCompound = '';
  private boxStartWear = 0;
  private wantFell = false;
  private laneLen = 0;

  constructor(track: ITrack, driver: Driver, skillMul: number, seed: number, opts: AIDriverOptions = {}) {
    this.track = track;
    this.driver = driver;
    this.L = track.length;
    this.rng = mulberry32(seed ^ 0x2545f491);
    this.aggression = clamp(driver.aggression, 0, 1);
    this.profile = cachedProfile(track, opts.mu ?? DEFAULT_MU, opts.downforceFactor ?? DEFAULT_DFF);
    const raw = driver.skill * skillMul;
    this.skillFactor = raw >= 1 ? 1 + Math.min(0.03, (raw - 1) * 0.3)
      : raw >= 0.86 ? 0.94 + (0.06 * (raw - 0.86)) / 0.14
        : Math.max(0.6, 0.94 - (0.86 - raw) * 0.8);
    this.lapVar = 1 + (this.rng() * 2 - 1) * 0.005;
  }

  setPitBox(k: number): void { this.pitBoxIdx = k; }

  /** True once when the car has been stuck for more than 8 s; the flag clears when read (the caller teleports it). */
  needsReset(): boolean {
    if (this.stuckT > 8) {
      this.stuckT = 0; this.slowT = 0; this.recovering = false; this.recT = 0;
      return true;
    }
    return false;
  }

  private profileAt(s: number): number {
    const n = this.profile.length;
    const f = ((s / this.L) % 1 + 1) % 1 * n;
    const i = Math.floor(f);
    const t = f - i;
    return this.profile[i % n] * (1 - t) + this.profile[(i + 1) % n] * t;
  }

  private wrapDs(ds: number): number {
    const L = this.L;
    ds = ((ds % L) + L) % L;
    return ds > L / 2 ? ds - L : ds;
  }

  update(dtIn: number, p: AIPerception): Controls {
    const dt = clamp(dtIn, 1e-4, 0.1);
    const L = this.L;
    const c: Controls = { steer: 0, throttle: 0, brake: 0, shiftUp: false, shiftDown: false, boost: false, pitLimiter: false };

    if (this.prevS !== null && this.prevS > 0.9 * L && p.s < 0.1 * L) {
      this.lapVar = 1 + (this.rng() * 2 - 1) * 0.005;
    }
    this.prevS = p.s;
    this.shiftTimer += dt;
    if (this.pitCooldown > 0) this.pitCooldown -= dt;

    const q = p.pose.quaternion;
    const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const lx = 1 - 2 * (q.y * q.y + q.z * q.z), lz = 2 * (q.x * q.z - q.y * q.w);
    const speed = p.speed;
    const tel = p.telemetry;

    // ---- grid: hold with brakes on
    const held = p.phase === 'pre' || p.phase === 'lights' || p.phase === 'formation';
    if (held) {
      c.brake = 1;
      this.prevPhase = p.phase;
      this.integ = 0;
      this.shiftOnly(c, tel, false);
      return c;
    }
    if (this.prevPhase === 'lights' || this.prevPhase === 'pre' || this.prevPhase === 'formation') {
      this.reactT = 0.15 + this.rng() * 0.25;
    }
    this.prevPhase = p.phase;
    if (this.reactT > 0) {
      this.reactT -= dt;
      c.brake = 1;
      this.shiftOnly(c, tel, false);
      return c;
    }

    if (Math.abs(speed) > 5) this.hasMoved = true;

    // ---- track geometry
    const frame = this.track.frameAt(p.s);
    const halfW = frame.halfWidth;
    const offTrack = Math.abs(p.lateral) > halfW + 0.3 && this.pitState === 'none';

    // ---- racecraft
    const rc = this.racecraft(p, dt, halfW, frame.curvature);

    // ---- pit state machine
    const pit = this.updatePit(p, dt, speed);

    // ---- recovery bookkeeping
    const inPitStuff = this.pitState !== 'none';
    const exempt = inPitStuff || p.phase === 'finished' || !this.hasMoved;
    if (exempt) { this.slowT = 0; this.stuckT = 0; }
    else {
      if (Math.abs(speed) < 1) this.slowT += dt; else this.slowT = 0;
      if (speed < 4) this.stuckT += dt; else this.stuckT = 0;
    }
    if (this.recovering) {
      if (tel.gear === -1) this.recT += dt;
      if (this.recT > 1.5) { this.recovering = false; this.slowT = 0; this.recT = 0; }
    } else if (this.slowT > 2) {
      this.recovering = true; this.recT = 0;
    }

    // ---- pure pursuit target
    // Shorter look-ahead at low speed so the car can turn out from behind a stopped car.
    const Ld = (this.overtakeSide !== 0 && Math.abs(speed) < 15 ? 4 : 8) + 0.45 * Math.abs(speed);
    let tx: number, tz: number;
    let desiredLatNow = this.track.racingLineOffset(p.s) + this.tactical;
    if (pit.target) {
      tx = pit.target.x; tz = pit.target.z;
      desiredLatNow = p.lateral;
    } else {
      const sT = p.s + Ld;
      const fT = this.track.frameAt(sT);
      const maxLat = Math.max(0, fT.halfWidth - 1.4);
      let lat = this.track.racingLineOffset(sT) + this.tactical;
      lat = clamp(lat, -maxLat, maxLat);
      if (offTrack) lat = clamp(this.track.racingLineOffset(sT) * 0.3, -maxLat, maxLat);
      tx = fT.position.x + fT.left.x * lat;
      tz = fT.position.z + fT.left.z * lat;
      desiredLatNow = clamp(desiredLatNow, -Math.max(0, halfW - 1.4), Math.max(0, halfW - 1.4));
    }
    const dx0 = tx - p.pose.position.x, dz0 = tz - p.pose.position.z;
    const dLeft = dx0 * lx + dz0 * lz;
    const dFwd = dx0 * fx + dz0 * fz;
    let steerPP: number;
    let facingAway = false;
    if (dFwd < 1) {
      steerPP = dLeft >= 0 ? 1 : -1;
      facingAway = dFwd < -2;
    } else {
      const k = (2 * dLeft) / (dLeft * dLeft + dFwd * dFwd);
      steerPP = Math.atan(WHEELBASE * k) / MAX_STEER;
    }
    // small PD on lateral / heading error relative to the track
    const tFwd = frame.tangent;
    const cosH = fx * tFwd.x + fz * tFwd.z;
    const sinH = lx * tFwd.x + lz * tFwd.z; // + when the track tangent lies to the car's left
    let steerCmd = steerPP;
    if (!pit.target && !facingAway && this.overtakeSide === 0) {
      const eLat = clamp(desiredLatNow - p.lateral, -3, 3);
      steerCmd += 0.012 * eLat;
      steerCmd += 0.06 * clamp(sinH, -0.4, 0.4) * (cosH > 0 ? 1 : 0);
    }
    steerCmd = clamp(steerCmd, -1, 1);
    const reversing = this.recovering;
    if (reversing) steerCmd = -steerCmd;

    const slow = offTrack || reversing;
    const rate = slow ? 4 : 16;
    this.steerSmooth += (steerCmd - this.steerSmooth) * Math.min(1, dt * rate);
    c.steer = clamp(this.steerSmooth, -1, 1);

    // ---- gearbox
    this.shiftOnly(c, tel, reversing);

    // ---- recovery: reverse
    if (reversing) {
      c.throttle = tel.gear === -1 && speed > -8 ? 1 : 0;
      c.brake = 0;
      this.integ = 0;
      return c;
    }

    // ---- target speed
    let vt = this.profileAt(p.s + Math.max(0, speed) * 0.12) * this.skillFactor * this.lapVar;
    if (p.phase === 'chequered' || p.phase === 'finished') vt *= 0.7;
    vt = Math.min(vt, rc.speedCap);
    if (pit.speedCap < vt) vt = pit.speedCap;
    if (offTrack) vt = Math.min(vt, 18);
    if (facingAway) vt = Math.min(vt, 9);
    if (Math.abs(desiredLatNow - p.lateral) > 4 && !pit.target) vt *= 0.85;
    if (pit.hold) vt = 0;

    // ---- longitudinal control
    const over = speed - vt;
    if (pit.hold) {
      c.brake = 1; c.throttle = 0; this.integ = 0;
    } else if (vt < 0.5) {
      c.brake = 0.6; c.throttle = 0; this.integ = 0;
    } else if (over > 1.5) {
      c.brake = clamp(0.3 + (over - 1.5) * 0.3, 0, 1);
      this.integ = 0;
    } else {
      const err = vt - speed;
      let thr = 0.4 * err + this.integ;
      if (thr > 0 && thr < 1) this.integ = clamp(this.integ + 0.2 * err * dt, 0, 0.7);
      if (vt >= 0 && speed < 0.3 && vt > 3) thr = Math.max(thr, 0.5);
      c.throttle = clamp(thr, 0, 1);
      // traction control
      const ws = tel.wheelSlip;
      const slip = ws && ws.length >= 4 ? Math.max(ws[2], ws[3]) : 0;
      // wheelSlip is normalised (1 = peak grip); back off once the rears go past the peak
      if (slip > 1.05) c.throttle *= Math.max(0.15, 1 - (slip - 1.05) * 2.5);
    }
    c.boost = rc.boost && c.throttle > 0.8;
    c.pitLimiter = pit.limiter;
    return c;
  }

  // ------------------------------------------------------------------ gearbox

  private shiftOnly(c: Controls, tel: Telemetry, wantReverse: boolean): void {
    if (this.shiftTimer < 0.25) return;
    const g = tel.gear;
    if (wantReverse) {
      if (g > -1) { c.shiftDown = true; this.shiftTimer = 0; }
      return;
    }
    if (g <= 0) { c.shiftUp = true; this.shiftTimer = 0; }
    else if (tel.rpm > 11300 && g < 8) { c.shiftUp = true; this.shiftTimer = 0; }
    else if (tel.rpm < 6500 && g > 1) { c.shiftDown = true; this.shiftTimer = 0; }
  }

  // ------------------------------------------------------------------ racecraft

  private racecraft(p: AIPerception, dt: number, halfW: number, curvature: number): { speedCap: number; boost: boolean } {
    let cap = Infinity;
    let boost = false;
    const speed = Math.max(p.speed, 0);
    const rl = this.track.racingLineOffset(p.s);
    let desiredLat: number | null = null; // absolute lateral wanted because of traffic
    let pushLat = 0;                      // lateral push from alongside cars
    const room = Math.max(0, halfW - 1.4);
    const straight = Math.abs(curvature) < 0.002 && Math.abs(this.track.frameAt(p.s + 80).curvature) < 0.003;
    let overtaking = false;

    // Only the nearest car directly ahead is the one to pass: deciding per car made the AI flip
    // sides between two slow cars and stop halfway (e.g. behind idle cars on the grid).
    let nearestId = '';
    let nearestDs = Infinity;
    for (const o of p.others) {
      const ds = this.wrapDs(o.s - p.s);
      if (ds > 0 && ds < nearestDs && Math.abs(o.lateral - p.lateral) < 2.3) { nearestDs = ds; nearestId = o.id; }
    }

    for (const o of p.others) {
      const ds = this.wrapDs(o.s - p.s);
      const dl = o.lateral - p.lateral;
      if (ds > 0 && ds < 70) {
        const overlap = Math.abs(dl) < 2.3;
        if (overlap) {
          let c = Math.max(0, o.speed + (ds - 9) * 0.5);
          if (o.id === nearestId && ds < 22 + 25 * this.aggression) {
            // Keep the side already chosen while still passing; pick a new one only for a new car.
            if (this.overtakeSide === 0 || (this.overtakeId !== o.id && this.overtakeHold <= 0)) {
              const roomL = halfW - o.lateral, roomR = halfW + o.lateral;
              this.overtakeSide = roomL >= roomR ? 1 : -1;
              this.overtakeId = o.id;
            }
            this.overtakeHold = 1.0;
            desiredLat = o.lateral + this.overtakeSide * 2.8;
            overtaking = true;
            // Keep enough speed to steer out from behind a slow or stopped car (a car that
            // brakes to a halt behind it can't move sideways), while there's a car length of room.
            if (ds > 6.5) c = Math.max(c, o.speed + 4 + (ds - 6.5) * 0.4);
          }
          cap = Math.min(cap, c);
        } else if (this.overtakeId === o.id && this.overtakeHold > 0 && ds < 40) {
          // keep going around until clear
          desiredLat = o.lateral + this.overtakeSide * 2.8;
          overtaking = true;
        }
        if (straight && Math.abs(dl) < 3.5 && ds > 3 && ds / Math.max(speed, 5) < 1 && p.telemetry.ersSoc > 0.3) boost = true;
      }
      // Alongside = actually overlapping side by side (within about a car length).
      if (ds > -5.5 && ds <= 5.5 && Math.abs(dl) < 2.5) {
        const dir = dl > 0.05 ? -1 : dl < -0.05 ? 1 : (o.id < this.driver.id ? 1 : -1);
        const need = 2.5 - Math.abs(dl) + 0.3;
        if (Math.abs(need) > Math.abs(pushLat)) pushLat = dir * need;
      }
    }
    if (!overtaking) this.overtakeHold = Math.max(0, this.overtakeHold - dt);
    if (this.overtakeHold <= 0) { this.overtakeSide = 0; this.overtakeId = ''; }

    let target = 0;
    // A car alongside must not push us back in behind the car we're passing.
    const pushFightsPass = desiredLat !== null && pushLat !== 0 && Math.sign(pushLat) !== Math.sign(desiredLat - p.lateral);
    if (pushLat !== 0 && !pushFightsPass) target = clamp(p.lateral + pushLat, -room, room) - rl;
    else if (desiredLat !== null) target = clamp(desiredLat, -room, room) - rl;
    if (Math.abs(curvature) > 0.01) target = clamp(target, -3, 3);
    const maxStep = 4 * dt;
    this.tactical += clamp(target - this.tactical, -maxStep, maxStep);
    if (target === 0 && Math.abs(this.tactical) < 0.01) this.tactical = 0;
    return { speedCap: cap, boost };
  }

  // ------------------------------------------------------------------ pit

  private ensureLaneLen(): void {
    if (this.laneLen > 0) return;
    let len = 0;
    let prev = this.track.pitLanePoint(0);
    for (let i = 1; i <= 40; i++) {
      const pt = this.track.pitLanePoint(i / 40);
      len += Math.hypot(pt.x - prev.x, pt.z - prev.z);
      prev = pt;
    }
    this.laneLen = Math.max(len, 1);
  }

  private updatePit(p: AIPerception, dt: number, speed: number): { target: { x: number; z: number } | null; speedCap: number; limiter: boolean; hold: boolean } {
    const out = { target: null as { x: number; z: number } | null, speedCap: Infinity, limiter: false, hold: false };
    const pitData = this.track.data.pit;
    const L = this.L;
    const vLim = Math.max(5, p.pitLimitKmh / 3.6 - 1);
    const dsEntry = (((pitData.entry * L - p.s) % L) + L) % L;
    // Shorter look-ahead at low speed so the car can turn out from behind a stopped car.
    const Ld = (this.overtakeSide !== 0 && Math.abs(speed) < 15 ? 4 : 8) + 0.45 * Math.abs(speed);

    if (this.pitState === 'none') {
      if (p.wantPit && this.pitCooldown <= 0 && p.phase === 'running' && dsEntry < 450) {
        this.pitState = 'approach';
        this.ensureLaneLen();
        this.pitT = 0;
      } else return out;
    }
    this.ensureLaneLen();

    if (this.pitState === 'approach') {
      if (!p.wantPit && dsEntry > 120) { this.pitState = 'none'; return out; }
      out.speedCap = Math.sqrt(vLim * vLim + 2 * 12 * Math.max(0, dsEntry - 20));
      if (dsEntry < Ld + 10) {
        const t = clamp((Ld - dsEntry) / this.laneLen, 0, 1);
        const pt = this.track.pitLanePoint(t);
        out.target = { x: pt.x, z: pt.z };
      }
      if (dsEntry < 4 || dsEntry > L - 25) {
        this.pitState = 'lane';
        this.pitT = 0;
        this.wantFell = false;
      }
      return out;
    }

    // lane / box / exit: advance the monotone lane parameter
    let best = this.pitT, bd = Infinity;
    const pos = p.pose.position;
    for (let t = this.pitT; t <= Math.min(1, this.pitT + 0.15); t += 0.004) {
      const pt = this.track.pitLanePoint(t);
      const d = (pt.x - pos.x) ** 2 + (pt.z - pos.z) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    this.pitT = best;
    out.limiter = true;
    const tTarget = Math.min(1, this.pitT + Ld / this.laneLen);
    const tp = this.track.pitLanePoint(tTarget);
    out.target = { x: tp.x, z: tp.z };

    const box = this.track.pitBox(this.pitBoxIdx);
    const dist = (box.t - this.pitT) * this.laneLen;
    if (!p.wantPit) this.wantFell = true;

    if (this.pitState === 'lane') {
      out.speedCap = Math.min(vLim, Math.sqrt(2 * 6 * Math.max(0, dist - 0.5)) + 0.0);
      if (dist <= 0.6 && Math.abs(speed) < 1.5) {
        this.pitState = 'box';
        this.boxT = 0;
        this.wantFell = !p.wantPit;
        this.boxStartCompound = p.telemetry.tyres?.[0]?.compound ?? '';
        this.boxStartWear = p.telemetry.tyres?.[0]?.wear ?? 0;
      } else if (dist < -3 && Math.abs(speed) < 1.5) {
        this.pitState = 'exit';
      }
      if (this.pitT >= 0.995 && dist < -3) this.pitState = 'exit';
      return out;
    }
    if (this.pitState === 'box') {
      this.boxT += dt;
      out.hold = true;
      const tyre = p.telemetry.tyres?.[0];
      const changed = !!tyre && (tyre.compound !== this.boxStartCompound || tyre.wear < this.boxStartWear - 0.02);
      if (this.boxT > 0.6 && (changed || this.wantFell || this.boxT > 12)) {
        this.pitState = 'exit';
        out.hold = false;
        out.speedCap = vLim;
      }
      return out;
    }
    // exit
    out.speedCap = vLim;
    if (this.pitT >= 0.985) {
      this.pitState = 'none';
      this.pitCooldown = 20;
      out.limiter = false;
      out.speedCap = Infinity;
      out.target = null;
    }
    return out;
  }
}
