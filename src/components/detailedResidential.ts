/**
 * Residential architecture baked to one mesh per building. Openings are real
 * gaps between wall segments, with reveals, recessed glazing and solid frames.
 * Coordinates are local, Y-up; rotation belongs to the consuming mesh.
 */
import { BufferAttribute, BufferGeometry, Color } from 'three'
import type { Building } from '../types/city'
import { hashString, mixSeed, Rng } from '../simulation/rng'

interface Builder {
  positions: number[]
  normals: number[]
  colors: number[]
}

type Point = [number, number, number]

interface Materials {
  wall: Color
  alternate: Color
  slab: Color
  frame: Color
  glass: Color
  roof: Color
  timber: Color
  metal: Color
  door: Color
  baysLimit: number
  railPosts: number
  district: boolean
}

interface Volume {
  x: number
  z: number
  width: number
  depth: number
  bottom: number
  height: number
}

function triangle(b: Builder, a: Point, c: Point, d: Point, color: Color): void {
  const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2]
  const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2]
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const length = Math.hypot(nx, ny, nz) || 1
  for (const p of [a, c, d]) {
    b.positions.push(...p)
    b.normals.push(nx / length, ny / length, nz / length)
    b.colors.push(color.r, color.g, color.b)
  }
}

function quad(b: Builder, a: Point, c: Point, d: Point, e: Point, color: Color): void {
  triangle(b, a, c, d, color)
  triangle(b, a, d, e, color)
}

function box(b: Builder, x: number, y: number, z: number, w: number, h: number, d: number, c: Color): void {
  if (w <= 0 || h <= 0 || d <= 0) return
  const x0 = x - w / 2, x1 = x + w / 2
  const y0 = y - h / 2, y1 = y + h / 2
  const z0 = z - d / 2, z1 = z + d / 2
  quad(b, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], c)
  quad(b, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], c)
  quad(b, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], c)
  quad(b, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], c)
  quad(b, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], c)
  quad(b, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], c)
}

/** A beam with arbitrary slope, including stair stringers and roof rafters. */
function beam(b: Builder, a: Point, c: Point, width: number, color: Color): void {
  const dx = c[0] - a[0], dy = c[1] - a[1], dz = c[2] - a[2]
  const horizontal = Math.hypot(dx, dz)
  if (horizontal < 0.0001) {
    box(b, a[0], (a[1] + c[1]) / 2, a[2], width, Math.abs(dy), width, color)
    return
  }
  const px = -dz / horizontal * width / 2, pz = dx / horizontal * width / 2
  const ay = a[1] - width / 2, cy = c[1] - width / 2
  quad(b, [a[0] - px, ay, a[2] - pz], [c[0] - px, cy, c[2] - pz], [c[0] - px, cy + width, c[2] - pz], [a[0] - px, ay + width, a[2] - pz], color)
  quad(b, [c[0] + px, cy, c[2] + pz], [a[0] + px, ay, a[2] + pz], [a[0] + px, ay + width, a[2] + pz], [c[0] + px, cy + width, c[2] + pz], color)
  quad(b, [a[0] + px, ay + width, a[2] + pz], [a[0] - px, ay + width, a[2] - pz], [c[0] - px, cy + width, c[2] - pz], [c[0] + px, cy + width, c[2] + pz], color)
  quad(b, [a[0] - px, ay, a[2] - pz], [a[0] + px, ay, a[2] + pz], [c[0] + px, cy, c[2] + pz], [c[0] - px, cy, c[2] - pz], color)
}

function tint(c: Color, factor: number): Color {
  return c.clone().multiplyScalar(factor)
}

