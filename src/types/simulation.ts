/**
 * Runtime simulation state.
 *
 * IMPORTANT: every object in here is *mutated in place* by the simulation
 * modules and read by the renderer through refs. None of it lives in React
 * state. Only the small aggregates in `SimulationSnapshot` are pushed into the
 * Zustand store, and only a few times per second.
 */

import type { AgentProfile, Building, RoadEdge, Shelter, DisasterScenario } from './city'

export type DamageState = 'intact' | 'minor' | 'major' | 'severe' | 'collapsed'

export const DAMAGE_STATES: DamageState[] = ['intact', 'minor', 'major', 'severe', 'collapsed']

/** §43 — loss fraction of `replacementValue` per damage state. */
export const DAMAGE_RATIO: Record<DamageState, number> = {
  intact: 0,
  minor: 0.05,
  major: 0.25,
  severe: 0.55,
  collapsed: 0.9,
}

export interface BuildingRuntime {
  /** Index into `SimulationEngine.buildings` — also the InstancedMesh index. */
  index: number
  id: string
  /** Immutable source record. */
  source: Building
  /** 0..1, decided once the shock passes over the building. */
  damageScore: number
  state: DamageState
  /** Sim-time at which the collapse animation started, or null. */
  collapseStartTime: number | null
  /** 0..1 collapse animation progress. */
  collapseProgress: number
  /** Direction the building topples, radians. */
  collapseDirection: number
  /** 0..1, current shaking amplitude used by the renderer. */
  shakeIntensity: number
  /** Per-building shake phase offset so the city doesn't move as one block. */
  shakePhase: number
  /** Peak shaking this building experienced. */
  hazardIntensity: number
  /** Ground amplification sampled at this building. */
  groundMultiplier: number
  onFire: boolean
  fireStartTime: number | null
  /** 0..1 */
  burnProgress: number
  waterDepth: number
  economicLoss: number
  /** Agents still inside (not yet evacuating / trapped / dead). */
  occupantsInside: number
  agentIds: number[]
}

export type AgentState =
  | 'inside'
  | 'evacuating'
  | 'sheltered'
  | 'trapped'
  | 'injured'
  | 'dead'

/**
 * Agent record. Stored in a dense array; `id` is the array index.
 * Positions are metres in world space (y is derived at render time).
 */
export interface Agent {
  id: number
  profile: AgentProfile
  x: number
  z: number
  /** Previous step position, for render interpolation. */
  px: number
  pz: number
  originBuildingIndex: number
  /** Node the agent most recently stood on / departed from. */
  currentRoadNodeId: string | null
  targetShelterIndex: number
  state: AgentState
  /** Sim seconds after the shock before this agent leaves the building. */
  evacuationStartDelay: number
  /** Base walking speed, m/s. */
  movementSpeed: number
  /** Lateral offset from the road centreline, metres (§56). */
  laneOffset: number
  /** Node ids, from the agent's current position to the shelter. */
  path: string[]
  /** Index of the node in `path` the agent is currently walking toward. */
  pathIndex: number
  /** Edge currently occupied, for congestion accounting. */
  currentEdgeId: string | null
  /** Sim time when the agent stopped to recompute a route. */
  repathUntil: number
  /** Number of reroutes performed; used to give up gracefully. */
  rerouteCount: number
  /** Cumulative metres walked, for statistics. */
  distanceWalked: number
  /** True once counted in the "evacuated" statistic. */
  hasLeftBuilding: boolean
  injurySeverity: number
}

export interface RoadRuntime {
  index: number
  id: string
  source: RoadEdge
  blocked: boolean
  /** 0..1 how much rubble is piled on the road (visual + cost). */
  debrisLevel: number
  waterDepth: number
  hazardLevel: number
  hazardBlocked: boolean
  /** Agents currently traversing this edge. */
  agentCount: number
  /** 0..1 congestion factor derived from agentCount vs. capacity. */
  congestion: number
  /** Sim time the edge became blocked, for the rubble drop animation. */
  blockedAt: number | null
}

export interface ShelterRuntime {
  index: number
  id: string
  source: Shelter
  occupancy: number
  capacity: number
  full: boolean
  unsafe: boolean
}

export type SimulationPhase = 'idle' | 'shaking' | 'evacuating' | 'finished'

export interface Statistics {
  /** Agents that left their building (includes those now sheltered). */
  evacuated: number
  sheltered: number
  stillInside: number
  moving: number
  trapped: number
  injured: number
  fatalities: number
  collapsedBuildings: number
  damagedBuildings: number
  minorBuildings: number
  majorBuildings: number
  severeBuildings: number
  floodedBuildings: number
  totalBuildings: number
  blockedRoads: number
  totalRoads: number
  /** 0..1 */
  roadBlockageRatio: number
  /** JPY */
  economicLoss: number
  buildingsOnFire: number
}

export const EMPTY_STATISTICS: Statistics = {
  evacuated: 0,
  sheltered: 0,
  stillInside: 0,
  moving: 0,
  trapped: 0,
  injured: 0,
  fatalities: 0,
  collapsedBuildings: 0,
  damagedBuildings: 0,
  minorBuildings: 0,
  majorBuildings: 0,
  severeBuildings: 0,
  floodedBuildings: 0,
  totalBuildings: 0,
  blockedRoads: 0,
  totalRoads: 0,
  roadBlockageRatio: 0,
  economicLoss: 0,
  buildingsOnFire: 0,
}

/** The small, serialisable slice pushed into React a few times per second. */
export interface SimulationSnapshot {
  disasterType: DisasterScenario['type']
  phase: SimulationPhase
  /** Simulation seconds since the shock. */
  time: number
  speed: number
  paused: boolean
  stats: Statistics
}

/** §65 — every disaster implements this so Flood / Fire / Tsunami can be added. */
export interface DisasterSimulator {
  readonly type: string
  /** Called once when the disaster is triggered. */
  start(): void
  /** Fixed-timestep update. `dt` is in simulation seconds. */
  update(dt: number, now: number): void
  /** True once the disaster itself (not the evacuation) has run its course. */
  isFinished(): boolean
}

export interface SelectedBuildingInfo {
  kind: 'building'
  id: string
  name: string
  use: string
  yearBuilt: number
  occupancy: number
  seismicResistance: number
  damageState: DamageState
  damageScore: number
  screenX: number
  screenY: number
}

export interface SelectedShelterInfo {
  kind: 'shelter'
  id: string
  name: string
  occupancy: number
  capacity: number
  screenX: number
  screenY: number
}

export type Selection = SelectedBuildingInfo | SelectedShelterInfo | null
