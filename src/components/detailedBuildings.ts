/**
 * Architectural meshes baked into one draw call per building.
 *
 * All coordinates are metres, local to the unrotated footprint, with y=0 at
 * grade. Facades have real recessed openings; floor plates, roof parapets,
 * service cores and exposed structures remain separate solids inside that
 * one mesh. No textures or online assets are needed.
 */
import { BufferAttribute, BufferGeometry, Color } from 'three'
import type { Building } from '../types/city'
import { Rng, hashString, mixSeed } from '../simulation/rng'

type Point = [number, number, number]
type Side = 0 | 1 | 2 | 3

const CONCRETE = new Color('#b9b7b0')
const LIGHT_STONE = new Color('#d8d6cc')
const DARK_STONE = new Color('#747b79')
const FRAME = new Color('#68787c')
const ALUMINIUM = new Color('#b2bab9')
const RECESS = new Color('#3c484c')
const ROOF = new Color('#6b7475')
const BLUE_GLASS = new Color('#506e7b')
const GREEN_GLASS = new Color('#637b79')
const WHITE = new Color('#e5e3d7')
const WOOD = new Color('#68543f')

function finite(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min
}

function tint(color: Color, factor: number): Color {
  return color.clone().multiplyScalar(factor)
}

/** Flat-shaded accumulator. The returned geometry has no index. */
class ArchitectureMesh {
  private positions: number[] = []
  private normals: number[] = []
  private colors: number[] = []

  triangle(a: Point, b: Point, c: Point, color: Color): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz)
    if (length < 1e-8) return
    for (const point of [a, b, c]) {
      this.positions.push(...point)
      this.normals.push(nx / length, ny / length, nz / length)
      this.colors.push(color.r, color.g, color.b)
    }
  }

  quad(a: Point, b: Point, c: Point, d: Point, color: Color): void {
    this.triangle(a, b, c, color)
    this.triangle(a, c, d, color)
  }

  box(x: number, y: number, z: number, w: number, h: number, d: number, color: Color): void {
    if (Math.min(w, h, d) <= 0) return
    const a = x - w / 2, b = x + w / 2
    const c = y - h / 2, e = y + h / 2
    const f = z - d / 2, g = z + d / 2
    this.quad([a, c, g], [b, c, g], [b, e, g], [a, e, g], color)
    this.quad([b, c, f], [a, c, f], [a, e, f], [b, e, f], color)
    this.quad([b, c, g], [b, c, f], [b, e, f], [b, e, g], color)
    this.quad([a, c, f], [a, c, g], [a, e, g], [a, e, f], color)
    this.quad([a, e, g], [b, e, g], [b, e, f], [a, e, f], color)
    this.quad([a, c, f], [b, c, f], [b, c, g], [a, c, g], color)
  }

  /** Rectangular member with its ends at a and b. */
  beam(a: Point, b: Point, width: number, depth: number, color: Color): void {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
    const length = Math.hypot(dx, dy, dz)
    if (length < 1e-5) return
    const ux = dx / length, uy = dy / length, uz = dz / length
    let vx = -uz, vy = 0, vz = ux
    const horizontal = Math.hypot(vx, vz)
    if (horizontal < 1e-5) { vx = 1; vz = 0 }
    else { vx /= horizontal; vz /= horizontal }
    const wx = uy * vz - uz * vy, wy = uz * vx - ux * vz, wz = ux * vy - uy * vx
    const points = (p: Point): Point[] => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [
      p[0] + u * vx * width / 2 + v * wx * depth / 2,
      p[1] + u * vy * width / 2 + v * wy * depth / 2,
      p[2] + u * vz * width / 2 + v * wz * depth / 2,
    ])
    const endsA = points(a), endsB = points(b)
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      this.quad(endsA[i], endsA[j], endsB[j], endsB[i], color)
    }
    this.quad(endsA[3], endsA[2], endsA[1], endsA[0], color)
    this.quad(endsB[0], endsB[1], endsB[2], endsB[3], color)
  }

  cylinder(x: number, y: number, z: number, radius: number, h: number, color: Color, segments = 10): void {
    for (let i = 0; i < segments; i++) {
      const a = i / segments * Math.PI * 2, b = (i + 1) / segments * Math.PI * 2
      const pa: Point = [x + Math.cos(a) * radius, y, z + Math.sin(a) * radius]
      const pb: Point = [x + Math.cos(b) * radius, y, z + Math.sin(b) * radius]
      const qa: Point = [pa[0], y + h, pa[2]], qb: Point = [pb[0], y + h, pb[2]]
      this.quad(pb, pa, qa, qb, color)
      this.triangle([x, y + h, z], qb, qa, color)
      this.triangle([x, y, z], pa, pb, color)
    }
  }

  finish(): BufferGeometry {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3))
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3))
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }
}

interface Mass {
  x: number
  z: number
  y: number
  w: number
  d: number
  h: number
  floors: number
}

interface Architecture {
  mesh: ArchitectureMesh
  rng: Rng
  building: Building
  w: number
  d: number
  h: number
  floors: number
  wall: Color
  accent: Color
  glass: Color
}

function facePoint(m: Mass, side: Side, u: number, y: number, depth = 0): Point {
  if (side === 0) return [m.x + u, y, m.z + m.d / 2 + depth]
  if (side === 1) return [m.x - u, y, m.z - m.d / 2 - depth]
  if (side === 2) return [m.x + m.w / 2 + depth, y, m.z - u]
  return [m.x - m.w / 2 - depth, y, m.z + u]
}

function wallRectangle(a: Architecture, m: Mass, side: Side, x0: number, y0: number, x1: number, y1: number, depth: number, color: Color): void {
  a.mesh.quad(facePoint(m, side, x0, y0, depth), facePoint(m, side, x1, y0, depth),
    facePoint(m, side, x1, y1, depth), facePoint(m, side, x0, y1, depth), color)
}

