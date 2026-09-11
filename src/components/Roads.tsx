/**
 * §15, §32 — the road network.
 *
 * The whole carriageway is baked into two merged, non-indexed buffer
 * geometries (surface + kerb) at start-up: nothing about the road *shape*
 * changes during a run, so there is no reason to pay for one draw call per
 * edge. Only the rubble that lands on blocked edges is dynamic, and that is a
 * single InstancedMesh whose matrices are written once per blocked edge and
 * then only re-scaled while the drop animation plays.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { ReactElement } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  IcosahedronGeometry,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  SphereGeometry,
} from 'three'
import type { InstancedMesh } from 'three'
import { Rng, mixSeed } from '../simulation/rng'
import type { SimulationEngine } from '../simulation/SimulationEngine'
import type { CityModel, RoadClass, Vec2 } from '../types/city'
import { useSimulationStore } from '../store/simulationStore'
import { ROAD_COLOR } from './palette'

/** Carriageway height above the ground plane. */
const SURFACE_Y = 0.06
/** Centre-line strip, sitting in the gap left between the two lane halves. */
const LINE_Y = 0.07
/** Kerb / sidewalk apron, a touch wider and a touch lower. */
const KERB_Y = 0.03

/** Segments used for the rounded junction blob. */
const JUNCTION_SEGMENTS = 12

/** Rubble slots reserved per edge (4..6 are used, the rest stay hidden). */
const ROCKS_PER_EDGE = 6
/** Seconds the rubble takes to grow to full size once an edge is blocked. */
const RUBBLE_GROW_TIME = 1

/** Very subtle lightness variation so the hierarchy reads from above. */
const CLASS_TONE: Record<RoadClass, number> = {
  arterial: 1.08,
  collector: 1.02,
  local: 0.96,
  alley: 0.9,
}

/** Half-width of the painted centre line, metres. */
const LINE_HALF: Partial<Record<RoadClass, number>> = {
  arterial: 0.6,
  collector: 0.4,
}

