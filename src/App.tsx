/**
 * Application shell: one <Canvas> holding the city, and the DOM overlays
 * (HUD + result panel) as siblings outside it. The city is the UI (§1).
 */

import { Suspense, useEffect } from 'react'
import type { JSX } from 'react'
import { Canvas } from '@react-three/fiber'
import { PCFShadowMap } from 'three'
import { CityScene } from './components/CityScene'
import { ResultDisplay } from './components/ResultDisplay'
import { SimulationHUD } from './components/SimulationHUD'
import { CAMERA_INITIAL } from './simulation/constants'
import { useSimulationStore } from './store/simulationStore'
import './index.css'

/**
 * Spherical → cartesian, Three.js convention (polar measured from +Y, azimuth
 * around +Y starting at +Z). CityScene re-frames on the real city centre once
 * the engine exists; this is the starting pose around the origin.
 */
function initialCameraPosition(): [number, number, number] {
  const distance = Number.isFinite(CAMERA_INITIAL.distance) ? CAMERA_INITIAL.distance : 620
  const polar = Number.isFinite(CAMERA_INITIAL.polar) ? CAMERA_INITIAL.polar : 0.92
  const azimuth = Number.isFinite(CAMERA_INITIAL.azimuth) ? CAMERA_INITIAL.azimuth : 0.7
  const horizontal = distance * Math.sin(polar)
  return [
    horizontal * Math.sin(azimuth),
    distance * Math.cos(polar),
    horizontal * Math.cos(azimuth),
  ]
}

const CAMERA_POSITION = initialCameraPosition()

export default function App(): JSX.Element {
  const initialise = useSimulationStore((s) => s.initialise)
  const setSelection = useSimulationStore((s) => s.setSelection)
  const status = useSimulationStore((s) => s.status)
  const errorMessage = useSimulationStore((s) => s.errorMessage)

  useEffect(() => {
    void initialise()
  }, [initialise])

  if (status === 'error') {
    return (
      <div className="app">
        <div className="fatal">
          <div className="boot-title">AOBA CITY</div>
          <div className="boot-sub">{errorMessage ?? 'city data could not be loaded'}</div>
        </div>
      </div>
    )
  }

  if (status !== 'ready') {
    return (
      <div className="app">
        <div className="boot">
          <div className="boot-title">AOBA CITY</div>
          <div className="boot-sub">loading</div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <Canvas
        shadows={{ type: PCFShadowMap }}
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ fov: 42, near: 1, far: 6000, position: CAMERA_POSITION }}
        onPointerMissed={() => setSelection(null)}
      >
        <Suspense fallback={null}>
          <CityScene />
        </Suspense>
      </Canvas>
      <SimulationHUD />
      <ResultDisplay />
    </div>
  )
}
