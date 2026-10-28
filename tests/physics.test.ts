import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Car, defaultSetup, ENGINE_MAPS } from '../src/physics/car';
import { COMPOUNDS, newTyre, tyreForce } from '../src/physics/tyre';
import { resolveCarCollisions, type CollisionBody } from '../src/physics/collisions';
import type { Controls, Environment, GroundQuery, GroundSample } from '../src/types';

const DT = 1 / 240;
const NORMAL = new Vector3(0, 1, 0);
const SAMPLE: GroundSample = { height: 0, normal: NORMAL, surface: 'asphalt' };
const flat: GroundQuery = { sample: () => SAMPLE, barrier: () => null };
const dry: Environment = { wetness: 0, rubber: 0.5, airTempC: 25, trackTempC: 35 };
const PERF = { power: 1, downforce: 1, drag: 1, tyreWear: 1 };

function ctl(p: Partial<Controls> = {}): Controls {
  return { steer: 0, throttle: 0, brake: 0, shiftUp: false, shiftDown: false, boost: false, pitLimiter: false, ...p };
}

function makeCar(compound: 'soft' | 'medium' | 'hard' | 'inter' | 'wet' = 'medium'): Car {
  const car = new Car({ setup: { ...defaultSetup(), startCompound: compound }, performance: PERF });
  car.reset(0, 0, 0, flat);
  return car;
}

/** Throttle/shift driver helper: auto upshift at ~11000 rpm. Returns controls for this step. */
function drive(car: Car, c: Partial<Controls>, upRpm = 11000): Controls {
  const out = ctl(c);
  const t = car.telemetry;
  if (t.gear === 0 && out.throttle > 0) out.shiftUp = true;
  else if (t.gear >= 1 && t.gear < 8 && t.rpm > upRpm) out.shiftUp = true;
  return out;
}

describe('tyre model', () => {
  it('has the specified compound colours', () => {
    expect(COMPOUNDS.soft.color).toBe('#e10600');
    expect(COMPOUNDS.medium.color).toBe('#ffd400');
    expect(COMPOUNDS.hard.color).toBe('#f0f0f0');
    expect(COMPOUNDS.inter.color).toBe('#43b02a');
    expect(COMPOUNDS.wet.color).toBe('#0067ad');
  });

  it('produces sane combined-slip forces', () => {
    const t = newTyre('soft', 23);
    const pure = tyreForce(0, 0.1, 4000, t, 1, -0.05).fy;
    expect(pure).toBeLessThan(0);
    expect(Math.abs(pure) / 4000).toBeGreaterThan(2);
    const fyPure = Math.abs(tyreForce(0, 0.1, 4000, t, 1, -0.05).fy);
    const fyComb = Math.abs(tyreForce(0.1, 0.1, 4000, t, 1, -0.05).fy);
    expect(fyComb).toBeLessThan(fyPure);
    // load sensitivity: mu falls with load
    const muLow = Math.abs(tyreForce(0, 0.1, 2000, t, 1, -0.05).fy) / 2000;
    const muHigh = Math.abs(tyreForce(0, 0.1, 8000, t, 1, -0.05).fy) / 8000;
    expect(muHigh).toBeLessThan(muLow);
    // worn tyres give less grip
    const worn = newTyre('soft', 23); worn.wear = 0.95;
    expect(Math.abs(tyreForce(0, 0.1, 4000, worn, 1, -0.05).fy)).toBeLessThan(0.8 * Math.abs(pure));
  });
});

