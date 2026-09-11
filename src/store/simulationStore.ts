/**
 * The only React-visible slice of the simulation.
 *
 * The `SimulationEngine` reference lives here but is never treated as reactive
 * data — it is mutated in place at 60 Hz and read through refs by the renderer.
 * Only `snapshot` (a handful of numbers) is diffed and pushed into React, at
 * around 5 Hz, so the HUD re-renders a few times per second instead of every
 * frame.
 */

import { create } from 'zustand'

import type { CityLoadResult, CityValidationIssue, DisasterScenario } from '../types/city'
import type { Selection, SimulationSnapshot } from '../types/simulation'
import { EMPTY_STATISTICS } from '../types/simulation'
import { SimulationEngine } from '../simulation/SimulationEngine'
import { loadCity } from '../simulation/CityLoader'
import { SPEED_STEPS } from '../simulation/constants'

/**
 * `tsconfig.app.json` does not enable `resolveJsonModule`, so the city files
 * come in as text through Vite's `?raw` suffix (typed by `vite/client`) and are
 * parsed here.
 *
 * `import.meta.glob` rather than a bare `import('../data/aoba-city.json?raw')`:
 * a direct dynamic import of a file that is not on disk fails the *build*, so
 * the runtime fallback below would never get a chance to run. A glob simply
 * omits the missing key, which keeps `aoba-city.json` genuinely optional.
 * Loaders are lazy — only the file actually chosen is fetched.
 */
const CITY_SOURCES = import.meta.glob<string>('../data/*.json', {
  query: '?raw',
  import: 'default',
})

const PRIMARY_CITY = '../data/aoba-city.json'
const FALLBACK_CITY = '../data/sample-city.json'

const SPEED_VALUES: readonly number[] = SPEED_STEPS

type StoreSetter = (partial: Partial<SimulationStore>) => void

export interface SimulationStore {
  engine: SimulationEngine | null
  status: 'loading' | 'ready' | 'error'
  errorMessage: string | null
  loadIssues: CityValidationIssue[]
  snapshot: SimulationSnapshot
  selection: Selection
  debug: boolean

  initialise(): Promise<void>
  pushSnapshot(s: SimulationSnapshot): void
  setSelection(s: Selection): void
  toggleDebug(): void
  triggerEarthquake(): void
  triggerDisaster(type: DisasterScenario['type']): void
  togglePause(): void
  cycleSpeed(): void
  reset(): void
}

function idleSnapshot(): SimulationSnapshot {
  return {
    phase: 'idle',
    disasterType: 'earthquake',
    time: 0,
    speed: SPEED_VALUES.length > 0 ? SPEED_VALUES[0] : 1,
    paused: false,
    stats: { ...EMPTY_STATISTICS },
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'unknown error'
}

/**
 * `CityLoadError` carries `issues`. Read them structurally rather than with an
 * `instanceof` check so a plain `Error` from `JSON.parse` is handled the same.
 */
function issuesOf(error: unknown): CityValidationIssue[] {
  if (typeof error !== 'object' || error === null) return []
  const raw = (error as { issues?: unknown }).issues
  if (!Array.isArray(raw)) return []
  const out: CityValidationIssue[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i]
    if (typeof entry !== 'object' || entry === null) continue
    const issue = entry as { severity?: unknown; path?: unknown; message?: unknown }
    out.push({
      severity: issue.severity === 'error' ? 'error' : 'warning',
      path: typeof issue.path === 'string' ? issue.path : 'city',
      message: typeof issue.message === 'string' ? issue.message : 'invalid city data',
    })
  }
  return out
}

async function readCityJson(path: string): Promise<unknown> {
  const loader = CITY_SOURCES[path]
  if (typeof loader !== 'function') throw new Error(`${path} is not part of the bundle`)
  const text = await loader()
  if (typeof text !== 'string' || text.length === 0) throw new Error(`${path} is empty`)
  return JSON.parse(text) as unknown
}