/** A facade tile with an actual opening and 28 cm deep masonry reveals. */
function windowTile(a: Architecture, m: Mass, side: Side, u: number, y: number, width: number, height: number, fill: number, wall: Color, glass: Color, door = false): void {
  const halfW = width / 2, halfH = height / 2
  const winW = halfW * fill, winH = halfH * (door ? 0.91 : 0.59)
  const outer = [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]]
  const inner = [[-winW, -winH], [winW, -winH], [winW, winH], [-winW, winH]]
  const originY = door ? y - height * 0.035 : y + height * 0.08
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    a.mesh.quad(facePoint(m, side, u + outer[i][0], y + outer[i][1]),
      facePoint(m, side, u + outer[j][0], y + outer[j][1]),
      facePoint(m, side, u + inner[j][0], originY + inner[j][1]),
      facePoint(m, side, u + inner[i][0], originY + inner[i][1]), wall)
    a.mesh.quad(facePoint(m, side, u + inner[i][0], originY + inner[i][1]),
      facePoint(m, side, u + inner[j][0], originY + inner[j][1]),
      facePoint(m, side, u + inner[j][0] * 0.97, originY + inner[j][1] * 0.96, -0.28),
      facePoint(m, side, u + inner[i][0] * 0.97, originY + inner[i][1] * 0.96, -0.28), ALUMINIUM)
  }
  wallRectangle(a, m, side, u - winW * 0.97, originY - winH * 0.96,
    u + winW * 0.97, originY + winH * 0.96, -0.285, glass)
  // The frame casts a thin shadow across the recessed glass.
  wallRectangle(a, m, side, u - 0.055, originY - winH * 0.97, u + 0.055, originY + winH * 0.97, -0.18, FRAME)
  if (width > 4.5) wallRectangle(a, m, side, u - winW * 0.97, originY - 0.045, u + winW * 0.97, originY + 0.045, -0.18, FRAME)
}

function parapet(a: Architecture, m: Mass, height = 0.65, color = a.wall): void {
  const thickness = Math.min(0.3, m.w * 0.04, m.d * 0.04)
  const top = m.y + m.h
  a.mesh.box(m.x, top + height / 2, m.z + (m.d - thickness) / 2, m.w, height, thickness, color)
  a.mesh.box(m.x, top + height / 2, m.z - (m.d - thickness) / 2, m.w, height, thickness, color)
  a.mesh.box(m.x + (m.w - thickness) / 2, top + height / 2, m.z, thickness, height, m.d, color)
  a.mesh.box(m.x - (m.w - thickness) / 2, top + height / 2, m.z, thickness, height, m.d, color)
  // Metal coping, deliberately thicker than the wall below it.
  for (const sign of [-1, 1]) {
    a.mesh.box(m.x, top + height + 0.04, m.z + sign * (m.d - thickness) / 2, m.w + 0.08, 0.08, thickness + 0.12, ALUMINIUM)
    a.mesh.box(m.x + sign * (m.w - thickness) / 2, top + height + 0.04, m.z, thickness + 0.12, 0.08, m.d, ALUMINIUM)
  }
}

/** RC frame and four perforated facades, not a solid box under painted windows. */
function masonryBlock(a: Architecture, m: Mass, options: { fill?: number; columns?: number; wall?: Color; parapet?: boolean; entrance?: boolean } = {}): void {
  const wall = options.wall ?? a.wall
  const floors = Math.max(1, Math.min(22, Math.round(m.floors)))
  const floorH = m.h / floors
  for (let f = 0; f <= floors; f++) {
    const y = m.y + f * floorH
    a.mesh.box(m.x, y + 0.1, m.z, m.w, 0.2, m.d, f === floors ? ROOF : CONCRETE)
  }
  // Interior service core visible in oblique views through the window recesses.
  a.mesh.box(m.x - m.w * 0.12, m.y + m.h / 2, m.z, Math.max(0.6, m.w * 0.12), m.h, m.d * 0.4, RECESS)
  const colsLimit = options.columns ?? 8
  for (let side = 0; side < 4; side++) {
    const span = side < 2 ? m.w : m.d
    const cols = Math.max(1, Math.min(colsLimit, Math.round(span / 4.5)))
    const cell = span / cols
    for (let f = 0; f < floors; f++) {
      const y = m.y + (f + 0.5) * floorH
      for (let c = 0; c < cols; c++) {
        const u = -span / 2 + (c + 0.5) * cell
        const isDoor = options.entrance && f === 0 && side === 0 && c === Math.floor(cols / 2)
        const glazing = tint(a.glass, a.rng.range(0.78, 1.19))
        windowTile(a, m, side as Side, u, y, cell, floorH, options.fill ?? 0.69, wall, glazing, isDoor)
      }
    }
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    a.mesh.box(m.x + sx * (m.w / 2 - 0.24), m.y + m.h / 2, m.z + sz * (m.d / 2 - 0.24), 0.48, m.h, 0.48, wall)
  }
  if (options.parapet !== false) parapet(a, m, Math.min(0.65, floorH * 0.22), wall)
}