function materials(building: Building, rng: Rng, district: boolean): Materials {
  const old = building.yearBuilt < 1981
  const apartment = building.use === 'apartment' || building.floors > 3 || building.constructionType === 'rc'
  const colors = apartment
    ? ['#c9c5bd', '#d9d4c5', '#b1a08e', '#e2dfd8', '#a89e96']
    : old ? ['#c9b691', '#b5a48a', '#ddd0b3', '#a18e73', '#d7c8a9']
      : ['#e8e5dd', '#c7b49c', '#c5c9c5', '#e0d2b9', '#aeb5b4']
  const wall = new Color(rng.pick(colors))
  return {
    wall,
    alternate: tint(wall, old ? 0.72 : 0.84),
    slab: new Color(old ? '#9a968b' : '#b7b8b2'),
    frame: new Color(old ? '#504c44' : '#6b747a'),
    glass: new Color(rng.pick(['#526c79', '#677e86', '#405665', '#78888a'])),
    roof: new Color(rng.pick(old ? ['#465158', '#585652', '#6b6253', '#5d6671'] : ['#49585e', '#63696c', '#785a49', '#4c6161'])),
    timber: new Color(old ? '#6d513c' : '#8c7154'),
    metal: new Color('#676d6b'),
    door: new Color(rng.pick(['#70553c', '#554c42', '#7f6950', '#555e61'])),
    baysLimit: district ? (apartment ? 1 : 2) : apartment ? Math.max(2, Math.min(5, Math.floor(20 / Math.max(1, building.floors)))) : 4,
    railPosts: district ? 2 : apartment ? Math.max(2, Math.min(14, Math.floor(35 / Math.max(1, building.floors)))) : 12,
    district,
  }
}

/** Local face coordinates: u along facade, n positive out of its wall. */
function faceBox(b: Builder, v: Volume, side: number, u: number, y: number, n: number, w: number, h: number, depth: number, color: Color): void {
  if (side === 0) box(b, v.x + u, y, v.z + v.depth / 2 + n, w, h, depth, color)
  else if (side === 1) box(b, v.x - u, y, v.z - v.depth / 2 - n, w, h, depth, color)
  else if (side === 2) box(b, v.x + v.width / 2 + n, y, v.z - u, depth, h, w, color)
  else box(b, v.x - v.width / 2 - n, y, v.z + u, depth, h, w, color)
}

function windowOpening(b: Builder, v: Volume, side: number, u: number, y: number, width: number, height: number, m: Materials, rng: Rng): void {
  const frame = 0.085
  // Glass is behind the outer wall by 14 cm. The aperture reveals and sill
  // have genuine depth, visible both close up and in cast shadows.
  faceBox(b, v, side, u, y, -0.14, width - frame, height - frame, 0.035, tint(m.glass, rng.range(0.8, 1.12)))
  if (m.district) {
    faceBox(b, v, side, u, y, -0.045, 0.075, height, 0.09, m.frame)
    return
  }
  faceBox(b, v, side, u, y - height / 2, -0.075, width + frame * 2, frame, 0.22, m.frame)
  faceBox(b, v, side, u, y + height / 2, -0.075, width + frame * 2, frame, 0.22, m.frame)
  faceBox(b, v, side, u - width / 2, y, -0.075, frame, height, 0.22, m.frame)
  faceBox(b, v, side, u + width / 2, y, -0.075, frame, height, 0.22, m.frame)
  faceBox(b, v, side, u, y, -0.045, 0.065, height, 0.09, m.frame)
  faceBox(b, v, side, u, y - height / 2 - 0.085, 0.02, width + 0.25, 0.11, 0.38, m.slab)
  if (rng.chance(0.4)) {
    // An inside blind occupies only the upper part of the glazing.
    faceBox(b, v, side, u, y + height * 0.32, -0.11, width * 0.92, height * 0.25, 0.02, tint(m.wall, 0.83))
  }
}

