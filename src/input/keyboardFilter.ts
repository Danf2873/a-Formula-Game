// Pure keyboard steering filter: rate-limited and speed-sensitive. Node-testable.

/** Max steering magnitude available at a given speed: 1.0 at standstill, 0.25 at 300 km/h. */
export function steerLimitForSpeed(speedKmh: number): number {
  const k = Math.min(1, Math.max(0, speedKmh / 300));
  return 1 - 0.75 * k;
}

/** Steer-in rate (units/s). Full lock in ~0.2 s at low speed, slower when fast. */
export function steerInRate(speedKmh: number): number {
  return 5 / (1 + Math.max(0, speedKmh) / 120);
}

/** Return-to-centre rate (units/s); always faster than steer-in at the same speed. */
export function steerReturnRate(speedKmh: number): number {
  return 1.8 * steerInRate(speedKmh) + 2;
}

/**
 * @param current  current filtered steer (-1..1, +1 = left)
 * @param target   raw keyboard direction -1, 0 or +1
 */
export function filterKeyboardSteer(current: number, target: number, speedKmh: number, dt: number): number {
  const limit = steerLimitForSpeed(speedKmh);
  const tgt = Math.max(-1, Math.min(1, target)) * limit;
  const towardsCentre = tgt === 0 || (current !== 0 && Math.sign(tgt) !== Math.sign(current)) || Math.abs(tgt) < Math.abs(current);
  const rate = towardsCentre ? steerReturnRate(speedKmh) : steerInRate(speedKmh);
  const d = tgt - current;
  const step = rate * dt;
  if (Math.abs(d) <= step) return tgt;
  return current + Math.sign(d) * step;
}

/** Ramp a pedal value towards target at a fixed time constant (full travel in `rampMs`). */
export function rampPedal(current: number, target: number, dt: number, rampMs = 80): number {
  const step = dt / (rampMs / 1000);
  if (Math.abs(target - current) <= step) return target;
  return current + Math.sign(target - current) * step;
}
