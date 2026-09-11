/**
 * §59, §60 — the ground plane, its district / soil tinting, and the procedural
 * street furniture (trees and lamps) that gives the model city its scale.
 *
 * The geometry is built once per engine and the instance matrices are written
 * once on mount; nothing here is rebuilt per frame. The only animation is the
 * §30 tremble: during the shock the tree and lamp groups are offset by a few
 * centimetres so the street furniture visibly shakes with the ground, while the
 * buildings — which shake individually — remain the thing that really moves.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { ReactElement } from 'react'
import {
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
  Vector2,
} from 'three'
import type { BufferGeometry, Group, InstancedMesh, Material } from 'three'
import { Rng, mixSeed } from '../simulation/rng'
import type { CityModel, DistrictKind, GroundType, Vec2 } from '../types/city'
import { useSimulationStore } from '../store/simulationStore'
import { GROUND_COLOR } from './palette'

/** §30 — peak sway of street furniture during the strongest shaking, metres. */
const FURNITURE_SHAKE_AMPLITUDE = 0.16
const FURNITURE_SHAKE_RATE = 11.5

/** Extra ground beyond the city bounds, metres. */
const GROUND_MARGIN = 400

const DISTRICT_Y = 0.01
const ZONE_Y = 0.02

const TREE_LIMIT = 900
const LAMP_LIMIT = 250
const TREE_SPACING = 18
const LAMP_SPACING = 34

/** Muted ward tints — enough to tell districts apart, never a data map. */
const DISTRICT_TINT: Record<DistrictKind, string> = {
  residential: '#93a081',
  commercial: '#a09479',
  business: '#8492a0',
  industrial: '#918d83',
  mixed: '#96968a',
  waterfront: '#6d8b9c',
  civic: '#8d9787',
}

const DISTRICT_OPACITY: Record<DistrictKind, number> = {
  residential: 0.12,
  commercial: 0.12,
  business: 0.12,
  industrial: 0.12,
  mixed: 0.1,
  // §60 — the only "water" we allow ourselves: a cooler, slightly stronger
  // wash over waterfront wards. No river is ever inferred from zone names.
  waterfront: 0.2,
  civic: 0.12,
}

/** Only weak ground is worth showing, and only just. */
const ZONE_OPACITY: Partial<Record<GroundType, number>> = {
  soft: 0.07,
  reclaimed: 0.1,
}

const ZONE_TINT = '#6f8492'

interface Bounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

function safeBounds(city: CityModel): Bounds {
  const b = city.meta.bounds
  const minX = Number.isFinite(b.minX) ? b.minX : 0
  const maxX = Number.isFinite(b.maxX) ? b.maxX : minX + 500
  const minZ = Number.isFinite(b.minZ) ? b.minZ : 0
  const maxZ = Number.isFinite(b.maxZ) ? b.maxZ : minZ + 500
  return {
    minX,
    maxX: maxX > minX ? maxX : minX + 500,
    minZ,
    maxZ: maxZ > minZ ? maxZ : minZ + 500,
  }
}

interface TintLayer {
  geometry: BufferGeometry
  material: MeshBasicMaterial
  /** World position; the geometry itself is built around the origin. */
  x: number
  y: number
  z: number
  key: string
}

/**
 * Builds the district discs and soil-zone patches.
 *
 * Both sit within centimetres of the ground plane, so every overlay gets a
 * negative polygon offset and `depthWrite: false`; the paint order alone would
 * z-fight at a 600 m camera distance.
 */
