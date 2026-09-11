/**
 * §13 — procedural building geometry.
 *
 * Every building is baked, once, into a single non-indexed `BufferGeometry`
 * carrying `position`, `normal` and `color`. There are no textures and no
 * per-window meshes: windows, signage bands, mullions and helipad markings are
 * all vertex-coloured quads pushed a few centimetres proud of the wall they sit
 * on. That keeps a 130-building city at a few hundred draw calls of very cheap
 * geometry while still reading as a distinct town from an oblique overhead
 * camera.
 *
 * Conventions for everything in this file:
 *   - the origin is the footprint centre, the base sits at y = 0,
 *   - the geometry is **unrotated** — the mesh carries the building's heading,
 *   - local +X is the footprint width, local +Z is the footprint depth,
 *   - all randomness comes from a stream keyed on (seed, building id), so the
 *     same city always bakes to the same skyline.
 */

import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage } from 'three'
import type { Building, BuildingUse } from '../types/city'
import type { DamageState } from '../types/simulation'
import { Rng, hashString, mixSeed } from '../simulation/rng'
import {
  RUBBLE_COLOR,
  WINDOW_COLOR,
  WINDOW_DARK_COLOR,
  createTintTransform,
  damageTintTransform,
  roofColorFor,
  wallColorFor,
} from './palette'

export interface BuildingGeometryResult {
  /** Origin at footprint centre, base at y = 0. */
  geometry: BufferGeometry
  /** Untinted vertex colours, so damage tinting can be re-derived. */
  baseColors: Float32Array
  /** Rough bounding height, for the collapse animation. */
  height: number
}

/* ------------------------------------------------------------------ *
 * Mesh accumulator
 * ------------------------------------------------------------------ */

interface MeshBuilder {
  pos: number[]
  nor: number[]
  col: number[]
  maxY: number
}

function createBuilder(): MeshBuilder {
  return { pos: [], nor: [], col: [], maxY: 0 }
}

function vertexCount(mb: MeshBuilder): number {
  return mb.pos.length / 3
}

function pushVertex(
  mb: MeshBuilder,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  c: Color,
): void {
  mb.pos.push(x, y, z)
  mb.nor.push(nx, ny, nz)
  mb.col.push(c.r, c.g, c.b)
  if (y > mb.maxY) mb.maxY = y
}

/** Triangle with an explicit face normal. */
function triN(
  mb: MeshBuilder,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  nx: number,
  ny: number,
  nz: number,
  c: Color,
): void {
  pushVertex(mb, ax, ay, az, nx, ny, nz, c)
  pushVertex(mb, bx, by, bz, nx, ny, nz, c)
  pushVertex(mb, cx, cy, cz, nx, ny, nz, c)
}

const normalScratch = [0, 1, 0]

function faceNormal(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): void {
  const ux = bx - ax
  const uy = by - ay
  const uz = bz - az
  const vx = cx - ax
  const vy = cy - ay
  const vz = cz - az
  let nx = uy * vz - uz * vy
  let ny = uz * vx - ux * vz
  let nz = ux * vy - uy * vx
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
  if (len > 1e-9) {
    nx /= len
    ny /= len
    nz /= len
  } else {
    // Degenerate face (a zero-area sliver): fall back to "up" rather than NaN.
    nx = 0
    ny = 1
    nz = 0
  }
  normalScratch[0] = nx
  normalScratch[1] = ny
  normalScratch[2] = nz
}

/** Triangle with a derived face normal. */
function tri(
  mb: MeshBuilder,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  c: Color,
): void {
  faceNormal(ax, ay, az, bx, by, bz, cx, cy, cz)
  triN(mb, ax, ay, az, bx, by, bz, cx, cy, cz, normalScratch[0], normalScratch[1], normalScratch[2], c)
}

/** Planar quad (a, b, c, d wound counter-clockwise) with an explicit normal. */
function quadN(
  mb: MeshBuilder,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  dx: number,
  dy: number,
  dz: number,
  nx: number,
  ny: number,
  nz: number,
  c: Color,
): void {
  triN(mb, ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, c)
  triN(mb, ax, ay, az, cx, cy, cz, dx, dy, dz, nx, ny, nz, c)
}

/** Planar quad with a derived normal. */
function quad(
  mb: MeshBuilder,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  dx: number,
  dy: number,
  dz: number,
  c: Color,
): void {
  faceNormal(ax, ay, az, bx, by, bz, cx, cy, cz)
  quadN(
    mb,
    ax, ay, az,
    bx, by, bz,
    cx, cy, cz,
    dx, dy, dz,
    normalScratch[0], normalScratch[1], normalScratch[2],
    c,
  )
}

/** Axis-aligned box, centred on (cx, cy, cz). 12 triangles. */
function box(
  mb: MeshBuilder,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  c: Color,
): void {
  if (!(sx > 0) || !(sy > 0) || !(sz > 0)) return
  const x0 = cx - sx * 0.5
  const x1 = cx + sx * 0.5
  const y0 = cy - sy * 0.5
  const y1 = cy + sy * 0.5
  const z0 = cz - sz * 0.5
  const z1 = cz + sz * 0.5
  quadN(mb, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, c)
  quadN(mb, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, c)
  quadN(mb, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, c)
  quadN(mb, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, c)
  quadN(mb, x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, c)
  quadN(mb, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, c)
}

/** Box yawed about its own centre. Used for rubble chunks and helipad rings. */
function yawedBox(
  mb: MeshBuilder,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  yaw: number,
  c: Color,
): void {
  if (!(sx > 0) || !(sy > 0) || !(sz > 0)) return
  const ca = Math.cos(yaw)
  const sa = Math.sin(yaw)
  const hx = sx * 0.5
  const hz = sz * 0.5
  const y0 = cy - sy * 0.5
  const y1 = cy + sy * 0.5
  // Corners ordered so that the side quads wind outwards (see quad winding).
  const lx = [-hx, -hx, hx, hx]
  const lz = [-hz, hz, hz, -hz]
  const wx = [0, 0, 0, 0]
  const wz = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) {
    wx[i] = cx + lx[i] * ca + lz[i] * sa
    wz[i] = cz - lx[i] * sa + lz[i] * ca
  }
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3
    quad(mb, wx[i], y0, wz[i], wx[j], y0, wz[j], wx[j], y1, wz[j], wx[i], y1, wz[i], c)
  }
  quad(mb, wx[0], y1, wz[0], wx[1], y1, wz[1], wx[2], y1, wz[2], wx[3], y1, wz[3], c)
  quad(mb, wx[3], y0, wz[3], wx[2], y0, wz[2], wx[1], y0, wz[1], wx[0], y0, wz[0], c)
}

/** Horizontal quad facing up — roof decks, helipad markings, plaza slabs. */
function deck(
  mb: MeshBuilder,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sz: number,
  c: Color,
): void {
  if (!(sx > 0) || !(sz > 0)) return
  const x0 = cx - sx * 0.5
  const x1 = cx + sx * 0.5
  const z0 = cz - sz * 0.5
  const z1 = cz + sz * 0.5
  quadN(mb, x0, cy, z1, x1, cy, z1, x1, cy, z0, x0, cy, z0, 0, 1, 0, c)
}

/**
 * Rotates every vertex pushed since `from` about the Y axis. Rotation preserves
 * handedness, so windings (and therefore normals) stay valid — which is what
 * lets the roof / wing builders below be written for one orientation only.
 */
