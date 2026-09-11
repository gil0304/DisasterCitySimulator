import type { CityModel, DisasterScenario } from '../types/city'
import type { BuildingRuntime, DisasterSimulator, RoadRuntime, ShelterRuntime } from '../types/simulation'
import { clamp01, damageStateFor, economicLossFor } from './DamageCalculator'
import { streamFor } from './rng'

export type DisasterType = DisasterScenario['type']
export const DISASTER_LABELS: Record<DisasterType, string> = {
  earthquake: '地震', flood: '洪水', tsunami: '津波', fire: '市街地火災', typhoon: '台風',
}

interface Options {
  type: Exclude<DisasterType, 'earthquake'>
  city: CityModel
  buildings: BuildingRuntime[]
  roads: RoadRuntime[]
  shelters: ShelterRuntime[]
  seed: number
  onCollapse: (building: BuildingRuntime, now: number) => void
}

interface SpreadNeighbor {
  building: BuildingRuntime
  chance: number
}

interface RoadHeatSource {
  building: BuildingRuntime
  heat: number
}

interface ShelterNeighbors {
  burning: BuildingRuntime[]
  ruined: BuildingRuntime[]
}

/** Educational surface-flow, wind and fire models. No rendering dependencies. */
export class EnvironmentalDisaster implements DisasterSimulator {
  readonly type: Exclude<DisasterType, 'earthquake'>
  private readonly options: Options
  private readonly variation: number[]
  private readonly burnExtent: number[]
  private time = 0
  private nextSpread = 12
  private readonly nodePositions: Map<string, { x: number; z: number }>
  /** Static geometry is sampled once. Runtime flags remain live references. */
  private readonly spreadNeighbors: SpreadNeighbor[][]
  private readonly roadHeatSources: RoadHeatSource[][]
  private readonly shelterNeighbors: ShelterNeighbors[]
  constructor(options: Options) {
    this.options = options
    this.type = options.type
    this.variation = options.buildings.map(b => streamFor(options.seed, `${options.type}:${b.id}`).range(0.65, 1.35))
    // Only part of a building's fuel/compartments may be involved before burnout.
    this.burnExtent = options.buildings.map(b => streamFor(options.seed, `compartments:${b.id}`).range(0.35, 1))
    this.nodePositions = new Map(options.city.roadNetwork.nodes.map(n => [n.id, n.position]))
    this.spreadNeighbors = options.buildings.map(() => [])
    this.roadHeatSources = options.roads.map(() => [])
    if (this.type === 'fire') {
      for (const source of options.buildings) {
        const a = source.source
        const neighbors = this.spreadNeighbors[source.index]
        // Preserve source-array order: an ignition earlier in the spread pass
        // must still exclude that target from all subsequent sources.
        for (const target of options.buildings) {
          if (target === source) continue
          const b = target.source
          const gap = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)
            - Math.hypot(a.footprint.width, a.footprint.depth) / 2 - Math.hypot(b.footprint.width, b.footprint.depth) / 2
          if (gap > 28) continue
          neighbors.push({ building: target, chance: (1 - b.fireResistance) * clamp01(1 - gap / 32) * 0.32 })
        }
      }
      for (const road of options.roads) {
        const sources = this.roadHeatSources[road.index]
        for (const building of options.buildings) {
          const gap = this.distanceToRoad(building, road) - Math.max(building.source.footprint.width, building.source.footprint.depth) / 2
          if (gap < 16) sources.push({ building, heat: clamp01(1 - gap / 20) })
        }
      }
    }
    this.shelterNeighbors = options.shelters.map(shelter => {
      const p = shelter.source.position
      const neighbors: ShelterNeighbors = { burning: [], ruined: [] }
      for (const building of options.buildings) {
        const distance = Math.hypot(p.x - building.source.position.x, p.z - building.source.position.z)
        if (distance < 30) neighbors.burning.push(building)
        if (distance < 6) neighbors.ruined.push(building)
      }
      return neighbors
    })
  }
  get progress(): number { return clamp01(this.time / this.duration) }
  get duration(): number { return this.type === 'fire' ? 1100 : this.type === 'typhoon' ? 720 : 960 }
  get windStrength(): number {
    if (this.type === 'fire') return this.isFinished() ? 0 : 0.2
    if (this.type !== 'typhoon') return 0
    return Math.sin(Math.PI * clamp01(this.time / this.duration)) ** 0.6
  }
  get windDirection(): number { return -Math.PI * 0.65 }
  start(): void {
    if (this.type === 'fire') {
      const candidates = [...this.options.buildings].sort((a, b) =>
        a.source.fireResistance - b.source.fireResistance || a.index - b.index)
      for (const b of candidates.slice(0, 3)) { b.onFire = true; b.fireStartTime = 0 }
    }
  }
  waterDepthAt(x: number, z: number): number {
    if (this.type !== 'flood' && this.type !== 'tsunami') return 0
    if (this.time <= 0) return 0
    const b = this.options.city.meta.bounds
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return 0
    const height = Math.max(1, b.maxZ - b.minZ)
    const northing = (z - b.minZ) / height
    const peak = this.type === 'tsunami' ? 210 : 360
    const advance = clamp01(this.time / peak)
    const front = 1 - advance * (this.type === 'tsunami' ? 0.88 : 0.60)
    const wet = clamp01((northing - front) * 15)
    const retreat = this.time < peak + 180 ? 1 : Math.max(0, 1 - (this.time - peak - 180) / (this.duration - peak - 180))
    const drainage = 0.85 + 0.15 * Math.sin(x * 0.007 + z * 0.003)
    return wet * retreat * (this.type === 'tsunami' ? 7.5 : 3.8) * (0.35 + 0.65 * northing) * drainage
  }
  update(dt: number, now: number): void {
    this.time = now
    const { buildings, roads, shelters } = this.options
    for (const b of buildings) {
      const src = b.source
      b.waterDepth = this.waterDepthAt(src.position.x, src.position.z)
      if (b.collapseStartTime !== null) b.collapseProgress = clamp01((now - b.collapseStartTime) / 3)
      const timber = src.constructionType === 'wood' || src.constructionType === 'prefab'
      let target = b.damageScore
      if (this.type === 'flood' || this.type === 'tsunami') {
        const depth = b.waterDepth
        const structural = depth / Math.max(3, Math.min(src.height, 12)) * (timber ? 0.85 : 0.25)
        const impact = this.type === 'tsunami' ? depth * (timber ? 0.05 : 0.02) : 0
        target = Math.max(target, (structural + impact) * this.variation[b.index])
        b.hazardIntensity = depth / 7.5
      } else if (this.type === 'typhoon') {
        const vulnerability = (1 - src.seismicResistance) * (timber ? 0.95 : 0.52)
        target = Math.max(target, this.windStrength ** 2 * vulnerability * this.variation[b.index])
        b.shakeIntensity = this.windStrength * Math.min(0.22, src.height / 400)
        b.hazardIntensity = this.windStrength
      }
      if (b.onFire && b.fireStartTime !== null) {
        b.burnProgress = clamp01((now - b.fireStartTime) / (timber ? 210 : 360))
        target = Math.max(target, b.burnProgress * (1 - src.fireResistance * 0.8) * this.variation[b.index] * this.burnExtent[b.index])
        b.hazardIntensity = Math.max(b.hazardIntensity, b.burnProgress)
        if (b.burnProgress >= 1) b.onFire = false
      }
      this.applyDamage(b, Math.min(target, b.damageScore + dt * 0.022), now)
    }
    if (this.type === 'fire' && now >= this.nextSpread && now < 700) {
      const interval = Math.floor(now / 12)
      this.nextSpread += 12
      const burning = buildings.filter(b => b.onFire && b.burnProgress > 0.08)
      for (const source of burning) for (const neighbor of this.spreadNeighbors[source.index]) {
        const target = neighbor.building
        if (target.onFire || target.burnProgress > 0) continue
        if (streamFor(this.options.seed, `spread:${interval}:${source.id}:${target.id}`).chance(neighbor.chance)) {
          target.onFire = true; target.fireStartTime = now
        }
      }
    }
    for (const road of roads) {
      const a = this.nodePositions.get(road.source.from)!, b = this.nodePositions.get(road.source.to)!
      road.waterDepth = Math.max(this.waterDepthAt(a.x, a.z), this.waterDepthAt(b.x, b.z), this.waterDepthAt((a.x + b.x) / 2, (a.z + b.z) / 2))
      let heat = 0
      if (this.type === 'fire') for (const source of this.roadHeatSources[road.index]) {
        if (source.building.onFire) heat = Math.max(heat, source.heat)
      }
      road.hazardLevel = Math.max(clamp01(road.waterDepth), heat)
      road.hazardBlocked = road.waterDepth > 0.55 || heat > 0.55
      const blocked = road.debrisLevel >= 0.48 || road.hazardBlocked
      if (blocked && !road.blocked) road.blockedAt = now
      road.blocked = blocked
    }
    for (const shelter of shelters) {
      const p = shelter.source.position
      const neighbors = this.shelterNeighbors[shelter.index]
      const burning = neighbors.burning.some(b => b.onFire)
      const ruined = neighbors.ruined.some(b => b.state === 'collapsed')
      shelter.unsafe = this.waterDepthAt(p.x, p.z) > 0.35 || burning || ruined
    }
  }
  private distanceToRoad(b: BuildingRuntime, road: RoadRuntime): number {
    const a = this.nodePositions.get(road.source.from)!, c = this.nodePositions.get(road.source.to)!
    const dx = c.x - a.x, dz = c.z - a.z
    const p = b.source.position
    const t = clamp01(((p.x - a.x) * dx + (p.z - a.z) * dz) / Math.max(1, dx * dx + dz * dz))
    return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz)
  }
  private applyDamage(b: BuildingRuntime, target: number, now: number): void {
    if (b.state === 'collapsed') return
    b.damageScore = clamp01(Math.max(b.damageScore, target))
    b.state = damageStateFor(b.damageScore, b.source.collapseThreshold)
    b.economicLoss = economicLossFor(b.source, b.state)
    if (b.state === 'collapsed') {
      b.collapseStartTime = now
      for (const road of this.options.roads) {
        const reach = Math.max(b.source.footprint.width, b.source.footprint.depth) / 2 + Math.min(25, b.source.height * 0.6)
        if (this.distanceToRoad(b, road) < reach) road.debrisLevel = Math.max(road.debrisLevel, road.source.width < 7 ? 0.9 : 0.35)
      }
      this.options.onCollapse(b, now)
    }
  }
  isFinished(): boolean { return this.time >= this.duration }
}