describe('car performance (flat ground)', () => {
  it('0-100 km/h in 2.2-3.0 s', () => {
    const car = makeCar();
    let t = 0;
    while (car.telemetry.speedKmh < 100 && t < 8) {
      car.step(DT, drive(car, { throttle: 1 }), flat, dry, false);
      t += DT;
    }
    console.log('0-100 s', t.toFixed(2), 'gear', car.telemetry.gear);
    expect(t).toBeGreaterThan(2.2);
    expect(t).toBeLessThan(3.0);
  });

  it('top speed with and without straight mode', () => {
    const run = (straight: boolean) => {
      const car = makeCar();
      car.ersSoc = 1;
      for (let i = 0; i < 240 * 70; i++) {
        car.step(DT, drive(car, { throttle: 1 }, 11300), flat, dry, straight);
        if (i % 2000 === 0) car.ersSoc = Math.max(car.ersSoc, 0.5);
      }
      return car.telemetry.speedKmh;
    };
    const a = run(true), b = run(false);
    console.log('top straight', a.toFixed(1), 'normal', b.toFixed(1));
    expect(a).toBeGreaterThan(330); expect(a).toBeLessThan(355);
    expect(b).toBeGreaterThan(295); expect(b).toBeLessThan(325);
  });

  it('corners at >= 4.5 g at 250 km/h', () => {
    const car = makeCar();
    for (let i = 0; i < 240 * 40 && car.telemetry.speedKmh < 250; i++) {
      car.step(DT, drive(car, { throttle: 1 }), flat, dry, false);
    }
    let steer = 0, best = 0, avg = 0;
    for (let i = 0; i < 240 * 6; i++) {
      steer = Math.min(1, steer + DT * 0.12);
      const kmh = car.telemetry.speedKmh;
      car.step(DT, drive(car, { steer, throttle: kmh < 250 ? 0.6 : 0.0 }), flat, dry, false);
      avg += (car.telemetry.latG - avg) * DT * 4; // ~0.25 s smoothing
      if (kmh > 235 && kmh < 265) best = Math.max(best, avg);
      expect(Number.isFinite(car.pose.position.x)).toBe(true);
    }
    console.log('lat g', best.toFixed(2), 'speed', car.telemetry.speedKmh.toFixed(0));
    expect(best).toBeGreaterThanOrEqual(4.5);
  });

  it('stops from 200 km/h in < 75 m without spinning', () => {
    const car = makeCar();
    for (let i = 0; i < 240 * 40 && car.telemetry.speedKmh < 200; i++) {
      car.step(DT, drive(car, { throttle: 1 }), flat, dry, false);
    }
    const start = car.pose.position.clone();
    let yawMax = 0;
    for (let i = 0; i < 240 * 10 && car.telemetry.speedKmh > 0.5; i++) {
      car.step(DT, ctl({ brake: 1 }), flat, dry, false);
      yawMax = Math.max(yawMax, Math.abs(car.pose.position.x - start.x));
    }
    const dist = car.pose.position.distanceTo(start);
    console.log('brake dist', dist.toFixed(1), 'lateral', yawMax.toFixed(2));
    expect(dist).toBeLessThan(75);
    expect(yawMax).toBeLessThan(2);
    expect(car.telemetry.speedKmh).toBeLessThan(1);
  });

  it('parked car stays put for 10 s', () => {
    const car = makeCar();
    const p0 = car.pose.position.clone();
    for (let i = 0; i < 240 * 10; i++) car.step(DT, ctl(), flat, dry, false);
    const p = car.pose.position;
    expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    expect(Math.hypot(p.x - p0.x, p.z - p0.z)).toBeLessThan(0.05);
    expect(Math.abs(p.y - p0.y)).toBeLessThan(0.03);
    expect(car.telemetry.speedKmh).toBeLessThan(0.5);
  });

  it('stays upright at full lock at 30 km/h', () => {
    const car = makeCar();
    for (let i = 0; i < 240 * 10 && car.telemetry.speedKmh < 30; i++) car.step(DT, drive(car, { throttle: 0.5 }), flat, dry, false);
    const up = new Vector3();
    let minUp = 1;
    for (let i = 0; i < 240 * 5; i++) {
      car.step(DT, drive(car, { steer: 1, throttle: car.telemetry.speedKmh < 30 ? 0.4 : 0 }), flat, dry, false);
      up.set(0, 1, 0).applyQuaternion(car.pose.quaternion);
      minUp = Math.min(minUp, up.y);
    }
    expect(minUp).toBeGreaterThan(0.8);
  });

  it('wears tyres, burns fuel, deploys and harvests ERS', () => {
    const car = makeCar();
    car.ersSoc = 0.8;
    const fuel0 = car.fuelKg;
    const soc0 = car.ersSoc;
    for (let i = 0; i < 240 * 20; i++) {
      car.step(DT, drive(car, { throttle: 1 }), flat, dry, true);
    }
    expect(car.ersSoc).toBeLessThan(soc0);
    for (let i = 240 * 20; i < 240 * 60; i++) {
      car.step(DT, drive(car, { throttle: 1, steer: Math.sin(i / 240) * 0.4 }), flat, dry, false);
    }
    expect(car.fuelKg).toBeLessThan(fuel0 - 1);
    expect(car.fuelKg).toBeGreaterThan(fuel0 - 2);
    expect(car.tyres[2].wear).toBeGreaterThan(0);
    console.log('wear', car.tyres.map((t) => t.wear.toExponential(2)), 'fuel', car.fuelKg.toFixed(2));
    const soc1 = car.ersSoc;
    for (let i = 0; i < 240 * 3; i++) car.step(DT, ctl({ brake: 0.7 }), flat, dry, false);
    expect(car.ersSoc).toBeGreaterThan(soc1);
  });

  it('shifts gears, reverses from standstill and honours the pit limiter', () => {
    const car = makeCar();
    car.step(DT, ctl({ shiftDown: true }), flat, dry, false);
    car.step(DT, ctl({ shiftDown: true }), flat, dry, false);
    expect(car.telemetry.gear).toBe(-1);
    for (let i = 0; i < 240 * 2; i++) car.step(DT, ctl({ throttle: 0.5 }), flat, dry, false);
    expect(car.forwardSpeed()).toBeLessThan(-0.5);

    const c2 = makeCar();
    c2.pitLimitKmh = 80;
    for (let i = 0; i < 240 * 20; i++) c2.step(DT, drive(c2, { throttle: 1, pitLimiter: true }), flat, dry, false);
    expect(c2.telemetry.speedKmh).toBeLessThan(84);
    expect(c2.telemetry.speedKmh).toBeGreaterThan(60);
  });

  it('hold freezes the car', () => {
    const car = makeCar();
    car.hold = true;
    for (let i = 0; i < 240; i++) car.step(DT, ctl({ throttle: 1 }), flat, dry, false);
    expect(car.telemetry.speedKmh).toBe(0);
    expect(Math.abs(car.pose.position.z)).toBeLessThan(1e-6);
  });

  it('wet weather: slicks lose grip, wets gain', () => {
    const wet: Environment = { ...dry, wetness: 1 };
    const g = (c: 'soft' | 'wet', env: Environment) => {
      const car = makeCar(c);
      for (let i = 0; i < 240 * 40 && car.telemetry.speedKmh < 150; i++) {
        car.step(DT, drive(car, { throttle: 1 }), flat, env, false);
      }
      let best = 0, steer = 0;
      for (let i = 0; i < 240 * 5; i++) {
        steer = Math.min(1, steer + DT * 0.15);
        car.step(DT, drive(car, { steer, throttle: car.telemetry.speedKmh < 150 ? 0.5 : 0 }), flat, env, false);
        best = Math.max(best, car.telemetry.latG);
      }
      return best;
    };
    expect(g('soft', wet)).toBeLessThan(0.7 * g('soft', dry));
    expect(g('wet', wet)).toBeGreaterThan(g('soft', wet));
  });
});

