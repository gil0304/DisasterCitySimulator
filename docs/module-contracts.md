# Module contracts

Every module below is implemented independently. **These signatures are
binding** — do not rename, do not change parameter order, do not add required
parameters. Add extra *optional* parameters or extra exports freely.

Shared rules:

- TypeScript is `strict`, with `noUnusedLocals`, `noUnusedParameters`,
  `verbatimModuleSyntax` and `erasableSyntaxOnly`.
  - Type-only imports **must** use `import type { X } from '...'`.
  - `erasableSyntaxOnly` forbids `enum`, namespaces, and **constructor
    parameter properties** (`constructor(private x: number)`). Declare fields
    explicitly and assign in the body.
- Import paths are relative and include no extension (`'../types/city'`).
- No `any` unless unavoidable; no `console.log` in committed code
  (`console.warn` for genuine load warnings is fine).
- Nothing in `src/simulation/**` may import React, Three.js or the store.
  `src/simulation/**` is pure logic. (Vectors are plain `{x, z}` objects.)
- All randomness goes through `Rng` from `src/simulation/rng.ts`. Never call
  `Math.random()`.
- Guard every division; never emit `NaN` or `undefined` into runtime state.

---

## `src/simulation/CityLoader.ts`

Implements `docs/city-schema.md`.

```ts
export function loadCity(raw: unknown): CityLoadResult
export function normalizePosition(value: unknown): Vec2 | null
export function pointInPolygon(p: Vec2, polygon: Vec2[]): boolean
export function groundMultiplierAt(city: CityModel, p: Vec2): number
export function primaryEarthquake(city: CityModel): DisasterScenario
```

`loadCity` throws `CityLoadError` (also exported, extends `Error`, carries
`issues: CityValidationIssue[]`) on a fatal problem; otherwise it returns a
fully-normalised `CityModel` plus any warnings.

---

## `src/simulation/RoadGraph.ts`

```ts
export interface GraphEdgeRef {
  edgeIndex: number   // index into RoadGraph.edges AND into RoadRuntime[]
  edgeId: string
  to: string          // neighbour node id
  length: number      // metres
}

export class RoadGraph {
  readonly nodes: RoadNode[]
  readonly edges: RoadEdge[]
  constructor(city: CityModel)
  nodeIndexOf(nodeId: string): number          // -1 if unknown
  edgeIndexOf(edgeId: string): number          // -1 if unknown
  position(nodeId: string): Vec2               // {x:0,z:0} if unknown
  adjacency(nodeId: string): GraphEdgeRef[]    // [] if unknown; never null
  adjacencyByIndex(nodeIndex: number): GraphEdgeRef[]
  edgeBetween(a: string, b: string): RoadEdge | null
  nearestNode(p: Vec2): string                 // uses an internal uniform grid
  nearestNodeIndex(p: Vec2): number
  edgesNear(p: Vec2, radius: number): number[] // edge indices whose segment is within radius
  /** Straight-line distance between two nodes, metres. */
  distance(a: string, b: string): number
}
```

`edgesNear` must be backed by a uniform spatial grid — it is called once per
building at start-up and must not be O(buildings × edges) in the naive sense
(a grid bucketed by edge bounding boxes is fine).

---

## `src/simulation/PathFinder.ts`

A\* over the road graph (§35).

```ts
export interface PathCostContext {
  /** Indexed identically to RoadGraph.edges. */
  roads: RoadRuntime[]
}

export interface PathResult {
  path: string[]        // node ids, [start, ..., goal]; length >= 1
  goalNodeId: string
  cost: number
}

/** Single-target A*. Returns null when the goal is unreachable. */
export function findPath(
  graph: RoadGraph,
  startNodeId: string,
  goalNodeId: string,
  ctx: PathCostContext,
): PathResult | null

/**
 * Multi-target A*: searches for the cheapest of several goals in one pass.
 * `bias` multiplies the accumulated cost when comparing candidates (a nearly
 * full shelter gets a bias > 1). Returns null when none are reachable.
 */
export function findPathToAny(
  graph: RoadGraph,
  startNodeId: string,
  goals: { nodeId: string; bias: number }[],
  ctx: PathCostContext,
): PathResult | null

/** Traversal cost of one edge, metres-equivalent. Infinity when impassable. */
export function edgeCost(edge: RoadEdge, road: RoadRuntime): number
```

