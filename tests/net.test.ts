import { describe, it, expect } from 'vitest';
import {
  generateRoomCode, normaliseRoomCode, isValidRoomCode, peerIdForCode,
} from '../src/net/codes';
import { packCar, unpackCar, channelFor, relayTargets, sendTargets } from '../src/net/net';
import { RemoteCarBuffer } from '../src/net/interp';
import type { NetCarState, NetMessage } from '../src/types';

function car(t: number, x: number, vx = 0, extra: Partial<NetCarState> = {}): NetCarState {
  return {
    id: 'p:abc', t, p: [x, 0.5, 0], q: [0, 0, 0, 1], v: [vx, 0, 0],
    steer: 0, speedKmh: Math.abs(vx) * 3.6, gear: 4, brake: 0, compound: 'soft', inPit: false, ...extra,
  };
}

describe('room codes', () => {
  it('generates valid 6-char codes from the alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const c = generateRoomCode();
      expect(c).toHaveLength(6);
      expect(isValidRoomCode(c)).toBe(true);
      expect(/[01OIL]/.test(c)).toBe(false);
    }
  });
  it('is deterministic with an rng and handles rng extremes', () => {
    expect(generateRoomCode(() => 0)).toBe('AAAAAA');
    expect(isValidRoomCode(generateRoomCode(() => 0.999999999))).toBe(true);
    expect(isValidRoomCode(generateRoomCode(() => 1))).toBe(true);
  });
  it('normalises input', () => {
    expect(normaliseRoomCode(' ab-c d2 e3 ')).toBe('ABCD2E3');
    expect(normaliseRoomCode('abc-def')).toBe('ABCDEF');
  });
  it('validates', () => {
    expect(isValidRoomCode('ABCDEF')).toBe(true);
    expect(isValidRoomCode('ABCDE')).toBe(false);
    expect(isValidRoomCode('ABCDEFG')).toBe(false);
    expect(isValidRoomCode('ABCDE0')).toBe(false);
    expect(isValidRoomCode('abcdef')).toBe(false);
  });
  it('maps to peer id', () => {
    expect(peerIdForCode('abc-def')).toBe('afg-ABCDEF');
  });
});

describe('packCar / unpackCar', () => {
  const s = car(123456.789, 12.3456789, 83.123456, {
    p: [12.3456789, 0.123456, -400.98765], q: [0.1234567, -0.7654321, 0.0001234, 0.6], steer: 0.2345678,
    brake: 0.55555, id: 'p:peer-1234567890',
  });
  it('round-trips within 1e-3', () => {
    const u = unpackCar(JSON.parse(JSON.stringify(packCar(s))));
    for (let i = 0; i < 3; i++) { expect(Math.abs(u.p[i] - s.p[i])).toBeLessThanOrEqual(1e-3); expect(Math.abs(u.v[i] - s.v[i])).toBeLessThanOrEqual(1e-3); }
    for (let i = 0; i < 4; i++) expect(Math.abs(u.q[i] - s.q[i])).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(u.steer - s.steer)).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(u.t - s.t)).toBeLessThanOrEqual(0.5);
    expect(u.id).toBe(s.id);
    expect(u.compound).toBe('soft');
  });
  it('is small on the wire', () => {
    const msg: NetMessage = { type: 'car', state: packCar(s) };
    expect(JSON.stringify(msg).length).toBeLessThan(300);
  });
  it('sanitises garbage', () => {
    const u = unpackCar({ ...s, p: [NaN, 1] as unknown as [number, number, number] });
    expect(u.p).toEqual([0, 1, 0]);
  });
});

describe('routing helpers', () => {
  it('routes car/cars on the unreliable channel, rest reliable', () => {
    expect(channelFor('car')).toBe('u');
    expect(channelFor('cars')).toBe('u');
    for (const t of ['hello', 'lobby', 'ready', 'start', 'lap', 'session', 'chat', 'leave']) expect(channelFor(t)).toBe('r');
  });
  it('relays only car messages to other clients', () => {
    const car1: NetMessage = { type: 'car', state: car(0, 0) };
    expect(relayTargets(car1, 'b', ['a', 'b', 'c'])).toEqual(['a', 'c']);
    expect(relayTargets({ type: 'chat', from: 'x', text: 'y' }, 'b', ['a', 'b'])).toEqual([]);
    expect(relayTargets({ type: 'cars', states: [] }, 'b', ['a', 'b'])).toEqual([]);
  });
  it('picks send targets', () => {
    expect(sendTargets(false, ['host'], 'zzz')).toEqual(['host']);
    expect(sendTargets(false, [])).toEqual([]);
    expect(sendTargets(true, ['a', 'b'])).toEqual(['a', 'b']);
    expect(sendTargets(true, ['a', 'b'], 'b')).toEqual(['b']);
    expect(sendTargets(true, ['a', 'b'], 'x')).toEqual([]);
  });
});

