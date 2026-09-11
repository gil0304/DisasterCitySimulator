#!/usr/bin/env node
/**
 * Procedural generator for `src/data/sample-city.json`.
 *
 * Produces AOBA CITY: a fictional Japanese coastal city on the XZ plane
 * (metres, Three.js Y-up), conforming to `docs/city-schema.md`.
 *
 * Deterministic: every random draw comes from a seeded mulberry32 stream, so
 * the output is byte-stable across runs and machines.
 *
 *   node scripts/generate-city.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = resolve(HERE, '..', 'src', 'data', 'sample-city.json')

const SEED = 20260908

/* ------------------------------------------------------------------ *
 * Seeded PRNG (mulberry32, transcribed — the TS module is not imported
 * because this script must run as plain Node ESM).
 * ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeRng(seed) {
  const next = mulberry32(seed)
  const rng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.min(items.length - 1, Math.floor(next() * items.length))],
    /** Irwin-Hall approximation of a standard normal. */
    normal: () => (next() + next() + next() + next() - 2) * 1.1547,
    clampedNormal: (mean, sd, min, max) =>
      Math.min(max, Math.max(min, mean + rng.normal() * sd)),
    weighted: (entries) => {
      let total = 0
      for (const e of entries) total += Math.max(0, e[1])
      if (total <= 0) return entries[0][0]
      let r = next() * total
      for (const e of entries) {
        r -= Math.max(0, e[1])
        if (r <= 0) return e[0]
      }
      return entries[entries.length - 1][0]
    },
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        const tmp = items[i]
        items[i] = items[j]
        items[j] = tmp
      }
      return items
    },
  }
  return rng
}

const rng = makeRng(SEED)

/* ------------------------------------------------------------------ *
 * Small numeric helpers
 * ------------------------------------------------------------------ */

function fail(message) {
  throw new Error(`[generate-city] ${message}`)
}

function round(value, places) {
  if (!Number.isFinite(value)) fail(`non-finite number produced (${value})`)
  const m = 10 ** places
  const out = Math.round(value * m) / m
  // Avoid emitting "-0" into the JSON.
  return out === 0 ? 0 : out
}

const r2 = (v) => round(v, 2)
const r3 = (v) => round(v, 3)

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

function dist(ax, az, bx, bz) {
  const dx = ax - bx
  const dz = az - bz
  return Math.sqrt(dx * dx + dz * dz)
}

/** Closest distance from point p to segment ab. */
function pointSegDistance(px, pz, ax, az, bx, bz) {
  const abx = bx - ax
  const abz = bz - az
  const lenSq = abx * abx + abz * abz
  if (lenSq <= 1e-9) return dist(px, pz, ax, az)
  let t = ((px - ax) * abx + (pz - az) * abz) / lenSq
  t = clamp(t, 0, 1)
  return dist(px, pz, ax + abx * t, az + abz * t)
}

function segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx)
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx)
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true
  }
  return false
}

/**
 * Exact distance between segment ab and the rotated rectangle centred at
 * (cx, cz) with the given rotation, width (local X) and depth (local Z).
 * Returns 0 when they overlap.
 */
function segmentRectDistance(ax, az, bx, bz, cx, cz, rot, width, depth) {
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const toLocal = (px, pz) => {
    const dx = px - cx
    const dz = pz - cz
    return [dx * cos - dz * sin, dx * sin + dz * cos]
  }
  const [lax, laz] = toLocal(ax, az)
  const [lbx, lbz] = toLocal(bx, bz)
  const hw = width * 0.5
  const hd = depth * 0.5
  const inside = (x, z) => Math.abs(x) <= hw && Math.abs(z) <= hd
  if (inside(lax, laz) || inside(lbx, lbz)) return 0
  const corners = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ]
  for (let i = 0; i < 4; i++) {
    const c0 = corners[i]
    const c1 = corners[(i + 1) % 4]
    if (segmentsIntersect(lax, laz, lbx, lbz, c0[0], c0[1], c1[0], c1[1])) return 0
  }
  let best = Infinity
  for (const c of corners) {
    const d = pointSegDistance(c[0], c[1], lax, laz, lbx, lbz)
    if (d < best) best = d
  }
  for (const p of [
    [lax, laz],
    [lbx, lbz],
  ]) {
    const dx = Math.max(Math.abs(p[0]) - hw, 0)
    const dz = Math.max(Math.abs(p[1]) - hd, 0)
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d < best) best = d
  }
  return best
}

/** Axis-aligned half-extents of a rotated rectangle. */
function rotatedHalfExtents(width, depth, rot) {
  const c = Math.abs(Math.cos(rot))
  const s = Math.abs(Math.sin(rot))
  return [0.5 * (width * c + depth * s), 0.5 * (width * s + depth * c)]
}

function aabbOverlap(a, b, pad) {
  return (
    Math.abs(a.cx - b.cx) < a.hx + b.hx + pad && Math.abs(a.cz - b.cz) < a.hz + b.hz + pad
  )
}

/* ------------------------------------------------------------------ *
 * Uniform spatial grid (used for footprint occupancy and road proximity)
 * ------------------------------------------------------------------ */

function makeGrid(cellSize) {
  const cells = new Map()
  const key = (gx, gz) => gx * 100003 + gz
  return {
    cellSize,
    insertRect(cx, cz, hx, hz, payload) {
      const gx0 = Math.floor((cx - hx) / cellSize)
      const gx1 = Math.floor((cx + hx) / cellSize)
      const gz0 = Math.floor((cz - hz) / cellSize)
      const gz1 = Math.floor((cz + hz) / cellSize)
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gz = gz0; gz <= gz1; gz++) {
          const k = key(gx, gz)
          let bucket = cells.get(k)
          if (!bucket) {
            bucket = []
            cells.set(k, bucket)
          }
          bucket.push(payload)
        }
      }
    },
    queryRect(cx, cz, hx, hz) {
      const gx0 = Math.floor((cx - hx) / cellSize)
      const gx1 = Math.floor((cx + hx) / cellSize)
      const gz0 = Math.floor((cz - hz) / cellSize)
      const gz1 = Math.floor((cz + hz) / cellSize)
      const seen = new Set()
      const out = []
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gz = gz0; gz <= gz1; gz++) {
          const bucket = cells.get(key(gx, gz))
          if (!bucket) continue
          for (const p of bucket) {
            if (seen.has(p)) continue
            seen.add(p)
            out.push(p)
          }
        }
      }
      return out
    },
  }
}

/* ------------------------------------------------------------------ *
 * City geometry constants
 * ------------------------------------------------------------------ */

const CITY_MIN_X = -680
const CITY_MAX_X = 680
const ROWS_NORTH_MIN = -580
const ROWS_NORTH_MAX = 80
const ROWS_SOUTH_MIN = 370
const ROWS_SOUTH_MAX = 590

/** River centreline: a gentle S running roughly east-west. */
const RIVER_HALF_WIDTH = 34
const RIVER_BANK_OFFSET = 50
function riverZ(x) {
  return 235 + 32 * Math.sin(x / 560)
}

const ROAD_WIDTH = { arterial: 22, collector: 14, local: 8, alley: 4 }

/* ------------------------------------------------------------------ *
 * 1. Road network
 * ------------------------------------------------------------------ */

/** Positions from `from` to `to` in `count` steps whose lengths land in [minStep, maxStep]. */
function irregularAxis(from, to, count, minStep, maxStep) {
  const steps = []
  for (let i = 0; i < count; i++) steps.push(rng.range(minStep, maxStep))
  const sum = steps.reduce((a, b) => a + b, 0)
  const scale = (to - from) / (sum || 1)
  const out = [from]
  let cursor = from
  for (let i = 0; i < count; i++) {
    cursor += steps[i] * scale
    out.push(cursor)
  }
  out[out.length - 1] = to
  return out
}

const colX = irregularAxis(CITY_MIN_X, CITY_MAX_X, 12, 90, 130)
const rowNorthZ = irregularAxis(ROWS_NORTH_MIN, ROWS_NORTH_MAX, 6, 90, 130)
const rowSouthZ = irregularAxis(ROWS_SOUTH_MIN, ROWS_SOUTH_MAX, 2, 90, 130)

const COLS = colX.length // 13
const NORTH_ROWS = rowNorthZ.length // 7
const BANK_NORTH_ROW = NORTH_ROWS // 7
const BANK_SOUTH_ROW = NORTH_ROWS + 1 // 8
const SOUTH_ROW_0 = NORTH_ROWS + 2 // 9
const ROW_LINES = NORTH_ROWS + 2 + rowSouthZ.length // 12

/** Row lines whose edges are wide arterials. */
const ARTERIAL_ROWS = new Set([5, SOUTH_ROW_0])
/** Column whose vertical edges are a wide arterial (also the main bridge). */
const ARTERIAL_COL = 6
const BRIDGE_COLS = [2, ARTERIAL_COL, 10]

