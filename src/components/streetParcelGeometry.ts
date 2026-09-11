import { BoxGeometry, BufferAttribute, Color, CylinderGeometry } from 'three'
import type { BufferGeometry } from 'three'
import type { Building, CityModel, Vec2 } from '../types/city'
import { hashUnit } from '../simulation/rng'

/** A ground-plane oriented rectangle, with Three.js' positive Y rotation. */
export interface ParcelRect {
  x: number
  z: number
  width: number
  depth: number
  yaw: number
}

export interface ParcelFeature extends ParcelRect {
  buildingId: string
  kind: 'approach' | 'forecourt' | 'parking' | 'wall' | 'planting' | 'marking' | 'furniture' | 'park_path' | 'plaza' | 'playground'
  y: number
  height: number
  color: string
  shape?: 'disc'
}

interface RoadParcel extends ParcelRect {
  a: Vec2
  b: Vec2
  kerbHalf: number
}

interface Frontage {
  point: Vec2
  normal: Vec2
  yaw: number
  width: number
  length: number
  target: Vec2
}

const BOX_FACES = new BoxGeometry(1, 1, 1)
const DISC_FACES = new CylinderGeometry(0.5, 0.5, 1, 32)
const GRID_SIZE = 32

function axes(rect: ParcelRect) {
  const c = Math.cos(rect.yaw), s = Math.sin(rect.yaw)
  return { ux: c, uz: -s, vx: s, vz: c }
}

function aabb(rect: ParcelRect, margin = 0) {
  const c = Math.abs(Math.cos(rect.yaw)), s = Math.abs(Math.sin(rect.yaw))
  const hw = c * rect.width / 2 + s * rect.depth / 2 + margin
  const hd = s * rect.width / 2 + c * rect.depth / 2 + margin
  return { minX: rect.x - hw, maxX: rect.x + hw, minZ: rect.z - hd, maxZ: rect.z + hd }
}

/** Exact OBB overlap: rotated buildings cannot accidentally acquire a wall inside them. */
export function parcelRectsOverlap(a: ParcelRect, b: ParcelRect, margin = 0): boolean {
  const aa = axes(a), ba = axes(b), dx = b.x - a.x, dz = b.z - a.z
  for (const [x, z] of [[aa.ux, aa.uz], [aa.vx, aa.vz], [ba.ux, ba.uz], [ba.vx, ba.vz]]) {
    const ar = Math.abs(x * aa.ux + z * aa.uz) * a.width / 2 + Math.abs(x * aa.vx + z * aa.vz) * a.depth / 2
    const br = Math.abs(x * ba.ux + z * ba.uz) * b.width / 2 + Math.abs(x * ba.vx + z * ba.vz) * b.depth / 2
    if (Math.abs(dx * x + dz * z) >= ar + br + margin - 1e-5) return false
  }
  return true
}

/** Small construction-time spatial index; it does not participate in simulation updates. */
class ParcelIndex<T extends ParcelRect> {
  private readonly cells = new Map<string, T[]>()

  add(rect: T) {
    const box = aabb(rect)
    for (let x = Math.floor(box.minX / GRID_SIZE); x <= Math.floor(box.maxX / GRID_SIZE); x++)
      for (let z = Math.floor(box.minZ / GRID_SIZE); z <= Math.floor(box.maxZ / GRID_SIZE); z++) {
        const key = `${x},${z}`, items = this.cells.get(key)
        if (items) items.push(rect)
        else this.cells.set(key, [rect])
      }
  }

  near(rect: ParcelRect, margin = 0): Set<T> {
    const box = aabb(rect, margin), result = new Set<T>()
    for (let x = Math.floor(box.minX / GRID_SIZE); x <= Math.floor(box.maxX / GRID_SIZE); x++)
      for (let z = Math.floor(box.minZ / GRID_SIZE); z <= Math.floor(box.maxZ / GRID_SIZE); z++)
        for (const item of this.cells.get(`${x},${z}`) ?? []) result.add(item)
    return result
  }
}

function buildingRect(b: Building): ParcelRect {
  return { x: b.position.x, z: b.position.z, width: b.footprint.width, depth: b.footprint.depth, yaw: b.rotation }
}