describe('RemoteCarBuffer', () => {
  it('returns null when empty', () => {
    expect(new RemoteCarBuffer().sample(0)).toBeNull();
  });

  it('interpolates midpoint between two states', () => {
    const b = new RemoteCarBuffer();
    // sender clock t, local = t + 1000 (constant offset, zero latency)
    b.push(car(1000, 0, 10), 2000);
    b.push(car(1100, 1, 10), 2100);
    // render time = local - offset(1000) - 100 -> want 1050 => local 2150
    const p = b.sample(2150)!;
    expect(p.position.x).toBeCloseTo(0.5, 2);
    expect(p.velocity.x).toBeCloseTo(10, 5);
  });

  it('slerps orientation and lerps steer', () => {
    const b = new RemoteCarBuffer();
    const h = Math.SQRT1_2;
    b.push(car(0, 0, 0, { q: [0, 0, 0, 1], steer: 0 }), 0);
    b.push(car(100, 0, 0, { q: [0, h, 0, h], steer: 0.4 }), 100); // 90 deg yaw
    const p = b.sample(150)!; // render t = 50
    expect(p.quaternion.y).toBeCloseTo(Math.sin(Math.PI / 8), 3);
    expect(p.quaternion.w).toBeCloseTo(Math.cos(Math.PI / 8), 3);
    expect(p.steerAngle).toBeCloseTo(0.2, 5);
  });

  it('extrapolates with velocity capped at 250 ms then holds', () => {
    const b = new RemoteCarBuffer();
    b.push(car(0, 0, 20), 0);
    b.push(car(100, 2, 20), 100);
    // render time 100 + 100 => local 300: 100 ms extrapolation
    expect(b.sample(300)!.position.x).toBeCloseTo(2 + 20 * 0.1, 3);
    // 250 ms cap
    const x250 = 2 + 20 * 0.25;
    expect(b.sample(100 + 100 + 250)!.position.x).toBeCloseTo(x250, 3);
    expect(b.sample(5000)!.position.x).toBeCloseTo(x250, 3);
  });

  it('handles out-of-order and duplicate packets', () => {
    const b = new RemoteCarBuffer();
    b.push(car(200, 2, 10), 200);
    b.push(car(0, 0, 10), 200);   // late
    b.push(car(100, 1, 10), 200); // late
    b.push(car(100, 1, 10), 200); // duplicate
    expect(b.size).toBe(3);
    const p = b.sample(150)!;     // render ~50 ms (offset drifts slightly up on late packets)
    expect(Math.abs(p.position.x - 0.5)).toBeLessThan(0.1);
  });

  it('keeps at most 20 states', () => {
    const b = new RemoteCarBuffer();
    for (let i = 0; i < 50; i++) b.push(car(i * 50, i), i * 50);
    expect(b.size).toBe(20);
  });

  it('estimates clock offset robustly against jitter', () => {
    const b = new RemoteCarBuffer();
    const trueOffset = 5000;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200; i++) {
      const t = i * 50;
      const jitter = i % 10 === 3 ? 0 : rnd() * 60;
      b.push(car(t, i), t + trueOffset + 20 + jitter);
    }
    // min latency 20ms -> offset should sit near 5020, never below it and not far above
    expect(b.clockOffset).toBeGreaterThanOrEqual(trueOffset + 20 - 1e-6);
    expect(b.clockOffset).toBeLessThan(trueOffset + 20 + 15);
  });

  it('advances wheel spin from speed and reuses the pose object', () => {
    const b = new RemoteCarBuffer();
    b.push(car(0, 0, 36), 0); // 36 m/s
    const a = b.sample(1000)!;
    const s0 = a.wheelSpin[0];
    const c = b.sample(1100)!;
    expect(c).toBe(a);
    expect(c.wheelSpin[0] - s0).toBeCloseTo((36 / 0.36) * 0.1, 3);
    expect(c.wheelCompression).toEqual([0, 0, 0, 0]);
  });
});
