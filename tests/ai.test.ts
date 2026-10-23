import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from 'three';
import { AIDriver, computeSpeedProfile, type AIPerception } from '../src/ai/aiDriver';
import { planStrategy } from '../src/ai/strategy';
import type { CarPose, CircuitData, Controls, Driver, ITrack, SessionPhase, TrackFrame, Telemetry } from '../src/types';

// ---------------------------------------------------------------- fake track (left-turning curvature field)

const MU = 2.5;
const G = 9.81;

function makeTrack(kappa: (s: number) => number, length: number, pitRadiusInset = 10): ITrack {
  const spacing = 2;
  const n = Math.round(length / spacing);
  const sp = length / n;
  const xs = new Float64Array(n + 1), zs = new Float64Array(n + 1), psi = new Float64Array(n + 1);
  let x = 0, z = 0, h = 0;
  for (let i = 0; i <= n; i++) {
    xs[i] = x; zs[i] = z; psi[i] = h;
    const k = kappa(i * sp);
    const hm = h + 0.5 * k * sp;
    x += Math.sin(hm) * sp; z += Math.cos(hm) * sp; h += k * sp;
  }
  const frameAt = (s: number): TrackFrame => {
    const f = (((s % length) + length) % length) / sp;
    const i = Math.floor(f), t = f - i;
    const px = xs[i] * (1 - t) + xs[i + 1] * t, pz = zs[i] * (1 - t) + zs[i + 1] * t;
    const h2 = psi[i] * (1 - t) + psi[i + 1] * t;
    return {
      s, position: new Vector3(px, 0, pz),
      tangent: new Vector3(Math.sin(h2), 0, Math.cos(h2)),
      left: new Vector3(Math.cos(h2), 0, -Math.sin(h2)),
      halfWidth: 6, curvature: kappa(((s % length) + length) % length),
    };
  };
  const R = length / (2 * Math.PI);
  const pitPoint = (t: number): Vector3 => {
    // Only valid for the circular fake: lane inside the corner from 90% to 110% of the lap.
    const a = (0.9 + 0.2 * t) * 2 * Math.PI;
    const r = R - pitRadiusInset;
    return new Vector3(R - r * Math.cos(a), 0, r * Math.sin(a));
  };
  const data = {
    id: 'fake', halfWidth: 6, sectors: [0.3, 0.7],
    pit: { side: 'left', entry: 0.9, exit: 0.1, offsetM: pitRadiusInset, speedLimitKmh: 80 },
  } as unknown as CircuitData;
  const track = {
    data, length, sampleSpacing: sp, sampleCount: n,
    frameAt,
    racingLineOffset: () => 0,
    pitLanePoint: pitPoint,
    pitBox: (_k: number) => ({ position: pitPoint(0.5), heading: 0, t: 0.5 }),
  } as unknown as ITrack;
  return track;
}

// ---------------------------------------------------------------- test car

const TOP = [22, 34, 46, 58, 70, 82, 94, 106];
const DRIVER: Driver = { id: 'x', firstName: 'X', lastName: 'Y', code: 'XYZ', number: 1, teamId: 't', nationality: 'GBR', skill: 1, aggression: 0.5 };

