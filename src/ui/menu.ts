import type {
  CarSetup, CircuitIndexEntry, Entry, SessionConfig, SessionKind, SessionSnapshot, TyreCompound,
} from '../types';
import type { InputManager } from '../input/inputManager';
import { TEAMS, DRIVERS, teamById, driverById } from '../data/grid';
import { defaultSetup } from '../physics/car';
import { el, btn, fmtLap, fmtGap, sliderRow, selectRow, TYRE_COLORS } from './dom';
import { renderSetupEditor, loadSetup } from './setupEditor';
import { renderSettings } from './settingsPanel';
import { startPadNav } from './padNav';

export interface MenuCallbacks {
  startSession(config: SessionConfig, playerDriverId: string, setup: CarSetup): void;
  startWeekend(base: SessionConfig, playerDriverId: string, setup: CarSetup): void;
  hostMultiplayer(name: string, driverId: string): void;
  joinMultiplayer(code: string, name: string, driverId: string): void;
}

type Mode = 'quick' | 'weekend' | 'timetrial' | 'practice' | 'qualifying';
const MODE_TITLES: Record<Mode, string> = {
  quick: 'Quick Race', weekend: 'Grand Prix Weekend', timetrial: 'Time Trial', practice: 'Practice', qualifying: 'Qualifying',
};
const MODE_KIND: Record<Mode, SessionKind> = {
  quick: 'race', weekend: 'practice', timetrial: 'timetrial', practice: 'practice', qualifying: 'qualifying',
};

const TIMES_OF_DAY: { label: string; value: number }[] = [
  { label: 'Circuit default', value: NaN }, { label: 'Morning', value: 9 }, { label: 'Noon', value: 12 },
  { label: 'Afternoon', value: 15.5 }, { label: 'Dusk', value: 19 }, { label: 'Night', value: 22 },
];

export function difficultyLabel(v: number): string {
  if (v < 0.78) return 'Rookie';
  if (v < 0.88) return 'Amateur';
  if (v < 0.98) return 'Pro';
  if (v < 1.05) return 'Expert';
  return 'Legend';
}

interface SetupState {
  mode: Mode;
  circuitId: string;
  driverId: string;
  config: SessionConfig;
  setup: CarSetup;
}

const NAME_KEY = 'f1.name';
const DRIVER_KEY = 'f1.driver';

export class Menu {
  private panel: HTMLElement;
  private visible = false;
  private stopNav: (() => void) | null = null;
  private backAction: (() => void) | null = null;
  private st: SetupState;
  private myReady = false;
  private playerName: string;

  constructor(private root: HTMLElement, private circuits: CircuitIndexEntry[], private input: InputManager, private cb: MenuCallbacks) {
    this.panel = el('div', 'screen menu hidden', undefined, root);
    let driverId = DRIVERS[0]?.id ?? '';
    try { driverId = localStorage.getItem(DRIVER_KEY) ?? driverId; } catch { /* ignore */ }
    if (!DRIVERS.some(d => d.id === driverId)) driverId = DRIVERS[0]?.id ?? '';
    this.playerName = 'Player';
    try { this.playerName = localStorage.getItem(NAME_KEY) ?? 'Player'; } catch { /* ignore */ }
    const circuitId = circuits[0]?.id ?? '';
    this.st = {
      mode: 'quick', circuitId, driverId,
      config: this.baseConfig('race', circuitId), setup: loadSetup(circuitId) ?? defaultSetup(),
    };
  }

  private baseConfig(kind: SessionKind, circuitId: string): SessionConfig {
    return {
      kind, circuitId, durationMin: 15, laps: 5, aiCount: kind === 'race' ? 11 : 0, aiSkill: 0.95,
      weather: 'dry', timeOfDay: NaN, timeScale: 1, tyreWearMul: 1, fuelMul: 1, gridOrder: [],
    };
  }

