/**
 * §29, §31, §47, §66 — the earthquake itself.
 *
 * Everything stochastic is decided in `start()` from streams keyed by building
 * id, so the outcome of a run depends only on the seed — never on iteration
 * order, frame rate or wall-clock time. `update()` only *reveals* what
 * `start()` already decided.
 *
 * This module never touches agents; casualties are the engine's job, driven by
 * the `onCollapse` callback.
 */

import type { CityModel, DisasterScenario, RoadEdge, Vec2 } from '../types/city'
import type {
  BuildingRuntime,
  DamageState,
  DisasterSimulator,
  RoadRuntime,
} from '../types/simulation'
import { groundMultiplierAt } from './CityLoader'
import type { RoadGraph } from './RoadGraph'
import {
  COLLAPSE_ANIM_MAX,
  COLLAPSE_ANIM_MIN,
  COLLAPSE_WINDOW_END,
  COLLAPSE_WINDOW_START,
  FIRE_BURN_DURATION,
  FIRE_SPREAD_CHECK_INTERVAL,
  FIRE_SPREAD_RADIUS,
  LOGIC_EVERY,
  SIM_TIMESTEP,
} from './constants'
import {
  blockageProbability,
  clamp,
  clamp01,
  computeDamageScore,
  damageStateFor,
  economicLossFor,
  hazardIntensityAt,
} from './DamageCalculator'
import { streamFor, type Rng } from './rng'

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

/* --------------------------------------------------------------- constants */

/** Seconds for the shaking to rise from nothing to full amplitude. */
const SHAKE_RISE_TIME = 1.5
/** Fraction of the duration spent at full amplitude before the decay starts. */
const SHAKE_PLATEAU_RATIO = 0.42
/** Radians per second of the slow amplitude beat layered on each building. */
const SHAKE_WOBBLE_RATE = 1.7
/** `hazardIntensity` that maps to a full-amplitude shake. */
const SHAKE_REFERENCE_INTENSITY = 1
/**
 * Apparent surface-wave speed, m/s. Far too slow to be seismologically honest,
 * but at city scale it turns the onset into a visible ripple instead of the
 * whole map twitching on the same frame.
 */
const SURFACE_WAVE_SPEED = 340
const MAX_ARRIVAL_DELAY = 6

/** An aftershock lasts this fraction of the main shock. */
const AFTERSHOCK_DURATION_RATIO = 0.45
const MIN_AFTERSHOCK_DURATION = 4

/** §47 — all damage is visible by this many seconds after the shock. */
const DAMAGE_REVEAL_END = 40
const REVEAL_SPAN_MIN = 5
const REVEAL_SPAN_MAX = 13

/** §66 — fire. */
const FIRE_SPREAD_PERIOD = FIRE_SPREAD_CHECK_INTERVAL * SIM_TIMESTEP * LOGIC_EVERY
const FIRE_IGNITION_DELAY_MIN = 8
const FIRE_IGNITION_DELAY_MAX = 110
/** Per-check odds that an adjacent, fully exposed wooden building catches. */
const FIRE_SPREAD_BASE = 0.22
/** Fire is secondary: at most this fraction of the city ever burns. */
const FIRE_MAX_FRACTION = 0.1
/** Damage a completely burnt-out building adds on top of its shaking damage. */
const FIRE_DAMAGE_GAIN = 0.55
/** How much a building's damage state raises its ignition odds. */
const FIRE_DAMAGE_IGNITION: Record<DamageState, number> = {
  intact: 0,
  minor: 0,
  major: 0.55,
  severe: 1.25,
  collapsed: 1.9,
}
/** How readily each construction type carries fire. */
const FIRE_MATERIAL_WEIGHT: Record<string, number> = {
  wood: 1,
  prefab: 0.6,
  lightSteel: 0.35,
  masonry: 0.25,
  steel: 0.16,
  rc: 0.12,
}

const DAMAGE_RANK: Record<DamageState, number> = {
  intact: 0,
  minor: 1,
  major: 2,
  severe: 3,
  collapsed: 4,
}

/**
 * Half the widest carriageway in the schema (arterial, 22 m). Included in the
 * nearby-edge search radius because `edgesNear` measures to the road
 * centreline, not to its kerb.
 */
const WIDEST_ROAD_HALF_WIDTH = 12

