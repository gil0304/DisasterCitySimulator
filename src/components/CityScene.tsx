/**
 * The whole 3D world: sky, lights, camera controls and every world component.
 *
 * This is also the *only* place the simulation is advanced (§45) — one
 * `engine.advance(delta)` per rendered frame, at a negative render priority so
 * every other `useFrame` in the tree sees fresh state in the same frame.
 */

import { useEffect, useMemo, useRef } from 'react'
import type { ComponentRef, JSX } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Sky } from '@react-three/drei'
import { Color, MOUSE, Vector3 } from 'three'
import type { DirectionalLight } from 'three'
import {
  CAMERA_INITIAL,
  CAMERA_MAX_DISTANCE,
  CAMERA_MIN_DISTANCE,
} from '../simulation/constants'
import type { SimulationEngine } from '../simulation/SimulationEngine'
import { useSimulationStore } from '../store/simulationStore'
import { Agents } from './Agents'
import { Buildings } from './Buildings'
import { Ground } from './Ground'
import { Roads } from './Roads'
import { Shelters } from './Shelters'
import { Vehicles } from './Vehicles'
import { HazardEffects } from './HazardEffects'
import { StreetDetails } from './StreetDetails'

/** Sun offset from the city centre, metres (§60). */
const SUN_OFFSET_X = 400
const SUN_OFFSET_Y = 700
const SUN_OFFSET_Z = 300
const SUN_DISTANCE = Math.hypot(SUN_OFFSET_X, SUN_OFFSET_Y, SUN_OFFSET_Z)
const SUN_DIRECTION = new Vector3(SUN_OFFSET_X, SUN_OFFSET_Y, SUN_OFFSET_Z).normalize()

const SKY_COLOR = '#c3d5e2'
const FOG_COLOR = '#c9d8e3'
const HEMI_SKY = '#d8e6f0'
const HEMI_GROUND = '#8d8a80'

/** Largest half-extent the shadow camera is allowed to cover, metres (§61). */
const MAX_SHADOW_HALF_EXTENT = 600
const SHADOW_MAP_SIZE = 2048

/** §30 — the camera wobble is deliberately almost imperceptible. */
const MAX_CAMERA_SHAKE = 0.15

/** Store push rate, seconds (5 Hz). */
const SNAPSHOT_INTERVAL = 0.2

const MOUSE_BUTTONS = {
  LEFT: MOUSE.ROTATE,
  MIDDLE: MOUSE.DOLLY,
  RIGHT: MOUSE.PAN,
}

const SHAKE_OFFSET = new Vector3()

type OrbitControlsRef = ComponentRef<typeof OrbitControls>

interface SceneFrame {
  centerX: number
  centerZ: number
  shadowHalfExtent: number
  fogNear: number
  fogFar: number
  skyDistance: number
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function measureCity(engine: SimulationEngine | null): SceneFrame {
  const bounds = engine?.city?.meta?.bounds
  const minX = finiteOr(bounds?.minX, -400)
  const maxX = finiteOr(bounds?.maxX, 400)
  const minZ = finiteOr(bounds?.minZ, -400)
  const maxZ = finiteOr(bounds?.maxZ, 400)

  const centerX = (minX + maxX) / 2
  const centerZ = (minZ + maxZ) / 2
  const extent = Math.max(Math.abs(maxX - minX), Math.abs(maxZ - minZ), 200)

  // Cover the city with a little slack, but never let the shadow map spread so
  // thin that individual buildings stop casting a readable shadow.
  const shadowHalfExtent = Math.min(extent * 0.55 + 40, MAX_SHADOW_HALF_EXTENT)

  // Fog starts well beyond the far corner of the city so it only softens the
  // horizon, never the city itself.
  const fogNear = extent * 1.2 + 900
  return {
    centerX,
    centerZ,
    shadowHalfExtent,
    fogNear,
    fogFar: fogNear + 3200,
    skyDistance: 4000,
  }
}

export function CityScene(): JSX.Element {
  const engine = useSimulationStore((s) => s.engine)
  const pushSnapshot = useSimulationStore((s) => s.pushSnapshot)

  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)

  const controlsRef = useRef<OrbitControlsRef>(null)
  const clearSky = useMemo(() => new Color(SKY_COLOR), [])
  const stormSky = useMemo(() => new Color('#899aa5'), [])
  const lightRef = useRef<DirectionalLight | null>(null)
  const snapshotAccumulator = useRef(0)
  const appliedShake = useRef(new Vector3())
  const framedEngine = useRef<SimulationEngine | null>(null)

  const frame = useMemo(() => measureCity(engine), [engine])

