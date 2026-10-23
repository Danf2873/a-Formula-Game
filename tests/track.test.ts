import { describe, it, expect } from 'vitest';
// @ts-ignore node builtins (no @types/node installed)
import fs from 'node:fs';
// @ts-ignore
import { fileURLToPath } from 'node:url';
import { Track } from '../src/track/track';
import type { CircuitData } from '../src/types';
import { makeOval } from './fixtures/oval';
import { buildTrackScene, disposeTrackScene } from '../src/track/trackMesh';
import type { Group, InstancedMesh, Mesh } from 'three';

const DIR: string = fileURLToPath(new URL('../public/circuits/', import.meta.url));
const IDS: string[] = (fs.readdirSync(DIR) as string[]).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.replace('.json', ''));
const load = (id: string): CircuitData => JSON.parse(fs.readFileSync(DIR + id + '.json', 'utf8'));

function polyLen(d: CircuitData): number {
  let L = 0;
  const p = d.points;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    L += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return L;
}

describe('Track (oval fixture)', () => {
  const data = makeOval();
  const t = new Track(data);
  const HP = 600 + (Math.PI * 60) / 2; // middle of the first hairpin

  it('length ~ polyline length, spacing ~2 m', () => {
    expect(Math.abs(t.length - polyLen(data)) / polyLen(data)).toBeLessThan(0.01);
    expect(t.sampleSpacing).toBeGreaterThan(1.9);
    expect(t.sampleSpacing).toBeLessThan(2.1);
  });

  it('frameAt is continuous across the wrap', () => {
    const a = t.frameAt(t.length - 0.01), b = t.frameAt(0.01), c = t.frameAt(t.length + 0.01);
    expect(a.position.distanceTo(b.position)).toBeLessThan(0.1);
    expect(b.position.distanceTo(c.position)).toBeLessThan(1e-6);
    expect(a.tangent.dot(b.tangent)).toBeGreaterThan(0.999);
    expect(t.frameAt(-5).s).toBeCloseTo(t.length - 5, 6);
  });

  it('left vector, curvature sign (left turns +) and tangent', () => {
    const f = t.frameAt(100);
    expect(f.tangent.x).toBeGreaterThan(0.99);
    expect(f.left.z).toBeLessThan(-0.99); // left of +x is -z
    const arc = t.frameAt(HP);
    expect(arc.curvature).toBeGreaterThan(1 / 80);
    expect(arc.curvature).toBeLessThan(1 / 45);
  });

  it('project round-trips s and lateral', () => {
    const hint = { idx: -1 };
    for (const s of [10, 250, 700, 900, 1500, t.length - 1]) {
      for (const lat of [-6, -2, 0, 3, 7]) {
        const f = t.frameAt(s);
        const p = f.position.clone().addScaledVector(f.left, lat);
        const pr = t.project(p.x, p.z, hint);
        let ds = Math.abs(pr.s - f.s);
        ds = Math.min(ds, t.length - ds);
        expect(ds).toBeLessThan(0.5);
        expect(Math.abs(pr.lateral - lat)).toBeLessThan(0.05);
      }
    }
  });

  it('recovers from a stale hint', () => {
    const f = t.frameAt(1200);
    const hint = { idx: 5 };
    const pr = t.project(f.position.x, f.position.z, hint);
    expect(Math.abs(pr.s - 1200)).toBeLessThan(0.5);
    expect(hint.idx).toBe(pr.idx);
    const bad = { idx: -1 };
    expect(Math.abs(t.project(f.position.x, f.position.z, bad).s - 1200)).toBeLessThan(0.5);
  });

  it('sample: height, normal, surfaces', () => {
    const hint = { idx: -1 };
    const at = (s: number, lat: number) => {
      const f = t.frameAt(s);
      const p = f.position.clone().addScaledVector(f.left, lat);
      return { f, g: t.sample(p.x, p.z, hint) };
    };
    const a = at(300, 0);
    expect(a.g.surface).toBe('asphalt');
    expect(a.g.height).toBeCloseTo(a.f.position.y, 1);
    expect(a.g.normal.length()).toBeCloseTo(1, 5);
    expect(a.g.normal.y).toBeGreaterThan(0.9);
    expect(at(300, 3).g.height).toBeCloseTo(a.g.height, 1);
    expect(at(300, 8.5).g.surface).toBe('grass'); // straight: no kerb
    expect(at(HP, 7.5 + 0.6).g.surface).toBe('kerb');
    expect(at(HP, -(7.5 + 0.6)).g.surface).toBe('kerb');
    expect(at(HP, 7.5 + 3).g.surface).toBe('grass');
    const gs = t.length * 0.37; // right-side gravel zone, on the second straight
    expect(at(gs, -(7.5 + 5)).g.surface).toBe('gravel');
    expect(at(gs, -(7.5 + 16)).g.surface).toBe('wall');
  });

  it('barrier: null inside, push-out toward track beyond', () => {
    const hint = { idx: -1 };
    const f = t.frameAt(300);
    const mk = (lat: number) => f.position.clone().addScaledVector(f.left, lat);
    let p = mk(7.5 + 6);
    expect(t.barrier(p.x, p.z, 0.9, hint)).toBeNull();
    p = mk(7.5 + 12 + 0.5); // beyond the left barrier (12 m run-off)
    const b = t.barrier(p.x, p.z, 0.9, hint)!;
    expect(b).not.toBeNull();
    expect(b.depth).toBeCloseTo(0.5 + 0.9, 1);
    expect(b.nx * f.left.x + b.nz * f.left.z).toBeCloseTo(-1, 3);
    expect(Math.hypot(b.nx, b.nz)).toBeCloseTo(1, 5);
    p = mk(-(7.5 + 12 + 0.5));
    const b2 = t.barrier(p.x, p.z, 0.9, hint)!;
    expect(b2.nx * f.left.x + b2.nz * f.left.z).toBeCloseTo(1, 3);
  });

  it('pit lane is reachable and walled from the track in the middle', () => {
    const hint = { idx: -1 };
    const tm = t.pitLanePoint(0.5);
    expect(t.isInPitLane(tm.x, tm.z, hint)).toBe(true);
    expect(t.barrier(tm.x, tm.z, 0.9, hint)).toBeNull();
    const f = t.frameAt(t.pitStart + t.pitLen / 2);
    const w = f.position.clone().addScaledVector(f.left, -(f.halfWidth + 3));
    expect(t.barrier(w.x, w.z, 0.9, hint)).not.toBeNull(); // pit wall
    const o = f.position.clone().addScaledVector(f.left, -(17.5 + 6 + 0.5));
    expect(t.barrier(o.x, o.z, 0.9, hint)).not.toBeNull(); // beyond pit barrier
    expect(t.isInPitLane(f.position.x, f.position.z, hint)).toBe(false);
    expect(t.frameAt(t.pitStart).position.distanceTo(t.pitLanePoint(0))).toBeLessThan(0.01);
    expect(t.frameAt(t.pitStart + t.pitLen).position.distanceTo(t.pitLanePoint(1))).toBeLessThan(0.01);
    for (let k = 0; k < 11; k++) {
      const bx = t.pitBox(k);
      expect(t.isInPitLane(bx.position.x, bx.position.z, hint)).toBe(true);
      expect(bx.t).toBeGreaterThan(0);
      expect(bx.t).toBeLessThan(1);
    }
    const d = t.pitBox(1).position.distanceTo(t.pitBox(0).position);
    expect(d).toBeGreaterThan(11.9);
    expect(d).toBeLessThan(12.1);
  });

  it('racing line within width and cuts inside at a hairpin', () => {
    for (let s = 0; s < t.length; s += 7) {
      const f = t.frameAt(s);
      expect(Math.abs(t.racingLineOffset(s))).toBeLessThanOrEqual(f.halfWidth - 1.2 + 1e-6);
    }
    expect(t.racingLineOffset(HP)).toBeGreaterThan(2); // left-hand corner -> inside = left (+)
    expect(t.racingLineOffset(600 + Math.PI * 60 + 600 + (Math.PI * 60) / 2)).toBeGreaterThan(2);
  });

  it('grid slots are behind the s/f line with correct spacing', () => {
    const f0 = t.frameAt(0);
    const sOf = (p: number) => {
      const g = t.gridSlot(p);
      const pr = t.project(g.position.x, g.position.z, { idx: -1 });
      return { g, pr, back: t.length - pr.s };
    };
    const g0 = sOf(0), g1 = sOf(1), g2 = sOf(2);
    expect(g0.back).toBeCloseTo(8, 0);
    expect(g1.back - g0.back).toBeCloseTo(8, 0);
    expect(g2.back - g1.back).toBeCloseTo(8, 0);
    expect(g0.pr.lateral * g1.pr.lateral).toBeLessThan(0);
    expect(Math.abs(Math.abs(g0.pr.lateral) - 2.2)).toBeLessThan(0.05);
    const fr = t.frameAt(t.length - 8);
    expect(g0.g.heading).toBeCloseTo(Math.atan2(fr.tangent.x, fr.tangent.z), 1);
    expect(f0.s).toBe(0);
  });

  it('sectorOf and inAeroZone with wrap', () => {
    const L = t.length;
    expect(t.sectorOf(0)).toBe(0);
    expect(t.sectorOf(L * 0.5)).toBe(1);
    expect(t.sectorOf(L * 0.9)).toBe(2);
    expect(t.sectorOf(L + 1)).toBe(0);
    expect(t.inAeroZone(L * 0.95)).toBe(true);
    expect(t.inAeroZone(L * 0.05)).toBe(true); // wrapped zone 0.9 -> 0.1
    expect(t.inAeroZone(L * 0.2)).toBe(false);
    expect(t.inAeroZone(L * 0.55)).toBe(true);
    expect(t.inAeroZone(-L * 0.05)).toBe(true);
  });
});

