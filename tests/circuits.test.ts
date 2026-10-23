import { describe, it, expect } from 'vitest';
// @ts-ignore node builtins (no @types/node installed)
import fs from 'node:fs';
// @ts-ignore
import { fileURLToPath } from 'node:url';
import type { CircuitData, CircuitIndexEntry } from '../src/types';

const DIR: string = fileURLToPath(new URL('../public/circuits/', import.meta.url));

const ORDER = ['melbourne', 'shanghai', 'suzuka', 'bahrain', 'jeddah', 'miami', 'montreal', 'monaco', 'barcelona', 'spielberg', 'silverstone', 'spa', 'hungaroring', 'zandvoort', 'monza', 'madrid', 'baku', 'singapore', 'austin', 'mexico', 'interlagos', 'lasvegas', 'lusail', 'abudhabi'];

const load = (id: string): CircuitData => JSON.parse(fs.readFileSync(DIR + id + '.json', 'utf8'));
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isFrac = (v: unknown) => isNum(v) && (v as number) >= 0 && (v as number) <= 1;
const RO = ['grass', 'gravel', 'asphalt', 'wall'];
const LM = ['grandstand', 'tower', 'bridge', 'building', 'ferris', 'hotel', 'trees', 'water', 'mountain'];

describe('index.json', () => {
  it('has 24 entries in calendar order', () => {
    const idx: CircuitIndexEntry[] = JSON.parse(fs.readFileSync(DIR + 'index.json', 'utf8'));
    expect(idx.map((e) => e.id)).toEqual(ORDER);
    idx.forEach((e, i) => {
      expect(e.round).toBe(i + 1);
      for (const k of ['name', 'grandPrix', 'country'] as const) expect(typeof e[k]).toBe('string');
      expect(load(e.id).realLengthM).toBe(e.realLengthM);
    });
  });
});

describe.each(ORDER)('circuit %s', (id) => {
  const c = load(id);
  const P = c.points;
  const n = P.length;
  const seg = (i: number) => {
    const a = P[i], b = P[(i + 1) % n];
    return Math.hypot(b[0] - a[0], b[2] - a[2]);
  };

  it('matches the schema', () => {
    expect(c.id).toBe(id);
    for (const k of ['name', 'grandPrix', 'country', 'city'] as const) expect(typeof c[k]).toBe('string');
    for (const k of ['realLengthM', 'raceLaps', 'halfWidth', 'gridSpacingM', 'raceTimeOfDay'] as const) expect(isNum(c[k])).toBe(true);
    expect(c.halfWidth).toBeGreaterThanOrEqual(4);
    expect(c.halfWidth).toBeLessThanOrEqual(8);
    expect(typeof c.street).toBe('boolean');
    for (const z of c.widthZones) expect(isFrac(z.from) && isFrac(z.to) && isNum(z.halfWidth)).toBe(true);
    for (const r of c.runoff) {
      expect(isFrac(r.from) && isFrac(r.to) && isNum(r.widthM)).toBe(true);
      expect(['left', 'right', 'both']).toContain(r.side);
      expect(RO).toContain(r.type);
    }
    expect(RO).toContain(c.defaultRunoff.type);
    expect(isNum(c.defaultRunoff.widthM)).toBe(true);
    expect(c.sectors).toHaveLength(2);
    expect(c.sectors[0]).toBeGreaterThan(0);
    expect(c.sectors[1]).toBeGreaterThan(c.sectors[0]);
    expect(c.sectors[1]).toBeLessThan(1);
    expect(c.aeroZones.length).toBeGreaterThanOrEqual(2);
    for (const z of c.aeroZones) expect(isFrac(z.from) && isFrac(z.to)).toBe(true);
    expect(['left', 'right']).toContain(c.pit.side);
    expect(isFrac(c.pit.entry) && isFrac(c.pit.exit) && isNum(c.pit.offsetM)).toBe(true);
    expect(c.pit.speedLimitKmh).toBe(id === 'monaco' ? 60 : 80);
    expect(isNum(c.climate.rainChance) && isNum(c.climate.airTempC)).toBe(true);
    expect(c.climate.rainChance).toBeGreaterThanOrEqual(0);
    expect(c.climate.rainChance).toBeLessThanOrEqual(1);
    expect(c.latLon).toHaveLength(2);
    expect(c.latLon.every(isNum)).toBe(true);
    expect(c.landmarks.length).toBeGreaterThanOrEqual(5);
    expect(c.landmarks.length).toBeLessThanOrEqual(15);
    for (const l of c.landmarks) {
      expect(LM).toContain(l.kind);
      expect(isFrac(l.at) && isNum(l.offsetM)).toBe(true);
      if (l.scale !== undefined) expect(isNum(l.scale)).toBe(true);
    }
  });

  it('has a clean closed centreline', () => {
    expect(n).toBeGreaterThanOrEqual(400);
    for (const p of P) {
      expect(p).toHaveLength(3);
      expect(p.every(isNum)).toBe(true);
    }
    expect(seg(n - 1)).toBeLessThan(10);
    let L = 0;
    for (let i = 0; i < n; i++) L += seg(i);
    expect(Math.abs(L - c.realLengthM) / c.realLengthM).toBeLessThan(0.01);
  });

  it('has 3-8 m spacing', () => {
    for (let i = 0; i < n; i++) {
      const d = seg(i);
      expect(d).toBeGreaterThanOrEqual(3);
      expect(d).toBeLessThanOrEqual(8);
    }
  });

  it('has no radius below 8 m', () => {
    let minR = Infinity;
    for (let i = 0; i < n; i++) {
      const a = P[(i + n - 1) % n], b = P[i], d = P[(i + 1) % n];
      const ab = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const bc = Math.hypot(d[0] - b[0], d[2] - b[2]);
      const ca = Math.hypot(a[0] - d[0], a[2] - d[2]);
      const cr = Math.abs((b[0] - a[0]) * (d[2] - b[2]) - (b[2] - a[2]) * (d[0] - b[0]));
      if (cr > 1e-9) minR = Math.min(minR, (ab * bc * ca) / (2 * cr));
    }
    expect(minR).toBeGreaterThanOrEqual(8);
  });

  it('has slopes <= 20%', () => {
    for (let i = 0; i < n; i++) {
      const b = P[(i + 1) % n];
      expect(Math.abs(b[1] - P[i][1]) / seg(i)).toBeLessThanOrEqual(0.2);
    }
  });
});

describe('suzuka crossover', () => {
  it('has >= 6 m vertical separation where the track crosses itself', () => {
    const P = load('suzuka').points;
    const n = P.length;
    let found = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 3; j < n; j++) {
        if (i === 0 && j >= n - 2) continue;
        const a = P[i], b = P[(i + 1) % n], c = P[j], d = P[(j + 1) % n];
        const rx = b[0] - a[0], rz = b[2] - a[2], sx = d[0] - c[0], sz = d[2] - c[2];
        const den = rx * sz - rz * sx;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((c[0] - a[0]) * sz - (c[2] - a[2]) * sx) / den;
        const u = ((c[0] - a[0]) * rz - (c[2] - a[2]) * rx) / den;
        if (t >= 0 && t < 1 && u >= 0 && u < 1) {
          found++;
          const y1 = a[1] + (b[1] - a[1]) * t, y2 = c[1] + (d[1] - c[1]) * u;
          expect(Math.abs(y1 - y2)).toBeGreaterThanOrEqual(6);
        }
      }
    }
    expect(found).toBeGreaterThanOrEqual(1);
  });
});
