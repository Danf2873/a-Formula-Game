// Scenery for the track scene: instanced trees, grandstands, buildings, marshal posts, brake boards,
// light posts and the landmark kinds from CircuitData.landmarks. Structures go into the shared BoxBatch.

import {
  BufferGeometry, BoxGeometry, Color, ConeGeometry, CylinderGeometry, InstancedMesh, Matrix4, MeshBasicMaterial,
  MeshStandardMaterial, Quaternion, Vector3,
} from 'three';
import type { Track } from './track';
import type { BoxBatch, Quality } from './trackMesh';

type RGB = [number, number, number];

export interface SceneryContext {
  track: Track;
  quality: Quality;
  density: number;
  rnd: () => number;
  desert: boolean;
  night: boolean;
  street: boolean;
  boxes: BoxBatch;
  groundY: (x: number, z: number) => number;
  limitOf: (i: number, side: 1 | -1) => number;
}

export interface SceneryResult {
  instanced: InstancedMesh[];
  structureExtra: BufferGeometry | null;
}

const DENSE = new Set(['spa', 'spielberg', 'interlagos', 'suzuka', 'montreal']);

const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const mul = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const UP = new Vector3(0, 1, 0);

export function scatterScenery(ctx: SceneryContext): SceneryResult {
  const { track, density, rnd, boxes, groundY, limitOf } = ctx;
  const d = track.data;
  const n = track.sampleCount;
  const L = track.length;
  const instanced: InstancedMesh[] = [];
  const sgn = (v: number): 1 | -1 => (v >= 0 ? 1 : -1);

  /** World position at lap distance s and signed lateral offset. */
  const at = (s: number, lat: number) => {
    const f = track.frameAt(s);
    return { f, x: f.position.x + f.left.x * lat, z: f.position.z + f.left.z * lat, yaw: Math.atan2(f.tangent.x, f.tangent.z) };
  };

  /** True when (x,z) is clear of the circuit (beyond barriers + margin, behind pit garages) and returns the margin used. */
  const hint = { idx: -1 };
  const clear = (x: number, z: number, margin: number): boolean => {
    const p = track.project(x, z, hint);
    const side = sgn(p.lateral);
    let lim = limitOf(p.idx, side);
    if (side === track.pitSide && track.pitOff[p.idx] >= 0) lim = Math.max(lim, d.pit.offsetM + 26);
    return Math.abs(p.lateral) >= lim + margin;
  };

  // ---------------------------------------------------------- trees
  const trees: { x: number; y: number; z: number; sc: number; tone: number }[] = [];
  const addTree = (x: number, z: number, sc: number) => {
    trees.push({ x, y: groundY(x, z), z, sc, tone: rnd() });
  };
  if (!ctx.street) {
    const dense = DENSE.has(d.id) ? 2.5 : 1;
    const mult = ctx.desert ? 0.12 : 1;
    const spacing = 14 / (density * dense * mult);
    for (let s = 0; s < L; s += spacing) {
      for (const side of [1, -1] as const) {
        if (rnd() < 0.15) continue;
        const i = Math.floor(s / track.sampleSpacing) % n;
        let lat = side * (limitOf(i, side) + 7 + rnd() * (dense > 1 ? 70 : 45));
        if (side === track.pitSide && track.pitOff[i] >= 0) lat = side * (d.pit.offsetM + 40 + rnd() * 40);
        const p = at(s + (rnd() - 0.5) * spacing, lat);
        if (!clear(p.x, p.z, 4)) continue;
        addTree(p.x, p.z, 0.8 + rnd() * 0.9);
      }
    }
  }

  // ---------------------------------------------------------- grandstands & structures
  const standColors = [hex(0xc23030), hex(0x2d4fa8), hex(0xd8d8d8), hex(0xe3a82b)];
  const grandstand = (s: number, lat: number, length: number, tiers: number) => {
    const p0 = at(s, lat);
    const side = sgn(lat);
    const base = groundY(p0.x, p0.z);
    const stepW = 1.7;
    const c = standColors[Math.floor(rnd() * standColors.length)];
    for (let k = 0; k < tiers; k++) {
      const q = at(s, lat + side * (k * stepW + stepW / 2));
      const h = 1.5 + k * 0.9;
      boxes.add(q.x, base + h / 2, q.z, stepW, h, length, q.yaw, k % 2 === 0 ? c : mul(c, 0.8));
    }
    const rq = at(s, lat + side * (tiers * stepW) / 2);
    boxes.add(rq.x, base + tiers * 0.9 + 4.5, rq.z, tiers * stepW + 1.5, 0.35, length + 2, rq.yaw, hex(0xe8e8ec));
    for (const e of [-1, 1]) {
      const pq = at(s + e * (length / 2 - 1), lat + side * (tiers * stepW - 0.6));
      boxes.add(pq.x, base + tiers * 0.9 / 2 + 2.2, pq.z, 0.4, tiers * 0.9 + 4.4, 0.4, pq.yaw, hex(0x70747a));
    }
  };

  // main straight stands
  {
    const i0 = Math.floor((L - 100) / track.sampleSpacing) % n;
    const pitStart = track.pitOff[i0] >= 0;
    const oppo = -track.pitSide as 1 | -1;
    grandstand(L - 110, oppo * (limitOf(i0, oppo) + 5), 110, ctx.quality === 'low' ? 4 : 6);
    const pl = pitStart ? d.pit.offsetM + 6 + 0.6 + 6 + 8 : limitOf(i0, track.pitSide) + 5;
    grandstand(L - 110, track.pitSide * pl, 110, ctx.quality === 'low' ? 4 : 7);
    if (ctx.quality !== 'low') grandstand(70, oppo * (limitOf(Math.floor(70 / track.sampleSpacing), oppo) + 5), 70, 5);
  }

  // corners: find tight corner apexes
  type Corner = { i: number; k: number };
  const corners: Corner[] = [];
  {
    const win = 30;
    for (let i = 0; i < n; i++) {
      const k = Math.abs(track.curv[i]);
      if (k < 1 / 140) continue;
      let isMax = true;
      for (let o = -win; o <= win && isMax; o++) if (Math.abs(track.curv[(i + o + n) % n]) > k) isMax = false;
      if (isMax) corners.push({ i, k });
    }
    // dedupe plateaus
    for (let a = corners.length - 1; a > 0; a--) if (corners[a].i - corners[a - 1].i < win) corners.splice(a, 1);
  }
  {
    const big = [...corners].sort((a, b) => b.k - a.k).slice(0, ctx.quality === 'low' ? 1 : 3);
    for (const c of big) {
      const side = -sgn(track.curv[c.i]) as 1 | -1; // outside of the corner
      const s = c.i * track.sampleSpacing;
      const pos = at(s, side * (limitOf(c.i, side) + 6));
      if (clear(pos.x, pos.z, 0)) grandstand(s, side * (limitOf(c.i, side) + 6), 45, 5);
    }
  }

  // brake boards (150/100/50 m before tight corners)
  {
    for (const c of corners) {
      if (c.k < 1 / 90) continue;
      let e = c.i;
      for (let o = 0; o < 150 && Math.abs(track.curv[(e + n - 1) % n]) > 1 / 500; o++) e = (e + n - 1) % n;
      const side = -sgn(track.curv[c.i]) as 1 | -1;
      for (let m = 1; m <= 3; m++) {
        const s = e * track.sampleSpacing - m * 50;
        const i = ((Math.floor(s / track.sampleSpacing) % n) + n) % n;
        const lat = side * Math.min(track.hw[i] + 2.6, limitOf(i, side) - 0.7);
        const p = at(s, lat);
        const y = p.f.position.y;
        boxes.add(p.x, y + 0.9, p.z, 0.12, 1.8, 0.12, p.yaw, hex(0x555555));
        boxes.add(p.x, y + 2.0, p.z, 1.3, 1.3, 0.1, p.yaw, hex(0xf0f0f0));
        boxes.add(p.x, y + 2.0, p.z, 1.0, 0.25 * m + 0.1, 0.12, p.yaw, hex(0xcc1111));
      }
    }
  }

  // buildings for street circuits
  if (ctx.street) {
    const spacing = 28 / Math.max(0.3, density);
    const pastel = [0xd8c8b0, 0xb0b8c0, 0xc8b0a0, 0xa8b8a8, 0xe0d8c8, 0x9aa0a8, 0xb8a090];
    for (let s = 0; s < L; s += spacing) {
      for (const side of [1, -1] as const) {
        const i = Math.floor(s / track.sampleSpacing) % n;
        const w = 10 + rnd() * 12, len = 18 + rnd() * 10, h = 10 + rnd() * 42;
        const lat = side * (limitOf(i, side) + 5 + w / 2 + rnd() * 6);
        const p = at(s, lat);
        if (!clear(p.x, p.z, w / 2 + 4)) continue;
        boxes.add(p.x, groundY(p.x, p.z) + h / 2, p.z, w, h, len, p.yaw, mul(hex(pastel[Math.floor(rnd() * pastel.length)]), 0.9 + rnd() * 0.15));
      }
    }
  }

  // ---------------------------------------------------------- landmarks
  for (const lm of d.landmarks ?? []) {
    const sc = lm.scale ?? 1;
    const s = lm.at * L;
    const lat = lm.offsetM;
    const p = at(s, lat);
    const gy = groundY(p.x, p.z);
    switch (lm.kind) {
      case 'grandstand':
        grandstand(s, lat, 50 * sc + 20, 5 + Math.round(sc));
        break;
      case 'tower': {
        const h = 40 * sc;
        boxes.add(p.x, gy + h / 2, p.z, 7, h, 7, p.yaw, hex(0xc9ccd2));
        boxes.add(p.x, gy + h + 3, p.z, 14, 6, 14, p.yaw, hex(0x3b4a5c));
        boxes.add(p.x, gy + h + 7, p.z, 4, 8, 4, p.yaw, hex(0xaaaaaa));
        break;
      }
      case 'bridge': {
        const i = Math.floor(s / track.sampleSpacing) % n;
        const reach = Math.max(limitOf(i, 1), limitOf(i, -1)) + 6;
        const y = p.f.position.y;
        const c = at(s, 0);
        boxes.add(c.x, y + 8 + 0.8, c.z, reach * 2, 1.6, 8, c.yaw, hex(0x8a8e96));
        for (const e of [-1, 1]) {
          const q = at(s, e * reach);
          boxes.add(q.x, y + 4.4, q.z, 2.4, 9, 6, q.yaw, hex(0x70747a));
        }
        break;
      }
      case 'building': {
        boxes.add(p.x, gy + 8 * sc, p.z, 20 * sc, 16 * sc, 26 * sc, p.yaw, hex(0xcdbfae));
        boxes.add(p.x, gy + 16 * sc + 0.5, p.z, 21 * sc, 1, 27 * sc, p.yaw, hex(0x8c5a44));
        break;
      }
      case 'hotel': {
        const h = 45 * sc;
        boxes.add(p.x, gy + h / 2, p.z, 18 * sc, h, 26 * sc, p.yaw, hex(0xd9d4c8));
        boxes.add(p.x, gy + h + 1, p.z, 19 * sc, 2, 27 * sc, p.yaw, hex(0x4a5560));
        for (let r = 1; r < 6; r++) boxes.add(p.x, gy + (h * r) / 6, p.z, 18.4 * sc, 1.2, 26.4 * sc, p.yaw, hex(0x6c8aa8));
        break;
      }
      case 'ferris': {
        const R = 22 * sc, hubY = gy + R + 3;
        const segs = 18;
        for (let k = 0; k < segs; k++) {
          const th = (k / segs) * Math.PI * 2;
          const fx = Math.cos(th) * R, fy = Math.sin(th) * R;
          const phi = Math.atan2(-Math.cos(th), -Math.sin(th));
          boxes.add(p.x + Math.sin(p.yaw) * fx, hubY + fy, p.z + Math.cos(p.yaw) * fx, 0.5, 0.5, ((2 * Math.PI * R) / segs) * 1.08, p.yaw, hex(0xe8e8e8), phi);
          if (k % 2 === 0) boxes.add(p.x + Math.sin(p.yaw) * fx, hubY + fy - 1.2, p.z + Math.cos(p.yaw) * fx, 1.8, 1.6, 1.8, p.yaw, hex(k % 4 === 0 ? 0xd03030 : 0x3050c8));
        }
        for (let k = 0; k < 4; k++) boxes.add(p.x, hubY, p.z, 0.3, 0.3, R * 2, p.yaw, hex(0xcfcfcf), (k / 4) * Math.PI);
        for (const e of [-3, 3]) boxes.add(p.x + Math.cos(p.yaw) * e, gy + (R + 3) / 2, p.z - Math.sin(p.yaw) * e, 0.7, R + 3, 0.7, p.yaw, hex(0x9a9ea6), e > 0 ? 0.25 : -0.25);
        break;
      }
      case 'trees': {
        const cnt = Math.round(24 * sc * density);
        for (let k = 0; k < cnt; k++) {
          const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 22 * sc;
          const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
          if (clear(x, z, 3)) addTree(x, z, 0.8 + rnd() * 0.9);
        }
        break;
      }
      case 'water': {
        boxes.add(p.x, gy + 0.05, p.z, 90 * sc, 0.5, 60 * sc, p.yaw, hex(0x2f6f9f));
        break;
      }
      case 'mountain': {
        const geo = new ConeGeometry(60 * sc, 70 * sc, 6, 1);
        for (let k = 0; k < 3; k++) {
          const m = new Matrix4().compose(
            new Vector3(p.x + (k - 1) * 70 * sc, gy + 35 * sc * (1 - k * 0.2), p.z + (k % 2) * 40 * sc),
            new Quaternion().setFromAxisAngle(UP, rnd() * 3),
            new Vector3(1 - k * 0.15, 1 - k * 0.2, 1 - k * 0.15),
          );
          boxes.addGeometry(geo, m, k === 0 ? hex(0x7a7468) : hex(0x6a665c));
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------- instanced: trees
  if (trees.length) {
    const trunkG = new CylinderGeometry(0.2, 0.3, 2, 5); trunkG.translate(0, 1, 0);
    const leafG = new ConeGeometry(2.2, 6.5, 6); leafG.translate(0, 2 + 3.25, 0);
    const trunk = new InstancedMesh(trunkG, new MeshStandardMaterial({ color: 0x5a3d26, flatShading: true }), trees.length);
    const leaf = new InstancedMesh(leafG, new MeshStandardMaterial({ color: 0xffffff, flatShading: true }), trees.length);
    const m = new Matrix4(), q = new Quaternion(), pos = new Vector3(), sc = new Vector3(), col = new Color();
    trees.forEach((t, i) => {
      q.setFromAxisAngle(UP, t.tone * 6.28);
      pos.set(t.x, t.y, t.z);
      sc.set(t.sc, t.sc * (0.9 + t.tone * 0.4), t.sc);
      m.compose(pos, q, sc);
      trunk.setMatrixAt(i, m);
      leaf.setMatrixAt(i, m);
      if (ctx.desert) col.setRGB(0.45 + t.tone * 0.1, 0.5 + t.tone * 0.1, 0.25);
      else col.setRGB(0.1 + t.tone * 0.08, 0.32 + t.tone * 0.18, 0.1 + t.tone * 0.05);
      leaf.setColorAt(i, col);
    });
    trunk.name = 'treeTrunks'; leaf.name = 'treeFoliage';
    trunk.castShadow = leaf.castShadow = ctx.quality !== 'low';
    instanced.push(trunk, leaf);
  }

  // ---------------------------------------------------------- instanced: marshal posts
  {
    const mats: Matrix4[] = [];
    const every = 300;
    let side: 1 | -1 = 1;
    for (let s = 120; s < L; s += every / Math.max(0.5, density)) {
      const i = Math.floor(s / track.sampleSpacing) % n;
      const p = at(s, side * (limitOf(i, side) + 1.6));
      side = -side as 1 | -1;
      if (!clear(p.x, p.z, 0.5)) continue;
      mats.push(new Matrix4().compose(new Vector3(p.x, groundY(p.x, p.z) + 1.1, p.z), new Quaternion().setFromAxisAngle(UP, p.yaw), new Vector3(1, 1, 1)));
    }
    if (mats.length) {
      const im = new InstancedMesh(new BoxGeometry(1.3, 2.2, 1.3), new MeshStandardMaterial({ color: 0xe86a10, flatShading: true }), mats.length);
      mats.forEach((m, i) => im.setMatrixAt(i, m));
      im.name = 'marshalPosts';
      instanced.push(im);
    }
  }

  // ---------------------------------------------------------- instanced: light posts (night)
  if (ctx.night) {
    const poles: Matrix4[] = [], heads: Matrix4[] = [];
    const every = 48 / Math.max(0.4, density);
    let side: 1 | -1 = 1;
    for (let s = 10; s < L; s += every) {
      const i = Math.floor(s / track.sampleSpacing) % n;
      const p = at(s, side * (limitOf(i, side) + 1.4));
      const toward = -side;
      side = -side as 1 | -1;
      if (!clear(p.x, p.z, 0.5)) continue;
      const gy = groundY(p.x, p.z);
      const q = new Quaternion().setFromAxisAngle(UP, p.yaw);
      poles.push(new Matrix4().compose(new Vector3(p.x, gy, p.z), q, new Vector3(1, 1, 1)));
      const lx = p.f.left.x * toward * 1.6, lz = p.f.left.z * toward * 1.6;
      heads.push(new Matrix4().compose(new Vector3(p.x + lx, gy + 12.2, p.z + lz), q, new Vector3(1, 1, 1)));
    }
    if (poles.length) {
      const pg = new CylinderGeometry(0.12, 0.2, 12, 5); pg.translate(0, 6, 0);
      const pi = new InstancedMesh(pg, new MeshStandardMaterial({ color: 0x4a4e55, flatShading: true }), poles.length);
      const hi = new InstancedMesh(new BoxGeometry(2.2, 0.3, 0.8), new MeshBasicMaterial({ color: 0xfff1c4 }), heads.length);
      poles.forEach((m, i) => pi.setMatrixAt(i, m));
      heads.forEach((m, i) => hi.setMatrixAt(i, m));
      pi.name = 'lightPosts'; hi.name = 'lightHeads';
      instanced.push(pi, hi);
    }
  }

  return { instanced, structureExtra: null };
}