class TestCar {
  x: number; z: number; psi: number; v = 0; gear = 1; hold = false;
  compound: 'medium' | 'hard' = 'medium';
  shiftTimes: number[] = [];
  private lastShift = false;
  consecutiveShifts = 0;
  constructor(readonly track: ITrack, s0 = 0, lateral = 0, v0 = 0) {
    const f = track.frameAt(s0);
    this.x = f.position.x + f.left.x * lateral; this.z = f.position.z + f.left.z * lateral;
    this.psi = Math.atan2(f.tangent.x, f.tangent.z);
    this.v = v0;
  }
  rpm(): number { return Math.max(4000, (11800 * Math.abs(this.v)) / TOP[Math.max(0, this.gear - 1)]); }
  step(c: Controls, dt: number, stepIdx: number) {
    const shifted = c.shiftUp || c.shiftDown;
    if (shifted && this.lastShift) this.consecutiveShifts++;
    this.lastShift = shifted;
    if (c.shiftUp && this.gear < 8) this.gear++;
    else if (c.shiftDown && this.gear > -1) this.gear--;
    if (shifted) this.shiftTimes.push(stepIdx);
    if (this.hold) { this.v = 0; return; }
    const delta = c.steer * (17 * Math.PI) / 180;
    let yawRate = (this.v * Math.tan(delta)) / 3.4;
    const ay = this.v * yawRate;
    let scrub = 0;
    if (Math.abs(ay) > MU * G) {
      yawRate = Math.sign(yawRate) * (MU * G) / Math.max(1, Math.abs(this.v));
      scrub = (Math.abs(ay) - MU * G) * 0.3;
    }
    const longAvail = Math.sqrt(Math.max(0, (MU * G) ** 2 - Math.min(ay * ay, (MU * G) ** 2)));
    let a = 0;
    const dir = this.gear === -1 ? -1 : 1;
    if (c.throttle > 0) a += dir * c.throttle * Math.min(longAvail, Math.max(1.5, 12 - (10 * Math.abs(this.v)) / 90));
    a -= 0.0004 * this.v * Math.abs(this.v);
    if (c.brake > 0) a -= Math.sign(this.v || 1) * c.brake * Math.min(longAvail, 30);
    a -= Math.sign(this.v) * scrub;
    const v0 = this.v;
    this.v += a * dt;
    if (c.brake > 0 && v0 * this.v < 0) this.v = 0;
    this.psi += yawRate * dt;
    this.x += Math.sin(this.psi) * this.v * dt;
    this.z += Math.cos(this.psi) * this.v * dt;
  }
  pose(): CarPose {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), this.psi);
    return {
      position: new Vector3(this.x, 0, this.z), quaternion: q,
      velocity: new Vector3(Math.sin(this.psi) * this.v, 0, Math.cos(this.psi) * this.v),
      steerAngle: 0, wheelSpin: [0, 0, 0, 0], wheelCompression: [0, 0, 0, 0],
    };
  }
}

/** s / lateral for the circular fake track. */
function project(track: ITrack, car: TestCar) {
  const R = track.length / (2 * Math.PI);
  const rx = R - car.x, rz = car.z;
  let ang = Math.atan2(rz, rx);
  if (ang < 0) ang += 2 * Math.PI;
  return { s: ang * R, lateral: R - Math.hypot(rx, rz) };
}

function telemetry(car: TestCar): Telemetry {
  return {
    speedKmh: car.v * 3.6, rpm: car.rpm(), gear: car.gear, throttle: 0, brake: 0, steer: 0, latG: 0, longG: 0,
    ersSoc: 0.8, ersDeployKw: 0, fuelKg: 50, straightMode: false,
    tyres: [0, 1, 2, 3].map(() => ({ compound: car.compound, wear: 0, tempC: 90, pressurePsi: 23 })),
    wheelSlip: [0, 0, 0, 0], wheelLoadN: [0, 0, 0, 0], surface: ['asphalt', 'asphalt', 'asphalt', 'asphalt'], pitLimiter: false,
  };
}

function perception(track: ITrack, car: TestCar, over: Partial<AIPerception> = {}): AIPerception {
  const pr = project(track, car);
  return {
    s: pr.s, lateral: pr.lateral, speed: car.v, pose: car.pose(), telemetry: telemetry(car),
    others: [], phase: 'running' as SessionPhase, wantPit: false, pitLimitKmh: 80, ...over,
  };
}

const R = 150;
const LEN = 2 * Math.PI * R;

