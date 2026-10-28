import type { Entry, EntryTiming, SessionSnapshot, Telemetry, WeatherState } from '../types';
import { teamById, driverById } from '../data/grid';
import { el, fmtLap, fmtSector, fmtGap, fmtClock, TYRE_COLORS, TYRE_LETTER } from './dom';
import { getPrefs } from './prefs';
import { ENGINE_MAPS } from '../physics/car';

const REV_LEDS = 15;
const REV_MIN = 6500, REV_MAX = 12200;

/** Sets text only when it changed (avoids needless layout). */
function setText(e: HTMLElement, v: string): void { if (e.textContent !== v) e.textContent = v; }
function setCls(e: HTMLElement, cls: string, on: boolean): void { if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on); }

/** Tyre temperature to colour: blue cold, green optimal (95-105), red hot. */
export function tyreTempColor(c: number): string {
  if (c < 95) {
    const k = Math.max(0, Math.min(1, (c - 40) / 55)); // 0 cold .. 1 optimal
    return `hsl(${210 - 90 * k}, 80%, 48%)`;               // 210 blue -> 120 green
  }
  if (c <= 105) return 'hsl(120, 75%, 42%)';
  const k = Math.max(0, Math.min(1, (c - 105) / 35));
  return `hsl(${120 - 120 * k}, 85%, 48%)`;                // green -> red
}

interface TowerRow {
  root: HTMLElement; pos: HTMLElement; bar: HTMLElement; code: HTMLElement; gap: HTMLElement; tyre: HTMLElement; pit: HTMLElement;
}

export class Hud {
  private rootEl: HTMLElement;
  private visible = false;
  private lastTower = 0;
  private rows: TowerRow[] = [];
  private tower: HTMLElement;

  // session info
  private sessName: HTMLElement; private sessMain: HTMLElement; private flag: HTMLElement;
  // dash
  private speed: HTMLElement; private speedUnit: HTMLElement; private gear: HTMLElement;
  private leds: HTMLElement[] = [];
  private ersFill: HTMLElement; private ersText: HTMLElement; private ersMode: HTMLElement;
  private engineMap: HTMLElement; private clip: HTMLElement;
  private fuel: HTMLElement; private straight: HTMLElement; private limiter: HTMLElement;
  private tyreBoxes: { box: HTMLElement; wear: HTMLElement; temp: HTMLElement }[] = [];
  private compoundDot: HTMLElement;
  private thrFill: HTMLElement; private brkFill: HTMLElement;
  // lap timer
  private lapTime: HTMLElement; private delta: HTMLElement; private lastLap: HTMLElement; private bestLap: HTMLElement;
  private sectors: HTMLElement[] = [];
  // weather
  private wxIcon: HTMLElement; private wxText: HTMLElement; private wxTemp: HTMLElement;
  // lights / messages
  private lights: HTMLElement; private lamps: HTMLElement[] = [];
  private toasts: HTMLElement;
  private lightsHideAt = 0;
  private lastLights = 0;

