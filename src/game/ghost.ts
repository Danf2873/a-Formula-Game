// Lap reference recording: live delta to personal best and time-trial ghost replays.
import type { CarPose } from '../types';

const DELTA_STEP_M = 10;
const GHOST_STEP_MS = 50;

/** Distance→time samples for one lap, used for the live delta. */
export class LapTrace {
  times: number[] = [];   // ms since lap start at s = i * DELTA_STEP_M

  record(s: number, lapMs: number): void {
    const i = Math.floor(s / DELTA_STEP_M);
    while (this.times.length <= i) this.times.push(lapMs);
  }

  timeAt(s: number): number | null {
    const f = s / DELTA_STEP_M;
    const i = Math.floor(f);
    if (i + 1 >= this.times.length) return null;
    return this.times[i] + (this.times[i + 1] - this.times[i]) * (f - i);
  }
}

export interface GhostData {
  circuitId: string;
  lapMs: number;
  driverId: string;
  frames: number[]; // flat: x, y, z, qx, qy, qz, qw per GHOST_STEP_MS
}

export class GhostRecorder {
  private frames: number[] = [];
  private nextMs = 0;

  reset(): void { this.frames = []; this.nextMs = 0; }

  record(lapMs: number, pose: CarPose): void {
    while (lapMs >= this.nextMs) {
      const p = pose.position, q = pose.quaternion;
      this.frames.push(+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2),
        +q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4), +q.w.toFixed(4));
      this.nextMs += GHOST_STEP_MS;
    }
  }

  finish(circuitId: string, driverId: string, lapMs: number): GhostData {
    return { circuitId, driverId, lapMs, frames: this.frames.slice() };
  }
}

/** Write the frame at `lapMs` into `out` (position + quaternion). Returns false past the end. */
export function sampleGhost(g: GhostData, lapMs: number, out: CarPose): boolean {
  const n = g.frames.length / 7;
  const f = lapMs / GHOST_STEP_MS;
  const i = Math.floor(f);
  if (i + 1 >= n || i < 0) return false;
  const t = f - i, a = i * 7, b = a + 7, F = g.frames;
  out.position.set(F[a] + (F[b] - F[a]) * t, F[a + 1] + (F[b + 1] - F[a + 1]) * t, F[a + 2] + (F[b + 2] - F[a + 2]) * t);
  out.quaternion.set(F[a + 3], F[a + 4], F[a + 5], F[a + 6]);
  const qb = { x: F[b + 3], y: F[b + 4], z: F[b + 5], w: F[b + 6] };
  out.quaternion.slerp(new (out.quaternion.constructor as any)(qb.x, qb.y, qb.z, qb.w), t);
  return true;
}

export function loadGhost(circuitId: string): GhostData | null {
  try {
    const raw = localStorage.getItem('f1.ghost.' + circuitId);
    return raw ? (JSON.parse(raw) as GhostData) : null;
  } catch { return null; }
}

export function saveGhost(g: GhostData): void {
  try { localStorage.setItem('f1.ghost.' + g.circuitId, JSON.stringify(g)); } catch { /* quota */ }
}