/** Shifts every vertex pushed since `from` along X — used to place wings. */
function translateXSince(mb: MeshBuilder, from: number, dx: number): void {
  for (let i = from * 3; i < mb.pos.length; i += 3) mb.pos[i] += dx
}

function rotateSince(mb: MeshBuilder, from: number, angle: number): void {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  for (let i = from * 3; i < mb.pos.length; i += 3) {
    const x = mb.pos[i]
    const z = mb.pos[i + 2]
    mb.pos[i] = x * c + z * s
    mb.pos[i + 2] = -x * s + z * c
    const nx = mb.nor[i]
    const nz = mb.nor[i + 2]
    mb.nor[i] = nx * c + nz * s
    mb.nor[i + 2] = -nx * s + nz * c
  }
}

/* ------------------------------------------------------------------ *
 * Wall detailing
 * ------------------------------------------------------------------ */

/** How far a window / band sits proud of its wall, metres. */
const PROUD = 0.06

/** Face ids for `panel`: 0 = +Z, 1 = -Z, 2 = +X, 3 = -X. */
function panel(
  mb: MeshBuilder,
  side: number,
  wallOffset: number,
  u: number,
  y: number,
  uSize: number,
  ySize: number,
  c: Color,
  proud: number = PROUD,
): void {
  if (!(uSize > 0) || !(ySize > 0)) return
  const o = wallOffset + proud
  const y0 = y - ySize * 0.5
  const y1 = y + ySize * 0.5
  const u0 = u - uSize * 0.5
  const u1 = u + uSize * 0.5
  if (side === 0) quadN(mb, u0, y0, o, u1, y0, o, u1, y1, o, u0, y1, o, 0, 0, 1, c)
  else if (side === 1) quadN(mb, u1, y0, -o, u0, y0, -o, u0, y1, -o, u1, y1, -o, 0, 0, -1, c)
  else if (side === 2) quadN(mb, o, y0, u1, o, y0, u0, o, y1, u0, o, y1, u1, 1, 0, 0, c)
  else quadN(mb, -o, y0, u0, -o, y0, u1, -o, y1, u1, -o, y1, u0, -1, 0, 0, c)
}

/** One continuous horizontal band on all four faces. */
function bandAllSides(
  mb: MeshBuilder,
  w: number,
  d: number,
  y: number,
  height: number,
  margin: number,
  c: Color,
): void {
  const spanW = w - margin * 2
  const spanD = d - margin * 2
  if (spanW > 0.5) {
    panel(mb, 0, d * 0.5, 0, y, spanW, height, c)
    panel(mb, 1, d * 0.5, 0, y, spanW, height, c)
  }
  if (spanD > 0.5) {
    panel(mb, 2, w * 0.5, 0, y, spanD, height, c)
    panel(mb, 3, w * 0.5, 0, y, spanD, height, c)
  }
}

/** A row of discrete windows on one face, centred on `u`. */
function windowRow(
  mb: MeshBuilder,
  side: number,
  wallOffset: number,
  u: number,
  span: number,
  y: number,
  winH: number,
  cols: number,
  fill: number,
  c: Color,
): void {
  if (cols < 1 || !(span > 0) || !(winH > 0)) return
  const cell = span / cols
  const winW = cell * fill
  if (winW < 0.3) return
  const start = u - span * 0.5 + cell * 0.5
  for (let i = 0; i < cols; i++) panel(mb, side, wallOffset, start + i * cell, y, winW, winH, c)
}

/** Discrete windows on all four faces of a rectangular mass. */
function windowGridAllSides(
  mb: MeshBuilder,
  w: number,
  d: number,
  y: number,
  winH: number,
  fill: number,
  c: Color,
): void {
  const spanW = w - 2
  const spanD = d - 2
  const colsW = clampInt(Math.round(spanW / 3.4), 1, 14)
  const colsD = clampInt(Math.round(spanD / 3.4), 1, 14)
  if (spanW > 1) {
    windowRow(mb, 0, d * 0.5, 0, spanW, y, winH, colsW, fill, c)
    windowRow(mb, 1, d * 0.5, 0, spanW, y, winH, colsW, fill, c)
  }
  if (spanD > 1) {
    windowRow(mb, 2, w * 0.5, 0, spanD, y, winH, colsD, fill, c)
    windowRow(mb, 3, w * 0.5, 0, spanD, y, winH, colsD, fill, c)
  }
}

/** Thin vertical strips on all four faces — the tower "mullion" read. */
function mullionsAllSides(
  mb: MeshBuilder,
  w: number,
  d: number,
  y0: number,
  y1: number,
  strips: number,
  c: Color,
): void {
  const h = y1 - y0
  if (!(h > 0) || strips < 1) return
  const yc = (y0 + y1) * 0.5
  const stepW = w / (strips + 1)
  const stepD = d / (strips + 1)
  for (let i = 1; i <= strips; i++) {
    const ux = -w * 0.5 + stepW * i
    const uz = -d * 0.5 + stepD * i
    panel(mb, 0, d * 0.5, ux, yc, 0.4, h, c, PROUD * 2)
    panel(mb, 1, d * 0.5, ux, yc, 0.4, h, c, PROUD * 2)
    panel(mb, 2, w * 0.5, uz, yc, 0.4, h, c, PROUD * 2)
    panel(mb, 3, w * 0.5, uz, yc, 0.4, h, c, PROUD * 2)
  }
}

/** Four thin boxes forming a roof parapet. */
function parapetRing(
  mb: MeshBuilder,
  w: number,
  d: number,
  y0: number,
  h: number,
  t: number,
  c: Color,
): void {
  if (!(h > 0) || !(t > 0) || w <= t * 2 || d <= t * 2) return
  const cy = y0 + h * 0.5
  box(mb, 0, cy, d * 0.5 - t * 0.5, w, h, t, c)
  box(mb, 0, cy, -d * 0.5 + t * 0.5, w, h, t, c)
  box(mb, w * 0.5 - t * 0.5, cy, 0, t, h, d - t * 2, c)
  box(mb, -w * 0.5 + t * 0.5, cy, 0, t, h, d - t * 2, c)
}

/* ------------------------------------------------------------------ *
 * Roofs
 * ------------------------------------------------------------------ */

/**
 * Gable roof with overhanging eaves. Built with the ridge along X, then yawed
 * a quarter turn when the footprint is deeper than it is wide.
 */
function gableRoof(
  mb: MeshBuilder,
  y0: number,
  w: number,
  d: number,
  roofH: number,
  overhang: number,
  c: Color,
): void {
  const alongX = w >= d
  const start = vertexCount(mb)
  const ow = (alongX ? w : d) * 0.5 + overhang
  const od = (alongX ? d : w) * 0.5 + overhang
  const y1 = y0 + roofH
  quad(mb, -ow, y0, od, ow, y0, od, ow, y1, 0, -ow, y1, 0, c)
  quad(mb, ow, y0, -od, -ow, y0, -od, -ow, y1, 0, ow, y1, 0, c)
  tri(mb, ow, y0, od, ow, y0, -od, ow, y1, 0, c)
  tri(mb, -ow, y0, -od, -ow, y0, od, -ow, y1, 0, c)
  quadN(mb, -ow, y0, -od, ow, y0, -od, ow, y0, od, -ow, y0, od, 0, -1, 0, c)
  if (!alongX) rotateSince(mb, start, Math.PI * 0.5)
}

