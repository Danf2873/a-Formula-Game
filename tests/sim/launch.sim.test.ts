import { it, expect } from 'vitest';
// @ts-ignore node types not installed
import { readFileSync } from 'node:fs';
import { Track } from '../../src/track/track';
import { Car, defaultSetup } from '../../src/physics/car';
import { applyAssists } from '../../src/input/assists';
import { TEAMS } from '../../src/data/grid';

// Full-throttle launch with the default assists (TC 100%) must not spin the car.
it('player launch at monza', () => {
  const track = new Track(JSON.parse(readFileSync('public/circuits/monza.json', 'utf8')));
  const car = new Car({ setup: defaultSetup(), performance: TEAMS[0].performance });
  const g = track.gridSlot(11);
  car.reset(g.position.x, g.position.z, g.heading, track);
  const env = { wetness: 0, rubber: 0.5, airTempC: 28, trackTempC: 40 };
  const settings: any = { autoGearbox: true, tractionControl: 1, absAssist: true, steeringAssist: 0.3 };
  for (let i = 0; i < 240 * 12; i++) {
    const c = applyAssists({ steer: 0, throttle: 1, brake: 0, shiftUp: false, shiftDown: false, boost: false, pitLimiter: false }, car.telemetry, settings);
    car.step(1 / 240, c, track, env, false);
  }
  expect(car.telemetry.speedKmh).toBeGreaterThan(200);
});
