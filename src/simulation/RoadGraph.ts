/**
 * Road network graph.
 *
 * Owns the three things the rest of the simulation needs in order to be fast:
 *
 *  1. `id -> index` maps for nodes and edges. Indices are the *source order* of
 *     `city.roadNetwork`, so `edges[i]` always lines up with `RoadRuntime[i]`.
 *     Edges that reference unknown nodes are kept in `edges` (to preserve that
 *     alignment) but are simply never traversable.
 *  2. An adjacency list holding both directions of every undirected edge,
 *     mirrored into a CSR triple (`adjStart` / `adjNode` / `adjEdge`) that the
 *     A* inner loop walks without touching a single hash map.
 *  3. Two uniform spatial grids sharing the same origin and cell size (~ the
 *     mean edge length): one bucketing nodes for `nearestNode`, one bucketing
 *     every edge segment into each cell it passes through for `edgesNear`.
 *
 * Every lookup is total: unknown ids yield `-1` / `{x: 0, z: 0}` / `[]` /
 * `null` instead of throwing, and no method can return `NaN`.
 */

import type { CityModel, RoadEdge, RoadNode, Vec2 } from '../types/city'

export interface GraphEdgeRef {
  /** Index into `RoadGraph.edges` AND into the parallel `RoadRuntime[]`. */
  edgeIndex: number
  edgeId: string
  /** Neighbour node id. */
  to: string
  /** Segment length, metres. */
  length: number
}

/** Shared immutable answer for "this node has no neighbours". */
const EMPTY_REFS: GraphEdgeRef[] = []
/** Shared immutable answer for "nothing found". Never mutated. */
const EMPTY_INDICES: number[] = []

/** Hard ceilings so a degenerate city can never allocate an absurd grid. */
const MAX_GRID_DIM = 1000
const MIN_CELL_SIZE = 2
const MAX_CELL_SIZE = 4000
const FALLBACK_CELL_SIZE = 30

/** Stamp counters live in an Int32Array; recycle well before it overflows. */
const STAMP_LIMIT = 2147483000

/** Separator for the "node pair -> edge" key. Node ids never contain it. */
const PAIR_SEPARATOR = '->'

function safeNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/** Clamp a (possibly NaN or infinite) grid coordinate into `[0, hi]`. */
function clampIndex(value: number, hi: number): number {
  if (!(value >= 0)) return 0
  if (value > hi) return hi
  return value | 0
}

/** Distance from `v` to the closed interval `[lo, hi]`; 0 when inside. */
function distanceToInterval(v: number, lo: number, hi: number): number {
  if (v < lo) return lo - v
  if (v > hi) return v - hi
  return 0
}

/** Squared distance from a point to the segment a->b, all on the XZ plane. */
function pointSegmentDistanceSq(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const vx = bx - ax
  const vz = bz - az
  const wx = px - ax
  const wz = pz - az
  const vv = vx * vx + vz * vz
  let t = 0
  if (vv > 1e-9) {
    t = (wx * vx + wz * vz) / vv
    t = t < 0 ? 0 : t > 1 ? 1 : t
  }
  const dx = wx - t * vx
  const dz = wz - t * vz
  return dx * dx + dz * dz
}

export class RoadGraph {
  readonly nodes: RoadNode[]
  readonly edges: RoadEdge[]

  /** Node world positions, parallel to `nodes`. Always finite. */
  readonly nodeX: Float64Array
  readonly nodeZ: Float64Array
  /** Guarded segment lengths, parallel to `edges`. Always finite and >= 0. */
  readonly edgeLength: Float64Array

  /**
   * CSR adjacency for hot loops (A*): the neighbours of node `i` occupy
   * `adjStart[i] .. adjStart[i + 1]` in `adjNode` (neighbour node index) and
   * `adjEdge` (edge index). Same content as `adjacencyByIndex`, no allocation.
   */
  readonly adjStart: Int32Array
  readonly adjNode: Int32Array
  readonly adjEdge: Int32Array

