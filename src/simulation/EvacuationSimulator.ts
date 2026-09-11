/**
 * Evacuation: departure, path following, congestion, rerouting, shelter
 * admission and collapse casualties (§37–§41, §50, §56).
 *
 * Design notes
 * ------------
 * - Per-agent mutable movement state lives in parallel typed arrays indexed by
 *   `Agent.id` so the per-step loop never touches a hash map and never
 *   allocates.
 * - Expensive decisions (route planning, blockage checks) are spread across
 *   fixed steps by striding the agent array: departures visit every agent once
 *   per simulated second, route checks once every REROUTE_CHECK_INTERVAL
 *   logic ticks.
 * - Every change to which edge an agent occupies goes through `setEdge`, which
 *   is the single writer of `RoadRuntime.agentCount`.
 */

import type { AgentProfile, CityModel } from '../types/city'
import type { Agent, BuildingRuntime, RoadRuntime, ShelterRuntime } from '../types/simulation'
import type { PathCostContext, PathResult } from './PathFinder'
import { findPathToAny } from './PathFinder'
import type { RoadGraph } from './RoadGraph'
import {
  CONSTRUCTION_VULNERABILITY,
  LOGIC_EVERY,
  MAX_REROUTES,
  MIN_CONGESTION_SPEED_FACTOR,
  REPATH_PAUSE,
  REROUTE_CHECK_INTERVAL,
  ROAD_COMFORT_DENSITY,
  SHELTER_ARRIVAL_RADIUS,
} from './constants'
import { Rng, hashString, mixSeed, streamFor } from './rng'

/** Agent movement modes. Plain constants — `erasableSyntaxOnly` forbids enums. */
const MODE_IDLE = 0
/** Walking toward `path[pathIndex]` along the current edge. */
const MODE_WALK = 1
/** Walking back to the node the agent came from after a mid-edge reroute. */
const MODE_RETURN = 2
/** Off the graph, closing the last few metres to the shelter entrance. */
const MODE_APPROACH = 3
/** Standing still while the replan pause elapses. */
const MODE_WAIT = 4
/** Terminal: sheltered, casualty, or gave up. */
const MODE_STOPPED = 5
const MODE_ACCESS = 6

/** Departures are checked in this many interleaved slices — one per fixed step. */
const DEPART_STRIDE = LOGIC_EVERY
/** Route checks are spread over four logic ticks' worth of fixed steps. */
const REROUTE_STRIDE = LOGIC_EVERY * REROUTE_CHECK_INTERVAL

const MAX_SHELTER_CANDIDATES = 6
/** Seconds an agent that found no route waits before trying again (a road may clear). */
const INSIDE_RETRY_INTERVAL = 15
const CONGESTION_SLOWDOWN = 1.4
const DEBRIS_SLOWDOWN = 1.6
const MIN_DEBRIS_SPEED_FACTOR = 0.3
/** Half-width kept clear of the kerb when applying an agent's lane offset. */
const KERB_MARGIN = 0.8

/** §40 — relative casualty odds per profile inside a collapsing building. */
const PROFILE_CASUALTY_FACTOR: Record<AgentProfile, number> = {
  adult: 0.85,
  child: 1.05,
  elderly: 1.35,
  mobilityImpaired: 1.65,
}