describe('tyre temperature and ERS', () => {
  it('keeps tyres at their optimal temperature', () => {
    for (const c of ['soft', 'medium', 'hard', 'inter', 'wet'] as const) {
      expect(newTyre(c, 23).tempC).toBe(COMPOUNDS[c].optimalTempC);
    }
    const car = makeCar('soft');
    for (let i = 0; i < 240 * 20; i++) car.step(DT, drive(car, { throttle: 1, steer: Math.sin(i / 200) * 0.6 }), flat, dry, false);
    for (const t of car.tyres) expect(t.tempC).toBe(COMPOUNDS.soft.optimalTempC);
    car.fitTyres('inter');
    for (const t of car.tyres) expect(t.tempC).toBe(COMPOUNDS.inter.optimalTempC);
  });

  it('recharges the battery when lifting off the throttle', () => {
    const car = makeCar();
    for (let i = 0; i < 240 * 12; i++) car.step(DT, drive(car, { throttle: 1 }), flat, dry, false);
    car.ersSoc = 0.3;
    for (let i = 0; i < 240 * 2; i++) car.step(DT, ctl(), flat, dry, false);
    expect(car.telemetry.ersHarvestKw).toBeGreaterThan(50);
    expect(car.ersSoc).toBeGreaterThan(0.31);
  });

  it('super clips at full throttle on a low battery and selects engine maps', () => {
    const top = (map: number, soc: number) => {
      const car = makeCar();
      let clipped = false, socEnd = 0;
      for (let i = 0; i < 240 * 60; i++) {
        car.ersSoc = Math.min(car.ersSoc, soc);
        car.step(DT, drive(car, { throttle: 1, engineMap: map }, 11300), flat, dry, false);
        clipped ||= car.telemetry.superClip;
        socEnd = car.ersSoc;
      }
      return { v: car.telemetry.speedKmh, clipped, socEnd, map: car.telemetry.engineMap };
    };
    const charge = top(0, 0.3), quali = top(3, 0.3);
    expect(charge.map).toBe(0);
    expect(quali.map).toBe(3);
    expect(charge.clipped).toBe(true);
    expect(quali.clipped).toBe(false);
    expect(charge.v).toBeLessThan(quali.v - 5);
    // clipping charges the battery even flat out
    const c2 = makeCar();
    for (let i = 0; i < 240 * 40; i++) c2.step(DT, drive(c2, { throttle: 1, engineMap: 0 }, 11300), flat, dry, false);
    const s0 = c2.ersSoc = 0.3;
    for (let i = 0; i < 240 * 5; i++) c2.step(DT, drive(c2, { throttle: 1, engineMap: 0 }, 11300), flat, dry, false);
    expect(c2.telemetry.superClip).toBe(true);
    expect(c2.ersSoc).toBeGreaterThan(s0);
    expect(ENGINE_MAPS.length).toBe(4);
  });
});

