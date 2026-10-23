// Pit stop service timing.

export class PitStop {
  /**
   * Stationary time in ms once the car has stopped in its box.
   * Tyres: 2000-2800 ms, with a 5% chance of a slow stop (+1.5-4 s). Fuel: 100 ms/kg (refuelling in parallel is not modelled).
   */
  static serviceTimeMs(changeTyres: boolean, fuelKg: number, rng: () => number): number {
    let ms = 0;
    if (changeTyres) {
      ms += 2000 + rng() * 800;
      if (rng() < 0.05) ms += 1500 + rng() * 2500;
    }
    if (fuelKg > 0) ms += fuelKg * 100;
    // A stop with neither tyres nor fuel still takes a token moment.
    return Math.max(ms, 300);
  }
}
