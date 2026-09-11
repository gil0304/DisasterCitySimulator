/**
 * §25, §26, §28, §31, §42, §43 — the damage model.
 *
 * Pure functions: no state, no clock, no `Math.random`. Everything stochastic
 * is drawn from the `Rng` handed in by the caller, so the same seed always
 * produces the same city-wide damage pattern.
 */

import type { Building, DisasterScenario, RoadEdge, Vec2 } from '../types/city'
import type { DamageState } from '../types/simulation'
import { DAMAGE_RATIO } from '../types/simulation'
import { CONSTRUCTION_VULNERABILITY } from './constants'
import type { Rng } from './rng'

/** Clamp that also swallows NaN / Infinity (returns `min` for a broken input). */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/* ------------------------------------------------------------------ hazard */

/** Ceiling on `hazardIntensityAt`; ~1.0 is "very strong shaking". */
export const MAX_HAZARD_INTENSITY = 1.6

/**
 * Depth is expressed in kilometres but `intensityFalloff` (~1e-3 per metre) is
 * tuned to the few-hundred-metre scale of the city. Feeding the raw hypocentral
 * distance of a 12 km deep quake into that exponential would attenuate the
 * entire map to zero, so depth enters scaled: it keeps the effects that matter
 * (a deeper quake is weaker overall and has a flatter, wider footprint) at a
 * scale the city can actually resolve.
 */
const DEPTH_COUPLING = 0.03
/** Metres; softens the near-field spike of the 1/(1 + d/scale) term. */
const HAZARD_GEOMETRIC_SCALE = 900
/** Metres; how quickly overall intensity drops as the source gets deeper. */
const DEPTH_SOFTENING = 3000
const MAGNITUDE_REFERENCE = 7
const MAGNITUDE_SENSITIVITY = 0.42
const DEFAULT_DEPTH_KM = 12
const DEFAULT_FALLOFF = 0.0011
/** The linear model is declared in absolute terms and saturates at 1. */
const MAX_LINEAR_INTENSITY = 1
/** Ground amplification outside this range is data corruption, not geology. */
const MIN_GROUND = 0.4
const MAX_GROUND = 2.4

function safeGround(groundMultiplier: number): number {
  if (!Number.isFinite(groundMultiplier) || groundMultiplier <= 0) return 1
  return clamp(groundMultiplier, MIN_GROUND, MAX_GROUND)
}

/**
 * §25. Peak shaking at a point, 0 .. `MAX_HAZARD_INTENSITY`.
 *
 * Normalised so that the epicentre evaluates to
 * `baseIntensity × magnitudeTerm × depthFactor × groundMultiplier`, and falls
 * off with the *excess* path length beyond the shortest ray from the
 * hypocentre — a shallow quake gets a sharp bullseye, a deep one shakes the
 * whole city almost equally.
 */
