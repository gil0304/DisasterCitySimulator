/**
 * Runtime-state construction and population generation (§17, §18, §21, §22, §23).
 *
 * Everything here is deterministic for a given seed: each building draws from
 * its own `Rng` stream keyed by the building id, so the population is stable
 * regardless of the order in which buildings are visited.
 */

import type { AgentProfile, Building, CityModel, PopulationProfile } from '../types/city'
import { AGENT_PROFILES } from '../types/city'
import type { Agent, BuildingRuntime, RoadRuntime, ShelterRuntime } from '../types/simulation'
import type { RoadGraph } from './RoadGraph'
import {
  BASE_SPEED,
  EVAC_DELAY_BY_USE,
  EVAC_DELAY_MAX,
  EVAC_DELAY_MIN,
  EVAC_DELAY_PER_FLOOR,
} from './constants'
import { Rng, hashString, mixSeed } from './rng'

const TAU = Math.PI * 2

/** Fallback mix when a building's profile is missing or degenerate. */
const DEFAULT_PROFILE_WEIGHTS = [0.16, 0.6, 0.19, 0.05]

/** §18 — hospitals hold far more elderly and mobility-impaired occupants. */
const HOSPITAL_PROFILE_SKEW: Record<AgentProfile, number> = {
  child: 0.7,
  adult: 0.85,
  elderly: 2.1,
  mobilityImpaired: 2.8,
}

/** Hospital occupants move slowly even when they can walk unaided. */
const HOSPITAL_SPEED_FACTOR = 0.75

/** §23 — schools evacuate as classes, so their delays cluster tightly. */
const GROUP_DELAY_SPREAD = 2.5

/** Lateral spread across the carriageway, metres (§56). */
const LANE_OFFSET_RANGE = 2

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function createBuildingRuntimes(city: CityModel): BuildingRuntime[] {
  const source = city.buildings
  const out: BuildingRuntime[] = new Array<BuildingRuntime>(source.length)
  for (let i = 0; i < source.length; i++) {
    const b = source[i]
    // Stable per-building phases so the city never shakes as one rigid block,
    // even before EarthquakeSimulator overwrites collapseDirection.
    const h = hashString(b.id)
    out[i] = {
      index: i,
      id: b.id,
      source: b,
      damageScore: 0,
      state: 'intact',
      collapseStartTime: null,
      collapseProgress: 0,
      collapseDirection: ((h % 10007) / 10007) * TAU,
      shakeIntensity: 0,
      shakePhase: (((h >>> 11) % 10007) / 10007) * TAU,
      hazardIntensity: 0,
      groundMultiplier: 1,
      onFire: false,
      fireStartTime: null,
      burnProgress: 0,
      waterDepth: 0,
      economicLoss: 0,
      occupantsInside: 0,
      agentIds: [],
    }
  }
  return out
}

export function createRoadRuntimes(city: CityModel): RoadRuntime[] {
  // Index order must match RoadGraph.edges, which is built from the same array.
  const source = city.roadNetwork.edges
  const out: RoadRuntime[] = new Array<RoadRuntime>(source.length)
  for (let i = 0; i < source.length; i++) {
    const e = source[i]
    out[i] = {
      index: i,
      id: e.id,
      source: e,
      blocked: false,
      debrisLevel: 0,
      waterDepth: 0,
      hazardLevel: 0,
      hazardBlocked: false,
      agentCount: 0,
      congestion: 0,
      blockedAt: null,
    }
  }
  return out
}

export function createShelterRuntimes(city: CityModel): ShelterRuntime[] {
  const source = city.shelters
  const out: ShelterRuntime[] = new Array<ShelterRuntime>(source.length)
  for (let i = 0; i < source.length; i++) {
    const s = source[i]
    const capacity = Math.max(0, Math.floor(finiteOr(s.capacity, 0)))
    out[i] = {
      index: i,
      id: s.id,
      source: s,
      occupancy: 0,
      capacity,
      full: capacity <= 0,
      unsafe: false,
    }
  }
  return out
}

/** Writes the building's profile mix into `weights` (AGENT_PROFILES order). */
function fillProfileWeights(profile: PopulationProfile, isHospital: boolean, weights: number[]): void {
  let total = 0
  for (let i = 0; i < AGENT_PROFILES.length; i++) {
    const key = AGENT_PROFILES[i]
    let w = profile[key]
    w = Number.isFinite(w) && w > 0 ? w : 0
    // The source profile already includes patients needing assistance.
    weights[i] = w
    total += w
  }
  if (total > 0) return
  for (let i = 0; i < AGENT_PROFILES.length; i++) {
    const key = AGENT_PROFILES[i]
    const base = DEFAULT_PROFILE_WEIGHTS[i]
    weights[i] = isHospital ? base * HOSPITAL_PROFILE_SKEW[key] : base
  }
}

