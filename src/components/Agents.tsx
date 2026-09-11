import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { BoxGeometry, BufferAttribute, BufferGeometry, CapsuleGeometry, Color, CylinderGeometry, MeshLambertMaterial, Object3D, SphereGeometry } from 'three'
import type { InstancedMesh } from 'three'
import { useSimulationStore } from '../store/simulationStore'
import { MAX_RENDERED_AGENTS } from '../simulation/constants'
import { AGENT_COLORS } from './palette'

/** A small articulated figure, nine shared instance batches for the whole population. */
export function Agents() {
  const engine = useSimulationStore(s => s.engine)
  const debug = useSimulationStore(s => s.debug)
  const count = Math.min(engine?.agents.length ?? 0, MAX_RENDERED_AGENTS)
  const assets = useMemo(() => {
    const wheel = new CylinderGeometry(0.3, 0.3, 0.07, 10); wheel.rotateZ(Math.PI / 2)
    const geometries = [new CapsuleGeometry(0.23, 0.48, 3, 6), new SphereGeometry(0.22, 8, 6), new BoxGeometry(0.17, 0.74, 0.19), new BoxGeometry(0.17, 0.74, 0.19), new BoxGeometry(0.13, 0.64, 0.14), new BoxGeometry(0.13, 0.64, 0.14), new BoxGeometry(0.07, 0.87, 0.07), wheel, wheel.clone()]
    const parts = geometries.map((geometry, i) => ({ geometry, material: new MeshLambertMaterial({ color: i === 0 || i === 1 ? '#ffffff' : i > 5 ? '#434b50' : '#384956' }), mesh: null as InstancedMesh | null }))
    const path = new BufferGeometry(); path.setAttribute('position', new BufferAttribute(new Float32Array(6144), 3)); path.setDrawRange(0, 0)
    return { parts, path, ambientTime: 0, version: -1, colored: new Uint8Array(MAX_RENDERED_AGENTS), lastDebug: -1 }
  }, [])
  const dummy = useMemo(() => new Object3D(), [])
  useEffect(() => () => { assets.parts.forEach(p => { p.geometry.dispose(); p.material.dispose() }); assets.path.dispose() }, [assets])
  useFrame((frame, delta) => {
    if (!engine || !assets.parts.every(p => p.mesh)) return
    if (assets.version !== engine.runVersion) { assets.version = engine.runVersion; if (engine.phase === 'idle') assets.ambientTime = 0 }
    if (engine.phase === 'idle') assets.ambientTime += Math.min(0.1, delta)
    const idle = engine.phase === 'idle', time = idle ? assets.ambientTime : engine.renderTime()
    const b = engine.city.meta.bounds, cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2
    const cameraDistance = Math.hypot(frame.camera.position.x - cx, frame.camera.position.y, frame.camera.position.z - cz)
    const zoom = Math.min(2.2, Math.max(1, cameraDistance / 250))
    const alpha = engine.paused || engine.phase === 'finished' ? 1 : engine.alpha
    let colorsDirty = false
    for (let i = 0; i < count; i++) {
      const a = engine.agents[i]
      const visible = idle ? i < 280 : a.state !== 'inside' && a.state !== 'dead'
      if (!visible) {
        dummy.position.set(0, -1000, 0); dummy.scale.setScalar(0); dummy.updateMatrix()
        for (const part of assets.parts) part.mesh!.setMatrixAt(i, dummy.matrix)
        continue
      }
      let x = a.px + (a.x - a.px) * alpha, z = a.pz + (a.z - a.pz) * alpha
      let heading = Math.atan2(a.x - a.px, a.z - a.pz)
      let moving = Math.hypot(a.x - a.px, a.z - a.pz) > 0.001
      if (idle) {
        const road = engine.roads[(i * 17) % engine.roads.length].source
        const from = engine.graph.position(road.from), to = engine.graph.position(road.to)
        const length = Math.max(1, road.length - 5)
        const cycle = (i * 7.71 + time * a.movementSpeed) % (length * 2)
        const reverse = cycle > length, distance = (reverse ? length * 2 - cycle : cycle) + 2.5
        const dx = to.x - from.x, dz = to.z - from.z, full = Math.max(1, road.length)
        const side = (i % 2 ? -1 : 1) * Math.max(0, road.width / 2 - 0.55)
        x = from.x + dx * distance / full - dz / full * side
        z = from.z + dz * distance / full + dx / full * side
        heading = Math.atan2(dx, dz) + (reverse ? Math.PI : 0); moving = true
      }
      const wheelchair = a.profile === 'mobilityImpaired' && i % 3 === 0
      const scale = (a.profile === 'child' ? 0.72 : a.profile === 'elderly' ? 0.94 : 1) * zoom
      const stride = moving && !wheelchair ? Math.sin(time * a.movementSpeed * 7.2 + i * 1.73) * 0.48 : 0
      const bob = moving && !wheelchair ? Math.abs(stride) * 0.06 : 0
      const cos = Math.cos(heading), sin = Math.sin(heading)
      // local x/y/z, forward limb swing, visibility. The torso remains stable as legs alternate.
      for (let k = 0; k < assets.parts.length; k++) {
        const part = assets.parts[k]
        const lx = k === 2 ? -0.14 : k === 3 ? 0.14 : k === 4 ? -0.32 : k === 5 ? 0.32 : k === 6 ? 0.43 : k === 7 ? -0.37 : k === 8 ? 0.37 : 0
        const ly = k === 0 ? (wheelchair ? 0.94 : 1.08 + bob) : k === 1 ? (wheelchair ? 1.46 : 1.68 + bob) : k === 2 || k === 3 ? (wheelchair ? 0.45 : 0.41) : k < 6 ? 1.07 : k === 6 ? 0.44 : 0.33
        const lz = k === 1 ? 0.03 : (k === 2 || k === 3) && wheelchair ? 0.22 : k === 6 ? 0.14 : 0
        const pitch = k === 0 && a.profile === 'elderly' ? 0.1 : k === 2 ? stride : k === 3 ? -stride : k === 4 ? -stride * 0.7 : k === 5 ? stride * 0.7 : k === 6 ? -0.09 : 0
        const shown = k < 6 ? 1 : k === 6 ? (a.profile === 'elderly' || (a.profile === 'mobilityImpaired' && !wheelchair) ? 1 : 0) : wheelchair ? 1 : 0
        dummy.position.set(x + (lx * cos + lz * sin) * scale, ly * scale + 0.12, z + (-lx * sin + lz * cos) * scale)
        dummy.rotation.set(pitch, heading, 0, 'YXZ'); dummy.scale.setScalar(shown * scale); dummy.updateMatrix(); part.mesh!.setMatrixAt(i, dummy.matrix)
        if (!assets.colored[i] && k < 2) {
          const tint = k === 1 ? ['#be9678', '#d4b497', '#b38b70', '#e0c4a6'][i % 4] : AGENT_COLORS[a.profile]
          part.mesh!.setColorAt(i, new Color(tint)); colorsDirty = true
        }
      }
      assets.colored[i] = 1
    }
    for (const part of assets.parts) { part.mesh!.instanceMatrix.needsUpdate = true; if (colorsDirty && part.mesh!.instanceColor) part.mesh!.instanceColor!.needsUpdate = true }
    if (debug && Math.floor(time) !== assets.lastDebug) {
      assets.lastDebug = Math.floor(time)
      const positions = assets.path.getAttribute('position'); let n = 0
      for (let i = 0; i < count && n < 2046; i += 97) {
        const a = engine.agents[i]; if (a.state !== 'evacuating') continue
        let x = a.x, z = a.z
        for (const nodeId of a.path.slice(a.pathIndex)) {
          if (n >= 2046) break
          const p = engine.graph.position(nodeId)
          positions.setXYZ(n++, x, 0.3, z); positions.setXYZ(n++, p.x, 0.3, p.z); x = p.x; z = p.z
        }
      }
      assets.path.setDrawRange(0, n); positions.needsUpdate = true
    }
  })
  if (!engine) return null
  return <group>{assets.parts.map((p, i) => <instancedMesh key={i} ref={mesh => { p.mesh = mesh }} args={[p.geometry, p.material, Math.max(1, count)]} frustumCulled={false} />)}
    {debug && <lineSegments geometry={assets.path}><lineBasicMaterial color="#355d79" transparent opacity={0.5} /></lineSegments>}
  </group>
}