/**
 * Street hierarchy. A real ward is not served by a 14 m collector on every
 * block edge — collectors run every third line and everything between them is
 * an 8 m residential street. This matters to the simulation as well as the
 * look: rubble from a two-storey house closes an 8 m street but barely
 * inconveniences a 14 m one, so a flat grid of collectors produces a city
 * where nothing can ever be blocked.
 */
const COLLECTOR_ROWS = new Set([BANK_NORTH_ROW, BANK_SOUTH_ROW])
for (let r = 0; r < ROW_LINES; r++) if (r % 3 === 0) COLLECTOR_ROWS.add(r)
const COLLECTOR_COLS = new Set()
for (let c = 0; c < COLS; c++) if (c % 3 === 0) COLLECTOR_COLS.add(c)

/** Class of the horizontal edges running along row line `r`. */
function rowClass(r) {
  if (ARTERIAL_ROWS.has(r)) return 'arterial'
  return COLLECTOR_ROWS.has(r) ? 'collector' : 'local'
}

/** Class of the vertical edges running along column `c`. */
function colClass(c) {
  if (c === ARTERIAL_COL) return 'arterial'
  return COLLECTOR_COLS.has(c) ? 'collector' : 'local'
}

const nodes = []
const nodeById = new Map()
const edges = []
const edgeKeySeen = new Set()

function addNode(x, z) {
  const id = `n${nodes.length}`
  const node = { id, x, z, degree: 0 }
  nodes.push(node)
  nodeById.set(id, node)
  return node
}

