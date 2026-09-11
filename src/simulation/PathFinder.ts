/**
 * A* over the road graph.
 *
 * This is the hottest code in the simulation: every one of ~3000 agents calls
 * it once at departure and again on each reroute. So it allocates nothing per
 * search beyond the result itself:
 *
 *  - scratch arrays are module-level typed arrays sized to the graph, grown
 *    only when a bigger graph shows up;
 *  - instead of clearing them between searches, every entry carries a
 *    monotonically increasing "search stamp" and stale entries read as unset;
 *  - the priority queue is a binary min-heap over two parallel typed arrays
 *    (node index + f score) with lazy deletion, so there is no decrease-key.
 *
 * The heuristic is the straight-line distance to the goal. Every cost
 * multiplier in `edgeCost` is >= 1 and `RoadGraph` guarantees an edge is never
 * shorter than the straight line between its endpoints, so the heuristic never
 * over-estimates and A* stays optimal.
 */

import type { RoadEdge } from '../types/city'
import type { RoadRuntime } from '../types/simulation'
import type { RoadGraph } from './RoadGraph'
import {
  CONGESTION_COST_WEIGHT,
  DEBRIS_COST_WEIGHT,
  NARROW_ROAD_PENALTY,
  NARROW_ROAD_REFERENCE_WIDTH,
} from './constants'

export interface PathCostContext {
  /** Indexed identically to `RoadGraph.edges`. */
  roads: RoadRuntime[]
}

export interface PathResult {
  /** Node ids, `[start, ..., goal]`; length >= 1. */
  path: string[]
  goalNodeId: string
  /**
   * Accumulated traversal cost in metres-equivalent — the *raw* cost, with no
   * goal bias folded in, so it is comparable across calls.
   */
  cost: number
  /**
   * Convenience extra: the edge indices walked, `path.length - 1` of them,
   * parallel to the steps of `path`. Optional so nothing else has to fill it.
   */
  edgeIndices?: number[]
}

/** Stamp counters live in Int32Arrays; recycle well before they overflow. */
const STAMP_LIMIT = 2147483000
const MIN_SCRATCH = 64

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------

/** `NaN`-safe clamp into [0, 1]; anything non-positive or NaN becomes 0. */
function clamp01(value: number): number {
  return value > 0 ? (value < 1 ? value : 1) : 0
}

function baseLengthOf(edge: RoadEdge): number {
  const length = edge.length
  return Number.isFinite(length) && length > 0 ? length : 0
}

/** Narrow streets are slower to funnel a crowd through; >= 1 always. */
function narrowMultiplierOf(edge: RoadEdge): number {
  const raw = edge.width
  const width = Number.isFinite(raw) && raw > 0 ? raw : NARROW_ROAD_REFERENCE_WIDTH
  return 1 + NARROW_ROAD_PENALTY * clamp01(1 - width / NARROW_ROAD_REFERENCE_WIDTH)
}

/** Traversal cost of one edge, metres-equivalent. `Infinity` when impassable. */
export function edgeCost(edge: RoadEdge, road: RoadRuntime): number {
  if (road && road.blocked) return Infinity
  const base = baseLengthOf(edge)
  if (base === 0) return 0
  let cost = base * narrowMultiplierOf(edge)
  if (road) {
    cost *= 1 + CONGESTION_COST_WEIGHT * clamp01(road.congestion)
    cost *= 1 + DEBRIS_COST_WEIGHT * clamp01(road.debrisLevel)
  }
  return Number.isFinite(cost) ? cost : Infinity
}

function costOfEdgeIndex(graph: RoadGraph, edgeIndex: number, ctx: PathCostContext): number {
  const edge = graph.edges[edgeIndex]
  if (!edge) return Infinity
  const roads = ctx.roads
  const road = roads ? roads[edgeIndex] : undefined
  // No runtime record (e.g. a pre-disaster query): treat the road as clean.
  if (!road) return baseLengthOf(edge) * narrowMultiplierOf(edge)
  return edgeCost(edge, road)
}

// ---------------------------------------------------------------------------
// Per-node scratch, reused across every search
// ---------------------------------------------------------------------------

let scratchNodes = 0
let gScore = new Float64Array(0)
let cameFromNode = new Int32Array(0)
let cameFromEdge = new Int32Array(0)
let visitStamp = new Int32Array(0)
let closedStamp = new Int32Array(0)
/** Marks a node as one of this search's goals. */
let goalStamp = new Int32Array(0)
/** For a marked node, which entry of the goal arrays it belongs to. */
let goalSlot = new Int32Array(0)
let searchStamp = 0

