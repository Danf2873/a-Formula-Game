// Session: lap/sector timing, start sequence, positions, gaps, chequered flag, pit events, penalties.
import type {
  Entry, EntryTiming, LapRecord, QualiPart, SessionConfig, SessionPhase, SessionSnapshot, TyreCompound,
} from '../types';

export interface CarTrackState {
  entryId: string;
  s: number; lateral: number; onTrack: boolean; inPitLane: boolean;
  speedKmh: number; compound: TyreCompound; lapDistanceValid: boolean;
}

export type SessionEvent =
  | { type: 'lap'; entryId: string; lap: LapRecord; personalBest: boolean; sessionBest: boolean }
  | { type: 'sector'; entryId: string; sector: 0 | 1 | 2; ms: number; personalBest: boolean; sessionBest: boolean }
  | { type: 'trackLimits'; entryId: string }
  | { type: 'lightsOut' }
  | { type: 'chequered' }
  | { type: 'finished'; entryId: string; position: number }
  | { type: 'sessionOver' }
  | { type: 'pitEntry' | 'pitExit'; entryId: string };

const PRE_MS = 3000;
const LIGHT_INTERVAL_MS = 1000;
const CHECKPOINT_M = 50;
const RACE_FINISH_TIMEOUT_MS = 120000;
const OTHER_FINISH_TIMEOUT_MS = 180000;
const RACE_PENALTY_MS = 30000;
const STOPPED_KMH = 3;

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

function cloneTiming(t: EntryTiming): EntryTiming {
  return {
    ...t,
    currentSectors: t.currentSectors.slice(),
    lastLap: t.lastLap ? cloneLap(t.lastLap) : null,
    bestLap: t.bestLap ? cloneLap(t.bestLap) : null,
    laps: t.laps.map(cloneLap),
    compoundsUsed: t.compoundsUsed.slice(),
  };
}
function cloneLap(l: LapRecord): LapRecord {
  return { ...l, sectorsMs: [l.sectorsMs[0], l.sectorsMs[1], l.sectorsMs[2]] };
}

interface Car {
  timing: EntryTiming;
  prevS: number | null;
  preLine: boolean;          // race: still behind the start line on the grid
  debt: number;              // backward line crossings not yet paid back
  timingActive: boolean;
  limitsFlagged: boolean;
  bestSectors: [number | null, number | null, number | null];
  cps: number[];             // time (session ms) at which the car passed absolute checkpoint k
  prevAbs: number;
  stopped: boolean;          // stood still in the pit lane during this visit
  lastState: CarTrackState | null;
}

export class Session {
  readonly entries: Entry[];
  private readonly cfg: SessionConfig;
  private readonly length: number;
  private readonly sectors: [number, number];
  private readonly cars: Car[] = [];
  private readonly byId = new Map<string, Car>();
  private readonly isRace: boolean;
  private phase: SessionPhase;
  private elapsedMs = 0;
  private remainingMs: number;
  private lightsOn = 0;
  private lightsOutAt = 0;
  private chequeredAt = 0;
  private finishOrder: string[] = [];
  private sessionBestMs: number | null = null;
  private sessionBestSectors: [number | null, number | null, number | null] = [null, null, null];
  private wetCompoundSeen = false;
  private remote = false;

  constructor(config: SessionConfig, entries: Entry[], trackLength: number, sectors: [number, number], seed?: number) {
    this.cfg = config;
    this.entries = entries;
    this.length = trackLength;
    this.sectors = sectors;
    this.isRace = config.kind === 'race';
    const rng = mulberry32(seed ?? Math.floor(Math.random() * 0x7fffffff));
    if (this.isRace) {
      this.phase = 'pre';
      this.remainingMs = NaN;
      this.lightsOutAt = PRE_MS + 4 * LIGHT_INTERVAL_MS + 200 + rng() * 2800;
    } else {
      this.phase = 'running';
      this.remainingMs = config.kind === 'timetrial' ? Infinity : Math.max(0, config.durationMin) * 60000;
    }
    for (const e of entries) {
      const timing: EntryTiming = {
        entryId: e.id, position: 0, lapsCompleted: 0, currentLapStartMs: 0,
        currentSectors: [null, null, null], currentLapValid: true, lastLap: null, bestLap: null, laps: [],
        totalDistance: 0, gapToLeaderMs: 0, intervalMs: 0, pitStops: 0, inPit: false,
        finished: false, finishTimeMs: null, compoundsUsed: [], penaltyMs: 0,
      };
      const car: Car = {
        timing, prevS: null, preLine: false, debt: 0, timingActive: false, limitsFlagged: false,
        bestSectors: [null, null, null], cps: [], prevAbs: 0, stopped: false, lastState: null,
      };
      this.cars.push(car);
      this.byId.set(e.id, car);
    }
    this.rank();
  }