describe('rollover', () => {
  it('stays upright on fresh softs with a slow steering ramp at 150 km/h', () => {
    const car = makeCar('soft');
    for (let i = 0; i < 240 * 30 && car.telemetry.speedKmh < 150; i++) car.step(DT, drive(car, { throttle: 1 }), flat, dry, false);
    const up = new Vector3();
    let minUp = 1, steer = 0;
    for (let i = 0; i < 240 * 4; i++) {
      steer = Math.min(1, steer + DT * 0.5);
      car.step(DT, drive(car, { steer, throttle: 0.6 }), flat, dry, false);
      up.set(0, 1, 0).applyQuaternion(car.pose.quaternion);
      minUp = Math.min(minUp, up.y);
    }
    expect(minUp).toBeGreaterThan(0.9);
  });

  it('a car upside down slides on its body instead of sinking through the ground', () => {
    const car = makeCar();
    car.applyImpulse(new Vector3(0, 0, 40 * car.massKg), car.pose.position);
    // flip it 180 degrees about the forward axis, 1.5 m up
    const c = car as any;
    c.qx = 0; c.qy = 0; c.qz = 1; c.qw = 0; c.py = 1.5;
    let minY = Infinity;
    for (let i = 0; i < 240 * 5; i++) {
      car.step(DT, ctl(), flat, dry, false);
      minY = Math.min(minY, car.pose.position.y);
    }
    // pose origin sits ~0.3 m below the CG, so upside down it is ~0.3 m above the CG's resting height
    expect(c.py).toBeGreaterThan(0.4);
    expect(c.py).toBeLessThan(1.2);
    expect(minY).toBeGreaterThan(0);
    expect(car.telemetry.speedKmh).toBeLessThan(144);
  });
});

describe('collisions', () => {
  function body(id: string, x: number, z: number, car: Car | null): CollisionBody {
    return { id, position: new Vector3(x, 0, z), quaternion: new Quaternion(), velocity: new Vector3(), car };
  }

  it('pushes overlapping cars apart and exchanges momentum', () => {
    const a = makeCar(), b = makeCar();
    a.reset(0, 0, 0, flat); b.reset(0, 4, 0, flat);
    a.applyImpulse(new Vector3(0, 0, 30 * a.massKg), a.pose.position);
    const ba = body('a', 0, 0, a), bb = body('b', 0, 4, b);
    ba.position.copy(a.pose.position); bb.position.copy(b.pose.position);
    ba.velocity.copy(a.pose.velocity);
    resolveCarCollisions([ba, bb]);
    expect(b.pose.velocity.z).toBeGreaterThan(10);
    expect(a.pose.velocity.z).toBeLessThan(30);
    expect(Number.isFinite(a.pose.position.x)).toBe(true);
  });

  it('treats kinematic bodies as immovable', () => {
    const a = makeCar();
    a.reset(0, 0, 0, flat);
    a.applyImpulse(new Vector3(0, 0, 30 * a.massKg), a.pose.position);
    const ba = body('a', 0, 0, a);
    ba.position.copy(a.pose.position); ba.velocity.copy(a.pose.velocity);
    const k = body('k', 0, 4, null);
    resolveCarCollisions([ba, k]);
    expect(k.position.z).toBe(4);
    expect(a.pose.velocity.z).toBeLessThan(10);
  });

  it('barrier pushes the car out and kills normal velocity', () => {
    const wall: GroundQuery = {
      sample: () => SAMPLE,
      barrier: (x) => (x > 5 ? { nx: -1, nz: 0, depth: x - 5 } : null),
    };
    const car = makeCar();
    car.reset(0, 0, Math.PI / 2, wall); // face +X
    for (let i = 0; i < 240 * 6; i++) car.step(DT, drive(car, { throttle: 1 }), wall, dry, false);
    expect(car.pose.position.x).toBeLessThan(6.5);
    expect(Number.isFinite(car.pose.position.x)).toBe(true);
    expect(car.pose.velocity.x).toBeLessThan(5);
  });
});