/** Hip roof: two trapezoids and two triangles, with eaves. */
function hipRoof(
  mb: MeshBuilder,
  y0: number,
  w: number,
  d: number,
  roofH: number,
  overhang: number,
  c: Color,
): void {
  const alongX = w >= d
  const start = vertexCount(mb)
  const ow = (alongX ? w : d) * 0.5 + overhang
  const od = (alongX ? d : w) * 0.5 + overhang
  const y1 = y0 + roofH
  const r = Math.max(0.4, ow * 0.34)
  quad(mb, -ow, y0, od, ow, y0, od, r, y1, 0, -r, y1, 0, c)
  quad(mb, ow, y0, -od, -ow, y0, -od, -r, y1, 0, r, y1, 0, c)
  tri(mb, ow, y0, od, ow, y0, -od, r, y1, 0, c)
  tri(mb, -ow, y0, -od, -ow, y0, od, -r, y1, 0, c)
  quadN(mb, -ow, y0, -od, ow, y0, -od, ow, y0, od, -ow, y0, od, 0, -1, 0, c)
  if (!alongX) rotateSince(mb, start, Math.PI * 0.5)
}

/** Single-pitch roof rising toward +X. */
function monoRoof(
  mb: MeshBuilder,
  y0: number,
  w: number,
  d: number,
  rise: number,
  overhang: number,
  c: Color,
): void {
  const ow = w * 0.5 + overhang
  const od = d * 0.5 + overhang
  const y1 = y0 + rise
  quad(mb, -ow, y0, od, ow, y1, od, ow, y1, -od, -ow, y0, -od, c)
  tri(mb, ow, y0, od, ow, y1, od, -ow, y0, od, c)
  tri(mb, ow, y1, -od, ow, y0, -od, -ow, y0, -od, c)
  quadN(mb, ow, y0, od, ow, y0, -od, ow, y1, -od, ow, y1, od, 1, 0, 0, c)
  quadN(mb, -ow, y0, -od, ow, y0, -od, ow, y0, od, -ow, y0, od, 0, -1, 0, c)
}

/* ------------------------------------------------------------------ *
 * Shared numeric helpers
 * ------------------------------------------------------------------ */

function clampNum(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return value < min ? min : value > max ? max : value
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clampNum(value, min, max))
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function shade(c: Color, f: number): Color {
  return new Color(clamp01(c.r * f), clamp01(c.g * f), clamp01(c.b * f))
}

function mix(a: Color, b: Color, t: number): Color {
  const k = clamp01(t)
  return new Color(
    a.r + (b.r - a.r) * k,
    a.g + (b.g - a.g) * k,
    a.b + (b.b - a.b) * k,
  )
}

/* ------------------------------------------------------------------ *
 * Archetypes
 * ------------------------------------------------------------------ */

interface Shell {
  w: number
  d: number
  h: number
  floors: number
  rng: Rng
  /** Body / wall colour. */
  wall: Color
  /** Roof, parapet, cornice. */
  roof: Color
  /** Regular glazing. */
  glass: Color
  /** Recessed glazing — shopfronts, loading doors, north lights. */
  glassDark: Color
  /** Slightly darker wall — ledges, canopies, signage. */
  trim: Color
  /** Slightly lighter wall — the setback / podium read. */
  light: Color
}

type Archetype =
  | 'house'
  | 'apartment'
  | 'office'
  | 'commercial'
  | 'school'
  | 'hospital'
  | 'factory'
  | 'station'
  | 'civic'
  | 'temple'
  | 'parking'

function archetypeFor(use: BuildingUse, floors: number, wooden: boolean): Archetype {
  switch (use) {
    case 'residential':
      return floors <= 3 && wooden ? 'house' : 'apartment'
    case 'apartment':
      return 'apartment'
    case 'office':
      return 'office'
    case 'commercial':
    case 'retail':
      // A 16-storey department store reads as a tower, not as a shopping strip.
      return floors >= 8 ? 'office' : 'commercial'
    case 'school':
      return 'school'
    case 'hospital':
      return 'hospital'
    case 'factory':
      return 'factory'
    case 'station':
      return 'station'
    case 'civic':
      return 'civic'
    case 'temple':
      return 'temple'
    case 'parking':
      return 'parking'
    default:
      return 'apartment'
  }
}

/** Wooden house, 1–3 floors: gable or hip roof, deep eaves, entry porch. */
function buildHouse(mb: MeshBuilder, s: Shell, hip: boolean): void {
  const roofH = clampNum(s.h * 0.32, 1.3, 3.6)
  const bodyH = Math.max(s.h - roofH, 2.2)
  box(mb, 0, bodyH * 0.5, 0, s.w, bodyH, s.d, s.wall)

  const bands = clampInt(s.floors, 1, 3)
  const floorH = bodyH / bands
  const winH = Math.min(1.3, floorH * 0.42)
  for (let i = 0; i < bands; i++) {
    windowGridAllSides(mb, s.w, s.d, i * floorH + floorH * 0.56, winH, 0.5, s.glass)
  }

  const overhang = Math.min(0.6, Math.min(s.w, s.d) * 0.06) + 0.25
  if (hip) hipRoof(mb, bodyH, s.w, s.d, roofH, overhang, s.roof)
  else gableRoof(mb, bodyH, s.w, s.d, roofH, overhang, s.roof)

  // Entry porch on the +Z face.
  const porchW = Math.min(s.w * 0.34, 3.8)
  const porchD = 1.5
  const porchH = Math.min(2.5, bodyH * 0.85)
  const porchX = (s.rng.next() - 0.5) * Math.max(0, s.w - porchW - 1.4)
  box(mb, porchX, porchH * 0.5, s.d * 0.5 + porchD * 0.5, porchW, porchH, porchD, s.wall)
  box(mb, porchX, porchH + 0.14, s.d * 0.5 + porchD * 0.5, porchW + 0.7, 0.28, porchD + 0.7, s.roof)
  panel(mb, 0, s.d * 0.5 + porchD, porchX, 1.05, Math.min(1.1, porchW * 0.4), 2.05, s.glassDark)
}

/** RC mid-rise: flat roof, parapet, window band per floor, balconies, core. */
function buildApartment(mb: MeshBuilder, s: Shell): void {
  const variant = s.rng.int(0, 2)
  const parapetH = 0.85
  const bodyH = Math.max(s.h - parapetH, 2.6)
  const stepped = variant === 2 && s.floors >= 4
  const shoulder = stepped ? bodyH * 0.74 : bodyH
  box(mb, 0, shoulder * 0.5, 0, s.w, shoulder, s.d, s.wall)
  deck(mb, 0, shoulder + 0.04, 0, s.w - 0.4, s.d - 0.4, shade(s.roof, 0.86))
  parapetRing(mb, s.w, s.d, shoulder, parapetH, 0.34, s.roof)
  if (stepped) {
    box(mb, 0, (shoulder + bodyH) / 2, 0, s.w * 0.67, bodyH - shoulder, s.d * 0.76, s.light)
    deck(mb, 0, bodyH + 0.04, 0, s.w * 0.67, s.d * 0.76, s.roof)
  }

  const floors = clampInt(s.floors, 1, 24)
  const floorH = bodyH / floors
  const winH = Math.min(1.6, floorH * 0.44)
  for (let i = 0; i < floors; i++) {
    const y = i * floorH + floorH * 0.58
    const w = stepped && y > shoulder ? s.w * 0.67 : s.w
    const d = stepped && y > shoulder ? s.d * 0.76 : s.d
    windowGridAllSides(mb, w, d, y, winH, variant === 0 ? 0.68 : 0.48, s.glass)
  }

  // Balcony ledges on the +Z face only — asymmetry reads well from above.
  const balconies = Math.min(floors - 1, 8)
  const ledgeW = Math.max(0, s.w * 0.74)
  for (let i = 1; i <= balconies; i++) {
    const y = i * floorH + 0.5
    if (stepped && y > shoulder) continue
    box(mb, 0, y, s.d * 0.5 + 0.65, ledgeW, 0.22, 1.5, s.trim)
    box(mb, 0, y + 0.68, s.d * 0.5 + 1.35, ledgeW, 0.85, 0.12, variant === 1 ? s.glass : s.light)
    for (let x = -ledgeW / 2 + 2.5; x < ledgeW / 2; x += 3.5)
      box(mb, x, y + 0.7, s.d * 0.5 + 0.6, 0.14, 1.2, 1.25, s.light)
  }

  const coreW = Math.min(s.w * 0.3, 5.5)
  const coreD = Math.min(s.d * 0.3, 5.5)
  box(
    mb,
    (stepped ? s.w * 0.33 : s.w * 0.5) - coreW * 0.5 - 0.8,
    bodyH + parapetH + 1.4,
    -(stepped ? s.d * 0.38 : s.d * 0.5) + coreD * 0.5 + 0.8,
    coreW,
    2.9,
    coreD,
    s.roof,
  )
}