/** How strongly the open street frontage pulls a building's fall line. */
const FRONTAGE_BIAS = 0.55
/** Debris a near miss adds to a road, as a fraction of the remaining headroom. */
const DEBRIS_SPILL_GAIN = 0.8
/** Accumulated debris at which a carriageway counts as impassable. */
const DEBRIS_BLOCK_THRESHOLD = 0.6

const TWO_PI = Math.PI * 2

/* ----------------------------------------------------------------- helpers */

function smoothstep(x: number): number {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

/** 0..1 shaking envelope of a single shock: fast rise, plateau, tapered decay. */
function pulse(t: number, duration: number): number {
  if (!(duration > 0) || !(t > 0) || t >= duration) return 0
  const rise = Math.min(SHAKE_RISE_TIME, duration * 0.3)
  if (rise > 0 && t < rise) return smoothstep(t / rise)
  const plateauEnd = Math.max(rise, duration * SHAKE_PLATEAU_RATIO)
  if (t <= plateauEnd) return 1
  const decay = duration - plateauEnd
  if (!(decay > 0)) return 0
  return Math.pow(1 - (t - plateauEnd) / decay, 1.7)
}

function normalizeAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0
  const wrapped = angle % TWO_PI
  return wrapped < 0 ? wrapped + TWO_PI : wrapped
}

/**
 * Closest point to `p` on the segment (ax, az)–(bx, bz), written into `out`.
 * Takes raw numbers because `RoadGraph.position()` may hand back a shared
 * object, which would alias if both endpoints were kept as references.
 */
function closestPointOnSegment(
  p: Vec2,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  out: Vec2,
): Vec2 {
  const dx = bx - ax
  const dz = bz - az
  const lengthSq = dx * dx + dz * dz
  if (!(lengthSq > 0)) {
    out.x = ax
    out.z = az
    return out
  }
  const t = clamp01(((p.x - ax) * dx + (p.z - az) * dz) / lengthSq)
  out.x = ax + t * dx
  out.z = az + t * dz
  return out
}

interface FireNeighbour {
  index: number
  /** 1 next door, 0 at `FIRE_SPREAD_RADIUS`. */
  proximity: number
}

interface Aftershock {
  time: number
  duration: number
  scale: number
}

interface BuildingPlan {
  hazardIntensity: number
  groundMultiplier: number
  /** Final damage decided at `start()`, revealed over the first 40 s. */
  finalDamage: number
  collapseThreshold: number
  /** Damage the reveal is allowed to show before a scheduled collapse fires. */
  revealCap: number
  /** Ceiling on fire damage, so a fire alone never reads as a collapse. */
  fireDamageCap: number
  arrivalDelay: number
  revealStart: number
  revealEnd: number
  /** `Infinity` for buildings that never collapse. */
  collapseTime: number
  collapseDuration: number
  collapseDirection: number
  collapseTriggered: boolean
  nearbyEdges: number[]
  fireNeighbours: FireNeighbour[]
  /** `Infinity` once resolved or when the building never ignites on its own. */
  ignitionTime: number
}

/* --------------------------------------------------------------- simulator */

export class EarthquakeSimulator implements DisasterSimulator {
  readonly type: string = 'earthquake'

  readonly city: CityModel
  readonly scenario: DisasterScenario
  readonly graph: RoadGraph
  readonly buildings: BuildingRuntime[]
  readonly roads: RoadRuntime[]
  readonly seed: number

  private onCollapse: (building: BuildingRuntime, now: number) => void
  private plans: BuildingPlan[]
  private aftershocks: Aftershock[]
  private started: boolean
  private duration: number
  private shakeEndTime: number
  private finishTime: number
  private pendingCollapses: number
  private time: number
  private elapsed: number
  private nextFireCheck: number
  private fireCheckIndex: number
  private fireCap: number
  private ignitedCount: number
  private scratch: Vec2

  constructor(options: EarthquakeOptions) {
    this.city = options.city
    this.scenario = options.scenario
    this.graph = options.graph
    this.buildings = options.buildings
    this.roads = options.roads
    this.seed = options.seed
    this.onCollapse = options.onCollapse

    this.plans = []
    this.aftershocks = []
    this.started = false
    this.duration = 40
    this.shakeEndTime = 40
    this.finishTime = 40
    this.pendingCollapses = 0
    this.time = 0
    this.elapsed = 0
    this.nextFireCheck = Number.POSITIVE_INFINITY
    this.fireCheckIndex = 0
    this.fireCap = 0
    this.ignitedCount = 0
    this.scratch = { x: 0, z: 0 }
  }

