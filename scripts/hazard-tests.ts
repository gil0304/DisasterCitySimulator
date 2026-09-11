import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadCity } from '../src/simulation/CityLoader'
import { SimulationEngine } from '../src/simulation/SimulationEngine'
import { TrafficSimulator } from '../src/simulation/TrafficSimulator'
import { createBuildingGeometry, createDamagedGeometry, createRubbleGeometry } from '../src/components/buildingGeometry'
import type { DisasterType } from '../src/simulation/EnvironmentalDisaster'

const { city, issues } = loadCity(JSON.parse(readFileSync(new URL('../src/data/aoba-city.json', import.meta.url), 'utf8')))
assert.equal(issues.filter(i => i.severity === 'error').length, 0)
const seed = city.meta.simulationSeed
const types: DisasterType[] = ['earthquake', 'flood', 'tsunami', 'fire', 'typhoon']

function audit(engine: SimulationEngine) {
  for (const b of engine.buildings) {
    assert.ok(Number.isFinite(b.damageScore) && b.damageScore >= 0 && b.damageScore <= 1)
    assert.ok(Number.isFinite(b.waterDepth) && b.waterDepth >= 0)
  }
  for (const r of engine.roads) {
    assert.ok(r.agentCount >= 0 && Number.isFinite(r.waterDepth))
    if (r.hazardBlocked) assert.ok(r.blocked, 'hazardous road was reopened')
  }
  for (const s of engine.shelters) {
    assert.ok(s.occupancy >= 0 && s.occupancy <= s.capacity, 'shelter overflow')
    assert.equal(s.occupancy, engine.agents.filter(a => a.state === 'sheltered' && a.targetShelterIndex === s.index).length)
    if (s.unsafe) assert.equal(s.occupancy, 0, 'unsafe shelter retained occupants')
  }
  for (const a of engine.agents) assert.ok(Number.isFinite(a.x) && Number.isFinite(a.z))
  for (const value of Object.values(engine.getStatistics())) assert.ok(Number.isFinite(value))
  assert.equal(engine.agents.length, 3000)
}

function finish(engine: SimulationEngine, type: DisasterType) {
  engine.triggerDisaster(type)
  engine.setSpeed(16)
  let peakWater = 0, peakBurning = 0, peakUnsafe = 0, peakBlocked = 0, peakWind = 0
  const previousDamage = engine.buildings.map(() => 0)
  for (let i = 0; i < 500 && engine.phase !== 'finished'; i++) {
    engine.advance(0.25)
    peakWater = Math.max(peakWater, ...engine.buildings.map(b => b.waterDepth))
    peakBurning = Math.max(peakBurning, engine.buildings.filter(b => b.onFire).length)
    peakUnsafe = Math.max(peakUnsafe, engine.shelters.filter(s => s.unsafe).length)
    peakBlocked = Math.max(peakBlocked, engine.roads.filter(r => r.hazardBlocked).length)
    peakWind = Math.max(peakWind, engine.windStrength)
    for (const b of engine.buildings) {
      assert.ok(b.damageScore + 1e-9 >= previousDamage[b.index], `${type}: damage healed during disaster`)
      previousDamage[b.index] = b.damageScore
    }
    if (i % 20 === 0) audit(engine)
    if (i === 25) {
      const before = JSON.stringify(engine.snapshot())
      const positions = engine.agents.map(a => [a.x, a.z])
      engine.togglePause(); engine.advance(0.25); engine.togglePause()
      assert.equal(JSON.stringify(engine.snapshot()), before, `${type}: pause advanced time`)
      assert.deepEqual(engine.agents.map(a => [a.x, a.z]), positions)
    }
  }
  assert.equal(engine.phase, 'finished', `${type}: did not terminate`)
  audit(engine)
  if (type === 'flood' || type === 'tsunami') {
    assert.ok(peakWater > 2 && peakBlocked > 0 && peakUnsafe > 0, `${type}: missing water/closure/refuge interaction`)
    assert.equal(engine.waterDepthAt(500, 950), 0, 'water did not recede')
  }
  if (type === 'fire') assert.ok(peakBurning > 3, 'fire never spread beyond ignition buildings')
  if (type === 'typhoon') assert.ok(peakWind > 0.9)
  const stats = { ...engine.getStatistics() }
  assert.ok(stats.majorBuildings + stats.severeBuildings > 0, `${type}: no partially damaged buildings remain`)
  return {
    stats, states: engine.buildings.map(b => [b.state, b.damageScore]),
    agents: engine.agents.map(a => [a.state, a.x, a.z, a.targetShelterIndex]),
    vehicles: engine.traffic.vehicles.map(v => [v.x, v.z, v.edge, v.speed, v.reroutes]),
    peakWater: +peakWater.toFixed(2), peakBurning, peakUnsafe, peakBlocked,
  }
}

