# Architecture & module contracts

Shared types live in `src/types.ts`. Read that first. This file pins each module's **public API**.
Modules may add private helpers freely, but must export exactly these names and signatures so
`src/game/` can wire them together. Three.js (`three`) is the only rendering dependency; physics,
AI, session, weather and track *runtime* code must run in Node (Vitest) with no DOM.

## Module map and ownership

| Dir | Purpose | Depends on |
|---|---|---|
| `src/physics/` | Vehicle dynamics (no rendering) | types, three math |
| `src/track/track.ts` | Track runtime from CircuitData (no rendering) | types, three math |
| `src/track/trackMesh.ts`, `scenery.ts` | Low-poly track/scenery meshes | track.ts, three |
| `scripts/import-circuits.mjs` → `public/circuits/` | GeoJSON → CircuitData JSON | — |
| `src/data/grid.ts` | Teams & drivers | types |
| `src/render/` | Renderer, sky/time-of-day, rain, car meshes, cameras | three, types, data |
| `src/ai/` | AI drivers | types, track (ITrack) |
| `src/session/` | Timing, session rules, pit stops | types |
| `src/weather/` | Weather simulation | types |
| `src/input/` | Keyboard / gamepad / wheel | types |
| `src/audio/` | Engine & tyre sounds (WebAudio) | types |
| `src/ui/` | DOM menus, HUD, telemetry, setup, settings | types, data |
| `src/net/` | PeerJS multiplayer | types, peerjs |
| `src/game/` | Orchestration (main loop) | everything |

## src/physics

```ts
// src/physics/car.ts
export interface CarParams {
  massKg: number;            // 768 incl. driver, without fuel (2026 min ~768)
  wheelbaseM: number;        // 3.4
  trackFrontM: number;       // 1.60
  trackRearM: number;        // 1.55
  cgHeightM: number;         // 0.28
  weightDistFront: number;   // 0.445
  inertia: [number, number, number]; // kg·m² about local X (pitch), Y (yaw), Z (roll)
  wheelRadiusM: number;      // 0.36 (18" rim)
  maxSteerDeg: number;       // road-wheel lock, ~17
  icePowerKw: number;        // ~400
  ersPowerKw: number;        // 350
  ersCapacityMJ: number;     // 4 (usable per lap budget handled via harvest)
  maxRpm: number;            // 15000 (11000 is the 2026 limit; use 11500 redline feel)
  gearRatios: number[];      // 8 forward
  finalDrive: number;
  dragCoef: number;          // CdA in m² (high downforce mode) ~1.1
  dragCoefStraight: number;  // CdA in straight mode ~0.75
  liftCoef: number;          // ClA in m² ~3.5 (downforce), straight mode reduces it
  liftCoefStraight: number;  // ~1.9
  aeroBalanceFront: number;  // ~0.40
}
export const DEFAULT_CAR_PARAMS: CarParams;
export function defaultSetup(): CarSetup;   // a balanced setup, medium tyres, 60 kg fuel

export class Car {
  constructor(opts: { setup: CarSetup; performance: TeamPerformance; params?: Partial<CarParams> });
  readonly pose: CarPose;          // refreshed after every step()
  readonly telemetry: Telemetry;   // refreshed after every step()
  tyres: TyreState[];              // 4
  fuelKg: number;
  ersSoc: number;                  // 0..1
  setup: CarSetup;
  /** Place stationary on the ground at (x, ground height, z), yaw `heading` (0 faces +Z). Gear 1. */
  reset(x: number, z: number, heading: number, ground: GroundQuery): void;
  /** Advance by dt seconds (expected 1/240). `straightModeAllowed` = car is inside a track aero zone. */
  step(dt: number, c: Controls, ground: GroundQuery, env: Environment, straightModeAllowed: boolean): void;
  /** Velocity along the car's forward axis, m/s. */
  forwardSpeed(): number;
  /** Instant pit-stop service. */
  fitTyres(compound: TyreCompound): void;
  addFuel(kg: number): void;
  setSetup(s: CarSetup): void;
  /** Collision response hooks used by resolveCarCollisions. */
  applyImpulse(impulse: Vector3, worldPoint: Vector3): void;
  translate(dx: number, dy: number, dz: number): void;
  get massKg(): number;           // current mass incl. fuel
  /** Freeze the car (pit stop / pre-race hold): zero velocities, ignore controls until released. */
  hold: boolean;
}

// src/physics/tyre.ts
export const COMPOUNDS: Record<TyreCompound, { grip: number; wearRate: number; optimalTempC: number; tempWindowC: number; wetGrip: number; color: string }>;
export function newTyre(compound: TyreCompound, pressurePsi: number): TyreState;
/** Pacejka-style combined-slip force. Returns local tyre forces in N (fx longitudinal, fy lateral). */
export function tyreForce(slipRatio: number, slipAngle: number, loadN: number, tyre: TyreState, surfaceGrip: number, camberRad: number): { fx: number; fy: number };

// src/physics/collisions.ts
export interface CollisionBody { id: string; position: Vector3; quaternion: Quaternion; velocity: Vector3; car: Car | null /* null = kinematic (remote) */ }
/** Car-vs-car: each car = 2 circles (r 0.9 m) at ±1.6 m along forward. Pushes apart and exchanges impulse. */
export function resolveCarCollisions(bodies: CollisionBody[]): void;
```