export function hazardIntensityAt(
  scenario: DisasterScenario,
  p: Vec2,
  groundMultiplier: number,
): number {
  const epicenter = scenario.epicenter
  const ex = Number.isFinite(epicenter.x) ? epicenter.x : 0
  const ez = Number.isFinite(epicenter.z) ? epicenter.z : 0
  const px = Number.isFinite(p.x) ? p.x : ex
  const pz = Number.isFinite(p.z) ? p.z : ez
  const surface = Math.hypot(px - ex, pz - ez)

  const falloff = Number.isFinite(scenario.intensityFalloff)
    ? Math.max(0, scenario.intensityFalloff)
    : DEFAULT_FALLOFF
  const base = Number.isFinite(scenario.baseIntensity) ? Math.max(0, scenario.baseIntensity) : 1
  const ground = safeGround(groundMultiplier)

  // The model the data declares wins over the one we would have guessed: the
  // two forms need falloff coefficients an order of magnitude apart, so
  // reading a linear `intensityFalloff` as an exponential one (or the reverse)
  // silently produces either a uniformly shaken or a completely still city.
  if (scenario.intensityModel === 'linear') {
    // `aoba-city.json`: "Subtract intensityFalloff times epicentral distance
    // in meters from baseIntensity, then multiply by shakingAmplification and
    // clamp to [0,1]."
    //
    // Deliberately the *surface* distance. That file states no hypocentral
    // depth, so `depthKm` is only the loader's default; hypot(1 km, 12 km) is
    // essentially constant across a 1 km city, which would flatten the whole
    // gradient this falloff exists to produce. Magnitude and geometric
    // spreading are left out for the same reason — the data's own recipe is
    // complete, and re-scaling it here would make `baseIntensity` a lie.
    return clamp((base - falloff * surface) * ground, 0, MAX_LINEAR_INTENSITY)
  }

  const depthKm = Number.isFinite(scenario.depthKm)
    ? Math.max(0, scenario.depthKm)
    : DEFAULT_DEPTH_KM
  const depth = depthKm * 1000 * DEPTH_COUPLING
  const distance = Math.hypot(surface, depth)
  const excess = Math.max(0, distance - depth)

  const attenuation = Math.exp(-falloff * excess)

  // Mild geometric spreading, written as a ratio so the epicentre stays at 1.
  const geometric =
    (1 + depth / HAZARD_GEOMETRIC_SCALE) / (1 + distance / HAZARD_GEOMETRIC_SCALE)
  const depthFactor = 1 / (1 + depth / DEPTH_SOFTENING)

  const magnitude = Number.isFinite(scenario.magnitude) ? scenario.magnitude : MAGNITUDE_REFERENCE
  const magnitudeTerm = Math.exp(MAGNITUDE_SENSITIVITY * (magnitude - MAGNITUDE_REFERENCE))

  return clamp(
    base * magnitudeTerm * depthFactor * attenuation * geometric * ground,
    0,
    MAX_HAZARD_INTENSITY,
  )
}

/* ------------------------------------------------------------------ damage */

/** How much of the score `seismicResistance` can take away. */
const RESISTANCE_INFLUENCE = 0.65
/** Foundation damage on soft ground, on top of the extra shaking already in `hazardIntensity`. */
const SOIL_DAMAGE_WEIGHT = 0.18
const DAMAGE_VARIATION_SD = 0.16
const DAMAGE_VARIATION_MIN = 0.55
const DAMAGE_VARIATION_MAX = 1.5
/** Global severity knob for the whole city. */
const DAMAGE_SCALE = 1.05

/**
 * Japanese seismic-code eras. These are genuine step changes, not a smooth
 * trend: 1971 (column hoops after Tokachi-oki), 1981 (the "new" code after
 * Miyagi-oki) and 2000 (connections and foundations after Kobe).
 */
export function ageFactor(yearBuilt: number): number {
  const year = Number.isFinite(yearBuilt) ? yearBuilt : 1985
  if (year < 1971) return 1.45
  if (year < 1981) return 1.26
  if (year < 2000) return 1.04
  if (year < 2010) return 0.94
  return 0.88
}

/**
 * Resistance a seismic retrofit of a given vintage implies, on the same 0..1
 * scale as `seismicResistance`. The steps mirror `ageFactor`'s code eras: a
 * retrofit to the 1981 "new" code is a large improvement, one carried out
 * under the post-2000 rules (connections and foundations, after Kobe) larger
 * still. Anything earlier was a modest strengthening exercise.
 */
function retrofitTarget(year: number): number {
  if (year >= 2000) return 0.9
  if (year >= 1981) return 0.76
  return 0.62
}

/** How far toward that target a retrofit actually moves a building. */
const RETROFIT_BLEND = 0.6

/**
 * §26. `seismicResistance` blended toward what the retrofit year implies.
 *
 * A retrofit improves a structure, it does not replace it: the original frame,
 * its material and its geometry still set the ceiling, so the result is a
 * blend rather than the target outright. A retrofit never *lowers* resistance
 * — a building already better than its retrofit vintage keeps its own value —
 * and `yearRetrofitted === null` returns exactly `clamp01(seismicResistance)`,
 * which is what the pre-retrofit model did.
 */
