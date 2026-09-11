/** Reproducible urban infill of the authored 90-building city. The original stays in aoba_city.json. */
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { loadCity } from '../src/simulation/CityLoader'
import { Rng } from '../src/simulation/rng'
import type { Building, RoadEdge, Vec2 } from '../src/types/city'

const raw = JSON.parse(readFileSync(new URL('../aoba_city.json', import.meta.url), 'utf8'))
const { city } = loadCity(raw)
const rng = new Rng(city.meta.simulationSeed + 841)
const originalCount = city.buildings.length
const round = (v: number) => Math.round(v * 1000) / 1000
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z)
type Rect = { x: number; z: number; w: number; d: number }
type Segment = { a: Vec2; b: Vec2; width: number; roadClass: RoadEdge['roadClass']; id: string; cuts: number[] }
const rectFor = (b: Building): Rect => ({ x: b.position.x, z: b.position.z,
  w: Math.abs(Math.cos(b.rotation)) * b.footprint.width + Math.abs(Math.sin(b.rotation)) * b.footprint.depth,
  d: Math.abs(Math.sin(b.rotation)) * b.footprint.width + Math.abs(Math.cos(b.rotation)) * b.footprint.depth })
const overlap = (a: Rect, b: Rect, gap = 0) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.z - b.z) < (a.d + b.d) / 2 + gap
const project = (p: Vec2, s: Segment) => {
  const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z
  const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.z - s.a.z) * dz) / Math.max(1, dx * dx + dz * dz)))
  return { t, p: { x: s.a.x + dx * t, z: s.a.z + dz * t } }
}
const segmentRect = (s: Segment, extra = 0): Rect => ({ x: (s.a.x + s.b.x) / 2, z: (s.a.z + s.b.z) / 2,
  w: Math.abs(s.b.x - s.a.x) + s.width + extra * 2, d: Math.abs(s.b.z - s.a.z) + s.width + extra * 2 })
function intersection(a: Segment, b: Segment): { ta: number; tb: number } | null {
  const ax = a.b.x - a.a.x, az = a.b.z - a.a.z, bx = b.b.x - b.a.x, bz = b.b.z - b.a.z
  const cross = ax * bz - az * bx
  if (Math.abs(cross) < 0.0001) return null
  const dx = b.a.x - a.a.x, dz = b.a.z - a.a.z
  const ta = (dx * bz - dz * bx) / cross, tb = (dx * az - dz * ax) / cross
  return ta >= -1e-6 && ta <= 1 + 1e-6 && tb >= -1e-6 && tb <= 1 + 1e-6 ? { ta, tb } : null
}

// Restore human-scale detached houses instead of 24–30 m wide two-person sheds.
for (const b of city.buildings) if (b.use === 'residential' && b.floors <= 3 && b.constructionType === 'wood') {
  b.footprint.width = round(Math.min(b.footprint.width, rng.range(10, 14)))
  b.footprint.depth = round(Math.min(b.footprint.depth, rng.range(11, 16)))
}
const reserved: Rect[] = city.shelters.filter(s => s.kind === 'park').map(s => ({ x: s.position.x, z: s.position.z, w: s.footprint.width, d: s.footprint.depth }))
for (const b of city.buildings.filter(b => b.use === 'school')) {
  const r = rectFor(b); reserved.push({ ...r, w: r.w + 18, d: r.d + 24 })
}
const occupied = city.buildings.map(rectFor)
const nodes = new Map(city.roadNetwork.nodes.map(n => [n.id, n.position]))
const segments: Segment[] = city.roadNetwork.edges.map(e => ({ a: nodes.get(e.from)!, b: nodes.get(e.to)!, width: e.width, roadClass: e.roadClass, id: e.id, cuts: [0, 1] }))
const originalSegments = segments.length

// Mid-block lanes join existing streets at both ends. Schools and parks retain open land.
const axes = [112.5, 237.5, 362.5, 487.5, 612.5, 737.5, 875]
for (const vertical of [true, false]) for (const axis of axes) {
  const line: Segment = { a: vertical ? { x: axis, z: 50 } : { x: 50, z: axis }, b: vertical ? { x: axis, z: 950 } : { x: 950, z: axis }, width: 5.5, roadClass: 'local', id: '', cuts: [] }
  const crossings = segments.map(s => intersection(line, s)?.ta).filter((t): t is number => t !== undefined).sort((a, b) => a - b)
  const unique = crossings.filter((t, i) => i === 0 || t - crossings[i - 1] > 0.001)
  for (let i = 1; i < unique.length; i++) {
    const point = (t: number) => ({ x: line.a.x + (line.b.x - line.a.x) * t, z: line.a.z + (line.b.z - line.a.z) * t })
    const a = point(unique[i - 1]), b = point(unique[i]), length = distance(a, b)
    if (length < 40 || length > 190) continue
    const oldTown = (a.x + b.x) / 2 < 550 && (a.z + b.z) / 2 > 550
    const candidate: Segment = { ...line, a, b, width: oldTown ? 4 : 5.5, roadClass: oldTown ? 'alley' : 'local', id: `lane_${segments.length}`, cuts: [0, 1] }
    const r = segmentRect(candidate, 1.5)
    if (occupied.some(b => overlap(r, b)) || reserved.some(b => overlap(r, b, 2))) continue
    segments.push(candidate)
  }
}