function ensureNodeScratch(count: number): void {
  if (count <= scratchNodes) return
  const size = Math.max(count, scratchNodes * 2, MIN_SCRATCH)
  // Fresh arrays are zero-filled and stamps are always >= 1, so every entry
  // correctly reads as "not visited by the current search".
  gScore = new Float64Array(size)
  cameFromNode = new Int32Array(size)
  cameFromEdge = new Int32Array(size)
  visitStamp = new Int32Array(size)
  closedStamp = new Int32Array(size)
  goalStamp = new Int32Array(size)
  goalSlot = new Int32Array(size)
  scratchNodes = size
}

function nextSearchStamp(): number {
  if (searchStamp >= STAMP_LIMIT) {
    visitStamp.fill(0)
    closedStamp.fill(0)
    goalStamp.fill(0)
    searchStamp = 0
  }
  searchStamp++
  return searchStamp
}

// ---------------------------------------------------------------------------
// Goal scratch
// ---------------------------------------------------------------------------

let goalCapacity = 0
let goalNodeIndex = new Int32Array(0)
let goalBias = new Float64Array(0)
let goalX = new Float64Array(0)
let goalZ = new Float64Array(0)

function ensureGoalScratch(count: number): void {
  if (count <= goalCapacity) return
  const size = Math.max(count, goalCapacity * 2, 8)
  goalNodeIndex = new Int32Array(size)
  goalBias = new Float64Array(size)
  goalX = new Float64Array(size)
  goalZ = new Float64Array(size)
  goalCapacity = size
}

// ---------------------------------------------------------------------------
// Binary min-heap over parallel arrays (node index, f score)
// ---------------------------------------------------------------------------

let heapNode = new Int32Array(0)
let heapF = new Float64Array(0)
let heapSize = 0

function heapReset(minCapacity: number): void {
  if (heapNode.length < minCapacity) {
    const size = Math.max(minCapacity, heapNode.length * 2, MIN_SCRATCH)
    heapNode = new Int32Array(size)
    heapF = new Float64Array(size)
  }
  heapSize = 0
}

function heapGrow(): void {
  const size = Math.max(MIN_SCRATCH, heapNode.length * 2)
  const nextNode = new Int32Array(size)
  nextNode.set(heapNode)
  heapNode = nextNode
  const nextF = new Float64Array(size)
  nextF.set(heapF)
  heapF = nextF
}

function heapSwap(i: number, j: number): void {
  const node = heapNode[i]
  const f = heapF[i]
  heapNode[i] = heapNode[j]
  heapF[i] = heapF[j]
  heapNode[j] = node
  heapF[j] = f
}

function heapPush(node: number, f: number): void {
  if (heapSize >= heapNode.length) heapGrow()
  let i = heapSize
  heapSize++
  heapNode[i] = node
  heapF[i] = f
  while (i > 0) {
    const parent = (i - 1) >> 1
    if (heapF[parent] <= heapF[i]) break
    heapSwap(i, parent)
    i = parent
  }
}

/** Removes and returns the lowest-f node index, or -1 when the heap is empty. */
function heapPop(): number {
  if (heapSize <= 0) return -1
  const top = heapNode[0]
  heapSize--
  if (heapSize > 0) {
    heapNode[0] = heapNode[heapSize]
    heapF[0] = heapF[heapSize]
    let i = 0
    for (;;) {
      const left = 2 * i + 1
      if (left >= heapSize) break
      const right = left + 1
      let smallest = left
      if (right < heapSize && heapF[right] < heapF[left]) smallest = right
      if (heapF[i] <= heapF[smallest]) break
      heapSwap(i, smallest)
      i = smallest
    }
  }
  return top
}

// ---------------------------------------------------------------------------
// The search itself
// ---------------------------------------------------------------------------

/** Node index the last search settled on, and its raw (unbiased) g-cost. */
let resultGoalNode = -1
let resultCost = 0

/**
 * h(n) = distance from n to the *nearest* goal, over the full goal set.
 *
 * Taking the minimum over a fixed set keeps the heuristic consistent (each
 * per-goal straight-line distance is consistent, and the pointwise minimum of
 * consistent heuristics is consistent), and it is exactly 0 at every goal —
 * which is what lets the bias logic below compare g-costs safely.
 */
function heuristicAt(graph: RoadGraph, nodeIndex: number, goalCount: number): number {
  const nx = graph.nodeX[nodeIndex]
  const nz = graph.nodeZ[nodeIndex]
  let best = 0
  for (let k = 0; k < goalCount; k++) {
    const dx = nx - goalX[k]
    const dz = nz - goalZ[k]
    const d = Math.sqrt(dx * dx + dz * dz)
    if (k === 0 || d < best) best = d
  }
  return Number.isFinite(best) ? best : 0
}