Physics targets (tests must check): standing 0–100 km/h ≈ 2.4–2.8 s; top speed 330–350 km/h in straight mode,
~310 without; steady-state cornering ≥ 4.5 g lateral at 250 km/h on dry softs; 200→0 km/h stop in < 70 m;
a parked car with neutral controls stays still (no drift/jitter) for 10 s; keyboard-style full lock at
30 km/h does not flip the car.

## src/track

```ts
// src/track/track.ts
export class Track implements ITrack {
  constructor(data: CircuitData);              // resamples to ~2 m Catmull-Rom spline, builds frames
  static async load(id: string, baseUrl?: string): Promise<Track>;  // fetch `${baseUrl}circuits/${id}.json`
  // ...ITrack members
}
export async function loadCircuitIndex(baseUrl?: string): Promise<CircuitIndexEntry[]>;
// baseUrl defaults to import.meta.env.BASE_URL when available, else './'

// src/track/trackMesh.ts
/** Whole static circuit world: road, kerbs, run-off, barriers, pit lane + boxes, start line, grid
 *  boxes, terrain ground, scenery & landmarks. Flat-shaded low-poly, merged/instanced geometry. */
export function buildTrackScene(track: Track, opts?: { quality: 'low' | 'medium' | 'high' }): THREE.Group;
```

Surfaces (`GroundQuery.sample`): asphalt inside halfWidth; kerb for 1.2 m beyond the edge where
|curvature| > 1/250 (and at the corresponding inside apex); then run-off type per zone; past run-off
width → 'wall' via `barrier()`. Pit lane counts as 'pitlane'. Height comes from the interpolated
centreline elevation (flat across the width, slight 2% crown not required).

## src/data/grid.ts

```ts
export const TEAMS: Team[];       // 11 teams, 2026 grid
export const DRIVERS: Driver[];   // 22 drivers
export function teamById(id: string): Team;
export function driverById(id: string): Driver;
```

## src/render

```ts
// src/render/renderer.ts
export class Renderer {
  constructor(canvas: HTMLCanvasElement);
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  setTrack(group: THREE.Group | null): void;
  setQuality(q: 'low' | 'medium' | 'high'): void;
  /** Sun position from timeOfDay + latLon, sky colour, fog, ambient, night floodlights (street/night tracks), rain particles & wet road tint. */
  setWeather(w: WeatherState, latLon: [number, number], nightLights: boolean): void;
  render(): void;
  resize(): void;
}

// src/render/carMesh.ts
export class CarVisual {
  constructor(team: Team, number: number, driverCode: string);
  readonly object: THREE.Object3D;
  /** Pose, steering, wheel spin & suspension; brake glow and rain light from telemetry if given. */
  update(pose: CarPose, opts?: { brake?: number; compound?: TyreCompound; rainLight?: boolean }): void;
  dispose(): void;
}

// src/render/cameras.ts
export type CameraMode = 'chase' | 'tcam' | 'cockpit' | 'nose' | 'tv';
export class CameraRig {
  constructor(camera: THREE.PerspectiveCamera);
  mode: CameraMode;
  cycle(): void;
  /** Smooth follow of the target pose; `trackFrame` supplied for TV camera placement. */
  update(dt: number, target: CarPose, lookBack: boolean, speedKmh: number): void;
}
```

## src/ai

