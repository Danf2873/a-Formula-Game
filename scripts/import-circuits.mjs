// Circuit importer: scripts/f1-circuits.geojson (bacinger/f1-circuits, MIT) -> public/circuits/*.json
//
// Coordinate choice: equirectangular projection around the circuit centroid.
//   x = east, z = -north (so z points SOUTH). With +Y up this is a right-handed system and the map is NOT
//   mirrored: seen from above (+Y looking down) with x to the right, north is up-screen.
// Internally all geometry is processed in (x, n=north) and converted to z=-n on output.
// In (x,n) a positive signed area = anticlockwise on the map = left turns.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'circuits');
const R_DEG = (6371008.8 * Math.PI) / 180; // metres per degree

// ------------------------------------------------------------------ per-track data
// dir: expected racing direction on the map ('cw' | 'ccw'). Geometry is flipped when the GeoJSON disagrees.
//   Anticlockwise in 2026: interlagos, austin, baku, singapore, jeddah, abudhabi, lasvegas, miami. Rest clockwise.
// el: elevation keypoints [lapFraction, metres], first at 0, last at 1 (equal values), cosine-interpolated.
// ru: [type, widthM] for auto-generated outside-of-corner run-off (non-street only).
const SP = 'Spanish Grand Prix';
const T = [
  { id: 'melbourne', gj: 'au-1953', name: 'Albert Park Circuit', gp: 'Australian Grand Prix', country: 'Australia', city: 'Melbourne', laps: 58, len: 5278, hw: 6.5, dir: 'cw', street: false, ru: ['gravel', 12], air: 22, rain: 0.25, tod: 15,
    el: [[0, 0], [0.25, 1.5], [0.5, 2.5], [0.75, 1], [1, 0]],
    lm: [['water', 0.5, 140, 3], ['building', 0.8, 170, 3], ['trees', 0.3, 60], ['trees', 0.65, 70]] },
  { id: 'shanghai', gj: 'cn-2004', name: 'Shanghai International Circuit', gp: 'Chinese Grand Prix', country: 'China', city: 'Shanghai', laps: 56, len: 5451, hw: 7.5, dir: 'cw', street: false, ru: ['asphalt', 20], air: 18, rain: 0.3, tod: 15,
    el: [[0, 0], [0.3, -1.5], [0.6, 1], [1, 0]],
    lm: [['building', 0.01, 110, 4], ['tower', 0.4, 90, 2], ['building', 0.7, 140, 2], ['trees', 0.5, 60]] },
  { id: 'suzuka', gj: 'jp-1962', name: 'Suzuka International Racing Course', gp: 'Japanese Grand Prix', country: 'Japan', city: 'Suzuka', laps: 53, len: 5807, hw: 6.5, dir: 'cw', street: false, ru: ['gravel', 15], air: 17, rain: 0.3, tod: 14,
    el: [[0, 0], [0.05, -8], [0.12, 4], [0.2, 14], [0.28, 8], [0.36, -4], [0.42, -12], [0.5, -8], [0.58, -14], [0.66, -6], [0.74, 10], [0.8, 18], [0.86, 16], [0.93, 6], [1, 0]],
    lm: [['ferris', 0.72, 130, 2], ['mountain', 0.5, 450, 3], ['trees', 0.2, 50], ['trees', 0.6, 50], ['trees', 0.85, 50]] },
  { id: 'bahrain', gj: 'bh-2002', name: 'Bahrain International Circuit', gp: 'Bahrain Grand Prix', country: 'Bahrain', city: 'Sakhir', laps: 57, len: 5412, hw: 7.5, dir: 'cw', street: false, ru: ['asphalt', 25], air: 27, rain: 0.02, tod: 18, night: true,
    el: [[0, 0], [0.1, -2], [0.3, 3], [0.5, 6], [0.7, 3], [0.9, -1], [1, 0]],
    lm: [['tower', 0.02, 70, 3], ['mountain', 0.4, 500, 2], ['building', 0.6, 150, 2]] },
  { id: 'jeddah', gj: 'sa-2021', name: 'Jeddah Corniche Circuit', gp: 'Saudi Arabian Grand Prix', country: 'Saudi Arabia', city: 'Jeddah', laps: 50, len: 6174, hw: 6.5, dir: 'ccw', street: true, air: 30, rain: 0.02, tod: 20, night: true,
    el: [[0, 0], [0.3, 1.5], [0.6, -1], [1, 0]],
    lm: [['water', 0.5, 150, 4], ['building', 0.1, 90, 2], ['tower', 0.7, 100, 2], ['hotel', 0.3, 110, 2]] },
  { id: 'miami', gj: 'us-2022', name: 'Miami International Autodrome', gp: 'Miami Grand Prix', country: 'USA', city: 'Miami Gardens', laps: 57, len: 5412, hw: 6.5, dir: 'ccw', street: true, air: 30, rain: 0.2, tod: 16,
    el: [[0, 0], [0.3, 1.5], [0.6, 2.5], [1, 0]],
    lm: [['building', 0.1, 220, 5], ['water', 0.5, 140, 2], ['hotel', 0.3, 110, 2], ['tower', 0.8, 120, 2]] },
  { id: 'montreal', gj: 'ca-1978', name: 'Circuit Gilles Villeneuve', gp: 'Canadian Grand Prix', country: 'Canada', city: 'Montreal', laps: 70, len: 4361, hw: 6.5, dir: 'cw', street: false, ru: ['asphalt', 10], air: 22, rain: 0.25, tod: 14,
    el: [[0, 0], [0.5, 1], [1, 0]],
    lm: [['water', 0.55, 150, 4], ['bridge', 0.5, 0, 2], ['building', 0.3, 130, 2], ['trees', 0.7, 50]] },
  { id: 'monaco', gj: 'mc-1929', name: 'Circuit de Monaco', gp: 'Monaco Grand Prix', country: 'Monaco', city: 'Monte Carlo', laps: 78, len: 3337, hw: 4.8, dir: 'cw', street: true, pit: 60, air: 21, rain: 0.15, tod: 15,
    el: [[0, 0], [0.045, 0], [0.1, 8], [0.2, 28], [0.27, 38], [0.33, 32], [0.375, 26], [0.44, 18], [0.48, 10], [0.52, -2], [0.6, -6], [0.64, -6], [0.7, -5], [0.8, -6], [0.9, -5], [0.97, -2], [1, 0]],
    lm: [['water', 0.8, 80, 4], ['hotel', 0.25, 50, 2], ['building', 0.15, 45, 2], ['mountain', 0.5, 280, 2], ['building', 0.6, 60, 2], ['trees', 0.35, 40]] },
  { id: 'barcelona', gj: 'es-1991', name: 'Circuit de Barcelona-Catalunya', gp: 'Barcelona-Catalunya Grand Prix', country: 'Spain', city: 'Montmelo', laps: 66, len: 4657, hw: 7, dir: 'cw', street: false, ru: ['gravel', 15], air: 24, rain: 0.1, tod: 15,
    el: [[0, 0], [0.06, -3], [0.14, 4], [0.24, 14], [0.32, 20], [0.4, 14], [0.5, 4], [0.58, -6], [0.66, 6], [0.76, 14], [0.88, 6], [0.95, 2], [1, 0]],
    lm: [['tower', 0.02, 70, 2], ['mountain', 0.5, 450, 2], ['trees', 0.3, 60], ['building', 0.7, 140, 2]] },
  { id: 'spielberg', gj: 'at-1969', name: 'Red Bull Ring', gp: 'Austrian Grand Prix', country: 'Austria', city: 'Spielberg', laps: 71, len: 4318, hw: 6.5, dir: 'cw', street: false, ru: ['asphalt', 15], air: 22, rain: 0.25, tod: 15,
    el: [[0, 0], [0.09, 26], [0.15, 14], [0.28, 40], [0.4, 58], [0.5, 44], [0.6, 22], [0.7, 4], [0.78, 14], [0.86, 34], [0.93, 16], [1, 0]],
    lm: [['mountain', 0.4, 500, 3], ['trees', 0.2, 60], ['trees', 0.6, 60], ['tower', 0.9, 90, 2], ['building', 0.05, 90, 2]] },
  { id: 'silverstone', gj: 'gb-1948', name: 'Silverstone Circuit', gp: 'British Grand Prix', country: 'United Kingdom', city: 'Silverstone', laps: 52, len: 5891, hw: 7, dir: 'cw', street: false, ru: ['gravel', 18], air: 20, rain: 0.35, tod: 14,
    el: [[0, 0], [0.15, -2], [0.3, -4], [0.5, 1], [0.7, 4], [0.85, 2], [1, 0]],
    lm: [['building', 0.01, 90, 3], ['tower', 0.5, 120, 2], ['trees', 0.3, 60], ['trees', 0.75, 60]] },
  { id: 'spa', gj: 'be-1925', name: 'Circuit de Spa-Francorchamps', gp: 'Belgian Grand Prix', country: 'Belgium', city: 'Stavelot', laps: 44, len: 7004, hw: 7, dir: 'cw', street: false, ru: ['gravel', 15], air: 18, rain: 0.45, tod: 14,
    el: [[0, 0], [0.04, -8], [0.08, -14], [0.12, 18], [0.2, 40], [0.24, 42], [0.3, 30], [0.34, 10], [0.4, -5], [0.45, 10], [0.52, 25], [0.6, 20], [0.7, 30], [0.85, 12], [0.95, -2], [1, 0]],
    lm: [['trees', 0.1, 40], ['trees', 0.2, 40], ['trees', 0.35, 40], ['trees', 0.55, 40], ['trees', 0.8, 40], ['mountain', 0.45, 500, 3], ['tower', 0.01, 80, 2]] },
  { id: 'hungaroring', gj: 'hu-1986', name: 'Hungaroring', gp: 'Hungarian Grand Prix', country: 'Hungary', city: 'Mogyorod', laps: 70, len: 4381, hw: 6.5, dir: 'cw', street: false, ru: ['gravel', 12], air: 28, rain: 0.15, tod: 15,
    el: [[0, 0], [0.06, -10], [0.14, -16], [0.24, 0], [0.34, 14], [0.44, 18], [0.52, 6], [0.6, -4], [0.7, 6], [0.8, 12], [0.9, 4], [1, 0]],
    lm: [['trees', 0.2, 50], ['trees', 0.5, 50], ['trees', 0.8, 50], ['building', 0.02, 90, 2]] },
  { id: 'zandvoort', gj: 'nl-1948', name: 'Circuit Zandvoort', gp: 'Dutch Grand Prix', country: 'Netherlands', city: 'Zandvoort', laps: 72, len: 4259, hw: 6.5, dir: 'cw', street: false, ru: ['gravel', 12], air: 20, rain: 0.25, tod: 15,
    el: [[0, 0], [0.07, 2], [0.12, 4], [0.2, -3], [0.3, -6], [0.4, 2], [0.5, 8], [0.6, 4], [0.7, -2], [0.8, 3], [0.9, 6], [1, 0]],
    lm: [['trees', 0.15, 50], ['trees', 0.45, 50], ['trees', 0.7, 50], ['tower', 0.05, 90, 2], ['water', 0.3, 300, 4]] },
  { id: 'monza', gj: 'it-1922', name: 'Autodromo Nazionale Monza', gp: 'Italian Grand Prix', country: 'Italy', city: 'Monza', laps: 53, len: 5793, hw: 7.5, dir: 'cw', street: false, ru: ['gravel', 15], air: 25, rain: 0.1, tod: 15,
    el: [[0, 0], [0.2, -1], [0.45, 3], [0.6, 4], [0.8, 2], [1, 0]],
    lm: [['trees', 0.2, 60], ['trees', 0.4, 60], ['trees', 0.6, 60], ['trees', 0.85, 60], ['tower', 0.02, 90, 2]] },
  { id: 'madrid', gj: 'es-2026', name: 'Madring', gp: SP, country: 'Spain', city: 'Madrid', laps: 57, len: 5474, hw: 6.5, dir: 'cw', street: true, air: 27, rain: 0.05, tod: 15,
    el: [[0, 0], [0.2, 3], [0.4, 8], [0.6, 5], [0.8, 2], [1, 0]],
    lm: [['building', 0.05, 110, 4], ['hotel', 0.3, 100, 2], ['tower', 0.6, 110, 2], ['building', 0.8, 110, 2]] },
  { id: 'baku', gj: 'az-2016', name: 'Baku City Circuit', gp: 'Azerbaijan Grand Prix', country: 'Azerbaijan', city: 'Baku', laps: 51, len: 6003, hw: 6.5, dir: 'ccw', street: true, air: 28, rain: 0.05, tod: 15,
    wz: [{ from: 0.52, to: 0.6, halfWidth: 3.8 }],
    el: [[0, 0], [0.3, -4], [0.5, 6], [0.6, 8], [0.8, -2], [1, 0]],
    lm: [['building', 0.55, 55, 3], ['tower', 0.2, 120, 3], ['water', 0.9, 150, 4], ['building', 0.1, 110, 2], ['hotel', 0.75, 110, 2]] },
  { id: 'singapore', gj: 'sg-2008', name: 'Marina Bay Street Circuit', gp: 'Singapore Grand Prix', country: 'Singapore', city: 'Singapore', laps: 62, len: 4940, hw: 6, dir: 'ccw', street: true, air: 30, rain: 0.3, tod: 20, night: true,
    el: [[0, 0], [0.3, 1], [0.6, 2], [1, 0]],
    lm: [['ferris', 0.3, 120, 3], ['building', 0.1, 90, 4], ['building', 0.5, 100, 4], ['water', 0.7, 100, 3], ['hotel', 0.85, 90, 4]] },
  { id: 'austin', gj: 'us-2012', name: 'Circuit of the Americas', gp: 'United States Grand Prix', country: 'USA', city: 'Austin', laps: 56, len: 5513, hw: 7.5, dir: 'ccw', street: false, ru: ['asphalt', 20], air: 27, rain: 0.1, tod: 14,
    el: [[0, 0], [0.055, 30], [0.08, 22], [0.12, 10], [0.2, 2], [0.35, -2], [0.5, 2], [0.6, 0], [0.8, -3], [0.9, -3], [1, 0]],
    lm: [['tower', 0.05, 90, 3], ['trees', 0.3, 60], ['trees', 0.6, 60], ['building', 0.01, 90, 3]] },
  { id: 'mexico', gj: 'mx-1962', name: 'Autodromo Hermanos Rodriguez', gp: 'Mexico City Grand Prix', country: 'Mexico', city: 'Mexico City', laps: 71, len: 4304, hw: 7, dir: 'cw', street: false, ru: ['asphalt', 15], air: 22, rain: 0.15, tod: 14,
    el: [[0, 0], [0.3, -1.5], [0.6, 1.5], [1, 0]],
    lm: [['building', 0.5, 100, 4], ['mountain', 0.3, 500, 3], ['trees', 0.7, 60], ['tower', 0.02, 90, 2]] },
  { id: 'interlagos', gj: 'br-1940', name: 'Autodromo Jose Carlos Pace', gp: 'Sao Paulo Grand Prix', country: 'Brazil', city: 'Sao Paulo', laps: 71, len: 4309, hw: 7, dir: 'ccw', street: false, ru: ['gravel', 15], air: 24, rain: 0.35, tod: 14,
    el: [[0, 0], [0.03, 2], [0.1, -10], [0.2, -24], [0.3, -38], [0.38, -28], [0.45, -30], [0.55, -16], [0.62, -8], [0.7, -10], [0.8, -26], [0.88, -34], [0.95, -14], [1, 0]],
    lm: [['building', 0.5, 150, 3], ['water', 0.4, 200, 3], ['trees', 0.2, 50], ['trees', 0.75, 50], ['tower', 0.02, 90, 2]] },
  { id: 'lasvegas', gj: 'us-2023', name: 'Las Vegas Strip Circuit', gp: 'Las Vegas Grand Prix', country: 'USA', city: 'Las Vegas', laps: 50, len: 6201, hw: 6.5, dir: 'ccw', street: true, air: 14, rain: 0.02, tod: 22, night: true,
    el: [[0, 0], [0.3, 1], [0.6, -1], [1, 0]],
    lm: [['building', 0.4, 160, 5], ['ferris', 0.6, 170, 3], ['hotel', 0.3, 110, 4], ['hotel', 0.5, 110, 4], ['hotel', 0.7, 110, 4], ['tower', 0.2, 130, 3]] },
  { id: 'lusail', gj: 'qa-2004', name: 'Lusail International Circuit', gp: 'Qatar Grand Prix', country: 'Qatar', city: 'Lusail', laps: 57, len: 5419, hw: 7.5, dir: 'cw', street: false, ru: ['asphalt', 25], air: 28, rain: 0.02, tod: 19, night: true,
    el: [[0, 0], [0.3, 2], [0.6, 3], [1, 0]],
    lm: [['tower', 0.02, 70, 3], ['building', 0.5, 170, 3], ['hotel', 0.75, 150, 3]] },
  { id: 'abudhabi', gj: 'ae-2009', name: 'Yas Marina Circuit', gp: 'Abu Dhabi Grand Prix', country: 'UAE', city: 'Abu Dhabi', laps: 58, len: 5281, hw: 7.5, dir: 'ccw', street: false, ru: ['asphalt', 25], air: 28, rain: 0.02, tod: 17, night: true,
    el: [[0, 0], [0.3, 1.5], [0.6, 3], [1, 0]],
    lm: [['hotel', 0.55, 0, 3, true], ['water', 0.8, 130, 3], ['tower', 0.02, 80, 3], ['building', 0.3, 130, 3], ['ferris', 0.4, 150, 2]] },
];

