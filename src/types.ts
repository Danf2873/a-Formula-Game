// Shared contracts between modules. Every module imports its cross-module types from here.
//
// World conventions:
//   - Units: metres, seconds, kilograms, newtons, radians. Speeds in m/s unless the name says Kmh.
//   - World axes: +Y up. The track lies in the XZ plane; Y is elevation.
//   - Car local axes: +X left, +Y up, +Z forward (right-handed). A car at identity rotation faces +Z.
//   - Wheel index order everywhere: 0 FL, 1 FR, 2 RL, 3 RR.
//   - Track distance `s` is metres along the centreline from the start/finish line, in [0, length).
//   - Track lateral offset is metres from the centreline, positive = LEFT of the racing direction.

import type { Vector3, Quaternion } from 'three';

// ---------------------------------------------------------------- input

/** Normalised driver controls. Produced by InputManager (human), AIDriver or a network snapshot. */
export interface Controls {
  steer: number;        // -1 full right .. +1 full left  (matches +X = left)
  throttle: number;     // 0..1
  brake: number;        // 0..1
  shiftUp: boolean;     // edge-triggered: true for exactly one sim step per press
  shiftDown: boolean;   // edge-triggered
  boost: boolean;       // held: 2026 manual-override ERS deployment
  pitLimiter: boolean;  // toggle state (not edge)
}

export const NEUTRAL_CONTROLS: Controls = {
  steer: 0, throttle: 0, brake: 0, shiftUp: false, shiftDown: false, boost: false, pitLimiter: false,
};

/** Menu / camera actions that are not car controls. Edge-triggered. */
export interface UiActions {
  pause: boolean;
  camera: boolean;     // cycle camera
  lookBack: boolean;   // held
  ok: boolean;
  back: boolean;
}

export type InputDeviceKind = 'keyboard' | 'gamepad' | 'wheel';

// ---------------------------------------------------------------- surfaces & ground

export type SurfaceType = 'asphalt' | 'kerb' | 'grass' | 'gravel' | 'pitlane' | 'wall';

export interface GroundSample {
  height: number;        // world Y of the ground at this x,z
  normal: Vector3;       // unit, world space
  surface: SurfaceType;
}

/** What the vehicle physics needs from the world. Track implements it; tests use a flat plane. */
export interface GroundQuery {
  /** `hint` is a mutable cache the caller keeps per wheel to make lookups O(1) amortised. */
  sample(x: number, z: number, hint: { idx: number }): GroundSample;
  /** Barrier collision: returns a push-out (world XZ, metres) if the point is beyond the barrier, else null. */
  barrier(x: number, z: number, radius: number, hint: { idx: number }): { nx: number; nz: number; depth: number } | null;
}

/** Per-step environmental modifiers supplied by the weather system. */
export interface Environment {
  wetness: number;       // 0 dry .. 1 standing water (track surface)
  rubber: number;        // 0..1 rubbered-in racing line bonus
  airTempC: number;
  trackTempC: number;
}

// ---------------------------------------------------------------- tyres, setup, car

export type TyreCompound = 'soft' | 'medium' | 'hard' | 'inter' | 'wet';

export interface TyreState {
  compound: TyreCompound;
  wear: number;          // 0 new .. 1 destroyed (grip falls off sharply past ~0.75)
  tempC: number;         // surface/carcass blended temperature
  pressurePsi: number;   // hot pressure
}

/** Player-adjustable setup. Ranges in comments are the legal UI ranges. */
export interface CarSetup {
  frontWing: number;     // 0..10 (downforce/drag)
  rearWing: number;      // 0..10
  frontArb: number;      // 1..11
  rearArb: number;       // 1..11
  frontSpring: number;   // 1..11
  rearSpring: number;    // 1..11
  frontRideHeightMm: number; // 15..35
  rearRideHeightMm: number;  // 35..60
  frontCamberDeg: number;    // -3.5..-2.5
  rearCamberDeg: number;     // -2.0..-1.0
  frontToeDeg: number;       // 0..0.2 (toe-out)
  rearToeDeg: number;        // 0.1..0.5 (toe-in)
  brakeBias: number;         // 0.50..0.65 front fraction
  brakePressure: number;     // 0.80..1.00
  diffOnThrottle: number;    // 0.10..1.00 lock
  diffOffThrottle: number;   // 0.10..1.00 lock
  tyrePressurePsi: number;   // 21..26 (cold, all four)
  fuelKg: number;            // 5..110
  startCompound: TyreCompound;
}