  show(): void {
    this.visible = true;
    this.panel.classList.remove('hidden');
    this.main();
    this.stopNav?.();
    this.stopNav = startPadNav(() => this.panel, this.input, () => this.backAction?.());
  }

  hide(): void {
    this.visible = false;
    this.panel.classList.add('hidden');
    this.stopNav?.(); this.stopNav = null;
    this.panel.textContent = '';
  }

  // ------------------------------------------------------------ plumbing

  private screen(title?: string, back?: () => void): HTMLElement {
    this.panel.textContent = '';
    this.backAction = back ?? null;
    const wrap = el('div', 'menu-wrap', undefined, this.panel);
    if (title) {
      const head = el('div', 'menu-head', undefined, wrap);
      if (back) btn('‹ Back', back, 'btn small ghost', head);
      el('h2', 'menu-title', title, head);
    }
    const body = el('div', 'menu-body', undefined, wrap);
    queueMicrotask(() => {
      const first = this.panel.querySelector<HTMLElement>('button.btn-primary, button.menu-item, button.btn');
      if (this.visible && first && !this.panel.contains(document.activeElement)) first.focus({ preventScroll: true });
    });
    return body;
  }

  private persistDriver(): void {
    try { localStorage.setItem(DRIVER_KEY, this.st.driverId); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ main

  private main(): void {
    const body = this.screen();
    const hero = el('div', 'hero', undefined, body);
    el('div', 'hero-sub', 'FORMULA SIMULATION', hero);
    el('h1', 'hero-title', 'A FORMULA GAME', hero);
    const list = el('div', 'menu-list', undefined, body);
    const item = (label: string, sub: string, fn: () => void) => {
      const b = btn('', fn, 'menu-item', list);
      el('span', 'mi-label', label, b);
      el('span', 'mi-sub', sub, b);
    };
    item('Quick Race', 'Jump straight into a race', () => this.setupScreen('quick'));
    item('Grand Prix Weekend', 'Practice, Q1 / Q2 / Q3, then the race', () => this.setupScreen('weekend'));
    item('Time Trial', 'Alone on track, chase the perfect lap', () => this.setupScreen('timetrial'));
    item('Practice', 'Test setups and learn the circuit', () => this.setupScreen('practice'));
    item('Qualifying', 'One flying lap at a time', () => this.setupScreen('qualifying'));
    item('Multiplayer', 'Host or join with a 6 character code', () => this.multiplayer());
    item('Settings', 'Controls, assists, graphics, audio', () => this.settings());
    item('Credits', 'Data sources and licences', () => this.credits());
  }

  private settings(): void {
    const body = this.screen('Settings', () => this.main());
    renderSettings(body, this.input);
  }

  private credits(): void {
    const body = this.screen('Credits', () => this.main());
    const p = el('div', 'panel credits', undefined, body);
    el('h3', undefined, 'A Formula Game', p);
    el('p', undefined, 'Circuit centreline data: bacinger/f1-circuits (MIT licence).', p);
    el('p', undefined, 'Built with Three.js, PeerJS and Vite. Engine sound is synthesised live with WebAudio.', p);
    el('p', 'muted', 'This is an unofficial fan project. It is not affiliated with, endorsed by or connected to Formula 1, the FIA or any team, driver or sponsor.', p);
  }

  // ------------------------------------------------------------ session setup

  private setupScreen(mode: Mode): void {
    const cur = this.st;
    cur.mode = mode;
    const prevCircuit = cur.config.circuitId || cur.circuitId;
    cur.config = { ...this.baseConfig(MODE_KIND[mode], prevCircuit) };
    cur.circuitId = prevCircuit;
    cur.setup = loadSetup(cur.circuitId) ?? defaultSetup();
    this.renderSetup();
  }

  private lapsPreset(pct: number): number {
    const c = this.circuits.find(x => x.id === this.st.circuitId);
    const len = c?.realLengthM || 5000;
    return Math.max(1, Math.min(78, Math.round((305000 / len) * pct)));
  }

  private renderSetup(): void {
    const st = this.st;
    const cfg = st.config;
    const body = this.screen(MODE_TITLES[st.mode], () => this.main());
    const isRace = st.mode === 'quick';
    const showLaps = isRace || st.mode === 'weekend';
    const showDuration = st.mode === 'practice' || st.mode === 'qualifying' || st.mode === 'weekend';
    const showAi = st.mode !== 'timetrial';

    const layout = el('div', 'setup-layout', undefined, body);
    const left = el('div', 'setup-col', undefined, layout);
    const right = el('div', 'setup-col', undefined, layout);

    // circuits
    const cp = el('div', 'panel', undefined, left);
    el('h3', undefined, 'Circuit', cp);
    const grid = el('div', 'circuit-grid', undefined, cp);
    for (const c of [...this.circuits].sort((a, b) => a.round - b.round)) {
      const b = btn('', () => {
        st.circuitId = c.id; cfg.circuitId = c.id;
        st.setup = loadSetup(c.id) ?? st.setup;
        grid.querySelectorAll('.circuit-card').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        updatePresets();
      }, 'circuit-card' + (c.id === st.circuitId ? ' active' : ''), grid);
      el('span', 'cc-round mono', String(c.round).padStart(2, '0'), b);
      el('span', 'cc-name', c.grandPrix || c.name, b);
      el('span', 'cc-sub', `${c.country} · ${(c.realLengthM / 1000).toFixed(3)} km`, b);
    }

    // driver
    const dp = el('div', 'panel', undefined, left);
    el('h3', undefined, 'Team and driver', dp);
    this.driverPicker(dp, st.driverId, id => { st.driverId = id; this.persistDriver(); });

    // options
    const op = el('div', 'panel', undefined, right);
    el('h3', undefined, 'Session', op);
    let presetBox: HTMLElement | null = null;
    let lapsInput: HTMLInputElement | null = null;
    const updatePresets = () => {
      if (!presetBox) return;
      presetBox.textContent = '';
      for (const [label, pct] of [['5', 0], ['10', 0], ['25%', 0.25], ['50%', 0.5], ['100%', 1]] as [string, number][]) {
        const laps = pct === 0 ? Number(label) : this.lapsPreset(pct);
        btn(pct === 0 ? label : `${label} (${laps})`, () => { cfg.laps = laps; if (lapsInput) lapsInput.value = String(laps); }, 'chip', presetBox);
      }
    };
    if (showLaps) {
      const row = el('div', 'row', undefined, op);
      el('label', 'row-label', 'Race laps', row);
      lapsInput = el('input', 'num', undefined, row);
      lapsInput.type = 'number'; lapsInput.min = '1'; lapsInput.max = '78'; lapsInput.value = String(cfg.laps);
      lapsInput.addEventListener('change', () => {
        const v = Math.max(1, Math.min(78, Math.round(Number(lapsInput!.value) || 5)));
        cfg.laps = v; lapsInput!.value = String(v);
      });
      presetBox = el('div', 'chips', undefined, op);
      updatePresets();
    }
    if (showDuration) {
      sliderRow(op, st.mode === 'weekend' ? 'Practice length' : 'Session length', 5, 60, 5, cfg.durationMin, v => v + ' min', v => { cfg.durationMin = v; });
    }
    if (showAi) {
      sliderRow(op, 'AI opponents', 0, 21, 1, cfg.aiCount, v => String(v), v => { cfg.aiCount = v; });
      sliderRow(op, 'AI difficulty', 0.7, 1.1, 0.01, cfg.aiSkill, v => difficultyLabel(v) + ' (' + v.toFixed(2) + ')', v => { cfg.aiSkill = v; });
    }
    selectRow(op, 'Weather', [
      { value: 'dry', label: 'Dry' }, { value: 'changeable', label: 'Changeable' }, { value: 'wet', label: 'Wet' }, { value: 'random', label: 'Random' },
    ], cfg.weather, v => { cfg.weather = v; });
    selectRow(op, 'Time of day', TIMES_OF_DAY.map(t => ({ value: isNaN(t.value) ? 'default' : String(t.value), label: t.label })),
      isNaN(cfg.timeOfDay) ? 'default' : String(cfg.timeOfDay), v => { cfg.timeOfDay = v === 'default' ? NaN : Number(v); });
    selectRow(op, 'Time scale', [1, 5, 10, 30].map(v => ({ value: v, label: '×' + v })), cfg.timeScale, v => { cfg.timeScale = v; });
    selectRow(op, 'Tyre wear', [0, 1, 2, 3].map(v => ({ value: v, label: v === 0 ? 'Off' : '×' + v })), cfg.tyreWearMul, v => { cfg.tyreWearMul = v; });
    selectRow(op, 'Fuel use', [0, 1, 2].map(v => ({ value: v, label: v === 0 ? 'Off' : '×' + v })), cfg.fuelMul, v => { cfg.fuelMul = v; });
    selectRow<TyreCompound>(op, 'Starting tyre', (['soft', 'medium', 'hard', 'inter', 'wet'] as TyreCompound[]).map(c => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })),
      st.setup.startCompound, v => { st.setup.startCompound = v; });

    const actions = el('div', 'actions', undefined, right);
    btn('Car Setup', () => this.setupEditorScreen(), 'btn', actions);
    btn(st.mode === 'weekend' ? 'Start Weekend' : 'Start', () => {
      cfg.circuitId = st.circuitId;
      const c = { ...cfg, gridOrder: [] };
      if (st.mode === 'weekend') this.cb.startWeekend(c, st.driverId, { ...st.setup });
      else this.cb.startSession(c, st.driverId, { ...st.setup });
    }, 'btn btn-primary', actions);
  }