function drive(laps: number, seed: number, driver = DRIVER, mu = MU) {
  const track = makeTrack(() => 1 / R, LEN);
  const ai = new AIDriver(track, driver, 1, seed, { mu, downforceFactor: 0 });
  const car = new TestCar(track);
  const dt = 1 / 120;
  let t = 0, maxLat = 0, lapsDone = 0, prevS = 0, lapStartT = 0;
  const lapTimes: number[] = [];
  let step = 0;
  let hash = 0;
  while (lapsDone < laps && t < 200) {
    const c = ai.update(dt, perception(track, car));
    car.step(c, dt, step++);
    t += dt;
    const pr = project(track, car);
    maxLat = Math.max(maxLat, Math.abs(pr.lateral));
    if (prevS > 0.9 * LEN && pr.s < 0.1 * LEN) { lapsDone++; lapTimes.push(t - lapStartT); lapStartT = t; }
    prevS = pr.s;
    hash = (hash * 31 + Math.round(c.steer * 1e4) + Math.round(c.throttle * 1e3) * 7 + Math.round(c.brake * 1e3)) | 0;
  }
  return { car, maxLat, lapTimes, hash, t, lapsDone };
}

describe('speed profile', () => {
  it('is slower in tighter corners and respects the grip limit', () => {
    const len = 1000;
    const track = makeTrack((s) => (s < 500 ? 1 / 150 : 1 / 60), len);
    const p = computeSpeedProfile(track, 3, 0);
    expect(p.length).toBe(track.sampleCount);
    const wide = p[Math.floor(p.length * 0.2)], tight = p[Math.floor(p.length * 0.8)];
    expect(tight).toBeLessThan(wide);
    // A constant-radius arc can only brake/accelerate on the friction-circle remainder, so allow a few % below the limit.
    expect(wide).toBeLessThanOrEqual(Math.sqrt(3 * G * 150) + 0.5);
    expect(wide).toBeGreaterThan(0.93 * Math.sqrt(3 * G * 150));
    expect(tight).toBeLessThanOrEqual(Math.sqrt(3 * G * 60) + 0.5);
    expect(tight).toBeGreaterThan(0.93 * Math.sqrt(3 * G * 60));
    for (const v of p) expect(v).toBeLessThanOrEqual(95);
  });
  it('downforce raises corner speed and straights are capped', () => {
    const track = makeTrack(() => 1 / 300, 2000);
    const a = computeSpeedProfile(track, 1.8, 0)[10];
    const b = computeSpeedProfile(track, 1.8, 0.0001)[10];
    expect(b).toBeGreaterThan(a);
    const straight = makeTrack(() => 0, 3000);
    expect(computeSpeedProfile(straight, 2, 0.0001)[5]).toBeCloseTo(95, 3);
  });
  it('braking zone precedes a tight corner', () => {
    const track = makeTrack((s) => (s > 700 && s < 800 ? 1 / 40 : 0), 1500);
    const p = computeSpeedProfile(track, 2.5, 0);
    const i = (m: number) => Math.round(m / track.sampleSpacing);
    expect(p[i(650)]).toBeLessThan(p[i(300)]);
    expect(p[i(750)]).toBeLessThan(p[i(650)]);
    // deceleration never above 5 g
    for (let k = 1; k < p.length; k++) {
      const a = (p[k - 1] ** 2 - p[k] ** 2) / (2 * track.sampleSpacing);
      expect(a).toBeLessThan(5 * G + 0.5);
    }
  });
});