function roadParcels(city: CityModel): RoadParcel[] {
  const nodes = new Map(city.roadNetwork.nodes.map(n => [n.id, n.position]))
  const out: RoadParcel[] = []
  for (const road of city.roadNetwork.edges) {
    const a = nodes.get(road.from), b = nodes.get(road.to)
    if (!a || !b) continue
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz)
    if (length < 0.1) continue
    const kerbHalf = road.width / 2 + Math.min(3.2, Math.max(1.4, road.width * 0.16))
    out.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, width: kerbHalf * 2, depth: length, yaw: Math.atan2(dx, dz), a, b, kerbHalf })
  }
  return out
}

function circleOverlaps(rect: ParcelRect, point: Vec2, radius: number) {
  const a = axes(rect), dx = point.x - rect.x, dz = point.z - rect.z
  const x = Math.max(0, Math.abs(dx * a.ux + dz * a.uz) - rect.width / 2)
  const z = Math.max(0, Math.abs(dx * a.vx + dz * a.vz) - rect.depth / 2)
  return x * x + z * z < radius * radius - 1e-5
}

function shifted(rect: ParcelRect, x: number, z: number, width: number, depth: number): ParcelRect {
  const a = axes(rect)
  return { x: rect.x + a.ux * x + a.vx * z, z: rect.z + a.uz * x + a.vz * z, width, depth, yaw: rect.yaw }
}

function ribbon(a: Vec2, b: Vec2, width: number): ParcelRect {
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, width, depth: Math.hypot(b.x - a.x, b.z - a.z), yaw: Math.atan2(b.x - a.x, b.z - a.z) }
}

/**
 * Use-conditioned, bounded parcel details. Every physical feature is tested
 * against actual rotated footprints, carriageways, kerbs, and previous plots.
 * There are no artificial giant slabs filling whatever land remains empty.
 */
