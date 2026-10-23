// One running session: owns the track, cars, AI, timing, weather, and the per-frame update.
import * as THREE from 'three';
import type {
  CarPose, CarSetup, Controls, Driver, Entry, NetCarState, SessionConfig, SessionSnapshot,
  Team, TrackProjection, TyreCompound, WeatherState,
} from '../types';
import { NEUTRAL_CONTROLS } from '../types';
import { Car } from '../physics/car';
import { resolveCarCollisions, type CollisionBody } from '../physics/collisions';
import { Track } from '../track/track';
import { buildTrackScene, disposeTrackScene } from '../track/trackMesh';
import type { Renderer } from '../render/renderer';
import { CarVisual } from '../render/carMesh';
import { CameraRig } from '../render/cameras';
import { AIDriver } from '../ai/aiDriver';
import { planStrategy } from '../ai/strategy';
import { Session, type CarTrackState, type SessionEvent } from '../session/session';
import { PitStop } from '../session/pit';
import { Weather } from '../weather/weather';
import type { InputManager } from '../input/inputManager';
import { applyAssists } from '../input/assists';
import type { EngineAudio } from '../audio/engineAudio';
import type { Hud } from '../ui/hud';
import type { TelemetryPanel } from '../ui/telemetryPanel';
import { TEAMS, teamById, driverById } from '../data/grid';
import { RemoteCarBuffer } from '../net/interp';
import { GhostRecorder, LapTrace, loadGhost, sampleGhost, saveGhost, type GhostData } from './ghost';

const DT = 1 / 240;
const MAX_SUBSTEPS = 24;

/** Networking hooks the world calls; supplied by the multiplayer glue. */
export interface WorldNet {
  isHost: boolean;
  selfEntryId: string;
  sendCar(state: NetCarState): void;
  sendCars(states: NetCarState[]): void;            // host only
  sendSession(s: SessionSnapshot, w: WeatherState): void; // host only
}

export interface WorldDeps {
  renderer: Renderer;
  input: InputManager;
  audio: EngineAudio;
  hud: Hud;
  telemetry: TelemetryPanel;
  quality: 'low' | 'medium' | 'high';
}

export interface WorldOptions {
  config: SessionConfig;
  entries: Entry[];
  playerEntryId: string | null;       // null = spectate
  playerSetup: CarSetup;
  seed: number;
  net?: WorldNet;
  onEvent?: (e: SessionEvent) => void;
  onFinished?: (s: SessionSnapshot) => void;
}

interface Racer {
  entry: Entry;
  driver: Driver;
  team: Team;
  car: Car | null;                  // null: remote car shown from network snapshots
  remote: RemoteCarBuffer | null;
  ai: AIDriver | null;
  visual: CarVisual;
  controls: Controls;
  hint: { idx: number };
  proj: TrackProjection;
  body: CollisionBody;
  pitBox: number;
  stops: number[];
  stopCompounds: TyreCompound[];
  nextStop: number;
  service: { untilMs: number; compound: TyreCompound | null; fuelKg: number } | null;
  servicedThisVisit: boolean;
  stuckMs: number;
  compound: TyreCompound;
  remoteSpeedKmh: number;
  remoteBrake: number;
}

const tmpV = new THREE.Vector3();

export class World {
  readonly track: Track;
  readonly session: Session;
  readonly weather: Weather;
  readonly racers: Racer[] = [];
  readonly cameraRig: CameraRig;
  player: Racer | null = null;
  paused = false;
  /** Player's pit plan (set from the pause menu). */
  pitPlan: { compound: TyreCompound; fuelKg: number } = { compound: 'medium', fuelKg: 0 };

  private deps: WorldDeps;
  private opts: WorldOptions;
  private scene: THREE.Group;
  private acc = 0;
  private simMs = 0;
  private lastWeatherApply = -1e9;
  private lastNetCar = 0;
  private lastNetCars = 0;
  private lastNetSession = 0;
  private hostPhaseHeld = true;
  private finishedFired = false;
  private rng: () => number;
  // Delta & ghost
  private bestTrace: LapTrace | null = null;
  private curTrace = new LapTrace();
  private ghostRec = new GhostRecorder();
  private ghost: GhostData | null = null;
  private ghostVisual: CarVisual | null = null;
  private ghostPose: CarPose;
  private lastPlayerLaps = 0;

