# A Formula Game

A low-poly Formula 1 racing sim that runs in the browser. It covers all 24 circuits and all 11 teams of the 2026 season, and is built with Three.js.

## Features

- **Physics:** a raycast vehicle with a Pacejka tyre model, suspension and anti-roll bars, aero, 2026 active aero (straight mode) and an ICE + ERS power unit.
- **Input:** keyboard, gamepad or steering wheel through the Gamepad API, with rebinding, calibration and optional assists (auto gearbox, TC, ABS).
- **Sessions:** practice, qualifying (Q1/Q2/Q3), race, time trial with a saved ghost, and a full Grand Prix weekend.
- **AI:** AI drivers that follow a racing line, overtake and defend, and make pit stops.
- **Strategy:** tyre compounds with wear and temperature, fuel, pit stops, and the two-compound rule.
- **Weather and time of day:** rain, a track that gets wetter or dries, and day/night.
- **Car setup and telemetry:** a setup editor with wings, ARB, springs, ride height, alignment, brakes, diff, pressures and fuel, plus live telemetry graphs.
- **Multiplayer:** peer-to-peer with room codes, via WebRTC and PeerJS. No server is needed.

## Controls (keyboard)

| Action | Keys |
|---|---|
| Throttle / brake | W / S or ↑ / ↓ |
| Steer | A / D or ← / → |
| Shift up / down | E / Q |
| Boost (ERS override) | Space |
| Pit limiter | L |
| Next / previous camera | C / V |
| Pick a camera directly | 1–9, 0 |
| Look back | B |
| Telemetry | T |
| Reset car to track | R |
| Pause | Esc |

Gamepads and wheels are detected automatically, and you can configure them under Settings. Browsers don't expose force feedback for wheels, but gamepads get rumble.

## Development

```bash
npm install
npm run dev        # local dev server
npm test           # unit tests (Vitest)
npm run build      # production build into dist/
npm run import-circuits   # regenerate public/circuits/*.json from scripts/f1-circuits.geojson
```

## Deploying to GitHub Pages

1. Push to `main`. The workflow in `.github/workflows/deploy.yml` tests, builds and publishes `dist/`.
2. Under **Settings → Pages**, set **Source** to **GitHub Actions**. This is needed once.

The Vite `base` is relative, so the site works under any repo name.

## Credits

- Circuit centrelines come from [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits) (MIT licence).
- This is an unofficial fan project and is not affiliated with Formula 1, the FIA or any team. Liveries are approximate colours only.