  private setupEditorScreen(): void {
    const body = this.screen('Car Setup', () => this.renderSetup());
    renderSetupEditor(body, this.st.setup, s => { this.st.setup = s; }, { circuitId: this.st.circuitId });
  }

  private driverPicker(parent: HTMLElement, selected: string, onPick: (id: string) => void): void {
    const wrap = el('div', 'team-grid', undefined, parent);
    for (const t of TEAMS) {
      const card = el('div', 'team-card', undefined, wrap);
      card.style.setProperty('--team', t.colors.primary);
      el('div', 'team-name', t.name, card);
      for (const d of DRIVERS.filter(x => x.teamId === t.id)) {
        const b = btn('', () => {
          onPick(d.id);
          wrap.querySelectorAll('.driver-btn').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
        }, 'driver-btn' + (d.id === selected ? ' active' : ''), card);
        el('span', 'db-num mono', String(d.number), b);
        el('span', 'db-name', `${d.firstName[0]}. ${d.lastName}`, b);
      }
    }
  }

  // ------------------------------------------------------------ multiplayer

  private multiplayer(): void {
    const st = this.st;
    const body = this.screen('Multiplayer', () => this.main());
    const p = el('div', 'panel', undefined, body);
    const row = el('div', 'row', undefined, p);
    el('label', 'row-label', 'Player name', row);
    const name = el('input', 'text', undefined, row);
    name.maxLength = 16; name.value = this.playerName;
    const getName = () => {
      const n = name.value.trim() || 'Player';
      this.playerName = n;
      try { localStorage.setItem(NAME_KEY, n); } catch { /* ignore */ }
      return n;
    };
    el('h3', undefined, 'Team and driver', p);
    this.driverPicker(p, st.driverId, id => { st.driverId = id; this.persistDriver(); });

    const act = el('div', 'panel mp-actions', undefined, body);
    btn('Host a game', () => this.cb.hostMultiplayer(getName(), st.driverId), 'btn btn-primary', act);
    const jr = el('div', 'row', undefined, act);
    const code = el('input', 'text code-input mono', undefined, jr);
    code.maxLength = 6; code.placeholder = 'CODE';
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    const join = btn('Join', () => {
      if (code.value.length === 6) this.cb.joinMultiplayer(code.value, getName(), st.driverId);
      else { code.classList.add('error'); setTimeout(() => code.classList.remove('error'), 600); }
    }, 'btn', jr);
    code.addEventListener('keydown', e => { if (e.key === 'Enter') join.click(); });
  }