// ------------------------------------------------------------------ geometry helpers
const hyp = Math.hypot;

function signedArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

function crSeg(p0, p1, p2, p3, t) { // centripetal Catmull-Rom (Barry-Goldman)
  const d = (a, b) => Math.sqrt(hyp(a[0] - b[0], a[1] - b[1])) || 1e-6;
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const lp = (a, b, ta, tb) => {
    const u = (tb - tt) / (tb - ta), v = (tt - ta) / (tb - ta);
    return [u * a[0] + v * b[0], u * a[1] + v * b[1]];
  };
  const A1 = lp(p0, p1, t0, t1), A2 = lp(p1, p2, t1, t2), A3 = lp(p2, p3, t2, t3);
  return lp(lp(A1, A2, t0, t2), lp(A2, A3, t1, t3), t1, t2);
}

function loopLength(p) {
  let L = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; L += hyp(q[0] - p[i][0], q[1] - p[i][1]); }
  return L;
}

function resampleEqual(p, n) { // closed loop, linear interpolation, starts at p[0]
  const m = p.length, cum = [0];
  for (let i = 0; i < m; i++) { const q = p[(i + 1) % m]; cum.push(cum[i] + hyp(q[0] - p[i][0], q[1] - p[i][1])); }
  const L = cum[m], out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (k * L) / n;
    while (j < m - 1 && cum[j + 1] <= s) j++;
    const a = p[j], b = p[(j + 1) % m], seg = cum[j + 1] - cum[j] || 1, f = (s - cum[j]) / seg;
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

function scaleTo(p, target) {
  const k = target / loopLength(p);
  return p.map((q) => [q[0] * k, q[1] * k]);
}

function normalise(p, target, n) {
  let q = scaleTo(p, target);
  for (let it = 0; it < 3; it++) q = scaleTo(resampleEqual(q, n), target);
  return q;
}

function laplacian(p, w, idx) {
  const n = p.length, out = p.map((q) => q.slice());
  const set = idx ?? p.map((_, i) => i);
  for (const i of set) {
    const a = p[(i + n - 1) % n], b = p[(i + 1) % n];
    out[i] = [p[i][0] + w * ((a[0] + b[0]) / 2 - p[i][0]), p[i][1] + w * ((a[1] + b[1]) / 2 - p[i][1])];
  }
  return out;
}

function radiusAt(p, i) {
  const n = p.length, a = p[(i + n - 1) % n], b = p[i], c = p[(i + 1) % n];
  const ab = hyp(b[0] - a[0], b[1] - a[1]), bc = hyp(c[0] - b[0], c[1] - b[1]), ca = hyp(a[0] - c[0], a[1] - c[1]);
  const cr = Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]));
  return cr < 1e-9 ? Infinity : (ab * bc * ca) / (2 * cr);
}