  private readonly nodeIdToIndex: Map<string, number>
  private readonly edgeIdToIndex: Map<string, number>
  private readonly pairToEdgeIndex: Map<string, number>
  private readonly adjRefs: GraphEdgeRef[][]

  /** Endpoint node indices per edge; -1 when the edge dangles. */
  private readonly edgeNodeA: Int32Array
  private readonly edgeNodeB: Int32Array

  private readonly cellSize: number
  private readonly gridMinX: number
  private readonly gridMinZ: number
  private readonly gridCols: number
  private readonly gridRows: number

  private readonly nodeCellStart: Int32Array
  private readonly nodeCellItems: Int32Array
  private readonly edgeCellStart: Int32Array
  private readonly edgeCellItems: Int32Array

  /** Dedupe scratch for `edgesNear`, keyed by edge index. */
  private readonly edgeMark: Int32Array
  private edgeQueryStamp: number

  constructor(city: CityModel) {
    const network = city.roadNetwork
    const sourceNodes = Array.isArray(network.nodes) ? network.nodes : []
    const sourceEdges = Array.isArray(network.edges) ? network.edges : []
    this.nodes = sourceNodes.slice()
    this.edges = sourceEdges.slice()

    const nodeCount = this.nodes.length
    const edgeCount = this.edges.length

    // ---- nodes ------------------------------------------------------------
    this.nodeX = new Float64Array(nodeCount)
    this.nodeZ = new Float64Array(nodeCount)
    this.nodeIdToIndex = new Map()
    for (let i = 0; i < nodeCount; i++) {
      const node = this.nodes[i]
      if (!node) continue
      const pos = node.position
      this.nodeX[i] = pos ? safeNumber(pos.x, 0) : 0
      this.nodeZ[i] = pos ? safeNumber(pos.z, 0) : 0
      // First id wins, so duplicated ids degrade gracefully instead of aliasing.
      if (!this.nodeIdToIndex.has(node.id)) this.nodeIdToIndex.set(node.id, i)
    }

    // ---- edges ------------------------------------------------------------
    this.edgeLength = new Float64Array(edgeCount)
    this.edgeNodeA = new Int32Array(edgeCount)
    this.edgeNodeB = new Int32Array(edgeCount)
    this.edgeIdToIndex = new Map()
    this.pairToEdgeIndex = new Map()
    const degree = new Int32Array(nodeCount)
    let lengthSum = 0
    let lengthCount = 0

    for (let i = 0; i < edgeCount; i++) {
      this.edgeNodeA[i] = -1
      this.edgeNodeB[i] = -1
      const edge = this.edges[i]
      if (!edge) continue
      if (!this.edgeIdToIndex.has(edge.id)) this.edgeIdToIndex.set(edge.id, i)

      const a = this.nodeIdToIndex.get(edge.from)
      const b = this.nodeIdToIndex.get(edge.to)
      if (a === undefined || b === undefined) continue

      this.edgeNodeA[i] = a
      this.edgeNodeB[i] = b

      const dx = this.nodeX[a] - this.nodeX[b]
      const dz = this.nodeZ[a] - this.nodeZ[b]
      const geometric = Math.sqrt(dx * dx + dz * dz)
      const declared = safeNumber(edge.length, geometric)
      // The straight-line distance is the floor: A*'s heuristic relies on it.
      const length = Math.max(declared > 0 ? declared : 0, geometric)
      this.edgeLength[i] = Number.isFinite(length) ? length : 0
      lengthSum += this.edgeLength[i]
      lengthCount++

      degree[a]++
      degree[b]++

      const idA = this.nodes[a].id
      const idB = this.nodes[b].id
      const keyAB = idA + PAIR_SEPARATOR + idB
      const keyBA = idB + PAIR_SEPARATOR + idA
      if (!this.pairToEdgeIndex.has(keyAB)) this.pairToEdgeIndex.set(keyAB, i)
      if (!this.pairToEdgeIndex.has(keyBA)) this.pairToEdgeIndex.set(keyBA, i)
    }

    // ---- adjacency (object list + CSR mirror) -----------------------------
    this.adjStart = new Int32Array(nodeCount + 1)
    for (let i = 0; i < nodeCount; i++) this.adjStart[i + 1] = this.adjStart[i] + degree[i]
    const adjTotal = nodeCount > 0 ? this.adjStart[nodeCount] : 0
    this.adjNode = new Int32Array(adjTotal)
    this.adjEdge = new Int32Array(adjTotal)
    this.adjRefs = new Array(nodeCount)
    for (let i = 0; i < nodeCount; i++) this.adjRefs[i] = []

    const cursor = this.adjStart.slice(0, nodeCount)
    for (let i = 0; i < edgeCount; i++) {
      const a = this.edgeNodeA[i]
      const b = this.edgeNodeB[i]
      if (a < 0 || b < 0) continue
      const edge = this.edges[i]
      const length = this.edgeLength[i]

      this.adjNode[cursor[a]] = b
      this.adjEdge[cursor[a]] = i
      cursor[a]++
      this.adjRefs[a].push({ edgeIndex: i, edgeId: edge.id, to: this.nodes[b].id, length })

      this.adjNode[cursor[b]] = a
      this.adjEdge[cursor[b]] = i
      cursor[b]++
      this.adjRefs[b].push({ edgeIndex: i, edgeId: edge.id, to: this.nodes[a].id, length })
    }

    // ---- grid geometry ----------------------------------------------------
    let minX = 0
    let maxX = 0
    let minZ = 0
    let maxZ = 0
    if (nodeCount > 0) {
      minX = maxX = this.nodeX[0]
      minZ = maxZ = this.nodeZ[0]
      for (let i = 1; i < nodeCount; i++) {
        const x = this.nodeX[i]
        const z = this.nodeZ[i]
        if (x < minX) minX = x
        else if (x > maxX) maxX = x
        if (z < minZ) minZ = z
        else if (z > maxZ) maxZ = z
      }
    }
    const spanX = Math.max(0, maxX - minX)
    const spanZ = Math.max(0, maxZ - minZ)

    let cell = lengthCount > 0 ? lengthSum / lengthCount : FALLBACK_CELL_SIZE
    if (!Number.isFinite(cell) || cell <= 0) cell = FALLBACK_CELL_SIZE
    cell = Math.min(MAX_CELL_SIZE, Math.max(MIN_CELL_SIZE, cell))

    let cols = Math.max(1, Math.floor(spanX / cell) + 1)
    let rows = Math.max(1, Math.floor(spanZ / cell) + 1)
    if (cols > MAX_GRID_DIM || rows > MAX_GRID_DIM) {
      cols = Math.min(cols, MAX_GRID_DIM)
      rows = Math.min(rows, MAX_GRID_DIM)
      // Widen the cell so the clamped grid still spans the whole city.
      cell = Math.max(cell, (spanX + 1) / cols, (spanZ + 1) / rows)
      cols = Math.max(1, Math.min(MAX_GRID_DIM, Math.floor(spanX / cell) + 1))
      rows = Math.max(1, Math.min(MAX_GRID_DIM, Math.floor(spanZ / cell) + 1))
    }

    this.cellSize = cell
    this.gridMinX = minX
    this.gridMinZ = minZ
    this.gridCols = cols
    this.gridRows = rows
    const cellCount = cols * rows

    // ---- node buckets (CSR) -----------------------------------------------
    this.nodeCellStart = new Int32Array(cellCount + 1)
    const nodeCellOf = new Int32Array(nodeCount)
    for (let i = 0; i < nodeCount; i++) {
      const c = this.cellOf(this.nodeX[i], this.nodeZ[i])
      nodeCellOf[i] = c
      this.nodeCellStart[c + 1]++
    }
    for (let c = 0; c < cellCount; c++) this.nodeCellStart[c + 1] += this.nodeCellStart[c]
    this.nodeCellItems = new Int32Array(nodeCount)
    const nodeCursor = this.nodeCellStart.slice(0, cellCount)
    for (let i = 0; i < nodeCount; i++) {
      const c = nodeCellOf[i]
      this.nodeCellItems[nodeCursor[c]] = i
      nodeCursor[c]++
    }

    // ---- edge buckets (CSR) -----------------------------------------------
    // Each segment is sampled at quarter-cell spacing; the 3x3 neighbourhood of
    // every sample is a strict superset of the cells the segment touches (two
    // consecutive samples are less than one cell apart), and the
    // centre-to-segment test below prunes that superset back to a tight set.
    const halfDiagonal = cell * Math.SQRT1_2 + 1e-6
    const halfDiagonalSq = halfDiagonal * halfDiagonal
    const cellStamp = new Int32Array(cellCount)
    const pairEdge: number[] = []
    const pairCell: number[] = []
    let buildStamp = 0

    for (let i = 0; i < edgeCount; i++) {
      const a = this.edgeNodeA[i]
      const b = this.edgeNodeB[i]
      if (a < 0 || b < 0) continue
      const ax = this.nodeX[a]
      const az = this.nodeZ[a]
      const bx = this.nodeX[b]
      const bz = this.nodeZ[b]
      buildStamp++

      const steps = Math.max(1, Math.min(8192, Math.ceil(this.edgeLength[i] / (cell * 0.25))))
      for (let s = 0; s <= steps; s++) {
        const t = s / steps
        const sx = ax + (bx - ax) * t
        const sz = az + (bz - az) * t
        const sampleCol = clampIndex(Math.floor((sx - minX) / cell), cols - 1)
        const sampleRow = clampIndex(Math.floor((sz - minZ) / cell), rows - 1)
        for (let r = sampleRow - 1; r <= sampleRow + 1; r++) {
          if (r < 0 || r >= rows) continue
          for (let c = sampleCol - 1; c <= sampleCol + 1; c++) {
            if (c < 0 || c >= cols) continue
            const cellIndex = r * cols + c
            if (cellStamp[cellIndex] === buildStamp) continue
            cellStamp[cellIndex] = buildStamp
            const centreX = minX + (c + 0.5) * cell
            const centreZ = minZ + (r + 0.5) * cell
            if (pointSegmentDistanceSq(centreX, centreZ, ax, az, bx, bz) > halfDiagonalSq) continue
            pairEdge.push(i)
            pairCell.push(cellIndex)
          }
        }
      }
    }

    this.edgeCellStart = new Int32Array(cellCount + 1)
    for (let k = 0; k < pairCell.length; k++) this.edgeCellStart[pairCell[k] + 1]++
    for (let c = 0; c < cellCount; c++) this.edgeCellStart[c + 1] += this.edgeCellStart[c]
    this.edgeCellItems = new Int32Array(pairEdge.length)
    const edgeCursor = this.edgeCellStart.slice(0, cellCount)
    for (let k = 0; k < pairEdge.length; k++) {
      const c = pairCell[k]
      this.edgeCellItems[edgeCursor[c]] = pairEdge[k]
      edgeCursor[c]++
    }

    this.edgeMark = new Int32Array(edgeCount)
    this.edgeQueryStamp = 0
  }