Cost model (§36), all constants from `constants.ts`:

- base = `edge.length`
- blocked → `Infinity`
- narrow roads: multiply by `1 + NARROW_ROAD_PENALTY * clamp01(1 - width / NARROW_ROAD_REFERENCE_WIDTH)`
- congestion: `× (1 + CONGESTION_COST_WEIGHT * road.congestion)`
- debris (partially blocked / hazardous): `× (1 + DEBRIS_COST_WEIGHT * road.debrisLevel)`

The heuristic must be admissible for the *base* metric (straight-line distance),
so multipliers ≥ 1 keep A\* correct.

Performance: this runs for ~3000 agents and again on every reroute. Use a
binary-heap priority queue and reusable scratch arrays keyed by node index
(`Float64Array` for g-scores plus an integer "visit stamp" array so you never
reallocate). Guard against pathological cases with a node-expansion cap
(e.g. `graph.nodes.length * 4`) and return `null` when it is exceeded.

---

## `src/simulation/PopulationGenerator.ts`

```ts
export function createBuildingRuntimes(city: CityModel): BuildingRuntime[]
export function createRoadRuntimes(city: CityModel): RoadRuntime[]
export function createShelterRuntimes(city: CityModel): ShelterRuntime[]

/**
 * §17, §18, §21, §22, §23. Populates `buildings[i].agentIds` and
 * `buildings[i].occupantsInside`.
 */
export function generatePopulation(
  city: CityModel,
  graph: RoadGraph,
  buildings: BuildingRuntime[],
  seed: number,
): Agent[]
```

Every agent starts `state: 'inside'`, at a random point inside its building's
footprint, with `currentRoadNodeId` set to the building's
`nearestRoadNodeId` (fall back to `graph.nearestNode`).

Speeds: `BASE_SPEED[profile]` × `Rng.clampedNormal(1, 0.12, 0.7, 1.3)`.
Hospital occupants get an extra 0.75× factor and a skewed profile mix.
Delays: `Rng.range(EVAC_DELAY_MIN, EVAC_DELAY_MAX)` ×
`EVAC_DELAY_BY_USE[use]` + `EVAC_DELAY_PER_FLOOR × (floors - 1) × floorFactor`,
where school occupants are tightly clustered around the building's own group
delay (§23) rather than independently random.

---

## `src/simulation/DamageCalculator.ts`

```ts
/** §25. Peak shaking at a point, ~0..1.4. */
export function hazardIntensityAt(
  scenario: DisasterScenario,
  p: Vec2,
  groundMultiplier: number,
): number

/** §26. Deterministic given `rng`. Returns 0..1. */
export function computeDamageScore(
  building: Building,
  hazardIntensity: number,
  groundMultiplier: number,
  rng: Rng,
): number

/** §28. */
export function damageStateFor(damageScore: number, collapseThreshold: number): DamageState

/** §42, §43. */
export function economicLossFor(building: Building, state: DamageState): number

/** §31. Probability that a collapsing building blocks a nearby road edge. */
export function blockageProbability(
  building: Building,
  edge: RoadEdge,
  distanceToEdge: number,
  collapseDirection: number,
  edgeBearing: number,
): number
```

`seismicResistance` derived from `yearBuilt` is already baked into the data;
here just use `building.seismicResistance`, `building.constructionType`
(`CONSTRUCTION_VULNERABILITY`), and an age factor from `yearBuilt`.

---

## `src/simulation/EarthquakeSimulator.ts`

