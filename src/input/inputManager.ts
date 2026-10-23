import type { Controls, UiActions, InputDeviceKind } from '../types';
import { filterKeyboardSteer, rampPedal } from './keyboardFilter';

export type BindingKind = 'key' | 'button' | 'axis';
export interface Binding { device: InputDeviceKind; kind: BindingKind; code: string | number; dir?: 1 | -1 }

export interface InputSettings {
  device: 'auto' | InputDeviceKind;
  steerSensitivity: number; steerLinearity: number; deadzone: number;
  wheelRotationDeg: number;          // physical wheel rotation, 900 typical
  invertThrottle: boolean; invertBrake: boolean; combinedPedals: boolean;
  bindings: Record<string, Binding>;
  autoGearbox: boolean; tractionControl: number; absAssist: boolean; steeringAssist: number;
  /** Extra: degrees of physical wheel rotation (from centre) that equal full car lock. */
  wheelLockDeg: number;
}

export const ACTIONS = [
  'steer', 'throttle', 'brake', 'shiftUp', 'shiftDown', 'boost', 'pitLimiter', 'camera', 'lookBack', 'pause',
] as const;
export type Action = typeof ACTIONS[number];
export const ACTION_LABELS: Record<Action, string> = {
  steer: 'Steering', throttle: 'Throttle', brake: 'Brake', shiftUp: 'Shift up', shiftDown: 'Shift down',
  boost: 'Boost (ERS)', pitLimiter: 'Pit limiter', camera: 'Camera', lookBack: 'Look back', pause: 'Pause',
};

export function defaultSettings(): InputSettings {
  return {
    device: 'auto', steerSensitivity: 1, steerLinearity: 1.4, deadzone: 0.08,
    wheelRotationDeg: 900, invertThrottle: false, invertBrake: false, combinedPedals: false,
    bindings: {}, autoGearbox: true, tractionControl: 1, absAssist: true, steeringAssist: 0.3,
    wheelLockDeg: 95,
  };
}

// ------------------------------------------------------------------ default maps

const KEY_DEFAULTS: Record<string, string[]> = {
  throttle: ['KeyW', 'ArrowUp'], brake: ['KeyS', 'ArrowDown'],
  steerLeft: ['KeyA', 'ArrowLeft'], steerRight: ['KeyD', 'ArrowRight'],
  shiftUp: ['KeyE', 'ShiftRight'], shiftDown: ['KeyQ', 'ControlLeft', 'ControlRight'],
  boost: ['Space'], pitLimiter: ['KeyL'], camera: ['KeyC'], lookBack: ['KeyB'], pause: ['Escape'],
};

interface PadDef { kind: 'button' | 'axis'; code: number; dir?: 1 | -1 }
const PAD_DEFAULTS: Record<Action, PadDef[]> = {
  steer: [{ kind: 'axis', code: 0, dir: 1 }],
  throttle: [{ kind: 'button', code: 7 }], brake: [{ kind: 'button', code: 6 }],
  shiftUp: [{ kind: 'button', code: 0 }, { kind: 'button', code: 5 }],
  shiftDown: [{ kind: 'button', code: 2 }, { kind: 'button', code: 4 }],
  boost: [{ kind: 'button', code: 1 }], pitLimiter: [{ kind: 'button', code: 14 }],
  camera: [{ kind: 'button', code: 3 }], lookBack: [{ kind: 'button', code: 8 }], pause: [{ kind: 'button', code: 9 }],
};

const WHEEL_RE = /(g29|g920|g923|g pro|g-pro|driving force|t300|t150|tmx|t248|t-gt|t818|tx racing|thrustmaster|fanatec|csl|podium|moza|simucube|simagic|wheel)/i;
export function isWheelId(id: string): boolean { return WHEEL_RE.test(id); }

