/**
 * §54 — evacuation shelters.
 *
 * A shelter is a low open pad with a slim marker pylon and a flat canopy. The
 * only thing that animates is the fill indicator: an inner pad that grows on X
 * and Z toward `occupancy / capacity`, plus a canopy that darkens by value as
 * the shelter fills. No labels, no alert colours — you read it from the shape.
 */

import { useEffect, useMemo, useRef } from 'react'
import type { ReactElement } from 'react'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { BoxGeometry, Color, CylinderGeometry, MeshLambertMaterial } from 'three'
import type { Mesh } from 'three'
import type { Shelter, ShelterKind } from '../types/city'
import { useSimulationStore } from '../store/simulationStore'
import { SHELTER_COLOR } from './palette'

const PAD_HEIGHT = 0.24
/** Pad centre — the pad is a unit box scaled to (width, PAD_HEIGHT, depth). */
const PAD_Y = 0.12
/** Fill pad rides just above the platform surface. */
const FILL_Y = 0.3
const FILL_THICKNESS = 0.12
const PYLON_HEIGHT = 6.2
const CANOPY_Y = PYLON_HEIGHT + 0.2

/**
 * Upper bound on a pad's side length. Generators sometimes hand us a park's
 * whole parcel; past this the pad stops reading as a marker and starts hiding
 * whatever it covers.
 */
const MAX_PAD_EXTENT = 150

/** Very small per-kind value shifts so wards of shelters are not identical. */
const KIND_TONE: Record<ShelterKind, number> = {
  park: 1.05,
  school: 1.0,
  gym: 0.96,
  civic: 0.98,
  hospital: 1.02,
}

