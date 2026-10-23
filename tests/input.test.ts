import { describe, it, expect } from 'vitest';
import { applyAssists, newAssistState } from '../src/input/assists';
import { filterKeyboardSteer, steerLimitForSpeed, rampPedal } from '../src/input/keyboardFilter';
import { defaultSettings } from '../src/input/inputManager';
import type { Controls, Telemetry } from '../src/types';

const ctl = (o: Partial<Controls> = {}): Controls => ({
  steer: 0, throttle: 1, brake: 0, shiftUp: false, shiftDown: false, boost: false, pitLimiter: false, ...o,
});
const tel = (o: Partial<Telemetry> = {}): Telemetry => ({
  speedKmh: 200, rpm: 9000, gear: 4, throttle: 1, brake: 0, steer: 0, latG: 0, longG: 0, ersSoc: 0.5,
  ersDeployKw: 0, fuelKg: 50, straightMode: false, tyres: [], wheelSlip: [0, 0, 0, 0], wheelLoadN: [0, 0, 0, 0],
  surface: ['asphalt', 'asphalt', 'asphalt', 'asphalt'], pitLimiter: false, ...o,
});

describe('applyAssists', () => {
  it('auto upshift fires once, then is debounced', () => {
    const s = { ...defaultSettings(), autoGearbox: true };
    const st = newAssistState();
    const t = tel({ rpm: 11500, gear: 3 });
    expect(applyAssists(ctl(), t, s, st, 1 / 60).shiftUp).toBe(true);
    expect(applyAssists(ctl(), t, s, st, 1 / 60).shiftUp).toBe(false);
    // after the debounce elapses it may shift again
    expect(applyAssists(ctl(), t, s, st, 0.5).shiftUp).toBe(true);
  });
  it('auto downshift at low rpm', () => {
    const s = { ...defaultSettings(), autoGearbox: true };
    expect(applyAssists(ctl(), tel({ rpm: 6000, gear: 5 }), s, newAssistState()).shiftDown).toBe(true);
  });
  it('traction control reduces throttle under rear slip', () => {
    const s = { ...defaultSettings(), tractionControl: 1 };
    const out = applyAssists(ctl(), tel({ wheelSlip: [0, 0, 0.4, 0.4] }), s, newAssistState());
    expect(out.throttle).toBeLessThan(0.5);
    const off = applyAssists(ctl(), tel({ wheelSlip: [0, 0, 0.4, 0.4] }), { ...s, tractionControl: 0 }, newAssistState());
    expect(off.throttle).toBe(1);
  });
  it('ABS reduces brake under front slip', () => {
    const s = { ...defaultSettings(), absAssist: true };
    const out = applyAssists(ctl({ throttle: 0, brake: 1 }), tel({ wheelSlip: [0.5, 0.5, 0, 0] }), s, newAssistState());
    expect(out.brake).toBeLessThan(0.6);
    const none = applyAssists(ctl({ throttle: 0, brake: 1 }), tel({ wheelSlip: [0.05, 0.05, 0, 0] }), s, newAssistState());
    expect(none.brake).toBe(1);
  });
});

describe('keyboard steering filter', () => {
  it('is rate limited', () => {
    const v = filterKeyboardSteer(0, 1, 0, 1 / 60);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.2);
  });
  it('reaches full lock quickly at low speed', () => {
    let v = 0;
    for (let i = 0; i < 30; i++) v = filterKeyboardSteer(v, 1, 0, 1 / 60);
    expect(v).toBeCloseTo(1, 5);
  });
  it('limits lock at high speed', () => {
    let v = 0;
    for (let i = 0; i < 300; i++) v = filterKeyboardSteer(v, 1, 300, 1 / 60);
    expect(v).toBeCloseTo(0.25, 5);
    expect(steerLimitForSpeed(150)).toBeGreaterThan(0.25);
  });
  it('returns to centre faster than it steers in', () => {
    const inStep = filterKeyboardSteer(0, 1, 100, 0.05);
    const outStep = 0.5 - filterKeyboardSteer(0.5, 0, 100, 0.05);
    expect(outStep).toBeGreaterThan(inStep);
  });
  it('pedal ramp takes about 80 ms', () => {
    let p = 0;
    for (let i = 0; i < 4; i++) p = rampPedal(p, 1, 0.02);
    expect(p).toBeCloseTo(1, 5);
  });
});