/** Per-brand pedal axes. Pedals report +1 released -> -1 pressed on most wheels in Chrome (dir -1). Best-effort; rebindable. */
function wheelPedalDefaults(id: string): { throttle: PadDef; brake: PadDef } {
  const s = id.toLowerCase();
  if (/logitech|g29|g920|g923|g pro|driving force/.test(s)) return { throttle: { kind: 'axis', code: 2, dir: -1 }, brake: { kind: 'axis', code: 3, dir: -1 } };
  if (/thrustmaster|t300|t150|tmx|t248|t-gt|t818|tx racing/.test(s)) return { throttle: { kind: 'axis', code: 1, dir: -1 }, brake: { kind: 'axis', code: 2, dir: -1 } };
  if (/fanatec|csl|podium/.test(s)) return { throttle: { kind: 'axis', code: 5, dir: -1 }, brake: { kind: 'axis', code: 4, dir: -1 } };
  if (/moza/.test(s)) return { throttle: { kind: 'axis', code: 2, dir: -1 }, brake: { kind: 'axis', code: 1, dir: -1 } };
  return { throttle: { kind: 'axis', code: 5, dir: -1 }, brake: { kind: 'axis', code: 1, dir: -1 } };
}

function wheelDefaults(id: string): Record<Action, PadDef[]> {
  const p = wheelPedalDefaults(id);
  return {
    steer: [{ kind: 'axis', code: 0, dir: 1 }],
    throttle: [p.throttle], brake: [p.brake],
    shiftUp: [{ kind: 'button', code: 4 }], shiftDown: [{ kind: 'button', code: 5 }],
    boost: [{ kind: 'button', code: 0 }], pitLimiter: [{ kind: 'button', code: 2 }],
    camera: [{ kind: 'button', code: 3 }], lookBack: [{ kind: 'button', code: 1 }], pause: [{ kind: 'button', code: 9 }],
  };
}

// ------------------------------------------------------------------ helpers

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

function applyDeadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * (a - dz) / (1 - dz);
}

interface Cal { lo: number; hi: number }

const STORAGE_KEY = 'f1.input';

interface PadSnap { id: string; buttons: number[]; axes: number[] }

export class InputManager {
  settings: InputSettings = defaultSettings();
  /** Observed min/max per pedal axis ("<padId>#<axis>"), persisted with the settings. */
  calibration: Record<string, Cal> = {};

  private held = new Set<string>();
  private pressedLatch = new Set<string>();       // for poll() edges
  private oneShot = new Map<string, number>();    // for consumeKey()
  private lastDevice: InputDeviceKind = 'keyboard';
  private steerKb = 0;
  private thr = 0;
  private brk = 0;
  private pitLimiterOn = false;
  private prevButtons = new Map<number, boolean[]>();
  private prevAxes = new Map<number, number[]>();
  private capturing = false;
  private capBase: PadSnap[] = [];
  private capRaf = 0;
  private capCancel: (() => void) | null = null;

