/** Tunables shared across the simulation and the renderer. */

import type { AgentProfile, BuildingUse, ConstructionType, GroundType } from '../types/city'

/** Fixed timestep, simulation seconds (§45). Logic runs every LOGIC_EVERY steps. */
export const SIM_TIMESTEP = 0.25
export const LOGIC_EVERY = 4 // → one "logic tick" per simulation second
export const MAX_STEPS_PER_FRAME = 40

export const SPEED_STEPS = [1, 4, 16] as const

/** §50 — the run ends after 30 simulation minutes at the latest. */
export const SIM_END_TIME = 30 * 60

/** §21 — base walking speeds, m/s. */
export const BASE_SPEED: Record<AgentProfile, number> = {
  adult: 1.4,
  child: 1.2,
  elderly: 0.9,
  mobilityImpaired: 0.6,
}

/** §22 — evacuation start delay window, simulation seconds. */
export const EVAC_DELAY_MIN = 5
export const EVAC_DELAY_MAX = 60

/** §23 — per-use multiplier on the evacuation start delay. */
export const EVAC_DELAY_BY_USE: Record<BuildingUse, number> = {
  residential: 0.75,
  apartment: 1.0,
  office: 1.35,
  commercial: 1.15,
  retail: 1.0,
  school: 0.9,
  hospital: 1.8,
  factory: 1.2,
  civic: 1.05,
  station: 0.7,
  temple: 0.9,
  parking: 0.6,
}

/** Extra delay per floor above ground, seconds — tall buildings empty slowly. */
export const EVAC_DELAY_PER_FLOOR = 2.6

/** §25 — shaking amplification by ground type. */
export const GROUND_AMPLIFICATION: Record<GroundType, number> = {
  rock: 0.75,
  hard: 0.9,
  medium: 1.0,
  soft: 1.35,
  reclaimed: 1.7,
}

/** Relative vulnerability of each construction type (higher = weaker). */
export const CONSTRUCTION_VULNERABILITY: Record<ConstructionType, number> = {
  wood: 1.35,
  lightSteel: 1.05,
  masonry: 1.5,
  prefab: 1.1,
  rc: 0.8,
  steel: 0.7,
}

/** Fraction of `replacementValue` lost, per damage state (§43). */
export const COLLAPSE_ANIM_MIN = 1.0
export const COLLAPSE_ANIM_MAX = 3.0

/** §47 — collapse window after the shock, simulation seconds. */
export const COLLAPSE_WINDOW_START = 10
export const COLLAPSE_WINDOW_END = 60

/** §39 — congestion. Agents per metre of road before speed starts dropping. */
export const ROAD_COMFORT_DENSITY = 0.35
export const MIN_CONGESTION_SPEED_FACTOR = 0.28

/** §36 — path cost multipliers. */
export const NARROW_ROAD_PENALTY = 1.9 // applied as width falls below this
export const NARROW_ROAD_REFERENCE_WIDTH = 8
export const CONGESTION_COST_WEIGHT = 1.6
export const HAZARD_COST_WEIGHT = 0.5
export const DEBRIS_COST_WEIGHT = 1.2

/** How often (logic ticks) an evacuating agent re-evaluates its route. */
export const REROUTE_CHECK_INTERVAL = 4
export const MAX_REROUTES = 12
/** Sim seconds an agent pauses while recomputing a route (§37). */
export const REPATH_PAUSE = 1.5

/** Radius within which an agent is considered to have reached a shelter. */
export const SHELTER_ARRIVAL_RADIUS = 12

/** §66 — fire. */
export const FIRE_SPREAD_RADIUS = 26
export const FIRE_SPREAD_CHECK_INTERVAL = 20 // logic ticks
export const FIRE_BURN_DURATION = 420

/** Agent render tuning. */
export const AGENT_RADIUS = 0.7
export const MAX_RENDERED_AGENTS = 6000

/** Camera. */
export const CAMERA_MIN_DISTANCE = 60
export const CAMERA_MAX_DISTANCE = 1400
export const CAMERA_INITIAL = { distance: 620, polar: 0.92, azimuth: 0.7 }