/** Segmented wall: solid piers / lintels / spandrels surround each opening. */
function facade(b: Builder, v: Volume, side: number, m: Materials, rng: Rng, groundEntrance = false, balconyDoors = false): void {
  const span = side < 2 ? v.width : v.depth
  const bays = Math.max(1, Math.min(m.baysLimit, Math.round(span / (balconyDoors ? 4.4 : 4))))
  const bay = span / bays
  const thickness = 0.25
  const base = v.bottom + 0.2
  const usable = Math.max(1.7, v.height - 0.38)
  const sill = balconyDoors ? 0.14 : Math.min(0.88, usable * 0.28)
  const openingH = Math.min(balconyDoors ? 2.15 : 1.58, usable - sill - 0.28)
  for (let i = 0; i < bays; i++) {
    const u = -span / 2 + bay * (i + 0.5)
    const entrance = groundEntrance && i === Math.floor(bays / 2)
    const width = Math.min(bay - 0.5, entrance ? 1.3 : bay * (balconyDoors ? 0.72 : 0.57))
    const openingBottom = base + (entrance ? 0 : sill)
    const apertureH = entrance ? Math.min(2.12, usable - 0.2) : openingH
    const pier = Math.max(0.15, (bay - width) / 2)
    faceBox(b, v, side, u - width / 2 - pier / 2, base + usable / 2, -thickness / 2, pier, usable, thickness, m.wall)
    faceBox(b, v, side, u + width / 2 + pier / 2, base + usable / 2, -thickness / 2, pier, usable, thickness, m.wall)
    const below = openingBottom - base
    faceBox(b, v, side, u, base + below / 2, -thickness / 2, width, below, thickness, m.wall)
    const upper = base + usable - openingBottom - apertureH
    faceBox(b, v, side, u, openingBottom + apertureH + upper / 2, -thickness / 2, width, upper, thickness, m.wall)
    if (entrance) {
      faceBox(b, v, side, u, openingBottom + apertureH / 2, -0.11, width, apertureH, 0.11, m.door)
      faceBox(b, v, side, u + width * 0.33, openingBottom + apertureH * 0.47, -0.015, 0.06, 0.25, 0.07, m.slab)
      faceBox(b, v, side, u, openingBottom + apertureH * 0.73, -0.035, width * 0.48, apertureH * 0.21, 0.035, m.glass)
      faceBox(b, v, side, u, openingBottom + apertureH + 0.22, 0.3, width + 0.7, 0.12, 0.9, m.roof)
    } else windowOpening(b, v, side, u, openingBottom + apertureH / 2, width, apertureH, m, rng)
  }
  // Continuous ring beam, visible between stories, ties the solid piers.
  faceBox(b, v, side, 0, v.bottom + v.height - 0.12, -0.11, span, 0.24, 0.28, m.alternate)
}

function floorShell(b: Builder, v: Volume, m: Materials, rng: Rng, entrance = false, balcony = false): void {
  box(b, v.x, v.bottom + 0.1, v.z, v.width, 0.2, v.depth, m.slab)
  for (let side = 0; side < 4; side++) facade(b, v, side, m, rng, entrance && side === 0, balcony && side === 0)
  // Actual corner columns and a central partition also remain plausible when
  // damage clipping exposes the interior of the building.
  if (!m.district) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      box(b, v.x + sx * (v.width / 2 - 0.19), v.bottom + v.height / 2, v.z + sz * (v.depth / 2 - 0.19), 0.32, v.height, 0.32, m.alternate)
    }
    box(b, v.x, v.bottom + v.height / 2, v.z, 0.15, v.height - 0.2, v.depth - 0.6, tint(m.wall, 0.91))
    box(b, v.x, v.bottom + v.height - 0.13, v.z, v.width - 0.45, 0.26, 0.23, m.alternate)
  }
}

/** Repeated upper stories on tall imported blocks use ribbon openings. */
function upperFloorShell(b: Builder, v: Volume, m: Materials): void {
  box(b, v.x, v.bottom + 0.1, v.z, v.width, 0.2, v.depth, m.slab)
  const lowerH = v.height * 0.28
  const glassH = v.height * 0.47
  const upperH = v.height - lowerH - glassH
  for (let side = 0; side < 4; side++) {
    const span = side < 2 ? v.width : v.depth
    faceBox(b, v, side, 0, v.bottom + lowerH / 2, -0.13, span, lowerH, 0.26, m.wall)
    faceBox(b, v, side, 0, v.bottom + lowerH + glassH + upperH / 2, -0.13, span, upperH, 0.26, m.wall)
    faceBox(b, v, side, 0, v.bottom + lowerH + glassH / 2, -0.17, span - 0.3, glassH, 0.035, m.glass)
    // Four real piers divide the deep horizontal opening, keeping repeated
    // upper stories inexpensive without replacing their walls by a box.
    for (let i = 0; i <= 3; i++) faceBox(b, v, side, -span / 2 + 0.12 + (span - 0.24) * i / 3, v.bottom + lowerH + glassH / 2, -0.075, 0.14, glassH, 0.15, m.frame)
  }
}

