// WebGL renderer: scene, lighting, sky dome, weather (fog, rain), quality presets.
import * as THREE from 'three';
import type { WeatherState } from '../types';

export type Quality = 'low' | 'medium' | 'high';

const SHADOW_HALF = 60;        // 120 m shadow box
const RAIN_BOX = 50;           // rain volume edge around the camera, metres
const RAIN_HEIGHT = 28;
const RAIN_MAX = 6000;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunVis;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col;
  if (h >= 0.0) {
    float t = pow(clamp(h, 0.0, 1.0), 0.45);
    col = mix(uHorizon, uZenith, t);
  } else {
    col = mix(uHorizon, uGround, clamp(-h * 6.0, 0.0, 1.0));
  }
  float sd = max(dot(d, uSunDir), 0.0);
  float glow = pow(sd, 6.0) * 0.25 + pow(sd, 64.0) * 0.4;
  float disc = smoothstep(0.99965, 0.9999, sd);
  col += uSunColor * (glow + disc * 6.0) * uSunVis;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly gl: THREE.WebGLRenderer;

  private canvas: HTMLCanvasElement;
  private trackGroup: THREE.Group | null = null;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private skyMat: THREE.ShaderMaterial;
  private sky: THREE.Mesh;
  private stars: THREE.Points;
  private starMat: THREE.PointsMaterial;
  private fog = new THREE.Fog(0xaec6e0, 300, 3000);

  private rain: THREE.LineSegments;
  private rainGeo: THREE.BufferGeometry;
  private rainMat: THREE.LineBasicMaterial;
  private rainPos: Float32Array;
  private rainSeed: Float32Array;     // per-drop speed factor
  private rainFrac = 0;               // 0..1 intensity
  private rainMaxCount = RAIN_MAX;
  private rainVisible = 0;

  private quality: Quality = 'high';
  private sunDir = new THREE.Vector3(0.3, 0.8, 0.3).normalize();
  private shadowFocus = new THREE.Vector3();
  private lastTime = performance.now();
  private tmpC = new THREE.Color();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.2, 7000);
    this.scene.add(this.camera);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(0x87aedc);

    // lights
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4a4636, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 3);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF;
    sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun, this.sun.target);

    // sky dome
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color(0x3a74c8) },
        uHorizon: { value: new THREE.Color(0xaec6e0) },
        uGround: { value: new THREE.Color(0x555a50) },
        uSunDir: { value: this.sunDir.clone() },
        uSunColor: { value: new THREE.Color(0xfff0cc) },
        uSunVis: { value: 1 },
      },
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 24, 12), this.skyMat);
    this.sky.renderOrder = -100;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // stars
    const sp = new Float32Array(1200 * 3);
    for (let i = 0; i < 1200; i++) {
      const u = Math.random(), v = Math.random() * 0.97 + 0.03; // upper hemisphere only
      const a = u * Math.PI * 2, r = Math.sqrt(1 - v * v);
      sp[i * 3] = Math.cos(a) * r * 4800;
      sp[i * 3 + 1] = v * 4800;
      sp[i * 3 + 2] = Math.sin(a) * r * 4800;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false,
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.renderOrder = -99;
    this.stars.frustumCulled = false;
    this.stars.visible = false;
    this.scene.add(this.stars);

    // rain
    this.rainPos = new Float32Array(RAIN_MAX * 6);
    this.rainSeed = new Float32Array(RAIN_MAX);
    for (let i = 0; i < RAIN_MAX; i++) {
      const x = (Math.random() - 0.5) * RAIN_BOX * 2;
      const y = Math.random() * RAIN_HEIGHT - 4;
      const z = (Math.random() - 0.5) * RAIN_BOX * 2;
      this.rainSeed[i] = 0.8 + Math.random() * 0.4;
      this.rainPos.set([x, y, z, x, y, z], i * 6);
    }
    this.rainGeo = new THREE.BufferGeometry();
    this.rainGeo.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.rainMat = new THREE.LineBasicMaterial({ color: 0xb8cce0, transparent: true, opacity: 0.4, fog: false, depthWrite: false });
    this.rain = new THREE.LineSegments(this.rainGeo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.scene.add(this.rain);

    this.setQuality('high');
    this.setWeather(
      { cloud: 0.1, rain: 0, wetness: 0, rubber: 0, airTempC: 22, trackTempC: 30, timeOfDay: 14, forecast: [] },
      [45, 10], false,
    );
    this.resize();
  }

  // ---------------------------------------------------------------- public API

  setTrack(group: THREE.Group | null): void {
    if (this.trackGroup) this.scene.remove(this.trackGroup);
    this.trackGroup = group;
    if (group) this.scene.add(group);
  }

  addObject(o: THREE.Object3D): void { this.scene.add(o); }
  removeObject(o: THREE.Object3D): void { this.scene.remove(o); }

  setQuality(q: Quality): void {
    this.quality = q;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const ratio = q === 'low' ? 0.75 : q === 'medium' ? 1 : Math.min(dpr, 2);
    this.gl.setPixelRatio(ratio);
    const size = q === 'low' ? 0 : q === 'medium' ? 1024 : 2048;
    const shadow = this.sun.shadow;
    if (size === 0) {
      this.sun.castShadow = false;
    } else {
      this.sun.castShadow = true;
      if (shadow.mapSize.x !== size) {
        shadow.mapSize.set(size, size);
        if (shadow.map) { shadow.map.dispose(); shadow.map = null; }
      }
    }
    this.rainMaxCount = q === 'low' ? 1500 : q === 'medium' ? 3500 : RAIN_MAX;
    this.applyRainCount();
    this.resize();
  }

  /** Move the shadow frustum so it follows a world position (usually the player car). */
  setShadowFocus(v: THREE.Vector3): void {
    this.shadowFocus.copy(v);
    this.placeSun();
  }

  setWeather(w: WeatherState, latLon: [number, number], nightLights: boolean): void {
    // ---- sun position (approximate solar geometry, mid-summer declination)
    const lat = THREE.MathUtils.degToRad(latLon[0]);
    const dec = THREE.MathUtils.degToRad(15);
    const hour = THREE.MathUtils.degToRad((w.timeOfDay - 12) * 15);
    const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hour);
    const el = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1));
    const az = Math.atan2(Math.sin(hour), Math.cos(hour) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)); // from south, westward +
    const A = az + Math.PI; // from north, clockwise
    this.sunDir.set(Math.sin(A) * Math.cos(el), Math.sin(el), -Math.cos(A) * Math.cos(el)).normalize();
    const elDeg = THREE.MathUtils.radToDeg(el);

    const day = smooth(-4, 12, elDeg);              // 0 night .. 1 full day
    const golden = Math.max(0, 1 - Math.abs(elDeg - 3) / 12) * (1 - w.cloud * 0.6);
    const night = 1 - smooth(-14, -2, elDeg) ;      // 1 deep night
    const cloud = THREE.MathUtils.clamp(w.cloud, 0, 1);
    const overcast = Math.max(cloud, w.rain * 0.9);

    // ---- sky colours
    const zenith = new THREE.Color(0x2f6fd0).lerp(new THREE.Color(0x4a78b8), golden * 0.7);
    const horizon = new THREE.Color(0xb4cde6).lerp(new THREE.Color(0xff9a52), golden);
    const nz = new THREE.Color(0x040916), nh = new THREE.Color(0x121c38);
    const dayAmt = Math.max(day, golden * 0.7);
    zenith.lerp(nz, 1 - dayAmt);
    horizon.lerp(nh, 1 - dayAmt);
    const grey = 0.35 + 0.5 * day;
    const greyCol = this.tmpC.setRGB(grey * 0.78, grey * 0.8, grey * 0.84);
    zenith.lerp(greyCol, overcast * 0.85);
    horizon.lerp(greyCol.multiplyScalar(1.1), overcast * 0.9);

    const u = this.skyMat.uniforms;
    (u.uZenith.value as THREE.Color).copy(zenith);
    (u.uHorizon.value as THREE.Color).copy(horizon);
    (u.uGround.value as THREE.Color).copy(horizon).multiplyScalar(0.55);
    (u.uSunDir.value as THREE.Vector3).copy(this.sunDir);
    (u.uSunColor.value as THREE.Color).setRGB(1, 0.9 - golden * 0.25, 0.7 - golden * 0.35);
    u.uSunVis.value = day * (1 - overcast * 0.95) * (elDeg > -1 ? 1 : 0);

    // ---- stars
    const starOp = night * (1 - overcast * 0.9);
    this.starMat.opacity = starOp;
    this.stars.visible = starOp > 0.02;

    // ---- lights
    const sunCol = new THREE.Color(0xfff4e0).lerp(new THREE.Color(0xff9d5a), golden);
    this.sun.color.copy(sunCol);
    this.sun.intensity = 3.2 * day * (1 - overcast * 0.75) + 0.0;
    if (day < 0.05) {
      // moonlight
      this.sun.color.set(0x8fa8ff);
      this.sun.intensity = 0.25 * (1 - overcast * 0.6);
    }
    const hSky = new THREE.Color(0xbfd8ff).lerp(new THREE.Color(0x8aa0d0), 1 - day);
    this.hemi.color.copy(hSky);
    this.hemi.groundColor.set(0x4a4636).multiplyScalar(0.4 + 0.6 * day);
    let hemiI = THREE.MathUtils.lerp(0.18, 0.9, day) * (1 + overcast * 0.35);
    if (nightLights) hemiI = Math.max(hemiI, 0) + (1 - day) * 1.6; // floodlight fill
    this.hemi.intensity = hemiI;
    this.gl.toneMappingExposure = 1.0 - overcast * 0.08;

    // ---- fog and background
    const fogCol = horizon.clone();
    this.fog.color.copy(fogCol);
    this.fog.near = THREE.MathUtils.lerp(250, 15, Math.min(1, w.rain * 1.1 + cloud * 0.1));
    this.fog.far = THREE.MathUtils.lerp(3200, 380, Math.min(1, w.rain)) * (1 - 0.25 * cloud);
    (this.scene.background as THREE.Color).copy(fogCol);

    // ---- rain
    this.rainFrac = THREE.MathUtils.clamp(w.rain, 0, 1);
    this.applyRainCount();
    this.rainMat.color.copy(fogCol).lerp(new THREE.Color(0xdde8f4), 0.5);
    this.rainMat.opacity = 0.25 + 0.3 * day;

    this.placeSun();
  }

  render(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    // sky follows camera
    this.sky.position.copy(this.camera.position);
    this.stars.position.copy(this.camera.position);

    if (this.rain.visible) this.stepRain(dt);
    this.gl.render(this.scene, this.camera);
  }

  resize(): void {
    const c = this.canvas;
    const w = Math.max(1, c.clientWidth || c.width || 1);
    const h = Math.max(1, c.clientHeight || c.height || 1);
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- internals

  private placeSun(): void {
    const dir = this.sunDir.y > -0.03 ? this.sunDir : new THREE.Vector3(-this.sunDir.x, Math.abs(this.sunDir.y) + 0.4, -this.sunDir.z).normalize();
    // keep the light from grazing too low (stretched shadows / artefacts)
    const d = dir.clone();
    if (d.y < 0.15) { d.y = 0.15; d.normalize(); }
    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(d, 200);
    this.sun.target.updateMatrixWorld();
  }

  private applyRainCount(): void {
    const n = Math.floor(this.rainMaxCount * this.rainFrac);
    this.rainVisible = n;
    this.rainGeo.setDrawRange(0, n * 2);
    this.rain.visible = n > 0;
  }

  private stepRain(dt: number): void {
    const p = this.rainPos;
    const n = this.rainVisible;
    const wind = 3;
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const sp = 22 * this.rainSeed[i];
      let x = p[o] + wind * dt, y = p[o + 1] - sp * dt, z = p[o + 2];
      if (y < -4) {
        y += RAIN_HEIGHT;
        x = (Math.random() - 0.5) * RAIN_BOX * 2;
        z = (Math.random() - 0.5) * RAIN_BOX * 2;
      }
      if (x > RAIN_BOX) x -= RAIN_BOX * 2;
      p[o] = x; p[o + 1] = y; p[o + 2] = z;
      p[o + 3] = x - wind * 0.025; p[o + 4] = y + sp * 0.025; p[o + 5] = z; // streak tail (above head)
    }
    this.rainGeo.attributes.position.needsUpdate = true;
    // volume centred under the camera (ground approx. at camera height - 2.5)
    this.rain.position.set(this.camera.position.x, this.camera.position.y - 2, this.camera.position.z);
  }
}
