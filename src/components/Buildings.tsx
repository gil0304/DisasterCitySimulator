import { useCallback, useEffect, useMemo } from 'react'
import type { JSX } from 'react'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Mesh, MeshLambertMaterial } from 'three'
import type { BufferGeometry } from 'three'
import type { DamageState, SelectedBuildingInfo } from '../types/simulation'
import { useSimulationStore } from '../store/simulationStore'
import type { BuildingGeometryResult } from './buildingGeometry'
import { applyDamageTint, createBuildingGeometry, createDamagedGeometry, createRubbleGeometry } from './buildingGeometry'

export function Buildings(): JSX.Element | null {
  const engine = useSimulationStore(s => s.engine)
  const setSelection = useSimulationStore(s => s.setSelection)
  const material = useMemo(() => new MeshLambertMaterial({ vertexColors: true }), [])
  const visuals = useMemo(() => engine?.buildings.map(b => {
    const intact = createBuildingGeometry(b.source, engine.seed)
    return {
      intact, stages: new Map<DamageState, BuildingGeometryResult>([['intact', intact]]),
      rubble: createRubbleGeometry(b.source, engine.seed), mesh: null as Mesh | null,
      debrisMesh: null as Mesh | null, collapseGeometry: null as BufferGeometry | null,
      collapsePositions: null as Float32Array | null, lastBurn: -1, stage: 'intact' as DamageState,
    }
  }) ?? [], [engine])
  useEffect(() => () => {
    material.dispose()
    for (const v of visuals) {
      for (const result of v.stages.values()) result.geometry.dispose()
      v.rubble.dispose(); v.collapseGeometry?.dispose()
    }
  }, [visuals, material])
  const onPointerDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation()
    const store = useSimulationStore.getState()
    const index = event.object.userData.buildingIndex as number
    const b = store.engine?.buildings[index]
    if (!b) return
    if (store.selection?.kind === 'building' && store.selection.id === b.id) { setSelection(null); return }
    const info: SelectedBuildingInfo = {
      kind: 'building', id: b.id, name: b.source.name, use: b.source.use,
      yearBuilt: b.source.yearBuilt, occupancy: b.source.occupancy,
      seismicResistance: b.source.seismicResistance, damageState: b.state,
      damageScore: b.damageScore, screenX: event.clientX, screenY: event.clientY,
    }
    setSelection(info)
  }, [setSelection])
  useFrame(() => {
    if (!engine) return
    const t = engine.renderTime()
    for (let i = 0; i < visuals.length; i++) {
      const v = visuals[i], b = engine.buildings[i], mesh = v.mesh, debris = v.debrisMesh
      if (!mesh || !debris) continue
      const source = b.source
      const stage: DamageState = b.state === 'collapsed' ? 'severe' : b.state
      let result = v.stages.get(stage)
      if (!result) {
        result = createDamagedGeometry(source, v.intact, stage as 'minor' | 'major' | 'severe', engine.seed)
        v.stages.set(stage, result)
      }
      const burn = Math.round(b.burnProgress * 24) / 24
      if (stage !== v.stage || burn !== v.lastBurn) {
        applyDamageTint(result, source, stage, burn)
        v.lastBurn = burn; v.stage = stage
      }
      mesh.visible = b.collapseProgress < 1
      mesh.position.set(source.position.x, 0, source.position.z)
      mesh.rotation.set(0, source.rotation, 0)
      mesh.scale.set(1, 1, 1)
      mesh.geometry = result.geometry
      const p = b.collapseProgress
      debris.visible = p > 0
      if (p >= 1) {
        mesh.visible = false
        debris.scale.setScalar(1)
        continue
      }
      if (p > 0) {
        if (!v.collapseGeometry) {
          v.collapseGeometry = result.geometry.clone()
          v.collapsePositions = new Float32Array(v.collapseGeometry.getAttribute('position').array)
        }
        const cg = v.collapseGeometry, positions = cg.getAttribute('position'), base = v.collapsePositions!
        const height = Math.max(3, source.height)
        const wood = source.constructionType === 'wood'
        for (let j = 0; j < positions.count; j++) {
          const x = base[j * 3], y = base[j * 3 + 1], z = base[j * 3 + 2]
          const floor = Math.floor(y / (height / Math.max(1, source.floors)))
          const fall = Math.min(1, Math.max(0, (p - (1 - y / height) * 0.18) / 0.72))
          const crush = fall * fall
          const shift = (wood ? 0.17 : 0.06) * height * crush * y / height
          positions.setXYZ(j, x + Math.cos(b.collapseDirection) * shift + Math.sin(floor * 2.3) * crush, Math.max(0.1, y * (1 - crush * 0.92)), z + Math.sin(b.collapseDirection) * shift)
        }
        positions.needsUpdate = true
        mesh.geometry = cg
        debris.scale.setScalar(Math.min(1, p * 1.5))
        if (p >= 1) mesh.visible = false
      } else {
        // A reset discards the deformed copy so the next run starts from its original vertices.
        if (v.collapseGeometry) { v.collapseGeometry.dispose(); v.collapseGeometry = null; v.collapsePositions = null }
        const residual = stage === 'severe' ? 0.045 : stage === 'major' ? 0.012 : 0
        const shake = b.shakeIntensity
        mesh.rotation.x = Math.sin(b.collapseDirection) * residual + Math.sin(t * 12 + b.shakePhase) * shake * 0.016
        mesh.rotation.z = Math.cos(b.collapseDirection) * residual + Math.cos(t * 10.4 + b.shakePhase) * shake * 0.016
        mesh.position.y = stage === 'severe' ? -source.height * 0.025 : 0
      }
    }
  })
  if (!engine) return null
  return <group>{visuals.map((v, i) => {
    const b = engine.buildings[i].source
    return <group key={b.id}>
      <mesh ref={mesh => { v.mesh = mesh }} geometry={v.intact.geometry} material={material}
        position={[b.position.x, 0, b.position.z]} rotation={[0, b.rotation, 0]}
        userData={{ buildingIndex: i }} castShadow receiveShadow onPointerDown={onPointerDown} />
      <mesh ref={mesh => { v.debrisMesh = mesh }} geometry={v.rubble} material={material}
        position={[b.position.x, 0, b.position.z]} rotation={[0, b.rotation, 0]}
        visible={false} userData={{ buildingIndex: i }} receiveShadow onPointerDown={onPointerDown} />
    </group>
  })}</group>
}