function curvatures(p) { // signed 1/m, + = left (anticlockwise in (x,n))
  const n = p.length, k = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n], b = p[i], c = p[(i + 1) % n];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const ab = hyp(b[0] - a[0], b[1] - a[1]), bc = hyp(c[0] - b[0], c[1] - b[1]), ca = hyp(a[0] - c[0], a[1] - c[1]);
    k[i] = (2 * cr) / (ab * bc * ca || 1);
  }
  return k;
}

function segIntersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t < 1 && u >= 0 && u < 1 ? [t, u] : null;
}

function findCrossings(p) {
  const n = p.length, out = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 3; j < n; j++) {
      if (i === 0 && j >= n - 2) continue;
      if (segIntersect(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) out.push([i, j]);
    }
  }
  return out;
}

// ------------------------------------------------------------------ elevation
function elevationFromKeys(keys, n) {
  const y = new Array(n);
  for (let i = 0; i < n; i++) {
    const f = i / n;
    let k = 0;
    while (k < keys.length - 2 && keys[k + 1][0] <= f) k++;
    const [f0, y0] = keys[k], [f1, y1] = keys[k + 1];
    const u = Math.min(1, Math.max(0, (f - f0) / (f1 - f0 || 1)));
    y[i] = y0 + (y1 - y0) * (0.5 - 0.5 * Math.cos(Math.PI * u));
  }
  return y;
}

