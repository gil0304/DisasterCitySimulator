import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { BoxGeometry, BufferAttribute, Color, CylinderGeometry, MeshLambertMaterial, Object3D } from 'three'
import type { BufferGeometry, InstancedMesh } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { useSimulationStore } from '../store/simulationStore'

function vehicleGeometry(kind: number): BufferGeometry {
  const length = [3.5, 4.6, 4.9, 6.5, 10.5][kind], width = kind > 2 ? 2.4 : 1.75, height = kind > 1 ? 1.7 : 1.15
  const parts: BufferGeometry[] = []
  const add = (geometry: BufferGeometry, x: number, y: number, z: number, color: string) => {
    geometry.translate(x, y, z)
    const c = new Color(color), colors = new Float32Array(geometry.getAttribute('position').count * 3)
    for (let i = 0; i < colors.length; i += 3) { colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b }
    geometry.setAttribute('color', new BufferAttribute(colors, 3)); parts.push(geometry)
  }
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: string) => add(new BoxGeometry(w, h, d), x, y, z, color)
  box(width, 0.65, length, 0, 0.7, 0, '#eeeae0')
  box(width * 0.87, height, length * (kind > 1 ? 0.86 : 0.55), 0, 1.05 + height / 2, -0.15, '#d8dedc')
  box(width * 0.76, height * 0.65, 0.04, 0, 1.12 + height / 2, length * (kind > 1 ? 0.43 : 0.275) - 0.12, '#344b57')
  for (const side of [-1, 1]) {
    box(0.04, height * 0.6, length * (kind === 4 ? 0.73 : 0.4), side * width * 0.44, 1.15 + height / 2, -0.15, '#425966')
    if (kind === 4) box(0.06, 0.24, length * 0.95, side * width * 0.505, 0.85, 0, '#5c806f')
    for (const z of [-length * 0.32, length * 0.32]) {
      const wheel = new CylinderGeometry(0.35, 0.35, 0.22, 8); wheel.rotateZ(Math.PI / 2)
      add(wheel, side * width * 0.49, 0.4, z, '#303334')
    }
    box(0.35, 0.18, 0.08, side * width * 0.32, 0.74, length / 2 + 0.03, '#fff0c8')
    box(0.3, 0.18, 0.08, side * width * 0.32, 0.74, -length / 2 - 0.03, '#934838')
  }
  const result = mergeGeometries(parts)!
  for (const part of parts) part.dispose()
  return result
}
export function Vehicles() {
  const engine = useSimulationStore(s => s.engine)
  const assets = useMemo(() => {
    if (!engine) return null
    const traffic = engine.traffic
    return { traffic, kinds: Array.from({ length: 5 }, (_, kind) => ({ kind, geometry: vehicleGeometry(kind), mesh: null as InstancedMesh | null, ids: traffic.vehicles.filter(v => v.kind === kind).map(v => v.id) })), colored: false }
  }, [engine])
  const material = useMemo(() => new MeshLambertMaterial({ vertexColors: true }), [])
  const dummy = useMemo(() => new Object3D(), [])
  useEffect(() => () => { assets?.kinds.forEach(k => k.geometry.dispose()); material.dispose() }, [assets, material])
  useFrame(() => {
    if (!engine || !assets) return
    const alpha = engine.phase === 'idle' ? assets.traffic.alpha : engine.alpha
    for (const group of assets.kinds) {
      if (!group.mesh) continue
      group.ids.forEach((id, i) => {
        const v = assets.traffic.vehicles[id]
        dummy.position.set(v.px + (v.x - v.px) * alpha, 0.08, v.pz + (v.z - v.pz) * alpha)
        const turn = Math.atan2(Math.sin(v.heading - v.previousHeading), Math.cos(v.heading - v.previousHeading))
        dummy.rotation.set(0, v.previousHeading + turn * alpha, 0); dummy.scale.setScalar(1)
        dummy.updateMatrix(); group.mesh!.setMatrixAt(i, dummy.matrix)
        if (!assets.colored) group.mesh!.setColorAt(i, new Color(['#ffffff', '#bacbd0', '#d4d0c6', '#8c959f', '#b6bfb3', '#bfa9a1'][id % 6]))
      })
      group.mesh.instanceMatrix.needsUpdate = true
      if (!assets.colored && group.mesh.instanceColor) group.mesh.instanceColor.needsUpdate = true
    }
    assets.colored = true
  })
  if (!assets) return null
  return <group>{assets.kinds.filter(k => k.ids.length).map(k => <instancedMesh key={k.kind} ref={mesh => { k.mesh = mesh }} args={[k.geometry, material, k.ids.length]} frustumCulled={false} castShadow receiveShadow />)}</group>
}