/** Smallest bias among goals this search has not popped yet; 1 if none left. */
function minRemainingBias(goalCount: number, stamp: number, nodeCount: number): number {
  let best = Infinity
  for (let k = 0; k < goalCount; k++) {
    const gi = goalNodeIndex[k]
    if (gi < 0 || gi >= nodeCount) continue
    // Only the slot that actually owns the node counts (duplicates deduped).
    if (goalStamp[gi] !== stamp || goalSlot[gi] !== k) continue
    if (goalBias[k] < best) best = goalBias[k]
  }
  return best === Infinity ? 1 : best
}

/**
 * MULTI-GOAL BIAS HANDLING
 * ------------------------
 * A single A* pass finds the cheapest goal by *raw* cost, but the caller wants
 * the cheapest by `g * bias` (a nearly full shelter is made to look farther
 * away than it is). Folding the bias into the frontier would break
 * admissibility, so instead:
 *
 *   1. The heuristic ignores bias entirely, so f-values pop in non-decreasing
 *      order and every goal is popped with its true optimal g (h is 0 there).
 *   2. Each time a goal is popped we score it `g * bias` and keep the best.
 *   3. We keep searching. Any goal still unpopped will be popped later with
 *      `g >= fMin`, the current frontier minimum, so its biased score is at
 *      least `fMin * minRemainingBias`. Once that lower bound exceeds the best
 *      biased score found so far, no remaining goal can win and we stop.
 *
 * With shelter biases of `1 + 2 * occupancy / capacity` (always >= 1) this
 * usually stops on the very first goal popped; the bound is written in terms
 * of `minRemainingBias` so it stays correct for any positive bias.
 *
 * Returns true when a goal was reached. `resultGoalNode` / `resultCost` hold
 * the answer.
 */
function runSearch(
  graph: RoadGraph,
  startIndex: number,
  goalCount: number,
  ctx: PathCostContext,
): boolean {
  resultGoalNode = -1
  resultCost = 0

  const nodeCount = graph.nodes.length
  if (nodeCount === 0 || startIndex < 0 || startIndex >= nodeCount || goalCount <= 0) return false

  ensureNodeScratch(nodeCount)
  const stamp = nextSearchStamp()
  heapReset(nodeCount + MIN_SCRATCH)

  // Register goals, collapsing duplicate node indices onto their best bias.
  let distinctGoals = 0
  for (let k = 0; k < goalCount; k++) {
    const gi = goalNodeIndex[k]
    if (gi < 0 || gi >= nodeCount) continue
    if (goalStamp[gi] === stamp) {
      if (goalBias[k] < goalBias[goalSlot[gi]]) goalSlot[gi] = k
      continue
    }
    goalStamp[gi] = stamp
    goalSlot[gi] = k
    distinctGoals++
  }
  if (distinctGoals === 0) return false

  gScore[startIndex] = 0
  visitStamp[startIndex] = stamp
  cameFromNode[startIndex] = -1
  cameFromEdge[startIndex] = -1
  heapPush(startIndex, heuristicAt(graph, startIndex, goalCount))

  const adjStart = graph.adjStart
  const adjNode = graph.adjNode
  const adjEdge = graph.adjEdge

  // Two safety valves, neither of which a well-formed graph can trip: at most
  // one expansion per node, and at most one heap entry per directed arc plus
  // the start. If either is somehow exceeded we stop and hand back whatever
  // goal we had already reached (null when that is none).
  const maxExpansions = Math.max(MIN_SCRATCH, nodeCount * 4)
  const maxPops = graph.adjNode.length + 8
  let expansions = 0
  let pops = 0
  let remaining = distinctGoals
  let remainingBias = minRemainingBias(goalCount, stamp, nodeCount)
  let bestBiased = Infinity

  while (heapSize > 0) {
    if (resultGoalNode >= 0 && heapF[0] * remainingBias > bestBiased) break

    const node = heapPop()
    if (node < 0) break
    pops++
    if (pops > maxPops) break
    if (closedStamp[node] === stamp) continue
    closedStamp[node] = stamp
    expansions++
    if (expansions > maxExpansions) break

    if (goalStamp[node] === stamp) {
      const slot = goalSlot[node]
      const g = gScore[node]
      const biased = g * goalBias[slot]
      if (biased < bestBiased) {
        bestBiased = biased
        resultGoalNode = node
        resultCost = g
      }
      goalStamp[node] = 0
      remaining--
      if (remaining <= 0) break
      remainingBias = minRemainingBias(goalCount, stamp, nodeCount)
    }

    const gNode = gScore[node]
    const end = adjStart[node + 1]
    for (let i = adjStart[node]; i < end; i++) {
      const next = adjNode[i]
      if (next < 0 || next >= nodeCount) continue
      if (closedStamp[next] === stamp) continue
      const edgeIndex = adjEdge[i]
      const step = costOfEdgeIndex(graph, edgeIndex, ctx)
      // Rejects Infinity (blocked) and NaN in one test.
      if (!(step < Infinity)) continue
      const tentative = gNode + step
      if (visitStamp[next] === stamp && tentative >= gScore[next]) continue
      visitStamp[next] = stamp
      gScore[next] = tentative
      cameFromNode[next] = node
      cameFromEdge[next] = edgeIndex
      heapPush(next, tentative + heuristicAt(graph, next, goalCount))
    }
  }

  return resultGoalNode >= 0
}