for (const type of types) {
  const engine = new SimulationEngine(city, seed)
  const first = finish(engine, type)
  engine.reset()
  assert.ok(engine.buildings.every(b => b.state === 'intact' && !b.onFire && b.waterDepth === 0))
  assert.ok(engine.roads.every(r => !r.blocked && !r.hazardBlocked && r.waterDepth === 0 && r.agentCount === 0))
  assert.ok(engine.shelters.every(s => !s.unsafe && s.occupancy === 0))
  assert.equal(engine.time, 0)
  assert.deepEqual(finish(engine, type), first, `${type}: reset replay differs`)
  const { stats: s, peakWater, peakBurning, peakUnsafe, peakBlocked } = first
  console.log(`${type}: minor=${s.minorBuildings}, major=${s.majorBuildings}, severe=${s.severeBuildings}, collapsed=${s.collapsedBuildings}, peak water=${peakWater}m, burning=${peakBurning}, unsafe refuges=${peakUnsafe}, hazard closures=${peakBlocked}`)
}

// Every building archetype must survive clipping without NaNs or missing attributes.
for (const b of city.buildings) {
  const intact = createBuildingGeometry(b, seed)
  for (const stage of ['minor', 'major', 'severe'] as const) {
    const result = createDamagedGeometry(b, intact, stage, seed)
    const p = result.geometry.getAttribute('position')
    assert.ok(p.count > 0)
    assert.equal(result.geometry.getAttribute('color').count, p.count)
    assert.equal(result.geometry.getAttribute('normal').count, p.count)
    assert.ok(Array.from(p.array).every(Number.isFinite), `${b.id}/${stage}: non-finite geometry`)
    result.geometry.dispose()
  }
  const rubble = createRubbleGeometry(b, seed)
  assert.ok(Array.from(rubble.getAttribute('position').array).every(Number.isFinite))
  rubble.dispose()
  intact.geometry.dispose()
}

const engine = new SimulationEngine(city, seed)
const traffic = new TrafficSimulator(city, seed)
const env = { roads: engine.roads, emergency: false, earthquake: false, disasterTime: 0, waterDepthAt: () => 0 }
const initial = traffic.vehicles.map(v => [v.x, v.z])
for (let i = 0; i < 600; i++) traffic.advance(0.1, env)
assert.ok(traffic.vehicles.some((v, i) => Math.hypot(v.x - initial[i][0], v.z - initial[i][1]) > 20), 'idle traffic never moved')
assert.ok(traffic.vehicles.every(v => Number.isFinite(v.x) && Number.isFinite(v.z)))
env.emergency = true; env.earthquake = true
traffic.advance(0.2, env)
assert.ok(traffic.vehicles.every(v => v.stopped && v.speed === 0), 'cars failed to stop during shock')
traffic.reset()
assert.deepEqual(traffic.vehicles.map(v => [v.x, v.z]), initial)
env.emergency = false; env.earthquake = false
const lead = traffic.vehicles[0]
engine.roads[lead.edge].blocked = true
const stoppedAt = [lead.x, lead.z]
traffic.advance(4, env)
assert.deepEqual([lead.x, lead.z], stoppedAt, 'vehicle drove through blocked road')
console.log(`PASS: 5 hazards, deterministic reset/pause, population/capacity, 270 damage geometries, ${traffic.vehicles.length} vehicles`)
