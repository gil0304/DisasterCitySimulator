import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, ConeGeometry, IcosahedronGeometry, MeshLambertMaterial, MeshStandardMaterial, Object3D, PlaneGeometry } from 'three'
import type { InstancedMesh, Mesh, LineSegments } from 'three'
import { useSimulationStore } from '../store/simulationStore'
import { Rng } from '../simulation/rng'

/** Water follows the simulator's depth field. Smoke, flames and rain never decide damage. */
export function HazardEffects() {
  const engine = useSimulationStore(s => s.engine)
  const waterRef = useRef<Mesh>(null), smokeRef = useRef<InstancedMesh>(null), flameRef = useRef<InstancedMesh>(null)
  const rainRef = useRef<LineSegments>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const assets = useMemo(() => {
    if (!engine) return null
    const b = engine.city.meta.bounds
    const water = new PlaneGeometry(b.maxX - b.minX, b.maxZ - b.minZ, 52, 52)
    water.rotateX(-Math.PI / 2); water.translate((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2)
    const waterMaterial = new MeshStandardMaterial({ color: '#537f88', roughness: 0.25, metalness: 0.15, transparent: true, opacity: 0.72, depthWrite: false })
    const smoke = new IcosahedronGeometry(1, 1)
    const smokeMaterial = new MeshLambertMaterial({ color: '#9a9289', transparent: true, opacity: 0.28, depthWrite: false })
    const flame = new ConeGeometry(1, 1, 5)
    const flameMaterial = new MeshLambertMaterial({ color: '#df9849', emissive: '#a63511', emissiveIntensity: 0.65, transparent: true, opacity: 0.85, depthWrite: false })
    const rain = new BufferGeometry()
    rain.setAttribute('position', new BufferAttribute(new Float32Array(1200 * 6), 3))
    const rng = new Rng(engine.seed)
    const rainSeeds = Array.from({ length: 1200 }, () => [rng.range(b.minX, b.maxX), rng.range(0, 100), rng.range(b.minZ, b.maxZ)])
    return { water, waterMaterial, smoke, smokeMaterial, flame, flameMaterial, rain, rainSeeds }
  }, [engine])
  useEffect(() => () => { if (assets) {
    assets.water.dispose(); assets.waterMaterial.dispose(); assets.smoke.dispose(); assets.smokeMaterial.dispose(); assets.flame.dispose(); assets.flameMaterial.dispose(); assets.rain.dispose()
  } }, [assets])
  useFrame(() => {
    if (!engine || !assets || !waterRef.current || !smokeRef.current || !flameRef.current) return
    const active = engine.phase !== 'idle'
    const t = engine.renderTime()
    waterRef.current.visible = active && (engine.disasterType === 'flood' || engine.disasterType === 'tsunami')
    if (waterRef.current.visible) {
      const pos = assets.water.getAttribute('position')
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i), depth = engine.waterDepthAt(x, z)
        pos.setY(i, depth > 0.06 ? depth + Math.sin(x * 0.1 + t * 0.9) * Math.sin(z * 0.08 + t * 0.5) * Math.min(0.09, depth * 0.08) : -0.4)
      }
      pos.needsUpdate = true
      assets.water.computeVertexNormals()
    }
    const hide = (mesh: InstancedMesh, index: number) => { dummy.position.set(0, -1000, 0); dummy.scale.setScalar(0); dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix) }
    for (let i = 0; i < engine.buildings.length; i++) {
      const b = engine.buildings[i], src = b.source
      const dustAge = b.collapseStartTime === null ? 99 : t - b.collapseStartTime
      const dusty = dustAge >= 0 && dustAge < 12
      for (let k = 0; k < 6; k++) {
        const slot = i * 6 + k
        if (!active || (!b.onFire && !dusty)) { hide(smokeRef.current, slot); continue }
        const life = b.onFire ? (t * 0.08 + k / 6 + i * 0.13) % 1 : Math.min(1, dustAge / 12)
        const angle = k * 2.4 + i
        const radius = Math.max(2, Math.min(10, src.footprint.width * 0.12)) * (0.5 + life * 2)
        const spread = (b.onFire ? 4 : src.footprint.width * 0.35) * life
        dummy.position.set(src.position.x + Math.cos(angle) * spread + life * engine.windStrength * 18, (b.onFire ? (b.state === 'collapsed' ? 2 : src.height * 0.65) + life * 35 : 1 + life * 7), src.position.z + Math.sin(angle) * spread)
        dummy.scale.setScalar(radius * (dusty && !b.onFire ? 1 - life : 1)); dummy.rotation.set(0, angle, 0); dummy.updateMatrix(); smokeRef.current.setMatrixAt(slot, dummy.matrix)
      }
      for (let k = 0; k < 3; k++) {
        const slot = i * 3 + k
        if (!active || !b.onFire) { hide(flameRef.current, slot); continue }
        const flicker = 0.75 + 0.25 * Math.sin(t * 8 + i + k * 2)
        const h = Math.min(14, 2 + src.height * 0.35) * flicker
        dummy.position.set(src.position.x + Math.cos(k * 2.1) * src.footprint.width * 0.15, (b.state === 'collapsed' ? 1 : src.height * 0.6) + h / 2, src.position.z + Math.sin(k * 2.1) * src.footprint.depth * 0.15)
        dummy.scale.set(2.5 * flicker, h, 2.5 * flicker); dummy.rotation.set(0, k, engine.windStrength * 0.3); dummy.updateMatrix(); flameRef.current.setMatrixAt(slot, dummy.matrix)
      }
    }
    smokeRef.current.instanceMatrix.needsUpdate = true; flameRef.current.instanceMatrix.needsUpdate = true
    if (rainRef.current) {
      rainRef.current.visible = active && ((engine.disasterType === 'flood' && engine.hazardProgress < 0.8) || engine.windStrength > 0.1)
      if (rainRef.current.visible) {
        const pos = assets.rain.getAttribute('position')
        for (let i = 0; i < assets.rainSeeds.length; i++) {
          const [x, phase, z] = assets.rainSeeds[i], y = ((phase - t * 26) % 100 + 100) % 100
          const wind = engine.windStrength * 9
          pos.setXYZ(i * 2, x + wind * y / 10, y, z)
          pos.setXYZ(i * 2 + 1, x + wind * (y + 6) / 10, y + 6, z)
        }
        pos.needsUpdate = true
      }
    }
  })
  if (!engine || !assets) return null
  return <group>
    <mesh ref={waterRef} geometry={assets.water} material={assets.waterMaterial} visible={false} frustumCulled={false} renderOrder={4} />
    <instancedMesh ref={smokeRef} args={[assets.smoke, assets.smokeMaterial, engine.buildings.length * 6]} frustumCulled={false} renderOrder={5} />
    <instancedMesh ref={flameRef} args={[assets.flame, assets.flameMaterial, engine.buildings.length * 3]} frustumCulled={false} renderOrder={5} />
    <lineSegments ref={rainRef} geometry={assets.rain} visible={false} frustumCulled={false}><lineBasicMaterial color="#c5d7e0" transparent opacity={0.38} depthWrite={false} /></lineSegments>
  </group>
}
