import { useEffect, useMemo } from 'react'
import { BoxGeometry, BufferAttribute, Color, MeshLambertMaterial } from 'three'
import type { BufferGeometry } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { useSimulationStore } from '../store/simulationStore'
import { buildParcelGeometries } from './streetParcelGeometry'

/** Street-scale cues are baked into one mesh, derived from real graph junctions and parcels. */
export function StreetDetails() {
  const engine = useSimulationStore(s => s.engine)
  const assets = useMemo(() => {
    if (!engine) return null
    const city = engine.city, parts: BufferGeometry[] = []
    const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: string, yaw = 0) => {
      const geometry = new BoxGeometry(w, h, d)
      geometry.rotateY(yaw); geometry.translate(x, y, z)
      const c = new Color(color), colors = new Float32Array(geometry.getAttribute('position').count * 3)
      for (let i = 0; i < colors.length; i += 3) { colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b }
      geometry.setAttribute('color', new BufferAttribute(colors, 3)); parts.push(geometry)
    }
    const nodes = new Map(city.roadNetwork.nodes.map(n => [n.id, n]))
    for (const edge of city.roadNetwork.edges) {
      const a = nodes.get(edge.from), b = nodes.get(edge.to)
      if (!a || !b) continue
      const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z, len = Math.hypot(dx, dz)
      if (len < 24) continue
      const ux = dx / len, uz = dz / len, nx = -uz, nz = ux, yaw = Math.atan2(ux, uz)
      if (edge.width >= 12) for (let t = 16; t < len - 14; t += 9) box(a.position.x + ux * t, 0.085, a.position.z + uz * t, 0.18, 0.03, 4.5, '#e7e2cb', yaw)
      if (edge.width < 7) continue
      for (const [node, sign] of [[a, 1], [b, -1]] as const) {
        if (node.kind !== 'intersection') continue
        const t = Math.max(11, edge.width / 2 + 4)
        const cx = node.position.x + ux * t * sign, cz = node.position.z + uz * t * sign
        for (let offset = -edge.width / 2 + 0.8; offset < edge.width / 2 - 0.6; offset += 1.3)
          box(cx + nx * offset, 0.092, cz + nz * offset, 0.65, 0.035, 3.3, '#e4e1d6', yaw)
        // Signal housing, roadside pole, and a pedestrian crossing marker.
        const side = edge.width / 2 + 1.4
        box(cx + nx * side, 2.7, cz + nz * side, 0.13, 5.4, 0.13, '#7a8383')
        box(cx + nx * side, 5.35, cz + nz * side, 1.5, 0.55, 0.45, '#4b5357', yaw)
      }
    }
    parts.push(...buildParcelGeometries(city))
    if (!parts.length) return null
    const geometry = mergeGeometries(parts)!
    for (const p of parts) p.dispose()
    return { geometry, material: new MeshLambertMaterial({ vertexColors: true }) }
  }, [engine])
  useEffect(() => () => { assets?.geometry.dispose(); assets?.material.dispose() }, [assets])
  return assets ? <mesh geometry={assets.geometry} material={assets.material} receiveShadow /> : null
}
