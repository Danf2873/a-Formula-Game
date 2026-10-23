// 2026 grid: colours and performance only, no logos or sponsor names.
import type { Team, Driver } from '../types';

function team(
  id: string, name: string, fullName: string, engine: string,
  primary: string, secondary: string, accent: string,
  power: number, downforce: number, drag: number, tyreWear: number,
): Team {
  return { id, name, fullName, engine, colors: { primary, secondary, accent }, performance: { power, downforce, drag, tyreWear } };
}

export const TEAMS: Team[] = [
  team('mclaren', 'McLaren', 'McLaren Formula 1 Team', 'Mercedes', '#ff8000', '#111111', '#47c7fc', 1.0, 1.02, 0.99, 0.96),
  team('mercedes', 'Mercedes', 'Mercedes-AMG Petronas F1 Team', 'Mercedes', '#c6c6c6', '#111111', '#00d2be', 1.02, 1.0, 0.99, 0.98),
  team('ferrari', 'Ferrari', 'Scuderia Ferrari HP', 'Ferrari', '#dc0000', '#ffffff', '#ffeb00', 1.0, 1.0, 1.0, 1.0),
  team('redbull', 'Red Bull Racing', 'Oracle Red Bull Racing', 'Red Bull Ford', '#1e2a5a', '#e10600', '#ffcc00', 1.0, 1.01, 0.99, 1.0),
  team('astonmartin', 'Aston Martin', 'Aston Martin Aramco F1 Team', 'Honda', '#00594f', '#cedc00', '#ffffff', 0.99, 0.99, 1.0, 1.02),
  team('alpine', 'Alpine', 'BWT Alpine F1 Team', 'Mercedes', '#0078c1', '#ff87bc', '#ffffff', 0.99, 0.98, 1.0, 1.02),
  team('williams', 'Williams', 'Atlassian Williams Racing', 'Mercedes', '#00a0de', '#041e42', '#ffffff', 1.0, 0.98, 0.99, 1.01),
  team('racingbulls', 'Racing Bulls', 'Visa Cash App Racing Bulls', 'Red Bull Ford', '#f5f5f5', '#2b4562', '#e10600', 0.99, 0.98, 1.0, 1.02),
  team('haas', 'Haas', 'MoneyGram Haas F1 Team', 'Ferrari', '#f0f0f0', '#111111', '#e10600', 0.99, 0.97, 1.01, 1.03),
  team('audi', 'Audi', 'Audi Revolut F1 Team', 'Audi', '#9a9a9a', '#111111', '#e00000', 0.97, 0.97, 1.01, 1.04),
  team('cadillac', 'Cadillac', 'Cadillac Formula 1 Team', 'Ferrari', '#111111', '#ffffff', '#c8a45a', 0.98, 0.96, 1.02, 1.05),
];

function drv(
  id: string, firstName: string, lastName: string, code: string, number: number,
  teamId: string, nationality: string, skill: number, aggression: number,
): Driver {
  return { id, firstName, lastName, code, number, teamId, nationality, skill, aggression };
}

export const DRIVERS: Driver[] = [
  drv('norris', 'Lando', 'Norris', 'NOR', 1, 'mclaren', 'GBR', 0.99, 0.6),
  drv('piastri', 'Oscar', 'Piastri', 'PIA', 81, 'mclaren', 'AUS', 0.985, 0.5),
  drv('leclerc', 'Charles', 'Leclerc', 'LEC', 16, 'ferrari', 'MON', 0.985, 0.7),
  drv('hamilton', 'Lewis', 'Hamilton', 'HAM', 44, 'ferrari', 'GBR', 0.975, 0.6),
  drv('verstappen', 'Max', 'Verstappen', 'VER', 3, 'redbull', 'NED', 1.0, 0.95),
  drv('hadjar', 'Isack', 'Hadjar', 'HAD', 6, 'redbull', 'FRA', 0.92, 0.65),
  drv('russell', 'George', 'Russell', 'RUS', 63, 'mercedes', 'GBR', 0.98, 0.55),
  drv('antonelli', 'Kimi', 'Antonelli', 'ANT', 12, 'mercedes', 'ITA', 0.96, 0.6),
  drv('alonso', 'Fernando', 'Alonso', 'ALO', 14, 'astonmartin', 'ESP', 0.97, 0.8),
  drv('stroll', 'Lance', 'Stroll', 'STR', 18, 'astonmartin', 'CAN', 0.89, 0.45),
  drv('gasly', 'Pierre', 'Gasly', 'GAS', 10, 'alpine', 'FRA', 0.945, 0.6),
  drv('colapinto', 'Franco', 'Colapinto', 'COL', 43, 'alpine', 'ARG', 0.91, 0.65),
  drv('albon', 'Alexander', 'Albon', 'ALB', 23, 'williams', 'THA', 0.945, 0.5),
  drv('sainz', 'Carlos', 'Sainz', 'SAI', 55, 'williams', 'ESP', 0.965, 0.55),
  drv('lawson', 'Liam', 'Lawson', 'LAW', 30, 'racingbulls', 'NZL', 0.93, 0.7),
  drv('lindblad', 'Arvid', 'Lindblad', 'LIN', 41, 'racingbulls', 'GBR', 0.9, 0.6),
  drv('ocon', 'Esteban', 'Ocon', 'OCO', 31, 'haas', 'FRA', 0.935, 0.7),
  drv('bearman', 'Oliver', 'Bearman', 'BEA', 87, 'haas', 'GBR', 0.935, 0.6),
  drv('hulkenberg', 'Nico', 'Hülkenberg', 'HUL', 27, 'audi', 'GER', 0.94, 0.45),
  drv('bortoleto', 'Gabriel', 'Bortoleto', 'BOR', 5, 'audi', 'BRA', 0.91, 0.6),
  drv('perez', 'Sergio', 'Pérez', 'PER', 11, 'cadillac', 'MEX', 0.93, 0.5),
  drv('bottas', 'Valtteri', 'Bottas', 'BOT', 77, 'cadillac', 'FIN', 0.925, 0.4),
];

export function teamById(id: string): Team {
  const t = TEAMS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown team id: ${id}`);
  return t;
}

export function driverById(id: string): Driver {
  const d = DRIVERS.find((x) => x.id === id);
  if (!d) throw new Error(`Unknown driver id: ${id}`);
  return d;
}