/** Load-bearing floor edges, deep full-height mullions and recessed curtain glazing. */
function curtainBlock(a: Architecture, m: Mass, maxCols = 8): void {
  const floors = Math.max(1, Math.min(26, Math.round(m.floors)))
  const floorH = m.h / floors
  a.mesh.box(m.x, m.y + m.h / 2, m.z - m.d * 0.1, m.w * 0.24, m.h, m.d * 0.3, CONCRETE)
  for (let f = 0; f <= floors; f++) a.mesh.box(m.x, m.y + f * floorH + 0.1, m.z, m.w, 0.2, m.d, DARK_STONE)
  for (let side = 0; side < 4; side++) {
    const span = side < 2 ? m.w : m.d
    const cols = Math.max(2, Math.min(maxCols, Math.round(span / 3.2)))
    const cell = span / cols
    for (let c = 0; c <= cols; c++) {
      const p = facePoint(m, side as Side, -span / 2 + c * cell, m.y + m.h / 2, 0.08)
      a.mesh.box(...p, side < 2 ? 0.13 : 0.35, m.h, side < 2 ? 0.35 : 0.13, ALUMINIUM)
    }
    for (let f = 0; f < floors; f++) {
      const y0 = m.y + f * floorH + 0.18, y1 = m.y + (f + 1) * floorH - 0.12
      wallRectangle(a, m, side as Side, -span / 2, y0, span / 2, y0 + floorH * 0.18, -0.08, DARK_STONE)
      for (let c = 0; c < cols; c++) {
        const u0 = -span / 2 + c * cell + 0.07, u1 = u0 + cell - 0.14
        const glazing = tint(a.glass, a.rng.range(0.81, 1.24))
        wallRectangle(a, m, side as Side, u0, y0 + floorH * 0.18, u1, y1, -0.12, glazing)
        // A narrow brighter reflected edge gives a readable panel surface without a texture.
        wallRectangle(a, m, side as Side, u0 + 0.04, y0 + floorH * 0.2, u0 + Math.min(0.25, cell * 0.1), y1 - 0.07, -0.11, tint(glazing, 1.23))
      }
      const p = facePoint(m, side as Side, 0, y1, 0.025)
      a.mesh.box(...p, side < 2 ? span : 0.22, 0.12, side < 2 ? 0.22 : span, FRAME)
    }
  }
  parapet(a, m, 0.5, FRAME)
}

function rooftopPlant(a: Architecture, x: number, y: number, z: number, w: number, d: number, count = 3): void {
  const size = Math.max(0.8, Math.min(2.2, w / (count * 1.8), d * 0.32))
  for (let i = 0; i < count; i++) {
    const px = x + (i - (count - 1) / 2) * size * 1.65
    a.mesh.box(px, y + 0.11, z, size * 1.35, 0.22, size * 1.4, DARK_STONE)
    a.mesh.box(px, y + size * 0.32, z, size * 1.2, size * 0.53, size * 1.1, ALUMINIUM)
    a.mesh.cylinder(px, y + size * 0.58, z, size * 0.37, 0.11, FRAME, 10)
    a.mesh.cylinder(px, y + size * 0.69, z, size * 0.13, 0.04, DARK_STONE, 8)
    for (let blade = 0; blade < 3; blade++) {
      const angle = blade * Math.PI * 2 / 3
      a.mesh.beam([px, y + size * 0.7, z], [px + Math.cos(angle) * size * 0.31, y + size * 0.7, z + Math.sin(angle) * size * 0.31], 0.09, 0.025, ALUMINIUM)
    }
    for (let l = 0; l < 4; l++) a.mesh.box(px, y + 0.25 + l * size * 0.085, z + size * 0.56, size * 0.92, 0.035, 0.04, FRAME)
  }
  a.mesh.box(x, y + 0.2, z - size * 0.8, Math.min(w * 0.8, count * size * 1.7), 0.3, 0.35, ALUMINIUM)
}

function stairs(a: Architecture, x: number, z: number, w: number, rise: number, run: number, y = 0): void {
  const steps = Math.max(2, Math.min(12, Math.ceil(rise / 0.2)))
  for (let i = 0; i < steps; i++) {
    const sh = rise * (steps - i) / steps
    a.mesh.box(x, y + sh / 2, z + run * (i + 0.5) / steps, w, sh, run / steps, CONCRETE)
  }
}

function entryCanopy(a: Architecture, x: number, z: number, width: number, depth: number, y = 3.1, glass = false): void {
  a.mesh.box(x, y, z, width, 0.2, depth, glass ? BLUE_GLASS : a.accent)
  a.mesh.box(x, y + 0.14, z + depth / 2, width, 0.15, 0.18, ALUMINIUM)
  for (const side of [-1, 1]) {
    a.mesh.box(x + side * (width / 2 - 0.3), y / 2, z + depth * 0.28, 0.17, y, 0.17, FRAME)
    a.mesh.beam([x + side * (width / 2 - 0.3), y - 0.6, z + depth * 0.28],
      [x + side * (width / 2 - 0.3), y - 0.13, z - depth * 0.2], 0.1, 0.12, FRAME)
  }
}

function office(a: Architecture): void {
  const variant = a.rng.int(0, 2)
  const podiumH = Math.min(8, a.h * 0.22)
  const podium: Mass = { x: 0, z: 0, y: 0, w: a.w, d: a.d, h: podiumH, floors: Math.min(2, a.floors) }
  masonryBlock(a, podium, { fill: 0.86, columns: 8, wall: tint(a.wall, 0.9), entrance: true })
  const towerFloors = Math.max(1, a.floors - 2)
  if (variant === 1 && a.floors >= 9 && a.w > 24) {
    const tall: Mass = { x: -a.w * 0.18, z: -a.d * 0.06, y: podiumH + 0.2, w: a.w * 0.6, d: a.d * 0.8, h: a.h - podiumH - 0.7, floors: towerFloors }
    curtainBlock(a, tall)
    const shoulder: Mass = { x: a.w * 0.28, z: a.d * 0.12, y: podiumH + 0.2, w: a.w * 0.26, d: a.d * 0.48, h: (a.h - podiumH) * 0.64, floors: Math.max(1, Math.round(towerFloors * 0.64)) }
    masonryBlock(a, shoulder, { fill: 0.66, columns: 4 })
    rooftopPlant(a, tall.x, tall.y + tall.h + 0.25, tall.z, tall.w, tall.d, 3)
  } else {
    const tower: Mass = { x: variant === 2 ? -a.w * 0.055 : 0, z: -a.d * 0.055, y: podiumH + 0.2, w: a.w * 0.83, d: a.d * 0.79, h: a.h - podiumH - 0.7, floors: towerFloors }
    if (variant === 2) masonryBlock(a, tower, { fill: 0.81, columns: 7 })
    else curtainBlock(a, tower, 9)
    const coreH = Math.min(3.5, a.h * 0.045)
    a.mesh.box(tower.x - tower.w * 0.18, a.h + coreH / 2 - 0.4, tower.z - tower.d * 0.15, tower.w * 0.22, coreH, tower.d * 0.3, DARK_STONE)
    rooftopPlant(a, tower.x + tower.w * 0.13, tower.y + tower.h + 0.25, tower.z + tower.d * 0.16, tower.w * 0.55, tower.d * 0.4, 3)
  }
  entryCanopy(a, 0, a.d / 2 + 0.8, Math.min(a.w * 0.36, 12), 2.2, 3.4, true)
  // A raised planted terrace is physically separate from the tower and podium.
  for (const side of [-1, 1]) {
    a.mesh.box(side * a.w * 0.33, podiumH + 0.44, a.d * 0.4, a.w * 0.18, 0.5, 0.8, DARK_STONE)
    a.mesh.box(side * a.w * 0.33, podiumH + 0.82, a.d * 0.4, a.w * 0.16, 0.34, 0.65, new Color('#60715a'))
  }
}