function kerbExtraFor(width: number): number {
  return Math.min(3.2, Math.max(1.4, width * 0.16))
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

interface RoadSurfaces {
  surface: BufferGeometry
  kerb: BufferGeometry
}

/**
 * Builds the merged surface + kerb geometry.
 *
 * Each edge contributes a ribbon; roads that carry a centre line contribute
 * two half-ribbons with the line sitting in the gap between them, so no two
 * co-planar surfaces ever overlap (which would z-fight at this camera range).
 * Junctions are covered by a small rounded blob drawn in the same colour as
 * the carriageway, which hides the wedge-shaped gaps where ribbons meet.
 */
function buildRoadSurfaces(city: CityModel): RoadSurfaces {
  const nodes = city.roadNetwork.nodes
  const edges = city.roadNetwork.edges

  const nodePos = new Map<string, Vec2>()
  for (const node of nodes) nodePos.set(node.id, node.position)

  // Junction blob radii: the widest carriageway (and kerb) meeting the node.
  const roadRadius = new Map<string, number>()
  const kerbRadius = new Map<string, number>()
  const noteNode = (id: string, half: number, kerb: number): void => {
    const r = roadRadius.get(id)
    if (r === undefined || half > r) roadRadius.set(id, half)
    const k = kerbRadius.get(id)
    if (k === undefined || kerb > k) kerbRadius.set(id, kerb)
  }
  for (const edge of edges) {
    const half = Math.max(1, edge.width) * 0.5
    const kerb = half + kerbExtraFor(Math.max(1, edge.width))
    noteNode(edge.from, half, kerb)
    noteNode(edge.to, half, kerb)
  }

  const surfacePos: number[] = []
  const surfaceCol: number[] = []
  const kerbPos: number[] = []
  const kerbCol: number[] = []

  const base = new Color(ROAD_COLOR)
  const kerbColor = new Color(ROAD_COLOR).lerp(new Color('#ffffff'), 0.5)
  const tone = new Color()
  const lineColor = new Color()

  /** Emits one quad (two triangles, normal +Y) spanning [o0, o1] across the segment. */
  const quad = (
    pos: number[],
    col: number[],
    ax: number,
    az: number,
    bx: number,
    bz: number,
    nx: number,
    nz: number,
    o0: number,
    o1: number,
    y: number,
    c: Color,
  ): void => {
    const x0 = ax + nx * o0
    const z0 = az + nz * o0
    const x1 = ax + nx * o1
    const z1 = az + nz * o1
    const x2 = bx + nx * o1
    const z2 = bz + nz * o1
    const x3 = bx + nx * o0
    const z3 = bz + nz * o0
    pos.push(x0, y, z0, x1, y, z1, x2, y, z2)
    pos.push(x0, y, z0, x2, y, z2, x3, y, z3)
    for (let i = 0; i < 6; i++) col.push(c.r, c.g, c.b)
  }

  /** Emits a rounded cap centred on a node so junctions read as solid. */
  const blob = (
    pos: number[],
    col: number[],
    cx: number,
    cz: number,
    radius: number,
    y: number,
    c: Color,
  ): void => {
    // Circumscribed polygon: the flat sides still reach the nominal radius.
    const r = radius / Math.cos(Math.PI / JUNCTION_SEGMENTS)
    for (let i = 0; i < JUNCTION_SEGMENTS; i++) {
      const a0 = (i / JUNCTION_SEGMENTS) * Math.PI * 2
      const a1 = ((i + 1) / JUNCTION_SEGMENTS) * Math.PI * 2
      const x0 = cx + Math.cos(a0) * r
      const z0 = cz + Math.sin(a0) * r
      const x1 = cx + Math.cos(a1) * r
      const z1 = cz + Math.sin(a1) * r
      // Reversed winding so the face normal points up.
      pos.push(cx, y, cz, x1, y, z1, x0, y, z0)
      for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b)
    }
  }

  for (const edge of edges) {
    const a = nodePos.get(edge.from)
    const b = nodePos.get(edge.to)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz)
    if (!(len > 1e-3)) continue
    const ux = dx / len
    const uz = dz / len
    // Left normal in the XZ plane.
    const nx = -uz
    const nz = ux

    const width = Math.max(1, edge.width)
    const half = width * 0.5
    tone.copy(base).multiplyScalar(CLASS_TONE[edge.roadClass] ?? 1)

    const lineHalf = LINE_HALF[edge.roadClass]
    if (lineHalf !== undefined && half > lineHalf * 3) {
      quad(surfacePos, surfaceCol, a.x, a.z, b.x, b.z, nx, nz, -half, -lineHalf, SURFACE_Y, tone)
      quad(surfacePos, surfaceCol, a.x, a.z, b.x, b.z, nx, nz, lineHalf, half, SURFACE_Y, tone)
      lineColor.copy(tone).multiplyScalar(0.74)
      quad(
        surfacePos,
        surfaceCol,
        a.x,
        a.z,
        b.x,
        b.z,
        nx,
        nz,
        -lineHalf,
        lineHalf,
        LINE_Y,
        lineColor,
      )
    } else {
      quad(surfacePos, surfaceCol, a.x, a.z, b.x, b.z, nx, nz, -half, half, SURFACE_Y, tone)
    }

    const kerbHalf = half + kerbExtraFor(width)
    quad(kerbPos, kerbCol, a.x, a.z, b.x, b.z, nx, nz, -kerbHalf, kerbHalf, KERB_Y, kerbColor)
  }

  for (const node of nodes) {
    const r = roadRadius.get(node.id)
    if (r !== undefined && r > 0) {
      blob(surfacePos, surfaceCol, node.position.x, node.position.z, r, SURFACE_Y, base)
    }
    const k = kerbRadius.get(node.id)
    if (k !== undefined && k > 0) {
      blob(kerbPos, kerbCol, node.position.x, node.position.z, k, KERB_Y, kerbColor)
    }
  }

  const make = (pos: number[], col: number[]): BufferGeometry => {
    const geometry = new BufferGeometry()
    const count = pos.length / 3
    const normals = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    geometry.setAttribute('normal', new BufferAttribute(normals, 3))
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(col), 3))
    geometry.computeBoundingSphere()
    return geometry
  }

  return { surface: make(surfacePos, surfaceCol), kerb: make(kerbPos, kerbCol) }
}