function buildTints(city: CityModel): TintLayer[] {
  const layers: TintLayer[] = []

  city.districts.forEach((district, index) => {
    const radius = Number.isFinite(district.radius) && district.radius > 1 ? district.radius : 150
    const x = Number.isFinite(district.center.x) ? district.center.x : 0
    const z = Number.isFinite(district.center.z) ? district.center.z : 0
    const geometry = new CircleGeometry(radius, 48)
    geometry.rotateX(-Math.PI / 2)
    const material = new MeshBasicMaterial({
      color: new Color(DISTRICT_TINT[district.kind] ?? DISTRICT_TINT.mixed),
      transparent: true,
      opacity: DISTRICT_OPACITY[district.kind] ?? 0.12,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })
    layers.push({
      geometry,
      material,
      x,
      // A hair of separation per district keeps overlapping wards stable.
      y: DISTRICT_Y + index * 0.0005,
      z,
      key: `district-${district.id}`,
    })
  })

  city.groundZones.forEach((zone, index) => {
    const opacity = ZONE_OPACITY[zone.groundType]
    if (opacity === undefined) return
    const polygon = zone.polygon
    if (!Array.isArray(polygon) || polygon.length < 3) return

    const points: Vector2[] = []
    for (const p of polygon) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue
      // ShapeGeometry lives in XY; rotating -90° about X maps (x, y) → (x, -y)
      // in world XZ, so negate z going in.
      points.push(new Vector2(p.x, -p.z))
    }
    if (points.length < 3) return

    const geometry = new ShapeGeometry(new Shape(points))
    geometry.rotateX(-Math.PI / 2)
    const material = new MeshBasicMaterial({
      color: new Color(ZONE_TINT),
      transparent: true,
      opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    layers.push({
      geometry,
      material,
      x: 0,
      y: ZONE_Y + index * 0.0005,
      z: 0,
      key: `zone-${zone.id}`,
    })
  })

  return layers
}

/** Uniform grid over building footprints, so tree placement is not O(n·m). */
function buildBuildingGrid(city: CityModel): {
  cell: number
  buckets: Map<number, number[]>
  cx: Float32Array
  cz: Float32Array
  radius: Float32Array
} {
  const cell = 48
  const buckets = new Map<number, number[]>()
  const count = city.buildings.length
  const cx = new Float32Array(count)
  const cz = new Float32Array(count)
  const radius = new Float32Array(count)

  const key = (ix: number, iz: number): number => (ix + 32768) * 65536 + (iz + 32768)

  for (let i = 0; i < count; i++) {
    const b = city.buildings[i]
    if (!b) continue
    const x = Number.isFinite(b.position.x) ? b.position.x : 0
    const z = Number.isFinite(b.position.z) ? b.position.z : 0
    const w = Number.isFinite(b.footprint.width) ? Math.abs(b.footprint.width) : 10
    const d = Number.isFinite(b.footprint.depth) ? Math.abs(b.footprint.depth) : 10
    const r = Math.hypot(w, d) * 0.5 + 2.5
    cx[i] = x
    cz[i] = z
    radius[i] = r

    const ix0 = Math.floor((x - r) / cell)
    const ix1 = Math.floor((x + r) / cell)
    const iz0 = Math.floor((z - r) / cell)
    const iz1 = Math.floor((z + r) / cell)
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const k = key(ix, iz)
        const bucket = buckets.get(k)
        if (bucket) bucket.push(i)
        else buckets.set(k, [i])
      }
    }
  }

  return { cell, buckets, cx, cz, radius }
}

interface DetailData {
  trunk: Float32Array
  canopy: Float32Array
  treeCount: number
  pole: Float32Array
  head: Float32Array
  lampCount: number
}

const EMPTY_DETAIL: DetailData = {
  trunk: new Float32Array(0),
  canopy: new Float32Array(0),
  treeCount: 0,
  pole: new Float32Array(0),
  head: new Float32Array(0),
  lampCount: 0,
}

/**
 * Candidate street-furniture positions along the road network.
 *
 * Candidates are collected for the whole city first and then thinned with a
 * stride, so the cap spreads the trees evenly instead of filling the first
 * few streets and leaving the rest bare.
 */