  constructor() {
    this.load();
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('blur', () => { this.held.clear(); });
    }
  }

  get isCapturing(): boolean { return this.capturing; }

  // -------------------------------------------------------------- persistence

  private load(): void {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      if (!raw) return;
      const o = JSON.parse(raw);
      this.settings = { ...defaultSettings(), ...(o.settings ?? {}) };
      this.settings.bindings = { ...(o.settings?.bindings ?? {}) };
      this.calibration = o.calibration ?? {};
    } catch { /* ignore corrupt storage */ }
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: this.settings, calibration: this.calibration }));
    } catch { /* storage unavailable */ }
  }

  resetCalibration(): void { this.calibration = {}; this.save(); }

  // -------------------------------------------------------------- keyboard events

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.capturing) return; // handled by the capture listener
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.repeat) return;
    this.held.add(e.code);
    this.pressedLatch.add(e.code);
    this.oneShot.set(e.code, performance.now());
    if (this.settings.device === 'auto') this.lastDevice = 'keyboard';
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && tag !== 'BUTTON') e.preventDefault();
  };
  private onKeyUp = (e: KeyboardEvent): void => { this.held.delete(e.code); };

  /** One-off key (e.g. 'KeyT'): true once per press, then false until pressed again. */
  consumeKey(code: string): boolean {
    const t = this.oneShot.get(code);
    if (t === undefined) return false;
    this.oneShot.delete(code);
    return performance.now() - t < 500;
  }

  // -------------------------------------------------------------- gamepad access

  private pads(): Gamepad[] {
    try {
      const list = navigator.getGamepads?.() ?? [];
      return Array.from(list).filter((g): g is Gamepad => !!g && g.connected);
    } catch { return []; }
  }

  private padKind(g: Gamepad): InputDeviceKind {
    return isWheelId(g.id) ? 'wheel' : 'gamepad';
  }

  private bindingsFor(device: InputDeviceKind, action: Action, padId: string): PadDef[] {
    const b = this.settings.bindings[`${device}.${action}`];
    if (b && b.device === device && b.kind !== 'key') return [{ kind: b.kind, code: b.code as number, dir: b.dir }];
    return (device === 'wheel' ? wheelDefaults(padId) : PAD_DEFAULTS)[action];
  }

  private keysFor(action: string): string[] {
    const b = this.settings.bindings[`keyboard.${action}`];
    if (b && b.kind === 'key') return [String(b.code)];
    return KEY_DEFAULTS[action] ?? [];
  }

  /** Normalised 0..1 pedal value. For axes, auto-calibrates against the observed range. */
  private pedal(g: Gamepad, def: PadDef, invert: boolean): number {
    if (def.kind === 'button') {
      const v = g.buttons[def.code]?.value ?? 0;
      return invert ? 1 - v : v;
    }
    const v = g.axes[def.code] ?? 0;
    const key = `${g.id}#${def.code}`;
    let cal = this.calibration[key];
    if (!cal) cal = this.calibration[key] = { lo: v, hi: v };
    if (v < cal.lo) cal.lo = v;
    if (v > cal.hi) cal.hi = v;
    let lo = cal.lo, hi = cal.hi;
    if (hi - lo < 0.5) { lo = -1; hi = 1; }
    let t = clamp((v - lo) / (hi - lo), 0, 1);
    let dir = def.dir ?? 1;
    if (invert) dir = dir === 1 ? -1 : 1;
    if (dir === -1) t = 1 - t;
    return t < 0.02 ? 0 : t;
  }

  private digital(g: Gamepad, def: PadDef): boolean {
    if (def.kind === 'button') return !!g.buttons[def.code]?.pressed;
    return (g.axes[def.code] ?? 0) * (def.dir ?? 1) > 0.6;
  }

  // -------------------------------------------------------------- poll

  poll(dt: number, speedKmh: number): { controls: Controls; ui: UiActions; device: InputDeviceKind; deviceName: string } {
    dt = clamp(dt, 0, 0.1);
    const s = this.settings;
    const pads = this.pads();

    // Gamepad edge detection + activity
    const padEdges = new Map<number, boolean[]>();
    let activePad: Gamepad | null = null;
    for (const g of pads) {
      const prev = this.prevButtons.get(g.index) ?? [];
      const edges: boolean[] = [];
      const hold: boolean[] = [];
      let any = false;
      g.buttons.forEach((b, i) => {
        hold[i] = b.pressed;
        edges[i] = b.pressed && !prev[i];
        if (edges[i]) any = true;
      });
      const pa = this.prevAxes.get(g.index);
      if (pa) g.axes.forEach((a, i) => { if (Math.abs(a - (pa[i] ?? a)) > 0.08) any = true; });
      this.prevAxes.set(g.index, Array.from(g.axes));
      this.prevButtons.set(g.index, hold);
      padEdges.set(g.index, edges);
      if (any) activePad = g;
    }
    if (activePad && s.device === 'auto') this.lastDevice = this.padKind(activePad);

    let device: InputDeviceKind = s.device === 'auto' ? this.lastDevice : s.device;
    let pad: Gamepad | undefined;
    if (device !== 'keyboard') {
      pad = pads.find(g => this.padKind(g) === device) ?? (s.device === device ? pads[0] : undefined);
      if (!pad) device = 'keyboard';
    }

    const latch = this.pressedLatch;
    const edgeKey = (action: string): boolean => this.keysFor(action).some(k => latch.has(k));
    const heldKey = (action: string): boolean => this.keysFor(action).some(k => this.held.has(k));

    const controls: Controls = { steer: 0, throttle: 0, brake: 0, shiftUp: false, shiftDown: false, boost: false, pitLimiter: this.pitLimiterOn };
    let deviceName = 'Keyboard';
    let toggleLimiter = false;

    if (device === 'keyboard' || !pad) {
      const left = heldKey('steerLeft') ? 1 : 0, right = heldKey('steerRight') ? 1 : 0;
      this.steerKb = filterKeyboardSteer(this.steerKb, left - right, speedKmh, dt);
      controls.steer = clamp(this.steerKb * s.steerSensitivity, -1, 1);
      this.thr = rampPedal(this.thr, heldKey('throttle') ? 1 : 0, dt);
      this.brk = rampPedal(this.brk, heldKey('brake') ? 1 : 0, dt);
      controls.throttle = this.thr; controls.brake = this.brk;
      controls.shiftUp = edgeKey('shiftUp');
      controls.shiftDown = edgeKey('shiftDown');
      controls.boost = heldKey('boost');
      toggleLimiter = edgeKey('pitLimiter');
    } else {
      const p = pad;
      deviceName = p.id.replace(/\(.*?\)/g, '').trim().slice(0, 48) || (device === 'wheel' ? 'Wheel' : 'Gamepad');
      const edges = padEdges.get(p.index) ?? [];
      const anyEdge = (a: Action) => this.bindingsFor(device, a, p.id).some(d => d.kind === 'button' && !!edges[d.code]);
      const anyHeld = (a: Action) => this.bindingsFor(device, a, p.id).some(d => this.digital(p, d));
      // steering: axis value -1 = left, so steer = -axis
      const sd = this.bindingsFor(device, 'steer', p.id)[0];
      const raw = sd.kind === 'axis' ? (p.axes[sd.code] ?? 0) * (sd.dir ?? 1) : 0;
      let steer: number;
      if (device === 'wheel') {
        const deg = applyDeadzone(raw, Math.min(s.deadzone, 0.02)) * (s.wheelRotationDeg / 2);
        steer = -deg / Math.max(10, s.wheelLockDeg) * s.steerSensitivity;
      } else {
        const v = applyDeadzone(raw, s.deadzone);
        steer = -Math.sign(v) * Math.pow(Math.abs(v), Math.max(0.3, s.steerLinearity)) * s.steerSensitivity;
        steer *= 1 - 0.5 * clamp(speedKmh / 300, 0, 1);
      }
      controls.steer = clamp(steer, -1, 1);
      // pedals
      const td = this.bindingsFor(device, 'throttle', p.id)[0];
      if (device === 'wheel' && s.combinedPedals && td.kind === 'axis') {
        // one axis: moving towards `dir` = throttle, the other way = brake (rest at centre)
        const x = (p.axes[td.code] ?? 0) * (td.dir ?? 1) * (s.invertThrottle ? -1 : 1);
        controls.throttle = x > 0.02 ? clamp(x, 0, 1) : 0;
        controls.brake = x < -0.02 ? clamp(-x, 0, 1) : 0;
      } else {
        const bd = this.bindingsFor(device, 'brake', p.id)[0];
        controls.throttle = this.pedal(p, td, s.invertThrottle);
        controls.brake = this.pedal(p, bd, s.invertBrake);
      }
      controls.shiftUp = anyEdge('shiftUp');
      controls.shiftDown = anyEdge('shiftDown');
      controls.boost = anyHeld('boost');
      toggleLimiter = anyEdge('pitLimiter');
    }
    if (toggleLimiter) this.pitLimiterOn = !this.pitLimiterOn;
    controls.pitLimiter = this.pitLimiterOn;

    // UI actions: keyboard always, plus the active pad's bindings
    const ui: UiActions = {
      pause: edgeKey('pause'), camera: edgeKey('camera'), lookBack: heldKey('lookBack'),
      ok: latch.has('Enter') || latch.has('NumpadEnter'), back: latch.has('Escape'),
    };
    if (pad) {
      const p = pad;
      const edges = padEdges.get(p.index) ?? [];
      const dev = this.padKind(p);
      const ed = (a: Action) => this.bindingsFor(dev, a, p.id).some(d => d.kind === 'button' && !!edges[d.code]);
      ui.pause = ui.pause || ed('pause');
      ui.camera = ui.camera || ed('camera');
      ui.lookBack = ui.lookBack || this.bindingsFor(dev, 'lookBack', p.id).some(d => this.digital(p, d));
      ui.ok = ui.ok || !!edges[0];
      ui.back = ui.back || !!edges[1];
    }
    if (this.capturing) {
      ui.pause = ui.camera = ui.ok = ui.back = false;
      controls.shiftUp = controls.shiftDown = false;
    }
    latch.clear();
    return { controls, ui, device, deviceName };
  }

  // -------------------------------------------------------------- rebinding

  /** Listen for the next pressed key/button/axis movement (for rebinding). */
  captureNext(): Promise<Binding> {
    this.capCancel?.();
    this.capturing = true;
    this.capBase = this.pads().map(g => ({ id: g.id, buttons: g.buttons.map(b => (b.pressed ? 1 : 0)), axes: Array.from(g.axes) }));
    return new Promise<Binding>((resolve) => {
      let done = false;
      const onKey = (e: KeyboardEvent) => {
        e.preventDefault(); e.stopPropagation();
        finish({ device: 'keyboard', kind: 'key', code: e.code });
      };
      const finish = (b: Binding) => {
        if (done) return;
        done = true;
        window.removeEventListener('keydown', onKey, true);
        cancelAnimationFrame(this.capRaf);
        this.capCancel = null;
        // keep ignoring input briefly so the captured press doesn't trigger game actions
        setTimeout(() => { this.capturing = false; this.pressedLatch.clear(); this.oneShot.clear(); }, 80);
        resolve(b);
      };
      this.capCancel = () => { done = true; window.removeEventListener('keydown', onKey, true); cancelAnimationFrame(this.capRaf); };
      window.addEventListener('keydown', onKey, true);
      const loop = () => {
        if (done) return;
        for (const g of this.pads()) {
          const base = this.capBase.find(b => b.id === g.id);
          const kind = this.padKind(g);
          for (let i = 0; i < g.buttons.length; i++) {
            if (g.buttons[i].pressed && !base?.buttons[i]) { finish({ device: kind, kind: 'button', code: i }); return; }
          }
          for (let i = 0; i < g.axes.length; i++) {
            const d = g.axes[i] - (base?.axes[i] ?? 0);
            if (Math.abs(d) > 0.6) { finish({ device: kind, kind: 'axis', code: i, dir: d > 0 ? 1 : -1 }); return; }
          }
        }
        this.capRaf = requestAnimationFrame(loop);
      };
      this.capRaf = requestAnimationFrame(loop);
    });
  }

  /** Store a captured binding for an action ('steerLeft'/'steerRight' for keyboard steering). */
  setBinding(action: string, b: Binding): void {
    this.settings.bindings[`${b.device}.${action}`] = b;
    this.save();
  }
  clearBindings(): void { this.settings.bindings = {}; this.save(); }

  /** Human-readable description of the current binding for the settings UI. */
  describeBinding(device: InputDeviceKind, action: string): string {
    const b = this.settings.bindings[`${device}.${action}`];
    if (b) {
      return b.kind === 'key' ? String(b.code).replace(/^Key/, '')
        : `${b.kind === 'axis' ? 'Axis' : 'Button'} ${b.code}${b.dir ? (b.dir > 0 ? '+' : '-') : ''}`;
    }
    if (device === 'keyboard') return this.keysFor(action).map(k => k.replace(/^Key/, '').replace('Arrow', '')).join(' / ');
    const defs = (device === 'wheel' ? wheelDefaults('') : PAD_DEFAULTS)[action as Action];
    if (!defs) return '-';
    if (device === 'wheel' && (action === 'throttle' || action === 'brake')) return 'by brand';
    return defs.map(d => `${d.kind === 'axis' ? 'Axis' : 'Button'} ${d.code}`).join(' / ');
  }

  // -------------------------------------------------------------- rumble

  rumble(strong: number, weak: number, ms: number): void {
    try {
      for (const g of this.pads().filter(p => this.padKind(p) === 'gamepad')) {
        const act = (g as any).vibrationActuator;
        if (act?.playEffect) {
          const r = act.playEffect('dual-rumble', {
            startDelay: 0, duration: ms, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1),
          });
          r?.catch?.(() => {});
        }
      }
    } catch { /* unsupported */ }
  }
}
