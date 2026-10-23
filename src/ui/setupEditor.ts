import type { CarSetup, TyreCompound } from '../types';
import { defaultSetup } from '../physics/car';
import { el, btn, TYRE_COLORS } from './dom';

interface Field {
  key: Exclude<keyof CarSetup, 'startCompound'>;
  label: string; min: number; max: number; step: number; unit?: string; dec: number; help: string;
}

const GROUPS: { title: string; fields: Field[] }[] = [
  { title: 'Aerodynamics', fields: [
    { key: 'frontWing', label: 'Front wing', min: 0, max: 10, step: 0.5, dec: 1, help: 'More front wing: more front grip and downforce, more drag.' },
    { key: 'rearWing', label: 'Rear wing', min: 0, max: 10, step: 0.5, dec: 1, help: 'More rear wing: more stability and traction, lower top speed.' },
  ] },
  { title: 'Suspension', fields: [
    { key: 'frontArb', label: 'Front anti-roll bar', min: 1, max: 11, step: 1, dec: 0, help: 'Stiffer: sharper turn-in, more understeer in slow corners.' },
    { key: 'rearArb', label: 'Rear anti-roll bar', min: 1, max: 11, step: 1, dec: 0, help: 'Stiffer: more oversteer, better rotation, less rear traction.' },
    { key: 'frontSpring', label: 'Front springs', min: 1, max: 11, step: 1, dec: 0, help: 'Stiffer: better aero platform and response, worse over kerbs.' },
    { key: 'rearSpring', label: 'Rear springs', min: 1, max: 11, step: 1, dec: 0, help: 'Stiffer: sharper response, less mechanical grip on bumps.' },
    { key: 'frontRideHeightMm', label: 'Front ride height', min: 15, max: 35, step: 1, unit: 'mm', dec: 0, help: 'Lower: more downforce, but risk of bottoming out.' },
    { key: 'rearRideHeightMm', label: 'Rear ride height', min: 35, max: 60, step: 1, unit: 'mm', dec: 0, help: 'Higher rake: more rear downforce and stability on the straights.' },
  ] },
  { title: 'Wheel alignment', fields: [
    { key: 'frontCamberDeg', label: 'Front camber', min: -3.5, max: -2.5, step: 0.1, unit: '°', dec: 1, help: 'More negative: more cornering grip, faster inside tyre wear.' },
    { key: 'rearCamberDeg', label: 'Rear camber', min: -2.0, max: -1.0, step: 0.1, unit: '°', dec: 1, help: 'More negative: more cornering grip, less traction and braking.' },
    { key: 'frontToeDeg', label: 'Front toe-out', min: 0, max: 0.2, step: 0.01, unit: '°', dec: 2, help: 'More toe-out: sharper turn-in, less straight-line stability.' },
    { key: 'rearToeDeg', label: 'Rear toe-in', min: 0.1, max: 0.5, step: 0.01, unit: '°', dec: 2, help: 'More toe-in: more rear stability, more drag and tyre heat.' },
  ] },
  { title: 'Brakes and differential', fields: [
    { key: 'brakeBias', label: 'Brake bias (front)', min: 0.5, max: 0.65, step: 0.005, dec: 3, help: 'More forward: stable braking but front lock-ups. More rearward: rotates but risks rear locking.' },
    { key: 'brakePressure', label: 'Brake pressure', min: 0.8, max: 1.0, step: 0.01, dec: 2, help: 'Higher: stronger braking, easier to lock a wheel.' },
    { key: 'diffOnThrottle', label: 'Diff lock on throttle', min: 0.1, max: 1.0, step: 0.05, dec: 2, help: 'Higher: better traction out of corners, more understeer on power.' },
    { key: 'diffOffThrottle', label: 'Diff lock off throttle', min: 0.1, max: 1.0, step: 0.05, dec: 2, help: 'Higher: more stability on entry, more understeer into the corner.' },
  ] },
  { title: 'Tyres and fuel', fields: [
    { key: 'tyrePressurePsi', label: 'Tyre pressure (cold)', min: 21, max: 26, step: 0.1, unit: 'psi', dec: 1, help: 'Higher: less rolling resistance and faster warm-up, smaller contact patch.' },
    { key: 'fuelKg', label: 'Starting fuel', min: 5, max: 110, step: 1, unit: 'kg', dec: 0, help: 'More fuel: longer stint, slower car and heavier on tyres.' },
  ] },
];

