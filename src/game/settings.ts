// Game-wide (non-input) settings written by the settings screen.
export interface GameSettings {
  quality: 'low' | 'medium' | 'high';
  volume: number;
  units: 'kmh' | 'mph';
}

const DEFAULTS: GameSettings = { quality: 'medium', volume: 0.8, units: 'kmh' };

export function readGameSettings(): GameSettings {
  try {
    const raw = localStorage.getItem('f1.settings');
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}