  // ------------------------------------------------------------------------
  // Identity lookups
  // ------------------------------------------------------------------------

  nodeIndexOf(nodeId: string): number {
    const index = this.nodeIdToIndex.get(nodeId)
    return index === undefined ? -1 : index
  }

  edgeIndexOf(edgeId: string): number {
    const index = this.edgeIdToIndex.get(edgeId)
    return index === undefined ? -1 : index
  }

  /** Node id at an index, or `''` when the index is out of range. */
  nodeIdAt(nodeIndex: number): string {
    const node = this.nodes[nodeIndex]
    return node ? node.id : ''
  }

  position(nodeId: string): Vec2 {
    return this.positionByIndex(this.nodeIndexOf(nodeId))
  }

  /** Fresh `{x, z}`, so callers may keep or mutate the result freely. */
  positionByIndex(nodeIndex: number): Vec2 {
    if (nodeIndex < 0 || nodeIndex >= this.nodes.length) return { x: 0, z: 0 }
    return { x: this.nodeX[nodeIndex], z: this.nodeZ[nodeIndex] }
  }

  /**
   * Neighbours of a node. The returned array is the graph's own storage:
   * read it, do not mutate it.
   */
  adjacency(nodeId: string): GraphEdgeRef[] {
    return this.adjacencyByIndex(this.nodeIndexOf(nodeId))
  }