  carsHeld(): boolean {
    return this.isRace && (this.phase === 'pre' || this.phase === 'lights' || this.phase === 'formation');
  }

  update(dtMs: number, states: CarTrackState[]): SessionEvent[] {
    const events: SessionEvent[] = [];
    const prevElapsed = this.elapsedMs;
    this.elapsedMs += dtMs;
    if (this.remote) {
      if (Number.isFinite(this.remainingMs) && this.phase === 'running') this.remainingMs = Math.max(0, this.remainingMs - dtMs);
      return events;
    }
    const L = this.length;

    // ---- start sequence (race)
    if (this.isRace && (this.phase === 'pre' || this.phase === 'lights')) {
      if (this.elapsedMs >= PRE_MS && this.phase === 'pre') this.phase = 'lights';
      if (this.phase === 'lights') {
        if (this.elapsedMs >= this.lightsOutAt) {
          this.phase = 'running';
          this.lightsOn = 0;
          events.push({ type: 'lightsOut' });
          for (const c of this.cars) {
            c.timingActive = true;
            c.timing.currentLapStartMs = this.lightsOutAt;
          }
        } else {
          this.lightsOn = Math.min(5, Math.floor((this.elapsedMs - PRE_MS) / LIGHT_INTERVAL_MS) + 1);
        }
      }
    }

    // ---- per-car tracking
    const active = this.phase === 'running' || this.phase === 'chequered';
    for (const st of states) {
      const car = this.byId.get(st.entryId);
      if (!car) continue;
      this.trackCar(car, st, prevElapsed, dtMs, active, events);
    }

    // ---- clock-driven transitions
    if (!this.isRace && this.phase === 'running' && Number.isFinite(this.remainingMs)) {
      this.remainingMs = Math.max(0, this.remainingMs - dtMs);
      if (this.remainingMs <= 0) {
        this.phase = 'chequered';
        this.chequeredAt = this.elapsedMs;
        events.push({ type: 'chequered' });
      }
    }
    if (this.phase === 'chequered') {
      const timeout = this.isRace ? RACE_FINISH_TIMEOUT_MS : OTHER_FINISH_TIMEOUT_MS;
      const allDone = this.cars.every((c) => c.timing.finished);
      if (allDone || this.elapsedMs - this.chequeredAt >= timeout) {
        this.phase = 'finished';
        events.push({ type: 'sessionOver' });
      }
    }

    this.rank();
    return events;
  }

