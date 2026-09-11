/**
 * Headless acceptance run.
 *
 * Drives the engine through a full 30-simulation-minute earthquake with no
 * renderer attached and asserts the invariants from §69 / the closing
 * checklist: no NaN, no undefined, no shelter over capacity, no agent stuck
 * mid-road forever, statistics conserved, the run actually terminates.
 *
 *   npx tsx scripts/headless-sim.ts [--seed N] [--runs N] [--quiet]
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { loadCity } from '../src/simulation/CityLoader'
import { SimulationEngine } from '../src/simulation/SimulationEngine'
import { SIM_END_TIME } from '../src/simulation/constants'
import type { Agent, ShelterRuntime } from '../src/types/simulation'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const args = process.argv.slice(2)
function flag(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`)
  if (i < 0 || i + 1 >= args.length) return fallback
  const v = Number(args[i + 1])
  return Number.isFinite(v) ? v : fallback
}
const QUIET = args.includes('--quiet')
const RUNS = flag('runs', 1)

const cityPath = (() => {
  try {
    readFileSync(resolve(root, 'src/data/aoba-city.json'))
    return resolve(root, 'src/data/aoba-city.json')
  } catch {
    return resolve(root, 'src/data/sample-city.json')
  }
})()

const failures: string[] = []
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message)
}

const raw: unknown = JSON.parse(readFileSync(cityPath, 'utf8'))
const { city, issues } = loadCity(raw)

console.log(`city: ${cityPath.replace(root + '/', '')}`)
console.log(
  `  ${city.buildings.length} buildings · ${city.roadNetwork.nodes.length} nodes · ` +
    `${city.roadNetwork.edges.length} edges · ${city.shelters.length} shelters`,
)
const errors = issues.filter((i) => i.severity === 'error')
const warnings = issues.filter((i) => i.severity === 'warning')
console.log(`  load issues: ${errors.length} error(s), ${warnings.length} warning(s)`)
for (const w of warnings.slice(0, 12)) console.log(`    ! ${w.path}: ${w.message}`)
if (warnings.length > 12) console.log(`    ... and ${warnings.length - 12} more`)
check(errors.length === 0, `loader reported ${errors.length} errors`)

// §69 acceptance thresholds on the data itself.
check(city.buildings.length >= 80, `expected >= 80 buildings, got ${city.buildings.length}`)
check(city.shelters.length >= 1, 'expected at least one shelter')
check(city.roadNetwork.edges.length > 0, 'expected road edges')

function finite(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n)
}

function auditAgents(agents: Agent[], label: string): void {
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]
    if (!finite(a.x) || !finite(a.z) || !finite(a.px) || !finite(a.pz)) {
      check(false, `${label}: agent ${i} has a non-finite position`)
      return
    }
    if (!finite(a.movementSpeed) || a.movementSpeed <= 0) {
      check(false, `${label}: agent ${i} has a bad speed ${a.movementSpeed}`)
      return
    }
    if (!finite(a.evacuationStartDelay)) {
      check(false, `${label}: agent ${i} has a bad delay`)
      return
    }
  }
}

function auditShelters(shelters: ShelterRuntime[], label: string): void {
  for (const s of shelters) {
    if (s.occupancy > s.capacity) {
      check(false, `${label}: shelter ${s.id} over capacity (${s.occupancy}/${s.capacity})`)
      return
    }
    if (!finite(s.occupancy) || s.occupancy < 0) {
      check(false, `${label}: shelter ${s.id} occupancy ${s.occupancy}`)
      return
    }
  }
}

interface RunSummary {
  seed: number
  endTime: number
  steps: number
  stats: Record<string, number>
  shelterOccupancy: number[]
  wallMs: number
  maxEdgeAgents: number
  edgeCountSum: number
}

function runOnce(seed: number, label: string): RunSummary {
  const engine = new SimulationEngine(city, seed)

  check(engine.agents.length >= 2000, `${label}: expected >= 2000 agents, got ${engine.agents.length}`)
  auditAgents(engine.agents, `${label} pre`)

  engine.triggerEarthquake()
  engine.setSpeed(16)

  const t0 = Date.now()
  let steps = 0
  // 0.25 real seconds x speed 16 = 4 simulation seconds per advance().
  const REAL_DT = 0.25
  const MAX_STEPS = Math.ceil((SIM_END_TIME / (REAL_DT * 16)) * 1.5) + 200

  let sawShaking = false
  let sawEvacuating = false
  let peakMoving = 0
  let maxEdgeAgents = 0

  while (engine.phase !== 'finished' && steps < MAX_STEPS) {
    engine.advance(REAL_DT)
    steps++
    if (engine.phase === 'shaking') sawShaking = true
    if (engine.phase === 'evacuating') sawEvacuating = true
    const s = engine.getStatistics()
    peakMoving = Math.max(peakMoving, s.moving)

    if (steps % 20 === 0) {
      auditShelters(engine.shelters, `${label} t=${engine.time.toFixed(0)}`)
      for (const r of engine.roads) {
        if (r.agentCount < 0) {
          check(false, `${label}: edge ${r.id} has a negative agentCount (${r.agentCount})`)
          break
        }
        maxEdgeAgents = Math.max(maxEdgeAgents, r.agentCount)
      }
    }
  }
  const wallMs = Date.now() - t0

  check(engine.phase === 'finished', `${label}: run did not finish (phase=${engine.phase}, steps=${steps})`)
  check(sawShaking, `${label}: never entered the shaking phase`)
  check(sawEvacuating || engine.phase === 'finished', `${label}: never entered the evacuating phase`)
  check(peakMoving > 0, `${label}: no agent ever moved`)

  auditAgents(engine.agents, `${label} post`)
  auditShelters(engine.shelters, `${label} post`)

  const stats = engine.getStatistics()
  for (const [k, v] of Object.entries(stats)) {
    check(finite(v), `${label}: statistic ${k} is not finite (${v})`)
  }

  // Conservation: every agent is in exactly one terminal-ish bucket.
  const byState: Record<string, number> = {}
  let edgeCountSum = 0
  for (const a of engine.agents) byState[a.state] = (byState[a.state] ?? 0) + 1
  for (const r of engine.roads) edgeCountSum += r.agentCount

  const total = engine.agents.length
  const summed = Object.values(byState).reduce((s, n) => s + n, 0)
  check(summed === total, `${label}: agent state buckets sum to ${summed}, expected ${total}`)
  // Agents may legitimately still be 'evacuating' when the run ends, in two
  // distinct ways, and only one of them would be a bug:
  //   1. the clock ran out (§50 caps the run at 30 simulation minutes) — people
  //      still walking is then a real and interesting result, not a stall;
  //   2. the engine declared itself settled — in which case nobody may still be
  //      walking toward a shelter that still has room.
  const hitTimeCap = engine.time >= SIM_END_TIME - 1
  const stillOut = byState.evacuating ?? 0
  if (stillOut > 0 && !hitTimeCap) {
    const withRoom = engine.shelters.filter((s) => s.occupancy < s.capacity)
    check(
      withRoom.length === 0,
      `${label}: engine settled with ${stillOut} agents still walking while ${withRoom.length} shelter(s) had room ` +
        `(${withRoom.map((s) => `${s.id} ${s.occupancy}/${s.capacity}`).join(', ')})`,
    )
  }

  const shelteredFromAgents = byState.sheltered ?? 0
  const shelteredFromShelters = engine.shelters.reduce((s, x) => s + x.occupancy, 0)
  check(
    shelteredFromAgents === shelteredFromShelters,
    `${label}: sheltered agents (${shelteredFromAgents}) != shelter occupancy (${shelteredFromShelters})`,
  )
  check(
    stats.sheltered === shelteredFromAgents,
    `${label}: stats.sheltered (${stats.sheltered}) != actual (${shelteredFromAgents})`,
  )
  // Every agent that stopped must have released its edge. When the clock caps
  // the run, agents caught mid-walk are legitimately still on one — but the
  // count must then exactly equal the number still walking, never more.
  if (hitTimeCap) {
    check(
      edgeCountSum <= stillOut,
      `${label}: ${edgeCountSum} agents registered on road edges but only ${stillOut} still walking`,
    )
  } else {
    check(edgeCountSum === 0, `${label}: ${edgeCountSum} agent(s) still registered on road edges`)
  }

  // The simulation has to actually *do* something.
  check(stats.collapsedBuildings > 0, `${label}: no building collapsed`)
  check(stats.blockedRoads > 0, `${label}: no road was blocked`)
  check(stats.sheltered > 0, `${label}: nobody reached a shelter`)
  check(stats.economicLoss > 0, `${label}: no economic loss`)
  check(
    stats.evacuated >= stats.sheltered,
    `${label}: evacuated (${stats.evacuated}) < sheltered (${stats.sheltered})`,
  )

  return {
    seed,
    endTime: engine.time,
    steps,
    stats: stats as unknown as Record<string, number>,
    shelterOccupancy: engine.shelters.map((s) => s.occupancy),
    wallMs,
    maxEdgeAgents,
    edgeCountSum,
  }
}

const baseSeed = flag('seed', city.meta.simulationSeed)
const summaries: RunSummary[] = []
for (let r = 0; r < RUNS; r++) {
  summaries.push(runOnce(baseSeed + r * 7919, `run${r}`))
}

// §27 / §52 — determinism: the same seed must reproduce the run exactly.
const a = runOnce(baseSeed, 'determinism-a')
const b = runOnce(baseSeed, 'determinism-b')
check(
  JSON.stringify(a.stats) === JSON.stringify(b.stats),
  `determinism: identical seeds produced different statistics\n  a=${JSON.stringify(a.stats)}\n  b=${JSON.stringify(b.stats)}`,
)
check(
  JSON.stringify(a.shelterOccupancy) === JSON.stringify(b.shelterOccupancy),
  'determinism: identical seeds produced different shelter occupancy',
)

// reset() must reproduce the same run too.
{
  const engine = new SimulationEngine(city, baseSeed)
  engine.triggerEarthquake()
  engine.setSpeed(16)
  for (let i = 0; i < 40; i++) engine.advance(0.25)
  engine.reset()
  check(engine.phase === 'idle', `reset: phase is ${engine.phase}, expected idle`)
  check(engine.time === 0, `reset: time is ${engine.time}, expected 0`)
  const shelteredAfterReset = engine.shelters.reduce((s, x) => s + x.occupancy, 0)
  check(shelteredAfterReset === 0, `reset: shelters still hold ${shelteredAfterReset} people`)
  const inside = engine.agents.filter((x) => x.state === 'inside').length
  check(inside === engine.agents.length, `reset: only ${inside}/${engine.agents.length} agents are inside`)

  engine.triggerEarthquake()
  engine.setSpeed(16)
  let steps = 0
  while (engine.phase !== 'finished' && steps < 1200) {
    engine.advance(0.25)
    steps++
  }
  check(
    JSON.stringify(engine.getStatistics()) === JSON.stringify(a.stats),
    `reset: replay after reset diverged\n  fresh=${JSON.stringify(a.stats)}\n  reset=${JSON.stringify(engine.getStatistics())}`,
  )
}

if (!QUIET) {
  for (const s of summaries) {
    const st = s.stats
    console.log(`\nrun seed=${s.seed}  ended at ${(s.endTime / 60).toFixed(1)} sim-min  (${s.wallMs} ms wall)`)
    console.log(
      `  evacuated ${st.evacuated}  sheltered ${st.sheltered}  inside ${st.stillInside}  ` +
        `trapped ${st.trapped}  injured ${st.injured}  fatalities ${st.fatalities}`,
    )
    console.log(
      `  collapsed ${st.collapsedBuildings}/${st.totalBuildings}  damaged ${st.damagedBuildings}  ` +
        `blocked roads ${st.blockedRoads}/${st.totalRoads} (${(st.roadBlockageRatio * 100).toFixed(1)}%)  ` +
        `fires ${st.buildingsOnFire}`,
    )
    console.log(`  economic loss ¥${(st.economicLoss / 1e9).toFixed(1)}B   peak agents on one edge ${s.maxEdgeAgents}`)
    console.log(`  shelters: ${s.shelterOccupancy.join(', ')}`)
  }
}

console.log('')
if (failures.length === 0) {
  console.log(`PASS — ${RUNS} run(s) + determinism + reset, all invariants held.`)
} else {
  console.log(`FAIL — ${failures.length} problem(s):`)
  for (const f of failures) console.log(`  x ${f}`)
  process.exitCode = 1
}