/** Office: setbacks, mullions, glazed bands, a slim crown and an antenna. */
function buildOffice(mb: MeshBuilder, s: Shell): void {
  const tall = s.floors >= 9
  const variant = s.rng.int(0, 2)
  const curtain = variant === 1
  const crownH = Math.min(2.4, s.h * 0.06)
  const shaftH = Math.max(s.h - crownH, 3)
  const floors = clampInt(s.floors, 1, 40)

  // Segment table: [heightFraction, footprintScale].
  const segments: number[][] = curtain ? [[0.12, 1], [0.88, 0.88]] : variant === 2 ? [[0.82, 1], [0.18, 0.72]] : tall
    ? s.floors >= 15
      ? [[0.5, 1], [0.3, 0.84], [0.2, 0.68]]
      : [[0.66, 1], [0.34, 0.82]]
    : [[1, 1]]

  let y = 0
  let topW = s.w
  let topD = s.d
  // Bands are grouped once a tower is very tall so the count stays bounded.
  const bandStride = Math.max(1, Math.ceil(floors / 20))
  const floorH = shaftH / floors

  for (let si = 0; si < segments.length; si++) {
    const frac = segments[si][0]
    const scale = segments[si][1]
    const segH = shaftH * frac
    const sw = s.w * scale
    const sd = s.d * scale
    box(mb, 0, y + segH * 0.5, 0, sw, segH, sd, curtain && si > 0 ? s.glass : si === 0 ? s.wall : s.light)

    const first = Math.ceil(y / floorH)
    const last = Math.floor((y + segH) / floorH)
    for (let f = first; f < last; f += bandStride) {
      const by = f * floorH + floorH * 0.55
      if (by > y + 0.6 && by < y + segH - 0.6) {
        bandAllSides(mb, sw, sd, by, curtain ? 0.2 : Math.min(1.9, floorH * 0.56), 0.9, curtain ? s.trim : s.glass)
      }
    }
    mullionsAllSides(
      mb,
      sw,
      sd,
      y + 0.6,
      y + segH - 0.6,
      clampInt(sw / (curtain ? 3.6 : 5.5), 2, 12),
      shade(s.wall, 0.72),
    )

    y += segH
    topW = sw
    topD = sd
    // Cornice slab marking the setback.
    if (si < segments.length - 1) box(mb, 0, y - 0.25, 0, sw + 0.9, 0.5, sd + 0.9, s.roof)
  }

  parapetRing(mb, topW, topD, y, 0.8, 0.3, s.roof)
  box(mb, 0, y + crownH * 0.5, 0, topW * 0.5, crownH, topD * 0.5, s.roof)
  if (tall) {
    const antennaH = Math.min(14, s.h * 0.12 + 3)
    box(mb, 0, y + crownH + antennaH * 0.5, 0, 0.4, antennaH, 0.4, shade(s.roof, 0.6))
  }
}

/** Retail block: glazed ground floor, canopy, signage band, rooftop plant. */
function buildCommercial(mb: MeshBuilder, s: Shell): void {
  const parapetH = 0.7
  const bodyH = Math.max(s.h - parapetH, 3.2)
  const groundH = Math.min(4.4, bodyH * 0.55)
  box(mb, 0, bodyH * 0.5, 0, s.w, bodyH, s.d, s.wall)

  // Recessed shopfront glazing, then a canopy over the entrance side.
  bandAllSides(mb, s.w, s.d, groundH * 0.5, groundH * 0.7, 0.9, s.glassDark)
  box(mb, 0, groundH + 0.25, s.d * 0.5 + 0.8, s.w * 0.86, 0.35, 1.6, s.trim)

  const signY = Math.min(bodyH - 1.1, groundH + 1.2)
  if (signY > groundH + 0.4) {
    bandAllSides(mb, s.w, s.d, signY, 1.05, 1.8, mix(s.wall, new Color('#6f767b'), 0.55))
  }

  const floors = clampInt(s.floors, 1, 8)
  const floorH = bodyH / floors
  for (let i = 1; i < floors; i++) {
    bandAllSides(mb, s.w, s.d, i * floorH + floorH * 0.55, Math.min(1.6, floorH * 0.45), 1.4, s.glass)
  }

  deck(mb, 0, bodyH + 0.04, 0, s.w - 0.4, s.d - 0.4, shade(s.roof, 0.88))
  parapetRing(mb, s.w, s.d, bodyH, parapetH, 0.3, s.roof)

  const units = 2 + (s.rng.next() > 0.5 ? 1 : 0)
  const unitW = Math.min(3.2, s.w * 0.18)
  const unitD = Math.min(2.4, s.d * 0.18)
  for (let i = 0; i < units; i++) {
    const ux = (i - (units - 1) * 0.5) * (unitW + 1.4)
    box(mb, ux, bodyH + 0.85, -s.d * 0.22, unitW, 1.6, unitD, shade(s.roof, 0.82))
  }
}

