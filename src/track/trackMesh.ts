// Flat-shaded low-poly circuit world: terrain, road, kerbs, run-off, barriers, pit lane, start line,
// grid boxes, garages, scenery and landmarks. Geometry is merged per material, repeated items instanced.

import {
  BoxGeometry, BufferGeometry, ConeGeometry, CylinderGeometry, DoubleSide, Float32BufferAttribute, Group, InstancedMesh,
  Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, Quaternion, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Track } from './track';
import { scatterScenery, type SceneryContext } from './scenery';

export type Quality = 'low' | 'medium' | 'high';
export type RGB = [number, number, number];

const DESERT = new Set(['bahrain', 'jeddah', 'lusail', 'abudhabi', 'lasvegas']);
const NIGHT = new Set(['singapore', 'lasvegas', 'bahrain', 'lusail', 'abudhabi', 'jeddah']);

const KERB_WIDTH = 1.2;
const KERB_CURV = 1 / 250;
const PIT_HALF = 3.5;

export const smooth01 = (x: number) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Non-indexed triangle accumulator with per-triangle flat colour. */
export class Acc {
  pos: number[] = [];
  col: number[] = [];

  tri(a: number[], b: number[], c: number[], k: RGB): void {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.col.push(k[0], k[1], k[2], k[0], k[1], k[2], k[0], k[1], k[2]);
  }

  /** Quad a,b,c,d where (a,b,c) and (c,b,d) are the triangles; flips winding to face `want` when given. */
  quad(a: number[], b: number[], c: number[], d: number[], k: RGB, want?: [number, number, number]): void {
    if (want) {
      const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
      const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      if (nx * want[0] + ny * want[1] + nz * want[2] < 0) {
        this.tri(a, c, b, k);
        this.tri(c, d, b, k);
        return;
      }
    }
    this.tri(a, b, c, k);
    this.tri(c, b, d, k);
  }

  get triangles(): number { return this.pos.length / 9; }

  build(): BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

export function rgb(hex: number, jitter = 0, rnd?: () => number): RGB {
  const j = rnd && jitter ? 1 + (rnd() - 0.5) * 2 * jitter : 1;
  return [((hex >> 16) & 255) / 255 * j, ((hex >> 8) & 255) / 255 * j, (hex & 255) / 255 * j];
}

const unitBox = new BoxGeometry(1, 1, 1).toNonIndexed();
unitBox.deleteAttribute('uv');

/** Boxes (yaw about +Y, local x = left, local z = forward) collected into a merged geometry. */
export class BoxBatch {
  geos: BufferGeometry[] = [];
  private m = new Matrix4();
  private q = new Quaternion();
  private e = new Object3D();

  add(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yaw: number, color: RGB, pitch = 0): void {
    const g = unitBox.clone();
    this.e.position.set(cx, cy, cz);
    this.e.rotation.set(pitch, yaw, 0, 'YXZ');
    this.e.scale.set(sx, sy, sz);
    this.e.updateMatrix();
    this.m.copy(this.e.matrix);
    g.applyMatrix4(this.m);
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = color[0]; c[i * 3 + 1] = color[1]; c[i * 3 + 2] = color[2]; }
    g.setAttribute('color', new Float32BufferAttribute(c, 3));
    this.geos.push(g);
  }

  /** Append arbitrary geometry (already positioned) with a flat colour. */
  addGeometry(src: BufferGeometry, matrix: Matrix4, color: RGB): void {
    let g = src.index ? src.toNonIndexed() : src.clone();
    g.deleteAttribute('uv');
    g.applyMatrix4(matrix);
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = color[0]; c[i * 3 + 1] = color[1]; c[i * 3 + 2] = color[2]; }
    g.setAttribute('color', new Float32BufferAttribute(c, 3));
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    this.geos.push(g);
  }

  build(extra?: BufferGeometry | null): BufferGeometry | null {
    const list = [...this.geos];
    if (extra) list.push(extra);
    if (list.length === 0) return null;
    return mergeGeometries(list, false);
  }
}

