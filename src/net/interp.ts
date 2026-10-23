// Snapshot buffer for remote cars: interpolates ~100 ms in the past, extrapolates up to 250 ms.
import { Vector3, Quaternion } from 'three';
import type { CarPose, NetCarState } from '../types';

export const INTERP_DELAY_MS = 100;
export const MAX_EXTRAPOLATION_MS = 250;
export const BUFFER_SIZE = 20;
const WHEEL_RADIUS = 0.36;

interface Snap {
  t: number;
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number];
  steer: number;
  speed: number; // m/s
}

export class RemoteCarBuffer {
  private buf: Snap[] = [];
  private offset = 0; // estimated (localNow - senderT)
  private hasOffset = false;
  private lastSampleLocal = NaN;
  private readonly pose: CarPose = {
    position: new Vector3(),
    quaternion: new Quaternion(),
    velocity: new Vector3(),
    steerAngle: 0,
    wheelSpin: [0, 0, 0, 0],
    wheelCompression: [0, 0, 0, 0],
  };
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();

  /** Current clock-offset estimate (local ms minus sender ms). */
  get clockOffset(): number { return this.offset; }
  get size(): number { return this.buf.length; }

  push(s: NetCarState, localNowMs: number): void {
    const o = localNowMs - s.t;
    if (!this.hasOffset) { this.offset = o; this.hasOffset = true; }
    else if (o < this.offset) this.offset = o;              // fastest packet = least jitter: snap down
    else this.offset += (o - this.offset) * 0.02;           // drift up slowly (clock drift / route change)

    const snap: Snap = { t: s.t, p: s.p, q: s.q, v: s.v, steer: s.steer, speed: s.speedKmh / 3.6 };
    const b = this.buf;
    // Insert sorted by t; replace duplicates.
    let i = b.length;
    while (i > 0 && b[i - 1].t > s.t) i--;
    if (i > 0 && b[i - 1].t === s.t) b[i - 1] = snap;
    else b.splice(i, 0, snap);
    while (b.length > BUFFER_SIZE) b.shift();
  }

  sample(localNowMs: number): CarPose | null {
    const b = this.buf;
    if (b.length === 0) return null;
    const rt = localNowMs - this.offset - INTERP_DELAY_MS; // render time in sender clock
    const pose = this.pose;
    const last = b[b.length - 1];

    let speed: number;
    if (rt >= last.t) {
      const dt = Math.min(rt - last.t, MAX_EXTRAPOLATION_MS) / 1000;
      pose.position.set(last.p[0] + last.v[0] * dt, last.p[1] + last.v[1] * dt, last.p[2] + last.v[2] * dt);
      pose.quaternion.set(last.q[0], last.q[1], last.q[2], last.q[3]);
      pose.velocity.set(last.v[0], last.v[1], last.v[2]);
      pose.steerAngle = last.steer;
      speed = last.speed;
    } else if (rt <= b[0].t) {
      const f = b[0];
      pose.position.set(f.p[0], f.p[1], f.p[2]);
      pose.quaternion.set(f.q[0], f.q[1], f.q[2], f.q[3]);
      pose.velocity.set(f.v[0], f.v[1], f.v[2]);
      pose.steerAngle = f.steer;
      speed = f.speed;
    } else {
      let i = b.length - 2;
      while (i > 0 && b[i].t > rt) i--;
      const a = b[i], c = b[i + 1];
      const span = c.t - a.t;
      const u = span > 0 ? (rt - a.t) / span : 0;
      const h = span / 1000;
      // cubic Hermite using velocities
      const u2 = u * u, u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
      pose.position.set(
        h00 * a.p[0] + h10 * h * a.v[0] + h01 * c.p[0] + h11 * h * c.v[0],
        h00 * a.p[1] + h10 * h * a.v[1] + h01 * c.p[1] + h11 * h * c.v[1],
        h00 * a.p[2] + h10 * h * a.v[2] + h01 * c.p[2] + h11 * h * c.v[2],
      );
      this.qa.set(a.q[0], a.q[1], a.q[2], a.q[3]);
      this.qb.set(c.q[0], c.q[1], c.q[2], c.q[3]);
      pose.quaternion.copy(this.qa).slerp(this.qb, u);
      pose.velocity.set(
        a.v[0] + (c.v[0] - a.v[0]) * u, a.v[1] + (c.v[1] - a.v[1]) * u, a.v[2] + (c.v[2] - a.v[2]) * u);
      pose.steerAngle = a.steer + (c.steer - a.steer) * u;
      speed = a.speed + (c.speed - a.speed) * u;
    }

    if (!Number.isNaN(this.lastSampleLocal)) {
      const dtS = Math.min(Math.max(localNowMs - this.lastSampleLocal, 0), 250) / 1000;
      const d = (speed / WHEEL_RADIUS) * dtS;
      for (let k = 0; k < 4; k++) pose.wheelSpin[k] += d;
    }
    this.lastSampleLocal = localNowMs;
    return pose;
  }
}