/** School: long classroom slab, gym wing at one end, clock/vent tower. */
function buildSchool(mb: MeshBuilder, s: Shell): void {
  const alongX = s.w >= s.d
  const start = vertexCount(mb)
  const long = alongX ? s.w : s.d
  const across = alongX ? s.d : s.w

  const parapetH = 0.7
  const bodyH = Math.max(s.h - parapetH, 3.2)
  const gymLen = Math.min(long * 0.3, 26)
  const slabLen = Math.max(long - gymLen, long * 0.5)
  const slabCx = -long * 0.5 + slabLen * 0.5
  const gymCx = long * 0.5 - gymLen * 0.5
  const slabD = across

  box(mb, slabCx, bodyH * 0.5, 0, slabLen, bodyH, slabD, s.wall)

  const floors = clampInt(s.floors, 2, 5)
  const floorH = bodyH / floors
  const cols = clampInt(Math.round((slabLen - 3) / 3.4), 3, 16)
  const winH = Math.min(1.7, floorH * 0.5)
  for (let i = 0; i < floors; i++) {
    const y = i * floorH + floorH * 0.56
    windowRow(mb, 0, slabD * 0.5, slabCx, slabLen - 3, y, winH, cols, 0.62, s.glass)
    windowRow(mb, 1, slabD * 0.5, slabCx, slabLen - 3, y, winH, cols, 0.62, s.glass)
  }
  // The slab's exposed end gets a narrower stack of stairwell windows.
  windowRow(mb, 3, long * 0.5, 0, slabD - 3, bodyH * 0.5, bodyH * 0.6, 2, 0.35, s.glass)

  deck(mb, slabCx, bodyH + 0.04, 0, slabLen - 0.4, slabD - 0.4, shade(s.roof, 0.88))
  box(mb, slabCx, bodyH + parapetH * 0.5, slabD * 0.5 - 0.16, slabLen, parapetH, 0.32, s.roof)
  box(mb, slabCx, bodyH + parapetH * 0.5, -slabD * 0.5 + 0.16, slabLen, parapetH, 0.32, s.roof)

  // Gym wing — one tall volume with a shallow single-pitch roof.
  const gymH = bodyH * 0.9
  const gymD = across * 0.92
  box(mb, gymCx, gymH * 0.5, 0, gymLen, gymH, gymD, s.light)
  // monoRoof builds around the origin, so bake it then slide it onto the wing.
  const gymStart = vertexCount(mb)
  monoRoof(mb, gymH, gymLen, gymD, Math.max(1.2, bodyH * 0.16), 0.5, s.roof)
  translateXSince(mb, gymStart, gymCx)
  panel(mb, 0, gymD * 0.5, gymCx, gymH * 0.72, gymLen * 0.7, 1.5, s.glass)
  panel(mb, 1, gymD * 0.5, gymCx, gymH * 0.72, gymLen * 0.7, 1.5, s.glass)

  // Clock / vent tower on the slab roof, kept on the centreline so its faces
  // stay on the z = 0 planes that `panel` addresses.
  const towerS = Math.min(3.4, across * 0.3)
  const towerH = clampNum(bodyH * 0.38, 1.4, 5)
  const towerX = slabCx + slabLen * 0.3
  box(mb, towerX, bodyH + towerH * 0.5, 0, towerS, towerH, towerS, s.wall)
  box(mb, towerX, bodyH + towerH + 0.2, 0, towerS + 0.8, 0.4, towerS + 0.8, s.roof)
  panel(mb, 0, towerS * 0.5, towerX, bodyH + towerH * 0.62, towerS * 0.6, towerS * 0.6, s.trim)
  panel(mb, 1, towerS * 0.5, towerX, bodyH + towerH * 0.62, towerS * 0.6, towerS * 0.6, s.trim)

  if (!alongX) rotateSince(mb, start, Math.PI * 0.5)
}

/** Hospital: white, wide podium plus a slimmer tower, roof helipad ring. */
function buildHospital(mb: MeshBuilder, s: Shell): void {
  const podiumH = Math.min(clampNum(s.h * 0.4, 2, 11), s.h * 0.72)
  const towerH = Math.max(s.h - podiumH, 1.6)
  const tw = s.w * 0.6
  const td = s.d * 0.6
  const towerZ = -s.d * 0.08

  box(mb, 0, podiumH * 0.5, 0, s.w, podiumH, s.d, s.wall)
  const podiumFloors = clampInt(podiumH / 3.6, 1, 4)
  const podiumFloorH = podiumH / podiumFloors
  for (let i = 0; i < podiumFloors; i++) {
    bandAllSides(mb, s.w, s.d, i * podiumFloorH + podiumFloorH * 0.55, 1.5, 1.4, s.glass)
  }
  deck(mb, 0, podiumH + 0.04, 0, s.w - 0.4, s.d - 0.4, shade(s.roof, 0.9))
  parapetRing(mb, s.w, s.d, podiumH, 0.7, 0.3, s.roof)

  box(mb, 0, podiumH + towerH * 0.5, towerZ, tw, towerH, td, s.light)
  const towerFloors = clampInt(towerH / 3.6, 1, 14)
  const towerFloorH = towerH / towerFloors
  for (let i = 0; i < towerFloors; i++) {
    const y = podiumH + i * towerFloorH + towerFloorH * 0.55
    // Bands hug the tower, which is offset in z, so push them by hand.
    const spanW = tw - 2
    const spanD = td - 2
    if (spanW > 0.5) {
      panel(mb, 0, td * 0.5 + towerZ, 0, y, spanW, 1.5, s.glass)
      panel(mb, 1, td * 0.5 - towerZ, 0, y, spanW, 1.5, s.glass)
    }
    if (spanD > 0.5) {
      panel(mb, 2, tw * 0.5, towerZ, y, spanD, 1.5, s.glass)
      panel(mb, 3, tw * 0.5, towerZ, y, spanD, 1.5, s.glass)
    }
  }

  const roofY = podiumH + towerH
  deck(mb, 0, roofY + 0.05, towerZ, tw - 0.3, td - 0.3, shade(s.roof, 0.94))

  // Helipad: a ring of short tangential boxes plus a painted "H".
  const radius = Math.max(1.6, Math.min(tw, td) * 0.34)
  const segs = 12
  const segLen = (2 * Math.PI * radius) / segs
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2
    yawedBox(
      mb,
      Math.cos(a) * radius,
      roofY + 0.2,
      towerZ + Math.sin(a) * radius,
      segLen * 0.75,
      0.3,
      0.55,
      -a + Math.PI * 0.5,
      s.trim,
    )
  }
  const barW = radius * 0.22
  const barL = radius * 1.05
  deck(mb, -radius * 0.4, roofY + 0.12, towerZ, barW, barL, s.trim)
  deck(mb, radius * 0.4, roofY + 0.12, towerZ, barW, barL, s.trim)
  deck(mb, 0, roofY + 0.12, towerZ, radius * 0.8, barW, s.trim)
}

/** Factory: blank walls, sawtooth north-light roof, chimney and vent stacks. */
function buildFactory(mb: MeshBuilder, s: Shell): void {
  const roofRise = clampNum(s.h * 0.26, 1.4, 3.4)
  const wallH = Math.max(s.h - roofRise, 3.5)
  box(mb, 0, wallH * 0.5, 0, s.w, wallH, s.d, s.wall)

  // Sawtooth: each tooth is a slope rising toward +X closed by a glazed face.
  const teeth = clampInt(Math.round(s.w / 8), 3, 7)
  const toothW = s.w / teeth
  const hd = s.d * 0.5
  for (let i = 0; i < teeth; i++) {
    const x0 = -s.w * 0.5 + i * toothW
    const x1 = x0 + toothW
    const yt = wallH + roofRise
    quad(mb, x0, wallH, hd, x1, yt, hd, x1, yt, -hd, x0, wallH, -hd, s.roof)
    quadN(mb, x1, wallH, hd, x1, wallH, -hd, x1, yt, -hd, x1, yt, hd, 1, 0, 0, s.glassDark)
    tri(mb, x0, wallH, hd, x1, wallH, hd, x1, yt, hd, s.roof)
    tri(mb, x1, wallH, -hd, x0, wallH, -hd, x1, yt, -hd, s.roof)
  }

  // Loading door on the -Z face, plus one high strip of clerestory glazing.
  const doorW = Math.min(s.w * 0.32, 7)
  const doorH = Math.min(wallH * 0.62, 4.6)
  panel(mb, 1, hd, 0, doorH * 0.5, doorW, doorH, s.glassDark)
  bandAllSides(mb, s.w, s.d, wallH * 0.82, Math.min(1.1, wallH * 0.12), 2.2, s.glass)

  const stackH = clampNum(s.h * 0.75, 3, 26)
  const stackX = -s.w * 0.5 + Math.min(3.5, s.w * 0.14)
  const stackZ = -s.d * 0.5 + Math.min(3.5, s.d * 0.14)
  box(mb, stackX, wallH + stackH * 0.5, stackZ, 1.9, stackH, 1.9, shade(s.roof, 0.9))
  box(mb, stackX, wallH + stackH + 0.3, stackZ, 2.5, 0.6, 2.5, shade(s.roof, 0.7))
  const ventH = Math.min(2.6, s.h * 0.35)
  for (let i = 0; i < 2; i++) {
    box(
      mb,
      s.w * 0.5 - 3 - i * 3.2,
      wallH + roofRise + ventH * 0.5,
      s.d * 0.28,
      1.1,
      ventH,
      1.1,
      shade(s.roof, 0.8),
    )
  }
}