  private trackCar(c: Car, st: CarTrackState, prevElapsed: number, dtMs: number, active: boolean, events: SessionEvent[]): void {
    const t = c.timing;
    const L = this.length;
    c.lastState = st;
    if (!t.compoundsUsed.includes(st.compound)) t.compoundsUsed.push(st.compound);
    if (st.compound === 'inter' || st.compound === 'wet') this.wetCompoundSeen = true;

    if (c.prevS === null) {
      c.prevS = st.s;
      c.preLine = this.isRace && st.s > 0.5 * L;
      t.inPit = st.inPitLane;
      c.prevAbs = this.absDistance(c, st.s);
      t.totalDistance = c.prevAbs;
      return;
    }
    if (!active) {
      c.prevS = st.s;
      c.prevAbs = this.absDistance(c, st.s);
      t.totalDistance = c.prevAbs;
      t.inPit = st.inPitLane;
      return;
    }
    if (t.finished) {
      // Keep pit state honest but stop timing.
      this.pitTrack(c, st, events);
      c.prevS = st.s;
      return;
    }

    const prevS = c.prevS;
    const s = st.s;
    const wrapF = prevS > 0.9 * L && s < 0.1 * L;
    const wrapB = prevS < 0.1 * L && s > 0.9 * L;
    const ds = s - prevS;
    const nowT = prevElapsed + dtMs;

    // sector crossings (forward, no wrap)
    if (c.timingActive && !wrapF && !wrapB && ds > 0 && ds < 0.2 * L) {
      const lim = [this.sectors[0] * L, this.sectors[1] * L];
      for (let k = 0; k < 2; k++) {
        if (prevS < lim[k] && s >= lim[k] && t.currentSectors[k] === null && (k === 0 || t.currentSectors[0] !== null)) {
          const tc = prevElapsed + dtMs * ((lim[k] - prevS) / ds);
          const total = tc - t.currentLapStartMs;
          const ms = k === 0 ? total : total - (t.currentSectors[0] as number);
          t.currentSectors[k] = ms;
          this.sectorEvent(c, k as 0 | 1, ms, events);
        }
      }
    }

    if (wrapB) c.debt++;
    if (wrapF) {
      const frac = (L - prevS) / ((L - prevS) + s);
      const tc = prevElapsed + dtMs * frac;
      if (c.debt > 0) c.debt--;
      else if (c.preLine) c.preLine = false;
      else if (c.timingActive) this.completeLap(c, st, tc, events);
      else {
        // practice / quali / time trial: out-lap ends, first timed lap begins
        if (this.phase === 'chequered' && !this.isRace) this.finishCar(c, tc, events);
        else {
          c.timingActive = true;
          this.startLap(c, tc);
        }
      }
    }

    // validity
    if (c.timingActive && !t.finished) {
      if (!st.inPitLane && !st.onTrack) {
        t.currentLapValid = false;
        if (!c.limitsFlagged) { c.limitsFlagged = true; events.push({ type: 'trackLimits', entryId: t.entryId }); }
      }
      if (!st.lapDistanceValid) t.currentLapValid = false;
    }

    this.pitTrack(c, st, events);
    if (!this.isRace && c.timingActive && st.inPitLane) t.currentLapValid = false;

    // distance + checkpoints
    c.prevS = s;
    if (!t.finished) {
      const abs = this.absDistance(c, s);
      if (this.isRace) this.addCheckpoints(c, c.prevAbs, abs, prevElapsed, nowT);
      c.prevAbs = abs;
      t.totalDistance = abs;
    }
  }

  private absDistance(c: Car, s: number): number {
    const L = this.length;
    if (c.preLine) return -(L - s);
    return c.timing.lapsCompleted * L + s;
  }

  private addCheckpoints(c: Car, from: number, to: number, t0: number, t1: number): void {
    if (to <= from) return;
    let k = c.cps.length;
    while (k * CHECKPOINT_M <= to) {
      const d = k * CHECKPOINT_M;
      if (d >= from || k === 0) c.cps.push(t0 + (t1 - t0) * clamp01((d - from) / (to - from)));
      else c.cps.push(t1);
      k++;
    }
  }

  private startLap(c: Car, tc: number): void {
    const t = c.timing;
    t.currentLapStartMs = tc;
    t.currentSectors = [null, null, null];
    c.limitsFlagged = false;
    t.currentLapValid = !(!this.isRace && t.inPit);
  }

  private sectorEvent(c: Car, sector: 0 | 1 | 2, ms: number, events: SessionEvent[]): void {
    const valid = c.timing.currentLapValid;
    let pb = false, sb = false;
    if (valid) {
      const b = c.bestSectors[sector];
      if (b === null || ms < b) { c.bestSectors[sector] = ms; pb = true; }
      const g = this.sessionBestSectors[sector];
      if (g === null || ms < g) { this.sessionBestSectors[sector] = ms; sb = true; }
    }
    events.push({ type: 'sector', entryId: c.timing.entryId, sector, ms, personalBest: pb, sessionBest: sb });
  }