function awning(a: Architecture, x: number, z: number, w: number, y: number, accent: Color): void {
  const stripes = 6
  for (let i = 0; i < stripes; i++) {
    const left = x - w / 2 + i * w / stripes, right = left + w / stripes
    const color = i % 2 === 0 ? accent : WHITE
    a.mesh.quad([left, y - 0.35, z + 1.35], [right, y - 0.35, z + 1.35], [right, y, z], [left, y, z], color)
    a.mesh.quad([left, y - 0.62, z + 1.35], [right, y - 0.62, z + 1.35], [right, y - 0.35, z + 1.35], [left, y - 0.35, z + 1.35], color)
  }
  a.mesh.beam([x - w / 2, y - 1, z], [x - w / 2, y - 0.35, z + 1.35], 0.08, 0.09, FRAME)
  a.mesh.beam([x + w / 2, y - 1, z], [x + w / 2, y - 0.35, z + 1.35], 0.08, 0.09, FRAME)
}

function commercial(a: Architecture): void {
  if (a.floors >= 8) {
    // Hotels have repeated room openings and a much heavier podium than an office.
    const podiumH = Math.min(7, a.h * 0.2)
    masonryBlock(a, { x: 0, z: 0, y: 0, w: a.w, d: a.d, h: podiumH, floors: 2 }, { fill: 0.9, entrance: true })
    const tower: Mass = { x: -a.w * 0.04, z: -a.d * 0.06, y: podiumH + 0.2, w: a.w * 0.84, d: a.d * 0.81, h: a.h - podiumH - 0.65, floors: Math.min(22, a.floors - 2) }
    masonryBlock(a, tower, { fill: 0.58, columns: 7, wall: a.wall })
    for (const sign of [-1, 1]) a.mesh.box(sign * tower.w * 0.37, podiumH + tower.h / 2, tower.z + tower.d / 2 + 0.1, 0.7, tower.h, 0.65, a.accent)
    entryCanopy(a, 0, a.d / 2 + 1.2, a.w * 0.48, 3.2, 3.5)
    rooftopPlant(a, 0, tower.y + tower.h + 0.2, -a.d * 0.18, a.w * 0.6, a.d * 0.5, 3)
    return
  }
  const firstH = Math.min(4.5, a.h * 0.55)
  const base: Mass = { x: 0, z: 0, y: 0, w: a.w, d: a.d, h: firstH, floors: 1 }
  const shopCount = Math.max(2, Math.min(6, Math.round(a.w / 6)))
  masonryBlock(a, base, { fill: 0.87, columns: shopCount, entrance: true, parapet: false, wall: tint(a.wall, 0.8) })
  if (a.h - firstH > 0.7) {
    const upper: Mass = { x: a.w * 0.03, z: -a.d * 0.035, y: firstH, w: a.w * 0.94, d: a.d * 0.9, h: a.h - firstH - 0.55, floors: Math.max(1, a.floors - 1) }
    masonryBlock(a, upper, { fill: a.building.use === 'retail' ? 0.58 : 0.73, columns: 7 })
    rooftopPlant(a, 0, a.h - 0.32, -a.d * 0.16, a.w * 0.65, a.d * 0.5, 2)
  } else parapet(a, base)
  for (let i = 0; i < shopCount; i++) {
    const shopW = a.w / shopCount, x = -a.w / 2 + shopW * (i + 0.5)
    const accent = new Color(a.rng.pick(['#446d6b', '#8b5b50', '#aa9872', '#4f6276', '#68724f']))
    a.mesh.box(x, firstH - 0.55, a.d / 2 + 0.14, shopW * 0.9, 0.7, 0.25, accent)
    awning(a, x, a.d / 2 + 0.18, shopW * 0.88, firstH - 0.96, accent)
    // Recessed display cabinets behind the opening and a pavement sign stand.
    a.mesh.box(x + shopW * 0.2, 0.65, a.d / 2 - 0.62, shopW * 0.28, 1.05, 0.42, WOOD)
    a.mesh.box(x - shopW * 0.31, 0.65, a.d / 2 + 1.25, 0.56, 1.3, 0.22, accent)
    a.mesh.box(x - shopW * 0.31, 0.76, a.d / 2 + 1.37, 0.43, 0.7, 0.03, WHITE)
  }
  a.mesh.box(a.w * 0.36, a.h + 1.25, -a.d * 0.2, a.w * 0.21, 2.1, 0.35, a.accent)
  for (const x of [a.w * 0.3, a.w * 0.42]) a.mesh.box(x, a.h + 0.25, -a.d * 0.2, 0.13, 1.2, 0.16, FRAME)
}