/** Per-team performance modifiers on top of the shared 2026 car model. Values near 1.0. */
export interface TeamPerformance {
  power: number;         // ICE power multiplier
  downforce: number;     // downforce multiplier
  drag: number;          // drag multiplier (lower is better)
  tyreWear: number;      // wear rate multiplier (lower is better)
}

export interface Telemetry {
  speedKmh: number;
  rpm: number;
  gear: number;          // -1 reverse, 0 neutral, 1..8
  throttle: number;
  brake: number;
  steer: number;
  latG: number;
  longG: number;
  ersSoc: number;        // 0..1 battery state of charge
  ersDeployKw: number;
  fuelKg: number;
  straightMode: boolean; // 2026 active aero low-drag mode engaged
  tyres: TyreState[];    // 4, wheel order
  wheelSlip: number[];   // 4, combined slip magnitude (for UI / audio / skid marks)
  wheelLoadN: number[];  // 4
  surface: SurfaceType[];// 4
  pitLimiter: boolean;
}

/** Snapshot of a car's physical pose, used by rendering, AI perception and networking. */
export interface CarPose {
  position: Vector3;
  quaternion: Quaternion;
  velocity: Vector3;
  steerAngle: number;    // front wheel road angle, radians
  wheelSpin: number[];   // 4, accumulated wheel rotation angle (radians) for rendering
  wheelCompression: number[]; // 4, suspension travel in metres (+ = compressed) for rendering
}

// ---------------------------------------------------------------- track data (JSON on disk)

/** One circuit file: public/circuits/<id>.json. Produced by scripts/import-circuits.mjs. */
export interface CircuitData {
  id: string;            // e.g. 'monza'
  name: string;          // 'Autodromo Nazionale Monza'
  grandPrix: string;     // 'Italian Grand Prix'
  country: string;
  city: string;
  realLengthM: number;   // official lap length
  raceLaps: number;      // official race distance laps
  /** Closed centreline in racing direction, ~5 m spacing, first point ON the start/finish line.
   *  [x, y, z] metres; y = elevation. Do not repeat the first point at the end. */
  points: [number, number, number][];
  /** Half-width of the racing surface in metres. Default for the whole lap. */
  halfWidth: number;
  /** Optional overrides as fractions of lap distance [from, to) (may wrap: from > to). */
  widthZones: { from: number; to: number; halfWidth: number }[];
  /** Run-off beyond the asphalt edge, per side, by zone. Default 'grass' 12 m. */
  runoff: { from: number; to: number; side: 'left' | 'right' | 'both'; type: 'grass' | 'gravel' | 'asphalt' | 'wall'; widthM: number }[];
  defaultRunoff: { type: 'grass' | 'gravel' | 'asphalt' | 'wall'; widthM: number };
  /** Street circuits put walls close; this flags it for scenery and default run-off. */
  street: boolean;
  /** Sector boundaries as lap fractions, [s1End, s2End]. */
  sectors: [number, number];
  /** 2026 active-aero straight-mode zones as lap fractions [from, to). */
  aeroZones: { from: number; to: number }[];
  /** Pit lane: runs parallel to the main straight on `side`, offset from the centreline. */
  pit: {
    side: 'left' | 'right';
    entry: number;       // lap fraction where the pit lane splits off
    exit: number;        // lap fraction where it rejoins (may be < entry, wraps past s/f)
    offsetM: number;     // lateral distance from centreline to pit-lane centre
    speedLimitKmh: number; // 80 normally, 60 at Monaco etc.
  };
  /** Grid: pole at lap fraction `pole` counted backwards from the s/f line; 8 m between rows. */
  gridSpacingM: number;
  /** Climate for weather generation. */
  climate: { rainChance: number; airTempC: number };
  /** Default local time of day for the race, hours 0..24 (Singapore/Vegas/Bahrain/Qatar/Abu Dhabi/Jeddah are night). */
  raceTimeOfDay: number;
  /** Rough lat/lon of the circuit, for sun direction. */
  latLon: [number, number];
  /** Low-poly landmark hints for scenery: positions are lap fraction + lateral offset. */
  landmarks: { kind: 'grandstand' | 'tower' | 'bridge' | 'building' | 'ferris' | 'hotel' | 'trees' | 'water' | 'mountain'; at: number; offsetM: number; scale?: number }[];
}