interface RubbleData {
  edgeCount: number
  slots: number
  geometry: IcosahedronGeometry
  material: MeshLambertMaterial
  /** 1 once the matrices for that edge have been authored. */
  placed: Uint8Array
  /** 1 once the growth animation has reached full size. */
  grown: Uint8Array
  /** How many of the six slots that edge actually uses. */
  used: Uint8Array
  x: Float32Array
  y: Float32Array
  z: Float32Array
  rotation: Float32Array
  sx: Float32Array
  sy: Float32Array
  sz: Float32Array
}

function buildRubble(edgeCount: number): RubbleData {
  const slots = Math.max(1, edgeCount * ROCKS_PER_EDGE)
  const geometry = new IcosahedronGeometry(1, 0)
  const material = new MeshLambertMaterial({
    color: new Color(ROAD_COLOR).lerp(new Color('#7d6d59'), 0.42).multiplyScalar(0.82),
    flatShading: true,
  })
  return {
    edgeCount,
    slots,
    geometry,
    material,
    placed: new Uint8Array(Math.max(1, edgeCount)),
    grown: new Uint8Array(Math.max(1, edgeCount)),
    used: new Uint8Array(Math.max(1, edgeCount)),
    x: new Float32Array(slots),
    y: new Float32Array(slots),
    z: new Float32Array(slots),
    rotation: new Float32Array(slots),
    sx: new Float32Array(slots),
    sy: new Float32Array(slots),
    sz: new Float32Array(slots),
  }
}