  adjacencyByIndex(nodeIndex: number): GraphEdgeRef[] {
    if (nodeIndex < 0 || nodeIndex >= this.adjRefs.length) return EMPTY_REFS
    return this.adjRefs[nodeIndex]
  }

  edgeBetween(a: string, b: string): RoadEdge | null {
    const index = this.pairToEdgeIndex.get(a + PAIR_SEPARATOR + b)
    if (index === undefined) return null
    const edge = this.edges[index]
    return edge ? edge : null
  }

  /** Index of the edge joining two node ids, or -1. */
  edgeIndexBetween(a: string, b: string): number {
    const index = this.pairToEdgeIndex.get(a + PAIR_SEPARATOR + b)
    return index === undefined ? -1 : index
  }

  /**
   * Straight-line distance between two nodes, metres.
   * `Infinity` when either id is unknown, so callers ranking by distance
   * naturally sort unknown nodes last.
   */
  distance(a: string, b: string): number {
    return this.distanceByIndex(this.nodeIndexOf(a), this.nodeIndexOf(b))
  }

  distanceByIndex(a: number, b: number): number {
    const count = this.nodes.length
    if (a < 0 || b < 0 || a >= count || b >= count) return Infinity
    const dx = this.nodeX[a] - this.nodeX[b]
    const dz = this.nodeZ[a] - this.nodeZ[b]
    return Math.sqrt(dx * dx + dz * dz)
  }