function collectAlongRoads(
  city: CityModel,
  classes: readonly string[],
  spacing: number,
  offsetPad: number,
  bothSides: boolean,
  reject: (x: number, z: number) => boolean,
): { x: number[]; z: number[]; nx: number[]; nz: number[] } {
  const nodePos = new Map<string, Vec2>()
  for (const node of city.roadNetwork.nodes) nodePos.set(node.id, node.position)

  const x: number[] = []
  const z: number[] = []
  const nx: number[] = []
  const nz: number[] = []

  let slot = 0
  for (const edge of city.roadNetwork.edges) {
    if (!classes.includes(edge.roadClass)) continue
    const a = nodePos.get(edge.from)
    const b = nodePos.get(edge.to)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dz = b.z - a.z
    const length = Math.hypot(dx, dz)
    if (!(length > 1e-3)) continue

    const ux = dx / length
    const uz = dz / length
    const px = -uz
    const pz = ux

    const margin = 9
    const usable = length - margin * 2
    if (usable < spacing * 0.4) continue
    const steps = Math.max(1, Math.floor(usable / spacing))
    const start = margin + (usable - (steps - 1) * spacing) * 0.5
    const offset = Math.max(1, edge.width) * 0.5 + offsetPad

    for (let k = 0; k < steps; k++) {
      const along = start + k * spacing
      const bx = a.x + ux * along
      const bz = a.z + uz * along
      const sides = bothSides ? [-1, 1] : [slot % 2 === 0 ? 1 : -1]
      for (const side of sides) {
        const wx = bx + px * offset * side
        const wz = bz + pz * offset * side
        slot++
        if (reject(wx, wz)) continue
        x.push(wx)
        z.push(wz)
        // Normal pointing back toward the carriageway.
        nx.push(-px * side)
        nz.push(-pz * side)
      }
    }
  }

  return { x, z, nx, nz }
}

function strideIndices(total: number, cap: number): number[] {
  const out: number[] = []
  if (total <= 0) return out
  if (total <= cap) {
    for (let i = 0; i < total; i++) out.push(i)
    return out
  }
  const step = total / cap
  for (let i = 0; i < cap; i++) {
    const index = Math.min(total - 1, Math.floor(i * step))
    out.push(index)
  }
  return out
}

function buildDetail(city: CityModel): DetailData {
  const grid = buildBuildingGrid(city)
  const gridKey = (ix: number, iz: number): number => (ix + 32768) * 65536 + (iz + 32768)

  const nearBuilding = (x: number, z: number): boolean => {
    const bucket = grid.buckets.get(gridKey(Math.floor(x / grid.cell), Math.floor(z / grid.cell)))
    if (!bucket) return false
    for (const i of bucket) {
      const dx = x - grid.cx[i]
      const dz = z - grid.cz[i]
      const r = grid.radius[i]
      if (dx * dx + dz * dz < r * r) return true
    }
    return false
  }

  const trees = collectAlongRoads(
    city,
    ['collector', 'local'],
    TREE_SPACING,
    2.2,
    true,
    nearBuilding,
  )
  // Lamps belong on arterials, but some cities normalise their trunk roads to
  // `collector`; without a fallback those cities would get no lamps at all.
  let lamps = collectAlongRoads(city, ['arterial'], LAMP_SPACING, 1.6, false, nearBuilding)
  if (lamps.x.length === 0) {
    lamps = collectAlongRoads(city, ['collector'], LAMP_SPACING, 1.6, false, nearBuilding)
  }

  const treePick = strideIndices(trees.x.length, TREE_LIMIT)
  const lampPick = strideIndices(lamps.x.length, LAMP_LIMIT)

  const dummy = new Object3D()
  const trunk = new Float32Array(treePick.length * 16)
  const canopy = new Float32Array(treePick.length * 16)

  for (let i = 0; i < treePick.length; i++) {
    const source = treePick[i]
    // Deterministic per-candidate variation — never Math.random.
    const rng = new Rng(mixSeed(source + 1, 0x7f4a7c15))
    const trunkHeight = rng.range(2.4, 3.4)
    const canopyRadius = rng.range(1.7, 2.6)
    const lean = rng.range(-0.05, 0.05)
    const x = trees.x[source]
    const z = trees.z[source]

    dummy.position.set(x, trunkHeight * 0.5, z)
    dummy.rotation.set(lean, rng.range(0, Math.PI * 2), lean * 0.6)
    dummy.scale.set(1, trunkHeight, 1)
    dummy.updateMatrix()
    dummy.matrix.toArray(trunk, i * 16)

    dummy.position.set(x, trunkHeight + canopyRadius * 0.62, z)
    dummy.rotation.set(rng.range(-0.25, 0.25), rng.range(0, Math.PI * 2), rng.range(-0.25, 0.25))
    dummy.scale.set(canopyRadius, canopyRadius * rng.range(0.85, 1.2), canopyRadius)
    dummy.updateMatrix()
    dummy.matrix.toArray(canopy, i * 16)
  }

  const pole = new Float32Array(lampPick.length * 16)
  const head = new Float32Array(lampPick.length * 16)
  const poleHeight = 7.4

  for (let i = 0; i < lampPick.length; i++) {
    const source = lampPick[i]
    const x = lamps.x[source]
    const z = lamps.z[source]
    const inwardX = lamps.nx[source]
    const inwardZ = lamps.nz[source]
    // Rotation that puts the head's local +X along the inward normal.
    const yaw = Math.atan2(-inwardZ, inwardX)

    dummy.position.set(x, poleHeight * 0.5, z)
    dummy.rotation.set(0, 0, 0)
    dummy.scale.set(1, poleHeight, 1)
    dummy.updateMatrix()
    dummy.matrix.toArray(pole, i * 16)

    dummy.position.set(x + inwardX * 0.75, poleHeight - 0.25, z + inwardZ * 0.75)
    dummy.rotation.set(0, yaw, 0)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    dummy.matrix.toArray(head, i * 16)
  }

  return {
    trunk,
    canopy,
    treeCount: treePick.length,
    pole,
    head,
    lampCount: lampPick.length,
  }
}

