import './ui/styles.css';
import type { CarSetup, Entry, SessionConfig, SessionSnapshot } from './types';
import { Renderer } from './render/renderer';
import { InputManager } from './input/inputManager';
import { EngineAudio } from './audio/engineAudio';
import { Hud } from './ui/hud';
import { TelemetryPanel } from './ui/telemetryPanel';
import { PauseMenu } from './ui/pause';
import { Menu } from './ui/menu';
import { loadCircuitIndex } from './track/track';
import { qualifyingCut } from './session/session';
import { DRIVERS, driverById } from './data/grid';
import { World, mulberry32, type WorldDeps } from './game/world';
import { Multiplayer } from './game/multiplayer';
import { readGameSettings } from './game/settings';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

const renderer = new Renderer(canvas);
const input = new InputManager();
const audio = new EngineAudio();
const hud = new Hud(uiRoot);
const telemetry = new TelemetryPanel(uiRoot);
const pause = new PauseMenu(uiRoot, input);

let world: World | null = null;
let worldArgs: { config: SessionConfig; entries: Entry[]; playerId: string | null; setup: CarSetup; seed: number } | null = null;
let mp: Multiplayer | null = null;
let loading = false;

function deps(): WorldDeps {
  const s = readGameSettings();
  renderer.setQuality(s.quality);
  audio.setVolume(s.volume);
  return { renderer, input, audio, hud, telemetry, quality: s.quality };
}

// Audio needs a user gesture before it may start.
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => audio.resume(), { once: false });
window.addEventListener('resize', () => renderer.resize());

// ------------------------------------------------------------ session launching

function buildEntries(cfg: SessionConfig, playerDriverId: string, seed: number): Entry[] {
  const pd = driverById(playerDriverId);
  const entries: Entry[] = [{ id: pd.id, driverId: pd.id, displayName: `${pd.firstName} ${pd.lastName}`, teamId: pd.teamId, kind: 'player' }];
  const rng = mulberry32(seed);
  const others = DRIVERS.filter((d) => d.id !== pd.id).map((d) => ({ d, k: rng() })).sort((a, b) => a.k - b.k).map((x) => x.d);
  const n = cfg.kind === 'timetrial' ? 0 : Math.max(0, Math.min(21, cfg.aiCount));
  for (const d of others.slice(0, n)) entries.push({ id: d.id, driverId: d.id, displayName: `${d.firstName} ${d.lastName}`, teamId: d.teamId, kind: 'ai' });
  return entries;
}

async function launch(config: SessionConfig, entries: Entry[], playerId: string | null, setup: CarSetup, seed: number,
                      onFinished: (s: SessionSnapshot) => void): Promise<void> {
  if (loading) return;
  loading = true;
  disposeWorld();
  menu.hide();
  hud.show();
  hud.message('Loading circuit…', 1500);
  try {
    worldArgs = { config, entries, playerId, setup, seed };
    world = await World.create(deps(), {
      config, entries, playerEntryId: playerId, playerSetup: setup, seed,
      net: mp ? mp.worldNet() : undefined,
      onFinished: (s) => setTimeout(() => onFinished(s), 2500),
    });
    if (mp) mp.world = world;
    world.pitPlan = { compound: setup.startCompound === 'soft' ? 'medium' : 'hard', fuelKg: 0 };
    hud.message(sessionTitle(config), 2500);
  } catch (err) {
    console.error(err);
    hud.hide();
    menu.show();
    alert('Could not load the circuit: ' + (err as Error).message);
  } finally {
    loading = false;
  }
}

function disposeWorld(): void {
  if (world) { world.dispose(); world = null; }
  if (mp) mp.world = null;
  if (pause.isOpen) pause.close();
}

function quitToMenu(): void {
  disposeWorld();
  hud.hide();
  if (mp) { mp.leave(); mp = null; }
  menu.show();
}

function sessionTitle(c: SessionConfig): string {
  if (c.kind === 'qualifying') return `QUALIFYING ${c.qualiPart ?? ''}`.trim();
  return { practice: 'PRACTICE', race: 'RACE', timetrial: 'TIME TRIAL', qualifying: 'QUALIFYING' }[c.kind];
}

function showResults(s: SessionSnapshot, entries: Entry[], next?: { label: string; onClick: () => void }): void {
  disposeWorld();
  hud.hide();
  menu.show();
  menu.showResults(s, entries, next ?? { label: 'Main menu', onClick: () => menu.show() });
}

// ------------------------------------------------------------ Grand Prix weekend