  // ------------------------------------------------------------ results

  showResults(snapshot: SessionSnapshot, entries: Entry[], next?: { label: string; onClick: () => void }): void {
    this.visible = true;
    this.panel.classList.remove('hidden');
    const body = this.screen('Results');
    const isRace = snapshot.config.kind === 'race';
    const p = el('div', 'panel results', undefined, body);
    const table = el('table', 'results-table', undefined, p);
    const head = el('tr', undefined, undefined, el('thead', undefined, undefined, table));
    for (const h of ['Pos', '', 'Driver', 'Team', 'Laps', isRace ? 'Time / Gap' : 'Best', 'Best lap', 'Pits', 'Pen.']) el('th', undefined, h, head);
    const tb = el('tbody', undefined, undefined, table);
    const byId = new Map(entries.map(e => [e.id, e]));
    const leader = snapshot.timing[0];
    const sorted = !isRace
      ? [...snapshot.timing].sort((a, b) => (a.bestLap?.timeMs ?? Infinity) - (b.bestLap?.timeMs ?? Infinity))
      : snapshot.timing;
    sorted.forEach((t, i) => {
      const e = byId.get(t.entryId);
      const d = e ? driverById(e.driverId) : undefined;
      const team = e ? teamById(e.teamId) : undefined;
      const tr = el('tr', e?.kind === 'player' ? 'me' : '', undefined, tb);
      el('td', 'mono', String(isRace ? t.position : i + 1), tr);
      const bar = el('td', undefined, undefined, tr);
      const sw = el('span', 'team-bar', undefined, bar);
      sw.style.background = team?.colors.primary ?? '#888';
      el('td', 'driver-cell', e ? (e.kind === 'ai' && d ? `${d.firstName} ${d.lastName}` : e.displayName) : t.entryId, tr);
      el('td', undefined, team?.name ?? '', tr);
      el('td', 'mono', String(t.lapsCompleted), tr);
      let tg = '';
      if (isRace) {
        if (t.position === 1) tg = t.finishTimeMs !== null ? fmtLap(t.finishTimeMs) : '';
        else if (leader && t.lapsCompleted < leader.lapsCompleted) {
          const n = leader.lapsCompleted - t.lapsCompleted; tg = `+${n} lap${n > 1 ? 's' : ''}`;
        } else tg = fmtGap(t.gapToLeaderMs);
        if (!t.finished && t.position !== 1 && !tg) tg = 'DNF';
      } else tg = fmtLap(t.bestLap?.timeMs);
      el('td', 'mono', tg, tr);
      el('td', 'mono', fmtLap(t.bestLap?.timeMs), tr);
      el('td', 'mono', String(t.pitStops), tr);
      el('td', 'mono', t.penaltyMs ? `+${(t.penaltyMs / 1000).toFixed(0)}s` : '', tr);
    });
    const actions = el('div', 'actions', undefined, body);
    if (next) btn(next.label, next.onClick, 'btn btn-primary', actions);
    btn('Main menu', () => this.main(), next ? 'btn' : 'btn btn-primary', actions);
  }

