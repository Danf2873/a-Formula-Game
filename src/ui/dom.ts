// Small DOM helpers shared by the UI modules.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string, parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export function btn(label: string, onClick: () => void, cls = 'btn', parent?: HTMLElement): HTMLButtonElement {
  const b = el('button', cls, label, parent);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** m:ss.mmm */
export function fmtLap(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !isFinite(ms)) return '--:--.---';
  const m = Math.floor(ms / 60000);
  const s = (ms - m * 60000) / 1000;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}

/** Sector / short time: ss.mmm */
export function fmtSector(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !isFinite(ms)) return '--.---';
  return (ms / 1000).toFixed(3);
}

export function fmtGap(ms: number): string {
  if (!isFinite(ms)) return '';
  if (ms >= 60000) return `+${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, '0')}`;
  return `+${(ms / 1000).toFixed(3)}`;
}

export function fmtClock(ms: number): string {
  if (!isFinite(ms)) return '--:--';
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export const TYRE_COLORS: Record<string, string> = {
  soft: '#e10600', medium: '#ffd400', hard: '#f0f0f0', inter: '#43b02a', wet: '#0067ad',
};
export const TYRE_LETTER: Record<string, string> = { soft: 'S', medium: 'M', hard: 'H', inter: 'I', wet: 'W' };

/** Labelled slider row. Returns the wrapper. */
export function sliderRow(
  parent: HTMLElement, label: string, min: number, max: number, step: number, value: number,
  fmt: (v: number) => string, onChange: (v: number) => void, help?: string,
): HTMLElement {
  const row = el('div', 'row', undefined, parent);
  const l = el('label', 'row-label', label, row);
  const inp = el('input', 'slider', undefined, row);
  inp.type = 'range';
  inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(value);
  const out = el('span', 'row-value mono', fmt(value), row);
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    out.textContent = fmt(v);
    onChange(v);
  });
  if (help) { row.title = help; el('div', 'row-help', help, row); }
  void l;
  return row;
}

export function checkRow(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = el('div', 'row', undefined, parent);
  el('label', 'row-label', label, row);
  const inp = el('input', 'check', undefined, row);
  inp.type = 'checkbox'; inp.checked = value;
  inp.addEventListener('change', () => onChange(inp.checked));
  return row;
}

export function selectRow<T extends string | number>(
  parent: HTMLElement, label: string, options: { value: T; label: string }[], value: T, onChange: (v: T) => void,
): HTMLElement {
  const row = el('div', 'row', undefined, parent);
  el('label', 'row-label', label, row);
  const sel = el('select', 'select', undefined, row);
  for (const o of options) {
    const op = el('option', undefined, o.label, sel);
    op.value = String(o.value);
    if (o.value === value) op.selected = true;
  }
  sel.addEventListener('change', () => {
    const o = options.find(x => String(x.value) === sel.value);
    if (o) onChange(o.value);
  });
  return row;
}