function applyMatrices(mesh: InstancedMesh | null, source: Float32Array, count: number): void {
  if (!mesh || count <= 0) return
  const matrix = new Matrix4()
  for (let i = 0; i < count; i++) {
    matrix.fromArray(source, i * 16)
    mesh.setMatrixAt(i, matrix)
  }
  mesh.instanceMatrix.needsUpdate = true
  mesh.computeBoundingSphere()
}

export function Ground(): ReactElement | null {
  const engine = useSimulationStore((s) => s.engine)

  const plane = useMemo(() => {
    if (!engine) return null
    const bounds = safeBounds(engine.city)
    const width = bounds.maxX - bounds.minX + GROUND_MARGIN * 2
    const depth = bounds.maxZ - bounds.minZ + GROUND_MARGIN * 2
    const geometry = new PlaneGeometry(width, depth, 1, 1)
    geometry.rotateX(-Math.PI / 2)
    const material = new MeshLambertMaterial({ color: new Color(GROUND_COLOR) })
    return {
      geometry,
      material,
      x: (bounds.minX + bounds.maxX) * 0.5,
      z: (bounds.minZ + bounds.maxZ) * 0.5,
    }
  }, [engine])

  const tints = useMemo(() => (engine ? buildTints(engine.city) : []), [engine])
  const detail = useMemo(() => (engine ? buildDetail(engine.city) : EMPTY_DETAIL), [engine])

  const furniture = useMemo(() => {
    const trunkGeometry = new CylinderGeometry(0.16, 0.24, 1, 5)
    const canopyGeometry = new IcosahedronGeometry(1, 0)
    const poleGeometry = new CylinderGeometry(0.09, 0.15, 1, 5)
    const headGeometry = new BoxGeometry(1.4, 0.26, 0.5)
    const trunkMaterial = new MeshLambertMaterial({ color: '#6a5d50' })
    const canopyMaterial = new MeshLambertMaterial({ color: '#6f7f5f', flatShading: true })
    const poleMaterial = new MeshLambertMaterial({ color: '#8c8d89' })
    const headMaterial = new MeshLambertMaterial({ color: '#5c5e5c' })
    return {
      trunkGeometry,
      canopyGeometry,
      poleGeometry,
      headGeometry,
      trunkMaterial,
      canopyMaterial,
      poleMaterial,
      headMaterial,
    }
  }, [])

  const trunkRef = useRef<InstancedMesh | null>(null)
  const canopyRef = useRef<InstancedMesh | null>(null)
  const poleRef = useRef<InstancedMesh | null>(null)
  const headRef = useRef<InstancedMesh | null>(null)
  const treeGroupRef = useRef<Group | null>(null)
  const lampGroupRef = useRef<Group | null>(null)

  /**
   * §30 — the street furniture trembles with the ground.
   *
   * A whole-group *rotation* is not an option: these objects sit up to ~750 m
   * from the origin, where even 0.01 rad would swing them several metres. A
   * small uniform translation is what a rigid object standing on shaking ground
   * actually does, and it costs two transform writes per frame rather than
   * 1,100 instance matrices. Trees and lamps run on separate phases so the
   * street does not move as one rigid sheet.
   */
  useFrame(() => {
    const treeGroup = treeGroupRef.current
    const lampGroup = lampGroupRef.current
    if (!treeGroup && !lampGroup) return

    const envelope = engine ? Math.max(engine.shakeEnvelope(), engine.windStrength * 1.8) : 0
    if (!Number.isFinite(envelope) || envelope <= 0) {
      if (treeGroup) treeGroup.position.set(0, 0, 0)
      if (lampGroup) lampGroup.position.set(0, 0, 0)
      return
    }

    const t = engine ? engine.renderTime() : 0
    const amp = FURNITURE_SHAKE_AMPLITUDE * envelope
    if (treeGroup) {
      treeGroup.position.set(
        Math.sin(t * FURNITURE_SHAKE_RATE) * amp,
        0,
        Math.cos(t * FURNITURE_SHAKE_RATE * 1.31) * amp,
      )
    }
    if (lampGroup) {
      lampGroup.position.set(
        Math.sin(t * FURNITURE_SHAKE_RATE * 1.17 + 1.9) * amp,
        0,
        Math.cos(t * FURNITURE_SHAKE_RATE * 0.89 + 0.7) * amp,
      )
    }
  })

  useEffect(() => {
    if (!plane) return
    return () => {
      plane.geometry.dispose()
      plane.material.dispose()
    }
  }, [plane])

  useEffect(() => {
    if (tints.length === 0) return
    return () => {
      for (const layer of tints) {
        layer.geometry.dispose()
        layer.material.dispose()
      }
    }
  }, [tints])

  useEffect(
    () => () => {
      const disposables: (BufferGeometry | Material)[] = [
        furniture.trunkGeometry,
        furniture.canopyGeometry,
        furniture.poleGeometry,
        furniture.headGeometry,
        furniture.trunkMaterial,
        furniture.canopyMaterial,
        furniture.poleMaterial,
        furniture.headMaterial,
      ]
      for (const item of disposables) item.dispose()
    },
    [furniture],
  )

  useLayoutEffect(() => {
    applyMatrices(trunkRef.current, detail.trunk, detail.treeCount)
    applyMatrices(canopyRef.current, detail.canopy, detail.treeCount)
    applyMatrices(poleRef.current, detail.pole, detail.lampCount)
    applyMatrices(headRef.current, detail.head, detail.lampCount)
  }, [detail])

  if (!engine || !plane) return null

  return (
    <group>
      <mesh
        geometry={plane.geometry}
        material={plane.material}
        position={[plane.x, 0, plane.z]}
        receiveShadow
      />

      {tints.map((layer) => (
        <mesh
          key={layer.key}
          geometry={layer.geometry}
          material={layer.material}
          position={[layer.x, layer.y, layer.z]}
        />
      ))}

      {detail.treeCount > 0 ? (
        <group ref={treeGroupRef}>
          <instancedMesh
            ref={trunkRef}
            args={[furniture.trunkGeometry, furniture.trunkMaterial, detail.treeCount]}
          />
          <instancedMesh
            ref={canopyRef}
            args={[furniture.canopyGeometry, furniture.canopyMaterial, detail.treeCount]}
          />
        </group>
      ) : null}

      {detail.lampCount > 0 ? (
        <group ref={lampGroupRef}>
          <instancedMesh
            ref={poleRef}
            args={[furniture.poleGeometry, furniture.poleMaterial, detail.lampCount]}
          />
          <instancedMesh
            ref={headRef}
            args={[furniture.headGeometry, furniture.headMaterial, detail.lampCount]}
          />
        </group>
      ) : null}
    </group>
  )
}
