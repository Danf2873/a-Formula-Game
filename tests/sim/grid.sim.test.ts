import { it, expect } from 'vitest';
// @ts-ignore node types not installed
import { readFileSync } from 'node:fs';
import { Track } from '../../src/track/track';
import { Car, defaultSetup } from '../../src/physics/car';
import { AIDriver } from '../../src/ai/aiDriver';
import { resolveCarCollisions } from '../../src/physics/collisions';
import { DRIVERS, teamById } from '../../src/data/grid';
import { NEUTRAL_CONTROLS } from '../../src/types';

// AI cars starting behind a car that never moves (an idle human) must drive around it.
it('AI gets past a stationary car on the grid', () => {
  const track = new Track(JSON.parse(readFileSync('public/circuits/melbourne.json', 'utf8')));
  const env = { wetness: 0, rubber: 0.5, airTempC: 25, trackTempC: 35 };
  const cars = [0, 1, 2, 3, 4, 5].map((p, i) => {
    const d = DRIVERS[i];
    const car = new Car({ setup: defaultSetup(), performance: teamById(d.teamId).performance });
    const g = track.gridSlot(p);
    car.reset(g.position.x, g.position.z, g.heading, track);
    return { car, ai: i === 0 ? null : new AIDriver(track, d, 1, i), hint: { idx: -1 }, id: d.id };
  });
  const startS = cars.map((c) => track.project(c.car.pose.position.x, c.car.pose.position.z, c.hint).s);
  for (let step = 0; step < 240 * 35; step++) {
    const proj = cars.map((c) => track.project(c.car.pose.position.x, c.car.pose.position.z, c.hint));
    cars.forEach((c, i) => {
      let ctl = NEUTRAL_CONTROLS;
      if (c.ai && step % 4 === 0) {
        const others = cars.filter((o) => o !== c).map((o) => {
          const j = cars.indexOf(o);
          return { id: o.id, s: proj[j].s, lateral: proj[j].lateral, speed: o.car.forwardSpeed() };
        });
        (c as any).ctl = c.ai.update(4 / 240, { s: proj[i].s, lateral: proj[i].lateral, speed: c.car.forwardSpeed(), pose: c.car.pose, telemetry: c.car.telemetry, others, phase: 'running', wantPit: false, pitLimitKmh: 80 });
      }
      if (c.ai) ctl = (c as any).ctl ?? NEUTRAL_CONTROLS;
      c.car.step(1 / 240, step % 4 === 0 ? ctl : { ...ctl, shiftUp: false, shiftDown: false }, track, env, false);
    });
    resolveCarCollisions(cars.map((c) => ({ id: c.id, position: c.car.pose.position, quaternion: c.car.pose.quaternion, velocity: c.car.pose.velocity, car: c.car })));
  }
  const L = track.length;
  const moved = cars.map((c, i) => {
    const s = track.project(c.car.pose.position.x, c.car.pose.position.z, c.hint).s;
    return ((s - startS[i]) % L + L) % L;
  });
  for (let i = 1; i < cars.length; i++) expect(moved[i]).toBeGreaterThan(150);
});