async function loadCityModel(set: StoreSetter): Promise<void> {
  const issues: CityValidationIssue[] = []
  let primary: CityLoadResult | null = null

  let primaryRaw: unknown = null
  let havePrimaryRaw = false
  try {
    primaryRaw = await readCityJson(PRIMARY_CITY)
    havePrimaryRaw = true
  } catch (error) {
    const message = describeError(error)
    console.warn(`[city] aoba-city.json could not be read (${message}); using sample-city.json`)
    issues.push({
      severity: 'warning',
      path: 'data/aoba-city.json',
      message: `Could not be read (${message}); fell back to sample-city.json.`,
    })
  }

  if (havePrimaryRaw) {
    try {
      primary = loadCity(primaryRaw)
    } catch (error) {
      const message = describeError(error)
      console.warn(`[city] aoba-city.json failed validation (${message}); using sample-city.json`)
      issues.push({
        severity: 'warning',
        path: 'data/aoba-city.json',
        message: `Failed validation (${message}); fell back to sample-city.json.`,
      })
      for (const issue of issuesOf(error)) issues.push(issue)
    }
  }

  let result: CityLoadResult
  if (primary !== null) {
    result = primary
  } else {
    try {
      result = loadCity(await readCityJson(FALLBACK_CITY))
    } catch (error) {
      const message = describeError(error)
      const fatal = issuesOf(error)
      fatal.push({
        severity: 'error',
        path: 'data/sample-city.json',
        message,
      })
      set({
        engine: null,
        status: 'error',
        errorMessage: `No city data could be loaded: ${message}`,
        loadIssues: issues.concat(fatal),
      })
      return
    }
  }

  if (Array.isArray(result.issues)) {
    for (const issue of result.issues) issues.push(issue)
  }

  try {
    const engine = new SimulationEngine(result.city, result.city.meta.simulationSeed)
    set({
      engine,
      status: 'ready',
      errorMessage: null,
      loadIssues: issues,
      snapshot: engine.snapshot(),
      selection: null,
    })
  } catch (error) {
    const message = describeError(error)
    set({
      engine: null,
      status: 'error',
      errorMessage: `Simulation setup failed: ${message}`,
      loadIssues: issues,
    })
  }
}

/** Field-by-field diff — `time` only at 0.1 s resolution, which is all the HUD shows. */
function snapshotsEqual(a: SimulationSnapshot, b: SimulationSnapshot): boolean {
  if (a === b) return true
  if (a.phase !== b.phase || a.disasterType !== b.disasterType) return false
  if (a.speed !== b.speed) return false
  if (a.paused !== b.paused) return false
  if (Math.round(a.time * 10) !== Math.round(b.time * 10)) return false

  const x = a.stats
  const y = b.stats
  if (x === y) return true
  return (
    x.evacuated === y.evacuated &&
    x.sheltered === y.sheltered &&
    x.stillInside === y.stillInside &&
    x.moving === y.moving &&
    x.trapped === y.trapped &&
    x.injured === y.injured &&
    x.fatalities === y.fatalities &&
    x.collapsedBuildings === y.collapsedBuildings &&
    x.damagedBuildings === y.damagedBuildings &&
    x.minorBuildings === y.minorBuildings &&
    x.majorBuildings === y.majorBuildings &&
    x.severeBuildings === y.severeBuildings &&
    x.floodedBuildings === y.floodedBuildings &&
    x.totalBuildings === y.totalBuildings &&
    x.blockedRoads === y.blockedRoads &&
    x.totalRoads === y.totalRoads &&
    x.roadBlockageRatio === y.roadBlockageRatio &&
    x.economicLoss === y.economicLoss &&
    x.buildingsOnFire === y.buildingsOnFire
  )
}

/**
 * Module-level so React StrictMode's double effect invocation (and any second
 * component that calls `initialise`) share one load instead of racing.
 */
let initialisePromise: Promise<void> | null = null

export const useSimulationStore = create<SimulationStore>()((set, get) => ({
  engine: null,
  status: 'loading',
  errorMessage: null,
  loadIssues: [],
  snapshot: idleSnapshot(),
  selection: null,
  debug: false,

  initialise: () => {
    if (initialisePromise) return initialisePromise
    initialisePromise = loadCityModel((partial) => {
      set(partial)
    }).catch((error: unknown) => {
      set({
        engine: null,
        status: 'error',
        errorMessage: `Initialisation failed: ${describeError(error)}`,
      })
    })
    return initialisePromise
  },

  pushSnapshot: (s) => {
    if (snapshotsEqual(get().snapshot, s)) return
    set({ snapshot: s })
  },

  setSelection: (s) => {
    set({ selection: s })
  },

  toggleDebug: () => {
    set({ debug: !get().debug })
  },

  triggerDisaster: (type) => {
    const engine = get().engine
    if (!engine) return
    engine.triggerDisaster(type)
    set({ snapshot: engine.snapshot() })
  },

  triggerEarthquake: () => {
    const engine = get().engine
    if (!engine) return
    engine.triggerEarthquake()
    set({ snapshot: engine.snapshot() })
  },

  togglePause: () => {
    const engine = get().engine
    if (!engine) return
    engine.togglePause()
    set({ snapshot: engine.snapshot() })
  },

  cycleSpeed: () => {
    const engine = get().engine
    if (!engine || SPEED_VALUES.length === 0) return
    const current = SPEED_VALUES.indexOf(engine.speed)
    const next = SPEED_VALUES[(current + 1) % SPEED_VALUES.length]
    engine.setSpeed(next)
    set({ snapshot: engine.snapshot() })
  },

  reset: () => {
    const engine = get().engine
    if (!engine) return
    engine.reset()
    set({ snapshot: engine.snapshot(), selection: null })
  },
}))
