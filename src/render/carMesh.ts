// Procedural low-poly 2026-style F1 car. Car local axes: +X left, +Y up, +Z forward.
// Origin: on the ground, midway between the axles.
import * as THREE from 'three';
import type { CarPose, Team, TyreCompound } from '../types';

export const WHEEL_RADIUS = 0.36;
const WHEELBASE = 3.4;
const HALF_TRACK = 0.76;
const FRONT_W = 0.3;
const REAR_W = 0.38;

export const COMPOUND_COLORS: Record<TyreCompound, number> = {
  soft: 0xe10600, medium: 0xffd400, hard: 0xf0f0f0, inter: 0x43b02a, wet: 0x0067ad,
};

/** Camera anchor points in car-local space (used by cameras.ts). */
export const CAR_ANCHORS = {
  airbox: new THREE.Vector3(0, 1.08, -0.45),
  cockpit: new THREE.Vector3(0, 0.86, 0.28),
  nose: new THREE.Vector3(0, 0.5, 1.9),
};

// ------------------------------------------------------------------ geometry builder

interface Section { z: number; cx: number; cy: number; rx: number; ry: number }

class GeomBuilder {
  pos: number[] = [];
  idx: number[] = [];

  private vert(x: number, y: number, z: number): number {
    this.pos.push(x, y, z);
    return this.pos.length / 3 - 1;
  }

  private ringVerts(s: Section, ring: number, power: number): number[] {
    const r: number[] = [];
    for (let k = 0; k < ring; k++) {
      const a = (k / ring) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      r.push(this.vert(
        s.cx + s.rx * Math.sign(c) * Math.pow(Math.abs(c), 2 / power),
        s.cy + s.ry * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / power),
        s.z));
    }
    return r;
  }

  /** Lofted superellipse tube through sections (any z order). */
  loft(sections: Section[], ring = 10, power = 3, caps = true): void {
    const secs = sections.slice();
    if (secs[0].z > secs[secs.length - 1].z) secs.reverse();
    const rings = secs.map((s) => this.ringVerts(s, ring, power));
    for (let i = 0; i < rings.length - 1; i++) {
      for (let k = 0; k < ring; k++) {
        const a = rings[i][k], b = rings[i][(k + 1) % ring];
        const c = rings[i + 1][k], d = rings[i + 1][(k + 1) % ring];
        this.idx.push(a, b, d, a, d, c);
      }
    }
    if (caps) {
      const cap = (s: Section, front: boolean) => {
        const r = this.ringVerts(s, ring, power);
        const ctr = this.vert(s.cx, s.cy, s.z);
        for (let k = 0; k < ring; k++) {
          const p0 = r[k], p1 = r[(k + 1) % ring];
          if (front) this.idx.push(ctr, p0, p1); else this.idx.push(ctr, p1, p0);
        }
      };
      cap(secs[0], false);
      cap(secs[secs.length - 1], true);
    }
  }

  /** Merge a three.js geometry transformed by `m` (source geometry is disposed). */
  add(geo: THREE.BufferGeometry, m?: THREE.Matrix4): void {
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    const base = this.pos.length / 3;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      if (m) v.applyMatrix4(m);
      this.pos.push(v.x, v.y, v.z);
    }
    const ix = geo.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    geo.dispose();
  }

  box(sx: number, sy: number, sz: number, x: number, y: number, z: number, rotX = 0): void {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, 0, 0)),
      new THREE.Vector3(1, 1, 1));
    this.add(new THREE.BoxGeometry(sx, sy, sz), m);
  }

  /** Thin cylinder between two points. */
  strut(a: THREE.Vector3, b: THREE.Vector3, r: number, radial = 5): void {
    const dir = b.clone().sub(a);
    const len = dir.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    this.add(new THREE.CylinderGeometry(r, r, len, radial, 1, true), m);
  }

  /** Cambered thin wing element spanning x in [-hw, hw]; lead edge at zLead, chord towards -z. */
  wing(zLead: number, chord: number, y: number, camber: number, thick: number, hw: number): void {
    const z = zLead, c = chord;
    const prof: [number, number][] = [
      [z, y], [z - 0.35 * c, y + camber * 0.6 + thick], [z - c, y + camber + thick * 0.4],
      [z - c, y + camber], [z - 0.35 * c, y + camber * 0.6], [z, y - thick],
    ];
    // Shape x = -world z, shape y = world y
    const shape = new THREE.Shape(prof.map(([pz, py]) => new THREE.Vector2(-pz, py)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: hw * 2, bevelEnabled: false, steps: 1 });
    g.rotateY(Math.PI / 2); // shape x -> -z, extrude z -> +x
    g.translate(-hw, 0, 0);
    this.add(g);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

// ------------------------------------------------------------------ shared resources

interface TeamMats {
  body: THREE.MeshStandardMaterial;
  secondary: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  carbon: THREE.MeshStandardMaterial;
  refs: number;
}
const teamMatCache = new Map<string, TeamMats>();

function acquireTeamMats(team: Team): TeamMats {
  let m = teamMatCache.get(team.id);
  if (!m) {
    m = {
      body: new THREE.MeshStandardMaterial({ color: team.colors.primary, roughness: 0.38, metalness: 0.25 }),
      secondary: new THREE.MeshStandardMaterial({ color: team.colors.secondary, roughness: 0.45, metalness: 0.15 }),
      accent: new THREE.MeshStandardMaterial({ color: team.colors.accent, roughness: 0.45, metalness: 0.1 }),
      carbon: new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.5, metalness: 0.3 }),
      refs: 0,
    };
    teamMatCache.set(team.id, m);
  }
  m.refs++;
  return m;
}