function school(a: Architecture): void {
  if (a.floors === 1) { gymnasium(a); return }
  const rear: Mass = { x: 0, z: -a.d * 0.33, y: 0, w: a.w, d: a.d * 0.34, h: a.h - 0.65, floors: a.floors }
  masonryBlock(a, rear, { fill: 0.76, columns: 10, wall: LIGHT_STONE, entrance: true })
  for (const sign of [-1, 1]) {
    const wing: Mass = { x: sign * a.w * 0.395, z: a.d * 0.17, y: 0, w: a.w * 0.21, d: a.d * 0.66, h: a.h * (sign === 1 ? 0.76 : 0.88), floors: Math.max(2, a.floors - 1) }
    masonryBlock(a, wing, { fill: 0.79, columns: 6, wall: LIGHT_STONE })
    // External escape stair flights, with individual treads and landings.
    const x = wing.x - sign * (wing.w / 2 + 0.7)
    const floorH = wing.h / wing.floors
    for (let f = 0; f < wing.floors - 1; f++) {
      stairs(a, x, -a.d * 0.025, 1.5, floorH, 4.6, f * floorH)
      a.mesh.box(x, (f + 1) * floorH + 0.07, -a.d * 0.035, 1.8, 0.14, 1.7, CONCRETE)
      a.mesh.beam([x - 0.85, f * floorH + 1, -a.d * 0.025 + 4.6], [x - 0.85, (f + 1) * floorH + 1, -a.d * 0.025], 0.07, 0.08, FRAME)
    }
  }
  // Covered open-sided connection around a real courtyard.
  a.mesh.box(0, 3.1, a.d * 0.11, a.w * 0.58, 0.28, 2.5, LIGHT_STONE)
  for (let i = 0; i < 7; i++) a.mesh.box(-a.w * 0.27 + i * a.w * 0.09, 1.5, a.d * 0.11 + 1.03, 0.26, 3, 0.26, CONCRETE)
  a.mesh.box(0, 0.07, a.d * 0.32, a.w * 0.51, 0.14, a.d * 0.25, new Color('#a3a294'))
  // Clock face and hands on the central stair tower.
  const clockY = a.h * 0.8, clockZ = -a.d * 0.16 + 0.2
  a.mesh.box(0, clockY, clockZ, 2.2, 2.2, 0.25, WHITE)
  a.mesh.box(0, clockY + 0.35, clockZ + 0.14, 0.12, 0.8, 0.08, FRAME)
  a.mesh.box(0.35, clockY, clockZ + 0.14, 0.8, 0.12, 0.08, FRAME)
  rooftopPlant(a, -a.w * 0.15, rear.h + 0.25, rear.z, a.w * 0.4, rear.d, 3)
}

/** Barrel-vaulted assembly / sports hall, with visible end trusses. */
function gymnasium(a: Architecture): void {
  const wallH = a.h * 0.62, rise = a.h - wallH
  const hall: Mass = { x: 0, z: 0, y: 0, w: a.w, d: a.d, h: wallH, floors: 1 }
  masonryBlock(a, hall, { fill: 0.75, columns: 8, parapet: false, wall: LIGHT_STONE, entrance: true })
  const segments = 14
  const arc = (i: number, z: number, offset = 0): Point => {
    const u = i / segments
    return [-a.w / 2 + a.w * u, wallH + Math.sin(u * Math.PI) * rise + offset, z]
  }
  for (let i = 0; i < segments; i++) {
    a.mesh.quad(arc(i, a.d / 2), arc(i + 1, a.d / 2), arc(i + 1, -a.d / 2), arc(i, -a.d / 2), i === 4 || i === 9 ? GREEN_GLASS : ALUMINIUM)
    for (const sign of [-1, 1]) {
      const z = sign * a.d / 2
      const p = arc(i, z), q = arc(i + 1, z)
      if (sign === 1) a.mesh.quad([-a.w / 2 + a.w * i / segments, wallH, z], [-a.w / 2 + a.w * (i + 1) / segments, wallH, z], q, p, BLUE_GLASS)
      else a.mesh.quad([-a.w / 2 + a.w * (i + 1) / segments, wallH, z], [-a.w / 2 + a.w * i / segments, wallH, z], p, q, BLUE_GLASS)
    }
  }
  for (let r = 0; r < 6; r++) {
    const z = -a.d / 2 + a.d * r / 5
    for (let i = 0; i < segments; i++) a.mesh.beam(arc(i, z, 0.07), arc(i + 1, z, 0.07), 0.16, 0.19, FRAME)
    a.mesh.beam([-a.w / 2, wallH + 0.2, z], [a.w / 2, wallH + 0.2, z], 0.19, 0.26, FRAME)
    if (r === 0 || r === 5) for (let i = 1; i < segments; i += 2) a.mesh.beam([-a.w / 2 + a.w * i / segments, wallH, z], arc(i, z), 0.1, 0.1, FRAME)
  }
  entryCanopy(a, 0, a.d / 2 + 1.3, a.w * 0.24, 3.1, 3.4)
}