describe('AIDriver', () => {
  it('drives 3 laps inside the track at near the grip-limited speed', () => {
    const r = drive(3, 11);
    expect(r.lapsDone).toBe(3);
    expect(r.maxLat).toBeLessThan(6);
    const lap = r.lapTimes[2];
    const vAvg = LEN / lap;
    const vLim = Math.sqrt(MU * G * R);
    expect(vAvg).toBeGreaterThan(0.9 * vLim);
    expect(vAvg).toBeLessThan(1.1 * vLim);
  });

  it('is deterministic for equal seeds and differs across seeds', () => {
    const a = drive(1, 5), b = drive(1, 5), c = drive(1, 6);
    expect(a.hash).toBe(b.hash);
    expect(a.t).toBe(b.t);
    expect(c.hash).not.toBe(a.hash);
  });

  it('shift edges are never true on two consecutive updates and gears climb', () => {
    const r = drive(1, 3);
    expect(r.car.consecutiveShifts).toBe(0);
    expect(r.car.shiftTimes.length).toBeGreaterThan(3);
    for (let i = 1; i < r.car.shiftTimes.length; i++) {
      expect(r.car.shiftTimes[i] - r.car.shiftTimes[i - 1]).toBeGreaterThanOrEqual(30); // >= 0.25 s at 120 Hz
    }
  });

  it('holds on the grid before lights out and launches afterwards', () => {
    const track = makeTrack(() => 1 / R, LEN);
    const ai = new AIDriver(track, DRIVER, 1, 2, { mu: MU, downforceFactor: 0 });
    const car = new TestCar(track, LEN - 8);
    for (const phase of ['pre', 'lights'] as SessionPhase[]) {
      const c = ai.update(1 / 60, perception(track, car, { phase }));
      expect(c.brake).toBe(1);
      expect(c.throttle).toBe(0);
    }
    let thr = 0;
    for (let i = 0; i < 120; i++) {
      const c = ai.update(1 / 60, perception(track, car, { phase: 'running' }));
      thr = Math.max(thr, c.throttle);
      car.step(c, 1 / 60, i);
    }
    expect(thr).toBeGreaterThan(0.5);
    expect(car.v).toBeGreaterThan(5);
  });

  it('backs off the throttle when rear wheels slip', () => {
    const track = makeTrack(() => 1 / R, LEN);
    const ai = new AIDriver(track, DRIVER, 1, 2, { mu: MU, downforceFactor: 0 });
    const car = new TestCar(track, 0, 0, 20);
    const p = perception(track, car);
    const full = ai.update(1 / 60, p).throttle;
    const ai2 = new AIDriver(track, DRIVER, 1, 2, { mu: MU, downforceFactor: 0 });
    p.telemetry.wheelSlip = [0, 0, 1.6, 1.6];
    const slipped = ai2.update(1 / 60, p).throttle;
    expect(full).toBeGreaterThan(0);
    expect(slipped).toBeLessThan(full);
  });

  it('does not rear-end a slower car ahead and keeps lateral separation when passing', () => {
    const track = makeTrack(() => 1 / R, LEN);
    const ai = new AIDriver(track, DRIVER, 1, 4, { mu: MU, downforceFactor: 0 });
    const car = new TestCar(track, 0, 0, 30);
    const other = new TestCar(track, 60, 0, 30);
    const dt = 1 / 120;
    let minDist = Infinity;
    let passed = false;
    for (let i = 0; i < 120 * 40; i++) {
      // Other car is a scripted slow runner on the centre line.
      const oPr = project(track, other);
      const oc = { steer: 0, throttle: 0, brake: 0, shiftUp: false, shiftDown: false, boost: false, pitLimiter: false };
      // simple hold at ~35 m/s with the AI's own steering law is overkill; teleport along the circle instead.
      const s = (oPr.s + 35 * dt) % LEN;
      const f = track.frameAt(s);
      other.x = f.position.x; other.z = f.position.z; other.psi = Math.atan2(f.tangent.x, f.tangent.z); other.v = 35;
      void oc;
      const me = project(track, car);
      const op = project(track, other);
      const c = ai.update(dt, perception(track, car, { others: [{ id: 'o', s: op.s, lateral: op.lateral, speed: 35 }] }));
      car.step(c, dt, i);
      minDist = Math.min(minDist, Math.hypot(car.x - other.x, car.z - other.z));
      let ds = op.s - me.s; if (ds > LEN / 2) ds -= LEN; if (ds < -LEN / 2) ds += LEN;
      if (ds < -10) passed = true;
    }
    expect(minDist).toBeGreaterThan(2.0);
    expect(passed).toBe(true);
  });

  it('reverses when stuck and requests a reset after 8 s', () => {
    const track = makeTrack(() => 1 / R, LEN);
    const ai = new AIDriver(track, DRIVER, 1, 8, { mu: MU, downforceFactor: 0 });
    const car = new TestCar(track, 100, 0, 20);
    // let it move so it counts as "has moved"
    for (let i = 0; i < 120; i++) { const c = ai.update(1 / 120, perception(track, car)); car.step(c, 1 / 120, i); }
    car.hold = true; car.v = 0; // wedged
    let sawReverseGearRequest = false;
    let reset = false;
    for (let i = 0; i < 120 * 12 && !reset; i++) {
      const c = ai.update(1 / 120, perception(track, car));
      if (c.shiftDown) sawReverseGearRequest = true;
      car.step(c, 1 / 120, 1000 + i);
      reset = ai.needsReset();
    }
    expect(sawReverseGearRequest).toBe(true);
    expect(reset).toBe(true);
  });

  it('makes a pit stop: limiter in the lane, stops at the box, leaves and rejoins', () => {
    const track = makeTrack(() => 1 / R, LEN);
    // AI plans below the car's friction limit (as it would on a track with a straight before the pit entry),
    // otherwise the test car has no spare grip to brake while cornering.
    const ai = new AIDriver(track, DRIVER, 1, 9, { mu: 1.2, downforceFactor: 0 });
    ai.setPitBox(3);
    const car = new TestCar(track, LEN * 0.6, 0, 40);
    const dt = 1 / 120;
    const box = track.pitBox(3).position;
    let wantPit = true;
    let stoppedAtBox = false, stopT = 0, maxLaneSpeed = 0, limiterSeen = false, done = false;
    let t = 0;
    for (let i = 0; i < 120 * 150 && !done; i++) {
      const pr = project(track, car);
      const lapFrac = pr.s / LEN;
      const inLane = lapFrac > 0.9 || lapFrac < 0.1;
      const c = ai.update(dt, perception(track, car, { wantPit }));
      const dBox = Math.hypot(car.x - box.x, car.z - box.z);
      if (stoppedAtBox && car.hold && t - stopT > 3) { car.hold = false; car.compound = 'hard'; }
      else if (!stoppedAtBox && Math.abs(car.v) < 0.3 && dBox < 6 && t > 5) {
        stoppedAtBox = true; stopT = t; car.hold = true; wantPit = false; // world: service starts, wantPit clears
      }
      if (c.pitLimiter) { limiterSeen = true; maxLaneSpeed = Math.max(maxLaneSpeed, car.v); }
      // emulate the limiter on the physics side
      if (c.pitLimiter && car.v > 80 / 3.6) car.v = 80 / 3.6;
      car.step(c, dt, i);
      t += dt;
      if (stoppedAtBox && !car.hold && t - stopT > 4 && !inLane && Math.abs(pr.lateral) < 6 && car.v > 20) done = true;
      void inLane;
    }
    expect(stoppedAtBox).toBe(true);
    expect(limiterSeen).toBe(true);
    expect(maxLaneSpeed).toBeLessThanOrEqual(80 / 3.6 + 2);
    expect(done).toBe(true);
  });
});