function releaseTeamMats(team: Team): void {
  const m = teamMatCache.get(team.id);
  if (!m) return;
  if (--m.refs <= 0) {
    m.body.dispose(); m.secondary.dispose(); m.accent.dispose(); m.carbon.dispose();
    teamMatCache.delete(team.id);
  }
}

let sharedTyre: THREE.MeshStandardMaterial | null = null;
let sharedRim: THREE.MeshStandardMaterial | null = null;
const wheelGeoCache = new Map<number, { tyre: THREE.BufferGeometry; rim: THREE.BufferGeometry; cover: THREE.BufferGeometry }>();

function wheelGeos(w: number) {
  let g = wheelGeoCache.get(w);
  if (g) return g;
  const R = WHEEL_RADIUS;
  const prof = [
    new THREE.Vector2(0.21, -w / 2), new THREE.Vector2(R - 0.04, -w / 2), new THREE.Vector2(R, -w * 0.33),
    new THREE.Vector2(R, w * 0.33), new THREE.Vector2(R - 0.04, w / 2), new THREE.Vector2(0.21, w / 2),
  ];
  const tyre = new THREE.LatheGeometry(prof, 20);
  tyre.rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(0.22, 0.22, w * 0.92, 14, 1, true);
  rim.rotateZ(Math.PI / 2);
  const cover = new THREE.CircleGeometry(0.22, 14);
  cover.rotateY(Math.PI / 2); // faces +X
  g = { tyre, rim, cover };
  wheelGeoCache.set(w, g);
  return g;
}

// ------------------------------------------------------------------ number decals

