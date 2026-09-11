/**
 * Static city description — the shape of `src/data/aoba-city.json`.
 *
 * These types describe the data *after* normalisation by `CityLoader`.
 * The raw JSON is allowed to be looser (see `RawCityModel` at the bottom and
 * the tolerance rules documented in `docs/city-schema.md`); the loader fills in
 * defaults and canonicalises positions so the rest of the app can rely on
 * every field being present.
 *
 * Coordinate system: Three.js, Y-up. The city lies on the XZ plane, metres.
 */

export interface Vec2 {
  x: number
  z: number
}

export const BUILDING_USES = [
  'residential',
  'apartment',
  'office',
  'commercial',
  'retail',
  'school',
  'hospital',
  'factory',
  'civic',
  'station',
  'temple',
  'parking',
] as const
export type BuildingUse = (typeof BUILDING_USES)[number]

export const CONSTRUCTION_TYPES = [
  'wood',
  'lightSteel',
  'masonry',
  'rc',
  'steel',
  'prefab',
] as const
export type ConstructionType = (typeof CONSTRUCTION_TYPES)[number]

export const ROOF_TYPES = ['flat', 'gable', 'hip', 'mono', 'sawtooth', 'dome'] as const
export type RoofType = (typeof ROOF_TYPES)[number]

export const GROUND_TYPES = ['rock', 'hard', 'medium', 'soft', 'reclaimed'] as const
export type GroundType = (typeof GROUND_TYPES)[number]

export const ROAD_CLASSES = ['arterial', 'collector', 'local', 'alley'] as const
export type RoadClass = (typeof ROAD_CLASSES)[number]

export const SHELTER_KINDS = ['park', 'school', 'gym', 'civic', 'hospital'] as const
export type ShelterKind = (typeof SHELTER_KINDS)[number]

export const DISTRICT_KINDS = [
  'residential',
  'commercial',
  'business',
  'industrial',
  'mixed',
  'waterfront',
  'civic',
] as const
export type DistrictKind = (typeof DISTRICT_KINDS)[number]

export const AGENT_PROFILES = ['child', 'adult', 'elderly', 'mobilityImpaired'] as const
export type AgentProfile = (typeof AGENT_PROFILES)[number]

/** Fractions per profile. Normalised to sum to 1 by the loader. */
export type PopulationProfile = Record<AgentProfile, number>

export interface Footprint {
  /** Extent along the building's local X axis, metres. */
  width: number
  /** Extent along the building's local Z axis, metres. */
  depth: number
}

export interface Building {
  id: string
  name: string
  /** Centre of the footprint on the ground plane. */
  position: Vec2
  /** Y rotation, radians. */
  rotation: number
  footprint: Footprint
  floors: number
  /** Total height above ground, metres. */
  height: number
  use: BuildingUse
  constructionType: ConstructionType
  yearBuilt: number
  roofType: RoofType
  /** 0 (none) .. 1 (modern base-isolated). */
  seismicResistance: number
  /** damageScore at or above which the building collapses. 0..1 */
  collapseThreshold: number
  /** Rebuild cost, JPY. */
  replacementValue: number
  /** Number of people present at the moment the scenario starts. */
  occupancy: number
  populationProfile: PopulationProfile
  /** 0..1 chance of igniting after severe shaking. */
  fireIgnitionProbability: number
  /** 0..1 resistance to catching and carrying fire. */
  fireResistance: number
  /**
   * Authored baseline delay before this building's occupants start moving,
   * measured from the end of the shaking. `null` when the data does not say,
   * in which case `PopulationGenerator` derives one from the building's use
   * and height (§22, §23).
   */
  evacuationDelaySeconds: number | null
  /** Year of a seismic retrofit, if any — raises the effective resistance. */
  yearRetrofitted: number | null
  districtId: string | null
  /** Explicit ground zone membership, when the data states it. */
  groundZoneId: string | null
  /** Optional pre-baked link into the road network; loader computes it if absent. */
  nearestRoadNodeId: string | null
}