function hospital(a: Architecture): void {
  const podiumH = a.h * 0.28
  const podium: Mass = { x: 0, z: 0, y: 0, w: a.w, d: a.d, h: podiumH, floors: Math.max(1, Math.min(2, a.floors - 1)) }
  masonryBlock(a, podium, { fill: 0.75, columns: 9, wall: LIGHT_STONE, entrance: true })
  const wardH = a.h - podiumH - 0.7
  const wardFloors = Math.max(1, a.floors - podium.floors)
  for (const sign of [-1, 1]) {
    const ward: Mass = { x: sign * a.w * 0.3, z: -a.d * 0.055, y: podiumH + 0.2, w: a.w * 0.28, d: a.d * 0.79, h: sign < 0 ? wardH : wardH * 0.92, floors: wardFloors }
    masonryBlock(a, ward, { fill: 0.65, columns: 7, wall: WHITE })
    rooftopPlant(a, ward.x, ward.y + ward.h + 0.25, -a.d * 0.14, ward.w, ward.d * 0.55, 2)
  }
  const link: Mass = { x: 0, z: -a.d * 0.23, y: podiumH + 0.2, w: a.w * 0.32, d: a.d * 0.22, h: wardH * 0.82, floors: Math.max(1, wardFloors - 1) }
  curtainBlock(a, link, 5)
  const canopyH = Math.min(4.2, podiumH * 0.7)
  entryCanopy(a, 0, a.d / 2 + 1.3, a.w * 0.4, 3.3, canopyH, true)
  // Blue medical emblem, raised from its backing sign.
  const crossY = a.h * 0.77, crossX = -a.w * 0.3, crossZ = a.d * 0.342
  const size = Math.min(3.8, a.w * 0.12)
  a.mesh.box(crossX, crossY, crossZ, size * 1.18, size * 1.18, 0.25, WHITE)
  const blue = new Color('#547f93')
  a.mesh.box(crossX, crossY, crossZ + 0.18, size * 0.3, size, 0.14, blue)
  a.mesh.box(crossX, crossY, crossZ + 0.18, size, size * 0.3, 0.14, blue)
  if (a.w > 70 && a.d > 60) {
    const x = 0, z = a.d * 0.2, y = podiumH + 0.23, radius = Math.min(9, a.w * 0.105)
    a.mesh.cylinder(x, y, z, radius, 0.12, new Color('#5d746d'), 28)
    for (let i = 0; i < 28; i++) {
      const p = i / 28 * Math.PI * 2, q = (i + 1) / 28 * Math.PI * 2
      a.mesh.beam([x + Math.cos(p) * radius * 0.88, y + 0.16, z + Math.sin(p) * radius * 0.88],
        [x + Math.cos(q) * radius * 0.88, y + 0.16, z + Math.sin(q) * radius * 0.88], 0.27, 0.025, WHITE)
    }
    a.mesh.box(x - radius * 0.28, y + 0.18, z, 0.55, 0.04, radius * 0.85, WHITE)
    a.mesh.box(x + radius * 0.28, y + 0.18, z, 0.55, 0.04, radius * 0.85, WHITE)
    a.mesh.box(x, y + 0.18, z, radius * 0.56, 0.04, 0.55, WHITE)
  }
}

function factory(a: Architecture): void {
  const metal = a.building.constructionType !== 'wood'
  const wallH = a.h * 0.73, roofH = a.h - wallH
  const m: Mass = { x: 0, z: 0, y: 0, w: a.w, d: a.d, h: wallH, floors: 1 }
  const cladding = metal ? new Color(a.rng.pick(['#aeb8b7', '#bec3bd', '#8d9b9d', '#b4aea0'])) : new Color('#8f806b')
  const bays = Math.max(2, Math.min(5, Math.round(a.w / 15)))
  const bayW = a.w / bays
  a.mesh.box(0, 0.15, 0, a.w, 0.3, a.d, CONCRETE)
  // Tall loading openings have lintels, jambs and doors inset into the opening.
  for (let side = 0; side < 4; side++) {
    const span = side < 2 ? a.w : a.d
    const cols = side < 2 ? bays : Math.max(2, Math.min(6, Math.round(a.d / 9)))
    const cell = span / cols
    for (let i = 0; i < cols; i++) {
      const u = -span / 2 + (i + 0.5) * cell
      windowTile(a, m, side as Side, u, wallH * 0.5, cell, wallH, side === 0 ? 0.77 : 0.67, cladding, side === 0 ? RECESS : GREEN_GLASS, side === 0)
      if (side === 0) {
        const doorH = wallH * (i === 0 ? 0.24 : 0.67)
        for (let j = 0; j < 9; j++) wallRectangle(a, m, 0, u - cell * 0.36, wallH - doorH + j * doorH / 9,
          u + cell * 0.36, wallH - doorH + (j + 0.8) * doorH / 9, -0.15, ALUMINIUM)
        a.mesh.box(u, 0.46, a.d / 2 + 0.5, cell * 0.81, 0.62, 1.2, CONCRETE)
        // Stacked cargo visible through the partly raised first shutter.
        if (i === 0) {
          a.mesh.box(u + cell * 0.18, 1.35, a.d / 2 - 2.3, cell * 0.28, 2.2, 2.4, WOOD)
          a.mesh.box(u - cell * 0.19, 0.85, a.d / 2 - 2.6, cell * 0.27, 1.2, 2.2, new Color('#8c8067'))
        }
      }
    }
    const ribs = Math.max(3, Math.min(22, Math.round(span / 1.8)))
    for (let i = 0; i <= ribs; i++) {
      const point = facePoint(m, side as Side, -span / 2 + span * i / ribs, wallH / 2, 0.05)
      a.mesh.box(...point, side < 2 ? 0.09 : 0.12, wallH, side < 2 ? 0.12 : 0.09, tint(cladding, 0.83))
    }
  }
  for (let i = 0; i < bays; i++) {
    const left = -a.w / 2 + i * bayW, right = left + bayW
    const ridge = metal ? left + bayW * 0.76 : (left + right) / 2
    const top = wallH + roofH
    a.mesh.quad([left, wallH, a.d / 2 + 0.3], [ridge, top, a.d / 2 + 0.3], [ridge, top, -a.d / 2 - 0.3], [left, wallH, -a.d / 2 - 0.3], metal ? ROOF : DARK_STONE)
    a.mesh.quad([ridge, top, a.d / 2 + 0.3], [right, wallH, a.d / 2 + 0.3], [right, wallH, -a.d / 2 - 0.3], [ridge, top, -a.d / 2 - 0.3], metal ? BLUE_GLASS : DARK_STONE)
    for (const sign of [-1, 1]) {
      const z = sign * a.d / 2
      if (sign === 1) a.mesh.triangle([left, wallH, z], [right, wallH, z], [ridge, top, z], cladding)
      else a.mesh.triangle([right, wallH, z], [left, wallH, z], [ridge, top, z], cladding)
      a.mesh.beam([left, wallH, z + sign * 0.12], [ridge, top, z + sign * 0.12], 0.18, 0.2, FRAME)
      a.mesh.beam([ridge, top, z + sign * 0.12], [right, wallH, z + sign * 0.12], 0.18, 0.2, FRAME)
      a.mesh.beam([left, wallH, z + sign * 0.12], [right, wallH, z + sign * 0.12], 0.18, 0.2, FRAME)
      for (let t = 1; t < 4; t++) a.mesh.beam([left + bayW * t / 4, wallH, z + sign * 0.14], [ridge, top - 0.12, z + sign * 0.14], 0.1, 0.12, FRAME)
    }
    for (let r = 1; r < 7; r++) {
      const z = -a.d / 2 + a.d * r / 7
      a.mesh.beam([left, wallH + 0.05, z], [ridge, top + 0.05, z], 0.075, 0.1, ALUMINIUM)
    }
    a.mesh.box(left + 0.12, wallH + 0.1, 0, 0.26, 0.2, a.d + 0.8, ALUMINIUM)
  }
  // Side-mounted drainage and extract stacks.
  for (const sign of [-1, 1]) {
    a.mesh.cylinder(sign * (a.w / 2 + 0.13), 0.1, -a.d * 0.36, 0.1, wallH, FRAME, 6)
    a.mesh.cylinder(sign * a.w * 0.24, wallH + roofH * 0.4, -a.d * 0.15, 0.65, roofH * 0.75, ALUMINIUM, 10)
  }
}