function safeExtent(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 1 ? value : fallback
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

interface ShelterLayout {
  shelter: Shelter
  width: number
  depth: number
  /** Extent of the fill pad at 100 % occupancy. */
  fillWidth: number
  fillDepth: number
  /** Uniform scale for the pylon + canopy, so big pads get a bigger marker. */
  markerScale: number
}

function layoutFor(shelter: Shelter): ShelterLayout {
  // Shelters without a usable footprint get one scaled from capacity so the
  // pad still reads at city scale.
  const fallback = Math.max(14, Math.sqrt(Math.max(1, shelter.capacity)) * 1.4)
  const width = Math.min(MAX_PAD_EXTENT, safeExtent(shelter.footprint.width, fallback))
  const depth = Math.min(MAX_PAD_EXTENT, safeExtent(shelter.footprint.depth, fallback))
  const markerScale = Math.min(2.4, Math.max(0.75, Math.sqrt(width * depth) / 32))
  return {
    shelter,
    width,
    depth,
    fillWidth: width * 0.82,
    fillDepth: depth * 0.82,
    markerScale,
  }
}

export function Shelters(): ReactElement | null {
  const engine = useSimulationStore((s) => s.engine)
  const setSelection = useSimulationStore((s) => s.setSelection)

  const layouts = useMemo<ShelterLayout[]>(
    () => (engine ? engine.city.shelters.map(layoutFor) : []),
    [engine],
  )

  const assets = useMemo(() => {
    const unitBox = new BoxGeometry(1, 1, 1)
    const pylon = new CylinderGeometry(0.2, 0.32, PYLON_HEIGHT, 8)
    const canopy = new CylinderGeometry(2.6, 2.6, 0.26, 12)
    const pylonMaterial = new MeshLambertMaterial({
      color: new Color(SHELTER_COLOR).multiplyScalar(0.6),
    })
    const fillMaterial = new MeshLambertMaterial({
      color: new Color(SHELTER_COLOR).lerp(new Color('#4c4a42'), 0.34),
    })
    return { unitBox, pylon, canopy, pylonMaterial, fillMaterial }
  }, [])

  /** One pad + canopy material per shelter: both are tinted individually. */
  const materials = useMemo(() => {
    const canopyBase = new Color(SHELTER_COLOR).multiplyScalar(1.06)
    const canopyFull = new Color(SHELTER_COLOR).multiplyScalar(0.46)
    const pads = layouts.map(
      (l) =>
        new MeshLambertMaterial({
          color: new Color(SHELTER_COLOR).multiplyScalar(KIND_TONE[l.shelter.kind] ?? 1),
        }),
    )
    const canopies = layouts.map(() => new MeshLambertMaterial({ color: canopyBase.clone() }))
    return { pads, canopies, canopyBase, canopyFull }
  }, [layouts])

  const fillRefs = useRef<(Mesh | null)[]>([])
  const smoothed = useMemo(() => new Float32Array(Math.max(1, layouts.length)), [layouts])
  const lastMs = useRef(0)

  useEffect(
    () => () => {
      assets.unitBox.dispose()
      assets.pylon.dispose()
      assets.canopy.dispose()
      assets.pylonMaterial.dispose()
      assets.fillMaterial.dispose()
    },
    [assets],
  )

  useEffect(
    () => () => {
      for (const m of materials.pads) m.dispose()
      for (const m of materials.canopies) m.dispose()
    },
    [materials],
  )

  useFrame(() => {
    if (!engine) return
    const nowMs = performance.now()
    const previous = lastMs.current
    lastMs.current = nowMs
    // First frame (and any tab-switch gap) must not produce a huge step.
    const dt = previous === 0 ? 0 : Math.min(0.1, Math.max(0, (nowMs - previous) / 1000))
    const blend = Math.min(1, dt * 3)

    const runtimes = engine.shelters
    for (let i = 0; i < layouts.length; i++) {
      const layout = layouts[i]
      const runtime = runtimes[i]
      const mesh = fillRefs.current[i]
      if (!layout || !mesh) continue

      let target = 0
      if (runtime) {
        const capacity = runtime.capacity > 0 ? runtime.capacity : 1
        target = clamp01(runtime.occupancy / capacity)
      }
      const next = smoothed[i] + (target - smoothed[i]) * blend
      smoothed[i] = Number.isFinite(next) ? next : target

      const fill = smoothed[i]
      // Never fully degenerate: an empty shelter still shows a hairline pad.
      const scale = Math.max(0.04, fill)
      mesh.scale.set(layout.fillWidth * scale, FILL_THICKNESS, layout.fillDepth * scale)

      const canopyMaterial = materials.canopies[i]
      if (canopyMaterial) {
        canopyMaterial.color.copy(materials.canopyBase).lerp(materials.canopyFull, fill * 0.85)
      }
    }
  })

  if (!engine || layouts.length === 0) return null

  const handleDown = (index: number) => (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation()
    const layout = layouts[index]
    if (!layout) return
    const shelter = layout.shelter
    const store = useSimulationStore.getState()
    const current = store.selection
    if (current && current.kind === 'shelter' && current.id === shelter.id) {
      setSelection(null)
      return
    }
    const runtime = store.engine ? store.engine.shelters[index] : undefined
    setSelection({
      kind: 'shelter',
      id: shelter.id,
      name: shelter.name,
      occupancy: runtime ? runtime.occupancy : 0,
      capacity: runtime ? runtime.capacity : shelter.capacity,
      screenX: event.nativeEvent.clientX,
      screenY: event.nativeEvent.clientY,
    })
  }

  return (
    <group>
      {layouts.map((layout, index) => (
        <group
          key={layout.shelter.id}
          position={[layout.shelter.position.x, 0, layout.shelter.position.z]}
          onPointerDown={handleDown(index)}
        >
          <mesh
            geometry={assets.unitBox}
            material={materials.pads[index]}
            position={[0, PAD_Y, 0]}
            scale={[layout.width, PAD_HEIGHT, layout.depth]}
            receiveShadow
          />
          <mesh
            ref={(node) => {
              fillRefs.current[index] = node
            }}
            geometry={assets.unitBox}
            material={assets.fillMaterial}
            position={[0, FILL_Y, 0]}
            scale={[layout.fillWidth * 0.04, FILL_THICKNESS, layout.fillDepth * 0.04]}
            receiveShadow
          />
          <group scale={layout.markerScale}>
            <mesh
              geometry={assets.pylon}
              material={assets.pylonMaterial}
              position={[0, PYLON_HEIGHT * 0.5, 0]}
              castShadow
            />
            <mesh
              geometry={assets.canopy}
              material={materials.canopies[index]}
              position={[0, CANOPY_Y, 0]}
              castShadow
            />
          </group>
        </group>
      ))}
    </group>
  )
}