/** Station: a long shed under a stepped barrel vault, with a plaza canopy. */
function buildStation(mb: MeshBuilder, s: Shell): void {
  const alongX = s.w >= s.d
  const start = vertexCount(mb)
  const long = alongX ? s.w : s.d
  const across = alongX ? s.d : s.w

  const archH = clampNum(s.h * 0.42, 3, 12)
  const shedH = Math.max(s.h - archH, 4)
  box(mb, 0, shedH * 0.5, 0, long, shedH, across, s.wall)

  // Concourse glazing along both flanks, and a full-height glazed frontage.
  bandAllSides(mb, long, across, shedH * 0.62, Math.min(2.6, shedH * 0.34), 1.6, s.glass)
  panel(mb, 0, across * 0.5, 0, shedH * 0.45, long * 0.6, shedH * 0.62, s.glassDark)

  const steps = 5
  const stepH = archH / steps
  const r = across * 0.5
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps
    const halfW = r * Math.sqrt(Math.max(0, 1 - t * t))
    if (halfW <= 0.2) continue
    box(mb, 0, shedH + i * stepH + stepH * 0.5, 0, long, stepH, halfW * 2, s.roof)
  }

  // Plaza-facing canopy on two posts.
  const canopyD = Math.min(5, across * 0.4)
  const canopyY = Math.min(5.2, shedH * 0.62)
  box(mb, 0, canopyY, across * 0.5 + canopyD * 0.5, long * 0.78, 0.4, canopyD, s.trim)
  const postX = long * 0.3
  box(mb, -postX, canopyY * 0.5, across * 0.5 + canopyD * 0.8, 0.5, canopyY, 0.5, s.trim)
  box(mb, postX, canopyY * 0.5, across * 0.5 + canopyD * 0.8, 0.5, canopyY, 0.5, s.trim)

  if (!alongX) rotateSince(mb, start, Math.PI * 0.5)
}

/** Civic hall: a solid base, a colonnade on the entrance face, a stepped attic. */
function buildCivic(mb: MeshBuilder, s: Shell): void {
  const parapetH = 0.8
  const bodyH = Math.max(s.h - parapetH, 4)
  box(mb, 0, bodyH * 0.5, 0, s.w, bodyH, s.d, s.wall)

  const floors = clampInt(s.floors, 1, 6)
  const floorH = bodyH / floors
  for (let i = 0; i < floors; i++) {
    windowGridAllSides(mb, s.w, s.d, i * floorH + floorH * 0.56, Math.min(2.0, floorH * 0.5), 0.45, s.glass)
  }

  // Colonnade standing proud of the +Z face.
  const colH = Math.min(bodyH * 0.62, 9)
  const cols = clampInt(s.w / 5, 3, 7)
  const step = s.w / (cols + 1)
  for (let i = 1; i <= cols; i++) {
    const x = -s.w * 0.5 + step * i
    box(mb, x, colH * 0.5, s.d * 0.5 + 0.55, 0.85, colH, 1.1, s.light)
  }
  box(mb, 0, colH + 0.3, s.d * 0.5 + 0.55, s.w * 0.9, 0.6, 1.5, s.roof)
  // Entrance steps.
  box(mb, 0, 0.22, s.d * 0.5 + 1.9, s.w * 0.44, 0.44, 2.4, s.trim)

  deck(mb, 0, bodyH + 0.04, 0, s.w - 0.4, s.d - 0.4, shade(s.roof, 0.88))
  parapetRing(mb, s.w, s.d, bodyH, parapetH, 0.34, s.roof)
  box(mb, 0, bodyH + parapetH + 1.1, 0, s.w * 0.32, 2.2, s.d * 0.32, s.light)
}

/** Temple: low body under a heavy hip roof with very deep eaves. */
function buildTemple(mb: MeshBuilder, s: Shell): void {
  const roofH = clampNum(s.h * 0.42, 1.8, 8)
  const bodyH = Math.max(s.h - roofH, 2.6)
  const bw = s.w * 0.84
  const bd = s.d * 0.84

  // Raised veranda platform.
  box(mb, 0, 0.3, 0, s.w, 0.6, s.d, s.trim)
  box(mb, 0, 0.6 + bodyH * 0.5, 0, bw, bodyH, bd, s.wall)
  bandAllSides(mb, bw, bd, 0.6 + bodyH * 0.55, Math.min(1.8, bodyH * 0.45), 1.2, s.glassDark)

  const overhang = Math.min(Math.min(s.w, s.d) * 0.12, 2.4) + 0.7
  const lower = s.floors >= 2
  if (lower) {
    // Two-tier roof for the larger halls.
    hipRoof(mb, 0.6 + bodyH * 0.55, bw + 1.5, bd + 1.5, roofH * 0.42, overhang * 0.8, s.roof)
    hipRoof(mb, 0.6 + bodyH, bw, bd, roofH, overhang, s.roof)
  } else {
    hipRoof(mb, 0.6 + bodyH, bw, bd, roofH, overhang, s.roof)
  }
  const ridgeLong = s.w >= s.d
  box(
    mb,
    0,
    0.6 + bodyH + roofH + 0.2,
    0,
    ridgeLong ? bw * 0.42 : 1.1,
    0.55,
    ridgeLong ? 1.1 : bd * 0.42,
    shade(s.roof, 0.8),
  )
}