function station(a: Architecture): void {
  const sideW = a.w * 0.19, mainW = a.w * 0.61
  const baseH = a.h * 0.53
  for (const sign of [-1, 1]) masonryBlock(a, { x: sign * a.w * 0.405, z: -a.d * 0.02, y: 0, w: sideW, d: a.d * 0.96, h: a.h * 0.85, floors: Math.max(2, a.floors - 1) }, { columns: 5, fill: 0.77, entrance: true })
  const concourse: Mass = { x: 0, z: -a.d * 0.05, y: 0, w: mainW, d: a.d * 0.86, h: baseH, floors: 2 }
  curtainBlock(a, concourse, 9)
  const roofY = baseH + 0.6
  const segments = 12, radius = mainW / 2
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments * Math.PI, t1 = (i + 1) / segments * Math.PI
    const x0 = -Math.cos(t0) * radius, x1 = -Math.cos(t1) * radius
    const y0 = roofY + Math.sin(t0) * a.h * 0.28, y1 = roofY + Math.sin(t1) * a.h * 0.28
    a.mesh.quad([x0, y0, a.d * 0.48], [x1, y1, a.d * 0.48], [x1, y1, -a.d * 0.51], [x0, y0, -a.d * 0.51], i % 3 === 1 ? BLUE_GLASS : LIGHT_STONE)
    for (const z of [-a.d * 0.5, 0, a.d * 0.46]) a.mesh.beam([x0, y0 + 0.05, z], [x1, y1 + 0.05, z], 0.16, 0.2, FRAME)
  }
  entryCanopy(a, 0, a.d / 2 + 1.8, mainW * 0.92, 4.2, 4.4, true)
  for (let i = 0; i < 7; i++) a.mesh.box(-mainW * 0.36 + i * mainW * 0.12, 1.1, a.d * 0.36, 0.38, 1.1, 1.3, ALUMINIUM)
  a.mesh.box(0, baseH * 0.79, a.d * 0.49, mainW * 0.48, 1.4, 0.35, new Color('#50756c'))
  stairs(a, 0, a.d / 2 + 0.4, mainW * 0.62, 0.6, 1.1)
}

function civic(a: Architecture): void {
  const high: Mass = { x: -a.w * 0.16, z: -a.d * 0.08, y: 0.45, w: a.w * 0.65, d: a.d * 0.81, h: a.h - 1.1, floors: a.floors }
  masonryBlock(a, high, { fill: 0.57, columns: 7, wall: LIGHT_STONE, entrance: true })
  const reading: Mass = { x: a.w * 0.335, z: a.d * 0.075, y: 0.45, w: a.w * 0.33, d: a.d * 0.77, h: a.h * 0.63, floors: Math.max(1, a.floors - 1) }
  curtainBlock(a, reading, 5)
  // Deep civic colonnade with a stone entablature and separate stair podium.
  const frontZ = a.d * 0.35, porticoH = Math.min(4.5, a.h * 0.5)
  a.mesh.box(-a.w * 0.15, porticoH + 0.5, frontZ + 1.4, a.w * 0.6, 0.55, 3.4, LIGHT_STONE)
  for (let i = 0; i < 6; i++) {
    const x = -a.w * 0.41 + i * a.w * 0.105
    a.mesh.cylinder(x, 0.5, frontZ + 2.5, 0.26, porticoH - 0.18, LIGHT_STONE, 8)
    a.mesh.box(x, 0.65, frontZ + 2.5, 0.68, 0.25, 0.68, CONCRETE)
    a.mesh.box(x, porticoH + 0.3, frontZ + 2.5, 0.65, 0.2, 0.65, LIGHT_STONE)
  }
  stairs(a, -a.w * 0.15, frontZ + 2.4, a.w * 0.63, 0.5, 1.5)
  rooftopPlant(a, -a.w * 0.15, high.y + high.h + 0.25, -a.d * 0.16, a.w * 0.35, a.d * 0.3, 2)
  // Sloped clerestory on the lower reading / community room wing.
  const y = reading.y + reading.h + 0.22
  a.mesh.quad([reading.x - reading.w * 0.37, y, reading.z + reading.d * 0.34], [reading.x + reading.w * 0.37, y, reading.z + reading.d * 0.34],
    [reading.x + reading.w * 0.37, y + 0.9, reading.z - reading.d * 0.34], [reading.x - reading.w * 0.37, y + 0.9, reading.z - reading.d * 0.34], BLUE_GLASS)
}