/** Separate stepped tile courses on both roof pitches, with real thickness. */
function tiledRoof(b: Builder, v: Volume, rise: number, hip: boolean, m: Materials, rng: Rng): void {
  const x0 = v.x - v.width / 2 - 0.2, x1 = v.x + v.width / 2 + 0.2
  const halfDepth = v.depth / 2 + 0.23
  const eaveY = v.bottom + v.height
  const ridgeY = eaveY + rise
  const ridgeInset = hip ? Math.min(v.width * 0.25, halfDepth * 0.72) : 0
  // Closed gable / hip ends: the roof has fascia and volume, not a paper plane.
  for (const sign of [-1, 1]) {
    const edgeX = sign < 0 ? x0 : x1
    const ridgeX = edgeX - sign * ridgeInset
    if (sign > 0) triangle(b, [edgeX, eaveY, v.z + halfDepth], [edgeX, eaveY, v.z - halfDepth], [ridgeX, ridgeY, v.z], m.roof)
    else triangle(b, [edgeX, eaveY, v.z - halfDepth], [edgeX, eaveY, v.z + halfDepth], [ridgeX, ridgeY, v.z], m.roof)
    beam(b, [edgeX, eaveY - 0.07, v.z - halfDepth], [ridgeX, ridgeY - 0.07, v.z], 0.2, m.timber)
    beam(b, [ridgeX, ridgeY - 0.07, v.z], [edgeX, eaveY - 0.07, v.z + halfDepth], 0.2, m.timber)
  }
  const courses = Math.max(3, Math.min(m.district ? 3 : 8, Math.round(halfDepth / 0.65)))
  const columns = Math.max(3, Math.min(m.district ? 4 : 16, Math.round(v.width / 0.9)))
  for (const sign of [-1, 1]) {
    for (let row = 0; row < courses; row++) {
      const t0 = row / courses, t1 = (row + 1) / courses
      const z0 = v.z + sign * halfDepth * (1 - t0), z1 = v.z + sign * halfDepth * (1 - t1)
      const y0 = eaveY + rise * t0, y1 = eaveY + rise * t1
      const left0 = x0 + ridgeInset * t0, right0 = x1 - ridgeInset * t0
      const left1 = x0 + ridgeInset * t1, right1 = x1 - ridgeInset * t1
      for (let column = 0; column < columns; column++) {
        const u0 = column / columns, u1 = (column + 1) / columns
        const a: Point = [left0 + (right0 - left0) * u0, y0 + 0.055, z0]
        const c: Point = [left0 + (right0 - left0) * u1 - 0.014, y0 + 0.055, z0]
        const d: Point = [left1 + (right1 - left1) * u1 - 0.014, y1, z1]
        const e: Point = [left1 + (right1 - left1) * u0, y1, z1]
        const tile = tint(m.roof, rng.range(0.9, 1.1))
        if (sign > 0) quad(b, a, c, d, e, tile)
        else quad(b, c, a, e, d, tile)
        const lowerA: Point = [a[0], a[1] - 0.07, a[2]]
        const lowerC: Point = [c[0], c[1] - 0.07, c[2]]
        if (sign > 0) quad(b, lowerA, lowerC, c, a, tint(tile, 0.75))
        else quad(b, lowerC, lowerA, a, c, tint(tile, 0.75))
      }
    }
    box(b, v.x, eaveY - 0.09, v.z + sign * halfDepth, v.width + 0.5, 0.2, 0.16, m.roof)
    // Rainwater pipes and gutters are attached to actual eaves.
    if (!m.district) box(b, x1 - 0.32, (eaveY + v.bottom) / 2, v.z + sign * (halfDepth - 0.1), 0.11, eaveY - v.bottom, 0.11, m.metal)
  }
  box(b, v.x, ridgeY + 0.1, v.z, Math.max(0.3, x1 - x0 - ridgeInset * 2), 0.24, 0.3, tint(m.roof, 1.14))
}

