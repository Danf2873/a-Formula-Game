// Track runtime: uniform ~2 m resampled centreline, frames, projection, ground/barrier queries,
// racing line, pit lane and grid. Node-safe (three math only).

import { CatmullRomCurve3, Vector3 } from 'three';
import type {
  CircuitData, CircuitIndexEntry, GroundSample, ITrack, SurfaceType, TrackFrame, TrackProjection,
} from '../types';

const KERB_WIDTH = 1.2;
const KERB_CURV = 1 / 250;
const PIT_HALF = 3.5;        // half width of the pit lane surface
const PIT_WALL_GAP = 3;      // pit wall sits this far beyond the track edge
const PIT_WALL_THICK = 0.3;  // half thickness of the pit wall for collision
const PIT_BLEND = 80;        // m, blend from track to pit lane offset
const PIT_WALL_TRIM = 60;    // m, wall starts/ends this far from entry/exit
const LOCAL_WINDOW = 40;     // samples
const GLOBAL_DIST = 30;      // m

type RoType = 0 | 1 | 2 | 3; // grass gravel asphalt wall
const RO_ID: Record<string, RoType> = { grass: 0, gravel: 1, asphalt: 2, wall: 3 };

const smooth01 = (x: number) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };
const mod = (a: number, n: number) => ((a % n) + n) % n;

function inFracZone(f: number, from: number, to: number): boolean {
  if (from <= to) return f >= from && f < to;
  return f >= from || f < to;
}

export class Track implements ITrack {
  readonly data: CircuitData;
  readonly length: number;
  readonly sampleSpacing: number;
  readonly sampleCount: number;

  // per-sample arrays
  readonly px: Float64Array; readonly py: Float64Array; readonly pz: Float64Array;
  readonly tx: Float64Array; readonly ty: Float64Array; readonly tz: Float64Array;
  readonly lx: Float64Array; readonly lz: Float64Array;
  readonly hw: Float64Array;
  readonly curv: Float64Array;
  /** run-off per side: [0] left, [1] right */
  readonly roType: [Uint8Array, Uint8Array];
  readonly roWidth: [Float32Array, Float32Array];
  /** pit lane lateral offset magnitude at sample (>= 0 inside the pit range, -1 outside) */
  readonly pitOff: Float32Array;
  readonly pitWall: Uint8Array;
  private readonly rline: Float64Array;

  // pit params
  readonly pitSide: 1 | -1;
  readonly pitStart: number;   // s of entry
  readonly pitLen: number;     // path length from entry to exit

  // scratch results of locate()
  private _u = 0; private _lat = 0; private _idx = 0;