function parking(a: Architecture): void {
  const floors = Math.max(2, Math.min(8, a.floors)), floorH = a.h / floors
  const colsX = Math.max(3, Math.min(7, Math.round(a.w / 7)))
  const colsZ = Math.max(3, Math.min(7, Math.round(a.d / 7)))
  for (let f = 0; f <= floors; f++) {
    const y = f * floorH
    a.mesh.box(0, y + 0.15, 0, a.w, 0.3, a.d, CONCRETE)
    for (const sign of [-1, 1]) {
      a.mesh.box(0, y + 0.65, sign * (a.d / 2 - 0.15), a.w, 0.6, 0.25, WHITE)
      a.mesh.box(sign * (a.w / 2 - 0.15), y + 0.65, 0, 0.25, 0.6, a.d, WHITE)
    }
    if (f < floors) {
      for (let x = 0; x < colsX; x++) for (let z = 0; z < colsZ; z++) a.mesh.box(-a.w * 0.44 + a.w * 0.88 * x / (colsX - 1), y + floorH / 2,
        -a.d * 0.44 + a.d * 0.88 * z / (colsZ - 1), 0.42, floorH, 0.42, CONCRETE)
      a.mesh.beam([a.w * 0.29, y + 0.3, -a.d * 0.31], [a.w * 0.29, y + floorH + 0.3, a.d * 0.31], a.w * 0.15, 0.24, DARK_STONE)
    }
    for (let i = 0; i < 9; i++) a.mesh.box(-a.w * 0.39 + a.w * 0.78 * i / 8, y + 0.315, -a.d * 0.3, 0.08, 0.015, a.d * 0.21, WHITE)
  }
  a.mesh.box(-a.w * 0.3, a.h - 0.8, a.d / 2 + 0.25, 2.2, 2.5, 0.3, new Color('#567fa0'))
}

function temple(a: Architecture): void {
  const bodyH = a.h * 0.59
  a.mesh.box(0, 0.5, 0, a.w * 0.94, 1, a.d * 0.9, CONCRETE)
  const main: Mass = { x: 0, z: 0, y: 1, w: a.w * 0.76, d: a.d * 0.74, h: bodyH - 1, floors: 1 }
  masonryBlock(a, main, { fill: 0.8, columns: 6, wall: WOOD, parapet: false })
  for (const sign of [-1, 1]) for (let i = 0; i < 7; i++) a.mesh.box(-a.w * 0.34 + i * a.w * 0.113, bodyH * 0.53, sign * a.d * 0.4, 0.3, bodyH * 0.88, 0.3, WOOD)
  const roofRise = a.h - bodyH
  const left = -a.w * 0.53, right = a.w * 0.53, front = a.d * 0.55, back = -a.d * 0.55
  const darkRoof = new Color('#575e5b')
  // Two gently swept roof pitches with wide, thick eaves.
  for (const sign of [-1, 1]) {
    const z = sign === 1 ? front : back
    const sections = [[0, bodyH + roofRise], [z * 0.64, bodyH + roofRise * 0.31], [z, bodyH + roofRise * 0.19]]
    for (let i = 0; i < sections.length - 1; i++) {
      const p = sections[i], q = sections[i + 1]
      if (sign === 1) a.mesh.quad([left, q[1], q[0]], [right, q[1], q[0]], [right, p[1], p[0]], [left, p[1], p[0]], darkRoof)
      else a.mesh.quad([right, q[1], q[0]], [left, q[1], q[0]], [left, p[1], p[0]], [right, p[1], p[0]], darkRoof)
    }
    a.mesh.box(0, bodyH + roofRise * 0.18, z, a.w * 1.08, 0.25, 0.32, darkRoof)
    for (let i = 0; i <= 18; i++) {
      const x = left + (right - left) * i / 18
      a.mesh.beam([x, bodyH + roofRise + 0.035, 0], [x, bodyH + roofRise * 0.32, z * 0.64], 0.07, 0.08, tint(darkRoof, 1.13))
      a.mesh.beam([x, bodyH + roofRise * 0.32, z * 0.64], [x, bodyH + roofRise * 0.2, z], 0.07, 0.08, tint(darkRoof, 1.13))
    }
  }
  a.mesh.box(0, a.h + 0.09, 0, a.w * 1.08, 0.3, 0.4, darkRoof)
  stairs(a, 0, a.d * 0.42, a.w * 0.3, 1, 2.3)
}

/**
 * Deterministic detailed non-residential architecture. Its footprint and
 * heading come from the city model; small eaves/canopies extend at most a few
 * metres beyond it. Geometry can be merged, instanced, clipped and tinted by
 * the existing damage renderer without a material change.
 */
export function createDetailedBuilding(building: Building, seed: number): BufferGeometry {
  const rng = new Rng(mixSeed(seed, hashString(building.id + ':architecture')))
  const masonry = new Color(rng.pick(['#c7c5bc', '#d1cfc5', '#b7bbb8', '#c4beb0', '#b4aaa0']))
  const a: Architecture = {
    mesh: new ArchitectureMesh(), rng, building,
    w: finite(building.footprint.width, 3, 240), d: finite(building.footprint.depth, 3, 240),
    h: finite(building.height, 3, 400), floors: Math.round(finite(building.floors, 1, 120)),
    wall: masonry,
    accent: new Color(rng.pick(['#627d80', '#776e60', '#6f7764', '#536b7d', '#807567'])),
    glass: tint(building.use === 'hospital' || building.use === 'school' ? GREEN_GLASS : BLUE_GLASS, rng.range(0.88, 1.1)),
  }
  switch (building.use) {
    case 'office': office(a); break
    case 'commercial': case 'retail': commercial(a); break
    case 'school': school(a); break
    case 'hospital': hospital(a); break
    case 'factory': factory(a); break
    case 'station': station(a); break
    case 'civic': civic(a); break
    case 'parking': parking(a); break
    case 'temple': temple(a); break
    default:
      masonryBlock(a, { x: 0, z: 0, y: 0, w: a.w, d: a.d, h: a.h - 0.7, floors: a.floors }, { entrance: true })
  }
  const geometry = a.mesh.finish()
  geometry.name = `architecture:${building.id}`
  return geometry
}