/**
 * §17, §18, §21, §22, §23. Populates `buildings[i].agentIds` and
 * `buildings[i].occupantsInside`. `Agent.id` is the index into the result.
 */
export function generatePopulation(
  city: CityModel,
  graph: RoadGraph,
  buildings: BuildingRuntime[],
  seed: number,
): Agent[] {
  // Pre-size the dense array from the city's declared occupancy so pushing
  // several thousand agents never re-grows the backing store.
  let expected = 0
  for (let i = 0; i < city.buildings.length; i++) {
    expected += Math.max(0, Math.floor(finiteOr(city.buildings[i].occupancy, 0)))
  }
  const agents: Agent[] = []
  if (expected > 0) {
    agents.length = expected
    agents.length = 0
  }
  const weights: number[] = [0, 0, 0, 0]
  const baseSeed = seed >>> 0

  for (let bi = 0; bi < buildings.length; bi++) {
    const runtime = buildings[bi]
    if (runtime === undefined) continue
    const b: Building = runtime.source
    runtime.agentIds = []
    runtime.occupantsInside = 0

    const count = Math.max(0, Math.floor(finiteOr(b.occupancy, 0)))
    if (count === 0) continue

    const rng = new Rng(mixSeed(baseSeed, hashString('population:' + b.id)))
    const isHospital = b.use === 'hospital'
    const isGrouped = b.use === 'school'
    fillProfileWeights(b.populationProfile, isHospital, weights)

    // Footprint sampling frame (inset slightly so nobody stands in a wall).
    const halfW = positiveOr(b.footprint.width, 10) * 0.43
    const halfD = positiveOr(b.footprint.depth, 10) * 0.43
    const rot = finiteOr(b.rotation, 0)
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const cx = finiteOr(b.position.x, 0)
    const cz = finiteOr(b.position.z, 0)

    const floors = Math.max(1, Math.floor(positiveOr(b.floors, 1)))
    const useMul = positiveOr(EVAC_DELAY_BY_USE[b.use], 1)
    // §23 — one shared "the class was told to leave" moment per school.
    const groupDelay = rng.range(EVAC_DELAY_MIN, EVAC_DELAY_MAX) * useMul

    // Resolve the building's road anchor once for the whole population.
    let nodeId = b.nearestRoadNodeId
    if (nodeId === null || graph.nodeIndexOf(nodeId) < 0) {
      nodeId = graph.nearestNode(b.position)
      if (graph.nodeIndexOf(nodeId) < 0) nodeId = null
    }

    for (let k = 0; k < count; k++) {
      const profile = AGENT_PROFILES[rng.weightedIndex(weights)]

      const u = rng.range(-halfW, halfW)
      const v = rng.range(-halfD, halfD)
      const x = cx + u * cos - v * sin
      const z = cz + u * sin + v * cos

      let speed = positiveOr(BASE_SPEED[profile], 1.2) * rng.clampedNormal(1, 0.12, 0.7, 1.3)
      if (isHospital) speed *= HOSPITAL_SPEED_FACTOR
      if (!(speed > 0.15)) speed = 0.15

      const base = isGrouped
        ? groupDelay + rng.clampedNormal(0, GROUP_DELAY_SPREAD, -2 * GROUP_DELAY_SPREAD, 2 * GROUP_DELAY_SPREAD)
        : rng.range(EVAC_DELAY_MIN, EVAC_DELAY_MAX) * useMul
      // Which floor this occupant started on decides how much stairwell time it costs.
      const floorFactor = rng.next()
      let delay = (b.evacuationDelaySeconds ?? base) + EVAC_DELAY_PER_FLOOR * (floors - 1) * floorFactor
      if (!(delay > 1)) delay = 1

      const id = agents.length
      agents.push({
        id,
        profile,
        x,
        z,
        px: x,
        pz: z,
        originBuildingIndex: bi,
        currentRoadNodeId: nodeId,
        targetShelterIndex: -1,
        state: 'inside',
        evacuationStartDelay: delay,
        movementSpeed: speed,
        laneOffset: rng.range(-LANE_OFFSET_RANGE, LANE_OFFSET_RANGE),
        path: [],
        pathIndex: 0,
        currentEdgeId: null,
        repathUntil: 0,
        rerouteCount: 0,
        distanceWalked: 0,
        hasLeftBuilding: false,
        injurySeverity: 0,
      })
      runtime.agentIds.push(id)
    }
    runtime.occupantsInside = runtime.agentIds.length
  }

  return agents
}