const districtAt = (p: Vec2) => raw.districts.find((d: { bounds: { minX: number; maxX: number; minZ: number; maxZ: number } }) => p.x >= d.bounds.minX && p.x < d.bounds.maxX && p.z >= d.bounds.minZ && p.z < d.bounds.maxZ)
let counter = 0
for (const s of [...segments].sort((a, b) => b.width - a.width)) for (const side of [-1, 1]) {
  const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z, len = Math.hypot(dx, dz), nx = -dz / len, nz = dx / len
  let cursor = 8
  while (cursor < len - 10) {
    const probe = { x: s.a.x + dx / len * cursor + nx * side * 18, z: s.a.z + dz / len * cursor + nz * side * 18 }
    const district = districtAt(probe)
    const type = district?.type ?? 'residential'
    const old = type === 'old_residential'
    const urban = ['commercial', 'station', 'office'].includes(type)
    const industry = type === 'factory'
    const frontage = industry ? rng.range(18, 28) : urban ? rng.range(10, 19) : rng.range(old ? 8 : 10, old ? 12 : 15)
    const depth = industry ? rng.range(22, 38) : urban ? rng.range(14, 26) : rng.range(11, 18)
    cursor += frontage / 2
    if (cursor + frontage / 2 > len - 6) break
    const setback = urban ? rng.range(1.7, 3) : rng.range(2, 4.5)
    const offset = s.width / 2 + setback + depth / 2
    const position = { x: round(s.a.x + dx / len * cursor + nx * offset * side), z: round(s.a.z + dz / len * cursor + nz * offset * side) }
    const rotation = round(-Math.atan2(dz, dx) + (side > 0 ? Math.PI : 0))
    const use: Building['use'] = industry ? (rng.chance(0.8) ? 'factory' : 'commercial') : urban ? rng.pick(['commercial', 'commercial', 'apartment', 'office']) : rng.chance(0.2) ? 'apartment' : 'residential'
    const floors = industry ? rng.int(1, 2) : use === 'residential' ? (rng.chance(0.12) ? 3 : 2) : use === 'apartment' ? rng.int(3, 5) : rng.int(2, 5)
    const wood = use === 'residential'
    const building: Building = {
      id: `infill_${String(++counter).padStart(4, '0')}`, name: `${district?.name ?? 'Aoba'} ${wood ? 'House' : use === 'apartment' ? 'Residence' : 'Block'} ${counter}`,
      position, rotation, footprint: { width: round(frontage), depth: round(depth) }, floors,
      height: round(floors * (industry ? 4.8 : wood ? 3.1 : 3.4)), use,
      constructionType: wood ? 'wood' : industry ? 'steel' : 'rc', yearBuilt: old ? rng.int(1955, 1984) : rng.int(1987, 2023),
      seismicResistance: round(old ? rng.range(0.2, 0.5) : rng.range(0.58, 0.92)),
      fireResistance: round(wood ? old ? rng.range(0.15, 0.4) : rng.range(0.35, 0.65) : rng.range(0.68, 0.92)),
      collapseThreshold: round(old ? rng.range(0.55, 0.75) : rng.range(0.78, 0.94)),
      roofType: wood ? rng.pick(['gable', 'hip', 'mono']) : industry ? 'sawtooth' : 'flat',
      replacementValue: Math.round(frontage * depth * floors * (wood ? 190000 : 310000)), occupancy: wood ? 2 : floors * 2,
      populationProfile: wood ? { child: 0.16, adult: 0.57, elderly: 0.23, mobilityImpaired: 0.04 } : { child: 0.06, adult: 0.76, elderly: 0.14, mobilityImpaired: 0.04 },
      fireIgnitionProbability: null, evacuationDelaySeconds: old ? 24 : 18, yearRetrofitted: null,
      groundZoneId: null, districtId: district?.id ?? null, nearestRoadNodeId: null,
    }
    const rect = rectFor(building)
    const inBounds = position.x - rect.w / 2 >= 6 && position.x + rect.w / 2 <= 994 && position.z - rect.d / 2 >= 6 && position.z + rect.d / 2 <= 994
    const roadCollision = segments.some(e => overlap(rect, segmentRect(e, 1.35)))
    if (inBounds && !roadCollision && !occupied.some(r => overlap(rect, r, 1.4)) && !reserved.some(r => overlap(rect, r, 2))) {
      city.buildings.push(building); occupied.push(rect)
    }
    cursor += frontage / 2 + rng.range(1.8, 3.5)
  }
}