  // ------------------------------------------------------------------------
  // Spatial queries
  // ------------------------------------------------------------------------

  nearestNode(p: Vec2): string {
    return this.nodeIdAt(this.nearestNodeIndex(p))
  }

  /**
   * Nearest node by straight-line distance, via an expanding ring search over
   * the node grid. Once a candidate is found we keep expanding until the
   * closest point the next ring could possibly contain is provably farther
   * away than that candidate (which is at least one extra ring).
   */
  nearestNodeIndex(p: Vec2): number {
    const nodeCount = this.nodes.length
    if (nodeCount === 0) return -1

    const px = p ? safeNumber(p.x, 0) : 0
    const pz = p ? safeNumber(p.z, 0) : 0
    const cell = this.cellSize
    const cols = this.gridCols
    const rows = this.gridRows

    const cx = clampIndex(Math.floor((px - this.gridMinX) / cell), cols - 1)
    const cz = clampIndex(Math.floor((pz - this.gridMinZ) / cell), rows - 1)

    // How far outside its (clamped) home cell the query point sits. Ring
    // bounds are measured from that cell, so this slackens them for points
    // that fall outside the grid entirely.
    const homeMinX = this.gridMinX + cx * cell
    const homeMinZ = this.gridMinZ + cz * cell
    const outside = Math.max(
      distanceToInterval(px, homeMinX, homeMinX + cell),
      distanceToInterval(pz, homeMinZ, homeMinZ + cell),
    )

    let best = -1
    let bestDistSq = Infinity

    const scanCell = (r: number, c: number): void => {
      const cellIndex = r * cols + c
      const start = this.nodeCellStart[cellIndex]
      const end = this.nodeCellStart[cellIndex + 1]
      for (let k = start; k < end; k++) {
        const i = this.nodeCellItems[k]
        const dx = this.nodeX[i] - px
        const dz = this.nodeZ[i] - pz
        const d2 = dx * dx + dz * dz
        if (d2 < bestDistSq) {
          bestDistSq = d2
          best = i
        }
      }
    }

    const maxRing = Math.max(cols, rows)
    for (let ring = 0; ring <= maxRing; ring++) {
      if (best >= 0) {
        const lower = (ring - 1) * cell - outside
        if (lower > 0 && lower * lower > bestDistSq) break
      }
      const rowLo = cz - ring
      const rowHi = cz + ring
      const colLo = cx - ring
      const colHi = cx + ring
      for (let r = rowLo; r <= rowHi; r++) {
        if (r < 0 || r >= rows) continue
        if (r === rowLo || r === rowHi) {
          for (let c = colLo; c <= colHi; c++) {
            if (c < 0 || c >= cols) continue
            scanCell(r, c)
          }
        } else {
          if (colLo >= 0 && colLo < cols) scanCell(r, colLo)
          if (colHi !== colLo && colHi >= 0 && colHi < cols) scanCell(r, colHi)
        }
      }
    }

    // Every node lives in some cell and the loop visits every cell, so `best`
    // is only ever -1 for an empty graph, which was handled above.
    return best >= 0 ? best : 0
  }