describe('real circuits', () => {
  it('finds 24 circuits', () => expect(IDS.length).toBe(24));
  it.each(IDS)('%s builds finite data with plausible length', (id) => {
    const d = load(id);
    const t = new Track(d);
    expect(Math.abs(t.length - d.realLengthM) / d.realLengthM).toBeLessThan(0.015);
    const bad = (a: ArrayLike<number>) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return true; return false; };
    expect(bad(t.px) || bad(t.py) || bad(t.pz) || bad(t.tx) || bad(t.tz) || bad(t.lx) || bad(t.lz) || bad(t.curv) || bad(t.hw)).toBe(false);
    for (let k = 0; k < 11; k++) {
      const b = t.pitBox(k);
      expect(Number.isFinite(b.position.x + b.position.z + b.heading + b.t)).toBe(true);
    }
    expect(Number.isFinite(t.racingLineOffset(123))).toBe(true);
    const hint = { idx: -1 };
    for (const f of [0.1, 0.5, 0.9]) {
      const fr = t.frameAt(f * t.length);
      const p = fr.position.clone().addScaledVector(fr.left, 2);
      const pr = t.project(p.x, p.z, hint);
      expect(Math.abs(pr.s - fr.s)).toBeLessThan(1);
      expect(Math.abs(pr.lateral - 2)).toBeLessThan(0.3);
    }
    expect(t.pitLen).toBeGreaterThan(11 * 12 + 40);
  });
});