/** List of circuits in calendar order: public/circuits/index.json */
export interface CircuitIndexEntry {
  id: string;
  round: number;
  name: string;
  grandPrix: string;
  country: string;
  realLengthM: number;
}

// ---------------------------------------------------------------- track runtime (src/track/track.ts)

export interface TrackFrame {
  s: number;             // distance along centreline
  position: Vector3;     // centreline point (with elevation)
  tangent: Vector3;      // unit, racing direction (XZ mostly, includes slope)
  left: Vector3;         // unit, horizontal, points to the left edge
  halfWidth: number;
  curvature: number;     // signed 1/m, + = turning left
}

export interface TrackProjection {
  s: number;             // distance along centreline of the closest point
  lateral: number;       // + = left of centreline
  idx: number;           // sample index (use as hint next call)
  onTrack: boolean;      // |lateral| <= halfWidth (+ small kerb allowance)
  surface: SurfaceType;
}

/** Public API of the Track runtime class. Implemented in src/track/track.ts. */
export interface ITrack extends GroundQuery {
  readonly data: CircuitData;
  readonly length: number;           // metres (centreline length after resampling)
  readonly sampleSpacing: number;    // metres between samples (~2)
  readonly sampleCount: number;
  frameAt(s: number): TrackFrame;    // interpolated, s wraps
  project(x: number, z: number, hint: { idx: number }): TrackProjection;
  /** Racing line lateral offset (metres, + left) at sample i; computed once at build time. */
  racingLineOffset(s: number): number;
  /** Pit lane: world position along the pit lane for parameter t in [0,1] from entry to exit. */
  pitLanePoint(t: number): Vector3;
  isInPitLane(x: number, z: number, hint: { idx: number }): boolean;
  /** Grid slot world transform for position p (0 = pole). */
  gridSlot(p: number): { position: Vector3; heading: number }; // heading = yaw about +Y, 0 faces +Z
  /** Pit box world transform for team slot k (0..10). */
  pitBox(k: number): { position: Vector3; heading: number; t: number };
  sectorOf(s: number): 0 | 1 | 2;
  inAeroZone(s: number): boolean;
}

// ---------------------------------------------------------------- teams & drivers (src/data/grid.ts)

export interface Team {
  id: string;            // 'mclaren'
  name: string;          // 'McLaren'
  fullName: string;
  engine: string;        // power unit supplier
  colors: { primary: string; secondary: string; accent: string }; // CSS hex
  performance: TeamPerformance;
}

export interface Driver {
  id: string;            // 'norris'
  firstName: string;
  lastName: string;
  code: string;          // 'NOR'
  number: number;
  teamId: string;
  nationality: string;   // ISO alpha-3, e.g. 'GBR'
  skill: number;         // 0.80..1.00 AI pace
  aggression: number;    // 0..1 AI racecraft
}

// ---------------------------------------------------------------- sessions & timing

export type SessionKind = 'practice' | 'qualifying' | 'race' | 'timetrial';
export type QualiPart = 'Q1' | 'Q2' | 'Q3';

