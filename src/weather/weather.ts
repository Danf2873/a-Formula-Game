// Weather: seeded rain curve (truthful forecast), track wetness, rubber, temperatures, time of day.
import type { CircuitData, Environment, SessionConfig, WeatherState } from '../types';

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

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

interface Shower { startS: number; durS: number; peak: number }

const WET_RISE_S = 240;      // seconds 0 -> 1 at rain 1
const DRY_BASE_S = 1200;     // seconds 1 -> 0 at 30 C track, no cars, no cloud
const FORECAST_STEPS = [5, 10, 15, 20, 25, 30];

export class Weather {
  readonly state: WeatherState;
  private readonly mode: SessionConfig['weather'];
  private readonly circuit: CircuitData;
  private readonly timeScale: number;
  private readonly showers: Shower[] = [];
  private readonly phases: number[];
  private readonly cloudBase: number;
  private elapsedS = 0;

  constructor(mode: SessionConfig['weather'], circuit: CircuitData, startTimeOfDay: number, timeScale: number, seed: number) {
    this.mode = mode;
    this.circuit = circuit;
    this.timeScale = timeScale;
    const rng = mulberry32(seed ^ 0x9e3779b9);
    this.phases = [rng() * 6.283, rng() * 6.283, rng() * 6.283];
    this.cloudBase = mode === 'dry' ? 0.1 + rng() * 0.3 : 0.3 + rng() * 0.3;

    if (mode === 'changeable') {
      this.showers.push({ startS: (2 + rng() * 18) * 60, durS: (5 + rng() * 15) * 60, peak: 0.6 + rng() * 0.35 });
    } else if (mode === 'random') {
      const chance = clamp(circuit.climate.rainChance, 0, 1);
      // 20-minute blocks over 6 hours; each may start a shower.
      for (let b = 0; b < 18; b++) {
        const roll = rng(), off = rng(), dur = rng(), peak = rng();
        if (roll < chance * 0.6) {
          this.showers.push({ startS: (b * 20 + off * 15) * 60, durS: (5 + dur * 20) * 60, peak: 0.3 + peak * 0.6 });
        }
      }
    }

    const tod = Number.isFinite(startTimeOfDay) ? startTimeOfDay : circuit.raceTimeOfDay;
    const rain0 = this.rainAt(0);
    this.state = {
      cloud: 0, rain: rain0,
      wetness: mode === 'wet' ? 0.5 : rain0 > 0.05 ? 0.4 : 0,
      rubber: 0.4, airTempC: 20, trackTempC: 25,
      timeOfDay: ((tod % 24) + 24) % 24,
      forecast: [],
    };
    this.refreshDerived();
  }

  /** Deterministic rain intensity (0..1) at session time tS seconds. */
  private rainAt(tS: number): number {
    const p = this.phases;
    if (this.mode === 'dry') return 0;
    if (this.mode === 'wet') {
      const n = Math.sin(tS / 170 + p[0]) * 0.5 + Math.sin(tS / 61 + p[1]) * 0.3 + Math.sin(tS / 437 + p[2]) * 0.2;
      return clamp(0.7 + 0.2 * n, 0.5, 0.9);
    }
    let r = 0;
    for (const sh of this.showers) {
      const u = (tS - sh.startS) / sh.durS;
      if (u <= 0 || u >= 1) continue;
      const env = Math.min(1, Math.sin(Math.PI * u) * 2.2); // quick onset, plateau, fade
      const flut = 1 + 0.12 * Math.sin(tS / 53 + p[0]) + 0.08 * Math.sin(tS / 149 + p[1]);
      r = Math.max(r, sh.peak * env * flut);
    }
    return clamp(r, 0, 1);
  }

  private refreshDerived(): void {
    const s = this.state;
    const tod = s.timeOfDay;
    const sun = Math.max(0, Math.sin((Math.PI * (tod - 6)) / 12));
    s.cloud = clamp(this.cloudBase + 0.6 * s.rain + 0.05 * Math.sin(this.elapsedS / 300 + this.phases[1]), 0, 1);
    const diurnal = 3 * Math.sin((2 * Math.PI * (tod - 9)) / 24);
    s.airTempC = this.circuit.climate.airTempC + diurnal - 4 * clamp(s.rain * 3, 0, 1);
    s.trackTempC = s.airTempC + 20 * sun * (1 - 0.7 * s.cloud) - 3 * s.wetness;
    s.forecast = FORECAST_STEPS.map((m) => ({ inMin: m, rain: this.rainAt(this.elapsedS + m * 60) }));
  }

  update(dtSec: number, carsOnTrack: number): void {
    if (dtSec <= 0) return;
    const s = this.state;
    this.elapsedS += dtSec;
    s.rain = this.rainAt(this.elapsedS);
    s.timeOfDay = (((s.timeOfDay + (dtSec * this.timeScale) / 3600) % 24) + 24) % 24;
    const sun = Math.max(0, Math.sin((Math.PI * (s.timeOfDay - 6)) / 12));

    const rise = s.rain / WET_RISE_S;
    const dryRate = (1 / DRY_BASE_S) * clamp(s.trackTempC / 30, 0.3, 2) * (0.7 + 0.5 * sun) * (1 - 0.5 * s.cloud)
      * (1 + 0.03 * Math.max(0, carsOnTrack));
    s.wetness = clamp(s.wetness + (rise - dryRate * (1 - s.rain)) * dtSec, 0, 1);

    if (s.rain > 0.05) {
      s.rubber = Math.max(0.4, s.rubber - (s.rain * dtSec) / 400);
    } else if (s.wetness < 0.3) {
      s.rubber = Math.min(1, s.rubber + (0.6 * Math.max(0, carsOnTrack) * dtSec) / (1800 * 20));
    }
    this.refreshDerived();
  }

  environment(): Environment {
    const s = this.state;
    return { wetness: s.wetness, rubber: s.rubber, airTempC: s.airTempC, trackTempC: s.trackTempC };
  }

  applyState(st: WeatherState): void {
    const s = this.state;
    s.cloud = st.cloud; s.rain = st.rain; s.wetness = st.wetness; s.rubber = st.rubber;
    s.airTempC = st.airTempC; s.trackTempC = st.trackTempC; s.timeOfDay = st.timeOfDay;
    s.forecast = st.forecast.map((f) => ({ ...f }));
  }
}