function railing(b: Builder, x: number, y: number, z: number, width: number, m: Materials, solid: boolean): void {
  const height = 1.06
  box(b, x, y + height, z, width, 0.075, 0.075, m.metal)
  box(b, x, y + 0.16, z, width, 0.065, 0.075, m.metal)
  const count = Math.max(2, Math.min(m.railPosts, Math.ceil(width / 0.48)))
  for (let i = 0; i <= count; i++) box(b, x - width / 2 + width * i / count, y + height / 2, z, 0.045, height, 0.055, m.metal)
  if (solid) box(b, x, y + 0.5, z - 0.055, width, 0.67, 0.095, tint(m.wall, 0.87))
}

function house(b: Builder, building: Building, rng: Rng, m: Materials, w: number, d: number, height: number): void {
  const floors = Math.max(1, Math.min(3, Math.round(building.floors)))
  const roofRise = Math.min(3.4, Math.max(1.15, height * 0.22))
  const bodyH = Math.max(2.3, height - roofRise)
  const floorH = bodyH / floors
  const width = w * 0.89
  const depth = d * 0.68
  const z = -d * 0.105
  const stepped = floors > 1 && building.yearBuilt >= 1990
  const upperScale = stepped ? 0.88 : 1
  box(b, 0, 0.16, z, width + 0.14, 0.32, depth + 0.14, m.slab)
  for (let floor = 0; floor < floors; floor++) {
    const scale = floor > 0 ? upperScale : 1
    const volume: Volume = { x: stepped && floor > 0 ? -width * 0.045 : 0, z: floor > 0 ? z - depth * (1 - scale) / 2 : z, width: width * scale, depth: depth * scale, bottom: floor * floorH + 0.22, height: floorH }
    floorShell(b, volume, m, rng, floor === 0, false)
    if (building.yearBuilt < 1981) {
      // Exposed timber posts / horizontal weatherboard on older houses.
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(b, volume.x + sx * (volume.width / 2 + 0.02), volume.bottom + floorH / 2, volume.z + sz * (volume.depth / 2 + 0.015), 0.12, floorH, 0.12, m.timber)
      for (const side of [0, 1]) faceBox(b, volume, side, 0, volume.bottom + 0.5, 0.025, volume.width, 0.18, 0.1, m.timber)
    }
    if (floor === floors - 1) tiledRoof(b, volume, roofRise, building.roofType === 'hip' || rng.chance(0.33), m, rng)
  }
  // A projecting one-storey entrance wing makes the plan an L, including a
  // lower roof meeting the main elevation instead of a single tall cuboid.
  const wing: Volume = { x: -w * 0.225, z: d * 0.345, width: w * 0.43, depth: d * 0.22, bottom: 0.22, height: Math.min(floorH * 0.86, 2.65) }
  floorShell(b, wing, m, rng, true)
  tiledRoof(b, wing, Math.min(1.05, roofRise * 0.6), false, m, rng)
  // Doorstep, front gate / letter box, and a recessed upper balcony.
  box(b, wing.x, 0.12, wing.z + wing.depth / 2 + 0.25, Math.min(2.4, wing.width * 0.7), 0.24, 0.55, m.slab)
  box(b, w * 0.34, 0.85, d * 0.41, 0.38, 1.7, 0.3, m.alternate)
  box(b, w * 0.34, 1.36, d * 0.43, 0.48, 0.26, 0.26, m.metal)
  if (floors > 1) {
    const balconyW = width * 0.39
    const balconyX = width * 0.23
    const front = z + depth / 2
    box(b, balconyX, floorH + 0.23, front + 0.48, balconyW, 0.19, 1.15, m.slab)
    railing(b, balconyX, floorH + 0.33, front + 1, balconyW, m, building.yearBuilt < 1981)
    box(b, balconyX - balconyW / 2, floorH + 0.87, front + 0.48, 0.12, 1.08, 1.12, m.alternate)
    box(b, balconyX + balconyW / 2, floorH + 0.87, front + 0.48, 0.12, 1.08, 1.12, m.alternate)
  }
}