describe('planStrategy', () => {
  it('wet: single inter/wet stint, no stops', () => {
    const s = planStrategy(50, 1, true, 3);
    expect(s.stopLaps).toEqual([]);
    expect(['inter', 'wet']).toContain(s.compounds[0]);
  });
  it('dry: at least two dry compounds, stops mid-race, mostly one stop', () => {
    let ones = 0;
    for (let seed = 0; seed < 200; seed++) {
      const s = planStrategy(60, 1, false, seed);
      expect(new Set(s.compounds).size).toBeGreaterThanOrEqual(2);
      expect(s.compounds.length).toBe(s.stopLaps.length + 1);
      expect(s.stopLaps.length).toBeGreaterThanOrEqual(1);
      if (s.stopLaps.length === 1) { ones++; expect(s.stopLaps[0]).toBeGreaterThanOrEqual(20); expect(s.stopLaps[0]).toBeLessThanOrEqual(34); }
      for (let i = 1; i < s.stopLaps.length; i++) expect(s.stopLaps[i]).toBeGreaterThan(s.stopLaps[i - 1]);
    }
    expect(ones).toBeGreaterThan(100);
  });
  it('wearMul 0: one stop at 50%; deterministic', () => {
    const s = planStrategy(40, 0, false, 1);
    expect(s.stopLaps).toEqual([20]);
    expect(planStrategy(40, 1, false, 77)).toEqual(planStrategy(40, 1, false, 77));
  });
});