  constructor(root: HTMLElement) {
    this.rootEl = el('div', 'hud hidden', undefined, root);
    const r = this.rootEl;

    this.tower = el('div', 'tower', undefined, r);

    const top = el('div', 'session-info', undefined, r);
    this.sessName = el('div', 'si-name', '', top);
    this.sessMain = el('div', 'si-main mono', '', top);
    this.flag = el('div', 'si-flag hidden', '', top);

    const wx = el('div', 'weather panel', undefined, r);
    this.wxIcon = el('span', 'wx-icon', '', wx);
    this.wxText = el('span', 'wx-text mono', '', wx);
    this.wxTemp = el('span', 'wx-temp mono', '', wx);

    // dash
    const dash = el('div', 'dash panel', undefined, r);
    const leds = el('div', 'rev-leds', undefined, dash);
    for (let i = 0; i < REV_LEDS; i++) {
      const l = el('span', 'led ' + (i < 5 ? 'g' : i < 10 ? 'r' : 'b'), undefined, leds);
      this.leds.push(l);
    }
    const mid = el('div', 'dash-mid', undefined, dash);
    const sp = el('div', 'speed-block', undefined, mid);
    this.speed = el('div', 'speed mono', '0', sp);
    this.speedUnit = el('div', 'speed-unit', 'KM/H', sp);
    this.gear = el('div', 'gear mono', 'N', mid);
    const pedals = el('div', 'pedals', undefined, mid);
    const tb = el('div', 'pedal thr', undefined, pedals); this.thrFill = el('div', 'fill', undefined, tb);
    const bb = el('div', 'pedal brk', undefined, pedals); this.brkFill = el('div', 'fill', undefined, bb);

    const ers = el('div', 'ers', undefined, dash);
    this.ersMode = el('span', 'ers-mode', 'ERS', ers);
    const bar = el('div', 'bar', undefined, ers);
    this.ersFill = el('div', 'fill', undefined, bar);
    this.ersText = el('span', 'mono ers-text', '', ers);

    const flags = el('div', 'dash-flags', undefined, dash);
    this.fuel = el('span', 'mono fuel', '', flags);
    this.engineMap = el('span', 'tag map on', '', flags);
    this.clip = el('span', 'tag clip', 'SUPER CLIP', flags);
    this.straight = el('span', 'tag', 'STRAIGHT', flags);
    this.limiter = el('span', 'tag warn', 'PIT LIMITER', flags);

    const tyres = el('div', 'tyres', undefined, dash);
    this.compoundDot = el('span', 'compound-dot', '', tyres);
    const tg = el('div', 'tyre-grid', undefined, tyres);
    for (let i = 0; i < 4; i++) {
      const box = el('div', 'tyre-box', undefined, tg);
      const temp = el('span', 'mono tt', '', box);
      const wear = el('span', 'mono tw', '', box);
      this.tyreBoxes.push({ box, wear, temp });
    }

    // lap timer
    const lt = el('div', 'laptimer panel', undefined, r);
    const secs = el('div', 'sectors', undefined, lt);
    for (let i = 0; i < 3; i++) this.sectors.push(el('div', 'sector', undefined, secs));
    this.lapTime = el('div', 'lap-current mono', '0:00.000', lt);
    this.delta = el('div', 'lap-delta mono', '', lt);
    const lr = el('div', 'lap-rows', undefined, lt);
    this.lastLap = el('span', 'mono', '', lr);
    this.bestLap = el('span', 'mono', '', lr);

    // start lights
    this.lights = el('div', 'start-lights hidden', undefined, r);
    for (let i = 0; i < 5; i++) {
      const col = el('div', 'lamp-col', undefined, this.lights);
      el('div', 'lamp', undefined, col);
      this.lamps.push(col.firstElementChild as HTMLElement);
    }
    this.toasts = el('div', 'toasts', undefined, r);
  }

  show(): void { this.visible = true; this.rootEl.classList.remove('hidden'); }
  hide(): void { this.visible = false; this.rootEl.classList.add('hidden'); }