function makeNumberTexture(num: number, primary: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  try {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    const c = new THREE.Color(primary);
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    ctx.clearRect(0, 0, 128, 128);
    ctx.font = 'bold 84px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = lum > 0.35 ? '#ffffff' : '#000000';
    ctx.strokeText(String(num), 64, 68);
    ctx.fillStyle = lum > 0.35 ? '#111111' : '#ffffff';
    ctx.fillText(String(num), 64, 68);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ CarVisual

interface WheelRig {
  group: THREE.Group;
  spin: THREE.Group;
  front: boolean;
  restY: number;
}

export class CarVisual {
  readonly object: THREE.Group = new THREE.Group();
  private team: Team;
  private mats: TeamMats;
  private geos: THREE.BufferGeometry[] = [];
  private ownMats: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private wheels: WheelRig[] = [];
  private stripeMat: THREE.MeshBasicMaterial;
  private discMat: THREE.MeshStandardMaterial;
  private rainMat: THREE.MeshStandardMaterial;
  private compound: TyreCompound = 'soft';
  private heat = 0;
  private disposed = false;

  constructor(team: Team, number: number, driverCode: string) {
    this.team = team;
    this.mats = acquireTeamMats(team);
    if (!sharedTyre) sharedTyre = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.85, metalness: 0 });
    if (!sharedRim) sharedRim = new THREE.MeshStandardMaterial({ color: 0x2b2c30, roughness: 0.4, metalness: 0.7 });
    this.stripeMat = new THREE.MeshBasicMaterial({ color: COMPOUND_COLORS.soft, side: THREE.DoubleSide });
    this.discMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.5, metalness: 0.8, emissive: 0xff5a00, emissiveIntensity: 0 });
    this.rainMat = new THREE.MeshStandardMaterial({ color: 0x300000, emissive: 0xff0000, emissiveIntensity: 0, roughness: 0.4 });
    this.ownMats.push(this.stripeMat, this.discMat, this.rainMat);
    this.object.name = `car-${driverCode}`;
    this.buildBody(number);
    this.buildWheels();
    this.setCompound('soft');
  }

  private addMesh(b: GeomBuilder, mat: THREE.Material, shadow = true): THREE.Mesh {
    const geo = b.build();
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    this.object.add(mesh);
    return mesh;
  }

  private buildBody(number: number): void {
    const body = new GeomBuilder(), sec = new GeomBuilder(), acc = new GeomBuilder(), carb = new GeomBuilder();

    // --- nose + monocoque
    body.loft([
      { z: 2.2, cx: 0, cy: 0.27, rx: 0.11, ry: 0.09 },
      { z: 1.6, cx: 0, cy: 0.33, rx: 0.21, ry: 0.16 },
      { z: 0.9, cx: 0, cy: 0.42, rx: 0.29, ry: 0.24 },
      { z: 0.2, cx: 0, cy: 0.46, rx: 0.31, ry: 0.28 },
      { z: -0.4, cx: 0, cy: 0.47, rx: 0.29, ry: 0.28 },
    ], 12, 3, false);
    // nose tip (secondary)
    sec.loft([
      { z: 2.46, cx: 0, cy: 0.235, rx: 0.045, ry: 0.04 },
      { z: 2.2, cx: 0, cy: 0.27, rx: 0.11, ry: 0.09 },
    ], 10, 3, true);
    // engine cover
    body.loft([
      { z: -0.4, cx: 0, cy: 0.47, rx: 0.28, ry: 0.28 },
      { z: -1.0, cx: 0, cy: 0.5, rx: 0.2, ry: 0.24 },
      { z: -1.6, cx: 0, cy: 0.47, rx: 0.14, ry: 0.19 },
      { z: -2.3, cx: 0, cy: 0.4, rx: 0.07, ry: 0.09 },
    ], 10, 3, true);
    // engine cover stripe (secondary)
    sec.loft([
      { z: -1.0, cx: 0, cy: 0.745, rx: 0.045, ry: 0.006 },
      { z: -1.6, cx: 0, cy: 0.664, rx: 0.04, ry: 0.006 },
      { z: -2.3, cx: 0, cy: 0.494, rx: 0.03, ry: 0.006 },
    ], 6, 3, false);
    // nose pinstripes (accent)
    for (const s of [1, -1]) {
      acc.loft([
        { z: 2.2, cx: s * 0.05, cy: 0.364, rx: 0.012, ry: 0.005 },
        { z: 1.6, cx: s * 0.07, cy: 0.494, rx: 0.012, ry: 0.005 },
        { z: 0.9, cx: s * 0.08, cy: 0.664, rx: 0.012, ry: 0.005 },
        { z: 0.2, cx: s * 0.09, cy: 0.744, rx: 0.012, ry: 0.005 },
      ], 6, 3, false);
    }

    // --- airbox + shark fin
    body.loft([
      { z: -0.36, cx: 0, cy: 0.82, rx: 0.12, ry: 0.13 },
      { z: -0.7, cx: 0, cy: 0.82, rx: 0.12, ry: 0.12 },
      { z: -1.0, cx: 0, cy: 0.8, rx: 0.08, ry: 0.09 },
    ], 8, 3, true);
    carb.box(0.14, 0.1, 0.02, 0, 0.84, -0.36); // intake
    const fin = new THREE.Shape([
      new THREE.Vector2(0.9, 0.86), new THREE.Vector2(1.6, 0.7), new THREE.Vector2(2.2, 0.52),
      new THREE.Vector2(2.2, 0.4), new THREE.Vector2(0.9, 0.4),
    ]);
    const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.015, bevelEnabled: false });
    finGeo.rotateY(Math.PI / 2); // shape x -> -z
    finGeo.translate(-0.0075, 0, 0);
    body.add(finGeo);

    // --- cockpit opening, headrest, halo
    carb.loft([
      { z: 0.5, cx: 0, cy: 0.738, rx: 0.14, ry: 0.012 },
      { z: 0.15, cx: 0, cy: 0.752, rx: 0.2, ry: 0.012 },
      { z: -0.3, cx: 0, cy: 0.755, rx: 0.18, ry: 0.012 },
    ], 10, 2.5, true);
    carb.box(0.2, 0.2, 0.08, 0, 0.84, -0.3); // headrest
    const haloCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.2, 0.74, -0.3), new THREE.Vector3(0.19, 0.92, -0.12), new THREE.Vector3(0.12, 0.98, 0.18),
      new THREE.Vector3(0, 0.97, 0.46), new THREE.Vector3(-0.12, 0.98, 0.18), new THREE.Vector3(-0.19, 0.92, -0.12),
      new THREE.Vector3(-0.2, 0.74, -0.3),
    ]);
    carb.add(new THREE.TubeGeometry(haloCurve, 14, 0.02, 5, false));
    carb.strut(new THREE.Vector3(0, 0.97, 0.46), new THREE.Vector3(0, 0.72, 0.62), 0.022, 5);
    // mirrors
    for (const s of [1, -1]) {
      carb.strut(new THREE.Vector3(s * 0.26, 0.7, 0.5), new THREE.Vector3(s * 0.4, 0.8, 0.46), 0.008, 4);
      sec.box(0.13, 0.08, 0.05, s * 0.46, 0.8, 0.45);
    }

    // helmet (own material, accent coloured) + visor
    const helmetMat = new THREE.MeshStandardMaterial({ color: this.team.colors.accent, roughness: 0.3, metalness: 0.2 });
    this.ownMats.push(helmetMat);
    const hg = new THREE.SphereGeometry(0.12, 10, 7);
    this.geos.push(hg);
    const helmet = new THREE.Mesh(hg, helmetMat);
    helmet.position.set(0, 0.84, -0.14);
    helmet.castShadow = true;
    this.object.add(helmet);
    carb.box(0.15, 0.045, 0.06, 0, 0.855, -0.03);

    // --- sidepods
    for (const s of [1, -1]) {
      body.loft([
        { z: 0.75, cx: s * 0.4, cy: 0.28, rx: 0.1, ry: 0.15 },
        { z: 0.25, cx: s * 0.47, cy: 0.34, rx: 0.17, ry: 0.2 },
        { z: -0.5, cx: s * 0.47, cy: 0.35, rx: 0.17, ry: 0.19 },
        { z: -1.2, cx: s * 0.34, cy: 0.27, rx: 0.12, ry: 0.12 },
        { z: -1.75, cx: s * 0.22, cy: 0.22, rx: 0.08, ry: 0.08 },
      ], 10, 3, true);
      carb.box(0.16, 0.2, 0.02, s * 0.4, 0.28, 0.75); // inlet
    }

    // --- floor (visible under the pods = undercut) and diffuser
    const fp = [[0.3, 1.3], [0.62, 0.9], [0.68, -0.4], [0.56, -1.5], [0.4, -1.75]];
    const pts: THREE.Vector2[] = [];
    for (const [x, z] of fp) pts.push(new THREE.Vector2(x, z));
    for (let i = fp.length - 1; i >= 0; i--) pts.push(new THREE.Vector2(-fp[i][0], fp[i][1]));
    const floor = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 0.03, bevelEnabled: false });
    floor.rotateX(Math.PI / 2); // shape y -> z, extrude -> -y
    floor.translate(0, 0.09, 0);
    carb.add(floor);
    carb.loft([
      { z: -1.7, cx: 0, cy: 0.07, rx: 0.42, ry: 0.03 },
      { z: -2.45, cx: 0, cy: 0.2, rx: 0.36, ry: 0.025 },
    ], 8, 3, true);
    for (const x of [-0.18, 0, 0.18]) carb.box(0.012, 0.12, 0.7, x, 0.12, -2.1, 0.2);
    carb.box(0.3, 0.015, 3.0, 0, 0.04, -0.1); // plank

    // --- front wing (3 elements + endplates)
    carb.wing(2.9, 0.34, 0.1, 0.05, 0.012, 0.88);
    carb.wing(2.74, 0.26, 0.17, 0.07, 0.01, 0.85);
    carb.wing(2.6, 0.22, 0.25, 0.07, 0.01, 0.8);
    for (const s of [1, -1]) {
      sec.box(0.025, 0.3, 0.6, s * 0.9, 0.2, 2.62);
      carb.box(0.02, 0.05, 0.14, s * 0.78, 0.31, 2.7);
    }
    carb.box(0.04, 0.2, 0.07, 0.07, 0.19, 2.35);
    carb.box(0.04, 0.2, 0.07, -0.07, 0.19, 2.35);

    // --- rear wing (main + flap + beam wing)
    carb.wing(-2.15, 0.3, 0.86, 0.06, 0.012, 0.44);
    carb.wing(-2.27, 0.22, 0.98, 0.07, 0.01, 0.44);
    carb.wing(-2.2, 0.2, 0.4, 0.04, 0.01, 0.34);
    carb.box(0.07, 0.4, 0.06, 0, 0.62, -2.28);
    for (const s of [1, -1]) sec.box(0.025, 0.5, 0.62, s * 0.45, 0.78, -2.28);

    // --- suspension wishbones (static, thin dark struts)
    for (const zs of [1, -1]) {
      const zA = zs * (WHEELBASE / 2);
      for (const s of [1, -1]) {
        const hub = (dy: number) => new THREE.Vector3(s * 0.6, WHEEL_RADIUS + dy, zA);
        carb.strut(new THREE.Vector3(s * 0.2, 0.46, zA + 0.25), hub(0.1), 0.012);
        carb.strut(new THREE.Vector3(s * 0.2, 0.46, zA - 0.25), hub(0.1), 0.012);
        carb.strut(new THREE.Vector3(s * 0.2, 0.2, zA + 0.28), hub(-0.12), 0.012);
        carb.strut(new THREE.Vector3(s * 0.2, 0.2, zA - 0.28), hub(-0.12), 0.012);
        if (zs > 0) carb.strut(new THREE.Vector3(s * 0.2, 0.34, zA + 0.05), hub(0.08), 0.01, 4);
      }
    }

    this.addMesh(body, this.mats.body);
    this.addMesh(sec, this.mats.secondary);
    this.addMesh(acc, this.mats.accent, false);
    this.addMesh(carb, this.mats.carbon);

    // --- rain light
    const rlGeo = new THREE.BoxGeometry(0.1, 0.1, 0.02);
    this.geos.push(rlGeo);
    const rl = new THREE.Mesh(rlGeo, this.rainMat);
    rl.position.set(0, 0.4, -2.33);
    this.object.add(rl);

    // --- number decals (browser only)
    const tex = makeNumberTexture(number, this.team.colors.primary);
    if (tex) {
      this.textures.push(tex);
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      this.ownMats.push(mat);
      const pg = new THREE.PlaneGeometry(0.2, 0.2);
      this.geos.push(pg);
      const nose = new THREE.Mesh(pg, mat);
      nose.rotation.x = -Math.PI / 2 + 0.22;
      nose.position.set(0, 0.43, 1.95);
      this.object.add(nose);
      for (const s of [1, -1]) {
        const m = new THREE.Mesh(pg, mat);
        m.rotation.y = s * Math.PI / 2;
        m.position.set(s * 0.215, 0.56, -0.95);
        this.object.add(m);
      }
    }
  }

  private buildWheels(): void {
    const tyreMat = sharedTyre!, rimMat = sharedRim!;
    // [side (+1 left), axle (+1 front), isFront] in FL FR RL RR order
    const specs: [number, number, boolean][] = [[1, 1, true], [-1, 1, true], [1, -1, false], [-1, -1, false]];
    for (const [side, axle, front] of specs) {
      const w = front ? FRONT_W : REAR_W;
      const g = wheelGeos(w);
      const group = new THREE.Group();
      group.position.set(side * HALF_TRACK, WHEEL_RADIUS, axle * WHEELBASE / 2);
      const spin = new THREE.Group();
      group.add(spin);

      const tyre = new THREE.Mesh(g.tyre, tyreMat); tyre.castShadow = true; spin.add(tyre);
      spin.add(new THREE.Mesh(g.rim, rimMat));
      const cover = new THREE.Mesh(g.cover, rimMat);
      cover.position.x = side * (w * 0.46);
      if (side < 0) cover.rotation.y = Math.PI;
      spin.add(cover);

      // coloured compound stripe on the outer sidewall
      const sg = new THREE.RingGeometry(0.26, 0.31, 20);
      sg.rotateY(Math.PI / 2);
      this.geos.push(sg);
      const stripe = new THREE.Mesh(sg, this.stripeMat);
      stripe.position.x = side * (w / 2 + 0.002);
      spin.add(stripe);

      // brake disc (inboard, glows)
      const dg = new THREE.CylinderGeometry(0.15, 0.15, 0.02, 14);
      dg.rotateZ(Math.PI / 2);
      this.geos.push(dg);
      const disc = new THREE.Mesh(dg, this.discMat);
      disc.position.x = -side * (w * 0.4);
      spin.add(disc);

      this.object.add(group);
      this.wheels.push({ group, spin, front, restY: WHEEL_RADIUS });
    }
  }

  private setCompound(c: TyreCompound): void {
    this.compound = c;
    this.stripeMat.color.setHex(COMPOUND_COLORS[c]);
  }

  update(pose: CarPose, opts?: { brake?: number; compound?: TyreCompound; rainLight?: boolean }): void {
    this.object.position.copy(pose.position);
    this.object.quaternion.copy(pose.quaternion);
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.group.position.y = w.restY - (pose.wheelCompression[i] ?? 0);
      w.group.rotation.y = w.front ? pose.steerAngle : 0;
      w.spin.rotation.x = pose.wheelSpin[i] ?? 0;
    }
    if (opts) {
      if (opts.compound && opts.compound !== this.compound) this.setCompound(opts.compound);
      const brake = opts.brake ?? 0;
      this.heat = brake > 0.8 ? Math.min(1, this.heat + 0.05) : Math.max(0, this.heat - 0.02);
      this.discMat.emissiveIntensity = this.heat * 2.2;
      if (opts.rainLight) {
        const on = Math.floor(performance.now() / 250) % 2 === 0;
        this.rainMat.emissiveIntensity = on ? 3 : 0.3;
      } else {
        this.rainMat.emissiveIntensity = 0;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.geos) g.dispose();
    for (const m of this.ownMats) m.dispose();
    for (const t of this.textures) t.dispose();
    releaseTeamMats(this.team);
    this.object.removeFromParent();
  }
}

/** Triangle count of an object tree (for tests / budgets). */
export function countTriangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) {
      const g = m.geometry;
      n += g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
    }
  });
  return Math.round(n);
}