function maxSlope(y, ds) {
  let m = 0;
  for (let i = 0; i < y.length; i++) m = Math.max(m, Math.abs(y[(i + 1) % y.length] - y[i]) / ds);
  return m;
}

function smoothY(y, half) {
  const n = y.length;
  return y.map((_, i) => { let s = 0; for (let d = -half; d <= half; d++) s += y[(i + d + n) % n]; return s / (2 * half + 1); });
}

function addBump(y, centre, amp, halfWidthSamples) {
  const n = y.length;
  for (let d = -halfWidthSamples; d <= halfWidthSamples; d++) {
    y[(centre + d + n) % n] += (amp / 2) * (1 + Math.cos((Math.PI * d) / halfWidthSamples));
  }
}

// ------------------------------------------------------------------ main
const gj = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'f1-circuits.geojson'), 'utf8'));
const byId = new Map(gj.features.map((f) => [f.properties.id, f]));
fs.mkdirSync(OUT, { recursive: true });

const report = [];
const index = [];

T.forEach((t, ti) => {
  const feat = byId.get(t.gj);
  if (!feat) throw new Error(`GeoJSON is missing ${t.gj} (${t.id})`);
  let ll = feat.geometry.coordinates.map((c) => [c[0], c[1]]);
  const f0 = ll[0], l0 = ll[ll.length - 1];
  if (f0[0] === l0[0] && f0[1] === l0[1]) ll.pop();
  const lon0 = ll.reduce((s, c) => s + c[0], 0) / ll.length, lat0 = ll.reduce((s, c) => s + c[1], 0) / ll.length;
  const cosL = Math.cos((lat0 * Math.PI) / 180);
  let pts = ll.map((c) => [(c[0] - lon0) * cosL * R_DEG, (c[1] - lat0) * R_DEG]); // (x east, n north)
  // drop near-duplicates
  pts = pts.filter((q, i) => hyp(q[0] - pts[(i + pts.length - 1) % pts.length][0], q[1] - pts[(i + pts.length - 1) % pts.length][1]) > 0.5 || i === 0);

  // orientation
  const area = signedArea(pts);
  const isCcw = area > 0;
  const wantCcw = t.dir === 'ccw';
  let flipped = false;
  if (isCcw !== wantCcw) { pts = [pts[0], ...pts.slice(1).reverse()]; flipped = true; }

  // spline densify (~1 m), starting at the first original point
  const m = pts.length, dense = [];
  for (let i = 0; i < m; i++) {
    const p0 = pts[(i + m - 1) % m], p1 = pts[i], p2 = pts[(i + 1) % m], p3 = pts[(i + 2) % m];
    const ns = Math.max(2, Math.ceil(hyp(p2[0] - p1[0], p2[1] - p1[1])));
    for (let s = 0; s < ns; s++) dense.push(crSeg(p0, p1, p2, p3, s / ns));
  }
  const N = Math.round(t.len / 5);
  let q = normalise(dense, t.len, N);
  // light smoothing
  for (let it = 0; it < 2; it++) q = laplacian(q, 0.3);
  q = normalise(q, t.len, N);
  // local min-radius fix
  for (let round = 0; round < 40; round++) {
    let any = false;
    for (let it = 0; it < 30; it++) {
      const bad = new Set();
      for (let i = 0; i < N; i++) if (radiusAt(q, i) < 10) for (let d = -3; d <= 3; d++) bad.add((i + d + N) % N);
      if (!bad.size) break;
      any = true;
      q = laplacian(q, 0.5, [...bad]);
    }
    q = normalise(q, t.len, N);
    if (!any) break;
  }
  let minR = Infinity;
  for (let i = 0; i < N; i++) minR = Math.min(minR, radiusAt(q, i));
  const ds = loopLength(q) / N;

  // elevation
  let y = elevationFromKeys(t.el, N);
  for (let it = 0; it < 60 && maxSlope(y, ds) > 0.16; it++) y = smoothY(y, 2);
  const crossings = findCrossings(q);
  for (const [i, j] of crossings) {
    // later segment (j) is the overpass; ensure >= 8.5 m separation
    const diff = y[j] - y[i];
    if (diff < 8.5) {
      const need = 8.5 - diff, hw = Math.round(300 / ds);
      addBump(y, j, need / 2, hw);
      addBump(y, i, -need / 2, hw);
    }
  }
  if (maxSlope(y, ds) > 0.18) throw new Error(`${t.id}: slope ${maxSlope(y, ds)}`);
  const yMin = Math.min(...y), yMax = Math.max(...y);

  // curvature-derived features
  const smooth11 = (pp) => { const kap = curvatures(pp); return kap.map((_, i) => { let s = 0; for (let d = -5; d <= 5; d++) s += kap[(i + d + N) % N]; return s / 11; }); };
  let sm = smooth11(q);
  // If the GeoJSON first point is not on a straight, move the s/f line to the nearest decent straight.
  const winMax = (smv, c) => { let mk = 0; for (let s = -320; s <= 260; s += ds) mk = Math.max(mk, Math.abs(smv[(c + Math.round(s / ds) + 5 * N) % N])); return mk; };
  let shift = 0;
  const wm = []; let best = Infinity;
  for (let c = 0; c < N; c++) { wm[c] = winMax(sm, c); best = Math.min(best, wm[c]); }
  if (wm[0] > 1 / 300) {
    const lim = Math.max(best * 1.3, 1 / 600);
    let bd = Infinity;
    for (let c = 0; c < N; c++) { const d = Math.min(c, N - c); if (d * ds <= 600 && wm[c] <= lim && d < bd) { bd = d; shift = c; } }
    if (!shift) { let bw = Infinity; for (let c = 0; c < N; c++) { const d = Math.min(c, N - c); if (d * ds <= 600 && wm[c] < bw) { bw = wm[c]; shift = c; } } }
  }
  if (shift) {
    q = q.slice(shift).concat(q.slice(0, shift));
    y = y.slice(shift).concat(y.slice(0, shift));
    sm = smooth11(q);
  }

  // corners -> outside run-off
  const runoff = [];
  if (!t.street && t.ru) {
    const isC = sm.map((k) => Math.abs(k) > 1 / 180);
    const start = isC.indexOf(false);
    let i = 0;
    while (i < N) {
      const idx = (start + i) % N;
      if (isC[idx]) {
        let j = i, sum = 0;
        while (j < N && isC[(start + j) % N]) { sum += sm[(start + j) % N]; j++; }
        if ((j - i) * ds >= 15) {
          const from = (((start + i) * ds - 30) / t.len + 1) % 1, to = ((((start + j) * ds + 30) / t.len) % 1 + 1) % 1;
          runoff.push({ from: +from.toFixed(4), to: +to.toFixed(4), side: sum > 0 ? 'right' : 'left', type: t.ru[0], widthM: t.ru[1] });
        }
        i = j;
      } else i++;
    }
  }

  // straights -> aero zones
  const straightTh = t.street && t.pit === 60 ? 1 / 250 : 1 / 700; // Monaco has no real straights
  const straight = sm.map((k) => Math.abs(k) < straightTh);
  const runs = [];
  {
    const st = straight.indexOf(false);
    let i = 0;
    while (i < N) {
      if (straight[(st + i) % N]) {
        let j = i;
        while (j < N && straight[(st + j) % N]) j++;
        runs.push({ s0: (st + i) * ds, s1: (st + j) * ds });
        i = j;
      } else i++;
    }
  }
  let chosen = [];
  for (const minLen of [350, 250, 180, 120, 80]) {
    chosen = runs.filter((r) => r.s1 - r.s0 >= minLen).sort((a, b) => b.s1 - b.s0 - (a.s1 - a.s0)).slice(0, 4);
    if (chosen.length >= 2) break;
  }
  const aero = [];
  for (const r of chosen.sort((a, b) => a.s0 - b.s0)) {
    const a = r.s0 + 30, b = r.s1 - (t.pit === 60 ? 40 : 110);
    if (b - a < 40) continue;
    const fa = (a / t.len) % 1, fb = (b / t.len) % 1;
    if (fa < fb) aero.push({ from: +fa.toFixed(4), to: +fb.toFixed(4) });
    else { aero.push({ from: +fa.toFixed(4), to: 1 }); if (fb > 0) aero.push({ from: 0, to: +fb.toFixed(4) }); }
  }

  // pit lane + start straightness check
  const pitSide = t.dir === 'cw' ? 'right' : 'left';
  const pitSign = pitSide === 'left' ? 1 : -1;
  const pitEntry = +(1 - 320 / t.len).toFixed(4), pitExit = +(260 / t.len).toFixed(4);
  let maxK = 0;
  for (let s = -320; s <= 260; s += ds) maxK = Math.max(maxK, Math.abs(sm[(Math.round(s / ds) + N) % N]));
  const sfStraight = maxK < 1 / 400;

  // widths: wider start straight
  const widthZones = [{ from: pitEntry, to: pitExit, halfWidth: +(t.hw + 1).toFixed(1) }, ...(t.wz ?? [])];

  // landmarks
  const grandOff = -pitSign * (t.hw + 28);
  const lmRaw = [
    ['grandstand', 0.0, grandOff, 2],
    ['grandstand', 0.97, grandOff, 1],
    ['grandstand', 0.03, grandOff, 1],
    ['grandstand', 0.5, (ti % 2 ? 1 : -1) * (t.hw + 30), 1],
    ...t.lm,
  ];
  const landmarks = lmRaw.map(([kind, at, off, scale, fixed]) => {
    const i = Math.round(at * N) % N;
    const a = q[(i + N - 1) % N], b = q[(i + 1) % N];
    const tl = hyp(b[0] - a[0], b[1] - a[1]) || 1, lx = -(b[1] - a[1]) / tl, ln = (b[0] - a[0]) / tl;
    const need = { mountain: 150, water: 60, trees: 30 }[kind] ?? 45;
    let o = off;
    if (kind !== 'bridge' && !fixed) {
      const ok = (oo) => {
        if (Math.abs(oo) < t.hw + 20) return false;
        const px = q[i][0] + lx * oo, pn = q[i][1] + ln * oo;
        for (let k = 0; k < N; k++) if (hyp(q[k][0] - px, q[k][1] - pn) < need) return false;
        return true;
      };
      const sg = Math.sign(off) || 1;
      let found = false;
      for (const s of [sg, -sg]) {
        for (let mag = Math.max(Math.abs(off), t.hw + 20); mag <= 450 && !found; mag += 10) if (ok(s * mag)) { o = s * mag; found = true; }
        if (found) break;
      }
    }
    const lmo = { kind, at: +at.toFixed(4), offsetM: Math.round(o) };
    if (scale && scale !== 1) lmo.scale = scale;
    return lmo;
  });

  const data = {
    id: t.id, name: t.name, grandPrix: t.gp, country: t.country, city: t.city,
    realLengthM: t.len, raceLaps: t.laps,
    points: q.map((p, i) => [+p[0].toFixed(2), +y[i].toFixed(2), +(-p[1]).toFixed(2)]),
    halfWidth: t.hw, widthZones,
    runoff,
    defaultRunoff: t.street ? { type: 'wall', widthM: 1.5 } : { type: 'grass', widthM: 12 },
    street: t.street,
    sectors: [0.33, 0.67],
    aeroZones: aero,
    pit: { side: pitSide, entry: pitEntry, exit: pitExit, offsetM: t.hw + 10, speedLimitKmh: t.pit ?? 80 },
    gridSpacingM: 8,
    climate: { rainChance: t.rain, airTempC: t.air },
    raceTimeOfDay: t.tod,
    latLon: [+lat0.toFixed(4), +lon0.toFixed(4)],
    landmarks,
  };
  fs.writeFileSync(path.join(OUT, `${t.id}.json`), JSON.stringify(data));
  index.push({ id: t.id, round: ti + 1, name: t.name, grandPrix: t.gp, country: t.country, realLengthM: t.len });
  report.push(`${t.id.padEnd(12)} N=${N} flip=${flipped ? 'YES' : 'no '} minR=${minR.toFixed(1)} y=[${yMin.toFixed(0)},${yMax.toFixed(0)}] slope=${(maxSlope(y, ds) * 100).toFixed(1)}% aero=${aero.length} crossings=${crossings.length} shift=${(shift*ds).toFixed(0)}m sfStraight=${sfStraight ? 'ok' : 'CURVY(maxR=' + (1 / maxK).toFixed(0) + ')'}`);
});

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2));
console.log(report.join('\n'));
console.log(`wrote ${T.length} circuits + index.json to ${OUT}`);
