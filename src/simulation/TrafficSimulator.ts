import type { CityModel, Vec2 } from '../types/city'
import type { RoadRuntime } from '../types/simulation'
import { Rng, hashString } from './rng'

export interface Vehicle {
  id: number; kind: number; edge: number; reverse: boolean; distance: number
  x: number; z: number; px: number; pz: number; heading: number; previousHeading: number; speed: number
  length: number; stopped: boolean; reroutes: number; desiredSpeed: number
}
interface TrafficEnvironment {
  roads: RoadRuntime[]; emergency: boolean; earthquake: boolean; disasterTime: number
  waterDepthAt(x: number, z: number): number
}
/** Fixed-step traffic on the same road graph as evacuation, with left-hand lanes. */
export class TrafficSimulator {
  readonly vehicles: Vehicle[] = []
  private readonly city: CityModel
  private readonly seed: number
  private rng: Rng
  private time = 0
  private remainder = 0
  private nodes: Map<string, Vec2>
  private adjacency = new Map<string, number[]>()
  private reservations = new Map<string, number>()
  get alpha(): number { return this.remainder / 0.1 }
  constructor(city: CityModel, seed: number) {
    this.city = city; this.seed = seed; this.rng = new Rng(seed + 377)
    this.nodes = new Map(city.roadNetwork.nodes.map(n => [n.id, n.position]))
    city.roadNetwork.edges.forEach((e, i) => {
      if (e.width < 5) return
      for (const id of [e.from, e.to]) { const a = this.adjacency.get(id) ?? []; a.push(i); this.adjacency.set(id, a) }
    })
    this.reset()
  }
  reset(): void {
    this.rng = new Rng(this.seed + 377); this.time = 0; this.remainder = 0; this.vehicles.length = 0; this.reservations.clear()
    const eligible = this.city.roadNetwork.edges.map((e, i) => e.width >= 6 && e.length > 35 ? i : -1).filter(i => i >= 0)
    this.rng.shuffle(eligible)
    for (const edge of eligible.slice(0, 86)) {
      const source = this.city.roadNetwork.edges[edge]
      const kind = source.width >= 12 ? this.rng.int(0, 4) : this.rng.int(0, 2)
      const vehicle: Vehicle = {
        id: this.vehicles.length, kind, edge, reverse: this.rng.chance(0.5), distance: this.rng.range(8, source.length - 15),
        x: 0, z: 0, px: 0, pz: 0, heading: 0, previousHeading: 0, speed: 0, length: [3.5, 4.6, 4.9, 6.5, 10.5][kind], stopped: false, reroutes: 0, desiredSpeed: this.rng.range(6.5, 11.5),
      }
      this.position(vehicle); vehicle.px = vehicle.x; vehicle.pz = vehicle.z; vehicle.previousHeading = vehicle.heading; this.vehicles.push(vehicle)
    }
  }
  advance(dt: number, env: TrafficEnvironment): void {
    this.remainder += Math.min(4, Math.max(0, Number.isFinite(dt) ? dt : 0))
    while (this.remainder >= 0.1) { this.step(0.1, env); this.remainder -= 0.1 }
  }
  private step(dt: number, env: TrafficEnvironment): void {
    this.time += dt
    // Snapshot gaps first: outcomes don't depend on which vehicle moves first.
    const available = this.vehicles.map(v => {
      let gap = Infinity
      for (const other of this.vehicles) if (other.edge === v.edge && other.reverse === v.reverse && other.distance > v.distance)
        gap = Math.min(gap, other.distance - v.distance - (other.length + v.length) / 2 - 2.5)
      return Math.max(0, gap)
    })
    for (const v of this.vehicles) {
      v.px = v.x; v.pz = v.z; v.previousHeading = v.heading
      const edge = this.city.roadNetwork.edges[v.edge], road = env.roads[v.edge]
      const end = v.reverse ? edge.from : edge.to
      const a = this.nodes.get(edge.from)!, b = this.nodes.get(edge.to)!
      const junction = (this.adjacency.get(end)?.length ?? 0) > 2
      const horizontal = Math.abs(b.x - a.x) > Math.abs(b.z - a.z)
      const green = Math.floor((this.time + hashString(end) % 30) / 18) % 2 === (horizontal ? 0 : 1)
      const left = edge.length - v.distance
      const hazardStop = road.blocked || env.waterDepthAt(v.x, v.z) > 0.3 || (env.emergency && env.earthquake && env.disasterTime < 40)
      let desired = hazardStop ? 0 : v.desiredSpeed * (env.emergency ? 0.48 : 1)
      if (left < 24) desired = Math.min(desired, 4)
      if (junction && (!green || (this.reservations.get(end) ?? 0) > this.time)) desired = Math.min(desired, Math.max(0, left - 10))
      desired = Math.min(desired, available[v.id] * 0.8)
      v.speed += Math.max(-dt * 9, Math.min(dt * 2, desired - v.speed))
      // Hazard fronts stop vehicles before they can move further into unsafe edges.
      if (hazardStop) v.speed = 0
      v.stopped = v.speed < 0.2
      v.distance += Math.min(available[v.id], v.speed * dt)
      if (v.distance >= edge.length - 0.1) {
        const choices = (this.adjacency.get(end) ?? []).filter(i => i !== v.edge)
        const preferred = choices.length ? choices[this.rng.int(0, choices.length - 1)] : v.edge
        const safe = choices.filter(i => !env.roads[i].blocked && env.roads[i].waterDepth < 0.3)
        const next = safe.includes(preferred) ? preferred : safe[0]
        if (next === undefined) {
          v.distance = edge.length - 0.1; v.speed = 0; v.stopped = true
          // Dead-end streets allow a turn back, but no vehicle crosses a blocked edge.
          if (!choices.length && !road.blocked) { v.reverse = !v.reverse; v.distance = 0 }
        } else {
          if (next !== preferred) v.reroutes++
          const nextEdge = this.city.roadNetwork.edges[next]
          const reverse = nextEdge.to === end
          const occupied = this.vehicles.some(o => o !== v && o.edge === next && o.reverse === reverse && o.distance < o.length + 5)
          if (occupied) { v.distance = edge.length - 0.1; v.speed = 0; v.stopped = true }
          else {
            this.reservations.set(end, this.time + 1.2)
            v.edge = next; v.reverse = reverse; v.distance = 0
          }
        }
      }
      this.position(v)
    }
  }
  private position(v: Vehicle): void {
    const edge = this.city.roadNetwork.edges[v.edge]
    const a = this.nodes.get(v.reverse ? edge.to : edge.from)!, b = this.nodes.get(v.reverse ? edge.from : edge.to)!
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.max(1, edge.length)
    const ratio = Math.min(1, Math.max(0, v.distance / len))
    const lane = edge.width * 0.23 * Math.min(1, v.distance / 8, (len - v.distance) / 8)
    v.x = a.x + dx * ratio + dz / len * lane
    v.z = a.z + dz * ratio - dx / len * lane
    v.heading = Math.atan2(dx, dz)
  }
}