  message(text: string, ms = 3000, kind: 'info' | 'good' | 'bad' | 'purple' = 'info'): void {
    const t = el('div', 'toast ' + kind, text, this.toasts);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, ms);
  }

  update(s: SessionSnapshot, entries: Entry[], playerId: string, t: Telemetry, w: WeatherState, deltaMs: number | null): void {
    if (!this.visible) return;
    const now = performance.now();
    const player = s.timing.find(x => x.entryId === playerId);

    this.updateSession(s, player);
    this.updateDash(t);
    this.updateLapTimer(s, player, deltaMs);
    this.updateWeather(w);
    this.updateLights(s, now);

    if (now - this.lastTower >= 100) {
      this.lastTower = now;
      this.updateTower(s, entries, playerId, t);
    }
  }

  // ---------------------------------------------------------------- parts

  private updateSession(s: SessionSnapshot, player: EntryTiming | undefined): void {
    const k = s.config.kind;
    let name = k === 'race' ? 'RACE' : k === 'qualifying' ? 'QUALIFYING' : k === 'timetrial' ? 'TIME TRIAL' : 'PRACTICE';
    if (s.config.qualiPart) name += ' ' + s.config.qualiPart;
    setText(this.sessName, name);
    if (k === 'race') {
      const lap = Math.min(s.config.laps, (player?.lapsCompleted ?? 0) + 1);
      setText(this.sessMain, `LAP ${lap}/${s.config.laps}`);
    } else if (k === 'timetrial') {
      setText(this.sessMain, `LAP ${(player?.lapsCompleted ?? 0) + 1}`);
    } else {
      setText(this.sessMain, fmtClock(s.remainingMs));
    }
    const chq = s.phase === 'chequered' || s.phase === 'finished';
    setCls(this.flag, 'hidden', !chq);
    setText(this.flag, chq ? 'CHEQUERED FLAG' : '');
  }

  private updateDash(t: Telemetry): void {
    const mph = getPrefs().units === 'mph';
    setText(this.speed, String(Math.round(mph ? t.speedKmh * 0.621371 : t.speedKmh)));
    setText(this.speedUnit, mph ? 'MPH' : 'KM/H');
    setText(this.gear, t.gear < 0 ? 'R' : t.gear === 0 ? 'N' : String(t.gear));
    const lit = Math.round(Math.max(0, Math.min(1, (t.rpm - REV_MIN) / (REV_MAX - REV_MIN))) * REV_LEDS);
    for (let i = 0; i < REV_LEDS; i++) setCls(this.leds[i], 'on', i < lit);
    setCls(this.rootEl, 'rev-flash', t.rpm > REV_MAX - 100);

    this.thrFill.style.height = Math.round(t.throttle * 100) + '%';
    this.brkFill.style.height = Math.round(t.brake * 100) + '%';

    this.ersFill.style.width = Math.round(Math.max(0, Math.min(1, t.ersSoc)) * 100) + '%';
    const harvesting = t.ersHarvestKw > 5 && t.ersHarvestKw >= t.ersDeployKw;
    const flowKw = harvesting ? t.ersHarvestKw : t.ersDeployKw;
    setText(this.ersText, `${Math.round(t.ersSoc * 100)}%  ${harvesting ? '+' : ''}${Math.round(flowKw)} kW`);
    setCls(this.ersMode, 'boost', t.ersDeployKw > 350);
    setCls(this.ersMode, 'harvest', harvesting);
    setText(this.ersMode, t.ersDeployKw > 350 ? 'BOOST' : harvesting ? 'HARVEST' : t.ersDeployKw > 5 ? 'DEPLOY' : 'ERS');
    setText(this.engineMap, ENGINE_MAPS[t.engineMap]?.name ?? '');
    setCls(this.clip, 'on', t.superClip);

    setText(this.fuel, `FUEL ${t.fuelKg.toFixed(1)} kg`);
    setCls(this.straight, 'on', t.straightMode);
    setCls(this.limiter, 'on', t.pitLimiter);

    for (let i = 0; i < 4; i++) {
      const ty = t.tyres[i];
      const b = this.tyreBoxes[i];
      if (!ty) continue;
      b.box.style.background = tyreTempColor(ty.tempC);
      setText(b.temp, Math.round(ty.tempC) + '°');
      setText(b.wear, Math.round(ty.wear * 100) + '%');
    }
    const c = t.tyres[0]?.compound;
    if (c) {
      this.compoundDot.style.background = TYRE_COLORS[c];
      setText(this.compoundDot, TYRE_LETTER[c]);
      setCls(this.compoundDot, 'dark', c === 'hard' || c === 'medium');
    }
  }

  private updateLapTimer(s: SessionSnapshot, p: EntryTiming | undefined, deltaMs: number | null): void {
    if (!p) return;
    const cur = Math.max(0, s.elapsedMs - p.currentLapStartMs);
    setText(this.lapTime, s.phase === 'running' || s.phase === 'chequered' ? fmtLap(cur) : fmtLap(0));
    setCls(this.lapTime, 'invalid', !p.currentLapValid);
    if (deltaMs === null || !isFinite(deltaMs)) {
      setText(this.delta, '');
    } else {
      setText(this.delta, (deltaMs >= 0 ? '+' : '-') + Math.abs(deltaMs / 1000).toFixed(3));
      setCls(this.delta, 'pos', deltaMs > 0);
      setCls(this.delta, 'neg', deltaMs <= 0);
    }
    setText(this.lastLap, 'LAST ' + fmtLap(p.lastLap?.timeMs));
    setText(this.bestLap, 'BEST ' + fmtLap(p.bestLap?.timeMs));

    // sectors: purple = session best, green = personal best, yellow otherwise
    for (let i = 0; i < 3; i++) {
      const box = this.sectors[i];
      const v = p.currentSectors[i];
      let pb = Infinity;
      for (const l of p.laps) if (l.sectorsMs[i] < pb) pb = l.sectorsMs[i];
      const sb = s.sessionBestSectorsMs[i];
      if (v === null || v === undefined) {
        // show last completed lap's sector faintly
        const last = p.lastLap?.sectorsMs[i];
        setText(box, last !== undefined ? fmtSector(last) : '--.---');
        box.className = 'sector idle';
      } else {
        setText(box, fmtSector(v));
        let k = 'yellow';
        if (sb !== null && sb !== undefined && v <= sb) k = 'purple';
        else if (v <= pb) k = 'green';
        box.className = 'sector ' + k;
      }
    }
  }

  private updateWeather(w: WeatherState): void {
    const icon = w.rain > 0.5 ? '☂' : w.rain > 0.05 ? '☔' : w.cloud > 0.6 ? '☁' : '☀';
    setText(this.wxIcon, icon);
    setText(this.wxText, `RAIN ${Math.round(w.rain * 100)}%  WET ${Math.round(w.wetness * 100)}%`);
    setText(this.wxTemp, `AIR ${Math.round(w.airTempC)}°  TRK ${Math.round(w.trackTempC)}°`);
  }

  private updateLights(s: SessionSnapshot, now: number): void {
    const phaseLights = s.phase === 'lights';
    if (phaseLights) this.lightsHideAt = 0;
    if (this.lastLights > 0 && s.phase === 'running' && this.lightsHideAt === 0) this.lightsHideAt = now + 1200;
    this.lastLights = phaseLights ? s.lightsOn : 0;
    const show = phaseLights || now < this.lightsHideAt;
    setCls(this.lights, 'hidden', !show);
    const n = phaseLights ? s.lightsOn : 0;
    for (let i = 0; i < 5; i++) setCls(this.lamps[i], 'on', i < n);
  }

  private updateTower(s: SessionSnapshot, entries: Entry[], playerId: string, t: Telemetry): void {
    const byId = new Map(entries.map(e => [e.id, e]));
    const race = s.config.kind === 'race';
    while (this.rows.length < s.timing.length) {
      const root = el('div', 'tower-row', undefined, this.tower);
      const row: TowerRow = {
        root, pos: el('span', 'tr-pos mono', '', root), bar: el('span', 'tr-bar', '', root),
        code: el('span', 'tr-code', '', root), gap: el('span', 'tr-gap mono', '', root),
        tyre: el('span', 'tr-tyre', '', root), pit: el('span', 'tr-pit', '', root),
      };
      this.rows.push(row);
    }
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const tm = s.timing[i];
      if (!tm) { setCls(row.root, 'hidden', true); continue; }
      setCls(row.root, 'hidden', false);
      const e = byId.get(tm.entryId);
      const d = e ? driverById(e.driverId) : undefined;
      const team = e ? teamById(e.teamId) : undefined;
      setText(row.pos, String(tm.position));
      row.bar.style.background = team?.colors.primary ?? '#888';
      setText(row.code, d?.code ?? (e?.displayName ?? tm.entryId).slice(0, 3).toUpperCase());
      let g: string;
      if (race) g = i === 0 ? 'LEADER' : fmtGap(tm.intervalMs);
      else g = fmtLap(tm.bestLap?.timeMs);
      if (race && tm.finished) g = i === 0 ? 'FIN' : fmtGap(tm.gapToLeaderMs);
      setText(row.gap, g);
      const comp = tm.entryId === playerId ? t.tyres[0]?.compound : tm.compoundsUsed[tm.compoundsUsed.length - 1] ?? tm.lastLap?.compound;
      if (comp) { row.tyre.style.background = TYRE_COLORS[comp]; } else row.tyre.style.background = 'transparent';
      setText(row.pit, tm.inPit ? 'PIT' : '');
      setCls(row.root, 'me', tm.entryId === playerId);
    }
  }
}