/** Parking structure: open decks on columns, edge beams, one solid stair core. */
function buildParking(mb: MeshBuilder, s: Shell): void {
  const decks = clampInt(s.floors, 2, 6)
  const deckH = s.h / decks
  const slab = shade(s.wall, 0.92)
  const beam = s.trim

  box(mb, 0, 0.25, 0, s.w, 0.5, s.d, slab)
  for (let i = 1; i <= decks; i++) {
    const y = i * deckH
    box(mb, 0, y - 0.25, 0, s.w, 0.5, s.d, slab)
    parapetRing(mb, s.w, s.d, y - 0.5, 1.0, 0.28, beam)
  }

  // Corner columns carry the read of an open structure at oblique angles.
  const colInset = Math.min(1.6, Math.min(s.w, s.d) * 0.1)
  const colX = s.w * 0.5 - colInset
  const colZ = s.d * 0.5 - colInset
  for (let i = 0; i < 4; i++) {
    const sx = i === 0 || i === 3 ? 1 : -1
    const sz = i < 2 ? 1 : -1
    box(mb, colX * sx, s.h * 0.5, colZ * sz, 0.7, s.h, 0.7, slab)
  }

  const coreW = Math.min(s.w * 0.2, 6)
  const coreD = Math.min(s.d * 0.2, 6)
  box(
    mb,
    -s.w * 0.5 + coreW * 0.5,
    s.h * 0.5 + 0.6,
    -s.d * 0.5 + coreD * 0.5,
    coreW,
    s.h + 1.2,
    coreD,
    s.wall,
  )
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

const GLASS_TINT = new Color(WINDOW_COLOR)
const GLASS_DARK_TINT = new Color(WINDOW_DARK_COLOR)

function makeShell(building: Building, rng: Rng): Shell {
  const w = clampNum(building.footprint.width, 3, 240)
  const d = clampNum(building.footprint.depth, 3, 240)
  const floors = clampInt(building.floors, 1, 60)
  const h = clampNum(building.height, 2.5, 400)

  // A gentle per-building brightness jitter keeps a street of identical uses
  // from reading as a single flat mass.
  const jitter = rng.range(0.9, 1.08)
  const residential = building.use === 'residential' || building.use === 'apartment'
  const old = building.yearBuilt < 1981
  const wallPalette = old ? ['#c2b29a', '#c8c6b7', '#a3a6a0', '#bea78d'] : ['#e0dcd1', '#b9c6c8', '#d3c3b0', '#c0c4bf', '#ddd7c8']
  const roofPalette = old ? ['#555a5b', '#675b53', '#788185'] : ['#596f79', '#5c6266', '#796455', '#898780']
  const wall = shade(new Color(residential ? rng.pick(wallPalette) : wallColorFor(building.use)), jitter)
  const roof = shade(new Color(residential ? rng.pick(roofPalette) : roofColorFor(building.use)), rng.range(0.9, 1.08))

  return {
    w,
    d,
    h,
    floors,
    rng,
    wall,
    roof,
    glass: mix(shade(wall, 0.45), building.use === 'office' ? new Color(rng.pick(['#3d5966', '#52635e', '#5f6f7c'])) : GLASS_TINT, 0.55),
    glassDark: mix(shade(wall, 0.32), GLASS_DARK_TINT, 0.65),
    trim: shade(wall, 0.78),
    light: mix(wall, new Color(1, 1, 1), 0.1),
  }
}

function finishGeometry(mb: MeshBuilder): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(mb.pos), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(mb.nor), 3))
  geometry.computeBoundingSphere()
  return geometry
}

/** Deterministic for a given building id + seed. */
export function createBuildingGeometry(building: Building, seed: number): BuildingGeometryResult {
  const rng = new Rng(mixSeed(seed, hashString(building.id)))
  const shell = makeShell(building, rng)
  const mb = createBuilder()

  const wooden =
    building.constructionType === 'wood' ||
    building.constructionType === 'prefab' ||
    building.constructionType === 'lightSteel'
  const archetype = archetypeFor(building.use, shell.floors, wooden)

  switch (archetype) {
    case 'house':
      buildHouse(mb, shell, building.roofType === 'hip' || building.roofType === 'dome' || hashString(building.id) % 3 === 0)
      break
    case 'apartment':
      buildApartment(mb, shell)
      break
    case 'office':
      buildOffice(mb, shell)
      break
    case 'commercial':
      buildCommercial(mb, shell)
      break
    case 'school':
      if (building.floors === 1) buildFactory(mb, { ...shell, wall: new Color('#dddcd3') })
      else buildSchool(mb, shell)
      break
    case 'hospital':
      buildHospital(mb, shell)
      break
    case 'factory':
      buildFactory(mb, shell)
      break
    case 'station':
      buildStation(mb, shell)
      break
    case 'civic':
      buildCivic(mb, shell)
      break
    case 'temple':
      buildTemple(mb, shell)
      break
    case 'parking':
      buildParking(mb, shell)
      break
  }

  if (building.use === 'residential' && wooden) {
    const modern = building.yearBuilt >= 2000
    if (modern && rng.next() > 0.35) {
      // Photovoltaic panels on one roof slope, kept inside the eaves.
      yawedBox(mb, -shell.w * 0.2, shell.h - 0.45, 0, shell.w * 0.22, 0.18, shell.d * 0.48, 0, new Color('#394d59'))
    } else if (!modern) {
      for (let i = 0; i < 5; i++) box(mb, -shell.w * 0.4 + i * shell.w * 0.2, shell.h * 0.35, shell.d * 0.501, 0.15, shell.h * 0.55, 0.18, shell.trim)
    }
  }
  if (building.use === 'commercial' && shell.floors < 6) {
    const awning = rng.pick(['#597568', '#756058', '#5b7586', '#b7a377'])
    for (let i = 0; i < 5; i++) box(mb, -shell.w * 0.32 + i * shell.w * 0.16, 3.1, shell.d * 0.5 + 0.7, shell.w * 0.14, 0.24, 1.6, new Color(i % 2 ? '#e2ded0' : awning))
  }
  // Degenerate input (a zero footprint, say) must still yield a visible mass.
  if (mb.pos.length === 0) box(mb, 0, shell.h * 0.5, 0, shell.w, shell.h, shell.d, shell.wall)

  const geometry = finishGeometry(mb)
  const baseColors = new Float32Array(mb.col)
  const colorAttribute = new BufferAttribute(baseColors.slice(), 3)
  colorAttribute.setUsage(DynamicDrawUsage)
  geometry.setAttribute('color', colorAttribute)

  return { geometry, baseColors, height: mb.maxY > 0 ? mb.maxY : shell.h }
}

const tintScratch = createTintTransform()

/** Rewrites the geometry's colour attribute in place. Cheap; call on change only. */
export function applyDamageTint(
  result: BuildingGeometryResult,
  building: Building,
  state: DamageState,
  burn: number,
): void {
  const attribute = result.geometry.getAttribute('color')
  if (!attribute) return
  const target = attribute.array as Float32Array
  const base = result.baseColors
  const count = Math.min(target.length, base.length)

  // Timber and prefab shells char harder than concrete ones, so the same burn
  // progress reads as slightly more soot on them.
  const sootBias =
    building.constructionType === 'wood' || building.constructionType === 'prefab' ? 1 : 0.82
  const { m, o } = damageTintTransform(state, burn * sootBias, tintScratch)
  const m0 = m[0]
  const m1 = m[1]
  const m2 = m[2]
  const m3 = m[3]
  const m4 = m[4]
  const m5 = m[5]
  const m6 = m[6]
  const m7 = m[7]
  const m8 = m[8]
  const o0 = o[0]
  const o1 = o[1]
  const o2 = o[2]

  for (let i = 0; i + 2 < count; i += 3) {
    const r = base[i]
    const g = base[i + 1]
    const b = base[i + 2]
    target[i] = m0 * r + m1 * g + m2 * b + o0
    target[i + 1] = m3 * r + m4 * g + m5 * b + o1
    target[i + 2] = m6 * r + m7 * g + m8 * b + o2
  }
  attribute.needsUpdate = true
}

/** Rotate fragments around their own centres, including their surface normals. */
function tiltFragment(mb: MeshBuilder, start: number, cx: number, cy: number, cz: number, ax: number, az: number): void {
  const sx = Math.sin(ax), coX = Math.cos(ax), sz = Math.sin(az), coZ = Math.cos(az)
  for (let i = start * 3; i < mb.pos.length; i += 3) {
    const x = mb.pos[i] - cx, y = mb.pos[i + 1] - cy, z = mb.pos[i + 2] - cz
    const ry = y * coX - z * sx, rz = y * sx + z * coX
    mb.pos[i] = cx + x * coZ - ry * sz
    mb.pos[i + 1] = cy + x * sz + ry * coZ
    mb.pos[i + 2] = cz + rz
    mb.maxY = Math.max(mb.maxY, mb.pos[i + 1])
    const nx = mb.nor[i], ny = mb.nor[i + 1] * coX - mb.nor[i + 2] * sx
    mb.nor[i + 2] = mb.nor[i + 1] * sx + mb.nor[i + 2] * coX
    mb.nor[i] = nx * coZ - ny * sz; mb.nor[i + 1] = nx * sz + ny * coZ
  }
}

