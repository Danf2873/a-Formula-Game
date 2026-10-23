// Tyre model: normalised Pacejka Magic Formula with combined slip, load sensitivity, temperature,
// wear and wetness effects. Pure functions + a small thermal/wear integrator. Allocation-free hot path.

import type { SurfaceType, TyreCompound, TyreState } from '../types';

export interface CompoundSpec {
  grip: number;          // peak friction scale vs. soft = 1
  wearRate: number;      // relative wear speed
  optimalTempC: number;
  tempWindowC: number;   // gaussian sigma of the temperature window
  wetGrip: number;       // relative wet-weather capability (1 = best possible)
  color: string;
}

export const COMPOUNDS: Record<TyreCompound, CompoundSpec> = {
  soft:   { grip: 1.00, wearRate: 1.00, optimalTempC: 100, tempWindowC: 28, wetGrip: 0.35, color: '#e10600' },
  medium: { grip: 0.965, wearRate: 0.62, optimalTempC: 102, tempWindowC: 30, wetGrip: 0.33, color: '#ffd400' },
  hard:   { grip: 0.93, wearRate: 0.42, optimalTempC: 105, tempWindowC: 32, wetGrip: 0.30, color: '#f0f0f0' },
  inter:  { grip: 0.84, wearRate: 0.95, optimalTempC: 72,  tempWindowC: 20, wetGrip: 0.80, color: '#43b02a' },
  wet:    { grip: 0.76, wearRate: 0.80, optimalTempC: 62,  tempWindowC: 18, wetGrip: 1.00, color: '#0067ad' },
};

export const TYRE_REF_LOAD = 4000;      // N, nominal per-tyre load
const MU_PEAK_Y = 2.7;                  // lateral peak friction at reference load, soft, new, optimal
const MU_PEAK_X = 2.1;
export const SLIP_ANGLE_PEAK = 0.115;    // rad (~6.5 deg)
export const SLIP_RATIO_PEAK = 0.11;

const PAC_C = 1.45;
const PAC_B = Math.tan(Math.PI / (2 * PAC_C));
const PAC_E = 0.0;

export function newTyre(compound: TyreCompound, pressurePsi: number): TyreState {
  return { compound, wear: 0, tempC: 60, pressurePsi };
}

/** Normalised Magic Formula, peak of 1 near s = 1. */
function pac(s: number): number {
  const x = PAC_B * s;
  return Math.sin(PAC_C * Math.atan(x - PAC_E * (x - Math.atan(x))));
}

export function temperatureGrip(tyre: TyreState): number {
  const spec = COMPOUNDS[tyre.compound];
  const d = (tyre.tempC - spec.optimalTempC) / spec.tempWindowC;
  return 0.62 + 0.38 * Math.exp(-0.5 * d * d);
}

export function wearGrip(wear: number): number {
  const w = wear < 0 ? 0 : wear > 1 ? 1 : wear;
  const base = 1 - 0.15 * Math.min(w / 0.75, 1);
  if (w <= 0.75) return base;
  const k = (w - 0.75) / 0.25;
  return base - 0.40 * k * (0.6 + 0.4 * k);
}

/** Grip factor from track wetness and compound. */
export function wetnessGrip(compound: TyreCompound, wetness: number): number {
  const w = wetness < 0 ? 0 : wetness > 1 ? 1 : wetness;
  switch (compound) {
    case 'inter': {
      // 0.86 dry, peak at mid wet, mild loss at full wet
      return w < 0.5 ? 0.86 + 0.14 * (w / 0.5) : 1.0 - 0.10 * ((w - 0.5) / 0.5);
    }
    case 'wet': {
      // dry-track penalty, best at full wet
      return 0.80 + 0.20 * Math.min(1, w * 1.2) - 0.0;
    }
    default:
      return 1 - 0.6 * Math.pow(w, 0.9);
  }
}

/** Surface friction multiplier (excluding wetness), and rolling drag coefficient. */
export function surfaceGrip(s: SurfaceType): number {
  switch (s) {
    case 'asphalt': return 1.0;
    case 'pitlane': return 1.0;
    case 'kerb': return 0.9;
    case 'grass': return 0.55;
    case 'gravel': return 0.45;
    default: return 0.8;
  }
}
export function surfaceRollingDrag(s: SurfaceType): number {
  switch (s) {
    case 'grass': return 0.06;
    case 'gravel': return 0.22;
    default: return 0.0;
  }
}