/** Walks `cameFrom*` back from the settled goal to the start. */
function buildResult(graph: RoadGraph, startIndex: number): PathResult | null {
  const goalIndex = resultGoalNode
  if (goalIndex < 0) return null

  const limit = graph.nodes.length + 1
  const path: string[] = []
  const edgeIndices: number[] = []
  let current = goalIndex
  let steps = 0

  while (steps <= limit) {
    const node = graph.nodes[current]
    if (!node) return null
    path.push(node.id)
    if (current === startIndex) break
    const edgeIndex = cameFromEdge[current]
    if (edgeIndex >= 0) edgeIndices.push(edgeIndex)
    const previous = cameFromNode[current]
    if (previous < 0) return null
    current = previous
    steps++
  }
  if (current !== startIndex) return null

  path.reverse()
  edgeIndices.reverse()
  const goalNode = graph.nodes[goalIndex]
  if (!goalNode) return null
  const cost = Number.isFinite(resultCost) ? resultCost : 0
  return { path, goalNodeId: goalNode.id, cost, edgeIndices }
}

function trivialResult(graph: RoadGraph, nodeIndex: number): PathResult {
  const id = graph.nodeIdAt(nodeIndex)
  return { path: [id], goalNodeId: id, cost: 0, edgeIndices: [] }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Single-target A*. Returns null when the goal is unreachable. */
export function findPath(
  graph: RoadGraph,
  startNodeId: string,
  goalNodeId: string,
  ctx: PathCostContext,
): PathResult | null {
  const startIndex = graph.nodeIndexOf(startNodeId)
  const goalIndex = graph.nodeIndexOf(goalNodeId)
  if (startIndex < 0 || goalIndex < 0) return null
  if (startIndex === goalIndex) return trivialResult(graph, startIndex)

  ensureGoalScratch(1)
  goalNodeIndex[0] = goalIndex
  goalBias[0] = 1
  goalX[0] = graph.nodeX[goalIndex]
  goalZ[0] = graph.nodeZ[goalIndex]

  if (!runSearch(graph, startIndex, 1, ctx)) return null
  return buildResult(graph, startIndex)
}

/**
 * Multi-target A*: searches for the cheapest of several goals in one pass.
 * `bias` multiplies the accumulated cost when comparing candidates (a nearly
 * full shelter gets a bias > 1). Returns null when none are reachable.
 *
 * See the comment block on `runSearch` for how the bias is applied without
 * breaking the heuristic.
 */
export function findPathToAny(
  graph: RoadGraph,
  startNodeId: string,
  goals: { nodeId: string; bias: number }[],
  ctx: PathCostContext,
): PathResult | null {
  const startIndex = graph.nodeIndexOf(startNodeId)
  if (startIndex < 0) return null
  if (!Array.isArray(goals) || goals.length === 0) return null

  ensureGoalScratch(goals.length)
  let count = 0
  for (let i = 0; i < goals.length; i++) {
    const goal = goals[i]
    if (!goal) continue
    const goalIndex = graph.nodeIndexOf(goal.nodeId)
    if (goalIndex < 0) continue
    // Standing on a goal costs 0, which no positive bias can beat.
    if (goalIndex === startIndex) return trivialResult(graph, startIndex)
    const rawBias = goal.bias
    goalNodeIndex[count] = goalIndex
    goalBias[count] = Number.isFinite(rawBias) && rawBias > 0 ? rawBias : 1
    goalX[count] = graph.nodeX[goalIndex]
    goalZ[count] = graph.nodeZ[goalIndex]
    count++
  }
  if (count === 0) return null

  if (!runSearch(graph, startIndex, count, ctx)) return null
  return buildResult(graph, startIndex)
}