  static async create(deps: WorldDeps, opts: WorldOptions): Promise<World> {
    const track = await Track.load(opts.config.circuitId);
    return new World(deps, opts, track);
  }

  private constructor(deps: WorldDeps, opts: WorldOptions, track: Track) {
    this.deps = deps;
    this.opts = opts;
    this.track = track;
    this.rng = mulberry32(opts.seed);
    const cfg = opts.config;

    this.scene = buildTrackScene(track, { quality: deps.quality });
    deps.renderer.setTrack(this.scene);

    const tod = Number.isFinite(cfg.timeOfDay) ? cfg.timeOfDay : track.data.raceTimeOfDay;
    this.weather = new Weather(cfg.weather, track.data, tod, cfg.timeScale, opts.seed);
    this.session = new Session(cfg, opts.entries, track.length, track.data.sectors);
    this.cameraRig = new CameraRig(deps.renderer.camera);

    const isClient = !!opts.net && !opts.net.isHost;
    const wet = this.weather.state.wetness > 0.35 || this.weather.state.rain > 0.3;
    const order = this.gridOrder(opts.entries, cfg);

    order.forEach((entry, gridPos) => {
      const driver = driverById(entry.driverId);
      const team = teamById(entry.teamId);
      const isPlayer = entry.id === opts.playerEntryId;
      const simulateHere = isPlayer || (!isClient && entry.kind === 'ai');
      const strat = planStrategy(cfg.laps, cfg.tyreWearMul, wet, opts.seed + gridPos * 7919);
      const startCompound: TyreCompound = isPlayer ? opts.playerSetup.startCompound : strat.compounds[0];
      const setup: CarSetup = isPlayer ? { ...opts.playerSetup } : { ...opts.playerSetup, startCompound, fuelKg: aiFuel(cfg, track) };
      if (!isPlayer) Object.assign(setup, neutralSetup(setup));

      let car: Car | null = null;
      if (simulateHere) {
        car = new Car({ setup, performance: team.performance });
        car.pitLimitKmh = track.data.pit.speedLimitKmh;
        car.fitTyres(startCompound);
      }
      const visual = new CarVisual(team, driver.number, driver.code);
      deps.renderer.scene.add(visual.object);
      const teamIdx = Math.max(0, TEAMS.findIndex((t) => t.id === team.id));
      const racer: Racer = {
        entry, driver, team, car,
        remote: simulateHere ? null : new RemoteCarBuffer(),
        ai: simulateHere && !isPlayer ? new AIDriver(track, driver, cfg.aiSkill, opts.seed + gridPos) : null,
        visual,
        controls: { ...NEUTRAL_CONTROLS },
        hint: { idx: -1 },
        proj: { s: 0, lateral: 0, idx: 0, onTrack: true, surface: 'asphalt' },
        body: { id: entry.id, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), car },
        pitBox: teamIdx,
        stops: strat.stopLaps, stopCompounds: strat.compounds, nextStop: 0,
        service: null, servicedThisVisit: false, stuckMs: 0,
        compound: startCompound, remoteSpeedKmh: 0, remoteBrake: 0,
      };
      racer.ai?.setPitBox?.(teamIdx);
      this.placeAtStart(racer, gridPos);
      this.racers.push(racer);
      if (isPlayer) this.player = racer;
    });