```ts
// src/ai/aiDriver.ts
export interface AIPerception {
  s: number; lateral: number; speed: number;            // self, from Track.project
  pose: CarPose; telemetry: Telemetry;
  others: { id: string; s: number; lateral: number; speed: number }[];  // nearby cars
  phase: SessionPhase;
  wantPit: boolean;                                      // strategy decided to box this lap
  pitLimitKmh: number;
}
export class AIDriver {
  constructor(track: ITrack, driver: Driver, skillMul: number, seed: number);
  update(dt: number, p: AIPerception): Controls;
}
/** Grip-limited target speed per track sample (m/s) for the racing line; mu ≈ peak lateral g. */
export function computeSpeedProfile(track: ITrack, mu: number, downforceFactor: number): Float32Array;

// src/ai/strategy.ts
export function planStrategy(laps: number, wearMul: number, wet: boolean, seed: number): { stopLaps: number[]; compounds: TyreCompound[] };
```

## src/session

```ts
// src/session/session.ts
export interface CarTrackState {
  entryId: string;
  s: number; lateral: number; onTrack: boolean; inPitLane: boolean;
  speedKmh: number; compound: TyreCompound; lapDistanceValid: boolean;
}
export type SessionEvent =
  | { type: 'lap'; entryId: string; lap: LapRecord; personalBest: boolean; sessionBest: boolean }
  | { type: 'sector'; entryId: string; sector: 0 | 1 | 2; ms: number; personalBest: boolean; sessionBest: boolean }
  | { type: 'trackLimits'; entryId: string }
  | { type: 'lightsOut' }
  | { type: 'chequered' }
  | { type: 'finished'; entryId: string; position: number }
  | { type: 'sessionOver' }
  | { type: 'pitEntry' | 'pitExit'; entryId: string };
export class Session {
  constructor(config: SessionConfig, entries: Entry[], trackLength: number, sectors: [number, number]);
  readonly entries: Entry[];
  /** dtMs of sim time. cars: one per entry. Returns events this step. Handles start lights (race),
   *  lap timing by s wrap-around, sectors, track-limits invalidation, positions, gaps, chequered flag. */
  update(dtMs: number, cars: CarTrackState[]): SessionEvent[];
  snapshot(): SessionSnapshot;
  /** Race: true while cars must be held on the grid (pre/lights). */
  carsHeld(): boolean;
  /** Network clients apply host snapshots. */
  applySnapshot(s: SessionSnapshot): void;
}
/** Qualifying knockout: entries eliminated after Q1 (last 6 of 22 → scale with field) and Q2. */
export function qualifyingCut(timing: EntryTiming[], part: QualiPart, fieldSize: number): string[];

// src/session/pit.ts
export class PitStop {
  /** Starts when a car stops in its box; returns duration in ms (2.0–3.5 s with jitter, + fuel time). */
  static serviceTimeMs(changeTyres: boolean, fuelKg: number, rng: () => number): number;
}
```

## src/weather

```ts
// src/weather/weather.ts
export class Weather {
  constructor(mode: SessionConfig['weather'], circuit: CircuitData, startTimeOfDay: number, timeScale: number, seed: number);
  readonly state: WeatherState;
  update(dtSec: number, carsOnTrack: number): void;   // rain evolves, wetness rises with rain, dries with sun+cars, rubber builds
  environment(): Environment;
  applyState(s: WeatherState): void;                  // network clients
}
```

## src/input

```ts
// src/input/inputManager.ts
export interface InputSettings {
  device: 'auto' | InputDeviceKind;
  steerSensitivity: number; steerLinearity: number; deadzone: number;
  wheelRotationDeg: number;          // physical wheel rotation, 900 typical
  invertThrottle: boolean; invertBrake: boolean; combinedPedals: boolean;
  bindings: Record<string, { device: InputDeviceKind; kind: 'key' | 'button' | 'axis'; code: string | number; dir?: 1 | -1 }>;
  autoGearbox: boolean; tractionControl: number; absAssist: boolean; steeringAssist: number;
}
export class InputManager {
  constructor();
  settings: InputSettings;            // persisted in localStorage 'f1.input'
  /** Call once per rendered frame. Keyboard steering is rate-limited & speed-sensitive. */
  poll(dt: number, speedKmh: number): { controls: Controls; ui: UiActions; device: InputDeviceKind; deviceName: string };
  /** Listen for the next pressed key/button/axis movement (for rebinding). */
  captureNext(): Promise<{ device: InputDeviceKind; kind: 'key' | 'button' | 'axis'; code: string | number; dir?: 1 | -1 }>;
  rumble(strong: number, weak: number, ms: number): void;
  save(): void;
}
// Assists (auto gearbox / TC / ABS) are applied by src/game, using helpers exported from src/input/assists.ts:
export function applyAssists(c: Controls, t: Telemetry, s: InputSettings): Controls;
```

