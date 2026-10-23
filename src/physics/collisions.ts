// Car-vs-car collisions. Each car is two circles (r 0.9 m) at +-1.6 m along its forward axis.
// Dynamic cars (car !== null) are pushed apart and exchange impulses; kinematic bodies are immovable.

import { Quaternion, Vector3 } from 'three';
import type { Car } from './car';

export interface CollisionBody {
  id: string;
  position: Vector3;
  quaternion: Quaternion;
  velocity: Vector3;
  car: Car | null; // null = kinematic (remote)
}

const R_CIRCLE = 0.9;
const OFFSET = 1.6;
const RESTITUTION = 0.2;
const FRICTION = 0.25;
const BROAD = 2 * (OFFSET + R_CIRCLE) + 0.5;
const CG_ABOVE_ORIGIN = 0.3;

const _p = new Vector3();
const _vA = new Vector3();
const _vB = new Vector3();

export function resolveCarCollisions(bodies: CollisionBody[]): void {
  const n = bodies.length;
  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j];
      if (!a.car && !b.car) continue;
      const dx = a.position.x - b.position.x, dz = a.position.z - b.position.z;
      if (dx * dx + dz * dz > BROAD * BROAD) continue;
      if (Math.abs(a.position.y - b.position.y) > 2) continue;
      collidePair(a, b);
    }
  }
}

function forwardXZ(q: Quaternion, out: { x: number; z: number }): void {
  // q * (0,0,1)
  out.x = 2 * (q.x * q.z + q.w * q.y);
  out.z = 1 - 2 * (q.x * q.x + q.y * q.y);
  const l = Math.hypot(out.x, out.z) || 1;
  out.x /= l; out.z /= l;
}

const _fa = { x: 0, z: 1 };
const _fb = { x: 0, z: 1 };

function collidePair(a: CollisionBody, b: CollisionBody): void {
  forwardXZ(a.quaternion, _fa);
  forwardXZ(b.quaternion, _fb);
  const fax = _fa.x, faz = _fa.z, fbx = _fb.x, fbz = _fb.z;
  for (let ca = -1; ca <= 1; ca += 2) {
    for (let cb = -1; cb <= 1; cb += 2) {
      // recompute centres (positions may have been nudged by earlier circle pairs)
      const ax = a.position.x + fax * OFFSET * ca, az = a.position.z + faz * OFFSET * ca;
      const bx = b.position.x + fbx * OFFSET * cb, bz = b.position.z + fbz * OFFSET * cb;
      let nx = ax - bx, nz = az - bz;
      const d = Math.hypot(nx, nz);
      const depth = 2 * R_CIRCLE - d;
      if (depth <= 0) continue;
      if (d > 1e-6) { nx /= d; nz /= d; } else { nx = 1; nz = 0; }

      const carA = a.car, carB = b.car;
      const imA = carA ? 1 / carA.massKg : 0, imB = carB ? 1 / carB.massKg : 0;
      const sum = imA + imB;
      if (sum === 0) continue;
      const pushA = depth * imA / sum, pushB = depth * imB / sum;
      if (carA && pushA > 0) { carA.translate(nx * pushA, 0, nz * pushA); a.position.x += nx * pushA; a.position.z += nz * pushA; }
      if (carB && pushB > 0) { carB.translate(-nx * pushB, 0, -nz * pushB); b.position.x -= nx * pushB; b.position.z -= nz * pushB; }

      // contact point: on the surface of circle B toward A
      const py = 0.5 * (a.position.y + b.position.y) + CG_ABOVE_ORIGIN;
      _p.set(bx + nx * R_CIRCLE, py, bz + nz * R_CIRCLE);
      if (carA) carA.pointVelocity(_p.x, _p.y, _p.z, _vA); else _vA.copy(a.velocity);
      if (carB) carB.pointVelocity(_p.x, _p.y, _p.z, _vB); else _vB.copy(b.velocity);
      const rvx = _vA.x - _vB.x, rvz = _vA.z - _vB.z;
      const vn = rvx * nx + rvz * nz;
      if (vn >= 0) continue;
      const inv = (carA ? carA.invMassAlong(_p.x, _p.y, _p.z, nx, 0, nz) : 0)
        + (carB ? carB.invMassAlong(_p.x, _p.y, _p.z, nx, 0, nz) : 0);
      const j = -(1 + RESTITUTION) * vn / inv;
      // tangential (scrub) impulse
      let tx = rvx - nx * vn, tz = rvz - nz * vn;
      const tl = Math.hypot(tx, tz);
      let jtx = 0, jtz = 0;
      if (tl > 1e-4) {
        tx /= tl; tz /= tl;
        const invT = (carA ? carA.invMassAlong(_p.x, _p.y, _p.z, tx, 0, tz) : 0)
          + (carB ? carB.invMassAlong(_p.x, _p.y, _p.z, tx, 0, tz) : 0);
        const jt = Math.min(FRICTION * j, tl / invT);
        jtx = -tx * jt; jtz = -tz * jt;
      }
      const ix = nx * j + jtx, iz = nz * j + jtz;
      if (carA) { carA.impulseWorld(ix, 0, iz, _p.x, _p.y, _p.z); a.velocity.copy(carA.pose.velocity); }
      if (carB) { carB.impulseWorld(-ix, 0, -iz, _p.x, _p.y, _p.z); b.velocity.copy(carB.pose.velocity); }
    }
  }
}