export function buildTrackScene(track: Track, opts?: { quality: Quality }): Group {
  const quality: Quality = opts?.quality ?? 'high';
  const density = quality === 'low' ? 0.3 : quality === 'medium' ? 0.65 : 1;
  const stride = quality === 'low' ? 3 : 2;
  const d = track.data;
  const n = track.sampleCount;
  const L = track.length;
  const rnd = mulberry32(hashStr(d.id));
  const desert = DESERT.has(d.id);
  const night = NIGHT.has(d.id) || d.raceTimeOfDay >= 18 || d.raceTimeOfDay <= 5;
  const group = new Group();
  group.name = `track:${d.id}`;

  const litMat = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
  const fenceMat = new MeshStandardMaterial({ color: 0x9aa0a8, transparent: true, opacity: 0.3, side: DoubleSide, roughness: 1 });

  // ------------------------------------------------------------- helpers
  const P = (i: number, lat: number, dy = 0): number[] => {
    const k = ((i % n) + n) % n;
    return [track.px[k] + track.lx[k] * lat, track.py[k] + dy, track.pz[k] + track.lz[k] * lat];
  };
  const pitSide = track.pitSide;
  const inPit = (i: number) => track.pitOff[((i % n) + n) % n] >= 0;
  const limitOf = (i: number, side: 1 | -1) => track.sideLimit(((i % n) + n) % n, side);

  type Fn = (i: number) => number;
  /** Ribbon along the samples between lateral bounds lo(i)..hi(i) (lo < hi, + = left). */
  function ribbon(acc: Acc, lo: Fn, hi: Fn, dy: number, color: (seg: number) => RGB, skip?: (i0: number, i1: number) => boolean, step = stride): void {
    for (let i = 0, seg = 0; i < n; i += step, seg++) {
      const j = Math.min(i + step, n);
      if (skip && skip(i, j)) continue;
      const a = P(i, lo(i), dy), b = P(j, lo(j), dy), c = P(i, hi(i), dy), e = P(j, hi(j), dy);
      acc.quad(a, b, c, e, color(seg));
    }
  }

  const hwOf = (i: number) => track.hw[((i % n) + n) % n];

  // ------------------------------------------------------------- terrain height
  const gh = { idx: -1 };
  const groundY = (x: number, z: number): number => {
    const p = track.project(x, z, gh);
    const y = track.frameAt(p.s).position.y;
    const a = Math.abs(p.lateral);
    return y - (1.5 - 0.9 * smooth01((a - 60) / 100));
  };

  // ------------------------------------------------------------- terrain
  const terrain = new Acc();
  {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i += 4) {
      minX = Math.min(minX, track.px[i]); maxX = Math.max(maxX, track.px[i]);
      minZ = Math.min(minZ, track.pz[i]); maxZ = Math.max(maxZ, track.pz[i]);
    }
    const cell = quality === 'low' ? 60 : quality === 'medium' ? 40 : 30;
    const margin = 350;
    minX -= margin; maxX += margin; minZ -= margin; maxZ += margin;
    const nx = Math.max(2, Math.ceil((maxX - minX) / cell)), nz = Math.max(2, Math.ceil((maxZ - minZ) / cell));
    const sx = (maxX - minX) / nx, sz = (maxZ - minZ) / nz;
    const H = new Float32Array((nx + 1) * (nz + 1));
    const th = { idx: -1 };
    for (let k = 0; k <= nz; k++) {
      for (let j = 0; j <= nx; j++) {
        const x = minX + j * sx, z = minZ + k * sz;
        const p = track.project(x, z, th);
        const y = track.frameAt(p.s).position.y;
        const a = Math.abs(p.lateral);
        H[k * (nx + 1) + j] = y - (1.5 + 1.0 - 0.9 * smooth01((a - 60) / 100)); // a little lower than ground()
      }
    }
    const base: RGB = desert ? [0.76, 0.66, 0.46] : [0.27, 0.45, 0.2];
    const alt: RGB = desert ? [0.7, 0.58, 0.4] : [0.23, 0.4, 0.17];
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < nx; j++) {
        const x0 = minX + j * sx, x1 = x0 + sx, z0 = minZ + k * sz, z1 = z0 + sz;
        const h00 = H[k * (nx + 1) + j], h10 = H[k * (nx + 1) + j + 1], h01 = H[(k + 1) * (nx + 1) + j], h11 = H[(k + 1) * (nx + 1) + j + 1];
        const t = rnd();
        const c1: RGB = [base[0] + (alt[0] - base[0]) * t, base[1] + (alt[1] - base[1]) * t, base[2] + (alt[2] - base[2]) * t];
        const c2: RGB = [c1[0] * 0.96, c1[1] * 0.96, c1[2] * 0.96];
        // up-facing winding: a=(x0,z0) b=(x0,z1) c=(x1,z0) -> (x1,z0)... forward = +z, left = -x
        terrain.tri([x0, h00, z0], [x0, h01, z1], [x1, h10, z0], c1);
        terrain.tri([x1, h10, z0], [x0, h01, z1], [x1, h11, z1], c2);
      }
    }
  }

  // ------------------------------------------------------------- road & markings
  const road = new Acc();
  const roadBase = 0.2;
  for (let lane = 0; lane < 4; lane++) {
    const f0 = lane / 4, f1 = (lane + 1) / 4;
    ribbon(road, (i) => (f0 * 2 - 1) * hwOf(i), (i) => (f1 * 2 - 1) * hwOf(i), 0, (seg) => {
      const v = roadBase + (rnd() - 0.5) * 0.035 + (seg % 7 === 0 ? 0.008 : 0);
      return [v, v, v * 1.04];
    });
  }
  // rubbered racing line
  ribbon(road, (i) => track.racingLineOffset(i * track.sampleSpacing) - 1.4, (i) => track.racingLineOffset(i * track.sampleSpacing) + 1.4, 0.025,
    () => { const v = roadBase - 0.045; return [v, v, v * 1.04]; });
  // edge lines
  const white: RGB = [0.9, 0.9, 0.9];
  ribbon(road, (i) => hwOf(i) - 0.5, (i) => hwOf(i) - 0.25, 0.04, () => white);
  ribbon(road, (i) => -hwOf(i) + 0.25, (i) => -hwOf(i) + 0.5, 0.04, () => white);

  // kerbs: red/white stripes every 1.5 m
  {
    const stripeLen = 1.5;
    const cnt = Math.floor(L / stripeLen);
    const red: RGB = [0.8, 0.08, 0.08], wh: RGB = [0.92, 0.92, 0.92];
    for (let m = 0; m < cnt; m++) {
      const sa = m * stripeLen, sb = sa + stripeLen;
      const ia = Math.floor(((sa + sb) / 2) / track.sampleSpacing) % n;
      if (Math.abs(track.curv[ia]) <= KERB_CURV) continue;
      const fa = track.frameAt(sa), fb = track.frameAt(sb);
      for (const side of [1, -1] as const) {
        if (side === pitSide && inPit(ia)) continue;
        const col = m % 2 === 0 ? red : wh;
        const lo = side > 0 ? 0 : -KERB_WIDTH, hi = side > 0 ? KERB_WIDTH : 0;
        const off = (f: typeof fa, v: number, dy: number) => [
          f.position.x + f.left.x * (side * f.halfWidth + v), f.position.y + dy, f.position.z + f.left.z * (side * f.halfWidth + v),
        ];
        road.quad(off(fa, lo, 0.045), off(fb, lo, 0.045), off(fa, hi, 0.045), off(fb, hi, 0.045), col);
      }
    }
  }

  // start/finish line + chequered strip
  {
    const f = track.frameAt(0);
    const cells = Math.max(4, Math.round(f.halfWidth * 2));
    const w = (f.halfWidth * 2) / cells;
    const rowLen = 0.8;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < cells; c++) {
        const colr: RGB = (r + c) % 2 === 0 ? [0.05, 0.05, 0.05] : [0.95, 0.95, 0.95];
        const l0 = -f.halfWidth + c * w, l1 = l0 + w;
        const fa = track.frameAt(r * rowLen), fb = track.frameAt((r + 1) * rowLen);
        const pt = (fr: typeof fa, l: number) => [fr.position.x + fr.left.x * l, fr.position.y + 0.06, fr.position.z + fr.left.z * l];
        road.quad(pt(fa, l0), pt(fb, l0), pt(fa, l1), pt(fb, l1), colr);
      }
    }
    // white line just before the chequered strip
    const fa = track.frameAt(-0.5), fb = track.frameAt(0);
    const pt = (fr: typeof fa, l: number) => [fr.position.x + fr.left.x * l, fr.position.y + 0.06, fr.position.z + fr.left.z * l];
    road.quad(pt(fa, -f.halfWidth), pt(fb, -f.halfWidth), pt(fa, f.halfWidth), pt(fb, f.halfWidth), white);
  }

  // grid boxes
  {
    for (let p = 0; p < 22; p++) {
      const g = track.gridSlot(p);
      const sn = Math.sin(g.heading), cs = Math.cos(g.heading);
      const fwd = [sn, cs], lft = [cs, -sn];
      const len = 5, wid = 2.4, lw = 0.15;
      const corner = (a: number, b: number) => [g.position.x + fwd[0] * a + lft[0] * b, g.position.y + 0.05, g.position.z + fwd[1] * a + lft[1] * b];
      // outline of the box, centred slightly ahead
      const rect = (a0: number, a1: number, b0: number, b1: number) => road.quad(corner(a0, b0), corner(a1, b0), corner(a0, b1), corner(a1, b1), white, [0, 1, 0]);
      rect(-len / 2 + 1.5, -len / 2 + 1.5 + lw, -wid / 2, wid / 2);          // back line
      rect(len / 2 - 1.5 - lw, len / 2 - 1.5, -wid / 2, -wid / 2 + 0.6);
      rect(len / 2 - 1.5 - lw, len / 2 - 1.5, wid / 2 - 0.6, wid / 2);
      rect(-len / 2 + 1.5, len / 2 - 1.5, -wid / 2, -wid / 2 + lw);          // side lines
      rect(-len / 2 + 1.5, len / 2 - 1.5, wid / 2 - lw, wid / 2);
    }
  }

  // ------------------------------------------------------------- run-off, pit lane, barriers
  const runoff = new Acc();
  const gravelC = 0x9a8a62, grassC = desert ? 0xb89f6c : 0x3f7a30, asphC = 0x4a4a50;
  for (const side of [1, -1] as const) {
    const si = side > 0 ? 0 : 1;
    const typeAt = (i: number) => track.roType[si][((i % n) + n) % n];
    ribbon(
      runoff,
      (i) => (side > 0 ? hwOf(i) : -limitOf(i, side)),
      (i) => (side > 0 ? limitOf(i, side) : -hwOf(i)),
      -0.03,
      (seg) => {
        const t = typeAt(seg * stride);
        return rgb(t === 1 ? gravelC : t >= 2 ? asphC : grassC, 0.06, rnd);
      },
      side === pitSide ? (i0, i1) => inPit(i0) && inPit(i1) : undefined,
    );
  }
  // embankment skirt beyond the barrier, down to the terrain
  for (const side of [1, -1] as const) {
    for (let i = 0; i < n; i += stride) {
      const j = Math.min(i + stride, n);
      const w0 = side * (limitOf(i, side) + 0.5), w1 = side * (limitOf(i, side) + 14);
      const v0 = side * (limitOf(j, side) + 0.5), v1 = side * (limitOf(j, side) + 14);
      const [a, b] = side > 0 ? [P(i, w0, -0.05), P(i, w1, -2.2)] : [P(i, w1, -2.2), P(i, w0, -0.05)];
      const [c, e] = side > 0 ? [P(j, v0, -0.05), P(j, v1, -2.2)] : [P(j, v1, -2.2), P(j, v0, -0.05)];
      runoff.quad(a, c, b, e, rgb(grassC, 0.06, rnd), [0, 1, 0]);
    }
  }
  // pit lane: concrete apron, lane surface, lane lines
  {
    const apron = 0x5a5a5e, lane = 0x2c2c30;
    const wallCol: RGB = [0.86, 0.86, 0.88];
    const ps = pitSide;
    const both = (i0: number, i1: number) => !(inPit(i0) || inPit(i1));
    const offAt = (i: number) => Math.max(0, track.pitOff[((i % n) + n) % n]);
    // apron from track edge to pit barrier (lateral measured on the pit side)
    ribbon(runoff, (i) => (ps > 0 ? hwOf(i) : -limitOf(i, ps)), (i) => (ps > 0 ? limitOf(i, ps) : -hwOf(i)), -0.02, () => rgb(apron, 0.04, rnd), both);
    const laneLo = (i: number) => Math.max(offAt(i) - PIT_HALF, hwOf(i));
    const laneHi = (i: number) => offAt(i) + PIT_HALF;
    const valid = (i0: number, i1: number) => both(i0, i1) || laneHi(i0) - laneLo(i0) < 0.4 || laneHi(i1) - laneLo(i1) < 0.4;
    ribbon(runoff, (i) => (ps > 0 ? laneLo(i) : -laneHi(i)), (i) => (ps > 0 ? laneHi(i) : -laneLo(i)), 0.02, () => rgb(lane, 0.05, rnd), valid);
    const lineHi = 0.18;
    for (const edge of [0, 1]) {
      const l = (i: number) => (edge === 0 ? laneLo(i) : laneHi(i) - lineHi);
      ribbon(runoff, (i) => (ps > 0 ? l(i) : -(l(i) + lineHi)), (i) => (ps > 0 ? l(i) + lineHi : -l(i)), 0.035, () => white, valid);
    }
    void wallCol;
  }

  // barrier ribbons
  const barrier = new Acc();
  const fence = new Acc();
  const poles: Matrix4[] = [];
  {
    const street = d.street;
    const mat4 = new Matrix4(), q = new Quaternion(), sc = new Vector3(1, 1, 1), up = new Vector3(0, 1, 0);
    for (const side of [1, -1] as const) {
      const si = side > 0 ? 0 : 1;
      for (let i = 0, seg = 0; i < n; i += stride, seg++) {
        const j = Math.min(i + stride, n);
        const lim0 = side * limitOf(i, side), lim1 = side * limitOf(j, side);
        const ro = track.roType[si][i % n];
        const corner = Math.abs(track.curv[i % n]) > 1 / 400;
        let h: number, col: RGB, topCol: RGB;
        if (street) {
          h = 1.8; col = seg % 8 < 4 ? [0.74, 0.74, 0.72] : [0.62, 0.62, 0.6]; topCol = [0.55, 0.55, 0.55];
          if (seg % 12 === 0) col = [0.8, 0.12, 0.12];
        } else if ((ro === 1 || ro === 2) && corner) {
          h = 1.2; col = seg % 6 === 5 ? [0.85, 0.85, 0.85] : seg % 2 === 0 ? [0.07, 0.07, 0.09] : [0.1, 0.12, 0.2]; topCol = [0.05, 0.05, 0.06];
        } else {
          h = 0.8; col = [0.72, 0.74, 0.78]; topCol = [0.6, 0.62, 0.66];
        }
        const a = P(i, lim0), b = P(j, lim1);
        const a2 = [a[0], a[1] + h, a[2]], b2 = [b[0], b[1] + h, b[2]];
        const inward: [number, number, number] = [-side * track.lx[i % n], 0, -side * track.lz[i % n]];
        barrier.quad(a, b, a2, b2, col, inward);
        const at = P(i, lim0 + side * 0.5, h), bt = P(j, lim1 + side * 0.5, h);
        barrier.quad(a2, b2, at, bt, topCol, [0, 1, 0]);
        if (street) {
          const fa2 = [a[0], a[1] + 5.2, a[2]], fb2 = [b[0], b[1] + 5.2, b[2]];
          fence.quad(a2, b2, fa2, fb2, [1, 1, 1], inward);
          if (seg % 3 === 0) {
            const nx = track.lx[i % n], nz = track.lz[i % n];
            const yaw = Math.atan2(nz, -nx);
            q.setFromAxisAngle(up, yaw);
            mat4.compose(new Vector3(a[0], a[1] + 3.2, a[2]), q, sc);
            poles.push(mat4.clone());
          }
        }
      }
    }
    // pit wall
    const ps = pitSide;
    const wallCol: RGB = [0.85, 0.85, 0.88];
    for (let i = 0, seg = 0; i < n; i += stride, seg++) {
      const j = Math.min(i + stride, n);
      if (!track.pitWall[i % n] || !track.pitWall[j % n]) continue;
      const l0 = ps * (hwOf(i) + 3), l1 = ps * (hwOf(j) + 3);
      const a = P(i, l0), b = P(j, l1);
      const a2 = [a[0], a[1] + 1.0, a[2]], b2 = [b[0], b[1] + 1.0, b[2]];
      const nrm: [number, number, number] = [track.lx[i % n], 0, track.lz[i % n]];
      barrier.quad(a, b, a2, b2, wallCol, nrm);
      barrier.quad(a, b, a2, b2, wallCol, [-nrm[0], 0, -nrm[2]]);
      const ta = P(i, l0 - 0.25, 1.0), tb = P(j, l1 - 0.25, 1.0), tc = P(i, l0 + 0.25, 1.0), td = P(j, l1 + 0.25, 1.0);
      barrier.quad(ta, tb, tc, td, seg % 4 < 2 ? [0.75, 0.1, 0.1] : [0.9, 0.9, 0.9], [0, 1, 0]);
    }
  }

  // ------------------------------------------------------------- structures
  const boxes = new BoxBatch();
  const yawOf = (s: number) => { const f = track.frameAt(s); return Math.atan2(f.tangent.x, f.tangent.z); };

  // garages behind the pit-lane barrier
  {
    const palette = [0x1e41ff, 0xd40000, 0xff8000, 0x00a19b, 0x229971, 0x0090ff, 0xff87bc, 0x6692ff, 0xb6babd, 0x52e252, 0xffffff];
    for (let k = 0; k < 11; k++) {
      const b = track.pitBox(k);
      const f = track.frameAt(track.pitStart + b.t * track.pitLen);
      const yaw = Math.atan2(f.tangent.x, f.tangent.z);
      const lat = pitSide * (d.pit.offsetM + 6 + 0.6 + 3);
      const cx = f.position.x + f.left.x * lat, cz = f.position.z + f.left.z * lat, cy = f.position.y;
      boxes.add(cx, cy + 2, cz, 6, 4, 10, yaw, rgb(0xcfd2d6));
      const fx = f.left.x * pitSide * -3.02, fz = f.left.z * pitSide * -3.02;
      boxes.add(cx + fx, cy + 3.6, cz + fz, 0.1, 0.5, 10, yaw, rgb(palette[k]));
      boxes.add(cx + fx * 0.99, cy + 1.6, cz + fz * 0.99, 0.12, 3.2, 9, yaw, [0.1, 0.1, 0.12]);
    }
    // pit building roof / lane marker strip along the lane
  }

  // start gantry
  const startLights: Mesh[] = [];
  {
    const f = track.frameAt(0), yaw = Math.atan2(f.tangent.x, f.tangent.z);
    const hw = f.halfWidth + 2.5;
    const at = (lat: number, fwd = 0, up = 0) => new Vector3(
      f.position.x + f.left.x * lat + f.tangent.x * fwd, f.position.y + up, f.position.z + f.left.z * lat + f.tangent.z * fwd);
    for (const sgn of [-1, 1]) {
      const p = at(sgn * hw);
      boxes.add(p.x, p.y + 4.2, p.z, 0.9, 8.4, 0.9, yaw, [0.25, 0.25, 0.28]);
    }
    const mid = at(0, 0, 8.4);
    boxes.add(mid.x, mid.y, mid.z, hw * 2 + 0.9, 1.4, 1.0, yaw, [0.15, 0.15, 0.17]);
    const podGeo = new BoxGeometry(1.3, 0.9, 0.5);
    for (let k = 0; k < 5; k++) {
      const p = at((k - 2) * 2.2, -0.7, 8.4);
      const m = new Mesh(podGeo, new MeshBasicMaterial({ color: 0x2a0505 }));
      m.position.copy(p);
      m.rotation.y = yaw;
      m.name = `startLight${k}`;
      startLights.push(m);
    }
  }

  // scenery (trees, grandstands, buildings, landmarks, marshal posts, brake boards, light posts)
  const ctx: SceneryContext = {
    track, quality, density, rnd, desert, night, street: d.street, boxes, groundY, limitOf,
  };
  const scenery = scatterScenery(ctx);

  // ------------------------------------------------------------- assemble
  const addMesh = (geo: BufferGeometry | null, name: string, receive: boolean, cast: boolean, mat: MeshStandardMaterial = litMat) => {
    if (!geo) return null;
    const m = new Mesh(geo, mat);
    m.name = name;
    m.receiveShadow = receive;
    m.castShadow = cast;
    group.add(m);
    return m;
  };
  addMesh(terrain.build(), 'terrain', true, false);
  addMesh(mergeGeometries([road.build(), runoff.build()].filter((g): g is BufferGeometry => !!g), false), 'surface', true, false);
  addMesh(barrier.build(), 'barriers', true, true);
  addMesh(boxes.build(scenery.structureExtra), 'structures', true, true);
  if (d.street && fence.triangles > 0) {
    const m = new Mesh(fence.build()!, fenceMat);
    m.name = 'fence';
    group.add(m);
  }
  for (const m of scenery.instanced) group.add(m);
  // street fence poles
  if (poles.length) {
    const g = new CylinderGeometry(0.06, 0.06, 6.4, 4);
    const im = new InstancedMesh(g, new MeshStandardMaterial({ color: 0x555a60, flatShading: true }), poles.length);
    poles.forEach((m, i) => im.setMatrixAt(i, m));
    im.name = 'fencePoles';
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
  }
  for (const m of startLights) group.add(m);
  group.userData.startLights = startLights;
  group.userData.night = night;
  return group;
}

export function disposeTrackScene(group: Group): void {
  const mats = new Set<any>();
  group.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = (m as any).material;
    if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x: any) => mats.add(x));
    if ((o as InstancedMesh).isInstancedMesh) (o as InstancedMesh).dispose();
  });
  mats.forEach((m) => m.dispose());
  group.clear();
}

export { ConeGeometry };
