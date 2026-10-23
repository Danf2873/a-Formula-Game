import type { InputDeviceKind } from '../types';
import { InputManager, ACTIONS, ACTION_LABELS } from '../input/inputManager';
import type { Action } from '../input/inputManager';
import { el, btn, sliderRow, checkRow, selectRow } from './dom';
import { getPrefs, setPrefs } from './prefs';

/** Shared settings UI (main menu + pause menu). */
export function renderSettings(container: HTMLElement, input: InputManager): void {
  container.textContent = '';
  const s = input.settings;
  const root = el('div', 'settings', undefined, container);
  const cols = el('div', 'settings-cols', undefined, root);

  // ---- input
  const p1 = el('div', 'panel', undefined, cols);
  el('h3', undefined, 'Controls', p1);
  selectRow<string>(p1, 'Input device', [
    { value: 'auto', label: 'Auto (last used)' }, { value: 'keyboard', label: 'Keyboard' },
    { value: 'gamepad', label: 'Gamepad' }, { value: 'wheel', label: 'Steering wheel' },
  ], s.device, v => { s.device = v as typeof s.device; input.save(); });
  sliderRow(p1, 'Steering sensitivity', 0.5, 1.5, 0.05, s.steerSensitivity, v => v.toFixed(2), v => { s.steerSensitivity = v; input.save(); });
  sliderRow(p1, 'Stick linearity', 0.6, 2.5, 0.05, s.steerLinearity, v => v.toFixed(2), v => { s.steerLinearity = v; input.save(); },
    '1 = linear, higher = softer around the centre.');
  sliderRow(p1, 'Stick deadzone', 0, 0.4, 0.01, s.deadzone, v => v.toFixed(2), v => { s.deadzone = v; input.save(); });
  el('h4', undefined, 'Steering wheel', p1);
  sliderRow(p1, 'Wheel rotation', 180, 1080, 10, s.wheelRotationDeg, v => v + '°', v => { s.wheelRotationDeg = v; input.save(); },
    'Set to the rotation configured in your wheel driver (900 typical).');
  sliderRow(p1, 'Degrees for full lock', 40, 270, 5, s.wheelLockDeg, v => v + '°', v => { s.wheelLockDeg = v; input.save(); },
    'Wheel rotation from centre that equals full steering lock. 95 is 1:1 with a real car.');
  checkRow(p1, 'Invert throttle', s.invertThrottle, v => { s.invertThrottle = v; input.save(); });
  checkRow(p1, 'Invert brake', s.invertBrake, v => { s.invertBrake = v; input.save(); });
  checkRow(p1, 'Combined pedals', s.combinedPedals, v => { s.combinedPedals = v; input.save(); });
  btn('Reset pedal calibration', () => input.resetCalibration(), 'btn small', p1);
  el('div', 'row-help', 'Pedals auto-calibrate: press each pedal fully once. Force feedback is not available in browsers.', p1);

  // ---- bindings
  const p2 = el('div', 'panel', undefined, cols);
  el('h3', undefined, 'Key and button bindings', p2);
  const devSel: { dev: InputDeviceKind } = { dev: s.device === 'gamepad' || s.device === 'wheel' ? s.device : 'keyboard' };
  const list = el('div', 'bind-list', undefined, p2);
  const renderBindings = () => {
    list.textContent = '';
    const tabs = el('div', 'chips', undefined, list);
    (['keyboard', 'gamepad', 'wheel'] as InputDeviceKind[]).forEach(d => {
      btn(d[0].toUpperCase() + d.slice(1), () => { devSel.dev = d; renderBindings(); }, 'chip' + (devSel.dev === d ? ' active' : ''), tabs);
    });
    const actions: string[] = devSel.dev === 'keyboard'
      ? ['throttle', 'brake', 'steerLeft', 'steerRight', ...ACTIONS.filter(a => a !== 'steer' && a !== 'throttle' && a !== 'brake')]
      : [...ACTIONS];
    for (const a of actions) {
      const row = el('div', 'bind-row', undefined, list);
      const label = a === 'steerLeft' ? 'Steer left' : a === 'steerRight' ? 'Steer right' : ACTION_LABELS[a as Action];
      el('span', 'row-label', label, row);
      const val = el('span', 'mono bind-val', input.describeBinding(devSel.dev, a), row);
      const b = btn('Rebind', async () => {
        b.textContent = 'Press...';
        const r = await input.captureNext();
        if (r.device !== devSel.dev) { b.textContent = 'Wrong device'; setTimeout(() => { b.textContent = 'Rebind'; }, 1200); return; }
        input.setBinding(a, r);
        val.textContent = input.describeBinding(devSel.dev, a);
        b.textContent = 'Rebind';
      }, 'btn small', row);
    }
    btn('Reset all bindings', () => { input.clearBindings(); renderBindings(); }, 'btn small', list);
  };
  renderBindings();

  // ---- assists + game
  const p3 = el('div', 'panel', undefined, cols);
  el('h3', undefined, 'Driving aids', p3);
  checkRow(p3, 'Automatic gearbox', s.autoGearbox, v => { s.autoGearbox = v; input.save(); });
  sliderRow(p3, 'Traction control', 0, 1, 0.05, s.tractionControl, v => (v * 100).toFixed(0) + '%', v => { s.tractionControl = v; input.save(); });
  checkRow(p3, 'ABS', s.absAssist, v => { s.absAssist = v; input.save(); });
  sliderRow(p3, 'Steering assist', 0, 1, 0.05, s.steeringAssist, v => (v * 100).toFixed(0) + '%', v => { s.steeringAssist = v; input.save(); });
  el('h3', undefined, 'Game', p3);
  const pr = getPrefs();
  selectRow(p3, 'Graphics quality', [
    { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
  ], pr.quality, v => setPrefs({ quality: v as 'low' | 'medium' | 'high' }));
  sliderRow(p3, 'Volume', 0, 1, 0.05, pr.volume, v => Math.round(v * 100) + '%', v => setPrefs({ volume: v }));
  selectRow(p3, 'Speed units', [{ value: 'kmh', label: 'km/h' }, { value: 'mph', label: 'mph' }], pr.units,
    v => setPrefs({ units: v as 'kmh' | 'mph' }));
}