export function Roads(): ReactElement | null {
  const engine = useSimulationStore((s) => s.engine)
  const debug = useSimulationStore((s) => s.debug)

  const surfaces = useMemo(() => (engine ? buildRoadSurfaces(engine.city) : null), [engine])
  const rubble = useMemo(() => (engine ? buildRubble(engine.roads.length) : null), [engine])

  const surfaceMaterial = useMemo(
    () =>
      new MeshLambertMaterial({
        vertexColors: true,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    [],
  )
  const kerbMaterial = useMemo(
    () =>
      new MeshLambertMaterial({
        vertexColors: true,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    [],
  )

  const rubbleRef = useRef<InstancedMesh | null>(null)
  const dummy = useMemo(() => new Object3D(), [])

  useEffect(() => {
    if (!surfaces) return
    return () => {
      surfaces.surface.dispose()
      surfaces.kerb.dispose()
    }
  }, [surfaces])

  useEffect(() => {
    if (!rubble) return
    return () => {
      rubble.geometry.dispose()
      rubble.material.dispose()
    }
  }, [rubble])

  useEffect(
    () => () => {
      surfaceMaterial.dispose()
      kerbMaterial.dispose()
    },
    [surfaceMaterial, kerbMaterial],
  )

  /** InstancedMesh matrices start as identity — hide every rock up front. */
  useLayoutEffect(() => {
    const mesh = rubbleRef.current
    if (!mesh || !rubble) return
    dummy.position.set(0, -1000, 0)
    dummy.rotation.set(0, 0, 0)
    dummy.scale.set(0.0001, 0.0001, 0.0001)
    dummy.updateMatrix()
    for (let i = 0; i < rubble.slots; i++) mesh.setMatrixAt(i, dummy.matrix)
    mesh.instanceMatrix.needsUpdate = true
    rubble.placed.fill(0)
    rubble.grown.fill(0)
  }, [rubble, dummy])

  useFrame(() => {
    const mesh = rubbleRef.current
    if (!engine || !mesh || !rubble) return
    const roads = engine.roads
    const now = engine.renderTime()
    let dirty = false

    const hide = (slot: number): void => {
      dummy.position.set(0, -1000, 0)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(0.0001, 0.0001, 0.0001)
      dummy.updateMatrix()
      mesh.setMatrixAt(slot, dummy.matrix)
    }

    const writeEdge = (edgeIndex: number, growth: number): void => {
      const used = rubble.used[edgeIndex] ?? 0
      for (let k = 0; k < ROCKS_PER_EDGE; k++) {
        const slot = edgeIndex * ROCKS_PER_EDGE + k
        if (slot >= rubble.slots) break
        if (k >= used) {
          hide(slot)
          continue
        }
        dummy.position.set(rubble.x[slot], rubble.y[slot] * growth, rubble.z[slot])
        dummy.rotation.set(0, rubble.rotation[slot], 0)
        dummy.scale.set(
          Math.max(0.0001, rubble.sx[slot] * growth),
          Math.max(0.0001, rubble.sy[slot] * growth),
          Math.max(0.0001, rubble.sz[slot] * growth),
        )
        dummy.updateMatrix()
        mesh.setMatrixAt(slot, dummy.matrix)
      }
    }

    const limit = Math.min(roads.length, rubble.edgeCount)
    for (let i = 0; i < limit; i++) {
      const road = roads[i]
      if (!road) continue

      if (road.debrisLevel < 0.3) {
        if (rubble.placed[i]) {
          for (let k = 0; k < ROCKS_PER_EDGE; k++) {
            const slot = i * ROCKS_PER_EDGE + k
            if (slot < rubble.slots) hide(slot)
          }
          rubble.placed[i] = 0
          rubble.grown[i] = 0
          dirty = true
        }
        continue
      }

      if (!rubble.placed[i]) {
        // Deterministic layout derived from the edge index alone.
        const edge = road.source
        const from = engine.graph.position(edge.from)
        const to = engine.graph.position(edge.to)
        const dx = to.x - from.x
        const dz = to.z - from.z
        const len = Math.hypot(dx, dz)
        if (!(len > 1e-3)) {
          rubble.used[i] = 0
        } else {
          const ux = dx / len
          const uz = dz / len
          const nx = -uz
          const nz = ux
          const rng = new Rng(mixSeed(i + 1, 0x1f2e3d4c))
          const count = 4 + rng.int(0, 2)
          rubble.used[i] = count
          const width = Math.max(2, edge.width)
          for (let k = 0; k < count; k++) {
            const slot = i * ROCKS_PER_EDGE + k
            if (slot >= rubble.slots) break
            // Middle third of the edge only: junctions stay walkable-looking.
            const spread = clamp01((k + 0.5) / count + rng.range(-0.14, 0.14))
            const t = 1 / 3 + spread / 3
            const lateral = rng.range(-0.34, 0.34) * width
            const size = (0.55 + width * 0.055) * rng.range(0.7, 1.35)
            rubble.x[slot] = from.x + ux * len * t + nx * lateral
            rubble.z[slot] = from.z + uz * len * t + nz * lateral
            rubble.y[slot] = SURFACE_Y + size * 0.3
            rubble.rotation[slot] = rng.range(0, Math.PI * 2)
            rubble.sx[slot] = size
            rubble.sy[slot] = size * rng.range(0.42, 0.68)
            rubble.sz[slot] = size * rng.range(0.8, 1.25)
          }
        }
        rubble.placed[i] = 1
        rubble.grown[i] = 0
        dirty = true
      }

      if (!rubble.grown[i]) {
        const blockedAt = road.blockedAt
        const growth =
          blockedAt === null || !Number.isFinite(blockedAt)
            ? 1
            : clamp01((now - blockedAt) / RUBBLE_GROW_TIME)
        // Ease-out so the pile settles rather than snapping to size.
        const eased = 1 - (1 - growth) * (1 - growth) * (1 - growth)
        writeEdge(i, Math.max(0.02, eased))
        if (growth >= 1) rubble.grown[i] = 1
        dirty = true
      }
    }

    if (dirty) mesh.instanceMatrix.needsUpdate = true
  })

  if (!engine || !surfaces || !rubble) return null

  return (
    <group>
      <mesh
        geometry={surfaces.kerb}
        material={kerbMaterial}
        receiveShadow
        castShadow={false}
        renderOrder={1}
      />
      <mesh
        geometry={surfaces.surface}
        material={surfaceMaterial}
        receiveShadow
        castShadow={false}
        renderOrder={2}
      />
      <instancedMesh
        ref={rubbleRef}
        args={[rubble.geometry, rubble.material, rubble.slots]}
        frustumCulled={false}
        receiveShadow
        castShadow={false}
      />
      {debug ? <RoadDebug engine={engine} /> : null}
    </group>
  )
}

/** §58, §68 — only mounted while debug is on. */
function RoadDebug({ engine }: { engine: SimulationEngine }): ReactElement {
  const nodeRef = useRef<InstancedMesh | null>(null)
  const blockedRef = useRef<InstancedMesh | null>(null)
  const dummy = useMemo(() => new Object3D(), [])

  const assets = useMemo(() => {
    const nodeGeometry = new SphereGeometry(1.5, 8, 6)
    const nodeMaterial = new MeshBasicMaterial({ color: '#e8e2d6' })
    const edgeGeometry = new BoxGeometry(1, 1, 1)
    const edgeMaterial = new MeshBasicMaterial({
      color: '#2a2320',
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    })
    return { nodeGeometry, nodeMaterial, edgeGeometry, edgeMaterial }
  }, [])

  const nodeCount = Math.max(1, engine.city.roadNetwork.nodes.length)
  const edgeCount = Math.max(1, engine.roads.length)

  useEffect(
    () => () => {
      assets.nodeGeometry.dispose()
      assets.nodeMaterial.dispose()
      assets.edgeGeometry.dispose()
      assets.edgeMaterial.dispose()
    },
    [assets],
  )

  useLayoutEffect(() => {
    const mesh = nodeRef.current
    if (!mesh) return
    const nodes = engine.city.roadNetwork.nodes
    for (let i = 0; i < nodeCount; i++) {
      const node = nodes[i]
      dummy.rotation.set(0, 0, 0)
      if (node) {
        dummy.position.set(node.position.x, 1.4, node.position.z)
        dummy.scale.set(1, 1, 1)
      } else {
        dummy.position.set(0, -1000, 0)
        dummy.scale.set(0.0001, 0.0001, 0.0001)
      }
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  }, [engine, nodeCount, dummy])

  useFrame(() => {
    const mesh = blockedRef.current
    if (!mesh) return
    const roads = engine.roads
    for (let i = 0; i < edgeCount; i++) {
      const road = roads[i]
      if (!road || !road.blocked) {
        dummy.position.set(0, -1000, 0)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(0.0001, 0.0001, 0.0001)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        continue
      }
      const from = engine.graph.position(road.source.from)
      const to = engine.graph.position(road.source.to)
      const dx = to.x - from.x
      const dz = to.z - from.z
      const len = Math.hypot(dx, dz)
      if (!(len > 1e-3)) {
        dummy.position.set(0, -1000, 0)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(0.0001, 0.0001, 0.0001)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        continue
      }
      dummy.position.set((from.x + to.x) * 0.5, 0.13, (from.z + to.z) * 0.5)
      dummy.rotation.set(0, Math.atan2(-dz / len, dx / len), 0)
      dummy.scale.set(len, 0.06, Math.max(1, road.source.width) * 0.8)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  })

  return (
    <group>
      <instancedMesh
        ref={nodeRef}
        args={[assets.nodeGeometry, assets.nodeMaterial, nodeCount]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={blockedRef}
        args={[assets.edgeGeometry, assets.edgeMaterial, edgeCount]}
        frustumCulled={false}
        renderOrder={4}
      />
    </group>
  )
}
