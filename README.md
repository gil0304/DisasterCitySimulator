# Disaster City Simulator

A 3D simulation model of a fictional Japanese city — **AOBA CITY** — with
earthquake, flood, tsunami, urban fire and typhoon scenarios. Choose a disaster
and watch progressive building damage, collapse, inundation, fire spread,
road closures, pedestrian evacuation and traffic on the shared street network.
Partially damaged buildings retain broken facades, exposed floors and columns.

> **SIMULATION MODEL — NOT A REAL-WORLD PREDICTION.**
> The point is to make it visible that *urban structure, building performance,
> population distribution, evacuation routes and shelter placement* change the
> outcome of a disaster. It is not an engineering tool.

## Run it

```bash
npm install
npm run dev
```

```bash
npm run build
npm run lint
npm run sim:test -- --quiet
npm run hazard:test
```

## City data

The city is data, not code. Nothing about the buildings is hard-coded.

- `src/data/aoba-city.json` — the authored fictional city, generated externally. **Drop it in
  and it is picked up automatically** (the store discovers it with
  `import.meta.glob`, so its absence is not a build error).
- `src/data/sample-city.json` — the fallback fixture used when
  `aoba-city.json` is missing or fails validation. Regenerate with
  `node scripts/generate-city.mjs`.

`docs/city-schema.md` is the contract for that JSON: every field, every accepted
alias, and every default the loader derives. The loader is deliberately tolerant
on input and strict on output.

## Layout

```
src/
├─ components/     rendering only — no simulation logic lives here
├─ simulation/     pure logic — no React, no Three.js
├─ store/          the thin Zustand bridge between the two
├─ types/          city.ts (static data) and simulation.ts (runtime state)
└─ data/
docs/
├─ city-schema.md      shape of the city JSON
└─ module-contracts.md the API each module implements
```

The separation matters: `DamageCalculator` decides damage, `BuildingRuntime`
holds it, `Building.tsx` only draws it. Simulation state is never React state —
the engine owns dense arrays that the renderer reads through refs, and only a
small snapshot is pushed into React, a few times per second.

## How the simulation works

| Step | Where |
| --- | --- |
| Fixed timestep (0.25 s), speed ×1/×4/×16, pause, reset | `SimulationEngine` |
| Shaking envelope, damage rolls, collapse schedule, fire | `EarthquakeSimulator` |
| Inundation, wind, spreading fire, unsafe roads and refuges | `EnvironmentalDisaster` |
| Left-hand traffic, vehicle spacing, intersection waits, blocked-edge avoidance | `TrafficSimulator` |
| Per-building damage score and state | `DamageCalculator` |
| Rubble blocking road edges | `EarthquakeSimulator` + `DamageCalculator.blockageProbability` |
| Agent generation from `occupancy` / `populationProfile` | `PopulationGenerator` |
| Departure, shelter choice, walking, congestion, rerouting, admission | `EvacuationSimulator` |
| A\* over the road graph | `PathFinder` / `RoadGraph` |
| Live counters and economic loss | `StatisticsCalculator` |

Everything stochastic draws from a seeded stream (`simulation/rng.ts`), so the
same `simulationSeed` always produces the same disaster — including after
`RESET`.

## Controls

- Drag — rotate. Wheel — zoom. Right-drag / Shift+drag — pan.
- Click a building or a shelter for a small card; click again or click empty
  space to close it.
- `D` — debug overlay (road graph, blocked edges, agent paths). Not part of the
  normal UI.
- `Space` — pause/resume. `R` — reset.

See [the extension notes](docs/disaster-expansion.md) for scenario behavior,
visual changes, reproducibility and the model's limits.
