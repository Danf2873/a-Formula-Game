import type { Controls, Telemetry } from '../types';
import type { InputSettings } from './inputManager';

export interface AssistState {
  /** seconds until the auto gearbox may shift again */
  shiftCooldown: number;
}

export function newAssistState(): AssistState {
  return { shiftCooldown: 0 };
}

const defaultState = newAssistState();

export const AUTO_UPSHIFT_RPM = 11200;
export const AUTO_DOWNSHIFT_RPM = 6800;
const SHIFT_DEBOUNCE_S = 0.4;
const TC_SLIP_THRESHOLD = 0.12;
const ABS_SLIP_THRESHOLD = 0.15;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Applies auto gearbox, traction control, ABS and steering assist. Returns a new Controls.
 * `st` holds debounce state (pass your own per-car state; a module default is used otherwise);
 * `dt` is the time since the previous call, used to age the debounce.
 */
export function applyAssists(
  c: Controls, t: Telemetry, s: InputSettings, st: AssistState = defaultState, dt = 1 / 60,
): Controls {
  const out: Controls = { ...c };
  st.shiftCooldown = Math.max(0, st.shiftCooldown - dt);

  // Auto gearbox
  if (s.autoGearbox) {
    out.shiftUp = false;
    out.shiftDown = false;
    if (st.shiftCooldown <= 0) {
      if (t.gear === 0 && c.throttle > 0.05) {
        out.shiftUp = true;
        st.shiftCooldown = SHIFT_DEBOUNCE_S;
      } else if (t.gear >= 1 && t.gear < 8 && t.rpm > AUTO_UPSHIFT_RPM) {
        out.shiftUp = true;
        st.shiftCooldown = SHIFT_DEBOUNCE_S;
      } else if (t.gear > 1 && t.rpm < AUTO_DOWNSHIFT_RPM) {
        out.shiftDown = true;
        st.shiftCooldown = SHIFT_DEBOUNCE_S;
      }
    }
  } else if (c.shiftUp || c.shiftDown) {
    st.shiftCooldown = 0.1;
  }

  // Traction control: cut throttle when rear wheels slip
  const tc = clamp01(s.tractionControl);
  if (tc > 0 && out.throttle > 0 && t.wheelSlip.length >= 4) {
    const rear = Math.max(t.wheelSlip[2], t.wheelSlip[3]);
    if (rear > TC_SLIP_THRESHOLD) {
      const excess = clamp01((rear - TC_SLIP_THRESHOLD) * 4);
      out.throttle = out.throttle * (1 - 0.9 * tc * excess);
    }
  }

  // ABS: limit brake when front wheels lock
  if (s.absAssist && out.brake > 0 && t.wheelSlip.length >= 2) {
    const front = Math.max(t.wheelSlip[0], t.wheelSlip[1]);
    if (front > ABS_SLIP_THRESHOLD) {
      const excess = clamp01((front - ABS_SLIP_THRESHOLD) * 4);
      out.brake = out.brake * (1 - 0.7 * excess);
    }
  }

  // Steering assist: reduce steer when the front tyres are sliding
  const sa = clamp01(s.steeringAssist);
  if (sa > 0 && t.wheelSlip.length >= 2) {
    const front = (t.wheelSlip[0] + t.wheelSlip[1]) / 2;
    if (front > 0.2) {
      out.steer = out.steer * (1 - 0.5 * sa * clamp01((front - 0.2) * 2));
    }
  }
  return out;
}
