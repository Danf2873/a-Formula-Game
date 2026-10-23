import { describe, it, expect } from 'vitest';
import { Session, qualifyingCut, type CarTrackState, type SessionEvent } from '../src/session/session';
import { PitStop } from '../src/session/pit';
import type { Entry, EntryTiming, SessionConfig, TyreCompound } from '../src/types';

const L = 5000;
const SECTORS: [number, number] = [0.3, 0.7];
const DT = 10; // ms

function cfg(over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    kind: 'practice', circuitId: 'x', durationMin: 10, laps: 3, aiCount: 0, aiSkill: 1, weather: 'dry',
    timeOfDay: 12, timeScale: 1, tyreWearMul: 1, fuelMul: 1, gridOrder: [], ...over,
  };
}
function entries(n: number): Entry[] {
  return Array.from({ length: n }, (_, i) => ({ id: `e${i}`, driverId: `d${i}`, displayName: `D${i}`, teamId: 't', kind: 'ai' as const }));
}

interface Sim {
  id: string;
  s0: number;          // starting s (may be behind line, e.g. L - 8)
  v: (tMs: number) => number; // m/s
  compound?: (tMs: number) => TyreCompound;
  onTrack?: (tMs: number) => boolean;
  inPit?: (tMs: number) => boolean;
}

function run(session: Session, sims: Sim[], totalMs: number, onEvents?: (e: SessionEvent[], t: number) => void, until?: () => boolean, len = L) {
  const pos = sims.map((s) => s.s0);
  const all: SessionEvent[] = [];
  let t = 0;
  while (t < totalMs) {
    t += DT;
    const held = session.carsHeld();
    const states: CarTrackState[] = sims.map((sim, i) => {
      if (!held) pos[i] += sim.v(t) * (DT / 1000);
      const inPitLane = sim.inPit?.(t) ?? false;
      return {
        entryId: sim.id, s: ((pos[i] % len) + len) % len, lateral: 0, onTrack: sim.onTrack ? sim.onTrack(t) : true,
        inPitLane, speedKmh: sim.v(t) * 3.6, compound: sim.compound ? sim.compound(t) : 'medium', lapDistanceValid: true,
      };
    });
    const ev = session.update(DT, states);
    all.push(...ev);
    onEvents?.(ev, t);
    if (until?.()) break;
  }
  return all;
}

const lapsOf = (ev: SessionEvent[], id: string) => ev.flatMap((e) => (e.type === 'lap' && e.entryId === id ? [e] : []));

