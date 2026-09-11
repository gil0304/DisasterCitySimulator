/**
 * Aggregate counters for the HUD and the result screen.
 *
 * One pass over each runtime array, straight into a reused `Statistics`
 * object — this runs several times per second and must never allocate.
 */

import type {
  Agent,
  BuildingRuntime,
  RoadRuntime,
  ShelterRuntime,
  Statistics,
} from '../types/simulation'

/** Fills and returns `out` (allocate one Statistics object and reuse it). */
export function computeStatistics(
  buildings: BuildingRuntime[],
  roads: RoadRuntime[],
  shelters: ShelterRuntime[],
  agents: Agent[],
  out: Statistics,
): Statistics {
  let evacuated = 0
  let shelteredAgents = 0
  let stillInside = 0
  let moving = 0
  let trapped = 0
  let injured = 0
  let fatalities = 0

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]
    if (a === undefined) continue
    if (a.hasLeftBuilding) evacuated++
    switch (a.state) {
      case 'inside':
        stillInside++
        break
      case 'evacuating':
        moving++
        break
      case 'sheltered':
        shelteredAgents++
        break
      case 'trapped':
        trapped++
        break
      case 'injured':
        injured++
        break
      case 'dead':
        fatalities++
        break
    }
  }

  // Shelter occupancy is the capacity-enforced source of truth; the agent-state
  // tally is the same number unless something upstream diverged.
  let shelterOccupancy = 0
  for (let i = 0; i < shelters.length; i++) {
    const s = shelters[i]
    if (s === undefined) continue
    const o = s.occupancy
    if (Number.isFinite(o) && o > 0) shelterOccupancy += o
  }

  let collapsedBuildings = 0
  let damagedBuildings = 0
  let minorBuildings = 0, majorBuildings = 0, severeBuildings = 0, floodedBuildings = 0
  let buildingsOnFire = 0
  let economicLoss = 0
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i]
    if (b === undefined) continue
    if (b.state !== 'intact') damagedBuildings++
    if (b.state === 'minor') minorBuildings++
    if (b.state === 'major') majorBuildings++
    if (b.state === 'severe') severeBuildings++
    if (b.waterDepth > 0.1) floodedBuildings++
    if (b.state === 'collapsed') collapsedBuildings++
    if (b.onFire) buildingsOnFire++
    const loss = b.economicLoss
    if (Number.isFinite(loss) && loss > 0) economicLoss += loss
  }

  let blockedRoads = 0
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i]
    if (r === undefined) continue
    if (r.blocked) blockedRoads++
  }

  const totalRoads = roads.length

  out.evacuated = evacuated
  out.sheltered = shelteredAgents > shelterOccupancy ? shelteredAgents : shelterOccupancy
  out.stillInside = stillInside
  out.moving = moving
  out.trapped = trapped
  out.injured = injured
  out.fatalities = fatalities
  out.collapsedBuildings = collapsedBuildings
  out.damagedBuildings = damagedBuildings
  out.minorBuildings = minorBuildings
  out.majorBuildings = majorBuildings
  out.severeBuildings = severeBuildings
  out.floodedBuildings = floodedBuildings
  out.totalBuildings = buildings.length
  out.blockedRoads = blockedRoads
  out.totalRoads = totalRoads
  out.roadBlockageRatio = blockedRoads / Math.max(1, totalRoads)
  out.economicLoss = economicLoss
  out.buildingsOnFire = buildingsOnFire
  return out
}