async function runWeekend(base: SessionConfig, playerDriverId: string, setup: CarSetup): Promise<void> {
  const seed = (Math.random() * 2 ** 31) | 0;
  const all = buildEntries({ ...base, kind: 'race' }, playerDriverId, seed);
  const field = all.length;
  const qualiMin = Math.max(5, Math.round(base.durationMin * 0.6));
  const order: string[] = [];         // final grid, built from the back
  const results: SessionSnapshot[] = [];

  const practice = (): Promise<void> => new Promise((done) =>
    launch({ ...base, kind: 'practice' }, all, playerDriverId, setup, seed, (s) =>
      showResults(s, all, { label: 'Go to qualifying', onClick: () => done() })));

  const quali = (part: 'Q1' | 'Q2' | 'Q3', entries: Entry[]): Promise<SessionSnapshot> => new Promise((done) =>
    launch({ ...base, kind: 'qualifying', qualiPart: part, durationMin: qualiMin }, entries,
      entries.some((e) => e.id === playerDriverId) ? playerDriverId : null, setup, seed + part.charCodeAt(1), (s) =>
        showResults(s, entries, { label: part === 'Q3' ? 'Go to the race' : 'Next session', onClick: () => done(s) })));

  await practice();
  let running = all;
  for (const part of ['Q1', 'Q2', 'Q3'] as const) {
    const playerIn = running.some((e) => e.id === playerDriverId);
    let snap: SessionSnapshot | null = null;
    if (playerIn) { snap = await quali(part, running); results.push(snap); }
    const timing = snap ? snap.timing : [];
    if (part === 'Q3' || !snap) {
      // Remaining cars in classification order.
      const ranked = snap ? timing.map((t) => t.entryId) : running.map((e) => e.id);
      order.unshift(...ranked.filter((id) => running.some((e) => e.id === id)));
      break;
    }
    const out = qualifyingCut(timing, part, field);
    const outRanked = timing.map((t) => t.entryId).filter((id) => out.includes(id));
    order.unshift(...outRanked);
    running = running.filter((e) => !out.includes(e.id));
  }
  const raceCfg: SessionConfig = { ...base, kind: 'race', gridOrder: order };
  await launch(raceCfg, all, playerDriverId, setup, seed + 99, (s) => showResults(s, all));
}

// ------------------------------------------------------------ menu

const circuits = await loadCircuitIndex();

const menu = new Menu(uiRoot, circuits, input, {
  startSession(config, playerDriverId, setup) {
    const seed = (Math.random() * 2 ** 31) | 0;
    const entries = buildEntries(config, playerDriverId, seed);
    launch(config, entries, playerDriverId, setup, seed, (s) => showResults(s, entries));
  },
  startWeekend(base, playerDriverId, setup) {
    runWeekend(base, playerDriverId, setup).catch((e) => { console.error(e); quitToMenu(); });
  },
  hostMultiplayer(name, driverId) { startMultiplayer('host', '', name, driverId); },
  joinMultiplayer(code, name, driverId) { startMultiplayer('join', code, name, driverId); },
});

async function startMultiplayer(mode: 'host' | 'join', code: string, name: string, driverId: string): Promise<void> {
  const defaultConfig: SessionConfig = {
    kind: 'race', circuitId: circuits[0]?.id ?? 'monza', durationMin: 10, laps: 5, aiCount: 8, aiSkill: 0.9,
    weather: 'dry', timeOfDay: NaN, timeScale: 1, tyreWearMul: 1, fuelMul: 1, gridOrder: [],
  };
  let ready = false;
  const view = {
    update: (st: Parameters<Menu['showLobby']>[0]) => {
      if (world) return;
      menu.showLobby(st, {
        setReady: (r) => { ready = r; mp?.setReady(r); },
        setConfig: (c) => mp?.setConfig(c),
        start: () => mp?.start(),
        leave: () => quitToMenu(),
      });
    },
    error: (msg: string) => alert(msg),
    start: (config: SessionConfig, entries: Entry[], seed: number, selfId: string) => {
      const d = driverById(entries.find((e) => e.id === selfId)?.driverId ?? driverId);
      const setup = { ...defaultSetupFor(config), startCompound: 'medium' as const };
      void d;
      launch(config, entries, selfId, setup, seed, (s) => showResults(s, entries, { label: 'Back to lobby', onClick: () => mp && view.update({ code: mp.net.code, isHost: mp.net.isHost, players: mp.players, config: mp.config }) }));
    },
    closed: () => { mp = null; },
  };
  try {
    mp = mode === 'host'
      ? await Multiplayer.host(name, driverId, defaultConfig, view)
      : await Multiplayer.join(code, name, driverId, defaultConfig, view);
    void ready;
  } catch (e) {
    alert((e as Error).message);
    mp = null;
    menu.show();
  }
}

import { defaultSetup } from './physics/car';
import { loadSetup } from './ui/setupEditor';
function defaultSetupFor(c: SessionConfig): CarSetup {
  return loadSetup(c.circuitId) ?? defaultSetup();
}

// ------------------------------------------------------------ main loop

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (world) {
    const polled = input.poll(dt, world.playerSpeedKmh());
    if (input.consumeKey('KeyT')) telemetry.toggle();
    if (input.consumeKey('KeyR')) world.resetPlayer();
    if (polled.ui.pause) togglePause();
    world.paused = pause.isOpen && !mp;   // multiplayer never pauses the simulation
    world.frame(dt, now, polled);
  } else {
    input.poll(dt, 0);
    renderer.render();
  }
  requestAnimationFrame(loop);
}

function togglePause(): void {
  if (!world || !worldArgs) return;
  if (pause.isOpen) { pause.close(); return; }
  const w = world;
  const args = worldArgs;
  const canEditSetup = args.config.kind === 'practice' || args.config.kind === 'timetrial';
  pause.open({
    resume: () => pause.close(),
    restart: () => {
      if (mp) return;
      launch(args.config, args.entries, args.playerId, args.setup, args.seed, (s) => showResults(s, args.entries));
    },
    quit: () => quitToMenu(),
    setup: canEditSetup ? (s) => { args.setup = s; w.setPlayerSetup(s); } : undefined,
    pitStrategy: {
      compound: w.pitPlan.compound,
      fuelKg: w.pitPlan.fuelKg,
      set: (c, fuel) => { w.pitPlan = { compound: c, fuelKg: fuel }; },
    },
  }, args.setup);
}

menu.show();
requestAnimationFrame(loop);