  /* ------------------------------------------------------------- start */

  start(): void {
    if (this.started) return
    this.started = true

    const scenario = this.scenario
    this.duration = Number.isFinite(scenario.durationSeconds)
      ? Math.max(1, scenario.durationSeconds)
      : 40

    this.aftershocks = []
    let shakeEnd = this.duration
    const rawAftershocks = Array.isArray(scenario.aftershocks) ? scenario.aftershocks : []
    for (const raw of rawAftershocks) {
      const time = Number.isFinite(raw.time) ? Math.max(0, raw.time) : -1
      const scale = Number.isFinite(raw.intensityScale) ? clamp(raw.intensityScale, 0, 1.5) : 0
      if (time < 0 || scale <= 0) continue
      const duration = Math.max(MIN_AFTERSHOCK_DURATION, this.duration * AFTERSHOCK_DURATION_RATIO)
      this.aftershocks.push({ time, duration, scale })
      shakeEnd = Math.max(shakeEnd, time + duration)
    }
    this.shakeEndTime = shakeEnd

    const epicenter = scenario.epicenter
    const epicenterX = Number.isFinite(epicenter.x) ? epicenter.x : 0
    const epicenterZ = Number.isFinite(epicenter.z) ? epicenter.z : 0

    this.plans = []
    this.pendingCollapses = 0
    this.ignitedCount = 0
    this.fireCheckIndex = 0
    this.time = 0
    this.elapsed = 0
    this.fireCap = Math.max(2, Math.round(this.buildings.length * FIRE_MAX_FRACTION))

    let lastCollapse = 0
    let lastReveal = 0

    for (const building of this.buildings) {
      const source = building.source
      const rng = streamFor(this.seed, 'eq:' + source.id)
      const position = source.position

      const rawGround = groundMultiplierAt(this.city, position)
      const ground = Number.isFinite(rawGround) && rawGround > 0 ? clamp(rawGround, 0.4, 2.4) : 1
      const hazard = hazardIntensityAt(scenario, position, ground)
      const damage = computeDamageScore(source, hazard, ground, rng)
      const threshold = Number.isFinite(source.collapseThreshold)
        ? clamp(source.collapseThreshold, 0.12, 1)
        : 0.75
      const state = damageStateFor(damage, threshold)

      const dx = (Number.isFinite(position.x) ? position.x : epicenterX) - epicenterX
      const dz = (Number.isFinite(position.z) ? position.z : epicenterZ) - epicenterZ
      const epicentralDistance = Math.hypot(dx, dz)
      const arrivalDelay = clamp(epicentralDistance / SURFACE_WAVE_SPEED, 0, MAX_ARRIVAL_DELAY)

      // Fall bearing is finalised below, once the nearby roads are known: the
      // building's open frontage pulls the fall line toward the street.
      const awayFromSource = Math.atan2(dz, dx)
      const collapseDuration = Math.max(
        0.25,
        rng.range(COLLAPSE_ANIM_MIN, Math.max(COLLAPSE_ANIM_MIN + 0.25, COLLAPSE_ANIM_MAX)),
      )

      let collapseTime = Number.POSITIVE_INFINITY
      if (state === 'collapsed') {
        // Badly overwhelmed structures go down during the strong motion; the
        // marginal ones hang on into the aftermath.
        const severity = clamp01((damage - threshold) / Math.max(0.15, 1 - threshold))
        const skew = Math.pow(rng.next(), 1 + 2.4 * severity)
        const windowEnd = Math.max(COLLAPSE_WINDOW_START, COLLAPSE_WINDOW_END)
        collapseTime = COLLAPSE_WINDOW_START + skew * (windowEnd - COLLAPSE_WINDOW_START)
        this.pendingCollapses++
        lastCollapse = Math.max(lastCollapse, collapseTime)
      }

      // Heavier damage becomes visible earlier — it happens during the shaking.
      const revealBias = clamp01(1 - damage * 0.65)
      let revealStart = 1 + rng.next() * (DAMAGE_REVEAL_END - 14) * (0.3 + 0.7 * revealBias)
      const span = rng.range(REVEAL_SPAN_MIN, REVEAL_SPAN_MAX)
      if (Number.isFinite(collapseTime)) {
        revealStart = Math.min(revealStart, Math.max(0.5, collapseTime - 4))
      }
      let revealEnd = Math.min(DAMAGE_REVEAL_END, revealStart + span)
      if (Number.isFinite(collapseTime)) revealEnd = Math.min(revealEnd, collapseTime)
      if (revealEnd <= revealStart) revealEnd = revealStart + 0.5
      lastReveal = Math.max(lastReveal, revealEnd)

      // A scheduled collapse owns the 'collapsed' transition, so the reveal is
      // capped just below the threshold until it fires. Fire damage is capped
      // the same way: nothing becomes 'collapsed' without `onCollapse`.
      const revealCap = Number.isFinite(collapseTime)
        ? Math.min(damage, threshold * 0.98)
        : damage
      const fireDamageCap = Math.max(0, Math.min(threshold * 0.9, threshold - 0.02))

      const ignitionDamage = FIRE_DAMAGE_IGNITION[state]
      const ignitionBase = Number.isFinite(source.fireIgnitionProbability)
        ? clamp01(source.fireIgnitionProbability)
        : 0
      const ignitionChance = clamp01(ignitionBase * ignitionDamage)
      let ignitionTime = Number.POSITIVE_INFINITY
      if (rng.chance(ignitionChance)) {
        ignitionTime =
          this.shakeEndTime + rng.range(FIRE_IGNITION_DELAY_MIN, FIRE_IGNITION_DELAY_MAX)
        if (Number.isFinite(collapseTime)) {
          ignitionTime = Math.max(ignitionTime, collapseTime + 5)
        }
      }

      // Must cover the same reach `blockageProbability` uses, or nearby roads
      // are never even considered. Distances are measured from the building
      // *centre* to the road centreline, so the building's own half-extent and
      // half the carriageway both have to be inside the radius — without them a
      // two-storey house searches 16 m and finds nothing, because its footprint
      // and the kerb setback already account for that much.
      const height = Number.isFinite(source.height) ? Math.max(0, source.height) : 6
      const fw = Number.isFinite(source.footprint.width) ? Math.max(1, source.footprint.width) : 10
      const fd = Number.isFinite(source.footprint.depth) ? Math.max(1, source.footprint.depth) : 10
      const footprintRadius = 0.5 * Math.max(fw, fd)
      const searchRadius = Math.max(12, footprintRadius + height * 0.9 + WIDEST_ROAD_HALF_WIDTH)
      const nearbyEdges = this.graph.edgesNear(position, searchRadius)

      // §31 — a building wedged into a block has exactly one unobstructed side:
      // its street frontage. Neighbours buttress the other three, so the debris
      // goes where there is room to go. Blend "away from the source" with
      // "toward the nearest street" as unit vectors, which wraps correctly at
      // +/-pi where averaging the raw angles would not.
      const frontage = this.frontageBearing(position, nearbyEdges)
      let fallBearing = awayFromSource
      if (Number.isFinite(frontage)) {
        const vx =
          (1 - FRONTAGE_BIAS) * Math.cos(awayFromSource) + FRONTAGE_BIAS * Math.cos(frontage)
        const vz =
          (1 - FRONTAGE_BIAS) * Math.sin(awayFromSource) + FRONTAGE_BIAS * Math.sin(frontage)
        if (vx * vx + vz * vz > 1e-8) fallBearing = Math.atan2(vz, vx)
      }
      const collapseDirection = normalizeAngle(
        fallBearing + rng.clampedNormal(0, 0.6, -1.9, 1.9),
      )

      this.plans.push({
        hazardIntensity: hazard,
        groundMultiplier: ground,
        finalDamage: damage,
        collapseThreshold: threshold,
        revealCap,
        fireDamageCap,
        arrivalDelay,
        revealStart,
        revealEnd,
        collapseTime,
        collapseDuration,
        collapseDirection,
        collapseTriggered: false,
        nearbyEdges: Array.isArray(nearbyEdges) ? nearbyEdges : [],
        fireNeighbours: [],
        ignitionTime,
      })

      // Reset the runtime so a re-run of the same seed starts from a clean slate.
      building.hazardIntensity = hazard
      building.groundMultiplier = ground
      building.damageScore = 0
      building.state = 'intact'
      building.economicLoss = 0
      building.collapseStartTime = null
      building.collapseProgress = 0
      building.collapseDirection = collapseDirection
      building.shakeIntensity = 0
      building.shakePhase = rng.range(0, TWO_PI)
      building.onFire = false
      building.fireStartTime = null
      building.burnProgress = 0
    }

    this.buildFireNeighbours()

    this.nextFireCheck = this.shakeEndTime + FIRE_SPREAD_PERIOD
    this.finishTime = Math.max(
      this.shakeEndTime,
      lastReveal,
      lastCollapse + Math.max(COLLAPSE_ANIM_MAX, COLLAPSE_ANIM_MIN),
    )
  }