function addEdge(aId, bId, roadClass) {
  if (aId === bId) fail(`self-loop edge on ${aId}`)
  const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`
  if (edgeKeySeen.has(key)) return null
  edgeKeySeen.add(key)
  const a = nodeById.get(aId)
  const b = nodeById.get(bId)
  if (!a || !b) fail(`edge references unknown node ${aId} / ${bId}`)
  const edge = {
    id: `e${edges.length}`,
    from: aId,
    to: bId,
    roadClass,
    width: ROAD_WIDTH[roadClass],
    length: dist(a.x, a.z, b.x, b.z),
  }
  if (edge.length < 4) fail(`degenerate edge ${edge.id} (length ${edge.length})`)
  edges.push(edge)
  a.degree++
  b.degree++
  return edge
}

// --- grid nodes -----------------------------------------------------------

/** grid[c][r] -> node */
const grid = []
for (let c = 0; c < COLS; c++) {
  grid.push(new Array(ROW_LINES).fill(null))
}

for (let c = 0; c < COLS; c++) {
  const baseX = colX[c]
  for (let r = 0; r < ROW_LINES; r++) {
    let baseZ
    let jitter = 4
    if (r < NORTH_ROWS) baseZ = rowNorthZ[r]
    else if (r === BANK_NORTH_ROW) {
      baseZ = riverZ(baseX) - RIVER_BANK_OFFSET
      jitter = 1.5
    } else if (r === BANK_SOUTH_ROW) {
      baseZ = riverZ(baseX) + RIVER_BANK_OFFSET
      jitter = 1.5
    } else baseZ = rowSouthZ[r - SOUTH_ROW_0]

    // Edge columns/rows stay put so the city keeps a clean outline.
    const jx = c === 0 || c === COLS - 1 ? 0 : rng.range(-4, 4)
    const jz = r === 0 || r === ROW_LINES - 1 ? 0 : rng.range(-jitter, jitter)
    grid[c][r] = addNode(baseX + jx, baseZ + jz)
  }
}

// --- grid edges -----------------------------------------------------------

/** hEdgeIndex[c][r] = index into `edges` for the edge (c,r)-(c+1,r), or -1. */
const hEdgeIndex = []
for (let c = 0; c < COLS - 1; c++) hEdgeIndex.push(new Array(ROW_LINES).fill(-1))
/** vEdgeIndex[c][r] = index into `edges` for the edge (c,r)-(c,r+1), or -1. */
const vEdgeIndex = []
for (let c = 0; c < COLS; c++) vEdgeIndex.push(new Array(ROW_LINES - 1).fill(-1))

for (let r = 0; r < ROW_LINES; r++) {
  const cls = rowClass(r)
  for (let c = 0; c < COLS - 1; c++) {
    const e = addEdge(grid[c][r].id, grid[c + 1][r].id, cls)
    if (e) hEdgeIndex[c][r] = edges.length - 1
  }
}

for (let c = 0; c < COLS; c++) {
  const cls = colClass(c)
  for (let r = 0; r < ROW_LINES - 1; r++) {
    // The river gap is crossed only by bridges.
    if (r === BANK_NORTH_ROW) continue
    const e = addEdge(grid[c][r].id, grid[c][r + 1].id, cls)
    if (e) vEdgeIndex[c][r] = edges.length - 1
  }
}

// --- bridges --------------------------------------------------------------

const bridgeEdgeIds = []
for (const c of BRIDGE_COLS) {
  const cls = c === ARTERIAL_COL ? 'arterial' : 'collector'
  const e = addEdge(grid[c][BANK_NORTH_ROW].id, grid[c][BANK_SOUTH_ROW].id, cls)
  if (!e) fail(`bridge at column ${c} could not be created`)
  bridgeEdgeIds.push(e.id)
  vEdgeIndex[c][BANK_NORTH_ROW] = edges.length - 1
}

// --- mid-block local streets (created by splitting grid edges) -------------

/**
 * Split an existing edge at parameter t, inserting a node. Returns the new
 * node. The original edge is rewired to end at the new node and a second edge
 * is appended.
 */
function splitEdge(edgeIdx, t, roadClass) {
  const edge = edges[edgeIdx]
  if (!edge) fail(`splitEdge on missing index ${edgeIdx}`)
  const a = nodeById.get(edge.from)
  const b = nodeById.get(edge.to)
  const tt = clamp(t, 0.2, 0.8)
  const mid = addNode(lerp(a.x, b.x, tt), lerp(a.z, b.z, tt))
  const oldTo = edge.to
  edge.to = mid.id
  edge.length = dist(a.x, a.z, mid.x, mid.z)
  b.degree--
  mid.degree++
  const key = edge.from < oldTo ? `${edge.from}|${oldTo}` : `${oldTo}|${edge.from}`
  edgeKeySeen.delete(key)
  const tail = addEdge(mid.id, oldTo, roadClass ?? edge.roadClass)
  if (!tail) fail(`could not create tail edge when splitting ${edge.id}`)
  return mid
}

const localStreetPlans = []
{
  // Horizontal mid-block lanes: split the vertical grid edges of a block row.
  const usedV = new Set()
  const rowChoices = [0, 1, 2, 3, 4, 5, 6, BANK_SOUTH_ROW, SOUTH_ROW_0, SOUTH_ROW_0 + 1]
  let attempts = 0
  while (localStreetPlans.length < 10 && attempts < 200) {
    attempts++
    const r = rng.pick(rowChoices)
    const span = rng.int(3, 5)
    const c0 = rng.int(0, COLS - 1 - span)
    let ok = true
    for (let c = c0; c <= c0 + span; c++) {
      if (usedV.has(`${c}:${r}`) || vEdgeIndex[c][r] < 0) ok = false
    }
    if (!ok) continue
    for (let c = c0; c <= c0 + span; c++) usedV.add(`${c}:${r}`)
    localStreetPlans.push({ axis: 'h', r, c0, c1: c0 + span, t: rng.range(0.4, 0.6) })
  }
}

for (const plan of localStreetPlans) {
  const cls = rng.chance(0.25) ? 'alley' : 'local'
  const created = []
  for (let c = plan.c0; c <= plan.c1; c++) {
    const idx = vEdgeIndex[c][plan.r]
    vEdgeIndex[c][plan.r] = -1
    created.push(splitEdge(idx, plan.t + rng.range(-0.05, 0.05), null))
  }
  for (let i = 0; i < created.length - 1; i++) {
    addEdge(created[i].id, created[i + 1].id, cls)
  }
}

{
  // Vertical mid-block lanes: split the horizontal grid edges of a block column.
  const usedH = new Set()
  const bands = [
    [0, 6],
    [BANK_SOUTH_ROW, ROW_LINES - 1],
  ]
  let made = 0
  let attempts = 0
  while (made < 4 && attempts < 200) {
    attempts++
    const band = attempts % 3 === 0 ? bands[1] : bands[0]
    const maxSpan = band[1] - band[0]
    if (maxSpan < 2) continue
    const span = Math.min(rng.int(2, 4), maxSpan)
    const r0 = rng.int(band[0], band[1] - span)
    const c = rng.int(0, COLS - 2)
    let ok = true
    for (let r = r0; r <= r0 + span; r++) {
      if (usedH.has(`${c}:${r}`) || hEdgeIndex[c][r] < 0) ok = false
    }
    if (!ok) continue
    for (let r = r0; r <= r0 + span; r++) usedH.add(`${c}:${r}`)
    const t = rng.range(0.4, 0.6)
    const created = []
    for (let r = r0; r <= r0 + span; r++) {
      const idx = hEdgeIndex[c][r]
      hEdgeIndex[c][r] = -1
      created.push(splitEdge(idx, t + rng.range(-0.05, 0.05), null))
    }
    const cls = made === 3 ? 'alley' : 'local'
    for (let i = 0; i < created.length - 1; i++) {
      addEdge(created[i].id, created[i + 1].id, cls)
    }
    made++
  }
}

/* ------------------------------------------------------------------ *
 * 2. Blocks
 * ------------------------------------------------------------------ */

const blocks = []
for (let c = 0; c < COLS - 1; c++) {
  for (let r = 0; r < ROW_LINES - 1; r++) {
    if (r === BANK_NORTH_ROW) continue // the river itself
    const nw = grid[c][r]
    const ne = grid[c + 1][r]
    const sw = grid[c][r + 1]
    const se = grid[c + 1][r + 1]
    // Conservative inner rectangle of the four bounding streets.
    const x0 = Math.max(nw.x, sw.x)
    const x1 = Math.min(ne.x, se.x)
    const z0 = Math.max(nw.z, ne.z)
    const z1 = Math.min(sw.z, se.z)
    if (x1 - x0 < 40 || z1 - z0 < 40) continue
    const northClass = rowClass(r)
    const southClass = rowClass(r + 1)
    const westClass = colClass(c)
    const eastClass = colClass(c + 1)
    blocks.push({
      col: c,
      row: r,
      x0,
      x1,
      z0,
      z1,
      cx: (x0 + x1) * 0.5,
      cz: (z0 + z1) * 0.5,
      setback: {
        n: ROAD_WIDTH[northClass] * 0.5 + 7,
        s: ROAD_WIDTH[southClass] * 0.5 + 7,
        w: ROAD_WIDTH[westClass] * 0.5 + 7,
        e: ROAD_WIDTH[eastClass] * 0.5 + 7,
      },
    })
  }
}

/* ------------------------------------------------------------------ *
 * 3. Alleys through a handful of blocks (alternate routes for rerouting)
 * ------------------------------------------------------------------ */

{
  const candidates = rng.shuffle(blocks.filter((b) => b.x1 - b.x0 > 70 && b.z1 - b.z0 > 70)).slice(0, 8)
  for (const b of candidates) {
    const mid = addNode(
      lerp(b.x0, b.x1, rng.range(0.42, 0.58)),
      lerp(b.z0, b.z1, rng.range(0.42, 0.58)),
    )
    addEdge(grid[b.col][b.row].id, mid.id, 'alley')
    addEdge(mid.id, grid[b.col + 1][b.row + 1].id, 'alley')
    b.hasAlley = true
  }
}

/* ------------------------------------------------------------------ *
 * 4. Spatial indexes over the finished road network
 * ------------------------------------------------------------------ */

const segments = edges.map((e) => {
  const a = nodeById.get(e.from)
  const b = nodeById.get(e.to)
  return { ax: a.x, az: a.z, bx: b.x, bz: b.z, halfWidth: e.width * 0.5 }
})

const roadGrid = makeGrid(70)
for (const s of segments) {
  const cx = (s.ax + s.bx) * 0.5
  const cz = (s.az + s.bz) * 0.5
  roadGrid.insertRect(cx, cz, Math.abs(s.ax - s.bx) * 0.5 + 2, Math.abs(s.az - s.bz) * 0.5 + 2, s)
}

const MAX_ROAD_HALF_WIDTH = 11

/** Smallest clearance from a rotated rectangle to any road carriageway edge. */
function roadClearance(cx, cz, rot, width, depth) {
  const [hx, hz] = rotatedHalfExtents(width, depth, rot)
  const near = roadGrid.queryRect(cx, cz, hx + MAX_ROAD_HALF_WIDTH + 14, hz + MAX_ROAD_HALF_WIDTH + 14)
  let worst = Infinity
  for (const s of near) {
    const d = segmentRectDistance(s.ax, s.az, s.bx, s.bz, cx, cz, rot, width, depth) - s.halfWidth
    if (d < worst) worst = d
  }
  return worst
}

/** Nearest road segment to a point, as [distance, segment]. */
function nearestSegment(px, pz) {
  let radius = 70
  for (let attempt = 0; attempt < 6; attempt++) {
    const near = roadGrid.queryRect(px, pz, radius, radius)
    let best = null
    let bestD = Infinity
    for (const s of near) {
      const d = pointSegDistance(px, pz, s.ax, s.az, s.bx, s.bz)
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    if (best) return [bestD, best]
    radius *= 2
  }
  let best = null
  let bestD = Infinity
  for (const s of segments) {
    const d = pointSegDistance(px, pz, s.ax, s.az, s.bx, s.bz)
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return [bestD, best]
}

/** Y-rotation that turns the building's local -Z face toward the nearest street. */
function facingRotation(px, pz) {
  const [, seg] = nearestSegment(px, pz)
  if (!seg) return 0
  const abx = seg.bx - seg.ax
  const abz = seg.bz - seg.az
  const lenSq = abx * abx + abz * abz
  let t = lenSq <= 1e-9 ? 0 : ((px - seg.ax) * abx + (pz - seg.az) * abz) / lenSq
  t = clamp(t, 0, 1)
  const qx = seg.ax + abx * t
  const qz = seg.az + abz * t
  let nx = qx - px
  let nz = qz - pz
  const len = Math.sqrt(nx * nx + nz * nz)
  if (len < 1e-6) return 0
  nx /= len
  nz /= len
  return Math.atan2(-nx, -nz)
}

function nearestNodeTo(px, pz) {
  let best = null
  let bestD = Infinity
  for (const n of nodes) {
    const d = dist(px, pz, n.x, n.z)
    if (d < bestD) {
      bestD = d
      best = n
    }
  }
  return [bestD, best]
}

/* ------------------------------------------------------------------ *
 * 5. Footprint occupancy (shelters + buildings share one index)
 * ------------------------------------------------------------------ */

const footprintGrid = makeGrid(45)
const placedRects = []

function canPlace(cx, cz, rot, width, depth, pad) {
  const [hx, hz] = rotatedHalfExtents(width, depth, rot)
  const box = { cx, cz, hx, hz }
  const near = footprintGrid.queryRect(cx, cz, hx + 40, hz + 40)
  for (const other of near) {
    if (aabbOverlap(box, other, pad)) return false
  }
  return true
}

function commitRect(cx, cz, rot, width, depth) {
  const [hx, hz] = rotatedHalfExtents(width, depth, rot)
  const box = { cx, cz, hx, hz }
  footprintGrid.insertRect(cx, cz, hx, hz, box)
  placedRects.push(box)
  return box
}

/* ------------------------------------------------------------------ *
 * 6. Districts and ground zones
 * ------------------------------------------------------------------ */

const districts = [
  { id: 'd-chuo', name: 'Chuo Business District', kind: 'business', center: [40, -110], radius: 260 },
  { id: 'd-sakura', name: 'Sakuragaoka Ward', kind: 'residential', center: [-450, -120], radius: 310 },
  { id: 'd-higashi', name: 'Higashi Ward', kind: 'residential', center: [470, -90], radius: 300 },
  { id: 'd-kawakita', name: 'Kawakita Shotengai', kind: 'commercial', center: [-40, 160], radius: 330 },
  { id: 'd-minato', name: 'Minato Waterfront', kind: 'industrial', center: [60, 430], radius: 400 },
  { id: 'd-aoyama', name: 'Aoyama Heights', kind: 'residential', center: [-140, -470], radius: 350 },
]

function districtAt(x, z) {
  if (z > 290) return 'd-minato'
  if (z > 90) return 'd-kawakita'
  if (z < -320) return 'd-aoyama'
  if (x < -190) return 'd-sakura'
  if (x > 260) return 'd-higashi'
  return 'd-chuo'
}

/* ------------------------------------------------------------------ *
 * 7. Shelters — placed before buildings so they own their open sites
 * ------------------------------------------------------------------ */

const SHELTER_PLAN = [
  { id: 'sh-chuo-park', name: 'Chuo Central Park', kind: 'park', weight: 420, target: [70, -190] },
  { id: 'sh-station', name: 'Aoba Station Plaza', kind: 'civic', weight: 300, target: [175, -35] },
  { id: 'sh-civic', name: 'Aoba Civic Hall', kind: 'civic', weight: 260, target: [-95, -240] },
  { id: 'sh-sakura-gym', name: 'Sakura Elementary Gymnasium', kind: 'gym', weight: 220, target: [-455, -150] },
  { id: 'sh-higashi-gym', name: 'Higashi Junior High Gymnasium', kind: 'gym', weight: 200, target: [470, -55] },
  { id: 'sh-aoyama-gym', name: 'Aoyama Elementary Gymnasium', kind: 'gym', weight: 180, target: [-160, -455] },
  { id: 'sh-kawakita-park', name: 'Kawakita Riverside Park', kind: 'park', weight: 150, target: [-330, 120] },
  { id: 'sh-minato-park', name: 'Minato Wharf Park', kind: 'park', weight: 90, target: [190, 440] },
  { id: 'sh-hikari', name: 'Hikari Community Center', kind: 'civic', weight: 60, target: [545, 300] },
]

const shelters = []

for (const plan of SHELTER_PLAN) {
  // Footprint area sized from the capacity weight (~2.4 m2 per person).
  const area = Math.max(240, plan.weight * 2.4)
  const width = Math.sqrt(area * 1.55)
  const depth = area / width

  // Rank road nodes by distance to the plan's target point, then try to seat
  // the shelter in one of the four quadrants around the chosen node.
  const ranked = nodes
    .map((n) => ({ n, d: dist(n.x, n.z, plan.target[0], plan.target[1]) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 12)

  let placed = null
  for (const cand of ranked) {
    const quadrants = [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]
    for (const [sx, sz] of quadrants) {
      const cx = cand.n.x + sx * (width * 0.5 + 17)
      const cz = cand.n.z + sz * (depth * 0.5 + 17)
      const rot = facingRotation(cx, cz)
      if (roadClearance(cx, cz, rot, width, depth) < 4) continue
      if (!canPlace(cx, cz, rot, width, depth, 6)) continue
      const [nodeDist, node] = nearestNodeTo(cx, cz)
      if (nodeDist > 55 || !node) continue
      placed = { cx, cz, rot, node }
      break
    }
    if (placed) break
  }
  if (!placed) fail(`could not place shelter ${plan.id} near ${plan.target}`)

  commitRect(placed.cx, placed.cz, placed.rot, width, depth)
  shelters.push({
    id: plan.id,
    name: plan.name,
    position: [r2(placed.cx), r2(placed.cz)],
    capacity: 0, // filled in once total occupancy is known
    kind: plan.kind,
    footprint: { width: r2(width), depth: r2(depth) },
    roadNodeId: placed.node.id,
    _weight: plan.weight,
  })
}

/* ------------------------------------------------------------------ *
 * 8. Buildings
 * ------------------------------------------------------------------ */

const FLOOR_HEIGHT = {
  residential: 3.0,
  apartment: 3.0,
  office: 3.85,
  commercial: 3.9,
  retail: 3.5,
  school: 3.6,
  hospital: 3.6,
  factory: 5.6,
  civic: 4.0,
  station: 5.0,
  temple: 5.0,
  parking: 3.0,
}

const UNIT_COST = {
  wood: 200000,
  lightSteel: 260000,
  masonry: 240000,
  rc: 320000,
  steel: 420000,
  prefab: 180000,
}

const BASE_PROFILE = {
  residential: { child: 0.18, adult: 0.52, elderly: 0.24, mobilityImpaired: 0.06 },
  apartment: { child: 0.16, adult: 0.58, elderly: 0.21, mobilityImpaired: 0.05 },
  office: { child: 0.0, adult: 0.95, elderly: 0.04, mobilityImpaired: 0.01 },
  commercial: { child: 0.08, adult: 0.72, elderly: 0.16, mobilityImpaired: 0.04 },
  retail: { child: 0.1, adult: 0.7, elderly: 0.16, mobilityImpaired: 0.04 },
  school: { child: 0.82, adult: 0.17, elderly: 0.0, mobilityImpaired: 0.01 },
  hospital: { child: 0.06, adult: 0.28, elderly: 0.42, mobilityImpaired: 0.24 },
  factory: { child: 0.0, adult: 0.93, elderly: 0.06, mobilityImpaired: 0.01 },
  civic: { child: 0.06, adult: 0.7, elderly: 0.2, mobilityImpaired: 0.04 },
  station: { child: 0.09, adult: 0.74, elderly: 0.14, mobilityImpaired: 0.03 },
  temple: { child: 0.04, adult: 0.46, elderly: 0.46, mobilityImpaired: 0.04 },
  parking: { child: 0.02, adult: 0.9, elderly: 0.07, mobilityImpaired: 0.01 },
}

/** Japanese building-code eras drive seismic resistance far more than age alone. */
function seismicFromYear(year, construction) {
  let base
  if (year <= 1970) base = 0.215
  else if (year <= 1981) base = lerp(0.215, 0.285, (year - 1970) / 11)
  else if (year <= 1995) base = lerp(0.34, 0.48, (year - 1981) / 14)
  else if (year <= 2000) base = lerp(0.48, 0.56, (year - 1995) / 5)
  else if (year <= 2012) base = lerp(0.58, 0.7, (year - 2000) / 12)
  else base = lerp(0.72, 0.86, clamp((year - 2012) / 14, 0, 1))
  const bonus = {
    wood: -0.03,
    masonry: -0.14,
    prefab: 0.0,
    lightSteel: 0.02,
    rc: 0.06,
    steel: 0.1,
  }[construction]
  return clamp(base + bonus + rng.range(-0.035, 0.035), 0.08, 0.95)
}

function makeProfile(use) {
  const base = BASE_PROFILE[use] ?? BASE_PROFILE.residential
  const keys = ['child', 'adult', 'elderly', 'mobilityImpaired']
  const raw = {}
  let sum = 0
  for (const k of keys) {
    const v = Math.max(0, base[k] * rng.range(0.85, 1.15))
    raw[k] = v
    sum += v
  }
  if (sum <= 0) fail(`degenerate population profile for use ${use}`)
  const out = {}
  let acc = 0
  // Round three of the four, then give the remainder to the largest component
  // so the fractions sum to exactly 1.
  let largest = keys[0]
  for (const k of keys) if (raw[k] > raw[largest]) largest = k
  for (const k of keys) {
    if (k === largest) continue
    const v = round(raw[k] / sum, 3)
    out[k] = v
    acc += v
  }
  out[largest] = round(1 - acc, 3)
  if (out[largest] < 0) fail(`negative population fraction for use ${use}`)
  return { child: out.child, adult: out.adult, elderly: out.elderly, mobilityImpaired: out.mobilityImpaired }
}

const NAME_POOL = {
  house: ['Aoba', 'Sakura', 'Midori', 'Hikari', 'Yanagi', 'Kaede', 'Shirakawa', 'Umegaoka', 'Suzuran', 'Hinode'],
  block: ['Aoba', 'Sakura', 'Kawakita', 'Higashi', 'Minato', 'Nishi', 'Hinode', 'Wakaba'],
  blockKind: ['Heights', 'Mansion', 'Residence', 'Court', 'Corp'],
  office: ['Aoba', 'Chuo', 'Minato', 'Kaigan', 'Sakae', 'Nihonbashi', 'Marunouchi'],
  officeKind: ['Building', 'Tower', 'Center', 'Square'],
  shopOwner: ['Marufuku', 'Tanaka', 'Yamashita', 'Kobayashi', 'Ito', 'Nakagawa', 'Ogawa', 'Fujita'],
  shopKind: ['Shoten', 'Store', 'Market', 'Bakery', 'Pharmacy', 'Bookshop', 'Ramen', 'Grocer'],
  factory: ['Aoba', 'Minato', 'Toyokawa', 'Kaigan', 'Seiwa'],
  factoryKind: ['Works', 'Plant', 'Warehouse', 'Foundry', 'Depot'],
  commercial: ['Aoba', 'Kawakita', 'Sakae', 'Hinode'],
  commercialKind: ['Plaza', 'Hall', 'Arcade', 'Terrace'],
}

const counters = {}
function nextIndex(use) {
  counters[use] = (counters[use] ?? 0) + 1
  return counters[use]
}

function buildingName(use) {
  const i = nextIndex(use)
  switch (use) {
    case 'residential':
      return `${rng.pick(NAME_POOL.house)} House ${i}`
    case 'apartment':
      return `${rng.pick(NAME_POOL.block)} ${rng.pick(NAME_POOL.blockKind)} ${i}`
    case 'office':
      return `${rng.pick(NAME_POOL.office)} ${rng.pick(NAME_POOL.officeKind)} ${i}`
    case 'commercial':
      return `${rng.pick(NAME_POOL.commercial)} ${rng.pick(NAME_POOL.commercialKind)} ${i}`
    case 'retail':
      return `${rng.pick(NAME_POOL.shopOwner)} ${rng.pick(NAME_POOL.shopKind)}`
    case 'factory':
      return `${rng.pick(NAME_POOL.factory)} ${rng.pick(NAME_POOL.factoryKind)} ${i}`
    default:
      return `${use} ${i}`
  }
}

const buildings = []

/**
 * Sample a footprint / structure for a use, clamped into the space available.
 * Returns null when the use cannot fit.
 */
function sampleForm(use, maxW, maxD) {
  const spec = {
    residential: { w: [7, 11.5], d: [8, 12.5], floors: [1, 3], minW: 6, minD: 7 },
    apartment: { w: [16, 30], d: [11, 16], floors: [5, 10], minW: 14, minD: 10 },
    office: { w: [20, 34], d: [16, 26], floors: [8, 24], minW: 17, minD: 14 },
    commercial: { w: [16, 30], d: [14, 22], floors: [3, 8], minW: 14, minD: 12 },
    retail: { w: [8, 16], d: [10, 16], floors: [1, 3], minW: 7, minD: 8 },
    school: { w: [46, 62], d: [14, 18], floors: [3, 4], minW: 40, minD: 13 },
    hospital: { w: [32, 44], d: [24, 32], floors: [5, 9], minW: 28, minD: 20 },
    factory: { w: [30, 58], d: [20, 36], floors: [1, 3], minW: 22, minD: 16 },
    civic: { w: [26, 40], d: [20, 28], floors: [2, 5], minW: 22, minD: 16 },
    station: { w: [52, 68], d: [24, 32], floors: [2, 3], minW: 46, minD: 20 },
    temple: { w: [17, 24], d: [14, 20], floors: [1, 1], minW: 15, minD: 12 },
  }[use]
  if (!spec) fail(`no form spec for use ${use}`)
  const w = clamp(rng.range(spec.w[0], spec.w[1]), spec.minW, Math.max(spec.minW, maxW))
  const d = clamp(rng.range(spec.d[0], spec.d[1]), spec.minD, Math.max(spec.minD, maxD))
  if (w > maxW + 0.01 || d > maxD + 0.01) return null
  const floors = rng.int(spec.floors[0], spec.floors[1])
  return { width: w, depth: d, floors }
}

function pickYear(use, districtId) {
  switch (use) {
    case 'office':
      return rng.int(1994, 2023)
    case 'commercial':
      return rng.int(1988, 2020)
    case 'apartment':
      return rng.int(1975, 2018)
    case 'retail':
      return rng.int(1966, 2012)
    case 'factory':
      return rng.int(1968, 2006)
    case 'school':
      return rng.int(1972, 2004)
    case 'hospital':
      return rng.int(1998, 2019)
    case 'station':
      return 2009
    case 'civic':
      return rng.chance(0.5) ? 1985 : 2014
    case 'temple':
      return 1898
    default:
      // Residential: the hill ward was developed later than the old low wards.
      if (districtId === 'd-aoyama') return rng.int(1979, 2005)
      if (districtId === 'd-kawakita') return rng.int(1960, 1994)
      return rng.int(1962, 2005)
  }
}

function pickConstruction(use, floors, year) {
  switch (use) {
    case 'office':
      return floors >= 14 ? 'steel' : 'rc'
    case 'commercial':
      return floors >= 6 ? 'steel' : 'rc'
    case 'apartment':
      return 'rc'
    case 'retail':
      if (year < 1985) return rng.chance(0.75) ? 'wood' : 'masonry'
      return rng.chance(0.55) ? 'lightSteel' : 'rc'
    case 'factory':
      if (year < 1980 && rng.chance(0.3)) return 'masonry'
      return rng.chance(0.55) ? 'lightSteel' : 'steel'
    case 'school':
    case 'hospital':
      return year >= 2010 ? 'steel' : 'rc'
    case 'civic':
      return 'rc'
    case 'station':
      return 'steel'
    case 'temple':
      return 'wood'
    default:
      if (year >= 2000 && rng.chance(0.3)) return rng.chance(0.5) ? 'prefab' : 'lightSteel'
      return 'wood'
  }
}

function pickRoof(use, floors, construction) {
  if (use === 'temple') return 'hip'
  if (use === 'factory') return floors <= 2 ? 'sawtooth' : 'flat'
  if (construction === 'wood' && floors <= 2) return rng.chance(0.65) ? 'gable' : 'hip'
  if (use === 'retail' && floors <= 2) return rng.chance(0.4) ? 'mono' : 'flat'
  if (use === 'residential' && floors <= 3) return rng.chance(0.5) ? 'gable' : 'flat'
  return 'flat'
}

/** People present at the moment of the shock (not registered residents). */
function rawOccupancy(use, form) {
  const area = form.width * form.depth * form.floors
  switch (use) {
    case 'residential':
      return rng.range(1.6, 5.2)
    case 'apartment': {
      const units = Math.max(1, Math.floor(form.width / 9)) * form.floors
      return units * rng.range(1.3, 2.4)
    }
    case 'office':
      return area / rng.range(130, 210)
    case 'commercial':
      return area / rng.range(120, 200)
    case 'retail':
      return area / rng.range(30, 55)
    case 'school':
      return rng.range(90, 150)
    case 'hospital':
      return rng.range(80, 150)
    case 'factory':
      return area / rng.range(90, 160)
    case 'civic':
      return area / rng.range(90, 150)
    case 'station':
      return rng.range(180, 240)
    case 'temple':
      return rng.range(3, 9)
    default:
      return 3
  }
}

function makeBuilding(use, cx, cz, rot, form, districtId, nameOverride) {
  const year = pickYear(use, districtId)
  const construction = pickConstruction(use, form.floors, year)
  const roof = pickRoof(use, form.floors, construction)
  const seismic = seismicFromYear(year, construction)
  const floorHeight = FLOOR_HEIGHT[use] ?? 3.2
  let height = form.floors * floorHeight
  if (roof === 'gable' || roof === 'hip') height += rng.range(1.5, 2.8)
  else if (roof === 'sawtooth') height += rng.range(1.4, 2.2)
  else if (roof === 'mono') height += rng.range(0.8, 1.6)
  else height += 1.1 // parapet
  const unitCost = use === 'factory' ? 150000 : UNIT_COST[construction]
  const floorArea = form.width * form.depth * form.floors
  const id = `b${buildings.length}`
  const building = {
    id,
    name: nameOverride ?? buildingName(use),
    position: [r2(cx), r2(cz)],
    rotation: r3(rot),
    footprint: { width: r2(form.width), depth: r2(form.depth) },
    floors: form.floors,
    height: r2(height),
    use,
    constructionType: construction,
    yearBuilt: year,
    roofType: roof,
    seismicResistance: r3(seismic),
    collapseThreshold: r3(clamp(0.72 + 0.2 * seismic + rng.range(-0.02, 0.02), 0.7, 0.95)),
    replacementValue: Math.round((floorArea * unitCost) / 10000) * 10000,
    occupancy: 0, // scaled below
    populationProfile: makeProfile(use),
    fireIgnitionProbability: r3(
      construction === 'wood'
        ? rng.range(0.045, 0.075)
        : use === 'factory'
          ? rng.range(0.04, 0.062)
          : rng.range(0.014, 0.028),
    ),
    districtId,
    nearestRoadNodeId: null,
    _raw: rawOccupancy(use, form),
  }
  buildings.push(building)
  commitRect(cx, cz, rot, form.width, form.depth)
  return building
}

/** Attempt to seat a building of `use` centred at (cx, cz). */
function tryPlace(use, cx, cz, maxW, maxD, districtId, nameOverride) {
  const form = sampleForm(use, maxW, maxD)
  if (!form) return null
  const rot = facingRotation(cx, cz) + rng.range(-0.035, 0.035)
  if (roadClearance(cx, cz, rot, form.width, form.depth) < 2.5) return null
  if (!canPlace(cx, cz, rot, form.width, form.depth, 2.2)) return null
  return makeBuilding(use, cx, cz, rot, form, districtId, nameOverride)
}

// --- landmark buildings ---------------------------------------------------

const LANDMARKS = [
  { use: 'station', name: 'Aoba Station', target: [140, -25] },
  { use: 'hospital', name: 'Aoba General Hospital', target: [-70, -195] },
  { use: 'hospital', name: 'Higashi Municipal Hospital', target: [415, 25] },
  { use: 'school', name: 'Sakura Elementary School', target: [-455, -165] },
  { use: 'school', name: 'Higashi Junior High School', target: [470, -70] },
  { use: 'school', name: 'Aoyama Elementary School', target: [-160, -470] },
  { use: 'civic', name: 'Aoba City Hall', target: [-95, -255] },
  { use: 'civic', name: 'Minato Community Center', target: [150, 480] },
  { use: 'temple', name: 'Ryusen-ji Temple', target: [-350, -520] },
]

for (const landmark of LANDMARKS) {
  const ranked = blocks
    .map((b) => ({ b, d: dist(b.cx, b.cz, landmark.target[0], landmark.target[1]) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 14)

  let placed = null
  for (const { b } of ranked) {
    const xb0 = b.x0 + b.setback.w
    const xb1 = b.x1 - b.setback.e
    const zb0 = b.z0 + b.setback.n
    const zb1 = b.z1 - b.setback.s
    if (xb1 - xb0 < 20 || zb1 - zb0 < 18) continue
    const spanX = xb1 - xb0
    const spanZ = zb1 - zb0
    const sides = [
      // [centreX, centreZ, maxWidthAlongStreet, maxDepth] for each block edge.
      { cx: (xb0 + xb1) * 0.5, cz: zb0, w: spanX, d: spanZ, vertical: false, anchor: 'n' },
      { cx: (xb0 + xb1) * 0.5, cz: zb1, w: spanX, d: spanZ, vertical: false, anchor: 's' },
      { cx: xb0, cz: (zb0 + zb1) * 0.5, w: spanZ, d: spanX, vertical: true, anchor: 'w' },
      { cx: xb1, cz: (zb0 + zb1) * 0.5, w: spanZ, d: spanX, vertical: true, anchor: 'e' },
    ]
    for (const side of rng.shuffle(sides)) {
      const form = sampleForm(landmark.use, side.w, Math.min(side.d, side.vertical ? spanX : spanZ))
      if (!form) continue
      let cx = side.cx
      let cz = side.cz
      if (side.anchor === 'n') cz = zb0 + form.depth * 0.5
      else if (side.anchor === 's') cz = zb1 - form.depth * 0.5
      else if (side.anchor === 'w') cx = xb0 + form.depth * 0.5
      else cx = xb1 - form.depth * 0.5
      const rot = facingRotation(cx, cz)
      if (roadClearance(cx, cz, rot, form.width, form.depth) < 2.5) continue
      if (!canPlace(cx, cz, rot, form.width, form.depth, 2.5)) continue
      placed = makeBuilding(
        landmark.use,
        cx,
        cz,
        rot,
        form,
        districtAt(cx, cz),
        landmark.name,
      )
      break
    }
    if (placed) break
  }
  if (!placed) fail(`could not place landmark "${landmark.name}"`)
}

// --- generic block fill ---------------------------------------------------

const DISTRICT_MIX = {
  'd-chuo': [
    ['office', 0.4],
    ['commercial', 0.34],
    ['retail', 0.14],
    ['apartment', 0.12],
  ],
  'd-sakura': [
    ['residential', 0.78],
    ['apartment', 0.14],
    ['retail', 0.08],
  ],
  'd-higashi': [
    ['residential', 0.74],
    ['apartment', 0.18],
    ['retail', 0.08],
  ],
  'd-aoyama': [
    ['residential', 0.88],
    ['apartment', 0.07],
    ['retail', 0.05],
  ],
  'd-kawakita': [
    ['retail', 0.46],
    ['apartment', 0.34],
    ['commercial', 0.2],
  ],
  'd-minato': [
    ['factory', 0.86],
    ['commercial', 0.08],
    ['residential', 0.06],
  ],
}

const DISTRICT_DENSITY = {
  'd-chuo': [4, 7],
  'd-sakura': [10, 16],
  'd-higashi': [9, 15],
  'd-aoyama': [10, 16],
  'd-kawakita': [5, 8],
  'd-minato': [2, 4],
}

const BUILDING_BUDGET = 480

// Assign each block a raw target count, then scale so the whole city lands on
// the budget. Roughly half the residential blocks stay sparse, which reads far
// better from above than a uniform density.
const blockPlans = []
for (const b of blocks) {
  const districtId = districtAt(b.cx, b.cz)
  const density = DISTRICT_DENSITY[districtId]
  const denseChance =
    districtId === 'd-chuo' || districtId === 'd-kawakita' || districtId === 'd-minato' ? 0.9 : 0.55
  const dense = rng.chance(denseChance)
  const raw = dense ? rng.int(density[0], density[1]) : rng.int(1, 4)
  blockPlans.push({ block: b, districtId, raw })
}
const rawSum = blockPlans.reduce((a, p) => a + p.raw, 0)
const budgetScale = rawSum > 0 ? (BUILDING_BUDGET - buildings.length) / rawSum : 0

/** Candidate lot positions around a block's inner perimeter plus its interior. */
function blockCandidates(plan) {
  const b = plan.block
  const xb0 = b.x0 + b.setback.w
  const xb1 = b.x1 - b.setback.e
  const zb0 = b.z0 + b.setback.n
  const zb1 = b.z1 - b.setback.s
  const out = []
  if (xb1 - xb0 < 14 || zb1 - zb0 < 14) return out

  // Kawakita's shopping street is deliberately shoulder-to-shoulder.
  const gap = plan.districtId === 'd-kawakita' ? rng.range(1.2, 2.4) : rng.range(2.5, 6)

  const walk = (from, to, step) => {
    const stops = []
    let cursor = from
    while (cursor + step <= to) {
      stops.push(cursor + step * 0.5)
      cursor += step + gap
    }
    return stops
  }

  const typicalW = plan.districtId === 'd-minato' ? 40 : plan.districtId === 'd-chuo' ? 24 : 12
  const typicalD = plan.districtId === 'd-minato' ? 26 : plan.districtId === 'd-chuo' ? 20 : 11

  const lot = (cx, cz) => ({ cx, cz, maxW: typicalW + 4, maxD: typicalD + 3 })
  // One run per block edge, walked in order so frontage builds up contiguously.
  const runs = [
    walk(xb0, xb1, typicalW).map((x) => lot(x, zb0 + typicalD * 0.5)),
    walk(xb0, xb1, typicalW).map((x) => lot(x, zb1 - typicalD * 0.5)),
    walk(zb0, zb1, typicalW).map((z) => lot(xb0 + typicalD * 0.5, z)),
    walk(zb0, zb1, typicalW).map((z) => lot(xb1 - typicalD * 0.5, z)),
  ]
  // Round-robin across the four runs so every bounding street gets frontage
  // instead of one edge being solid and the other three bare. Occasional skips
  // read as car ports, gardens and vacant lots.
  rng.shuffle(runs)
  const longest = runs.reduce((a, r) => Math.max(a, r.length), 0)
  for (let i = 0; i < longest; i++) {
    for (const run of runs) {
      if (i >= run.length) continue
      if (rng.chance(0.12)) continue
      out.push(run[i])
    }
  }

  // Interior lots, reached from mid-block lanes and alleys — used last.
  const ix0 = xb0 + typicalD + 6
  const ix1 = xb1 - typicalD - 6
  const iz0 = zb0 + typicalD + 6
  const iz1 = zb1 - typicalD - 6
  if (ix1 - ix0 > 16 && iz1 - iz0 > 16) {
    const count = plan.districtId === 'd-minato' ? 1 : 5
    for (let i = 0; i < count; i++) {
      out.push({
        cx: rng.range(ix0, ix1),
        cz: rng.range(iz0, iz1),
        maxW: typicalW + 2,
        maxD: typicalD + 2,
      })
    }
  }
  return out
}

for (const plan of blockPlans) {
  const target = Math.max(0, Math.round(plan.raw * budgetScale))
  if (target === 0) continue
  const mix = DISTRICT_MIX[plan.districtId]
  const candidates = blockCandidates(plan)
  let made = 0
  for (const cand of candidates) {
    if (made >= target) break
    const use = rng.weighted(mix)
    const built = tryPlace(use, cand.cx, cand.cz, cand.maxW, cand.maxD, plan.districtId, null)
    if (built) made++
  }
}

if (buildings.length < 130) fail(`only ${buildings.length} buildings generated (need >= 130)`)

/* ------------------------------------------------------------------ *
 * 9. Occupancy scaling and shelter capacities
 * ------------------------------------------------------------------ */

const OCCUPANCY_TARGET = 2900

{
  let rawTotal = 0
  for (const b of buildings) rawTotal += b._raw
  if (rawTotal <= 0) fail('total raw occupancy is zero')
  const scale = OCCUPANCY_TARGET / rawTotal
  let total = 0
  for (const b of buildings) {
    b.occupancy = Math.max(1, Math.round(b._raw * scale))
    total += b.occupancy
  }
  // Nudge the largest buildings until the total lands inside the required band.
  const byOccupancy = [...buildings].sort((a, b) => b.occupancy - a.occupancy)
  let cursor = 0
  let guard = 0
  while ((total < 2750 || total > 3050) && guard < 200000) {
    guard++
    const b = byOccupancy[cursor % byOccupancy.length]
    cursor++
    if (total > 3050) {
      if (b.occupancy > 2) {
        b.occupancy--
        total--
      }
    } else if (b.occupancy < 400) {
      b.occupancy++
      total++
    }
  }
  if (total < 2600 || total > 3200) fail(`total occupancy ${total} outside [2600, 3200]`)
}

const totalOccupancy = buildings.reduce((a, b) => a + b.occupancy, 0)

{
  const weightSum = shelters.reduce((a, s) => a + s._weight, 0)
  const capacityTarget = Math.round(totalOccupancy * 0.65)
  let assigned = 0
  for (const s of shelters) {
    s.capacity = Math.max(40, Math.round((capacityTarget * s._weight) / weightSum))
    assigned += s.capacity
  }
  // Absorb the rounding drift in the largest shelter.
  const biggest = shelters.reduce((a, b) => (b.capacity > a.capacity ? b : a), shelters[0])
  biggest.capacity += capacityTarget - assigned
  if (biggest.capacity < 40) fail('shelter capacity distribution collapsed')
}

/* ------------------------------------------------------------------ *
 * 10. Nearest road nodes
 * ------------------------------------------------------------------ */

for (const b of buildings) {
  const [d, node] = nearestNodeTo(b.position[0], b.position[1])
  if (!node) fail(`no road node found for building ${b.id}`)
  if (d > 120) fail(`building ${b.id} is ${d.toFixed(1)} m from the nearest road node`)
  b.nearestRoadNodeId = node.id
}

/* ------------------------------------------------------------------ *
 * 11. Bounds, ground zones, scenario
 * ------------------------------------------------------------------ */

const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }
function extend(x, z) {
  if (x < bounds.minX) bounds.minX = x
  if (x > bounds.maxX) bounds.maxX = x
  if (z < bounds.minZ) bounds.minZ = z
  if (z > bounds.maxZ) bounds.maxZ = z
}
for (const n of nodes) extend(n.x, n.z)
for (const rect of placedRects) {
  extend(rect.cx - rect.hx, rect.cz - rect.hz)
  extend(rect.cx + rect.hx, rect.cz + rect.hz)
}
const MARGIN = 60
const meta = {
  name: 'AOBA CITY',
  version: '1.0.0',
  generatedBy: 'scripts/generate-city.mjs',
  bounds: {
    minX: r2(bounds.minX - MARGIN),
    maxX: r2(bounds.maxX + MARGIN),
    minZ: r2(bounds.minZ - MARGIN),
    maxZ: r2(bounds.maxZ + MARGIN),
  },
  simulationSeed: SEED,
}

/** Irregular polygon around an axis-aligned rectangle. */
function jaggedRect(x0, z0, x1, z1, spacing, wobble) {
  const pts = []
  const push = (x, z) => pts.push([r2(x), r2(z)])
  const along = (ax, az, bx, bz) => {
    const len = dist(ax, az, bx, bz)
    const steps = Math.max(1, Math.round(len / spacing))
    for (let i = 0; i < steps; i++) {
      const t = i / steps
      const nx = -(bz - az) / (len || 1)
      const nz = (bx - ax) / (len || 1)
      const w = i === 0 ? 0 : rng.range(-wobble, wobble)
      push(lerp(ax, bx, t) + nx * w, lerp(az, bz, t) + nz * w)
    }
  }
  along(x0, z0, x1, z0)
  along(x1, z0, x1, z1)
  along(x1, z1, x0, z1)
  along(x0, z1, x0, z0)
  return pts
}

/** Polygon following the river centreline, offset by +/- `half` metres. */
function riverCorridor(half) {
  const north = []
  const south = []
  for (let i = 0; i <= 16; i++) {
    const x = lerp(meta.bounds.minX - 40, meta.bounds.maxX + 40, i / 16)
    const z = riverZ(x)
    const w = rng.range(-12, 12)
    north.push([r2(x), r2(z - half + w)])
    south.push([r2(x), r2(z + half + rng.range(-12, 12))])
  }
  south.reverse()
  return north.concat(south)
}

const groundZones = [
  {
    id: 'gz-river',
    name: 'Aoba River Corridor',
    groundType: 'reclaimed',
    amplification: 1.7,
    polygon: riverCorridor(95),
  },
  {
    id: 'gz-minato',
    name: 'Minato Reclaimed Land',
    groundType: 'reclaimed',
    amplification: 1.7,
    polygon: jaggedRect(
      meta.bounds.minX - 30,
      300,
      meta.bounds.maxX + 30,
      meta.bounds.maxZ + 30,
      150,
      26,
    ),
  },
  {
    id: 'gz-kawakita',
    name: 'Kawakita Alluvial Flat',
    groundType: 'soft',
    amplification: 1.35,
    polygon: jaggedRect(meta.bounds.minX - 30, -20, meta.bounds.maxX + 30, 320, 150, 24),
  },
  {
    id: 'gz-shitamachi',
    name: 'Shitamachi Lowland',
    groundType: 'soft',
    amplification: 1.35,
    polygon: jaggedRect(meta.bounds.minX - 30, -300, -150, -20, 130, 22),
  },
  {
    id: 'gz-aoyama',
    name: 'Aoyama Terrace',
    groundType: 'rock',
    amplification: 0.75,
    polygon: jaggedRect(meta.bounds.minX - 30, meta.bounds.minZ - 30, 160, -330, 150, 26),
  },
  {
    id: 'gz-plain',
    name: 'Aoba Plain',
    groundType: 'medium',
    amplification: 1.0,
    polygon: [
      [r2(meta.bounds.minX - 40), r2(meta.bounds.minZ - 40)],
      [r2(meta.bounds.maxX + 40), r2(meta.bounds.minZ - 40)],
      [r2(meta.bounds.maxX + 40), r2(meta.bounds.maxZ + 40)],
      [r2(meta.bounds.minX - 40), r2(meta.bounds.maxZ + 40)],
    ],
  },
]

const disasterScenarios = [
  {
    id: 'aoba-offshore',
    type: 'earthquake',
    name: 'Aoba Offshore Earthquake',
    epicenter: [140, 620],
    depthKm: 12,
    magnitude: 7.1,
    baseIntensity: 1.0,
    intensityFalloff: 0.0011,
    durationSeconds: 40,
    aftershocks: [{ time: 180, intensityScale: 0.35 }],
  },
]

/* ------------------------------------------------------------------ *
 * 12. Assemble
 * ------------------------------------------------------------------ */

function nodeKind(degree) {
  if (degree >= 3) return 'intersection'
  if (degree <= 1) return 'endpoint'
  return 'waypoint'
}

const city = {
  meta,
  districts: districts.map((d) => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    center: [r2(d.center[0]), r2(d.center[1])],
    radius: d.radius,
  })),
  groundZones,
  roadNetwork: {
    nodes: nodes.map((n) => ({
      id: n.id,
      position: [r2(n.x), r2(n.z)],
      kind: nodeKind(n.degree),
    })),
    edges: edges.map((e) => {
      const a = nodeById.get(e.from)
      const b = nodeById.get(e.to)
      return {
        id: e.id,
        from: e.from,
        to: e.to,
        width: e.width,
        roadClass: e.roadClass,
        lanes: Math.max(1, Math.round(e.width / 3.2)),
        length: r2(dist(a.x, a.z, b.x, b.z)),
      }
    }),
  },
  buildings: buildings.map((b) => {
    const out = { ...b }
    delete out._raw
    return out
  }),
  shelters: shelters.map((s) => {
    const out = { ...s }
    delete out._weight
    return out
  }),
  disasterScenarios,
}

/* ------------------------------------------------------------------ *
 * 13. Self-verification
 * ------------------------------------------------------------------ */

function verify() {
  const n = city.roadNetwork.nodes
  const e = city.roadNetwork.edges
  if (n.length < 140) fail(`only ${n.length} road nodes (need >= 140)`)
  if (e.length < 200) fail(`only ${e.length} road edges (need >= 200)`)
  if (city.buildings.length < 130) fail(`only ${city.buildings.length} buildings (need >= 130)`)

  // --- road graph fully connected (BFS) ---
  const indexOf = new Map()
  n.forEach((node, i) => indexOf.set(node.id, i))
  const adjacency = n.map(() => [])
  for (const edge of e) {
    const a = indexOf.get(edge.from)
    const b = indexOf.get(edge.to)
    if (a === undefined || b === undefined) fail(`edge ${edge.id} references an unknown node`)
    if (!(edge.length > 0)) fail(`edge ${edge.id} has non-positive length`)
    adjacency[a].push(b)
    adjacency[b].push(a)
  }
  const seen = new Uint8Array(n.length)
  const queue = [0]
  seen[0] = 1
  let reached = 1
  while (queue.length > 0) {
    const cur = queue.pop()
    for (const nb of adjacency[cur]) {
      if (!seen[nb]) {
        seen[nb] = 1
        reached++
        queue.push(nb)
      }
    }
  }
  if (reached !== n.length) {
    const orphan = n.find((_, i) => !seen[i])
    fail(`road graph is not fully connected: ${reached}/${n.length} nodes reachable (e.g. ${orphan.id})`)
  }

  // --- exactly the bridges cross the river ---
  const inRiver = (x, z) => Math.abs(z - riverZ(x)) < RIVER_HALF_WIDTH
  const posOf = new Map(n.map((node) => [node.id, node.position]))
  const crossing = []
  for (const edge of e) {
    const a = posOf.get(edge.from)
    const b = posOf.get(edge.to)
    let hit = false
    for (let i = 0; i <= 24; i++) {
      const t = i / 24
      if (inRiver(lerp(a[0], b[0], t), lerp(a[1], b[1], t))) {
        hit = true
        break
      }
    }
    if (hit) crossing.push(edge.id)
  }
  if (crossing.length !== bridgeEdgeIds.length) {
    fail(`${crossing.length} edges cross the river, expected ${bridgeEdgeIds.length} bridges`)
  }
  for (const id of crossing) {
    if (!bridgeEdgeIds.includes(id)) fail(`non-bridge edge ${id} crosses the river`)
  }

  // --- buildings near a road node, non-overlapping, off the carriageway ---
  const nodeList = n.map((node) => node.position)
  for (const b of city.buildings) {
    let best = Infinity
    for (const p of nodeList) {
      const d = dist(b.position[0], b.position[1], p[0], p[1])
      if (d < best) best = d
    }
    if (best > 120) fail(`building ${b.id} is ${best.toFixed(1)} m from the nearest road node`)
    const clearance = roadClearance(
      b.position[0],
      b.position[1],
      b.rotation,
      b.footprint.width,
      b.footprint.depth,
    )
    if (clearance < 0) {
      fail(`building ${b.id} overlaps a road carriageway (clearance ${clearance.toFixed(2)} m)`)
    }
  }

  const boxes = city.buildings.map((b) => {
    const [hx, hz] = rotatedHalfExtents(b.footprint.width, b.footprint.depth, b.rotation)
    return { id: b.id, cx: b.position[0], cz: b.position[1], hx, hz }
  })
  const checkGrid = makeGrid(45)
  for (const box of boxes) {
    for (const other of checkGrid.queryRect(box.cx, box.cz, box.hx + 40, box.hz + 40)) {
      if (aabbOverlap(box, other, 0)) fail(`buildings ${box.id} and ${other.id} overlap`)
    }
    checkGrid.insertRect(box.cx, box.cz, box.hx, box.hz, box)
  }

  // --- shelters ---
  let capacity = 0
  for (const s of city.shelters) {
    let best = Infinity
    for (const p of nodeList) {
      const d = dist(s.position[0], s.position[1], p[0], p[1])
      if (d < best) best = d
    }
    if (best > 60) fail(`shelter ${s.id} is ${best.toFixed(1)} m from the nearest road node`)
    if (!Number.isInteger(s.capacity) || s.capacity < 1) fail(`shelter ${s.id} has a bad capacity`)
    if (!indexOf.has(s.roadNodeId)) fail(`shelter ${s.id} references unknown node ${s.roadNodeId}`)
    capacity += s.capacity
  }
  if (city.shelters.length < 8 || city.shelters.length > 10) {
    fail(`expected 8-10 shelters, got ${city.shelters.length}`)
  }
  const ratio = capacity / totalOccupancy
  if (ratio < 0.6 || ratio > 0.7) {
    fail(`shelter capacity ratio ${ratio.toFixed(3)} outside [0.60, 0.70]`)
  }

  // --- occupancy and per-building sanity ---
  let occupancy = 0
  for (const b of city.buildings) {
    if (!Number.isInteger(b.occupancy) || b.occupancy < 1) fail(`building ${b.id} has a bad occupancy`)
    occupancy += b.occupancy
    const p = b.populationProfile
    const sum = p.child + p.adult + p.elderly + p.mobilityImpaired
    if (Math.abs(sum - 1) > 1e-6) fail(`building ${b.id} population profile sums to ${sum}`)
    for (const key of ['child', 'adult', 'elderly', 'mobilityImpaired']) {
      if (p[key] < 0) fail(`building ${b.id} has a negative ${key} fraction`)
    }
    if (b.seismicResistance < 0 || b.seismicResistance > 1) {
      fail(`building ${b.id} seismicResistance out of range`)
    }
    if (b.collapseThreshold < 0.5 || b.collapseThreshold > 1) {
      fail(`building ${b.id} collapseThreshold out of range`)
    }
    if (!(b.replacementValue > 0)) fail(`building ${b.id} has a non-positive replacementValue`)
    if (!indexOf.has(b.nearestRoadNodeId)) {
      fail(`building ${b.id} references unknown node ${b.nearestRoadNodeId}`)
    }
    if (b.height <= 0 || b.floors < 1) fail(`building ${b.id} has bad height/floors`)
  }
  if (occupancy < 2600 || occupancy > 3200) fail(`total occupancy ${occupancy} outside [2600, 3200]`)

  // --- ground zones ---
  if (city.groundZones.length < 5 || city.groundZones.length > 6) {
    fail(`expected 5-6 ground zones, got ${city.groundZones.length}`)
  }
  for (const z of city.groundZones) {
    if (!Array.isArray(z.polygon) || z.polygon.length < 3) fail(`ground zone ${z.id} has no polygon`)
  }
  // Every building must land inside at least one zone.
  const inside = (p, poly) => {
    let hit = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0]
      const zi = poly[i][1]
      const xj = poly[j][0]
      const zj = poly[j][1]
      if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi || 1e-9) + xi) {
        hit = !hit
      }
    }
    return hit
  }
  for (const b of city.buildings) {
    if (!city.groundZones.some((z) => inside(b.position, z.polygon))) {
      fail(`building ${b.id} is not covered by any ground zone`)
    }
  }

  // --- scenario ---
  const quake = city.disasterScenarios.find((s) => s.type === 'earthquake')
  if (!quake) fail('no earthquake scenario')

  return { occupancy, capacity, ratio, crossing }
}

// --- deep scan for NaN / undefined / null in disallowed places ---
function scanValues(value, path) {
  if (value === undefined) fail(`undefined value at ${path}`)
  if (value === null) {
    if (path.endsWith('.districtId') || path.endsWith('.nearestRoadNodeId') || path.endsWith('.roadNodeId')) {
      return
    }
    fail(`unexpected null at ${path}`)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`non-finite number at ${path}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanValues(item, `${path}[${i}]`))
    return
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) scanValues(value[key], `${path}.${key}`)
  }
}