export function planStreetParcels(city: CityModel): ParcelFeature[] {
  const features: ParcelFeature[] = [], buildings = new ParcelIndex<ParcelRect>()
  const roads = roadParcels(city), roadIndex = new ParcelIndex<RoadParcel>()
  const plots = new ParcelIndex<ParcelRect>()
  for (const b of city.buildings) buildings.add(buildingRect(b))
  // The expanded rectangle indexes rounded endcaps too; exact checks follow below.
  for (const road of roads) roadIndex.add({ ...road, depth: road.depth + road.kerbHalf * 2 })
  const bounds = city.meta.bounds

  const clear = (rect: ParcelRect, checkPlots = true, buildingMargin = 0.12): boolean => {
    const box = aabb(rect)
    if (box.minX < bounds.minX || box.maxX > bounds.maxX || box.minZ < bounds.minZ || box.maxZ > bounds.maxZ) return false
    for (const b of buildings.near(rect, buildingMargin)) if (parcelRectsOverlap(rect, b, buildingMargin)) return false
    for (const indexed of roadIndex.near(rect)) {
      const road = { ...indexed, depth: Math.hypot(indexed.b.x - indexed.a.x, indexed.b.z - indexed.a.z) }
      if (parcelRectsOverlap(rect, road) || circleOverlaps(rect, road.a, road.kerbHalf) || circleOverlaps(rect, road.b, road.kerbHalf)) return false
    }
    if (checkPlots) for (const p of plots.near(rect)) if (parcelRectsOverlap(rect, p, 0.12)) return false
    return true
  }

  const add = (b: { id: string }, kind: ParcelFeature['kind'], rect: ParcelRect, color: string, height = 0.05, y = height / 2 + 0.026) => {
    features.push({ ...rect, buildingId: b.id, kind, color, height, y })
  }

  for (const b of city.buildings) {
    if (b.use === 'parking') continue
    const source = buildingRect(b), a = axes(source), candidates: Frontage[] = []
    const publicUse = ['commercial', 'retail', 'office', 'hospital', 'civic', 'school', 'station'].includes(b.use)
    const walkWidth = publicUse ? Math.min(4.2, b.footprint.width * 0.18) : b.use === 'factory' ? 3.4 : 1.55
    // Prefer a short, outward connection from one of the four real façades.
    for (let face = 0; face < 4; face++) {
      const normal = face < 2 ? { x: a.vx * (face === 0 ? 1 : -1), z: a.vz * (face === 0 ? 1 : -1) }
        : { x: a.ux * (face === 2 ? 1 : -1), z: a.uz * (face === 2 ? 1 : -1) }
      const half = (face < 2 ? source.depth : source.width) / 2
      const point = { x: source.x + normal.x * (half + 0.2), z: source.z + normal.z * (half + 0.2) }
      for (const road of roads) {
        const dx = road.b.x - road.a.x, dz = road.b.z - road.a.z, lengthSq = dx * dx + dz * dz
        const t = Math.max(0, Math.min(1, ((point.x - road.a.x) * dx + (point.z - road.a.z) * dz) / lengthSq))
        const cx = road.a.x + t * dx, cz = road.a.z + t * dz
        const vx = cx - point.x, vz = cz - point.z, distance = Math.hypot(vx, vz)
        if (distance < road.kerbHalf + 1.2 || distance > 105 || (vx * normal.x + vz * normal.z) / distance < 0.75) continue
        // A narrow walk touches the outer kerb without covering the carriageway.
        const remaining = distance - road.kerbHalf - walkWidth / 2 - 0.12
        const target = { x: point.x + vx / distance * remaining, z: point.z + vz / distance * remaining }
        candidates.push({ point, target, length: remaining, normal, yaw: Math.atan2(normal.x, normal.z), width: face < 2 ? source.width : source.depth })
      }
    }
    candidates.sort((x, y) => x.length - y.length)
    const front = candidates.find(c => clear(ribbon(c.point, c.target, walkWidth)))
    if (!front) continue
    const frontRect: ParcelRect = { x: front.point.x, z: front.point.z, width: front.width, depth: 0, yaw: front.yaw }
    let walkStart = front.point
    // Small forecourts match the building use and available setback, never the whole parcel.
    if (publicUse && front.length > 5.2) {
      const depth = Math.min(b.use === 'station' ? 6 : 3.4, front.length * 0.28)
      const court = shifted(frontRect, 0, depth / 2 + 0.15, Math.min(23, front.width * 0.68), depth)
      if (clear(court)) {
        add(b, 'forecourt', court, b.use === 'school' ? '#bdb6a1' : '#c2c3bc')
        plots.add(court)
        // Do not overlap two coplanar paving surfaces.
        const offset = depth + 0.3
        walkStart = { x: front.point.x + front.normal.x * offset, z: front.point.z + front.normal.z * offset }
        // Joint lines communicate individual paving slabs at street-level zoom.
        for (let x = -court.width / 2 + 2.4; x < court.width / 2 - 0.5; x += 2.4)
          add(b, 'marking', shifted(court, x, 0, 0.035, court.depth - 0.2), '#aeb1aa', 0.008, 0.082)
      }
    }
    const approach = ribbon(walkStart, front.target, walkWidth)
    if (approach.depth > 0.3 && clear(approach, false)) {
      add(b, 'approach', approach, b.use === 'factory' ? '#adaea6' : '#c0beb2')
      plots.add(approach)
    }

    const identity = hashUnit(city.meta.simulationSeed, b.id)
    // A house gets a single modest driveway; businesses get a short row of bays.
    const slots = publicUse ? 2 + Math.floor(identity * 3) : b.use === 'factory' ? 3 : 1
    const parkingWidth = slots * 2.55 + 0.5, parkingDepth = 5.7
    if (front.length > parkingDepth + 1 && front.width > parkingWidth + walkWidth + 2) {
      for (const side of identity > 0.5 ? [1, -1] : [-1, 1]) {
        const x = side * (walkWidth / 2 + parkingWidth / 2 + 0.9)
        const parking = shifted(frontRect, x, parkingDepth / 2 + 0.55, parkingWidth, parkingDepth)
        if (!clear(parking)) continue
        const apronStart = shifted(parking, 0, parkingDepth / 2 + 0.15, 0, 0)
        const frontageAxes = axes(frontRect)
        const apronEnd = { x: front.target.x + frontageAxes.ux * x, z: front.target.z + frontageAxes.uz * x }
        const driveway = ribbon(apronStart, apronEnd, 2.8)
        // A parking row must have a real access strip; do not leave isolated
        // white rectangles floating in a lawn or behind another building.
        if (driveway.depth > 0.5 && !clear(driveway)) continue
        add(b, 'parking', parking, '#979d9b')
        plots.add(parking)
        if (driveway.depth > 0.5) {
          add(b, 'approach', driveway, '#a8aca6')
          plots.add(driveway)
        }
        for (let k = 0; k <= slots; k++) {
          const lineX = -slots * 2.55 / 2 + k * 2.55
          add(b, 'marking', shifted(parking, lineX, -0.1, 0.085, 5.0), '#e5e1d3', 0.016, 0.088)
        }
        for (let k = 0; k < slots; k++) {
          const bayX = -slots * 2.55 / 2 + (k + 0.5) * 2.55
          add(b, 'furniture', shifted(parking, bayX, -1.9, 1.6, 0.18), '#cac8bd', 0.12, 0.14)
          add(b, 'marking', shifted(parking, bayX, -2.55, 2.45, 0.08), '#e5e1d3', 0.016, 0.088)
        }
        break
      }
    }

    // Low boundaries leave entrances and ground-floor glazing visible. They
    // only occupy lateral setbacks, never the route to the street.
    for (const side of [-1, 1]) {
      const length = Math.min(9.5, Math.max(2.2, front.length * 0.38))
      const edge = shifted(frontRect, side * (front.width / 2 + 0.55), length / 2 + 0.6, 0.28, length)
      if (clear(edge)) {
        const hedge = b.use !== 'factory' && identity > 0.36
        add(b, hedge ? 'planting' : 'wall', edge, hedge ? '#718468' : '#b4b3a9', hedge ? 0.56 : 0.42)
        plots.add(edge)
        if (!hedge) add(b, 'furniture', { ...edge, width: 0.34 }, '#c4c0b4', 0.07, 0.475)
      }
    }
    if (publicUse && identity > 0.38) {
      const bed = shifted(frontRect, -front.width * 0.29, 1.6, Math.min(4.2, front.width * 0.19), 0.8)
      if (clear(bed)) {
        add(b, 'planting', bed, '#778b6b', 0.28)
        plots.add(bed)
      }
    }
  }

  for (const park of city.shelters) {
    if (park.kind !== 'park') continue
    const width = Math.min(park.footprint.width, 280), depth = Math.min(park.footprint.depth, 280)
    const large = width > 75 && depth > 75
    const base: ParcelRect = { x: park.position.x, z: park.position.z, width, depth, yaw: 0 }
    const pathWidth = large ? 3.2 : 2
    const halfW = width * 0.39, halfD = depth * 0.39
    const plazaSize = Math.min(22, width * 0.28, depth * 0.28)
    const plaza: ParcelRect = { ...base, width: plazaSize, depth: plazaSize }
    if (clear(plaza, false)) {
      features.push({ ...plaza, buildingId: park.id, kind: 'plaza', color: '#c8c0ae', y: 0.064, height: 0.055, shape: 'disc' })
    }
    const parkPath = (rect: ParcelRect) => {
      // A pavilion can interrupt a single path, not cancel all detail in the park.
      // Short segments preserve the parts that remain clear around the obstacle.
      const pathAxes = axes(rect), pieces = Math.max(1, Math.ceil(rect.depth / 8))
      for (let i = 0; i < pieces; i++) {
        const piece: ParcelRect = {
          ...rect,
          x: rect.x + pathAxes.vx * (rect.depth * ((i + 0.5) / pieces - 0.5)),
          z: rect.z + pathAxes.vz * (rect.depth * ((i + 0.5) / pieces - 0.5)),
          depth: rect.depth / pieces,
        }
        if (clear(piece, false)) add(park, 'park_path', piece, '#c2b9a5', 0.032, 0.05)
      }
    }
    // Continuous perimeter promenade and four spokes into the central plaza.
    for (const side of [-1, 1]) {
      parkPath(shifted(base, side * halfW, 0, pathWidth, halfD * 2 + pathWidth))
      parkPath({ ...shifted(base, 0, side * halfD, pathWidth, halfW * 2 + pathWidth), yaw: Math.PI / 2 })
      parkPath(shifted(base, 0, side * (halfD + plazaSize / 2) / 2, pathWidth, halfD - plazaSize / 2))
      parkPath({ ...shifted(base, side * (halfW + plazaSize / 2) / 2, 0, pathWidth, halfW - plazaSize / 2), yaw: Math.PI / 2 })
    }
    // Actual entrance aligned to the shelter's road connection.
    const entrance = city.roadNetwork.nodes.find(n => n.id === park.roadNodeId)?.position
    if (entrance) {
      const dx = entrance.x - base.x, dz = entrance.z - base.z
      const eastWest = Math.abs(dx / Math.max(1, halfW)) > Math.abs(dz / Math.max(1, halfD))
      const from = eastWest ? { x: base.x + Math.sign(dx) * halfW, z: base.z }
        : { x: base.x, z: base.z + Math.sign(dz) * halfD }
      const distance = Math.hypot(entrance.x - from.x, entrance.z - from.z)
      if (distance > 0.5 && distance < 120) parkPath(ribbon(from, entrance, pathWidth))
    }
    if (!large) continue

    const court = shifted(base, -width * 0.21, -depth * 0.21, 27, 16)
    if (clear(court, false)) {
      add(park, 'playground', court, '#8c9b88', 0.05, 0.06)
      for (const side of [-1, 1]) {
        add(park, 'marking', shifted(court, side * 11.9, 0, 0.12, 11), '#e1dfc8', 0.012, 0.092)
        add(park, 'marking', shifted(court, 0, side * 5.5, 23.8, 0.12), '#e1dfc8', 0.012, 0.092)
        add(park, 'marking', shifted(court, side * 6.35, 0, 0.1, 11), '#e1dfc8', 0.012, 0.092)
      }
      add(park, 'marking', shifted(court, 0, 0, 12.7, 0.1), '#e1dfc8', 0.012, 0.092)
      add(park, 'furniture', shifted(court, 0, 0, 0.06, 12), '#68736c', 0.7, 0.5)
      parkPath(ribbon({ x: court.x, z: court.z + court.depth / 2 }, { x: court.x, z: base.z }, 1.8))
    }

    const play = shifted(base, width * 0.21, depth * 0.21, 20, 17)
    if (clear(play, false)) {
      add(park, 'playground', play, '#c4b58f', 0.04, 0.06)
      // Sandpit and two differently proportioned low timber play structures.
      const sand = shifted(play, -4.7, -2.5, 6.4, 5.3)
      add(park, 'playground', sand, '#d4c79f', 0.1, 0.12)
      for (const side of [-1, 1]) {
        add(park, 'furniture', shifted(sand, side * 3.2, 0, 0.22, 5.4), '#9b876a', 0.22, 0.2)
        add(park, 'furniture', shifted(sand, 0, side * 2.65, 6.4, 0.22), '#9b876a', 0.22, 0.2)
      }
      for (const side of [-1, 1]) {
        add(park, 'furniture', shifted(play, 4 + side * 1.7, 1.8, 0.2, 0.2), '#857e65', 2.25, 1.2)
        add(park, 'furniture', shifted(play, 4 + side * 0.6, 1.8, 0.05, 0.08), '#727c76', 1.6, 1.42)
      }
      add(park, 'furniture', shifted(play, 4, 1.8, 3.9, 0.24), '#978569', 0.2, 2.36)
      add(park, 'furniture', shifted(play, 4, 1.8, 1.4, 0.48), '#807360', 0.12, 0.58)
      parkPath(ribbon({ x: play.x, z: play.z - play.depth / 2 }, { x: play.x, z: base.z }, 1.8))
    }

    // Benches are attached to promenade edges, leaving the walking strip clear.
    for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
      const seat = shifted(base, (i - 1) * halfW * 0.7, side * (halfD - 2.5), 2.6, 0.65)
      if (!clear(seat, false)) continue
      add(park, 'furniture', seat, '#8e8069', 0.12, 0.54)
      add(park, 'furniture', shifted(seat, 0, side * 0.27, 2.6, 0.12), '#8e8069', 0.46, 0.83)
      for (const end of [-1, 1]) add(park, 'furniture', shifted(seat, end * 0.92, 0, 0.12, 0.55), '#727a72', 0.45, 0.28)
    }
  }
  return features
}

/** Reuses the same primitive topology; all output merges into the street mesh. */
export function buildParcelGeometries(city: CityModel): BufferGeometry[] {
  const parts: BufferGeometry[] = []
  for (const feature of planStreetParcels(city)) {
    const geometry = (feature.shape === 'disc' ? DISC_FACES : BOX_FACES).clone()
    geometry.scale(feature.width, feature.height, feature.depth)
    geometry.rotateY(feature.yaw)
    geometry.translate(feature.x, feature.y, feature.z)
    const c = new Color(feature.color), count = geometry.getAttribute('position').count
    const colors = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) { colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b }
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    parts.push(geometry)
  }
  return parts
}
