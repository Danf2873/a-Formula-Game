// Non-input user preferences (graphics, volume, units). Persisted in localStorage 'f1.settings'.

export interface Prefs {
  quality: 'low' | 'medium' | 'high';
  volume: number;            // 0..1
  units: 'kmh' | 'mph';
}

const KEY = 'f1.settings';
let prefs: Prefs = { quality: 'medium', volume: 0.8, units: 'kmh' };
const listeners = new Set<(p: Prefs) => void>();

try {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
  if (raw) prefs = { ...prefs, ...JSON.parse(raw) };
} catch { /* ignore */ }

export function getPrefs(): Prefs { return prefs; }

export function setPrefs(p: Partial<Prefs>): void {
  prefs = { ...prefs, ...p };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  for (const l of listeners) l(prefs);
}

/** Subscribe to changes; returns an unsubscribe function. */
export function onPrefsChange(fn: (p: Prefs) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