export function effectiveSeismicResistance(
  seismicResistance: number,
  yearRetrofitted: number | null,
): number {
  const base = clamp01(seismicResistance)
  if (yearRetrofitted === null || !Number.isFinite(yearRetrofitted)) return base
  const target = retrofitTarget(yearRetrofitted)
  if (target <= base) return base
  return clamp01(base + RETROFIT_BLEND * (target - base))
}

/**
 * Mid-rises suffer most: soft ground floors, short columns, and a natural
 * period close to that of the shaking. Very low buildings are stiff; very tall
 * frames ride long-period motion comparatively well.
 */
export function heightFactor(floors: number): number {
  const f = Number.isFinite(floors) ? Math.max(1, floors) : 1
  if (f <= 2) return 0.97
  if (f <= 3) return 1.02
  if (f <= 8) return 1.12
  if (f <= 15) return 1.0
  return 0.92
}

/** §26. Deterministic given `rng`. Returns 0..1. */
export function computeDamageScore(
  building: Building,
  hazardIntensity: number,
  groundMultiplier: number,
  rng: Rng,
): number {
  const intensity = clamp(hazardIntensity, 0, MAX_HAZARD_INTENSITY)
  // Still draw from the stream when there is no shaking, so that the stream
  // position does not depend on where the epicentre happens to be.
  const variation = rng.clampedNormal(
    1,
    DAMAGE_VARIATION_SD,
    DAMAGE_VARIATION_MIN,
    DAMAGE_VARIATION_MAX,
  )
  if (intensity <= 0) return 0

  const rawVulnerability = CONSTRUCTION_VULNERABILITY[building.constructionType]
  const vulnerability = Number.isFinite(rawVulnerability) ? rawVulnerability : 1
  const age = ageFactor(building.yearBuilt)
  const height = heightFactor(building.floors)
  const resistance = effectiveSeismicResistance(building.seismicResistance, building.yearRetrofitted)
  const resistanceTerm = 1 - RESISTANCE_INFLUENCE * resistance
  const ground = safeGround(groundMultiplier)
  const soil = 1 + SOIL_DAMAGE_WEIGHT * (ground - 1)

  return clamp01(
    intensity * vulnerability * age * height * resistanceTerm * soil * variation * DAMAGE_SCALE,
  )
}

/* ------------------------------------------------------------- damage state */

export const MINOR_THRESHOLD = 0.2
export const MAJOR_THRESHOLD = 0.45
export const SEVERE_THRESHOLD = 0.7
const MIN_COLLAPSE_THRESHOLD = 0.12
const DEFAULT_COLLAPSE_THRESHOLD = 0.75

/** §28. */
export function damageStateFor(damageScore: number, collapseThreshold: number): DamageState {
  const score = clamp01(damageScore)
  const threshold = Number.isFinite(collapseThreshold)
    ? clamp(collapseThreshold, MIN_COLLAPSE_THRESHOLD, 1)
    : DEFAULT_COLLAPSE_THRESHOLD

  // Collapse wins outright: a fragile building may have a threshold well below
  // the nominal 'severe' line, and a score past it is always a collapse.
  if (score >= threshold) return 'collapsed'
  // The intermediate bands are squeezed underneath a low threshold so the
  // progression stays monotone instead of jumping 'minor' → 'collapsed'.
  if (score >= Math.min(SEVERE_THRESHOLD, threshold * 0.88)) return 'severe'
  if (score >= Math.min(MAJOR_THRESHOLD, threshold * 0.6)) return 'major'
  if (score >= Math.min(MINOR_THRESHOLD, threshold * 0.27)) return 'minor'
  return 'intact'
}