```ts
export interface EarthquakeOptions {
  city: CityModel
  scenario: DisasterScenario
  graph: RoadGraph
  buildings: BuildingRuntime[]
  roads: RoadRuntime[]
  seed: number
  /** Called exactly once per building, the moment it starts collapsing. */
  onCollapse: (building: BuildingRuntime, now: number) => void
}

export class EarthquakeSimulator implements DisasterSimulator {
  readonly type: string           // 'earthquake'
  constructor(options: EarthquakeOptions)
  start(): void
  update(dt: number, now: number): void
  isFinished(): boolean
  /** 0..1 global shaking envelope, for the renderer. */
  shakeEnvelope(now: number): number
}
```

Responsibilities:

1. `start()` — pre-compute each building's `hazardIntensity`,
   `groundMultiplier`, `damageScore`, final `state`, `economicLoss`,
   `collapseDirection`, and, for buildings that will collapse, a collapse time
   drawn in `[COLLAPSE_WINDOW_START, COLLAPSE_WINDOW_END]` biased earlier for
   higher damage. Also pre-compute, per building, the nearby road edge indices
   via `graph.edgesNear(pos, building.height * 0.55 + 12)`.
   Damage is *decided* at `start()` (so it is deterministic) but *revealed*
   progressively (see 2).
2. `update()` — drive `shakeIntensity` per building over the first
   `durationSeconds` (plus aftershocks), reveal each building's `state`
   gradually between 0 s and 40 s (§47) by moving `damageScore` from 0 toward
   its final value, run collapses at their scheduled times, and roll road
   blockage for each nearby edge on collapse using `blockageProbability`
   (set `blocked`, `blockedAt`, `debrisLevel`).
3. Fire ignition (§66): after the shock, roll `fireIgnitionProbability` scaled
   by damage; spread to buildings within `FIRE_SPREAD_RADIUS` every
   `FIRE_SPREAD_CHECK_INTERVAL` logic ticks, weighted toward wooden ones.
4. `isFinished()` — true once shaking, all scheduled collapses and aftershocks
   are done.

Never mutate agents here; casualties are the engine's job via `onCollapse`.

---

## `src/simulation/EvacuationSimulator.ts`

```ts
export interface EvacuationOptions {
  city: CityModel
  graph: RoadGraph
  buildings: BuildingRuntime[]
  roads: RoadRuntime[]
  shelters: ShelterRuntime[]
  agents: Agent[]
  seed: number
}

export class EvacuationSimulator {
  constructor(options: EvacuationOptions)
  /** `logicTick` is true once per simulation second. */
  update(dt: number, now: number, logicTick: boolean): void
  /** §40, §41 — casualties among occupants still inside a collapsing building. */
  onBuildingCollapse(building: BuildingRuntime, now: number): void
  /** True when no agent can make further progress (§50). */
  isSettled(): boolean
}
```

Behaviour:

- **Departure** — an agent leaves when `now >= evacuationStartDelay`. It picks a
  shelter with `findPathToAny` over up to ~6 candidate shelters ranked by
  straight-line distance, each with `bias = 1 + 2 * (occupancy / capacity)`, and
  full shelters excluded. On success: `state = 'evacuating'`, position snapped
  to the origin node, `hasLeftBuilding = true`, `occupantsInside--`.
  If no shelter is reachable, retry every ~15 s (a road may clear); after
  `MAX_REROUTES` failed attempts the agent stays `'inside'` but is not counted
  as stuck-forever — `isSettled()` must still be able to become true.
- **Movement** — walk toward `path[pathIndex]` along the edge centreline, offset
  laterally by `laneOffset` (perpendicular to the segment). Effective speed =
  `movementSpeed × congestionFactor(edge) × terrainFactor(debris)`. On reaching
  a node, advance `pathIndex`, update `currentRoadNodeId`, move the agent's
  contribution from the old edge's `agentCount` to the new edge's.
  **`agentCount` bookkeeping must be exact** — always decrement the previous
  edge before incrementing the next, and decrement on shelter arrival, death and
  reroute.
