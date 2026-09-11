/**
 * Fixed-timestep orchestrator (§45).
 *
 * Owns every runtime array and drives the disaster + evacuation simulators.
 * Nothing in here touches React, Three.js or the store: the renderer reads the
 * mutable arrays through the engine reference and only the tiny
 * `SimulationSnapshot` ever crosses into React state.
 */

import type { CityModel, DisasterScenario } from '../types/city'
import type {
  Agent,
  BuildingRuntime,
  RoadRuntime,
  ShelterRuntime,
  SimulationPhase,
  SimulationSnapshot,
  Statistics,
} from '../types/simulation'
import { EMPTY_STATISTICS } from '../types/simulation'

import { primaryEarthquake } from './CityLoader'
import { RoadGraph } from './RoadGraph'
import {
  createBuildingRuntimes,
  createRoadRuntimes,
  createShelterRuntimes,
  generatePopulation,
} from './PopulationGenerator'
import { EarthquakeSimulator } from './EarthquakeSimulator'
import { EnvironmentalDisaster, DISASTER_LABELS } from './EnvironmentalDisaster'
import { TrafficSimulator } from './TrafficSimulator'
import type { DisasterType } from './EnvironmentalDisaster'
import { EvacuationSimulator } from './EvacuationSimulator'
import { computeStatistics } from './StatisticsCalculator'
import {
  LOGIC_EVERY,
  MAX_STEPS_PER_FRAME,
  SIM_END_TIME,
  SIM_TIMESTEP,
  SPEED_STEPS,
} from './constants'

/** Largest real-time delta we are willing to integrate in one call, seconds. */
const MAX_REAL_DELTA = 0.25

/** Defensive copy of the timestep: every division below uses this. */
const STEP = SIM_TIMESTEP > 0 ? SIM_TIMESTEP : 0.25

/** Logic runs every N-th fixed step; never zero. */
const LOGIC_STRIDE = LOGIC_EVERY >= 1 ? Math.floor(LOGIC_EVERY) : 1

/** Hard ceiling on catch-up steps per frame; never zero. */
const STEP_BUDGET = MAX_STEPS_PER_FRAME >= 1 ? Math.floor(MAX_STEPS_PER_FRAME) : 1

const SPEED_VALUES: readonly number[] = SPEED_STEPS

const DEFAULT_SEED = 20260908