/** §42, §43. */
export function economicLossFor(building: Building, state: DamageState): number {
  const value = Number.isFinite(building.replacementValue)
    ? Math.max(0, building.replacementValue)
    : 0
  const ratio = DAMAGE_RATIO[state]
  return value * (Number.isFinite(ratio) ? ratio : 0)
}

/* ----------------------------------------------------------- road blockage */

/** Base odds for the worst case (adjacent alley, building falling straight at it). */
const BLOCKAGE_BASE = 0.85
/** A road this wide or wider shrugs off most of the rubble. */
const BLOCKAGE_WIDE_ROAD_WIDTH = 20
const MAX_BLOCKAGE_PROBABILITY = 0.95
/** Footprint diagonal (m) that counts as an "average" amount of debris. */
const BLOCKAGE_REFERENCE_FOOTPRINT = 14

/**
 * §31. Probability that a collapsing building blocks a nearby road edge.
 *
 * `distanceToEdge` is measured from the footprint *centre* to the edge's
 * centreline, so the reach of the debris is the footprint radius plus roughly
 * the building's own height plus half the carriageway.
 *
 * `bearingToEdge` is optional so the mandatory signature stays intact; pass it
 * whenever the caller already knows the closest point on the segment (the
 * simulator always does). Without it the fall direction can only be compared
 * against the road axis.
 */
export function blockageProbability(
  building: Building,
  edge: RoadEdge,
  distanceToEdge: number,
  collapseDirection: number,
  edgeBearing: number,
  bearingToEdge?: number,
): number {
  const height = Number.isFinite(building.height) ? Math.max(0, building.height) : 0
  const width = Number.isFinite(edge.width) ? Math.max(1, edge.width) : 6
  const halfWidth = width * 0.5
  const distance = Number.isFinite(distanceToEdge)
    ? Math.max(0, distanceToEdge)
    : Number.POSITIVE_INFINITY

  const footprint = building.footprint
  const fw = Number.isFinite(footprint.width) ? Math.max(1, footprint.width) : 10
  const fd = Number.isFinite(footprint.depth) ? Math.max(1, footprint.depth) : 10
  const footprintRadius = 0.5 * Math.max(fw, fd)

  const reach = footprintRadius + height * 0.9 + halfWidth
  if (!(reach > 0) || distance > reach) return 0

  // A building topples roughly its own height; debris density falls off with
  // how much of that reach is spent just getting to the carriageway.
  const proximity = Math.pow(clamp01(1 - distance / reach), 0.85)

  // Narrow streets choke on a fraction of the rubble an arterial absorbs.
  const narrowness = clamp01(1 - width / BLOCKAGE_WIDE_ROAD_WIDTH)
  const widthFactor = 0.3 + 1.05 * narrowness

  const fallDirection = Number.isFinite(collapseDirection) ? collapseDirection : 0
  const roadBearing = Number.isFinite(edgeBearing) ? edgeBearing : 0
  const toEdge =
    typeof bearingToEdge === 'number' && Number.isFinite(bearingToEdge)
      ? bearingToEdge
      : roadBearing + Math.PI / 2

  // Falling away from the road drops very little on it.
  const alignment = Math.cos(toEdge - fallDirection)
  const directionFactor = 0.18 + 0.82 * clamp01((alignment + 0.3) / 1.3)

  // A road running across the fall line is spanned by the debris; one running
  // along it is merely clipped.
  const crossing = Math.abs(Math.sin(fallDirection - roadBearing))
  const orientationFactor = 0.6 + 0.4 * crossing

  // A factory produces a great deal more rubble than a bungalow.
  const massFactor = clamp(
    Math.sqrt(Math.max(1, fw * fd)) / BLOCKAGE_REFERENCE_FOOTPRINT,
    0.7,
    1.35,
  )

  return clamp(
    BLOCKAGE_BASE * proximity * widthFactor * directionFactor * orientationFactor * massFactor,
    0,
    MAX_BLOCKAGE_PROBABILITY,
  )
}