  /**
   * Buckets buildings into a uniform grid of `FIRE_SPREAD_RADIUS` cells so the
   * neighbour lists cost O(n · neighbours) instead of O(n²).
   */
  private buildFireNeighbours(): void {
    const radius = Math.max(1, FIRE_SPREAD_RADIUS)
    const cells = new Map<string, number[]>()
    const count = this.buildings.length

    for (let i = 0; i < count; i++) {
      const p = this.buildings[i].source.position
      const cx = Math.floor((Number.isFinite(p.x) ? p.x : 0) / radius)
      const cz = Math.floor((Number.isFinite(p.z) ? p.z : 0) / radius)
      const key = cx + ':' + cz
      const bucket = cells.get(key)
      if (bucket) bucket.push(i)
      else cells.set(key, [i])
    }

    for (let i = 0; i < count; i++) {
      const p = this.buildings[i].source.position
      const px = Number.isFinite(p.x) ? p.x : 0
      const pz = Number.isFinite(p.z) ? p.z : 0
      const cx = Math.floor(px / radius)
      const cz = Math.floor(pz / radius)
      const neighbours = this.plans[i].fireNeighbours
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gz = cz - 1; gz <= cz + 1; gz++) {
          const bucket = cells.get(gx + ':' + gz)
          if (!bucket) continue
          for (const j of bucket) {
            if (j === i) continue
            const q = this.buildings[j].source.position
            const distance = Math.hypot(
              (Number.isFinite(q.x) ? q.x : 0) - px,
              (Number.isFinite(q.z) ? q.z : 0) - pz,
            )
            if (distance > radius) continue
            neighbours.push({ index: j, proximity: clamp01(1 - distance / radius) })
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------ update */

  update(dt: number, now: number): void {
    if (!this.started) return

    const step = Number.isFinite(dt) && dt > 0 ? dt : 0
    this.elapsed += step
    const t = Number.isFinite(now) ? Math.max(0, now) : this.elapsed
    this.time = t

    const count = this.buildings.length
    for (let i = 0; i < count; i++) {
      const building = this.buildings[i]
      const plan = this.plans[i]
      if (!building || !plan) continue
      this.updateCollapse(building, plan, t)
      this.updateReveal(building, plan, t)
      this.updateShake(building, plan, t)
      this.updateBurn(building, plan, t)
    }

    this.updateIgnitions(t)
  }

  private updateShake(building: BuildingRuntime, plan: BuildingPlan, t: number): void {
    const local = this.envelopeAt(t - plan.arrivalDelay)
    if (local <= 0) {
      building.shakeIntensity = 0
      return
    }
    const scaled = clamp01(plan.hazardIntensity / SHAKE_REFERENCE_INTENSITY)
    // A slow per-building beat keeps the city from moving as one rigid block.
    const wobble = 0.7 + 0.3 * Math.sin(t * SHAKE_WOBBLE_RATE + building.shakePhase)
    const collapsing = building.collapseStartTime === null ? 1 : 1 - building.collapseProgress
    building.shakeIntensity = clamp01(local * scaled * wobble * collapsing)
  }

  private updateReveal(building: BuildingRuntime, plan: BuildingPlan, t: number): void {
    if (t < plan.revealStart) return
    const span = plan.revealEnd - plan.revealStart
    const k = span > 0 ? smoothstep((t - plan.revealStart) / span) : 1
    this.raiseDamage(building, plan, plan.revealCap * k)
  }

  private updateCollapse(building: BuildingRuntime, plan: BuildingPlan, t: number): void {
    if (!Number.isFinite(plan.collapseTime)) return

    if (!plan.collapseTriggered) {
      if (t < plan.collapseTime) return
      plan.collapseTriggered = true
      this.pendingCollapses = Math.max(0, this.pendingCollapses - 1)

      building.damageScore = clamp01(Math.max(building.damageScore, plan.finalDamage))
      building.state = 'collapsed'
      building.economicLoss = economicLossFor(building.source, 'collapsed')
      building.collapseStartTime = t
      building.collapseProgress = 0
      this.applyBlockage(building, plan, t)
      // Called last, so the engine sees a fully-updated runtime record.
      this.onCollapse(building, t)
    }

    const startedAt = building.collapseStartTime === null ? plan.collapseTime : building.collapseStartTime
    building.collapseProgress = clamp01((t - startedAt) / plan.collapseDuration)
  }

  /**
   * Bearing from a building to the closest point on its nearest road, i.e. the
   * direction its open frontage faces. `NaN` when it has no road nearby.
   */
  private frontageBearing(position: Vec2, edgeIndices: number[]): number {
    let bestDistSq = Number.POSITIVE_INFINITY
    let bestX = 0
    let bestZ = 0
    for (let i = 0; i < edgeIndices.length; i++) {
      const edge = this.graph.edges[edgeIndices[i]]
      if (edge === undefined) continue
      const from = this.graph.position(edge.from)
      const ax = Number.isFinite(from.x) ? from.x : position.x
      const az = Number.isFinite(from.z) ? from.z : position.z
      const to = this.graph.position(edge.to)
      const bx = Number.isFinite(to.x) ? to.x : position.x
      const bz = Number.isFinite(to.z) ? to.z : position.z
      const closest = closestPointOnSegment(position, ax, az, bx, bz, this.scratch)
      const dx = closest.x - position.x
      const dz = closest.z - position.z
      const d2 = dx * dx + dz * dz
      if (d2 < bestDistSq) {
        bestDistSq = d2
        bestX = dx
        bestZ = dz
      }
    }
    if (!Number.isFinite(bestDistSq) || bestDistSq < 1e-6) return Number.NaN
    return Math.atan2(bestZ, bestX)
  }

  /** §31 — drop rubble on the road edges the building can actually reach. */
  private applyBlockage(building: BuildingRuntime, plan: BuildingPlan, t: number): void {
    if (plan.nearbyEdges.length === 0) return
    const rng = streamFor(this.seed, 'eq-blockage:' + building.id)
    const source = building.source
    const position = source.position

    for (const edgeIndex of plan.nearbyEdges) {
      const road = this.roads[edgeIndex]
      if (!road) continue
      const edge: RoadEdge | undefined = road.source ?? this.graph.edges[edgeIndex]
      if (!edge) continue

      const from = this.graph.position(edge.from)
      const ax = Number.isFinite(from.x) ? from.x : position.x
      const az = Number.isFinite(from.z) ? from.z : position.z
      const to = this.graph.position(edge.to)
      const bx = Number.isFinite(to.x) ? to.x : position.x
      const bz = Number.isFinite(to.z) ? to.z : position.z

      const closest = closestPointOnSegment(position, ax, az, bx, bz, this.scratch)
      const dx = closest.x - position.x
      const dz = closest.z - position.z
      const distance = Math.hypot(dx, dz)
      const bearingToEdge = distance > 1e-4 ? Math.atan2(dz, dx) : plan.collapseDirection
      const edgeBearing = Math.atan2(bz - az, bx - ax)

      const probability = blockageProbability(
        source,
        edge,
        distance,
        plan.collapseDirection,
        edgeBearing,
        bearingToEdge,
      )
      if (probability <= 0) continue

      const current = Number.isFinite(road.debrisLevel) ? road.debrisLevel : 0
      let debris: number
      if (rng.chance(probability)) {
        // Direct hit: the frontage comes down across the carriageway.
        debris = clamp01(Math.max(current, 0.62 + 0.38 * probability))
      } else {
        // Near miss: rubble still spills onto the carriageway, and it
        // *accumulates*. One house narrows the street; the fourth one along the
        // same block closes it. Saturating, so debris approaches but never
        // exceeds 1 no matter how many buildings come down.
        debris = clamp01(current + probability * DEBRIS_SPILL_GAIN * (1 - current))
      }
      road.debrisLevel = debris
      if (!road.blocked && debris >= DEBRIS_BLOCK_THRESHOLD) {
        road.blocked = true
        road.blockedAt = t
      }
    }
  }

  /* -------------------------------------------------------------- fire */

  private updateIgnitions(t: number): void {
    const count = this.buildings.length
    for (let i = 0; i < count; i++) {
      const plan = this.plans[i]
      if (!plan || t < plan.ignitionTime) continue
      plan.ignitionTime = Number.POSITIVE_INFINITY
      this.ignite(this.buildings[i], t)
    }

    if (t >= this.nextFireCheck) {
      this.spreadFire(t)
      this.nextFireCheck = t + FIRE_SPREAD_PERIOD
    }
  }

  private ignite(building: BuildingRuntime, t: number): boolean {
    if (!building || building.onFire || building.burnProgress > 0) return false
    if (this.ignitedCount >= this.fireCap) return false
    building.onFire = true
    building.fireStartTime = t
    building.burnProgress = 0
    this.ignitedCount++
    return true
  }

  private spreadFire(t: number): void {
    if (this.ignitedCount >= this.fireCap) return
    const rng: Rng = streamFor(this.seed, 'eq-fire:' + this.fireCheckIndex)
    this.fireCheckIndex++

    const count = this.buildings.length
    for (let i = 0; i < count; i++) {
      const building = this.buildings[i]
      if (!building.onFire) continue
      // A fire is at its most dangerous to the neighbours in mid-burn.
      const heat = 0.35 + 0.65 * Math.sin(Math.PI * clamp01(building.burnProgress))
      const neighbours = this.plans[i].fireNeighbours
      for (const neighbour of neighbours) {
        const target = this.buildings[neighbour.index]
        if (!target || target.onFire || target.burnProgress > 0) continue
        const rawWeight = FIRE_MATERIAL_WEIGHT[target.source.constructionType]
        const weight = Number.isFinite(rawWeight) ? rawWeight : 0.2
        const damaged = 0.6 + 0.8 * clamp01(target.damageScore)
        const probability = clamp01(
          FIRE_SPREAD_BASE * weight * neighbour.proximity * heat * damaged,
        )
        if (probability <= 0) continue
        if (rng.chance(probability) && this.ignite(target, t)) {
          if (this.ignitedCount >= this.fireCap) return
        }
      }
    }
  }

  private updateBurn(building: BuildingRuntime, plan: BuildingPlan, t: number): void {
    if (!building.onFire) return
    const startedAt = building.fireStartTime === null ? t : building.fireStartTime
    const duration = FIRE_BURN_DURATION > 0 ? FIRE_BURN_DURATION : 1
    const progress = clamp01((t - startedAt) / duration)
    building.burnProgress = progress
    // Burning adds damage but is capped below the collapse threshold: a
    // building only ever becomes 'collapsed' through a scheduled collapse.
    this.raiseDamage(
      building,
      plan,
      Math.min(plan.fireDamageCap, plan.finalDamage + FIRE_DAMAGE_GAIN * progress),
    )
    if (progress >= 1) building.onFire = false
  }

  /**
   * Damage only ever moves up. This is what keeps a burnt-out shell from
   * regressing when the (slower) shaking reveal catches up with it.
   */
  private raiseDamage(building: BuildingRuntime, plan: BuildingPlan, score: number): void {
    const next = clamp01(score)
    const current = Number.isFinite(building.damageScore) ? building.damageScore : 0
    if (next > current) building.damageScore = next
    else building.damageScore = current
    if (building.state === 'collapsed') return

    const state = damageStateFor(building.damageScore, plan.collapseThreshold)
    if (DAMAGE_RANK[state] > DAMAGE_RANK[building.state]) {
      building.state = state
      building.economicLoss = economicLossFor(building.source, state)
    }
  }

  /* ------------------------------------------------------------ queries */

  /** 0..1 global shaking envelope, for the renderer. */
  shakeEnvelope(now: number): number {
    if (!this.started) return 0
    return this.envelopeAt(Number.isFinite(now) ? now : this.time)
  }

  private envelopeAt(t: number): number {
    if (!Number.isFinite(t) || t <= 0) return 0
    let value = pulse(t, this.duration)
    for (const aftershock of this.aftershocks) {
      const v = pulse(t - aftershock.time, aftershock.duration) * aftershock.scale
      if (v > value) value = v
    }
    return clamp01(value)
  }

  isFinished(): boolean {
    if (!this.started) return false
    return this.pendingCollapses <= 0 && this.time >= this.finishTime
  }
}