    this.ghostPose = {
      position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(),
      steerAngle: 0, wheelSpin: [0, 0, 0, 0], wheelCompression: [0, 0, 0, 0],
    };
    if (cfg.kind === 'timetrial' && this.player) {
      this.ghost = loadGhost(cfg.circuitId);
      const pt = this.player.team;
      this.ghostVisual = new CarVisual(pt, this.player.driver.number, 'GHO');
      this.ghostVisual.object.traverse((o: any) => {
        if (o.material) {
          o.material = o.material.clone();
          o.material.transparent = true;
          o.material.opacity = 0.35;
          o.material.depthWrite = false;
        }
        o.castShadow = false;
      });
      this.ghostVisual.object.visible = false;
      deps.renderer.scene.add(this.ghostVisual.object);
    }
    this.applyWeatherVisuals(true);
  }

  // ------------------------------------------------------------ setup helpers

  private gridOrder(entries: Entry[], cfg: SessionConfig): Entry[] {
    if (cfg.kind === 'race' && cfg.gridOrder.length) {
      const byId = new Map(entries.map((e) => [e.id, e]));
      const out = cfg.gridOrder.map((id) => byId.get(id)).filter((e): e is Entry => !!e);
      for (const e of entries) if (!out.includes(e)) out.push(e);
      return out;
    }
    if (cfg.kind === 'race') {
      // No qualifying: order by driver skill with some shuffle; humans start mid-pack.
      return entries.slice().sort((a, b) => {
        const sa = driverById(a.driverId).skill * (a.kind === 'ai' ? 1 : 0.985) + this.rng() * 0.02;
        const sb = driverById(b.driverId).skill * (b.kind === 'ai' ? 1 : 0.985) + this.rng() * 0.02;
        return sb - sa;
      });
    }
    return entries.slice();
  }

  private placeAtStart(r: Racer, gridPos: number): void {
    const kind = this.opts.config.kind;
    let pos: THREE.Vector3, heading: number;
    if (kind === 'race') {
      ({ position: pos, heading } = this.track.gridSlot(gridPos));
    } else if (kind === 'timetrial') {
      // Flying start: a little before the line on the racing line.
      const f = this.track.frameAt(this.track.length - 150);
      pos = f.position.clone().addScaledVector(f.left, this.track.racingLineOffset(this.track.length - 150));
      heading = Math.atan2(f.tangent.x, f.tangent.z);
    } else {
      // Practice / qualifying: start from the pit box, staggered so cars leave one by one.
      ({ position: pos, heading } = this.track.pitBox(r.pitBox));
      pos = pos.clone();
      if (gridPos % 2 === 1) pos.addScaledVector(new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)), -7);
    }
    if (r.car) {
      r.car.reset(pos.x, pos.z, heading, this.track);
      if (kind === 'timetrial') {
        // Give the flying lap entry speed.
        const v = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)).multiplyScalar(55);
        r.car.applyImpulse(v.multiplyScalar(r.car.massKg), r.car.pose.position);
      }
      this.copyPose(r, r.car.pose);
    } else {
      r.body.position.copy(pos);
      r.body.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    }
    r.proj = this.track.project(r.body.position.x, r.body.position.z, r.hint);
    // Cars starting in their box must not be "serviced" before they have left it.
    r.servicedThisVisit = kind !== 'race';
    // Practice/quali AI wait a random few seconds before leaving the garage.
    if (r.ai && kind !== 'race') r.service = { untilMs: 2000 + gridPos * 2500 * this.rng(), compound: null, fuelKg: 0 };
  }

  private copyPose(r: Racer, p: CarPose): void {
    r.body.position.copy(p.position);
    r.body.quaternion.copy(p.quaternion);
    r.body.velocity.copy(p.velocity);
  }

  // ------------------------------------------------------------ public API

  get snapshot(): SessionSnapshot { return this.session.snapshot(); }

  playerTelemetry() { return this.player?.car?.telemetry ?? null; }

  setPlayerSetup(s: CarSetup): void { this.player?.car?.setSetup(s); }

  /** Reset the player onto the track centre near where they are (invalidates the lap). */
  resetPlayer(): void {
    const r = this.player;
    if (!r?.car) return;
    this.resetToTrack(r);
  }

  private resetToTrack(r: Racer): void {
    const s = r.proj.s;
    const f = this.track.frameAt(s);
    const off = this.track.racingLineOffset(s);
    const p = f.position.clone().addScaledVector(f.left, off);
    r.car!.reset(p.x, p.z, Math.atan2(f.tangent.x, f.tangent.z), this.track);
    r.hint.idx = -1;
    r.stuckMs = 0;
  }

  dispose(): void {
    for (const r of this.racers) {
      this.deps.renderer.scene.remove(r.visual.object);
      r.visual.dispose();
    }
    if (this.ghostVisual) { this.deps.renderer.scene.remove(this.ghostVisual.object); this.ghostVisual.dispose(); }
    this.deps.renderer.setTrack(null);
    disposeTrackScene(this.scene);
  }

  // ------------------------------------------------------------ network inputs

  onNetCar(s: NetCarState, nowMs: number): void {
    const r = this.racers.find((x) => x.entry.id === s.id);
    if (!r || !r.remote) return;
    r.remote.push(s, nowMs);
    r.compound = s.compound;
    r.remoteSpeedKmh = s.speedKmh;
    r.remoteBrake = s.brake;
  }

  onNetSession(s: SessionSnapshot, w: WeatherState): void {
    this.session.applySnapshot(s);
    this.weather.applyState(w);
    this.hostPhaseHeld = s.phase === 'pre' || s.phase === 'lights' || s.phase === 'formation';
  }

  // ------------------------------------------------------------ frame

  /** Player speed for the input manager's speed-sensitive keyboard steering. */
  playerSpeedKmh(): number {
    return this.player?.car ? Math.abs(this.player.car.forwardSpeed()) * 3.6 : 0;
  }

  frame(dtSec: number, nowMs: number, polled: ReturnType<InputManager['poll']>): void {
    const { renderer, hud, telemetry, audio } = this.deps;
    const player = this.player;
    const playerSpeed = this.playerSpeedKmh();
    if (polled.ui.camera) this.cameraRig.cycle();

    if (!this.paused) {
      dtSec = Math.min(dtSec, 0.1);
      this.updateControls(polled.controls, dtSec);
      this.acc += dtSec;
      let steps = 0;
      const env = this.weather.environment();
      const held = this.carsHeld();
      while (this.acc >= DT && steps < MAX_SUBSTEPS) {
        this.acc -= DT;
        this.simStep(env, held, steps === 0);
        steps++;
      }
      if (steps === MAX_SUBSTEPS) this.acc = 0;
      const dtMs = steps * DT * 1000;
      this.simMs += dtMs;
      this.updateRemotes(nowMs);
      this.updateSession(dtMs);
      this.weather.update(dtMs / 1000, this.racers.length);
      this.updateNet(nowMs);
    }

    // Visuals
    for (const r of this.racers) {
      if (r.car) r.visual.update(r.car.pose, { brake: r.car.telemetry.brake, compound: r.car.tyres[0].compound, rainLight: this.weather.state.rain > 0.1 });
      else {
        const pose = r.remote!.sample(nowMs);
        if (pose) r.visual.update(pose, { brake: r.remoteBrake, compound: r.compound, rainLight: this.weather.state.rain > 0.1 });
      }
    }
    this.applyWeatherVisuals(false);

    const target = player?.car?.pose ?? this.racers[0]?.car?.pose ?? null;
    if (target) {
      this.cameraRig.update(dtSec, target, polled.ui.lookBack, playerSpeed);
      (renderer as any).setShadowFocus?.(target.position);
    }
    renderer.render();

    const snap = this.session.snapshot();
    const t = player?.car?.telemetry;
    if (t) {
      hud.update(snap, this.opts.entries, player!.entry.id, t, this.weather.state, this.liveDelta());
      telemetry.push(t, player!.proj.s);
      audio.update(t);
    }
    if ((snap.phase === 'finished') && !this.finishedFired) {
      this.finishedFired = true;
      this.opts.onFinished?.(snap);
    }
  }

  private carsHeld(): boolean {
    if (this.opts.net && !this.opts.net.isHost) return this.hostPhaseHeld && this.opts.config.kind === 'race';
    return this.session.carsHeld();
  }

  private updateControls(human: Controls, dtSec: number): void {
    const snap = this.session.snapshot();
    const byId = new Map(snap.timing.map((t) => [t.entryId, t]));
    for (const r of this.racers) {
      if (!r.car) continue;
      if (r === this.player) {
        const c = applyAssists(human, r.car.telemetry, this.deps.input.settings);
        r.controls = { ...c };
        // Pit lane speed limiter engages automatically in the lane.
        if (this.track.isInPitLane(r.car.pose.position.x, r.car.pose.position.z, r.hint)) r.controls.pitLimiter = true;
        continue;
      }
      if (!r.ai) continue;
      const timing = byId.get(r.entry.id);
      const lap = (timing?.lapsCompleted ?? 0) + 1;
      const wantPit = this.aiWantsPit(r, lap);
      r.controls = r.ai.update(dtSec, {
        s: r.proj.s, lateral: r.proj.lateral, speed: r.car.forwardSpeed(),
        pose: r.car.pose, telemetry: r.car.telemetry,
        others: this.nearby(r),
        phase: snap.phase, wantPit, pitLimitKmh: this.track.data.pit.speedLimitKmh,
      });
      if ((r.ai as any).needsReset?.()) this.resetToTrack(r);
    }
  }

  private aiWantsPit(r: Racer, lap: number): boolean {
    const kind = this.opts.config.kind;
    if (kind !== 'race') return false;
    if (r.nextStop < r.stops.length && lap >= r.stops[r.nextStop]) return true;
    const t = r.car!.tyres;
    const wear = Math.max(...t.map((x) => x.wear));
    if (wear > 0.8) return true;
    // Weather calls: slicks in the wet / wets on a dry track.
    const w = this.weather.state.wetness;
    const c = t[0].compound;
    if (w > 0.45 && (c === 'soft' || c === 'medium' || c === 'hard')) return true;
    if (w < 0.15 && (c === 'inter' || c === 'wet')) return true;
    return false;
  }

  private nearby(self: Racer) {
    const L = this.track.length;
    const out: { id: string; s: number; lateral: number; speed: number }[] = [];
    for (const o of this.racers) {
      if (o === self) continue;
      let ds = o.proj.s - self.proj.s;
      if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
      if (ds > 80 || ds < -30) continue;
      out.push({ id: o.entry.id, s: o.proj.s, lateral: o.proj.lateral, speed: o.car ? o.car.forwardSpeed() : o.remoteSpeedKmh / 3.6 });
    }
    return out;
  }

  private simStep(env: ReturnType<Weather['environment']>, held: boolean, firstStep: boolean): void {
    const bodies: CollisionBody[] = [];
    for (const r of this.racers) {
      if (!r.car) { bodies.push(r.body); continue; }
      const car = r.car;
      const servicing = !!r.service && r.service.untilMs > this.simMs;
      if (r.service && !servicing) this.finishService(r);
      car.hold = held || servicing;
      const c = firstStep ? r.controls : { ...r.controls, shiftUp: false, shiftDown: false };
      car.step(DT, c, this.track, env, this.track.inAeroZone(r.proj.s));
      this.copyPose(r, car.pose);
      bodies.push(r.body);
    }
    resolveCarCollisions(bodies);
  }

  private updateRemotes(nowMs: number): void {
    for (const r of this.racers) {
      if (r.car || !r.remote) continue;
      const pose = r.remote.sample(nowMs);
      if (pose) { r.body.position.copy(pose.position); r.body.quaternion.copy(pose.quaternion); r.body.velocity.copy(pose.velocity); }
    }
  }

  private updateSession(dtMs: number): void {
    const states: CarTrackState[] = [];
    for (const r of this.racers) {
      const p = r.body.position;
      r.proj = this.track.project(p.x, p.z, r.hint);
      const inPitLane = this.track.isInPitLane(p.x, p.z, r.hint);
      let onTrack = true;
      let speedKmh = r.remoteSpeedKmh;
      if (r.car) {
        const surf = r.car.telemetry.surface;
        onTrack = surf.some((s) => s === 'asphalt' || s === 'kerb' || s === 'pitlane');
        speedKmh = r.car.telemetry.speedKmh;
        r.compound = r.car.tyres[0].compound;
        this.checkPitService(r, inPitLane, speedKmh);
      }
      states.push({ entryId: r.entry.id, s: r.proj.s, lateral: r.proj.lateral, onTrack, inPitLane, speedKmh, compound: r.compound, lapDistanceValid: true });
    }
    const events = this.session.update(dtMs, states);
    for (const e of events) this.handleEvent(e);
    this.updatePlayerTrace();
  }

  private checkPitService(r: Racer, inPitLane: boolean, speedKmh: number): void {
    if (!inPitLane) { r.servicedThisVisit = false; return; }
    if (r.servicedThisVisit || r.service || speedKmh > 3) return;
    const box = this.track.pitBox(r.pitBox).position;
    if (tmpV.copy(r.body.position).sub(box).setY(0).length() > 6) return;
    let compound: TyreCompound | null = null;
    let fuel = 0;
    if (r === this.player) { compound = this.pitPlan.compound; fuel = this.pitPlan.fuelKg; }
    else if (r.ai) {
      if (this.opts.config.kind !== 'race') return;
      const w = this.weather.state.wetness;
      compound = w > 0.6 ? 'wet' : w > 0.3 ? 'inter' : (r.stopCompounds[r.nextStop + 1] ?? 'hard');
      r.nextStop++;
    }
    const ms = PitStop.serviceTimeMs(compound !== null, fuel, this.rng);
    r.service = { untilMs: this.simMs + ms, compound, fuelKg: fuel };
    r.servicedThisVisit = true;
    if (r === this.player) this.deps.hud.message(`Pit stop ${(ms / 1000).toFixed(1)} s`, ms);
  }

  private finishService(r: Racer): void {
    const s = r.service!;
    if (r.car) {
      if (s.compound) r.car.fitTyres(s.compound);
      if (s.fuelKg > 0) r.car.addFuel(s.fuelKg);
    }
    r.service = null;
  }

  private handleEvent(e: SessionEvent): void {
    const pid = this.player?.entry.id;
    const hud = this.deps.hud;
    if (e.type === 'lightsOut') { hud.message('LIGHTS OUT', 1500, 'good'); this.lastNetSession = -1e9; }
    if (e.type === 'chequered') hud.message('CHEQUERED FLAG', 3000, 'info');
    if (e.type === 'trackLimits' && e.entryId === pid) { hud.message('TRACK LIMITS — LAP INVALIDATED', 2500, 'bad'); this.deps.input.rumble(0.6, 0.3, 200); }
    if (e.type === 'lap' && e.entryId === pid) {
      const lt = fmtLap(e.lap.timeMs);
      if (e.sessionBest && e.lap.valid) hud.message(`${lt}  FASTEST LAP`, 3000, 'purple');
      else if (e.personalBest && e.lap.valid) hud.message(`${lt}  PERSONAL BEST`, 3000, 'good');
      else hud.message(lt + (e.lap.valid ? '' : '  (invalid)'), 2500, 'info');
      if (e.personalBest && e.lap.valid) {
        this.bestTrace = this.curTrace;
        if (this.ghostVisual && this.player) {
          const g = this.ghostRec.finish(this.opts.config.circuitId, this.player.driver.id, e.lap.timeMs);
          if (!this.ghost || g.lapMs < this.ghost.lapMs) { this.ghost = g; saveGhost(g); }
        }
      }
    }
    this.opts.onEvent?.(e);
  }

  /** Records the player's distance/time trace and drives the ghost car. */
  private updatePlayerTrace(): void {
    const r = this.player;
    if (!r?.car) return;
    const snap = this.session.snapshot();
    const t = snap.timing.find((x) => x.entryId === r.entry.id);
    if (!t) return;
    if (t.lapsCompleted !== this.lastPlayerLaps) {
      this.lastPlayerLaps = t.lapsCompleted;
      this.curTrace = new LapTrace();
      this.ghostRec.reset();
    }
    const lapMs = snap.elapsedMs - t.currentLapStartMs;
    if (t.lapsCompleted > 0 || this.opts.config.kind === 'race' || this.opts.config.kind === 'timetrial') {
      this.curTrace.record(r.proj.s, lapMs);
      this.ghostRec.record(lapMs, r.car.pose);
    }
    if (this.ghostVisual) {
      const ok = !!this.ghost && sampleGhost(this.ghost, lapMs, this.ghostPose);
      this.ghostVisual.object.visible = ok;
      if (ok) this.ghostVisual.update(this.ghostPose);
    }
  }

  private liveDelta(): number | null {
    const r = this.player;
    if (!r || !this.bestTrace) return null;
    const snap = this.session.snapshot();
    const t = snap.timing.find((x) => x.entryId === r.entry.id);
    if (!t) return null;
    const ref = this.bestTrace.timeAt(r.proj.s);
    if (ref === null) return null;
    return snap.elapsedMs - t.currentLapStartMs - ref;
  }

  private applyWeatherVisuals(force: boolean): void {
    if (!force && this.simMs - this.lastWeatherApply < 500) return;
    this.lastWeatherApply = this.simMs;
    const d = this.track.data;
    const tod = this.weather.state.timeOfDay;
    const night = tod < 6.5 || tod > 18.5;
    this.deps.renderer.setWeather(this.weather.state, d.latLon, night);
  }

  private updateNet(nowMs: number): void {
    const net = this.opts.net;
    if (!net) return;
    const p = this.player;
    if (p?.car && nowMs - this.lastNetCar > 33) {
      this.lastNetCar = nowMs;
      net.sendCar(toNetState(p, this.simMs));
    }
    if (!net.isHost) return;
    if (nowMs - this.lastNetCars > 50) {
      this.lastNetCars = nowMs;
      const states = this.racers.filter((r) => r.ai && r.car).map((r) => toNetState(r, this.simMs));
      if (states.length) net.sendCars(states);
    }
    const phase = this.session.snapshot().phase;
    const interval = phase === 'running' ? 500 : 150;
    if (nowMs - this.lastNetSession > interval) {
      this.lastNetSession = nowMs;
      net.sendSession(this.session.snapshot(), this.weather.state);
    }
  }
}

