import { describe, it, expect } from 'vitest';
import { Weather } from '../src/weather/weather';
import type { CircuitData } from '../src/types';

const circuit = { climate: { rainChance: 0.4, airTempC: 24 }, raceTimeOfDay: 14 } as unknown as CircuitData;
const run = (w: Weather, minutes: number, cars = 10, step = 1) => {
  for (let t = 0; t < minutes * 60; t += step) w.update(step, cars);
};

describe('weather', () => {
  it('dry stays dry', () => {
    const w = new Weather('dry', circuit, 14, 1, 1);
    run(w, 120);
    expect(w.state.wetness).toBe(0);
    expect(w.state.rain).toBe(0);
    expect(w.state.rubber).toBeGreaterThan(0.4);
    expect(w.state.rubber).toBeLessThanOrEqual(1);
  });
  it('wet gets wet quickly', () => {
    const w = new Weather('wet', circuit, 14, 1, 2);
    run(w, 10);
    expect(w.state.wetness).toBeGreaterThan(0.6);
    expect(w.state.rain).toBeGreaterThanOrEqual(0.5);
  });
  it('changeable rains then dries', () => {
    const w = new Weather('changeable', circuit, 14, 1, 3);
    let maxWet = 0;
    for (let t = 0; t < 150 * 60; t++) { w.update(1, 15); maxWet = Math.max(maxWet, w.state.wetness); }
    expect(maxWet).toBeGreaterThan(0.3);
    expect(w.state.wetness).toBeLessThan(0.2);
  });
  it('time of day wraps', () => {
    const w = new Weather('dry', circuit, 23.9, 60, 4);
    run(w, 10); // 10 min * 60 = 10 h
    expect(w.state.timeOfDay).toBeGreaterThanOrEqual(0);
    expect(w.state.timeOfDay).toBeLessThan(24);
    expect(w.state.timeOfDay).toBeCloseTo(9.9, 1);
  });
  it('is deterministic', () => {
    const a = new Weather('random', circuit, 14, 1, 99);
    const b = new Weather('random', circuit, 14, 1, 99);
    run(a, 60); run(b, 60);
    expect(a.state).toEqual(b.state);
  });
  it('forecast is truthful and temps sane', () => {
    const w = new Weather('changeable', circuit, 12, 1, 5);
    expect(w.state.forecast.map((f) => f.inMin)).toEqual([5, 10, 15, 20, 25, 30]);
    const f10 = w.state.forecast[1].rain;
    run(w, 10, 5);
    expect(w.state.rain).toBeCloseTo(f10, 5);
    const e = w.environment();
    expect(e.trackTempC).toBeGreaterThan(e.airTempC - 5);
  });
});
