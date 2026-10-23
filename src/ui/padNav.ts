// Optional gamepad focus navigation for DOM menus: D-pad / left stick moves focus, A clicks, B goes back.
import type { InputManager } from '../input/inputManager';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]';

export function startPadNav(getContainer: () => HTMLElement | null, input: InputManager | null, onBack?: () => void): () => void {
  let raf = 0;
  let stopped = false;
  const prev: boolean[] = [];
  let lastStick = 0;

  const move = (dir: 1 | -1) => {
    const c = getContainer();
    if (!c) return;
    const list = Array.from(c.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(e => e.offsetParent !== null);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const n = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
    list[n].focus();
    list[n].scrollIntoView({ block: 'nearest' });
  };

  const adjust = (dir: 1 | -1) => {
    const a = document.activeElement as HTMLInputElement | HTMLSelectElement | null;
    if (!a) return false;
    if (a.tagName === 'INPUT' && (a as HTMLInputElement).type === 'range') {
      const r = a as HTMLInputElement;
      if (dir > 0) r.stepUp(); else r.stepDown();
      a.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (a.tagName === 'SELECT') {
      const s = a as HTMLSelectElement;
      const n = Math.max(0, Math.min(s.options.length - 1, s.selectedIndex + dir));
      if (n !== s.selectedIndex) { s.selectedIndex = n; s.dispatchEvent(new Event('change', { bubbles: true })); }
      return true;
    }
    return false;
  };

  const loop = () => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    if (input?.isCapturing) return;
    let g: Gamepad | null = null;
    try { g = Array.from(navigator.getGamepads?.() ?? []).find(x => !!x && x.connected) ?? null; } catch { /* none */ }
    if (!g) return;
    const down = (i: number) => !!g!.buttons[i]?.pressed;
    const edge = (i: number) => down(i) && !prev[i];
    const now = performance.now();
    const ax = g.axes[0] ?? 0, ay = g.axes[1] ?? 0;
    let stickV = 0, stickH = 0;
    if (now - lastStick > 220) {
      if (ay > 0.6) stickV = 1; else if (ay < -0.6) stickV = -1;
      if (ax > 0.6) stickH = 1; else if (ax < -0.6) stickH = -1;
      if (stickV || stickH) lastStick = now;
    }
    if (edge(13) || stickV > 0) move(1);
    if (edge(12) || stickV < 0) move(-1);
    if (edge(15) || stickH > 0) { if (!adjust(1)) move(1); }
    if (edge(14) || stickH < 0) { if (!adjust(-1)) move(-1); }
    if (edge(0)) (document.activeElement as HTMLElement | null)?.click?.();
    if (edge(1)) onBack?.();
    for (let i = 0; i < g.buttons.length; i++) prev[i] = down(i);
  };
  raf = requestAnimationFrame(loop);
  return () => { stopped = true; cancelAnimationFrame(raf); };
}
