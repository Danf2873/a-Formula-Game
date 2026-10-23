import type { CircuitData } from '../../src/types';

/** Stadium-shaped fixture: 600 m straight (x = east, z = -north) plus two 60 m radius hairpins. Turns left. */
export function makeOval(): CircuitData {
  const pts: [number, number, number][] = [];
  const R = 60, L = 600, step = 5;
  // bottom straight heading +x at z = 0 (first point on the s/f line), then left turn (towards -z)
  for (let x = 0; x < L; x += step) pts.push([x, 0, 0]);
  const arcN = Math.round((Math.PI * R) / step);
  for (let i = 0; i < arcN; i++) {
    const a = (i / arcN) * Math.PI; // 0..pi
    pts.push([L + Math.sin(a) * R, 0, -R + Math.cos(a) * R]);
  }
  for (let x = L; x > 0; x -= step) pts.push([x, 0, -2 * R]);
  for (let i = 0; i < arcN; i++) {
    const a = (i / arcN) * Math.PI;
    pts.push([-Math.sin(a) * R, 0, -R - Math.cos(a) * R]);
  }
  const withY = pts.map(([x, , z], i) => [x, 4 * Math.sin((i / pts.length) * Math.PI * 2), z] as [number, number, number]);
  return {
    id: 'oval', name: 'Oval', grandPrix: 'Test GP', country: 'XX', city: 'Test', realLengthM: 0,
    raceLaps: 5, points: withY, halfWidth: 7.5,
    widthZones: [{ from: 0.9, to: 0.05, halfWidth: 9 }],
    runoff: [{ from: 0.3, to: 0.45, side: 'right', type: 'gravel', widthM: 15 }],
    defaultRunoff: { type: 'grass', widthM: 12 }, street: false, sectors: [0.33, 0.67],
    aeroZones: [{ from: 0.9, to: 0.1 }, { from: 0.5, to: 0.6 }],
    pit: { side: 'right', entry: 0.95, exit: 0.15, offsetM: 17.5, speedLimitKmh: 80 },
    gridSpacingM: 8, climate: { rainChance: 0, airTempC: 20 }, raceTimeOfDay: 14, latLon: [0, 0],
    landmarks: [{ kind: 'grandstand', at: 0.02, offsetM: 30 }, { kind: 'tower', at: 0.5, offsetM: 40 }],
  };
}