describe('session timing', () => {
  it('lap time equals L/v within a step, sectors sum, out-lap untimed', () => {
    const s = new Session(cfg(), entries(1), L, SECTORS);
    const ev = run(s, [{ id: 'e0', s0: 4000, v: () => 50 }], 330_000);
    const laps = lapsOf(ev, 'e0');
    expect(laps.length).toBe(3);
    for (const l of laps) {
      expect(Math.abs(l.lap.timeMs - 100_000)).toBeLessThanOrEqual(DT);
      expect(Math.abs(l.lap.sectorsMs[0] + l.lap.sectorsMs[1] + l.lap.sectorsMs[2] - l.lap.timeMs)).toBeLessThan(1e-6);
      expect(Math.abs(l.lap.sectorsMs[0] - 30_000)).toBeLessThanOrEqual(DT);
      expect(Math.abs(l.lap.sectorsMs[1] - 40_000)).toBeLessThanOrEqual(DT);
      expect(l.lap.valid).toBe(true);
    }
    expect(laps[0].personalBest).toBe(true);
    expect(laps[0].sessionBest).toBe(true);
    expect(laps[1].personalBest).toBe(false);
    expect(laps[0].lap.lap).toBe(1);
    expect(ev.filter((e) => e.type === 'sector').length).toBe(9);
  });

  it('track-limits lap is invalid, flagged once and never best', () => {
    const s = new Session(cfg(), entries(1), L, SECTORS);
    // lap 1 (after out-lap) slow valid; lap 2 fast but off track for a while; lap 3 slow valid
    const lapStart = 100_000; // out-lap from s=0 starts timing at first crossing at t=100 s
    const ev = run(s, [{
      id: 'e0', s0: 0,
      v: (t) => (t > 200_000 && t < 300_000 ? 60 : 50),
      onTrack: (t) => !(t > 230_000 && t < 235_000) && !(t > 250_000 && t < 251_000),
    }], 410_000);
    const laps = lapsOf(ev, 'e0');
    expect(laps.length).toBeGreaterThanOrEqual(2);
    const bad = laps.filter((l) => !l.lap.valid);
    expect(bad.length).toBe(1);
    expect(bad[0].personalBest).toBe(false);
    expect(ev.filter((e) => e.type === 'trackLimits').length).toBe(1);
    const snap = s.snapshot().timing[0];
    expect(snap.bestLap!.valid).toBe(true);
    expect(snap.bestLap!.timeMs).toBeGreaterThan(bad[0].lap.timeMs);
    expect(lapStart).toBe(100_000);
  });

  it('time trial never ends', () => {
    const s = new Session(cfg({ kind: 'timetrial' }), entries(1), L, SECTORS);
    run(s, [{ id: 'e0', s0: 0, v: () => 50 }], 600_000);
    const snap = s.snapshot();
    expect(snap.remainingMs).toBe(Infinity);
    expect(snap.phase).toBe('running');
  });

  it('practice: countdown, chequered, each car finishes on next crossing, then finished', () => {
    const s = new Session(cfg({ durationMin: 4 }), entries(2), L, SECTORS);
    const phases: string[] = [];
    const ev = run(s, [
      { id: 'e0', s0: 0, v: () => 50 },
      { id: 'e1', s0: 2500, v: () => 40 },
    ], 600_000, () => { const p = s.snapshot().phase; if (phases[phases.length - 1] !== p) phases.push(p); }, () => s.snapshot().phase === 'finished');
    expect(phases).toEqual(['running', 'chequered', 'finished']);
    expect(ev.filter((e) => e.type === 'chequered').length).toBe(1);
    expect(ev.filter((e) => e.type === 'finished').length).toBe(2);
    expect(ev.filter((e) => e.type === 'sessionOver').length).toBe(1);
    const snap = s.snapshot();
    expect(snap.timing.every((t) => t.finished)).toBe(true);
    expect(snap.timing[0].entryId).toBe('e0'); // faster lap
    expect(snap.timing[0].position).toBe(1);
    expect(snap.timing[1].gapToLeaderMs).toBeGreaterThan(0);
  });

  it('chequered ends after 3 min even if a car never crosses', () => {
    const s = new Session(cfg({ durationMin: 1 }), entries(2), L, SECTORS);
    const ev = run(s, [
      { id: 'e0', s0: 0, v: () => 50 },
      { id: 'e1', s0: 100, v: () => 0 },
    ], 400_000, undefined, () => s.snapshot().phase === 'finished');
    const snap = s.snapshot();
    expect(snap.phase).toBe('finished');
    expect(snap.elapsedMs).toBeLessThanOrEqual(60_000 + 180_000 + 1000);
    expect(ev.some((e) => e.type === 'sessionOver')).toBe(true);
  });
});