- **Rerouting (§37)** — every `REROUTE_CHECK_INTERVAL` logic ticks (staggered by
  agent id so the work is spread across ticks), if the current or next edge is
  `blocked`, stop for `REPATH_PAUSE`, then recompute. Also reroute when the
  target shelter became full.
- **Arrival (§38)** — within `SHELTER_ARRIVAL_RADIUS` of the shelter position:
  if `occupancy < capacity`, admit (`occupancy++`, `state = 'sheltered'`,
  clear edge count); else mark the shelter `full` and reroute to another one.
  **Never exceed `capacity`.**
- **Congestion (§39)** — recompute `road.congestion` once per logic tick from
  `agentCount` and `ROAD_COMFORT_DENSITY × length × lanes`; speed factor is
  `clamp(1 / (1 + k·congestion), MIN_CONGESTION_SPEED_FACTOR, 1)`.
- **Casualties (§40, §41)** — in `onBuildingCollapse`, for each agent still
  `'inside'`, roll against a probability built from the building's
  `damageScore`, `constructionType`, `floors` and the agent's `profile`.
  Outcomes: `trapped` (most), `injured`, `dead`. A trapped agent stays trapped;
  it never moves again. Agents on a road adjacent to a collapsing building take
  a much smaller injury roll.

---

## `src/simulation/StatisticsCalculator.ts`

```ts
/** Fills and returns `out` (allocate one Statistics object and reuse it). */
export function computeStatistics(
  buildings: BuildingRuntime[],
  roads: RoadRuntime[],
  shelters: ShelterRuntime[],
  agents: Agent[],
  out: Statistics,
): Statistics
```

`evacuated` counts agents that left their building (`hasLeftBuilding`), which
includes `sheltered`. `damagedBuildings` counts state !== 'intact'.

---

## `src/simulation/SimulationEngine.ts`

```ts
export class SimulationEngine {
  readonly city: CityModel
  readonly graph: RoadGraph
  readonly scenario: DisasterScenario
  readonly seed: number
  readonly buildings: BuildingRuntime[]
  readonly roads: RoadRuntime[]
  readonly shelters: ShelterRuntime[]
  readonly agents: Agent[]

  phase: SimulationPhase
  /** Simulation seconds since the shock; 0 while idle. */
  time: number
  speed: number
  paused: boolean
  /** 0..1 interpolation factor inside the current fixed step, for rendering. */
  alpha: number

  constructor(city: CityModel, seed: number)
  triggerEarthquake(): void
  togglePause(): void
  setSpeed(speed: number): void
  /** Rebuilds every runtime array from scratch using the same seed (§52). */
  reset(): void
  /** `realDelta` in real seconds; internally clamped to 0.25 s. */
  advance(realDelta: number): void
  getStatistics(): Statistics
  snapshot(): SimulationSnapshot
  shakeEnvelope(): number
  /** For the collapse/​shake renderers: current sim time including alpha. */
  renderTime(): number
}
```

`advance` accumulates `realDelta × speed` simulation seconds and runs whole
`SIM_TIMESTEP` steps (at most `MAX_STEPS_PER_FRAME`), leaving the remainder in
`alpha`. Every `LOGIC_EVERY`-th step is a logic tick. It ends the run
(`phase = 'finished'`) at `SIM_END_TIME` or when the earthquake has finished and
`evacuation.isSettled()`.

`reset()` must reproduce the *identical* run for the same seed.

---

## `src/store/simulationStore.ts`

Zustand. The engine reference itself is stored but never treated as reactive
data (it is mutated in place).

```ts
export interface SimulationStore {
  engine: SimulationEngine | null
  status: 'loading' | 'ready' | 'error'
  errorMessage: string | null
  loadIssues: CityValidationIssue[]
  snapshot: SimulationSnapshot
  selection: Selection
  debug: boolean

  initialise(): Promise<void>      // loads the JSON, builds the engine
  pushSnapshot(s: SimulationSnapshot): void
  setSelection(s: Selection): void
  toggleDebug(): void
  triggerEarthquake(): void
  togglePause(): void
  cycleSpeed(): void
  reset(): void
}

export const useSimulationStore: UseBoundStore<StoreApi<SimulationStore>>
```