  // The directional light aims at the city centre, and its shadow frustum is
  // sized to the city rather than to the default 10 m box.
  useEffect(() => {
    const light = lightRef.current
    if (!light) return

    light.target.position.set(frame.centerX, 0, frame.centerZ)
    light.target.updateMatrixWorld()
    scene.add(light.target)

    const shadowCamera = light.shadow.camera
    shadowCamera.left = -frame.shadowHalfExtent
    shadowCamera.right = frame.shadowHalfExtent
    shadowCamera.top = frame.shadowHalfExtent
    shadowCamera.bottom = -frame.shadowHalfExtent
    shadowCamera.near = 40
    shadowCamera.far = SUN_DISTANCE + frame.shadowHalfExtent * 2.2 + 400
    shadowCamera.updateProjectionMatrix()
    light.shadow.bias = -0.0004
    light.shadow.normalBias = 1.1

    return () => {
      scene.remove(light.target)
    }
  }, [frame, scene])

  // Frame the city once per engine instance (§8). Done imperatively so the user
  // keeps whatever view they orbit to afterwards.
  useEffect(() => {
    if (!engine || framedEngine.current === engine) return
    framedEngine.current = engine

    const distance = finiteOr(CAMERA_INITIAL.distance, 620)
    const polar = finiteOr(CAMERA_INITIAL.polar, 0.92)
    const azimuth = finiteOr(CAMERA_INITIAL.azimuth, 0.7)
    const horizontal = distance * Math.sin(polar)

    camera.position.set(
      frame.centerX + horizontal * Math.sin(azimuth),
      distance * Math.cos(polar),
      frame.centerZ + horizontal * Math.cos(azimuth),
    )

    const controls = controlsRef.current
    if (controls) {
      controls.target.set(frame.centerX, 0, frame.centerZ)
      appliedShake.current.set(0, 0, 0)
      controls.update()
    } else {
      camera.lookAt(frame.centerX, 0, frame.centerZ)
      camera.updateMatrixWorld()
    }
  }, [engine, frame, camera])

  // Priority -2: runs before drei's OrbitControls (-1) and before every
  // world component (0), so the shake and the new sim state land in this frame.
  useFrame((state, delta) => {
    if (!engine) return

    const step = Number.isFinite(delta) ? Math.max(0, Math.min(delta, 0.25)) : 0
    engine.advance(step)
    const storm = engine.phase === 'idle' ? 0 : engine.windStrength
    if (lightRef.current) lightRef.current.intensity = 1.85 - storm * 1.1
    if (scene.background instanceof Color) scene.background.copy(clearSky).lerp(stormSky, storm)

    snapshotAccumulator.current += step
    if (snapshotAccumulator.current >= SNAPSHOT_INTERVAL) {
      snapshotAccumulator.current = 0
      pushSnapshot(engine.snapshot())
    }

    const controls = controlsRef.current
    if (!controls) return
    if (engine.paused) return

    let envelope = engine.shakeEnvelope()
    if (!Number.isFinite(envelope)) envelope = 0
    else if (envelope < 0) envelope = 0
    else if (envelope > 1) envelope = 1

    // Driven by wall-clock time, not sim time: at 16x the sim clock would alias
    // the oscillation into visible strobing.
    const t = state.clock.elapsedTime
    const amplitude = envelope * MAX_CAMERA_SHAKE
    SHAKE_OFFSET.set(
      Math.sin(t * 14.3) * amplitude,
      Math.sin(t * 11.7 + 1.4) * amplitude * 0.6,
      Math.cos(t * 12.9 + 0.7) * amplitude,
    )

    // Apply as a delta so user panning is never overwritten.
    controls.target.add(SHAKE_OFFSET).sub(appliedShake.current)
    appliedShake.current.copy(SHAKE_OFFSET)
  }, -2)

  return (
    <>
      <color attach="background" args={[SKY_COLOR]} />
      <fog attach="fog" args={[FOG_COLOR, frame.fogNear, frame.fogFar]} />

      <group position={[frame.centerX, 0, frame.centerZ]}>
        <Sky
          distance={frame.skyDistance}
          sunPosition={SUN_DIRECTION}
          turbidity={5}
          rayleigh={0.35}
          mieCoefficient={0.006}
          mieDirectionalG={0.85}
        />
      </group>

      <ambientLight intensity={0.42} />
      <hemisphereLight args={[HEMI_SKY, HEMI_GROUND, 0.28]} />
      <directionalLight
        ref={lightRef}
        position={[
          frame.centerX + SUN_OFFSET_X,
          SUN_OFFSET_Y,
          frame.centerZ + SUN_OFFSET_Z,
        ]}
        intensity={1.85}
        castShadow
        shadow-mapSize-width={SHADOW_MAP_SIZE}
        shadow-mapSize-height={SHADOW_MAP_SIZE}
      />

      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        screenSpacePanning={false}
        minDistance={CAMERA_MIN_DISTANCE}
        maxDistance={CAMERA_MAX_DISTANCE}
        minPolarAngle={0.08}
        maxPolarAngle={1.35}
        rotateSpeed={0.55}
        panSpeed={0.9}
        zoomSpeed={0.9}
        mouseButtons={MOUSE_BUTTONS}
      />

      <Ground />
      <Roads />
      <StreetDetails />
      <Buildings />
      <Shelters />
      <Agents />
      <Vehicles />
      <HazardEffects />
    </>
  )
}