// Actual graph intersections and dedicated access anchors prevent diagonal routes through neighbouring houses.
for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
  const hit = intersection(segments[i], segments[j])
  if (hit) { segments[i].cuts.push(hit.ta); segments[j].cuts.push(hit.tb) }
}
const nodeByPosition = new Map(city.roadNetwork.nodes.map(n => [`${round(n.position.x)},${round(n.position.z)}`, n.id]))
function nodeAt(p: Vec2): string {
  const position = { x: round(p.x), z: round(p.z) }, key = `${position.x},${position.z}`
  let id = nodeByPosition.get(key)
  if (!id) { id = `access_${city.roadNetwork.nodes.length}`; city.roadNetwork.nodes.push({ id, position, kind: 'waypoint' }); nodeByPosition.set(key, id) }
  return id
}
for (const b of city.buildings) {
  let nearest: { s: Segment; t: number; p: Vec2; d: number } | null = null
  for (const s of segments) {
    const hit = project(b.position, s), d = distance(b.position, hit.p)
    if (!nearest || d < nearest.d) nearest = { s, ...hit, d }
  }
  assert.ok(nearest)
  nearest.s.cuts.push(nearest.t)
  b.nearestRoadNodeId = nodeAt(nearest.p)
}
const edges: RoadEdge[] = []
for (const s of segments) {
  const cuts = s.cuts.sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.0001)
  for (let i = 1; i < cuts.length; i++) {
    const point = (t: number) => ({ x: s.a.x + (s.b.x - s.a.x) * t, z: s.a.z + (s.b.z - s.a.z) * t })
    const a = point(cuts[i - 1]), b = point(cuts[i]), length = distance(a, b)
    if (length < 0.1) continue
    edges.push({ id: `${s.id}_${i}`, from: nodeAt(a), to: nodeAt(b), width: s.width, roadClass: s.roadClass, lanes: s.width >= 7 ? 2 : 1, length: round(length) })
  }
}
city.roadNetwork.edges = edges
const degree = new Map<string, number>()
for (const e of edges) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1) }
for (const n of city.roadNetwork.nodes) n.kind = (degree.get(n.id) ?? 0) > 2 ? 'intersection' : (degree.get(n.id) ?? 0) === 1 ? 'endpoint' : 'waypoint'

// Keep the same 3,000-person experiment, spread over the refined city at the same weekday snapshot.
function apportion(buildings: Building[], total: number) {
  const sum = buildings.reduce((s, b) => s + b.occupancy, 0)
  const quotas = buildings.map(b => ({ b, value: b.occupancy * total / sum }))
  quotas.forEach(q => { q.b.occupancy = Math.floor(q.value) })
  let remainder = total - buildings.reduce((s, b) => s + b.occupancy, 0)
  for (const q of quotas.sort((a, b) => (b.value % 1) - (a.value % 1))) if (remainder-- > 0) q.b.occupancy++
}
apportion(city.buildings.slice(0, originalCount), 2000)
apportion(city.buildings.slice(originalCount), 1000)
city.meta.version = '2.0.0'
city.meta.generatedBy = 'scripts/refine-city.ts from authored aoba_city.json'
assert.equal(city.buildings.reduce((s, b) => s + b.occupancy, 0), 3000)
assert.ok(city.buildings.length > 300)
for (let i = originalCount; i < occupied.length; i++) for (let j = 0; j < i; j++) assert.ok(!overlap(occupied[i], occupied[j], 1), 'infill footprints overlap')
const area = city.buildings.reduce((s, b) => s + b.footprint.width * b.footprint.depth, 0)
const output = JSON.stringify(city, null, 2) + '\n'
loadCity(JSON.parse(output))
writeFileSync(new URL('../src/data/aoba-city.json', import.meta.url), output)
console.log(`${originalCount} → ${city.buildings.length} buildings; ${originalSegments} streets + ${segments.length - originalSegments} lanes; ${city.roadNetwork.nodes.length} connected access/junction nodes; ${edges.length} road segments; building coverage ${(area / 10000).toFixed(1)}%; 3000 people.`)