  private completeLap(c: Car, st: CarTrackState, tc: number, events: SessionEvent[]): void {
    const t = c.timing;
    const timeMs = tc - t.currentLapStartMs;
    let valid = t.currentLapValid;
    const s0 = t.currentSectors[0], s1 = t.currentSectors[1];
    let sec: [number, number, number];
    if (s0 === null || s1 === null) { valid = false; sec = [s0 ?? 0, s1 ?? 0, 0]; }
    else sec = [s0, s1, timeMs - s0 - s1];
    // sector 3 event
    t.currentLapValid = valid;
    if (s0 !== null && s1 !== null) this.sectorEvent(c, 2, sec[2], events);
    const rec: LapRecord = { lap: t.lapsCompleted + 1, timeMs, sectorsMs: sec, valid, compound: st.compound };
    t.laps.push(rec);
    t.lastLap = rec;
    t.lapsCompleted++;
    let pb = false, sb = false;
    if (valid) {
      if (!t.bestLap || timeMs < t.bestLap.timeMs) { t.bestLap = rec; pb = true; }
      if (this.sessionBestMs === null || timeMs < this.sessionBestMs) { this.sessionBestMs = timeMs; sb = true; }
    }
    events.push({ type: 'lap', entryId: t.entryId, lap: cloneLap(rec), personalBest: pb, sessionBest: sb });

    if (this.isRace) {
      if (this.phase === 'running' && t.lapsCompleted >= this.cfg.laps) {
        this.phase = 'chequered';
        this.chequeredAt = tc;
        events.push({ type: 'chequered' });
        this.finishCar(c, tc, events);
        return;
      }
      if (this.phase === 'chequered') { this.finishCar(c, tc, events); return; }
    } else if (this.phase === 'chequered') {
      this.finishCar(c, tc, events);
      return;
    }
    this.startLap(c, tc);
  }

  private finishCar(c: Car, tc: number, events: SessionEvent[]): void {
    const t = c.timing;
    t.finished = true;
    t.finishTimeMs = tc;
    c.timingActive = false;
    if (this.isRace) {
      const dry = this.cfg.weather !== 'wet' && !this.wetCompoundSeen;
      if (dry && t.compoundsUsed.length < 2) t.penaltyMs = RACE_PENALTY_MS;
    }
    this.finishOrder.push(t.entryId);
    const position = this.isRace ? this.finishOrder.length : Math.max(1, t.position);
    events.push({ type: 'finished', entryId: t.entryId, position });
  }

  private pitTrack(c: Car, st: CarTrackState, events: SessionEvent[]): void {
    const t = c.timing;
    if (st.inPitLane && !t.inPit) {
      t.inPit = true;
      c.stopped = false;
      events.push({ type: 'pitEntry', entryId: t.entryId });
    } else if (!st.inPitLane && t.inPit) {
      t.inPit = false;
      if (c.stopped) t.pitStops++;
      c.stopped = false;
      events.push({ type: 'pitExit', entryId: t.entryId });
    }
    if (t.inPit && st.speedKmh < STOPPED_KMH) c.stopped = true;
  }

  // ---------------------------------------------------------------- ranking & gaps

