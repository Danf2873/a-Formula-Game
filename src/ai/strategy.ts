// Race strategy planning for AI cars.
import type { TyreCompound } from '../types';

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

/**
 * Plans the stops. `stopLaps[i]` is the (1-based) lap on which stop i is made; `compounds[0]` is the starting
 * compound and `compounds[i + 1]` the one fitted at stop i, so compounds.length === stopLaps.length + 1.
 */
export function planStrategy(laps: number, wearMul: number, wet: boolean, seed: number): { stopLaps: number[]; compounds: TyreCompound[] } {
  const rng = mulberry32(seed ^ 0x51ed270b);
  const r1 = rng(), r2 = rng(), r3 = rng(), r4 = rng(), r5 = rng();
  if (wet) {
    return { stopLaps: [], compounds: [r1 < 0.7 ? 'inter' : 'wet'] };
  }
  const lo = laps >= 3 ? 2 : 1;
  const hi = Math.max(lo, laps - 1);
  const clampLap = (x: number) => Math.min(hi, Math.max(lo, Math.round(x)));
  if (laps < 2) return { stopLaps: [], compounds: [r1 < 0.5 ? 'medium' : 'hard'] };

  const mediumFirst = r2 < 0.55;
  if (wearMul <= 0) {
    return { stopLaps: [clampLap(laps * 0.5)], compounds: mediumFirst ? ['medium', 'hard'] : ['hard', 'medium'] };
  }
  const twoStopChance = laps >= 15 ? Math.min(0.6, 0.15 + 0.15 * wearMul) : 0;
  if (r1 < twoStopChance) {
    const a = clampLap(laps * (0.22 + r3 * 0.16));
    const b = Math.max(a + 1, clampLap(laps * (0.55 + r4 * 0.2)));
    const set: TyreCompound[][] = [
      ['medium', 'hard', 'medium'], ['hard', 'medium', 'hard'], ['soft', 'medium', 'hard'], ['medium', 'hard', 'hard'],
    ];
    const compounds = set[Math.floor(r5 * set.length)].slice();
    return { stopLaps: [a, Math.min(b, laps)], compounds };
  }
  const stop = clampLap(laps * (0.35 + r3 * 0.2));
  const compounds: TyreCompound[] = r5 < 0.12 ? ['soft', 'hard'] : mediumFirst ? ['medium', 'hard'] : ['hard', 'medium'];
  return { stopLaps: [stop], compounds };
}