function stairs(b: Builder, x: number, base: number, z: number, floorH: number, width: number, run: number, m: Materials, reverse: boolean): void {
  const steps = m.district ? 4 : Math.max(8, Math.min(18, Math.round(floorH / 0.2)))
  const direction = reverse ? -1 : 1
  for (let i = 0; i < steps; i++) {
    const treadZ = z + direction * ((i + 0.5) / steps - 0.5) * run
    box(b, x, base + (i + 1) / steps * floorH, treadZ, width, 0.085, run / steps * 1.05, m.slab)
  }
  for (const side of [-1, 1]) {
    const sx = x + side * width * 0.44
    beam(b, [sx, base + 0.08, z - direction * run / 2], [sx, base + floorH, z + direction * run / 2], 0.14, m.metal)
    beam(b, [sx, base + 1, z - direction * run / 2], [sx, base + floorH + 1, z + direction * run / 2], 0.055, m.metal)
    if (!m.district) for (let i = 0; i <= 4; i++) box(b, sx, base + floorH * i / 4 + 0.5, z + direction * (i / 4 - 0.5) * run, 0.045, 1, 0.045, m.metal)
  }
}

function apartment(b: Builder, building: Building, rng: Rng, m: Materials, w: number, d: number, height: number): void {
  // Detail every floor up to 24; beyond that combine pairs of stories to keep
  // a very large imported city bounded while preserving its actual height.
  const floors = Math.max(1, Math.min(24, Math.round(building.floors)))
  const floorH = Math.max(2.3, height - 0.65) / floors
  const balconyD = Math.min(1.8, d * 0.09)
  const rearWalkD = Math.min(1.35, d * 0.075)
  const stairW = Math.min(1.65, w * 0.07)
  const width = w * 0.94 - stairW
  const depth = d * 0.94 - balconyD - rearWalkD
  const x = -stairW / 2
  const z = (rearWalkD - balconyD) / 2
  const front = z + depth / 2
  const rear = z - depth / 2
  const old = building.yearBuilt < 1990
  const bays = Math.max(2, Math.min(9, Math.round(width / 4.5)))
  const bay = width / bays
  const parapetY = floors * floorH + 0.15
  for (let floor = 0; floor < floors; floor++) {
    const y = floor * floorH + 0.12
    const volume: Volume = { x, z, width, depth, bottom: y, height: floorH }
    if (floors > 8 && floor > 0) upperFloorShell(b, volume, m)
    else floorShell(b, volume, m, rng, floor === 0, floor > 0)
    box(b, x, y + 0.09, front + balconyD / 2, width, 0.18, balconyD, m.slab)
    box(b, x, y + 0.09, rear - rearWalkD / 2, width + stairW, 0.18, rearWalkD, m.slab)
    if (floor > 0) {
      railing(b, x, y + 0.2, front + balconyD - 0.08, width, m, old)
      railing(b, x, y + 0.2, rear - rearWalkD + 0.08, width, m, false)
      if (floors <= 8 && !m.district) for (let bayIndex = 1; bayIndex < bays; bayIndex++) box(b, x - width / 2 + bay * bayIndex, y + 0.92, front + balconyD / 2, 0.085, 1.65, balconyD * 0.88, tint(m.wall, 1.05))
      // Compressors, drainpipes and occasional laundry rails give inhabited
      // balconies a recognisable scale without separate render objects.
      for (let bayIndex = 0; bayIndex < (m.district ? 0 : floors > 8 ? 1 : bays); bayIndex++) {
        const bx = x - width / 2 + bay * (bayIndex + 0.22)
        if ((floor + bayIndex) % 2 === 0) {
          box(b, bx, y + 0.42, front + 0.33, 0.72, 0.56, 0.4, tint(m.slab, 1.11))
          box(b, bx, y + 0.42, front + 0.54, 0.48, 0.34, 0.02, m.frame)
        }
        if ((floor + bayIndex) % 4 === 0) box(b, bx + 0.65, y + 1.68, front + balconyD * 0.7, 1.35, 0.045, 0.045, m.metal)
      }
    }
    // External fire escape fits inside the authored footprint.
    if (floors <= 8 && floor < floors - 1 && floorH < 5) {
      const stairX = x + width / 2 + stairW / 2
      const stairZ = rear + Math.min(depth * 0.25, 2.7)
      stairs(b, stairX, y + 0.15, stairZ, floorH, stairW * 0.83, Math.min(depth * 0.44, 4.7), m, floor % 2 === 1)
      box(b, stairX, y + floorH + 0.08, stairZ + (floor % 2 === 1 ? -1 : 1) * Math.min(depth * 0.22, 2.35), stairW, 0.16, 1.1, m.slab)
    }
  }
  if (floors > 8) {
    // Tall blocks contain a protected stair tower instead of dozens of open
    // flights. Its narrow wall is distinct from the windowed residential body.
    box(b, x + width / 2 + stairW / 2, height / 2, rear + depth * 0.2, stairW, height, Math.min(4.2, depth * 0.32), m.alternate)
  }
  box(b, x, parapetY, z, width, 0.25, depth, m.slab)
  for (const sign of [-1, 1]) {
    box(b, x, parapetY + 0.33, z + sign * depth / 2, width, 0.65, 0.22, m.alternate)
    box(b, x + sign * width / 2, parapetY + 0.33, z, 0.22, 0.65, depth, m.alternate)
  }
  // Roof stair core, tank, and a shallow entrance canopy.
  const coreW = Math.min(4, width * 0.2), coreD = Math.min(4.2, depth * 0.25)
  box(b, x + width * 0.26, parapetY + 1.25, z - depth * 0.26, coreW, 2.5, coreD, m.alternate)
  box(b, x + width * 0.26, parapetY + 2.58, z - depth * 0.26, coreW + 0.15, 0.15, coreD + 0.15, m.slab)
  box(b, x - width * 0.2, parapetY + 0.42, z, 2.5, 0.8, 2.5, m.metal)
  box(b, x - width * 0.2, parapetY + 1.8, z, 2.25, 2.1, 2.25, tint(m.slab, 1.2))
  box(b, x, Math.min(floorH - 0.25, 2.6), front + balconyD * 0.65, Math.min(5.5, width * 0.4), 0.16, balconyD * 1.2, m.alternate)
  for (const sign of [-1, 1]) box(b, x + sign * width * 0.43, height / 2, front + 0.12, 0.13, height, 0.13, m.metal)
}

/** A deterministic, non-indexed position / normal / color geometry. */
export function createDetailedResidential(building: Building, seed: number, detail: 'full' | 'district' = 'full'): BufferGeometry {
  const rng = new Rng(mixSeed(seed, hashString(`residential-detail:${building.id}`)))
  const b: Builder = { positions: [], normals: [], colors: [] }
  const m = materials(building, rng, detail === 'district')
  const w = Number.isFinite(building.footprint.width) ? Math.max(4, Math.min(240, building.footprint.width)) : 12
  const d = Number.isFinite(building.footprint.depth) ? Math.max(4, Math.min(240, building.footprint.depth)) : 14
  const h = Number.isFinite(building.height) ? Math.max(3.2, Math.min(400, building.height)) : 6.5
  const detached = building.use === 'residential' && building.floors <= 3 && building.constructionType !== 'rc' && building.constructionType !== 'steel'
  if (detached) house(b, building, rng, m, w, d, h)
  else apartment(b, building, rng, m, w, d, h)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(b.positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(b.normals), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(b.colors), 3))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