  private rank(): void {
    const cars = this.cars.slice();
    const idx = new Map(cars.map((c, i) => [c, i]));
    if (this.isRace) {
      const final = this.phase === 'finished';
      cars.sort((a, b) => {
        const ta = a.timing, tb = b.timing;
        if (ta.finished !== tb.finished) return ta.finished ? -1 : 1;
        if (ta.finished && tb.finished) {
          if (final) {
            if (ta.lapsCompleted !== tb.lapsCompleted) return tb.lapsCompleted - ta.lapsCompleted;
            const d = (ta.finishTimeMs! + ta.penaltyMs) - (tb.finishTimeMs! + tb.penaltyMs);
            if (d !== 0) return d;
          } else {
            const d = this.finishOrder.indexOf(ta.entryId) - this.finishOrder.indexOf(tb.entryId);
            if (d !== 0) return d;
          }
        }
        if (tb.totalDistance !== ta.totalDistance) return tb.totalDistance - ta.totalDistance;
        return idx.get(a)! - idx.get(b)!;
      });
    } else {
      cars.sort((a, b) => {
        const ba = a.timing.bestLap?.timeMs, bb = b.timing.bestLap?.timeMs;
        if (ba !== undefined && bb !== undefined) {
          if (ba !== bb) return ba - bb;
        } else if (ba !== undefined) return -1;
        else if (bb !== undefined) return 1;
        else if (b.timing.totalDistance !== a.timing.totalDistance) return b.timing.totalDistance - a.timing.totalDistance;
        return idx.get(a)! - idx.get(b)!;
      });
    }
    cars.forEach((c, i) => { c.timing.position = i + 1; });

    // gaps
    const leader = cars[0];
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (i === 0) { c.timing.gapToLeaderMs = 0; c.timing.intervalMs = 0; continue; }
      if (this.isRace) {
        c.timing.gapToLeaderMs = this.raceGap(c, leader);
        c.timing.intervalMs = this.raceGap(c, cars[i - 1]);
      } else {
        const lb = leader.timing.bestLap?.timeMs, cb = c.timing.bestLap?.timeMs, pb = cars[i - 1].timing.bestLap?.timeMs;
        c.timing.gapToLeaderMs = lb !== undefined && cb !== undefined ? cb - lb : 0;
        c.timing.intervalMs = pb !== undefined && cb !== undefined ? cb - pb : 0;
      }
    }
  }

  /** Time for car `a` to reach where `b` is/was at a's distance, from per-50 m checkpoint stamps. */
  private raceGap(a: Car, b: Car): number {
    if (a.timing.finished && b.timing.finished) {
      return Math.max(0, (a.timing.finishTimeMs! + a.timing.penaltyMs) - (b.timing.finishTimeMs! + b.timing.penaltyMs));
    }
    const dA = a.timing.totalDistance;
    if (dA < 0 || a.timing.lapsCompleted < 0) return 0;
    const k = Math.floor(dA / CHECKPOINT_M);
    const tk = b.cps[k];
    if (tk === undefined) return 0;
    const frac = (dA - k * CHECKPOINT_M) / CHECKPOINT_M;
    let tb: number;
    const tk1 = b.cps[k + 1];
    if (tk1 !== undefined) tb = tk + (tk1 - tk) * frac;
    else {
      const dB = b.timing.totalDistance;
      const span = dB - k * CHECKPOINT_M;
      const tNow = b.timing.finished ? b.timing.finishTimeMs! : this.elapsedMs;
      tb = span > 1e-6 ? tk + (tNow - tk) * Math.min(1, (dA - k * CHECKPOINT_M) / span) : tk;
    }
    const nowA = a.timing.finished ? a.timing.finishTimeMs! : this.elapsedMs;
    return Math.max(0, nowA - tb);
  }

  // ---------------------------------------------------------------- snapshots

  snapshot(): SessionSnapshot {
    const timing = this.cars.map((c) => cloneTiming(c.timing)).sort((a, b) => a.position - b.position);
    return {
      config: this.cfg,
      phase: this.phase,
      elapsedMs: this.elapsedMs,
      remainingMs: this.remainingMs,
      lightsOn: this.lightsOn,
      timing,
      sessionBestMs: this.sessionBestMs,
      sessionBestSectorsMs: [this.sessionBestSectors[0], this.sessionBestSectors[1], this.sessionBestSectors[2]],
    };
  }

  applySnapshot(s: SessionSnapshot): void {
    this.remote = true;
    this.phase = s.phase;
    this.elapsedMs = s.elapsedMs;
    this.remainingMs = s.remainingMs;
    this.lightsOn = s.lightsOn;
    this.sessionBestMs = s.sessionBestMs;
    this.sessionBestSectors = [s.sessionBestSectorsMs[0], s.sessionBestSectorsMs[1], s.sessionBestSectorsMs[2]];
    for (const t of s.timing) {
      const c = this.byId.get(t.entryId);
      if (c) c.timing = cloneTiming(t);
    }
  }
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** Knockout: ids eliminated after Q1/Q2 = ceil(fieldSize*6/22) slowest by best valid lap (no time = last). Q3: none. */
export function qualifyingCut(timing: EntryTiming[], part: QualiPart, fieldSize: number): string[] {
  if (part === 'Q3') return [];
  const n = Math.min(timing.length, Math.ceil((fieldSize * 6) / 22));
  const ranked = timing
    .map((t, i) => ({ id: t.entryId, ms: t.bestLap && t.bestLap.valid ? t.bestLap.timeMs : Infinity, i }))
    .sort((a, b) => (a.ms === b.ms ? a.i - b.i : a.ms - b.ms));
  return ranked.slice(ranked.length - n).map((r) => r.id);
}