const COMPOUNDS: TyreCompound[] = ['soft', 'medium', 'hard', 'inter', 'wet'];

export function loadSetup(circuitId: string): CarSetup | null {
  try {
    const raw = localStorage.getItem('f1.setup.' + circuitId);
    if (!raw) return null;
    return { ...defaultSetup(), ...JSON.parse(raw) } as CarSetup;
  } catch { return null; }
}

export function saveSetup(circuitId: string, s: CarSetup): void {
  try { localStorage.setItem('f1.setup.' + circuitId, JSON.stringify(s)); } catch { /* ignore */ }
}

/**
 * Renders the setup editor into `container` (replacing its content).
 * `opts.circuitId` enables Save / Load buttons for that circuit.
 */
export function renderSetupEditor(
  container: HTMLElement, setup: CarSetup, onChange: (s: CarSetup) => void,
  opts: { circuitId?: string } = {},
): void {
  let cur: CarSetup = { ...setup };

  const build = () => {
    container.textContent = '';
    const root = el('div', 'setup-editor', undefined, container);
    const bar = el('div', 'setup-bar', undefined, root);
    btn('Reset to default', () => { cur = defaultSetup(); emit(); build(); }, 'btn small', bar);
    if (opts.circuitId) {
      const id = opts.circuitId;
      const status = el('span', 'setup-status', '', bar);
      btn('Save for circuit', () => { saveSetup(id, cur); status.textContent = 'Saved.'; }, 'btn small', bar);
      btn('Load for circuit', () => {
        const l = loadSetup(id);
        if (l) { cur = l; emit(); build(); } else status.textContent = 'No saved setup for this circuit.';
      }, 'btn small', bar);
    }

    const grid = el('div', 'setup-grid', undefined, root);
    for (const g of GROUPS) {
      const card = el('div', 'panel setup-group', undefined, grid);
      el('h3', undefined, g.title, card);
      for (const f of g.fields) {
        const row = el('div', 'setup-row', undefined, card);
        const head = el('div', 'setup-head', undefined, row);
        el('span', 'setup-label', f.label, head);
        const out = el('span', 'mono setup-val', '', head);
        const fmt = (v: number) => v.toFixed(f.dec) + (f.unit ? ' ' + f.unit : '');
        out.textContent = fmt(cur[f.key]);
        const inp = el('input', 'slider', undefined, row);
        inp.type = 'range';
        inp.min = String(f.min); inp.max = String(f.max); inp.step = String(f.step);
        inp.value = String(cur[f.key]);
        inp.addEventListener('input', () => {
          const v = parseFloat(inp.value);
          cur[f.key] = v;
          out.textContent = fmt(v);
          emit();
        });
        el('div', 'row-help', f.help, row);
      }
    }

    const card = el('div', 'panel setup-group', undefined, grid);
    el('h3', undefined, 'Starting tyre', card);
    const chips = el('div', 'chips', undefined, card);
    for (const c of COMPOUNDS) {
      const b = btn(c[0].toUpperCase() + c.slice(1), () => {
        cur.startCompound = c; emit();
        chips.querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      }, 'chip' + (cur.startCompound === c ? ' active' : ''), chips);
      b.style.setProperty('--chip', TYRE_COLORS[c]);
    }
    el('div', 'row-help', 'Softer: more grip, wears faster. Inter/wet are for damp and wet tracks.', card);
  };

  const emit = () => onChange({ ...cur });
  build();
}