## src/audio

```ts
// src/audio/engineAudio.ts
export class EngineAudio {
  constructor();                     // creates AudioContext lazily on first user gesture via resume()
  resume(): void;
  /** Player car: rpm, throttle, gear, skid (max wheel slip), surface rumble, speed. */
  update(t: Telemetry): void;
  setVolume(v: number): void;
  mute(m: boolean): void;
}
```

## src/ui

All UI is DOM over the canvas inside `#ui`. Styling in `src/ui/styles.css` (imported by `src/main.ts`).

```ts
// src/ui/menu.ts
export interface MenuCallbacks {
  startSession(config: SessionConfig, playerDriverId: string, setup: CarSetup): void;
  startWeekend(base: SessionConfig, playerDriverId: string, setup: CarSetup): void; // FP → Q1-3 → Race
  hostMultiplayer(name: string, driverId: string): void;
  joinMultiplayer(code: string, name: string, driverId: string): void;
}
export class Menu {
  constructor(root: HTMLElement, circuits: CircuitIndexEntry[], input: InputManager, cb: MenuCallbacks);
  show(): void; hide(): void;
  showResults(snapshot: SessionSnapshot, entries: Entry[], next?: { label: string; onClick: () => void }): void;
  /** Multiplayer lobby screen, driven by src/game. */
  showLobby(state: { code: string; isHost: boolean; players: { name: string; driverId: string; ready: boolean }[]; config: SessionConfig },
            actions: { setReady(r: boolean): void; setConfig(c: SessionConfig): void; start(): void; leave(): void }): void;
}

// src/ui/hud.ts
export class Hud {
  constructor(root: HTMLElement);
  show(): void; hide(): void;
  /** Timing tower, lap/sector times, delta, speed/gear/RPM lights, ERS & fuel, tyre temps/wear,
   *  weather icon, session clock, start lights, messages. */
  update(s: SessionSnapshot, entries: Entry[], playerId: string, t: Telemetry, w: WeatherState, deltaMs: number | null): void;
  message(text: string, ms?: number, kind?: 'info' | 'good' | 'bad' | 'purple'): void;
}

// src/ui/telemetryPanel.ts
export class TelemetryPanel {         // toggled with T: scrolling graphs of speed, throttle/brake, steer, g, tyre temps
  constructor(root: HTMLElement);
  toggle(): void;
  push(t: Telemetry, s: number): void;
}

// src/ui/pause.ts
export class PauseMenu {
  constructor(root: HTMLElement, input: InputManager);
  open(actions: { resume(): void; restart(): void; quit(): void; setup?: (s: CarSetup) => void; pitStrategy?: { compound: TyreCompound; fuelKg: number; set(c: TyreCompound, fuel: number): void } }, setup: CarSetup): void;
  close(): void;
  readonly isOpen: boolean;
}

// src/ui/setupEditor.ts
export function renderSetupEditor(container: HTMLElement, setup: CarSetup, onChange: (s: CarSetup) => void): void;
// setups persisted per circuit in localStorage 'f1.setup.<circuitId>'
```

## src/net

```ts
// src/net/net.ts
export class NetSession {
  static host(name: string): Promise<NetSession>;          // room code = short 6-char code mapped to peer id 'afg-<code>'
  static join(code: string, name: string): Promise<NetSession>;
  readonly isHost: boolean;
  readonly code: string;
  readonly selfId: string;
  readonly peers: string[];
  send(msg: NetMessage, to?: string): void;                // client: to host; host: to `to` or broadcast
  on(handler: (msg: NetMessage, from: string) => void): void;
  onPeerChange(handler: (peers: string[]) => void): void;
  close(): void;
}
// src/net/interp.ts — snapshot buffer for remote cars
export class RemoteCarBuffer {
  push(s: NetCarState, localNowMs: number): void;
  /** Interpolated pose ~100 ms in the past, extrapolated (≤250 ms) when packets are late. */
  sample(localNowMs: number): CarPose | null;
}
```