// ------------------------------------------------------------ helpers

function toNetState(r: Racer, t: number): NetCarState {
  const car = r.car!;
  const p = car.pose;
  return {
    id: r.entry.id, t,
    p: [p.position.x, p.position.y, p.position.z],
    q: [p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w],
    v: [p.velocity.x, p.velocity.y, p.velocity.z],
    steer: p.steerAngle, speedKmh: car.telemetry.speedKmh, gear: car.telemetry.gear,
    brake: car.telemetry.brake, compound: car.tyres[0].compound, inPit: false,
  };
}

function aiFuel(cfg: SessionConfig, track: Track): number {
  if (cfg.kind !== 'race') return 30;
  const perLap = 1.6 * (track.length / 5800) * Math.max(cfg.fuelMul, 0.01);
  return Math.min(110, Math.max(5, perLap * (cfg.laps + 1)));
}

/** AI cars use a neutral setup (the player's tweaks shouldn't change the field). */
function neutralSetup(s: CarSetup): Partial<CarSetup> {
  return {
    frontWing: 5, rearWing: 5, frontArb: 6, rearArb: 6, frontSpring: 6, rearSpring: 6,
    frontRideHeightMm: 25, rearRideHeightMm: 47, frontCamberDeg: -3, rearCamberDeg: -1.5,
    frontToeDeg: 0.1, rearToeDeg: 0.3, brakeBias: 0.56, brakePressure: 1, diffOnThrottle: 0.5,
    diffOffThrottle: 0.5, tyrePressurePsi: 23, startCompound: s.startCompound, fuelKg: s.fuelKg,
  };
}

export function fmtLap(ms: number): string {
  if (!Number.isFinite(ms)) return '--:--.---';
  const m = Math.floor(ms / 60000);
  const s = (ms % 60000) / 1000;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