  // ------------------------------------------------------------ lobby

  showLobby(
    state: { code: string; isHost: boolean; players: { name: string; driverId: string; ready: boolean }[]; config: SessionConfig },
    actions: { setReady(r: boolean): void; setConfig(c: SessionConfig): void; start(): void; leave(): void },
  ): void {
    this.visible = true;
    this.panel.classList.remove('hidden');
    const body = this.screen('Lobby', () => { this.myReady = false; actions.leave(); this.main(); });
    const top = el('div', 'panel lobby-code', undefined, body);
    el('div', 'muted', 'Share this code with your friends', top);
    const big = el('div', 'big-code mono', state.code, top);
    btn('Copy', () => {
      void navigator.clipboard?.writeText(state.code).then(() => { big.classList.add('copied'); setTimeout(() => big.classList.remove('copied'), 800); }).catch(() => {});
    }, 'btn small', top);

    const layout = el('div', 'setup-layout', undefined, body);
    const pl = el('div', 'panel', undefined, layout);
    el('h3', undefined, `Players (${state.players.length})`, pl);
    for (const p of state.players) {
      const r = el('div', 'player-row', undefined, pl);
      const d = DRIVERS.find(x => x.id === p.driverId);
      const t = d ? teamById(d.teamId) : undefined;
      const sw = el('span', 'team-bar', undefined, r);
      sw.style.background = t?.colors.primary ?? '#888';
      el('span', 'p-name', p.name, r);
      el('span', 'muted', d ? `${d.code} #${d.number}` : '', r);
      el('span', 'tick' + (p.ready ? ' on' : ''), p.ready ? '✓ Ready' : 'Waiting', r);
    }

    const cp = el('div', 'panel', undefined, layout);
    el('h3', undefined, 'Session', cp);
    const cfg = state.config;
    if (state.isHost) {
      const emit = (patch: Partial<SessionConfig>) => actions.setConfig({ ...cfg, ...patch });
      selectRow(cp, 'Circuit', [...this.circuits].sort((a, b) => a.round - b.round).map(c => ({ value: c.id, label: c.grandPrix || c.name })),
        cfg.circuitId, v => emit({ circuitId: v }));
      selectRow(cp, 'Type', [{ value: 'race', label: 'Race' }, { value: 'qualifying', label: 'Qualifying' }, { value: 'practice', label: 'Practice' }],
        cfg.kind === 'timetrial' ? 'practice' : cfg.kind, v => emit({ kind: v as SessionKind }));
      const row = el('div', 'row', undefined, cp);
      el('label', 'row-label', 'Laps', row);
      const li = el('input', 'num', undefined, row);
      li.type = 'number'; li.min = '1'; li.max = '78'; li.value = String(cfg.laps);
      li.addEventListener('change', () => emit({ laps: Math.max(1, Math.min(78, Math.round(Number(li.value) || 5))) }));
      selectRow(cp, 'AI cars', Array.from({ length: 22 }, (_, i) => ({ value: i, label: String(i) })), cfg.aiCount, v => emit({ aiCount: v }));
      selectRow(cp, 'Weather', [
        { value: 'dry', label: 'Dry' }, { value: 'changeable', label: 'Changeable' }, { value: 'wet', label: 'Wet' }, { value: 'random', label: 'Random' },
      ], cfg.weather, v => emit({ weather: v }));
      const a = el('div', 'actions', undefined, cp);
      btn('Start session', () => actions.start(), 'btn btn-primary', a);
    } else {
      const c = this.circuits.find(x => x.id === cfg.circuitId);
      el('div', undefined, `${c?.grandPrix ?? cfg.circuitId}`, cp);
      el('div', 'muted', `${cfg.kind === 'race' ? cfg.laps + ' laps' : cfg.durationMin + ' min'} · ${cfg.aiCount} AI · ${cfg.weather}`, cp);
      const a = el('div', 'actions', undefined, cp);
      const rb = btn(this.myReady ? 'Not ready' : 'Ready', () => {
        this.myReady = !this.myReady; actions.setReady(this.myReady); rb.textContent = this.myReady ? 'Not ready' : 'Ready';
      }, 'btn btn-primary', a);
      btn('Leave', () => { this.myReady = false; actions.leave(); this.main(); }, 'btn', a);
    }
    void TYRE_COLORS;
  }
}