export interface SessionConfig {
  kind: SessionKind;
  circuitId: string;
  /** Practice/quali: minutes. Race: ignored. */
  durationMin: number;
  /** Race only. */
  laps: number;
  aiCount: number;       // 0..21
  aiSkill: number;       // 0.7..1.1 global multiplier on driver.skill
  weather: 'dry' | 'changeable' | 'wet' | 'random';
  timeOfDay: number;     // hours; NaN = circuit default
  timeScale: number;     // time-of-day progression multiplier (1 = real time)
  tyreWearMul: number;   // 0 off, 1 real, up to 3
  fuelMul: number;       // 0 off, 1 real, up to 3
  /** Race: starting grid order of entry ids (from qualifying), or empty for random/skill order. */
  gridOrder: string[];
  qualiPart?: QualiPart;
}

/** A car in a session: the human player, a remote human, or AI. */
export interface Entry {
  id: string;            // unique in session, e.g. driver id, or 'p:<peerId>'
  driverId: string;      // which Driver record supplies name/number/team (human picks one)
  displayName: string;
  teamId: string;
  kind: 'player' | 'remote' | 'ai';
}

export interface LapRecord {
  lap: number;           // 1-based
  timeMs: number;
  sectorsMs: [number, number, number];
  valid: boolean;        // false if track limits were exceeded
  compound: TyreCompound;
}

export interface EntryTiming {
  entryId: string;
  position: number;      // 1-based, current classification
  lapsCompleted: number;
  currentLapStartMs: number;
  currentSectors: (number | null)[];
  currentLapValid: boolean;
  lastLap: LapRecord | null;
  bestLap: LapRecord | null;
  laps: LapRecord[];
  totalDistance: number; // laps*length + s, metres; used for race order
  gapToLeaderMs: number;
  intervalMs: number;    // to car ahead
  pitStops: number;
  inPit: boolean;
  finished: boolean;
  finishTimeMs: number | null;
  compoundsUsed: TyreCompound[];
  penaltyMs: number;
}

export type SessionPhase = 'pre' | 'formation' | 'lights' | 'running' | 'chequered' | 'finished';

export interface SessionSnapshot {
  config: SessionConfig;
  phase: SessionPhase;
  elapsedMs: number;     // session clock
  remainingMs: number;   // practice/quali countdown; race: NaN
  lightsOn: number;      // 0..5 for start lights
  timing: EntryTiming[]; // sorted by position
  sessionBestMs: number | null;
  sessionBestSectorsMs: [number | null, number | null, number | null];
}

// ---------------------------------------------------------------- weather

export interface WeatherState {
  cloud: number;         // 0..1
  rain: number;          // 0..1 current rain intensity
  wetness: number;       // 0..1 track water
  rubber: number;        // 0..1
  airTempC: number;
  trackTempC: number;
  timeOfDay: number;     // hours 0..24
  forecast: { inMin: number; rain: number }[]; // next ~30 min
}

// ---------------------------------------------------------------- networking

export interface NetCarState {
  id: string;            // entry id
  t: number;             // sender session time ms
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number];
  steer: number;
  speedKmh: number;
  gear: number;
  brake: number;
  compound: TyreCompound;
  inPit: boolean;
}

export type NetMessage =
  | { type: 'hello'; name: string; driverId: string; version: string }
  | { type: 'lobby'; players: { peerId: string; name: string; driverId: string; ready: boolean }[]; config: SessionConfig; hostId: string }
  | { type: 'ready'; ready: boolean; driverId: string }
  | { type: 'start'; config: SessionConfig; entries: Entry[]; seed: number }
  | { type: 'car'; state: NetCarState }
  | { type: 'cars'; states: NetCarState[] }              // host relays all cars (incl. AI) to clients
  | { type: 'lap'; entryId: string; lap: LapRecord }     // client reports own lap to host
  | { type: 'session'; snapshot: SessionSnapshot; weather: WeatherState } // host -> clients ~2 Hz
  | { type: 'chat'; from: string; text: string }
  | { type: 'leave' };