`initialise()` dynamically imports `../data/aoba-city.json`, and falls back to
`../data/sample-city.json` when that import fails **or** when `loadCity` throws.
The fallback must be logged with `console.warn` and surfaced in `loadIssues`.

`pushSnapshot` must not trigger a re-render when nothing changed: compare the
incoming stats field-by-field and reuse the previous object if identical.

---

## `src/components/palette.ts`

```ts
import { Color } from 'three'

export const USE_COLORS: Record<BuildingUse, string>   // §14, muted, no warning colours
export const ROOF_COLORS: Record<BuildingUse, string>
export const GROUND_COLOR: string
export const ROAD_COLOR: string
export const SHELTER_COLOR: string
export const AGENT_COLORS: Record<AgentProfile | 'sheltered' | 'trapped' | 'injured', string>

/** §14 — darkening applied to a building's base colour by damage state. */
export function damageTint(base: Color, state: DamageState, burn: number, out: Color): Color
```

Palette rules: desaturated, daylight, no red/yellow alert colours. Damage is
communicated purely by value (darkness) and by geometry.

---

## `src/components/buildingGeometry.ts`

```ts
export interface BuildingGeometryResult {
  geometry: BufferGeometry      // origin at footprint centre, base at y = 0
  /** Untinted vertex colours, so damage tinting can be re-derived. */
  baseColors: Float32Array
  /** Rough bounding height, for the collapse animation. */
  height: number
}

/** Deterministic for a given building id + seed. */
export function createBuildingGeometry(building: Building, seed: number): BuildingGeometryResult

/** Rewrites the geometry's colour attribute in place. Cheap; call on change only. */
export function applyDamageTint(
  result: BuildingGeometryResult,
  building: Building,
  state: DamageState,
  burn: number,
): void

/** A low, irregular rubble pile used when a building has fully collapsed. */
export function createRubbleGeometry(building: Building, seed: number): BufferGeometry
```

The geometry must make the six use classes visually distinguishable (§13):
wooden houses (gable/hip roofs, small footprints, visible eaves), RC mid-rises
(flat roofs, regular window bands, parapets), towers (setbacks, a crown,
vertical mullions), schools (long low slabs, repeated classroom windows, a
gym wing), hospitals (white, a podium plus a tower, a roof helipad ring),
factories (sawtooth roofs, big blank walls, a chimney or vent stacks),
commercial (glazed ground floor, signage band).

Windows are baked in as slightly inset, darker vertex-coloured quads — do **not**
create separate meshes per window. Keep each building under ~1500 triangles.
Merge everything into one `BufferGeometry` with `position`, `normal` and
`color` attributes only.

---

## Rendering components

All read `engine` from the store once (stable reference) and then mutate
Three.js objects inside `useFrame`. **No `setState` in `useFrame`.**

```tsx
// src/components/CityScene.tsx
export function CityScene(): JSX.Element        // <Canvas> lives in App.tsx
// Drives engine.advance(delta) and throttled store.pushSnapshot (5 Hz).

// src/components/Buildings.tsx
export function Buildings(): JSX.Element | null

// src/components/Roads.tsx
export function Roads(): JSX.Element | null

// src/components/Agents.tsx
export function Agents(): JSX.Element | null

// src/components/Shelters.tsx
export function Shelters(): JSX.Element | null

// src/components/Ground.tsx
export function Ground(): JSX.Element | null

// src/components/SimulationHUD.tsx
export function SimulationHUD(): JSX.Element    // DOM overlay, not inside <Canvas>

// src/components/ResultDisplay.tsx
export function ResultDisplay(): JSX.Element | null
```

React 19 + @react-three/fiber v9: JSX intrinsic elements such as `<mesh>` and
`<instancedMesh>` are provided by R3F; no `extend` call is needed for core
Three.js classes.