function normaliseSeed(seed: number): number {
  if (!Number.isFinite(seed)) return DEFAULT_SEED
  const truncated = Math.trunc(seed)
  // Rng only consumes 32 bits; keep it positive so `>>> 0` is stable.
  return Math.abs(truncated) >>> 0 || DEFAULT_SEED
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

export class SimulationEngine {
  readonly city: CityModel
  readonly graph: RoadGraph
  readonly traffic: TrafficSimulator
  scenario: DisasterScenario
  disasterType: DisasterType = 'earthquake'
  private environmental: EnvironmentalDisaster | null = null
  runVersion = 0
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

  /** Unconsumed simulation seconds, always < STEP after `advance`. */
  private accumulator: number
  /** Number of fixed steps executed since the shock; drives the logic tick. */
  private stepCounter: number
  private earthquake: EarthquakeSimulator | null
  private evacuation: EvacuationSimulator
  /** Single reused object — recomputed on logic ticks only. */
  private readonly stats: Statistics

  constructor(city: CityModel, seed: number) {
    this.city = city
    this.seed = normaliseSeed(seed)
    this.scenario = primaryEarthquake(city)
    this.graph = new RoadGraph(city)
    this.traffic = new TrafficSimulator(city, this.seed)

    this.buildings = []
    this.roads = []
    this.shelters = []
    this.agents = []

    this.phase = 'idle'
    this.time = 0
    this.speed = SPEED_VALUES.length > 0 ? SPEED_VALUES[0] : 1
    this.paused = false
    this.alpha = 0

    this.accumulator = 0
    this.stepCounter = 0
    this.earthquake = null
    this.stats = { ...EMPTY_STATISTICS }

    this.evacuation = this.build()
  }

  /**
   * Rebuilds every runtime array in place from the city + seed and returns a
   * matching evacuation simulator. The arrays keep their identity so renderers
   * that captured `engine.agents` once still see the fresh population (§52).
   * Called by both the constructor and `reset()`, which is what makes a reset
   * bit-for-bit identical to the original run.
   */
  private build(): EvacuationSimulator {
    this.buildings.length = 0
    this.roads.length = 0
    this.shelters.length = 0
    this.agents.length = 0

    const buildings = createBuildingRuntimes(this.city)
    for (let i = 0; i < buildings.length; i++) this.buildings.push(buildings[i])

    const roads = createRoadRuntimes(this.city)
    for (let i = 0; i < roads.length; i++) this.roads.push(roads[i])

    const shelters = createShelterRuntimes(this.city)
    for (let i = 0; i < shelters.length; i++) this.shelters.push(shelters[i])

    const agents = generatePopulation(this.city, this.graph, this.buildings, this.seed)
    for (let i = 0; i < agents.length; i++) this.agents.push(agents[i])

    this.refreshStatistics()

    return new EvacuationSimulator({
      city: this.city,
      graph: this.graph,
      buildings: this.buildings,
      roads: this.roads,
      shelters: this.shelters,
      agents: this.agents,
      seed: this.seed,
    })
  }

  get windStrength(): number { return this.environmental?.windStrength ?? 0 }
  get windDirection(): number { return this.environmental?.windDirection ?? 0 }
  get hazardProgress(): number { return this.environmental?.progress ?? clamp01(this.time / this.scenario.durationSeconds) }
  waterDepthAt(x: number, z: number): number { return this.environmental?.waterDepthAt(x, z) ?? 0 }

  triggerDisaster(type: DisasterType): void {
    if (this.phase !== 'idle') return
    this.disasterType = type
    if (type === 'earthquake') { this.triggerEarthquake(); return }
    this.traffic.reset()
    const authored = this.city.disasterScenarios.find(s => s.type === type)
    this.scenario = authored ?? { ...primaryEarthquake(this.city), id: type + '_default', type, name: DISASTER_LABELS[type], durationSeconds: 0 }
    this.environmental = new EnvironmentalDisaster({
      type, city: this.city, buildings: this.buildings, roads: this.roads,
      shelters: this.shelters, seed: this.seed,
      onCollapse: (b, now) => this.evacuation.onBuildingCollapse(b, now),
    })
    this.environmental.start()
    this.phase = 'shaking'
    this.runVersion++
    this.refreshStatistics()
  }

  triggerEarthquake(): void {
    if (this.phase !== 'idle') return

    this.disasterType = 'earthquake'
    this.traffic.reset()
    this.scenario = primaryEarthquake(this.city)
    this.runVersion++
    for (const agent of this.agents) agent.evacuationStartDelay += this.scenario.durationSeconds

    // Captured locally: a later reset() swaps in a new evacuation simulator and
    // discards this earthquake, so the closure must not follow `this`.
    const evacuation = this.evacuation
    this.earthquake = new EarthquakeSimulator({
      city: this.city,
      scenario: this.scenario,
      graph: this.graph,
      buildings: this.buildings,
      roads: this.roads,
      seed: this.seed,
      onCollapse: (building: BuildingRuntime, now: number) => {
        evacuation.onBuildingCollapse(building, now)
      },
    })
    this.earthquake.start()

    this.phase = 'shaking'
    this.time = 0
    this.accumulator = 0
    this.alpha = 0
    this.stepCounter = 0
    this.refreshStatistics()
  }

  togglePause(): void {
    this.paused = !this.paused
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed)) return
    if (SPEED_VALUES.indexOf(speed) < 0) return
    this.speed = speed
  }

  /** Rebuilds every runtime array from scratch using the same seed (§52). */
  reset(): void {
    this.earthquake = null
    this.environmental = null
    this.traffic.reset()
    this.runVersion++
    this.phase = 'idle'
    this.time = 0
    this.alpha = 0
    this.accumulator = 0
    this.stepCounter = 0
    this.paused = false
    // §52 — "completely back to the initial state" includes the playback speed:
    // the user is looking at a peaceful city again, not at a paused ×16 run.
    this.speed = SPEED_STEPS[0]
    this.evacuation = this.build()
  }

  /** `realDelta` in real seconds; internally clamped to 0.25 s. */
  advance(realDelta: number): void {
    const delta = Number.isFinite(realDelta)
      ? Math.min(MAX_REAL_DELTA, Math.max(0, realDelta))
      : 0
    // Read into a local: narrowing `this.phase` here would make TypeScript
    // believe `step()` cannot change it.
    const phase = this.phase
    if (phase === 'idle' || phase === 'finished') {
      if (phase === 'idle' && !this.paused) this.advanceTraffic(delta)
      this.alpha = 0
      this.accumulator = 0
      return
    }

    this.accumulator += delta * (this.paused ? 0 : this.speed)

    let steps = 0
    while (this.accumulator >= STEP && steps < STEP_BUDGET) {
      this.accumulator -= STEP
      steps++
      this.step()
      if (this.phase === 'finished') break
    }

    // Whatever we could not consume this frame is dropped rather than carried:
    // a backgrounded tab must not build a backlog it then fast-forwards through.
    if (this.accumulator >= STEP) this.accumulator %= STEP

    this.alpha = clamp01(this.accumulator / STEP)
  }

  private step(): void {
    this.time += STEP
    this.stepCounter++
    const logicTick = this.stepCounter % LOGIC_STRIDE === 0
    const now = this.time

    const earthquake = this.earthquake
    if (earthquake) earthquake.update(STEP, now)
    this.environmental?.update(STEP, now)
    this.advanceTraffic(STEP)
    if (logicTick) this.evacuation.evacuateUnsafeShelters(now)
    this.evacuation.update(STEP, now, logicTick)

    const disasterDone = this.environmental ? this.environmental.isFinished() : earthquake ? earthquake.isFinished() : true
    if (this.phase === 'shaking' && disasterDone) this.phase = 'evacuating'

    if (logicTick) this.refreshStatistics()

    if (this.time >= SIM_END_TIME) {
      this.finish()
      return
    }
    // `isSettled` walks every agent, so only ask on logic ticks.
    if (logicTick && disasterDone && this.evacuation.isSettled()) this.finish()
  }

  private finish(): void {
    if (this.phase === 'finished') return
    this.phase = 'finished'
    this.accumulator = 0
    this.alpha = 0
    this.refreshStatistics()
  }

  private advanceTraffic(dt: number): void {
    this.traffic.advance(dt, {
      roads: this.roads, emergency: this.phase !== 'idle',
      earthquake: this.disasterType === 'earthquake', disasterTime: this.time,
      waterDepthAt: (x, z) => this.waterDepthAt(x, z),
    })
  }

  private refreshStatistics(): void {
    computeStatistics(this.buildings, this.roads, this.shelters, this.agents, this.stats)
  }

  /** The live, reused statistics object. Do not retain or mutate it. */
  getStatistics(): Statistics {
    return this.stats
  }

  /** A fresh snapshot with a shallow copy of the stats, so the store can diff. */
  snapshot(): SimulationSnapshot {
    return {
      phase: this.phase,
      disasterType: this.disasterType,
      time: this.time,
      speed: this.speed,
      paused: this.paused,
      stats: { ...this.stats },
    }
  }

  shakeEnvelope(): number {
    if (this.phase === 'idle' || this.phase === 'finished') return 0
    const earthquake = this.earthquake
    if (!earthquake) return 0
    return clamp01(earthquake.shakeEnvelope(this.renderTime()))
  }

  /** For the collapse/shake renderers: current sim time including alpha. */
  renderTime(): number {
    return this.time + this.alpha * STEP
  }
}