describe('race', () => {
  const grid = (n: number) => Array.from({ length: n }, (_, i) => L - 8 * (i + 1));

  it('start sequence: pre, lights 1..5, random hold, lights out', () => {
    const s = new Session(cfg({ kind: 'race', laps: 2 }), entries(2), L, SECTORS, 42);
    const lightsSeen = new Set<number>();
    let outAt = -1;
    const held: boolean[] = [];
    run(s, [
      { id: 'e0', s0: grid(2)[0], v: () => 50 },
      { id: 'e1', s0: grid(2)[1], v: () => 50 },
    ], 15_000, (ev, t) => {
      const snap = s.snapshot();
      lightsSeen.add(snap.lightsOn);
      if (ev.some((e) => e.type === 'lightsOut')) outAt = t;
      held.push(s.carsHeld());
      if (t < 3000) expect(snap.phase).toBe('pre');
    });
    expect([...lightsSeen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(outAt).toBeGreaterThanOrEqual(7200);
    expect(outAt).toBeLessThanOrEqual(10_100);
    const firstFree = held.indexOf(false);
    expect(Math.abs((firstFree + 1) * DT - outAt)).toBeLessThanOrEqual(DT);
    expect(held.slice(firstFree).every((h) => !h)).toBe(true);
    expect(s.snapshot().phase).toBe('running');
  });

  it('grid positions behind the line; order follows distance; gaps match real time', () => {
    const s = new Session(cfg({ kind: 'race', laps: 3 }), entries(3), L, SECTORS, 1);
    // e0 pole; e1 (slower) and e2 (fastest) behind
    run(s, [
      { id: 'e0', s0: grid(3)[0], v: () => 50 },
      { id: 'e1', s0: grid(3)[1], v: () => 48 },
      { id: 'e2', s0: grid(3)[2], v: () => 46 },
    ], 2000);
    let snap = s.snapshot();
    expect(snap.timing.map((t) => t.entryId)).toEqual(['e0', 'e1', 'e2']);
    expect(snap.timing[0].totalDistance).toBeLessThan(0);
    expect(snap.timing[0].lapsCompleted).toBe(0);

    // Gap test: fresh session, two cars same speed, 250 m apart
    const s2 = new Session(cfg({ kind: 'race', laps: 3 }), entries(2), L, SECTORS, 1);
    run(s2, [
      { id: 'e0', s0: 2000, v: () => 50 },
      { id: 'e1', s0: 1750, v: () => 50 },
    ], 60_000);
    snap = s2.snapshot();
    expect(snap.timing[0].entryId).toBe('e0');
    // 250 m at 50 m/s, 5 s (plus a small start-up effect-free constant speed)
    const afterStart = snap.timing[1];
    expect(Math.abs(afterStart.gapToLeaderMs - 5000)).toBeLessThan(150);
    expect(Math.abs(afterStart.intervalMs - 5000)).toBeLessThan(150);
    expect(snap.timing[0].gapToLeaderMs).toBe(0);
  });

  it('chequered when leader completes laps; others finish next crossing; finished', () => {
    const s = new Session(cfg({ kind: 'race', laps: 2 }), entries(2), 1000, SECTORS, 3);
    const gridS = [992, 984];
    const sims: Sim[] = [
      { id: 'e0', s0: gridS[0], v: () => 40, compound: () => 'medium' },
      { id: 'e1', s0: gridS[1], v: () => 35, compound: () => 'hard' },
    ];
    const ev = run(s, sims, 300_000, undefined, () => s.snapshot().phase === 'finished', 1000);
    expect(ev.filter((e) => e.type === 'chequered').length).toBe(1);
    const fin = ev.filter((e) => e.type === 'finished');
    expect(fin.length).toBe(2);
    const snap = s.snapshot();
    expect(snap.phase).toBe('finished');
    expect(snap.timing[0].entryId).toBe('e0');
    expect(snap.timing[0].lapsCompleted).toBe(2);
  });
});

describe('penalty and pits', () => {
  it('one dry compound = 30 s penalty and re-sorts final classification', () => {
    const Ls = 2000;
    const s = new Session(cfg({ kind: 'race', laps: 2, weather: 'dry' }), entries(2), Ls, SECTORS, 5);
    // e1 is a bit faster but never changes compound; e0 uses two compounds.
    const sims: Sim[] = [
      { id: 'e0', s0: Ls - 8, v: () => 40, compound: (t) => (t < 60_000 ? 'medium' : 'hard') },
      { id: 'e1', s0: Ls - 16, v: () => 41.5, compound: () => 'medium' },
    ];
    run(s, sims, 400_000, undefined, () => s.snapshot().phase === 'finished', Ls);
    const snap = s.snapshot();
    expect(snap.phase).toBe('finished');
    const e0 = snap.timing.find((t) => t.entryId === 'e0')!;
    const e1 = snap.timing.find((t) => t.entryId === 'e1')!;
    expect(e0.penaltyMs).toBe(0);
    expect(e1.penaltyMs).toBe(30_000);
    expect(e1.finishTimeMs!).toBeLessThan(e0.finishTimeMs!);
    expect(e0.position).toBe(1);
    expect(e1.position).toBe(2);
    expect(snap.timing[0].entryId).toBe('e0');
  });

  it('pit entry/exit events and stop count', () => {
    const s = new Session(cfg({ kind: 'race', laps: 5 }), entries(2), L, SECTORS, 9);
    const sims: Sim[] = [
      { id: 'e0', s0: L - 8, v: (t) => (t > 40_000 && t < 50_000 ? 0 : 50), inPit: (t) => t > 30_000 && t < 60_000 },
      { id: 'e1', s0: L - 16, v: () => 50, inPit: (t) => t > 30_000 && t < 60_000 },
    ];
    const ev = run(s, sims, 80_000);
    expect(ev.filter((e) => e.type === 'pitEntry').length).toBe(2);
    expect(ev.filter((e) => e.type === 'pitExit').length).toBe(2);
    const snap = s.snapshot();
    expect(snap.timing.find((t) => t.entryId === 'e0')!.pitStops).toBe(1);
    expect(snap.timing.find((t) => t.entryId === 'e1')!.pitStops).toBe(0);
  });

  it('PitStop.serviceTimeMs ranges', () => {
    let seed = 7;
    const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 300; i++) {
      const t = PitStop.serviceTimeMs(true, 0, rng);
      expect(t).toBeGreaterThanOrEqual(2000);
      expect(t).toBeLessThanOrEqual(2800 + 4000);
    }
    expect(PitStop.serviceTimeMs(true, 20, () => 0.5)).toBeCloseTo(2400 + 2000, 5);
    expect(PitStop.serviceTimeMs(false, 10, () => 0.5)).toBeCloseTo(1000, 5);
  });
});

describe('qualifyingCut', () => {
  const mk = (n: number, noTime: number[] = []): EntryTiming[] =>
    Array.from({ length: n }, (_, i) => ({
      entryId: `e${i}`, position: i + 1, lapsCompleted: 1, currentLapStartMs: 0, currentSectors: [null, null, null],
      currentLapValid: true, lastLap: null,
      bestLap: noTime.includes(i) ? null : { lap: 1, timeMs: 80_000 + i * 100, sectorsMs: [1, 1, 1], valid: true, compound: 'soft' },
      laps: [], totalDistance: 0, gapToLeaderMs: 0, intervalMs: 0, pitStops: 0, inPit: false, finished: true,
      finishTimeMs: null, compoundsUsed: [], penaltyMs: 0,
    } as EntryTiming));

  it('cuts 6 of 22', () => {
    const cut = qualifyingCut(mk(22), 'Q1', 22);
    expect(cut).toEqual(['e16', 'e17', 'e18', 'e19', 'e20', 'e21']);
  });
  it('cuts 3 of 10, no time counts as last', () => {
    const t = mk(10, [2]);
    const cut = qualifyingCut(t, 'Q2', 10);
    expect(cut.length).toBe(3);
    expect(cut).toContain('e2');
    expect(cut).toContain('e9');
    expect(cut).toContain('e8');
  });
  it('Q3 eliminates nobody', () => {
    expect(qualifyingCut(mk(10), 'Q3', 10)).toEqual([]);
  });
});