/** Overall grip multiplier from the tyre state (compound, temperature, wear, pressure). */
export function tyreGripFactor(tyre: TyreState): number {
  const spec = COMPOUNDS[tyre.compound];
  const dp = (tyre.pressurePsi - 23) / 6;
  return spec.grip * temperatureGrip(tyre) * wearGrip(tyre.wear) * (1 - 0.04 * dp * dp);
}

/** Approximate longitudinal slip stiffness dFx/dkappa (N per unit slip ratio) at zero slip. */
export function longitudinalStiffness(loadN: number, tyre: TyreState, surfaceGripMul: number): number {
  if (loadN <= 1) return 0;
  const mu = Math.pow(loadN / TYRE_REF_LOAD, -0.13) * tyreGripFactor(tyre) * surfaceGripMul;
  return MU_PEAK_X * mu * loadN * PAC_C * PAC_B / SLIP_RATIO_PEAK;
}

const out = { fx: 0, fy: 0 };

/**
 * Combined-slip force. Returns local tyre forces in N (fx longitudinal, fy lateral, +fy toward +X local/left
 * convention is up to the caller: fy opposes the sign of slipAngle). The returned object is reused.
 * `surfaceGrip` should include surface type and wetness multipliers.
 */
export function tyreForce(
  slipRatio: number, slipAngle: number, loadN: number, tyre: TyreState, surfaceGripMul: number, camberRad: number,
): { fx: number; fy: number } {
  if (loadN <= 1) { out.fx = 0; out.fy = 0; return out; }
  const loadRatio = loadN / TYRE_REF_LOAD;
  const sens = Math.pow(loadRatio, -0.13);
  const mu = sens * tyreGripFactor(tyre) * surfaceGripMul;
  // camber: optimum ~ -3 deg (negative camber helps)
  const dc = camberRad + 0.05;
  const camberMul = Math.max(0.8, 1 - 25 * dc * dc);
  const kn = slipRatio / SLIP_RATIO_PEAK;
  const an = slipAngle / SLIP_ANGLE_PEAK;
  const s = Math.hypot(kn, an);
  if (s < 1e-6) { out.fx = 0; out.fy = 0; return out; }
  const f = pac(s);
  out.fx = MU_PEAK_X * mu * loadN * f * kn / s;
  out.fy = -MU_PEAK_Y * mu * camberMul * loadN * f * an / s;
  return out;
}

/**
 * Advance tyre temperature and wear.
 * slipPowerW: |F|·|slip velocity| for this tyre. speed: car speed m/s.
 */
export function stepTyre(
  tyre: TyreState, slipPowerW: number, loadN: number, speed: number, dt: number,
  airC: number, trackC: number, wetness: number, wearMul: number,
): void {
  const spec = COMPOUNDS[tyre.compound];
  const ambient = 0.5 * (airC + trackC) + 5;
  const rolling = 0.012 * loadN * speed;                       // hysteresis heating
  const heat = slipPowerW * 0.9 + rolling;
  const wetCool = 1 + 2.5 * wetness;
  const cool = 55 * (1 + speed / 35) * wetCool;               // W/K
  const C = 6500;                                              // J/K surface+carcass blend
  tyre.tempC += ((heat - cool * (tyre.tempC - ambient)) / C) * dt;
  if (tyre.tempC < -20) tyre.tempC = -20;
  if (tyre.tempC > 220) tyre.tempC = 220;
  // wear: slip energy; inters/wets wear much faster on a dry track; overheating accelerates it
  let rate = spec.wearRate;
  if (tyre.compound === 'inter') rate *= 1 + 3 * Math.max(0, 0.4 - wetness) / 0.4;
  if (tyre.compound === 'wet') rate *= 1 + 5 * Math.max(0, 0.6 - wetness) / 0.6;
  const over = Math.max(0, tyre.tempC - spec.optimalTempC - spec.tempWindowC) / 40;
  rate *= 1 + over;
  tyre.wear += (slipPowerW + 0.002 * loadN * speed) * dt * rate * wearMul * 1.5e-8;
  if (tyre.wear > 1) tyre.wear = 1;
}