  /**
   * Indices of every edge whose *segment* comes within `radius` of `p`.
   * Backed by the edge grid, so the cost scales with the queried area rather
   * than with the size of the network.
   */
  edgesNear(p: Vec2, radius: number): number[] {
    if (!p) return EMPTY_INDICES
    const px = safeNumber(p.x, Number.NaN)
    const pz = safeNumber(p.z, Number.NaN)
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return EMPTY_INDICES
    const r = safeNumber(radius, -1)
    if (!(r >= 0)) return EMPTY_INDICES

    const cell = this.cellSize
    const cols = this.gridCols
    const rows = this.gridRows

    // The closest point of a qualifying segment lies within `radius` of `p`,
    // and is bucketed in the cell that contains it, so this window is exact.
    const rawColLo = Math.floor((px - r - this.gridMinX) / cell)
    const rawColHi = Math.floor((px + r - this.gridMinX) / cell)
    const rawRowLo = Math.floor((pz - r - this.gridMinZ) / cell)
    const rawRowHi = Math.floor((pz + r - this.gridMinZ) / cell)
    if (!(rawColHi >= 0) || !(rawRowHi >= 0)) return EMPTY_INDICES
    if (rawColLo > cols - 1 || rawRowLo > rows - 1) return EMPTY_INDICES

    const colLo = clampIndex(rawColLo, cols - 1)
    const colHi = clampIndex(rawColHi, cols - 1)
    const rowLo = clampIndex(rawRowLo, rows - 1)
    const rowHi = clampIndex(rawRowHi, rows - 1)

    if (this.edgeQueryStamp >= STAMP_LIMIT) {
      this.edgeMark.fill(0)
      this.edgeQueryStamp = 0
    }
    const stamp = ++this.edgeQueryStamp
    const radiusSq = r * r
    const out: number[] = []

    for (let row = rowLo; row <= rowHi; row++) {
      for (let col = colLo; col <= colHi; col++) {
        const cellIndex = row * cols + col
        const start = this.edgeCellStart[cellIndex]
        const end = this.edgeCellStart[cellIndex + 1]
        for (let k = start; k < end; k++) {
          const edgeIndex = this.edgeCellItems[k]
          // A long edge is bucketed into many cells; test it only once.
          if (this.edgeMark[edgeIndex] === stamp) continue
          this.edgeMark[edgeIndex] = stamp
          const a = this.edgeNodeA[edgeIndex]
          const b = this.edgeNodeB[edgeIndex]
          if (a < 0 || b < 0) continue
          const d2 = pointSegmentDistanceSq(
            px,
            pz,
            this.nodeX[a],
            this.nodeZ[a],
            this.nodeX[b],
            this.nodeZ[b],
          )
          if (d2 <= radiusSq) out.push(edgeIndex)
        }
      }
    }

    return out
  }

  private cellOf(x: number, z: number): number {
    const c = clampIndex(Math.floor((x - this.gridMinX) / this.cellSize), this.gridCols - 1)
    const r = clampIndex(Math.floor((z - this.gridMinZ) / this.cellSize), this.gridRows - 1)
    return r * this.gridCols + c
  }
}
