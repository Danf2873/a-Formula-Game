import type { CarSetup, TyreCompound } from '../types';
import type { InputManager } from '../input/inputManager';
import { el, btn, sliderRow, TYRE_COLORS } from './dom';
import { renderSetupEditor } from './setupEditor';
import { renderSettings } from './settingsPanel';
import { startPadNav } from './padNav';

export interface PauseActions {
  resume(): void;
  restart(): void;
  quit(): void;
  setup?: (s: CarSetup) => void;
  pitStrategy?: { compound: TyreCompound; fuelKg: number; set(c: TyreCompound, fuel: number): void };
  /** Optional: enables save/load of setups for this circuit in the editor. */
  circuitId?: string;
}

export class PauseMenu {
  private wrap: HTMLElement;
  private body: HTMLElement;
  private _open = false;
  private stopNav: (() => void) | null = null;
  private actions: PauseActions | null = null;
  private setup: CarSetup | null = null;
  private sub: (() => void) | null = null;

  constructor(root: HTMLElement, private input: InputManager) {
    this.wrap = el('div', 'screen pause hidden', undefined, root);
    this.body = el('div', 'pause-body', undefined, this.wrap);
  }

  get isOpen(): boolean { return this._open; }

  open(actions: PauseActions, setup: CarSetup): void {
    this.actions = actions;
    this.setup = { ...setup };
    this._open = true;
    this.wrap.classList.remove('hidden');
    this.root();
    this.stopNav?.();
    this.stopNav = startPadNav(() => this.wrap, this.input, () => { if (this.sub) this.root(); else this.actions?.resume(); });
  }

  close(): void {
    this._open = false;
    this.sub = null;
    this.wrap.classList.add('hidden');
    this.body.textContent = '';
    this.stopNav?.(); this.stopNav = null;
  }

  private reset(title: string, back = true): HTMLElement {
    this.body.textContent = '';
    const head = el('div', 'menu-head', undefined, this.body);
    if (back) btn('‹ Back', () => this.root(), 'btn small ghost', head);
    el('h2', 'menu-title', title, head);
    this.sub = back ? () => this.root() : null;
    const c = el('div', 'pause-content', undefined, this.body);
    queueMicrotask(() => c.querySelector<HTMLElement>('button, input, select')?.focus({ preventScroll: true }));
    return c;
  }

  private root(): void {
    const a = this.actions!;
    this.body.textContent = '';
    this.sub = null;
    el('h2', 'menu-title center', 'PAUSED', this.body);
    const list = el('div', 'menu-list', undefined, this.body);
    const item = (label: string, fn: () => void, cls = 'menu-item') => {
      const b = btn('', fn, cls, list);
      el('span', 'mi-label', label, b);
      return b;
    };
    const first = item('Resume', () => a.resume(), 'menu-item btn-primary');
    item('Restart', () => a.restart());
    if (a.setup) item('Car Setup', () => this.setupView());
    if (a.pitStrategy) item('Pit Strategy', () => this.pitView());
    item('Settings', () => this.settingsView());
    item('Quit to menu', () => this.quitView());
    queueMicrotask(() => first.focus({ preventScroll: true }));
  }

  private setupView(): void {
    const c = this.reset('Car Setup');
    renderSetupEditor(c, this.setup!, s => { this.setup = s; this.actions?.setup?.(s); }, { circuitId: this.actions?.circuitId });
  }

  private settingsView(): void {
    const c = this.reset('Settings');
    renderSettings(c, this.input);
  }

  private pitView(): void {
    const ps = this.actions!.pitStrategy!;
    const c = this.reset('Pit Strategy');
    const p = el('div', 'panel', undefined, c);
    let comp = ps.compound, fuel = ps.fuelKg;
    el('h3', undefined, 'Next tyre compound', p);
    const chips = el('div', 'chips', undefined, p);
    (['soft', 'medium', 'hard', 'inter', 'wet'] as TyreCompound[]).forEach(t => {
      const b = btn(t[0].toUpperCase() + t.slice(1), () => {
        comp = t; ps.set(comp, fuel);
        chips.querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      }, 'chip' + (comp === t ? ' active' : ''), chips);
      b.style.setProperty('--chip', TYRE_COLORS[t]);
    });
    sliderRow(p, 'Fuel to add', 0, 110, 1, fuel, v => v + ' kg', v => { fuel = v; ps.set(comp, fuel); },
      'Takes effect at your next pit stop.');
  }

  private quitView(): void {
    const a = this.actions!;
    const c = this.reset('Quit to menu?');
    const p = el('div', 'panel', undefined, c);
    el('p', undefined, 'The current session will be abandoned.', p);
    const row = el('div', 'actions', undefined, p);
    btn('Cancel', () => this.root(), 'btn', row);
    btn('Quit', () => a.quit(), 'btn btn-primary', row);
  }
}