  constructor(data: CircuitData) {
    this.data = data;
    const pts = data.points;
    if (!pts || pts.length < 4) throw new Error('Track needs at least 4 points');

    // ---- resample with centripetal Catmull-Rom
    const curve = new CatmullRomCurve3(pts.map((p) => new Vector3(p[0], p[1], p[2])), true, 'centripetal');
    const K = 8;
    const M = pts.length * K;
    const dx = new Float64Array(M + 1), dy = new Float64Array(M + 1), dz = new Float64Array(M + 1), cum = new Float64Array(M + 1);
    const tmp = new Vector3();
    for (let i = 0; i <= M; i++) {
      curve.getPoint((i % M) / M, tmp);
      dx[i] = tmp.x; dy[i] = tmp.y; dz[i] = tmp.z;
      if (i > 0) cum[i] = cum[i - 1] + Math.hypot(dx[i] - dx[i - 1], dy[i] - dy[i - 1], dz[i] - dz[i - 1]);
    }
    const total = cum[M];
    const n = Math.max(16, Math.round(total / 2));
    const spacing = total / n;
    this.sampleCount = n;
    this.sampleSpacing = spacing;
    this.length = total;

    const px = (this.px = new Float64Array(n)), py = (this.py = new Float64Array(n)), pz = (this.pz = new Float64Array(n));
    let k = 0;
    for (let j = 0; j < n; j++) {
      const target = j * spacing;
      while (k < M - 1 && cum[k + 1] < target) k++;
      const seg = cum[k + 1] - cum[k];
      const f = seg > 1e-9 ? (target - cum[k]) / seg : 0;
      px[j] = dx[k] + (dx[k + 1] - dx[k]) * f;
      py[j] = dy[k] + (dy[k + 1] - dy[k]) * f;
      pz[j] = dz[k] + (dz[k + 1] - dz[k]) * f;
    }

    // ---- tangents, lefts
    const tx = (this.tx = new Float64Array(n)), ty = (this.ty = new Float64Array(n)), tz = (this.tz = new Float64Array(n));
    const lx = (this.lx = new Float64Array(n)), lz = (this.lz = new Float64Array(n));
    for (let i = 0; i < n; i++) {
      const a = (i + n - 1) % n, b = (i + 1) % n;
      let ax = px[b] - px[a], ay = py[b] - py[a], az = pz[b] - pz[a];
      const l = Math.hypot(ax, ay, az) || 1;
      ax /= l; ay /= l; az /= l;
      tx[i] = ax; ty[i] = ay; tz[i] = az;
      const h = Math.hypot(ax, az) || 1;
      lx[i] = az / h; lz[i] = -ax / h;
    }

    // ---- curvature (+ left), smoothed +-3 samples
    const rawC = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i + n - 1) % n, b = (i + 1) % n;
      const ddx = (tx[b] - tx[a]) / (2 * spacing), ddz = (tz[b] - tz[a]) / (2 * spacing);
      const h = Math.hypot(tx[i], tz[i]) || 1;
      rawC[i] = (ddx * lx[i] + ddz * lz[i]) / h;
    }
    const curv = (this.curv = new Float64Array(n));
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let o = -3; o <= 3; o++) s += rawC[(i + o + n) % n];
      curv[i] = s / 7;
    }

    // ---- half width with ~30 m blend
    const rawW = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const f = i / n;
      let w = data.halfWidth;
      for (const z of data.widthZones ?? []) if (inFracZone(f, z.from, z.to)) w = z.halfWidth;
      rawW[i] = w;
    }
    const hw = (this.hw = new Float64Array(n));
    const hwR = Math.max(1, Math.round(15 / spacing));
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let o = -hwR; o <= hwR; o++) s += rawW[(i + o + n) % n];
      hw[i] = s / (2 * hwR + 1);
    }

    // ---- run-off per side
    this.roType = [new Uint8Array(n), new Uint8Array(n)];
    this.roWidth = [new Float32Array(n), new Float32Array(n)];
    const def = data.defaultRunoff ?? { type: 'grass', widthM: 12 };
    for (let i = 0; i < n; i++) {
      const f = i / n;
      for (let side = 0; side < 2; side++) {
        let type = def.type, width = def.widthM;
        for (const r of data.runoff ?? []) {
          if (r.side !== 'both' && r.side !== (side === 0 ? 'left' : 'right')) continue;
          if (inFracZone(f, r.from, r.to)) { type = r.type; width = r.widthM; break; }
        }
        this.roType[side][i] = RO_ID[type] ?? 0;
        this.roWidth[side][i] = width;
      }
    }

    // ---- pit lane
    this.pitSide = data.pit.side === 'left' ? 1 : -1;
    this.pitStart = mod(data.pit.entry, 1) * total;
    let pe = mod(data.pit.exit, 1) - mod(data.pit.entry, 1);
    if (pe <= 0) pe += 1;
    this.pitLen = pe * total;
    this.pitOff = new Float32Array(n).fill(-1);
    this.pitWall = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const d = mod(i * spacing - this.pitStart, total);
      if (d <= this.pitLen) {
        this.pitOff[i] = this.pitOffsetAt(d);
        if (d >= PIT_WALL_TRIM && d <= this.pitLen - PIT_WALL_TRIM) this.pitWall[i] = 1;
      }
    }

    // ---- racing line
    this.rline = this.computeRacingLine();
  }

  // ------------------------------------------------------------ static loaders

  static async load(id: string, baseUrl?: string): Promise<Track> {
    const base = baseUrl ?? (import.meta as any).env?.BASE_URL ?? './';
    const res = await fetch(`${base}circuits/${id}.json`);
    if (!res.ok) throw new Error(`Failed to load circuit ${id}: ${res.status}`);
    return new Track((await res.json()) as CircuitData);
  }

  // ------------------------------------------------------------ interpolation

  /** Continuous sample index u in [0, n). */
  private sToU(s: number): number { return mod(s, this.length) / this.sampleSpacing; }

  frameAt(s: number): TrackFrame {
    const u = this.sToU(s);
    const n = this.sampleCount;
    const i0 = Math.floor(u) % n, i1 = (i0 + 1) % n, f = u - Math.floor(u);
    const lerp = (a: Float64Array) => a[i0] + (a[i1] - a[i0]) * f;
    const position = new Vector3(lerp(this.px), lerp(this.py), lerp(this.pz));
    const tangent = new Vector3(lerp(this.tx), lerp(this.ty), lerp(this.tz)).normalize();
    const left = new Vector3(lerp(this.lx), 0, lerp(this.lz));
    const ll = left.length() || 1;
    left.divideScalar(ll);
    return {
      s: mod(s, this.length), position, tangent, left,
      halfWidth: lerp(this.hw), curvature: lerp(this.curv),
    };
  }

  private heightAt(u: number): number {
    const n = this.sampleCount;
    const i0 = Math.floor(u) % n, i1 = (i0 + 1) % n, f = u - Math.floor(u);
    return this.py[i0] + (this.py[i1] - this.py[i0]) * f;
  }

  private hwAt(u: number): number {
    const n = this.sampleCount;
    const i0 = Math.floor(u) % n, i1 = (i0 + 1) % n, f = u - Math.floor(u);
    return this.hw[i0] + (this.hw[i1] - this.hw[i0]) * f;
  }

  // ------------------------------------------------------------ projection

  /** Finds continuous index u and lateral for (x,z); stores in _u/_lat/_idx. */
  private locate(x: number, z: number, hint: { idx: number }): void {
    const n = this.sampleCount;
    let i0 = hint.idx;
    let best = Infinity, bi = 0, bt = 0;
    const px = this.px, pz = this.pz;
    const scan = (from: number, count: number) => {
      for (let c = 0; c < count; c++) {
        const i = (from + c) % n, j = (i + 1) % n;
        const ax = px[i], az = pz[i];
        const sx = px[j] - ax, sz = pz[j] - az;
        const l2 = sx * sx + sz * sz;
        let t = l2 > 1e-12 ? ((x - ax) * sx + (z - az) * sz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + sx * t - x, ez = az + sz * t - z;
        const d = ex * ex + ez * ez;
        if (d < best) { best = d; bi = i; bt = t; }
      }
    };
    if (!Number.isFinite(i0) || i0 < 0 || i0 >= n) {
      scan(0, n);
    } else {
      i0 = Math.floor(i0);
      scan(mod(i0 - LOCAL_WINDOW, n), Math.min(n, 2 * LOCAL_WINDOW + 1));
      if (best > GLOBAL_DIST * GLOBAL_DIST) { best = Infinity; scan(0, n); }
    }
    // refine so that the foot point is perpendicular to the interpolated tangent
    let u = bi + bt;
    for (let it = 0; it < 3; it++) {
      const uu = mod(u, n);
      const a = Math.floor(uu) % n, b = (a + 1) % n, f = uu - Math.floor(uu);
      const cx = px[a] + (px[b] - px[a]) * f, cz = pz[a] + (pz[b] - pz[a]) * f;
      let tX = this.tx[a] + (this.tx[b] - this.tx[a]) * f, tZ = this.tz[a] + (this.tz[b] - this.tz[a]) * f;
      const tl = Math.hypot(tX, tZ) || 1; tX /= tl; tZ /= tl;
      const along = (x - cx) * tX + (z - cz) * tZ;
      u += along / this.sampleSpacing;
      if (Math.abs(along) < 1e-4) break;
    }
    u = mod(u, n);
    const a = Math.floor(u) % n, b = (a + 1) % n, f = u - Math.floor(u);
    const cx = px[a] + (px[b] - px[a]) * f, cz = pz[a] + (pz[b] - pz[a]) * f;
    let lX = this.lx[a] + (this.lx[b] - this.lx[a]) * f, lZ = this.lz[a] + (this.lz[b] - this.lz[a]) * f;
    const ll = Math.hypot(lX, lZ) || 1; lX /= ll; lZ /= ll;
    this._u = u;
    this._lat = (x - cx) * lX + (z - cz) * lZ;
    this._idx = Math.round(u) % n;
    hint.idx = this._idx;
  }

  project(x: number, z: number, hint: { idx: number }): TrackProjection {
    this.locate(x, z, hint);
    const u = this._u, lat = this._lat, i = this._idx;
    const hw = this.hwAt(u);
    return {
      s: u * this.sampleSpacing, lateral: lat, idx: i,
      onTrack: Math.abs(lat) <= hw + 0.2,
      surface: this.surfaceAt(i, lat, hw),
    };
  }

  // ------------------------------------------------------------ pit geometry

  /** Lateral offset magnitude of the pit lane centre at path distance d from the entry. */
  pitOffsetAt(d: number): number {
    const o = this.data.pit.offsetM;
    return o * smooth01(d / PIT_BLEND) * smooth01((this.pitLen - d) / PIT_BLEND);
  }

  /** Barrier distance from the centreline on a given side (+1 left, -1 right) at sample i. */
  sideLimit(i: number, side: 1 | -1): number {
    const si = side > 0 ? 0 : 1;
    let lim = this.hw[i] + this.roWidth[si][i];
    if (side === this.pitSide && this.pitOff[i] >= 0) {
      const b = this.pitOff[i] / this.data.pit.offsetM;
      lim = lim * (1 - b) + (this.data.pit.offsetM + 6) * b;
    }
    return lim;
  }

  private inPitBand(i: number, lat: number, hw: number, margin = 0): boolean {
    const off = this.pitOff[i];
    if (off < 0) return false;
    const l = lat * this.pitSide;
    if (l <= hw) return false;
    return l >= off - PIT_HALF - margin && l <= off + PIT_HALF + margin;
  }

  private surfaceAt(i: number, lat: number, hw: number): SurfaceType {
    const a = Math.abs(lat);
    if (this.pitOff[i] >= 0) {
      if (this.inPitBand(i, lat, hw, 0.5)) return 'pitlane';
    }
    if (a <= hw) return 'asphalt';
    const e = a - hw;
    if (e <= KERB_WIDTH && Math.abs(this.curv[i]) > KERB_CURV) return 'kerb';
    const si = lat >= 0 ? 0 : 1;
    if (a > this.sideLimit(i, lat >= 0 ? 1 : -1)) return 'wall';
    const t = this.roType[si][i];
    if (t === 1) return 'gravel';
    if (t === 2 || t === 3) return 'asphalt';
    return 'grass';
  }

  isInPitLane(x: number, z: number, hint: { idx: number }): boolean {
    this.locate(x, z, hint);
    const i = this._idx;
    if (this.pitOff[i] < 0) return false;
    return this.inPitBand(i, this._lat, this.hwAt(this._u), 0.5);
  }

  pitLanePoint(t: number): Vector3 {
    const tt = Math.min(1, Math.max(0, t));
    const d = tt * this.pitLen;
    const f = this.frameAt(this.pitStart + d);
    return f.position.addScaledVector(f.left, this.pitSide * this.pitOffsetAt(d));
  }

  pitBox(k: number): { position: Vector3; heading: number; t: number } {
    const spacing = 12;
    const mid = this.pitLen / 2;
    let d = mid + (k - 5) * spacing;
    d = Math.min(this.pitLen - 1, Math.max(1, d));
    const f = this.frameAt(this.pitStart + d);
    const off = this.pitOffsetAt(d) + 2; // park on the garage side of the lane
    const position = f.position.clone().addScaledVector(f.left, this.pitSide * off);
    return { position, heading: Math.atan2(f.tangent.x, f.tangent.z), t: d / this.pitLen };
  }

  // ------------------------------------------------------------ grid

  gridSlot(p: number): { position: Vector3; heading: number } {
    const g = this.data.gridSpacingM;
    const s = this.length - g * (p + 1);
    const f = this.frameAt(s);
    const lat = p % 2 === 0 ? 2.2 : -2.2;
    const position = f.position.clone().addScaledVector(f.left, lat);
    return { position, heading: Math.atan2(f.tangent.x, f.tangent.z) };
  }

  // ------------------------------------------------------------ sectors & aero

  sectorOf(s: number): 0 | 1 | 2 {
    const f = mod(s, this.length) / this.length;
    if (f < this.data.sectors[0]) return 0;
    if (f < this.data.sectors[1]) return 1;
    return 2;
  }

  inAeroZone(s: number): boolean {
    const f = mod(s, this.length) / this.length;
    for (const z of this.data.aeroZones ?? []) if (inFracZone(f, z.from, z.to) || (z.to >= 1 && f >= z.from)) return true;
    return false;
  }

  // ------------------------------------------------------------ racing line

  racingLineOffset(s: number): number {
    const u = this.sToU(s);
    const n = this.sampleCount;
    const i0 = Math.floor(u) % n, i1 = (i0 + 1) % n, f = u - Math.floor(u);
    return this.rline[i0] + (this.rline[i1] - this.rline[i0]) * f;
  }

  private computeRacingLine(): Float64Array {
    const n = this.sampleCount;
    const stride = 4;
    const m = Math.floor(n / stride);
    const idx = new Int32Array(m);
    for (let j = 0; j < m; j++) idx[j] = Math.floor((j * n) / m);
    const off = new Float64Array(m);
    const lim = new Float64Array(m);
    for (let j = 0; j < m; j++) lim[j] = Math.max(0, this.hw[idx[j]] - KERB_WIDTH);
    for (let it = 0; it < 200; it++) {
      for (let j = 0; j < m; j++) {
        const a = (j + m - 1) % m, b = (j + 1) % m;
        const ia = idx[a], ib = idx[b], ij = idx[j];
        const ax = this.px[ia] + this.lx[ia] * off[a], az = this.pz[ia] + this.lz[ia] * off[a];
        const bx = this.px[ib] + this.lx[ib] * off[b], bz = this.pz[ib] + this.lz[ib] * off[b];
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        let o = (mx - this.px[ij]) * this.lx[ij] + (mz - this.pz[ij]) * this.lz[ij];
        if (o > lim[j]) o = lim[j]; else if (o < -lim[j]) o = -lim[j];
        off[j] = o;
      }
    }
    const out = new Float64Array(n);
    for (let j = 0; j < m; j++) {
      const i0 = idx[j], i1 = j + 1 < m ? idx[j + 1] : idx[0] + n;
      for (let i = i0; i < i1; i++) {
        const f = (i - i0) / (i1 - i0);
        const lm = Math.max(0, this.hw[i % n] - KERB_WIDTH);
        out[i % n] = Math.max(-lm, Math.min(lm, off[j] + (off[(j + 1) % m] - off[j]) * f));
      }
    }
    return out;
  }

  // ------------------------------------------------------------ GroundQuery

  sample(x: number, z: number, hint: { idx: number }): GroundSample {
    this.locate(x, z, hint);
    const u = this._u, i = this._idx;
    const hw = this.hwAt(u);
    const surface = this.surfaceAt(i, this._lat, hw);
    const n = this.sampleCount;
    const a = Math.floor(u) % n, b = (a + 1) % n;
    const slope = (this.py[b] - this.py[a]) / this.sampleSpacing; // dy/ds (approx dy per horizontal m)
    const th = Math.hypot(this.tx[i], this.tz[i]) || 1;
    const normal = new Vector3(-slope * this.tx[i] / th, 1, -slope * this.tz[i] / th).normalize();
    return { height: this.heightAt(u), normal, surface };
  }

  barrier(x: number, z: number, radius: number, hint: { idx: number }): { nx: number; nz: number; depth: number } | null {
    this.locate(x, z, hint);
    const i = this._idx, lat = this._lat;
    const n = this.sampleCount;
    const a = Math.floor(this._u) % n, b = (a + 1) % n, f = this._u - Math.floor(this._u);
    let lX = this.lx[a] + (this.lx[b] - this.lx[a]) * f, lZ = this.lz[a] + (this.lz[b] - this.lz[a]) * f;
    const ll = Math.hypot(lX, lZ) || 1; lX /= ll; lZ /= ll;
    const hw = this.hwAt(this._u);

    if (this.pitWall[i]) {
      const W = this.pitSide * (hw + PIT_WALL_GAP);
      const dist = lat - W;
      const pen = radius + PIT_WALL_THICK - Math.abs(dist);
      if (pen > 0) {
        const sg = dist >= 0 ? 1 : -1;
        return { nx: sg * lX, nz: sg * lZ, depth: pen };
      }
    }
    const side: 1 | -1 = lat >= 0 ? 1 : -1;
    const depth = Math.abs(lat) + radius - this.sideLimit(i, side);
    if (depth > 0) return { nx: -side * lX, nz: -side * lZ, depth };
    return null;
  }
}

export async function loadCircuitIndex(baseUrl?: string): Promise<CircuitIndexEntry[]> {
  const base = baseUrl ?? (import.meta as any).env?.BASE_URL ?? './';
  const res = await fetch(`${base}circuits/index.json`);
  if (!res.ok) throw new Error(`Failed to load circuit index: ${res.status}`);
  return (await res.json()) as CircuitIndexEntry[];
}
