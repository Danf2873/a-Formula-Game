import { describe, it, expect } from 'vitest';
import { TEAMS, DRIVERS, teamById, driverById } from '../src/data/grid';
import { CarVisual, countTriangles } from '../src/render/carMesh';
import { Vector3, Quaternion } from 'three';

const HEX = /^#[0-9a-fA-F]{6}$/;

describe('grid data', () => {
  it('has 11 teams and 22 drivers', () => {
    expect(TEAMS.length).toBe(11);
    expect(DRIVERS.length).toBe(22);
  });
  it('every team has exactly 2 drivers', () => {
    for (const t of TEAMS) expect(DRIVERS.filter((d) => d.teamId === t.id).length).toBe(2);
  });
  it('ids, numbers and codes are unique', () => {
    expect(new Set(TEAMS.map((t) => t.id)).size).toBe(TEAMS.length);
    expect(new Set(DRIVERS.map((d) => d.id)).size).toBe(DRIVERS.length);
    expect(new Set(DRIVERS.map((d) => d.number)).size).toBe(DRIVERS.length);
    expect(new Set(DRIVERS.map((d) => d.code)).size).toBe(DRIVERS.length);
  });
  it('colours are valid hex and ranges sane', () => {
    for (const t of TEAMS) {
      for (const c of Object.values(t.colors)) expect(c).toMatch(HEX);
      expect(t.performance.power).toBeGreaterThanOrEqual(0.97);
      expect(t.performance.power).toBeLessThanOrEqual(1.02);
    }
    for (const d of DRIVERS) {
      expect(d.skill).toBeGreaterThanOrEqual(0.86);
      expect(d.skill).toBeLessThanOrEqual(1);
      expect(d.code).toMatch(/^[A-Z]{3}$/);
      expect(d.nationality).toMatch(/^[A-Z]{3}$/);
    }
  });
  it('lookups work and throw on unknown', () => {
    expect(teamById('ferrari').name).toBe('Ferrari');
    expect(driverById('norris').number).toBe(1);
    expect(() => teamById('nope')).toThrow();
    expect(() => driverById('nope')).toThrow();
  });
});

describe('CarVisual (node smoke)', () => {
  it('builds under the triangle budget and updates/disposes', () => {
    const car = new CarVisual(teamById('mclaren'), 1, 'NOR');
    const tris = countTriangles(car.object);
    console.log('car triangles', tris);
    expect(tris).toBeGreaterThan(500);
    expect(tris).toBeLessThan(6000);
    car.update({
      position: new Vector3(1, 2, 3), quaternion: new Quaternion(), velocity: new Vector3(),
      steerAngle: 0.2, wheelSpin: [1, 2, 3, 4], wheelCompression: [0, 0.01, 0, 0.02],
    }, { brake: 1, compound: 'hard', rainLight: true });
    expect(car.object.position.y).toBe(2);
    car.dispose();
  });
});