function clamp01(v: number): number {
  if (!(v > 0)) return 0
  return v > 1 ? 1 : v
}

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
  readonly city: CityModel
  readonly graph: RoadGraph
  readonly buildings: BuildingRuntime[]
  readonly roads: RoadRuntime[]
  readonly shelters: ShelterRuntime[]
  readonly agents: Agent[]
  readonly seed: number

  private pathCtx: PathCostContext
  private rng: Rng

  private nodeX: Float64Array
  private nodeZ: Float64Array
  private nodeIds: string[]

  private shelterNodeIds: string[]
  private shelterNodeIndex: Int32Array

  /** Combined congestion × debris speed multiplier, refreshed each logic tick. */
  private edgeSpeedFactor: Float64Array
  /** Scratch flags used while resolving the edges next to a collapsing building. */
  private edgeMark: Uint8Array

  private mode: Uint8Array
  private edgeOf: Int32Array
  private fromNode: Int32Array
  private toNode: Int32Array
  private tgtX: Float64Array
  private tgtZ: Float64Array
  private atNode: Uint8Array
  /** 1 while the agent's state can still change; drives `isSettled`. */
  private pendingFlag: Uint8Array
  private pending: number
  private stepIndex: number

  private goalPool: { nodeId: string; bias: number }[]
  private goalList: { nodeId: string; bias: number }[]
  private goalShelter: Int32Array
  private candIdx: Int32Array
  private candDist: Float64Array

  constructor(options: EvacuationOptions) {
    this.city = options.city
    this.graph = options.graph
    this.buildings = options.buildings
    this.roads = options.roads
    this.shelters = options.shelters
    this.agents = options.agents
    this.seed = options.seed >>> 0
    this.pathCtx = { roads: options.roads }
    this.rng = streamFor(this.seed, 'evacuation')
    this.stepIndex = 0

    const nodes = this.graph.nodes
    const nodeCount = nodes.length
    this.nodeX = new Float64Array(nodeCount)
    this.nodeZ = new Float64Array(nodeCount)
    this.nodeIds = new Array<string>(nodeCount)
    for (let i = 0; i < nodeCount; i++) {
      const n = nodes[i]
      const px = n.position.x
      const pz = n.position.z
      this.nodeX[i] = Number.isFinite(px) ? px : 0
      this.nodeZ[i] = Number.isFinite(pz) ? pz : 0
      this.nodeIds[i] = n.id
    }

    const shelterCount = this.shelters.length
    this.shelterNodeIds = new Array<string>(shelterCount)
    this.shelterNodeIndex = new Int32Array(shelterCount)
    for (let i = 0; i < shelterCount; i++) {
      const s = this.shelters[i]
      let nodeId = s.source.roadNodeId === null ? '' : s.source.roadNodeId
      let idx = nodeId === '' ? -1 : this.graph.nodeIndexOf(nodeId)
      if (idx < 0) {
        nodeId = this.graph.nearestNode(s.source.position)
        idx = this.graph.nodeIndexOf(nodeId)
      }
      if (idx < 0) nodeId = ''
      this.shelterNodeIds[i] = nodeId
      this.shelterNodeIndex[i] = idx
    }

    const roadCount = this.roads.length
    this.edgeSpeedFactor = new Float64Array(roadCount)
    this.edgeSpeedFactor.fill(1)
    this.edgeMark = new Uint8Array(roadCount)
    for (let i = 0; i < roadCount; i++) this.roads[i].agentCount = 0

    const n = this.agents.length
    this.mode = new Uint8Array(n)
    this.edgeOf = new Int32Array(n)
    this.fromNode = new Int32Array(n)
    this.toNode = new Int32Array(n)
    this.tgtX = new Float64Array(n)
    this.tgtZ = new Float64Array(n)
    this.atNode = new Uint8Array(n)
    this.pendingFlag = new Uint8Array(n)
    this.edgeOf.fill(-1)
    this.toNode.fill(-1)
    this.pending = 0
    for (let i = 0; i < n; i++) {
      const a = this.agents[i]
      const id = a.currentRoadNodeId
      this.fromNode[i] = id === null ? -1 : this.graph.nodeIndexOf(id)
      this.mode[i] = MODE_IDLE
      this.atNode[i] = 1
      a.currentEdgeId = null
      if (a.state === 'inside' || a.state === 'evacuating') {
        this.pendingFlag[i] = 1
        this.pending++
      }
    }

    this.goalPool = new Array<{ nodeId: string; bias: number }>(MAX_SHELTER_CANDIDATES)
    for (let i = 0; i < MAX_SHELTER_CANDIDATES; i++) this.goalPool[i] = { nodeId: '', bias: 1 }
    this.goalList = []
    this.goalShelter = new Int32Array(MAX_SHELTER_CANDIDATES)
    this.candIdx = new Int32Array(MAX_SHELTER_CANDIDATES)
    this.candDist = new Float64Array(MAX_SHELTER_CANDIDATES)

    this.recomputeRoadState()
  }

  /** `logicTick` is true once per simulation second. */
  update(dt: number, now: number, logicTick: boolean): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0
    const time = Number.isFinite(now) ? now : 0
    this.stepIndex = (this.stepIndex + 1) % 0x40000000
    if (logicTick) this.recomputeRoadState()
    this.processInside(time)
    this.processRouteChecks(time)
    this.moveAgents(step, time)
  }

  /** A refuge inundated or threatened by fire must not retain its occupants. */
  evacuateUnsafeShelters(now: number): void {
    for (const a of this.agents) {
      if (a.state !== 'sheltered' || !this.shelters[a.targetShelterIndex]?.unsafe) continue
      const s = this.shelters[a.targetShelterIndex]
      s.occupancy = Math.max(0, s.occupancy - 1)
      s.full = s.occupancy >= s.capacity
      const i = a.id
      a.state = 'evacuating'
      a.targetShelterIndex = -1
      a.repathUntil = now + REPATH_PAUSE
      a.rerouteCount = 0
      this.fromNode[i] = this.graph.nodeIndexOf(this.graph.nearestNode({ x: a.x, z: a.z }))
      this.mode[i] = MODE_WAIT
      this.atNode[i] = 0
      if (!this.pendingFlag[i]) { this.pendingFlag[i] = 1; this.pending++ }
    }
  }

  /** True when no agent can make further progress (§50). */
  isSettled(): boolean {
    return this.pending <= 0
  }

  // ---------------------------------------------------------------- congestion

  /** §39 — one pass over the edges per logic tick. */
  private recomputeRoadState(): void {
    const roads = this.roads
    for (let i = 0; i < roads.length; i++) {
      const r = roads[i]
      const src = r.source
      const length = Number.isFinite(src.length) && src.length > 0 ? src.length : 1
      const lanes = Number.isFinite(src.lanes) && src.lanes > 0 ? src.lanes : 1
      const capacity = Math.max(1, ROAD_COMFORT_DENSITY * length * lanes)
      const count = r.agentCount > 0 ? r.agentCount : 0
      const congestion = clamp01(count / capacity)
      r.congestion = congestion
      let f = 1 / (1 + CONGESTION_SLOWDOWN * congestion)
      if (f > 1) f = 1
      if (f < MIN_CONGESTION_SPEED_FACTOR) f = MIN_CONGESTION_SPEED_FACTOR
      let df = 1 / (1 + DEBRIS_SLOWDOWN * clamp01(r.debrisLevel))
      if (df > 1) df = 1
      if (df < MIN_DEBRIS_SPEED_FACTOR) df = MIN_DEBRIS_SPEED_FACTOR
      this.edgeSpeedFactor[i] = f * df * Math.max(0.25, 1 - r.waterDepth * 1.3)
    }
  }

  // ------------------------------------------------------------- edge accounting

  /**
   * The only writer of `RoadRuntime.agentCount`. Always releases the previous
   * edge before claiming the new one, so a count can never leak.
   */
  private setEdge(agent: Agent, newEdgeIndex: number): void {
    const i = agent.id
    const prev = this.edgeOf[i]
    let next = newEdgeIndex
    if (next < 0 || next >= this.roads.length) next = -1
    if (prev === next) {
      if (next < 0) agent.currentEdgeId = null
      return
    }
    if (prev >= 0 && prev < this.roads.length) {
      const r = this.roads[prev]
      if (r !== undefined) r.agentCount = r.agentCount > 0 ? r.agentCount - 1 : 0
    }
    if (next >= 0) {
      const r = this.roads[next]
      if (r !== undefined) {
        r.agentCount++
        this.edgeOf[i] = next
        agent.currentEdgeId = r.id
        return
      }
      next = -1
    }
    this.edgeOf[i] = -1
    agent.currentEdgeId = null
  }

  private clearPending(id: number): void {
    if (this.pendingFlag[id] === 1) {
      this.pendingFlag[id] = 0
      this.pending--
    }
  }

  /** The agent can make no further progress; it stays where it is. */
  private giveUp(agent: Agent): void {
    const i = agent.id
    // Releasing the edge is not optional: a stopped agent that stays counted on
    // its road inflates that road's congestion for everyone else, for the rest
    // of the run, and leaks the agentCount invariant.
    this.setEdge(agent, -1)
    this.mode[i] = MODE_STOPPED
    this.toNode[i] = -1
    this.clearPending(i)
  }

  /** True while some reachable shelter still has room. */
  private anyShelterHasRoom(): boolean {
    const shelters = this.shelters
    for (let i = 0; i < shelters.length; i++) {
      const s = shelters[i]
      if (this.shelterNodeIndex[i] < 0) continue
      if (!s.unsafe && s.occupancy < s.capacity) return true
    }
    return false
  }

  /**
   * §38 — every shelter is full and this agent is not getting in. It stops
   * where it stands, just outside the shelter, and is counted as evacuated but
   * never sheltered. Scattered around the perimeter so it reads as a crowd
   * waiting outside rather than a stack of bodies on one point.
   */
  private waitOutside(agent: Agent, shelter: ShelterRuntime | undefined): void {
    if (shelter !== undefined) {
      const fw = Number.isFinite(shelter.source.footprint.width)
        ? shelter.source.footprint.width
        : 20
      const fd = Number.isFinite(shelter.source.footprint.depth)
        ? shelter.source.footprint.depth
        : 20
      const angle = this.rng.range(0, Math.PI * 2)
      const ring = 0.5 * Math.max(fw, fd) + this.rng.range(2, 12)
      agent.x = shelter.source.position.x + Math.cos(angle) * ring
      agent.z = shelter.source.position.z + Math.sin(angle) * ring
      agent.px = agent.x
      agent.pz = agent.z
    }
    this.giveUp(agent)
  }

  // ---------------------------------------------------------------- departures

  private processInside(now: number): void {
    const agents = this.agents
    const n = agents.length
    for (let i = this.stepIndex % DEPART_STRIDE; i < n; i += DEPART_STRIDE) {
      const a = agents[i]
      if (a.state !== 'inside') continue
      if (this.pendingFlag[i] === 0) continue
      if (now < a.evacuationStartDelay) continue
      if (now < a.repathUntil) continue
      this.tryDepart(a, now)
    }
  }

  private tryDepart(agent: Agent, now: number): void {
    const i = agent.id
    let fromIdx = this.fromNode[i]
    if (fromIdx < 0) {
      const b = this.buildings[agent.originBuildingIndex]
      if (b === undefined) {
        this.giveUp(agent)
        return
      }
      fromIdx = this.graph.nodeIndexOf(this.graph.nearestNode(b.source.position))
      this.fromNode[i] = fromIdx
    }
    if (fromIdx < 0) {
      this.giveUp(agent)
      return
    }

    const shelterIndex = this.planRoute(agent, fromIdx)
    if (shelterIndex < 0) {
      agent.rerouteCount++
      if (agent.rerouteCount >= MAX_REROUTES) this.giveUp(agent)
      else agent.repathUntil = now + INSIDE_RETRY_INTERVAL + (i % 8) * 0.5
      return
    }

    const b = this.buildings[agent.originBuildingIndex]
    if (b !== undefined && b.occupantsInside > 0) b.occupantsInside--
    agent.state = 'evacuating'
    agent.hasLeftBuilding = true
    agent.targetShelterIndex = shelterIndex
    agent.currentRoadNodeId = this.nodeIds[fromIdx]
    this.tgtX[i] = this.nodeX[fromIdx]
    this.tgtZ[i] = this.nodeZ[fromIdx]
    this.mode[i] = MODE_ACCESS
    this.atNode[i] = 0
  }

  // ------------------------------------------------------------ route planning

  /**
   * Picks the best of the nearest non-full shelters in a single multi-target
   * A* pass. Sets `path` / `pathIndex` and returns the shelter index, or -1.
   */
  private planRoute(agent: Agent, fromIdx: number): number {
    const startNodeId = this.nodeIds[fromIdx]
    if (startNodeId === undefined) return -1
    // Prefer shelters with room; if the whole city is full, still head for the
    // nearest one and wait outside it rather than stopping in the street.
    let k = this.collectShelterCandidates(this.nodeX[fromIdx], this.nodeZ[fromIdx], false)
    if (k === 0) k = this.collectShelterCandidates(this.nodeX[fromIdx], this.nodeZ[fromIdx], true)
    if (k === 0) return -1

    const goals = this.goalList
    goals.length = 0
    for (let c = 0; c < k; c++) {
      const si = this.candIdx[c]
      const s = this.shelters[si]
      const capacity = s.capacity > 0 ? s.capacity : 1
      const entry = this.goalPool[c]
      entry.nodeId = this.shelterNodeIds[si]
      // §38 — a nearly full shelter looks further away than it is.
      entry.bias = 1 + 2 * clamp01(s.occupancy / capacity)
      goals.push(entry)
      this.goalShelter[c] = si
    }

    const res: PathResult | null = findPathToAny(this.graph, startNodeId, goals, this.pathCtx)
    if (res === null || res.path.length === 0) return -1

    let shelterIndex = -1
    for (let c = 0; c < k; c++) {
      if (this.goalPool[c].nodeId === res.goalNodeId) {
        shelterIndex = this.goalShelter[c]
        break
      }
    }
    if (shelterIndex < 0) return -1

    agent.path = res.path
    agent.pathIndex = 1
    return shelterIndex
  }

  /** Fills `candIdx` / `candDist` with the nearest non-full shelters. */
  private collectShelterCandidates(sx: number, sz: number, allowFull: boolean): number {
    const shelters = this.shelters
    const dist = this.candDist
    const idx = this.candIdx
    let count = 0
    for (let i = 0; i < shelters.length; i++) {
      const s = shelters[i]
      if (s.unsafe) continue
      if (!allowFull && (s.full || s.occupancy >= s.capacity)) continue
      if (this.shelterNodeIndex[i] < 0) continue
      const dx = s.source.position.x - sx
      const dz = s.source.position.z - sz
      const d = dx * dx + dz * dz
      if (!Number.isFinite(d)) continue
      let pos = count
      if (count === MAX_SHELTER_CANDIDATES) {
        if (d >= dist[MAX_SHELTER_CANDIDATES - 1]) continue
        pos = MAX_SHELTER_CANDIDATES - 1
      }
      while (pos > 0 && dist[pos - 1] > d) {
        dist[pos] = dist[pos - 1]
        idx[pos] = idx[pos - 1]
        pos--
      }
      dist[pos] = d
      idx[pos] = i
      if (count < MAX_SHELTER_CANDIDATES) count++
    }
    return count
  }

  // ---------------------------------------------------------------- rerouting

  private processRouteChecks(now: number): void {
    const agents = this.agents
    const n = agents.length
    for (let i = this.stepIndex % REROUTE_STRIDE; i < n; i += REROUTE_STRIDE) {
      const a = agents[i]
      if (a.state !== 'evacuating') continue
      const m = this.mode[i]
      if (m === MODE_STOPPED || m === MODE_WAIT) continue
      if (m === MODE_IDLE || this.needsReroute(a)) this.requestReroute(a, now)
    }
  }

  /** §37 — the edge underfoot, the next edge, or the target shelter went bad. */
  private needsReroute(agent: Agent): boolean {
    const i = agent.id
    const e = this.edgeOf[i]
    if (e >= 0) {
      const r = this.roads[e]
      if (r === undefined || r.blocked) return true
    }
    const si = agent.targetShelterIndex
    const s = si >= 0 && si < this.shelters.length ? this.shelters[si] : undefined
    if (s === undefined || s.unsafe || s.occupancy >= s.capacity) return true

    const to = this.toNode[i]
    const nextIndex = agent.pathIndex + 1
    if (to >= 0 && nextIndex < agent.path.length) {
      const nextId = agent.path[nextIndex]
      const adj = this.graph.adjacencyByIndex(to)
      for (let k = 0; k < adj.length; k++) {
        if (adj[k].to === nextId) {
          const r = this.roads[adj[k].edgeIndex]
          return r === undefined || r.blocked
        }
      }
      return true
    }
    return false
  }

  /** Stop where you are, then recompute once the pause elapses (§37). */
  private requestReroute(agent: Agent, now: number): void {
    const i = agent.id
    if (agent.rerouteCount >= MAX_REROUTES) {
      this.giveUp(agent)
      return
    }
    agent.rerouteCount++
    this.mode[i] = MODE_WAIT
    // Stagger by id so a whole street does not replan on the same step.
    agent.repathUntil = now + REPATH_PAUSE + (i % 8) * 0.25
  }

  private replan(agent: Agent, now: number): void {
    const i = agent.id
    const fromIdx = this.fromNode[i]
    if (fromIdx < 0) {
      this.giveUp(agent)
      return
    }
    const prevTo = this.toNode[i]
    const shelterIndex = this.planRoute(agent, fromIdx)
    if (shelterIndex < 0) {
      if (agent.rerouteCount >= MAX_REROUTES) {
        this.giveUp(agent)
        return
      }
      agent.rerouteCount++
      agent.repathUntil = now + INSIDE_RETRY_INTERVAL * 0.5 + (i % 8) * 0.25
      this.mode[i] = MODE_WAIT
      return
    }
    agent.targetShelterIndex = shelterIndex

    if (this.atNode[i] === 1) {
      this.advanceSegment(agent, now)
      return
    }
    // Mid-edge. If the new route continues down the same segment, keep walking;
    // otherwise turn around and walk back to the node we came from.
    const e = this.edgeOf[i]
    const road = e >= 0 ? this.roads[e] : undefined
    if (
      prevTo >= 0 &&
      agent.path.length > 1 &&
      agent.path[1] === this.nodeIds[prevTo] &&
      road !== undefined &&
      !road.blocked
    ) {
      this.toNode[i] = prevTo
      this.mode[i] = MODE_WALK
      this.setSegmentTarget(agent, fromIdx, prevTo, e)
      return
    }
    this.mode[i] = MODE_RETURN
    this.toNode[i] = -1
    this.tgtX[i] = this.nodeX[fromIdx]
    this.tgtZ[i] = this.nodeZ[fromIdx]
  }

  // ------------------------------------------------------------- path following

  private advanceSegment(agent: Agent, now: number): void {
    const i = agent.id
    const fromIdx = this.fromNode[i]
    if (fromIdx < 0) {
      this.giveUp(agent)
      return
    }
    const path = agent.path
    const hereId = this.nodeIds[fromIdx]
    // Skip entries that point at the node we are already standing on.
    while (agent.pathIndex < path.length && path[agent.pathIndex] === hereId) agent.pathIndex++
    if (agent.pathIndex >= path.length) {
      this.enterFinalApproach(agent, now)
      return
    }
    const toId = path[agent.pathIndex]
    const toIdx = this.graph.nodeIndexOf(toId)
    if (toIdx < 0) {
      this.requestReroute(agent, now)
      return
    }
    const adj = this.graph.adjacencyByIndex(fromIdx)
    let edgeIndex = -1
    for (let k = 0; k < adj.length; k++) {
      if (adj[k].to === toId) {
        edgeIndex = adj[k].edgeIndex
        break
      }
    }
    const road = edgeIndex >= 0 && edgeIndex < this.roads.length ? this.roads[edgeIndex] : undefined
    if (road === undefined || road.blocked) {
      this.requestReroute(agent, now)
      return
    }
    this.setEdge(agent, edgeIndex)
    this.toNode[i] = toIdx
    this.mode[i] = MODE_WALK
    this.atNode[i] = 0
    this.setSegmentTarget(agent, fromIdx, toIdx, edgeIndex)
  }

  /** §56 — aim at the far node pushed sideways by the agent's lane offset. */
  private setSegmentTarget(agent: Agent, fromIdx: number, toIdx: number, edgeIndex: number): void {
    const i = agent.id
    const ax = this.nodeX[fromIdx]
    const az = this.nodeZ[fromIdx]
    const bx = this.nodeX[toIdx]
    const bz = this.nodeZ[toIdx]
    const dx = bx - ax
    const dz = bz - az
    const len = Math.sqrt(dx * dx + dz * dz)
    // Degenerate (zero-length) segments have no meaningful perpendicular.
    let perpX = 0
    let perpZ = 0
    if (len > 1e-6) {
      perpX = -dz / len
      perpZ = dx / len
    }
    const road = edgeIndex >= 0 && edgeIndex < this.roads.length ? this.roads[edgeIndex] : undefined
    const width = road !== undefined && Number.isFinite(road.source.width) ? road.source.width : 6
    const maxOff = Math.max(0, width * 0.5 - KERB_MARGIN)
    let off = Number.isFinite(agent.laneOffset) ? agent.laneOffset : 0
    if (off > maxOff) off = maxOff
    else if (off < -maxOff) off = -maxOff
    this.tgtX[i] = bx + perpX * off
    this.tgtZ[i] = bz + perpZ * off
  }

  private enterFinalApproach(agent: Agent, now: number): void {
    const i = agent.id
    const s = this.shelters[agent.targetShelterIndex]
    if (s === undefined) {
      this.requestReroute(agent, now)
      return
    }
    this.setEdge(agent, -1)
    this.toNode[i] = -1
    this.atNode[i] = 0
    const sx = s.source.position.x
    const sz = s.source.position.z
    const dx = agent.x - sx
    const dz = agent.z - sz
    const d = Math.sqrt(dx * dx + dz * dz)
    if (!(d > SHELTER_ARRIVAL_RADIUS)) {
      this.tryAdmit(agent, now)
      return
    }
    const ux = dx / d
    const uz = dz / d
    let off = Number.isFinite(agent.laneOffset) ? agent.laneOffset * 0.5 : 0
    if (!Number.isFinite(off)) off = 0
    const r = SHELTER_ARRIVAL_RADIUS * 0.5
    this.tgtX[i] = sx + ux * r - uz * off
    this.tgtZ[i] = sz + uz * r + ux * off
    this.mode[i] = MODE_APPROACH
  }

  /** §38 — capacity is hard. A full shelter turns the agent away. */
  private tryAdmit(agent: Agent, now: number): void {
    const i = agent.id
    const s = this.shelters[agent.targetShelterIndex]
    if (s === undefined) {
      this.requestReroute(agent, now)
      return
    }
    if (s.unsafe) { this.requestReroute(agent, now); return }
    if (s.occupancy >= s.capacity) {
      s.full = true
      // Nowhere left in the whole city: stop here instead of rerouting between
      // full shelters until MAX_REROUTES runs out somewhere in the street.
      if (!this.anyShelterHasRoom()) {
        this.waitOutside(agent, s)
        return
      }
      this.requestReroute(agent, now)
      return
    }
    s.occupancy++
    if (s.occupancy >= s.capacity) s.full = true
    this.setEdge(agent, -1)
    agent.state = 'sheltered'
    agent.pathIndex = agent.path.length
    this.mode[i] = MODE_STOPPED
    this.toNode[i] = -1
    this.atNode[i] = 0
    this.clearPending(i)
    // Scatter inside the shelter footprint so a full shelter reads as a crowd.
    const fw = Number.isFinite(s.source.footprint.width) ? s.source.footprint.width : 20
    const fd = Number.isFinite(s.source.footprint.depth) ? s.source.footprint.depth : 20
    agent.x = s.source.position.x + this.rng.range(-0.45, 0.45) * fw
    agent.z = s.source.position.z + this.rng.range(-0.45, 0.45) * fd
    agent.px = agent.x
    agent.pz = agent.z
  }

  // ----------------------------------------------------------------- movement

  private moveAgents(dt: number, now: number): void {
    const agents = this.agents
    const n = agents.length
    const speedFactor = this.edgeSpeedFactor
    const mode = this.mode
    const edgeOf = this.edgeOf
    const tgtX = this.tgtX
    const tgtZ = this.tgtZ
    for (let i = 0; i < n; i++) {
      const a = agents[i]
      if (a.state !== 'evacuating') continue
      const m = mode[i]
      if (m === MODE_STOPPED || m === MODE_IDLE) continue
      a.px = a.x
      a.pz = a.z
      if (m === MODE_WAIT) {
        if (now >= a.repathUntil) this.replan(a, now)
        continue
      }
      let factor = 1
      const e = edgeOf[i]
      if (e >= 0) {
        const f = speedFactor[e]
        if (f > 0) factor = f
      }
      let step = a.movementSpeed * factor * dt
      if (!(step > 0)) step = 0
      const dx = tgtX[i] - a.x
      const dz = tgtZ[i] - a.z
      const d = Math.sqrt(dx * dx + dz * dz)
      if (d > step && d > 1e-5) {
        const inv = step / d
        a.x += dx * inv
        a.z += dz * inv
        a.distanceWalked += step
      } else {
        if (d > 0) a.distanceWalked += d
        a.x = tgtX[i]
        a.z = tgtZ[i]
        this.onTargetReached(a, now)
      }
    }
  }

  private onTargetReached(agent: Agent, now: number): void {
    const i = agent.id
    const m = this.mode[i]
    if (m === MODE_ACCESS) {
      this.atNode[i] = 1
      this.advanceSegment(agent, now)
      return
    }
    if (m === MODE_APPROACH) {
      this.tryAdmit(agent, now)
      return
    }
    if (m === MODE_RETURN) {
      const fromIdx = this.fromNode[i]
      if (fromIdx >= 0) agent.currentRoadNodeId = this.nodeIds[fromIdx]
      this.atNode[i] = 1
      this.toNode[i] = -1
      this.advanceSegment(agent, now)
      return
    }
    const toIdx = this.toNode[i]
    if (toIdx >= 0) {
      this.fromNode[i] = toIdx
      agent.currentRoadNodeId = this.nodeIds[toIdx]
    }
    this.toNode[i] = -1
    this.atNode[i] = 1
    agent.pathIndex++
    if (agent.pathIndex >= agent.path.length) this.enterFinalApproach(agent, now)
    else this.advanceSegment(agent, now)
  }

  // ---------------------------------------------------------------- casualties

  /** §40, §41 — occupants still inside when the building comes down. */
  onBuildingCollapse(building: BuildingRuntime, now: number): void {
    // Forked from the seed and the building id: order-independent and stable.
    const rng = new Rng(mixSeed(this.seed, hashString('collapse:' + building.id)))
    const src = building.source
    const damage = clamp01(building.damageScore)
    const vuln = CONSTRUCTION_VULNERABILITY[src.constructionType]
    const vulnFactor = Number.isFinite(vuln) && vuln > 0 ? vuln / 1.1 : 1
    const floors = Number.isFinite(src.floors) ? Math.max(1, Math.floor(src.floors)) : 1
    const floorFactor = 1 + 0.05 * Math.min(20, floors - 1)
    const severity = clamp01((damage - 0.3) / 0.7)
    const base = Math.pow(severity, 1.35) * 0.8 * vulnFactor * floorFactor
    const deadShare = 0.07 + 0.13 * damage
    const injuredShare = deadShare + 0.27

    const ids = building.agentIds
    for (let k = 0; k < ids.length; k++) {
      const agent = this.agents[ids[k]]
      if (agent === undefined || agent.state !== 'inside') continue
      let p = base * PROFILE_CASUALTY_FACTOR[agent.profile]
      if (!(p > 0)) p = 0
      if (p > 0.96) p = 0.96
      if (!rng.chance(p)) {
        // Survivors stop waiting and run for the door.
        const rush = now + rng.range(0.5, 4)
        if (agent.evacuationStartDelay > rush) agent.evacuationStartDelay = rush
        if (agent.repathUntil > rush) agent.repathUntil = rush
        continue
      }
      const roll = rng.next()
      if (roll < deadShare) {
        agent.state = 'dead'
        agent.injurySeverity = 1
      } else if (roll < injuredShare) {
        agent.state = 'injured'
        agent.injurySeverity = rng.range(0.35, 0.8)
      } else {
        // A trapped agent stays trapped; it never moves again.
        agent.state = 'trapped'
        agent.injurySeverity = rng.range(0.1, 0.6)
      }
      agent.px = agent.x
      agent.pz = agent.z
      this.mode[agent.id] = MODE_STOPPED
      this.toNode[agent.id] = -1
      this.setEdge(agent, -1)
      this.clearPending(agent.id)
      if (building.occupantsInside > 0) building.occupantsInside--
    }

    this.injureNearbyOnRoad(building, rng, damage)
  }

  /** §41 — a much smaller roll for people walking past the building. */
  private injureNearbyOnRoad(building: BuildingRuntime, rng: Rng, damage: number): void {
    const src = building.source
    const height = Number.isFinite(src.height) ? src.height : 6
    const radius = Math.max(8, height * 0.55 + 12)
    const near = this.graph.edgesNear(src.position, radius)
    if (near.length === 0) return
    const mark = this.edgeMark
    for (let k = 0; k < near.length; k++) {
      const e = near[k]
      if (e >= 0 && e < mark.length) mark[e] = 1
    }
    const p = 0.02 + 0.05 * damage
    const agents = this.agents
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i]
      if (agent.state !== 'evacuating') continue
      const e = this.edgeOf[i]
      if (e < 0 || mark[e] === 0) continue
      if (!rng.chance(p * PROFILE_CASUALTY_FACTOR[agent.profile])) continue
      agent.state = 'injured'
      agent.injurySeverity = rng.range(0.2, 0.6)
      agent.px = agent.x
      agent.pz = agent.z
      this.mode[i] = MODE_STOPPED
      this.toNode[i] = -1
      this.setEdge(agent, -1)
      this.clearPending(i)
    }
    for (let k = 0; k < near.length; k++) {
      const e = near[k]
      if (e >= 0 && e < mark.length) mark[e] = 0
    }
  }
}