describe('buildTrackScene (Node smoke test)', () => {
  const stats = (g: Group) => {
    let calls = 0, tris = 0, bad = false;
    g.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      calls++;
      const geo = m.geometry;
      const pos = geo.getAttribute('position');
      const count = (geo.index ? geo.index.count : pos.count) / 3;
      tris += count * ((o as InstancedMesh).isInstancedMesh ? (o as InstancedMesh).count : 1);
      for (let i = 0; i < pos.array.length; i += 97) if (!Number.isFinite(pos.array[i])) bad = true;
    });
    return { calls, tris, bad };
  };

  it('monza at high stays within draw call and triangle budgets', () => {
    const g = buildTrackScene(new Track(load('monza')), { quality: 'high' });
    const s = stats(g);
    console.log('monza high', s);
    expect(s.bad).toBe(false);
    expect(s.calls).toBeLessThan(300);
    expect(s.tris).toBeGreaterThan(20000);
    expect(s.tris).toBeLessThan(600000);
    expect(g.userData.startLights.length).toBe(5);
    disposeTrackScene(g);
    expect(g.children.length).toBe(0);
  });

  it('low quality is lighter than high', () => {
    const t = new Track(load('spa'));
    const hi = stats(buildTrackScene(t, { quality: 'high' }));
    const lo = stats(buildTrackScene(t, { quality: 'low' }));
    expect(lo.tris).toBeLessThan(hi.tris);
  });

  it.each(['monaco', 'singapore', 'jeddah'])('%s (street / night / desert) builds', (id) => {
    const s = stats(buildTrackScene(new Track(load(id)), { quality: 'medium' }));
    console.log(id, s);
    expect(s.bad).toBe(false);
    expect(s.calls).toBeLessThan(300);
    expect(s.tris).toBeLessThan(600000);
  });
});