export interface RoadNode {
  id: string
  position: Vec2
  /** Convenience flag; purely cosmetic. */
  kind: 'intersection' | 'endpoint' | 'waypoint'
}

export interface RoadEdge {
  id: string
  from: string
  to: string
  /** Carriageway width, metres. Drives both rendering and blockage odds. */
  width: number
  roadClass: RoadClass
  lanes: number
  /** Cached length in metres (loader computes from node positions). */
  length: number
}

export interface RoadNetwork {
  nodes: RoadNode[]
  edges: RoadEdge[]
}

export interface Shelter {
  id: string
  name: string
  position: Vec2
  capacity: number
  kind: ShelterKind
  footprint: Footprint
  /** Road node the shelter entrance attaches to; loader computes it if absent. */
  roadNodeId: string | null
}

export interface District {
  id: string
  name: string
  kind: DistrictKind
  center: Vec2
  /** Rough radius in metres, used only for labelling / ground tinting. */
  radius: number
}

export interface GroundZone {
  id: string
  name: string
  groundType: GroundType
  /** Shaking amplification factor, ~0.8 (rock) .. ~2.0 (reclaimed land). */
  amplification: number
  /** Convex or concave polygon on the XZ plane, metres. At least 3 points. */
  polygon: Vec2[]
}

export interface DisasterScenario {
  id: string
  type: 'earthquake' | 'flood' | 'tsunami' | 'fire' | 'typhoon'
  name: string
  /** Surface projection of the hypocentre. */
  epicenter: Vec2
  depthKm: number
  magnitude: number
  /** Intensity at the epicentre, ~1.0. Multiplies into every building's shaking. */
  baseIntensity: number
  /** Per-metre attenuation coefficient; intensity ~ base * exp(-falloff * distance). */
  intensityFalloff: number
  /** Length of strong shaking, simulation seconds. */
  durationSeconds: number
  /** Optional aftershocks, seconds after main shock. */
  aftershocks: { time: number; intensityScale: number }[]
  /**
   * How `baseIntensity` attenuates with epicentral distance.
   *
   * `exponential` (the default): `base * exp(-falloff * distance)`, which never
   * reaches zero and suits a large `falloff` over a wide city.
   * `linear`: `base - falloff * distance`, clamped at zero — the form declared
   * by `aoba-city.json`'s own metadata. The two need very different `falloff`
   * values, so this must follow whatever the data says rather than be guessed.
   */
  intensityModel: 'exponential' | 'linear'
  /** 0..1 chance of a single aftershock within 600 s, when no list is given. */
  aftershockProbability: number
  /** Scenario-wide baseline ignition chance, used when a building states none. */
  fireIgnitionProbability: number
}

export interface CityBounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export interface CityMeta {
  name: string
  version: string
  generatedBy: string
  bounds: CityBounds
  /** Deterministic seed baked into the data; may be overridden at runtime. */
  simulationSeed: number
}

export interface CityModel {
  meta: CityMeta
  districts: District[]
  groundZones: GroundZone[]
  roadNetwork: RoadNetwork
  buildings: Building[]
  shelters: Shelter[]
  disasterScenarios: DisasterScenario[]
}

/**
 * Loosely-typed view of the on-disk JSON. Every field is optional and several
 * are union-typed because the generator (Astra) may legitimately emit
 * `[x, z]`, `[x, y, z]`, `{x, z}` or `{x, y, z}` for a position, and may omit
 * derived values such as `height` or `length`.
 */
export type RawVec = number[] | { x: number; y?: number; z: number } | { x: number; y: number }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawCityModel = Record<string, any>

export interface CityValidationIssue {
  severity: 'error' | 'warning'
  path: string
  message: string
}

export interface CityLoadResult {
  city: CityModel
  issues: CityValidationIssue[]
}