/** A low, irregular rubble pile used when a building has fully collapsed. */
export function createRubbleGeometry(building: Building, seed: number): BufferGeometry {
  const rng = new Rng(mixSeed(mixSeed(seed, hashString(building.id)), hashString('rubble')))
  const w = clampNum(building.footprint.width, 3, 240)
  const d = clampNum(building.footprint.depth, 3, 240)
  const h = clampNum(building.height, 2.5, 400)

  const pileH = h * rng.range(0.15, 0.25)
  const timber = building.constructionType === 'wood'
  const chunks = rng.int(32, 46)
  const mb = createBuilder()
  const base = new Color(RUBBLE_COLOR)
  const chunkColor = new Color()

  for (let i = 0; i < chunks; i++) {
    const cx = rng.range(-0.3, 0.3) * w
    const cz = rng.range(-0.3, 0.3) * d
    const beam = timber && i % 3 === 0
    const sx = beam ? 0.22 : Math.max(0.6, w * rng.range(0.08, 0.27))
    const sz = beam ? d * rng.range(0.25, 0.6) : Math.max(0.6, d * rng.range(0.08, 0.27))
    // The pile thins toward the edges of the footprint.
    const edge = Math.max(Math.abs(cx) / (w * 0.5), Math.abs(cz) / (d * 0.5))
    const sy = beam ? 0.22 : Math.max(0.3, pileH * rng.range(0.15, 0.7) * (1 - 0.45 * clamp01(edge)))
    const tint = rng.range(0.82, 1.16)
    chunkColor.setRGB(clamp01(base.r * tint), clamp01(base.g * tint), clamp01(base.b * tint * 0.97))
    const cy = sy * 0.5 + pileH * rng.range(0.05, 0.4) * (1 - edge)
    const start = vertexCount(mb)
    yawedBox(mb, cx, cy, cz, sx, sy, sz, rng.range(0, Math.PI * 2), beam ? new Color('#68513c') : chunkColor)
    tiltFragment(mb, start, cx, cy, cz, rng.range(-0.45, 0.45), rng.range(-0.45, 0.45))
  }

  const geometry = finishGeometry(mb)
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(mb.col), 3))
  return geometry
}

/** Cut an actual corner out of the shell; expose floor plates, columns and broken panels. */
export function createDamagedGeometry(
  building: Building, original: BuildingGeometryResult, state: 'minor' | 'major' | 'severe', seed: number,
): BuildingGeometryResult {
  const mb = createBuilder()
  const g = original.geometry
  const p = g.getAttribute('position'), n = g.getAttribute('normal')
  const cols = original.baseColors
  const rng = new Rng(mixSeed(seed, hashString(building.id + ':fracture')))
  const w = building.footprint.width, d = building.footprint.depth, h = building.height
  const cutX = w * (state === 'major' ? 0.05 : -0.18)
  const cutY = h * (state === 'major' ? 0.32 : 0.18)
  type Vertex = number[]
  const clip = (poly: Vertex[], axis: number, plane: number, sign: number): Vertex[] => {
    const out: Vertex[] = []
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      const da = (a[axis] - plane) * sign, db = (b[axis] - plane) * sign
      if (da <= 0) out.push(a)
      if ((da <= 0) !== (db <= 0)) {
        const t = da / (da - db)
        out.push(a.map((v, k) => v + (b[k] - v) * t))
      }
    }
    return out
  }
  const emit = (poly: Vertex[]) => {
    for (let k = 1; k < poly.length - 1; k++) for (const v of [poly[0], poly[k], poly[k + 1]]) {
      mb.pos.push(v[0], v[1], v[2]); mb.nor.push(v[3], v[4], v[5]); mb.col.push(v[6], v[7], v[8])
      mb.maxY = Math.max(mb.maxY, v[1])
    }
  }
  for (let i = 0; i < p.count; i += 3) {
    const poly = [0, 1, 2].map(k => {
      const j = i + k
      return [p.getX(j), p.getY(j), p.getZ(j), n.getX(j), n.getY(j), n.getZ(j), cols[j * 3], cols[j * 3 + 1], cols[j * 3 + 2]]
    })
    if (state === 'minor') emit(poly)
    else {
      emit(clip(poly, 1, cutY, 1))
      emit(clip(clip(poly, 1, cutY, -1), 0, cutX, 1))
    }
  }
  const timber = building.constructionType === 'wood'
  const frame = new Color(timber ? '#6e5140' : '#96918b')
  if (state !== 'minor') {
    const floors = Math.min(24, building.floors), fh = h / floors
    const openW = w / 2 - cutX, cx = cutX + openW / 2
    for (let f = 1; f <= floors; f++) {
      const y = f * fh
      if (y < cutY) continue
      const settled = state === 'severe' ? cutY + (y - cutY) * 0.54 : y
      const slabW = openW * rng.range(0.6, 0.95)
      const start = vertexCount(mb)
      yawedBox(mb, cx, settled, -d * 0.05, slabW, timber ? 0.16 : 0.38, d * 0.8, rng.range(-0.1, 0.1), frame)
      tiltFragment(mb, start, cx, settled, -d * 0.05, rng.range(-0.08, 0.08), state === 'severe' ? rng.range(-0.2, -0.07) : rng.range(-0.1, -0.02))
      for (const z of [-d * 0.34, d * 0.34]) {
        box(mb, cutX + 0.4, y - fh / 2, z, 0.45, fh, 0.45, frame)
        if (state === 'major') box(mb, w * 0.39, y - fh / 2, z, 0.32, fh * 0.85, 0.32, frame)
      }
    }
    for (let i = 0; i < (state === 'severe' ? 20 : 12); i++) {
      const bw = rng.range(0.8, w * 0.14)
      yawedBox(mb, rng.range(cutX, w * 0.58), rng.range(0.15, h * 0.08), rng.range(-d * 0.45, d * 0.52), bw, rng.range(0.15, 0.55), rng.range(0.5, d * 0.13), rng.range(-Math.PI, Math.PI), frame)
    }
  }
  // Hairline fractures on retained wall faces. Geometry, not a colour wash.
  const crack = new Color('#302d2a')
  const crackCount = state === 'minor' ? 4 : 8
  for (let c = 0; c < crackCount; c++) {
    let x = rng.range(-w * 0.42, state === 'minor' ? w * 0.42 : cutX - 0.2)
    let y = rng.range(h * 0.1, h * 0.85)
    for (let k = 0; k < 4; k++) {
      const nx = x + rng.range(-0.8, 0.8), ny = y + Math.min(h * 0.025, 0.65)
      const width = state === 'minor' ? 0.045 : 0.11
      quad(mb, x - width, y, d / 2 + 0.09, x + width, y, d / 2 + 0.09, nx + width, ny, d / 2 + 0.09, nx - width, ny, d / 2 + 0.09, crack)
      x = nx; y = ny
    }
  }
  const geometry = finishGeometry(mb)
  const baseColors = new Float32Array(mb.col)
  geometry.setAttribute('color', new BufferAttribute(baseColors.slice(), 3))
  const result = { geometry, baseColors, height: original.height }
  applyDamageTint(result, building, state, 0)
  return result
}