const summary = verify()
scanValues(city, 'city')

const roundTripped = JSON.parse(JSON.stringify(city))
scanValues(roundTripped, 'roundTrip')
if (roundTripped.buildings.length !== city.buildings.length) fail('round-trip lost buildings')
if (roundTripped.roadNetwork.edges.length !== city.roadNetwork.edges.length) {
  fail('round-trip lost road edges')
}

/* ------------------------------------------------------------------ *
 * 14. Compact pretty-printer (2-space indent, small objects inlined)
 * ------------------------------------------------------------------ */

const INLINE_LIMIT = 640

function inlineOf(value) {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number' || t === 'boolean' || t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    const parts = []
    for (const item of value) {
      const s = inlineOf(item)
      if (s === null) return null
      parts.push(s)
    }
    return `[${parts.join(', ')}]`
  }
  if (t === 'object') {
    const parts = []
    for (const key of Object.keys(value)) {
      const s = inlineOf(value[key])
      if (s === null) return null
      parts.push(`${JSON.stringify(key)}: ${s}`)
    }
    return `{ ${parts.join(', ')} }`
  }
  return null
}

function pretty(value, indent) {
  const pad = '  '.repeat(indent)
  const padInner = '  '.repeat(indent + 1)
  if (value === null || typeof value !== 'object') return JSON.stringify(value)

  const flat = inlineOf(value)
  if (flat !== null && flat.length + pad.length <= INLINE_LIMIT) return flat

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((item) => padInner + pretty(item, indent + 1))
    return `[\n${items.join(',\n')}\n${pad}]`
  }
  const keys = Object.keys(value)
  if (keys.length === 0) return '{}'
  const items = keys.map((key) => `${padInner}${JSON.stringify(key)}: ${pretty(value[key], indent + 1)}`)
  return `{\n${items.join(',\n')}\n${pad}}`
}

mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, `${pretty(city, 0)}\n`, 'utf8')

/* ------------------------------------------------------------------ *
 * 15. Report
 * ------------------------------------------------------------------ */

const useCounts = {}
for (const b of city.buildings) useCounts[b.use] = (useCounts[b.use] ?? 0) + 1
const classCounts = {}
for (const e of city.roadNetwork.edges) classCounts[e.roadClass] = (classCounts[e.roadClass] ?? 0) + 1

const lines = [
  `AOBA CITY written to ${OUT_PATH}`,
  `  bounds          ${meta.bounds.minX} .. ${meta.bounds.maxX} x  ${meta.bounds.minZ} .. ${meta.bounds.maxZ} z` +
    `  (${r2(meta.bounds.maxX - meta.bounds.minX)} x ${r2(meta.bounds.maxZ - meta.bounds.minZ)} m)`,
  `  road nodes      ${city.roadNetwork.nodes.length}`,
  `  road edges      ${city.roadNetwork.edges.length}  (${Object.entries(classCounts)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')})`,
  `  bridges         ${summary.crossing.length}  [${summary.crossing.join(', ')}]`,
  `  buildings       ${city.buildings.length}`,
  `  by use          ${Object.entries(useCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')}`,
  `  total occupancy ${summary.occupancy}`,
  `  shelters        ${city.shelters.length}`,
  `  shelter capacity ${summary.capacity}  (${(summary.ratio * 100).toFixed(1)}% of occupancy)`,
  `  ground zones    ${city.groundZones.length}`,
  `  districts       ${city.districts.length}`,
  `  scenario        ${city.disasterScenarios[0].id} M${city.disasterScenarios[0].magnitude}`,
]
process.stdout.write(`${lines.join('\n')}\n`)
