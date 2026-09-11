/**
 * Reads the raw city JSON (`src/data/aoba-city.json`), validates it, fills in
 * every derived default documented in `docs/city-schema.md` and normalises the
 * result into the strictly-typed `CityModel` the rest of the app relies on.
 *
 * This is the only module that touches untyped input. It is deliberately
 * tolerant — the generator may emit positions in four shapes, use several
 * spellings for the same field, omit anything derivable, and hand over enum
 * values that only approximately match ours. Everything it cannot rescue turns
 * into a `CityValidationIssue`; only the handful of genuinely fatal problems
 * listed in the schema throw `CityLoadError`.
 *
 * ## Two dialects
 *
 * Two spellings of the same city are supported side by side:
 *
 * - the *original* dialect of `src/data/sample-city.json`, documented in
 *   `docs/city-schema.md`: `meta`, polygonal `groundZones`, `center` + `radius`
 *   districts, `use` / `constructionType` / `roadClass`, `roadNodeId`;
 * - the *Astra* dialect of `src/data/aoba-city.json`: a `metadata` block plus a
 *   `city` block, `bounds` rectangles on districts, ground zones and shelters,
 *   `type` / `construction` / `roadType`, `nearestRoadNode` / `roadNode`,
 *   `shakingAmplification`, plural `populationProfile` keys.
 *
 * Neither is privileged; every reader below accepts both. Astra's `metadata`
 * block states in prose how several values are meant to be read, and those
 * statements are part of the contract — the half-open ground-zone rectangle
 * rule (`groundZoneBoundaryRule`) and the linear attenuation form
 * (`groundIntensityInterpretation`) are both honoured here.
 */

import {
  AGENT_PROFILES,
  BUILDING_USES,
  CONSTRUCTION_TYPES,
  DISTRICT_KINDS,
  GROUND_TYPES,
  ROAD_CLASSES,
  ROOF_TYPES,
  SHELTER_KINDS,
} from '../types/city'
import type {
  AgentProfile,
  Building,
  BuildingUse,
  CityBounds,
  CityLoadResult,
  CityMeta,
  CityModel,
  CityValidationIssue,
  ConstructionType,
  DisasterScenario,
  District,
  DistrictKind,
  Footprint,
  GroundType,
  GroundZone,
  PopulationProfile,
  RoadClass,
  RoadEdge,
  RoadNetwork,
  RoadNode,
  RoofType,
  Shelter,
  ShelterKind,
  Vec2,
} from '../types/city'
import { GROUND_AMPLIFICATION } from './constants'
import { hashUnit } from './rng'

const TAU = Math.PI * 2
/** Storey height used for every height <-> floors derivation, metres. */
const FLOOR_HEIGHT = 3.2
/** Extra height given to flat-roofed buildings for their parapet, metres. */
const FLAT_ROOF_PARAPET = 1.1
/** `buildingAge` values below this are read as an age, above as a calendar year. */
const AGE_YEAR_THRESHOLD = 200
const REFERENCE_YEAR = 2026
const DEFAULT_YEAR_BUILT = 1985
const DEFAULT_SEED = 20260908
const BOUNDS_MARGIN = 60
/** Buildings farther than this from the nearest road node get a warning. */
const FAR_FROM_ROAD_DISTANCE = 120
/** Edges shorter than this are geometric noise and are dropped. */
const MIN_EDGE_LENGTH = 0.05
/** Per-category cap so one systematic data problem cannot emit 3000 issues. */
const MAX_ISSUES_PER_CATEGORY = 6
const MAX_TOTAL_ISSUES = 240

const DEFAULT_FOOTPRINT: Footprint = { width: 12, depth: 10 }

/** §14 — default road width per class, metres. */
const ROAD_CLASS_WIDTH: Record<RoadClass, number> = {
  arterial: 22,
  collector: 14,
  local: 8,
  alley: 4,
}

/** Rebuild cost per square metre of gross floor area, JPY. */
const UNIT_COST: Record<ConstructionType, number> = {
  wood: 205_000,
  lightSteel: 235_000,
  masonry: 215_000,
  rc: 320_000,
  steel: 355_000,
  prefab: 180_000,
}

/** Seismic-resistance nudge per construction type, added to the year curve. */
const CONSTRUCTION_SEISMIC_OFFSET: Record<ConstructionType, number> = {
  wood: -0.06,
  lightSteel: 0,
  masonry: -0.13,
  rc: 0.06,
  steel: 0.08,
  prefab: 0.02,
}

/** People per square metre of gross floor area at the moment of the shock. */
const USE_OCCUPANT_DENSITY: Record<BuildingUse, number> = {
  residential: 0.035,
  apartment: 0.04,
  office: 0.07,
  commercial: 0.08,
  retail: 0.09,
  school: 0.1,
  hospital: 0.05,
  factory: 0.02,
  civic: 0.05,
  station: 0.12,
  temple: 0.01,
  parking: 0.004,
}

const USE_POPULATION_PROFILE: Record<BuildingUse, PopulationProfile> = {
  residential: { child: 0.18, adult: 0.58, elderly: 0.2, mobilityImpaired: 0.04 },
  apartment: { child: 0.16, adult: 0.64, elderly: 0.16, mobilityImpaired: 0.04 },
  office: { child: 0.01, adult: 0.93, elderly: 0.04, mobilityImpaired: 0.02 },
  commercial: { child: 0.1, adult: 0.72, elderly: 0.15, mobilityImpaired: 0.03 },
  retail: { child: 0.12, adult: 0.7, elderly: 0.15, mobilityImpaired: 0.03 },
  school: { child: 0.82, adult: 0.16, elderly: 0, mobilityImpaired: 0.02 },
  hospital: { child: 0.08, adult: 0.46, elderly: 0.3, mobilityImpaired: 0.16 },
  factory: { child: 0, adult: 0.93, elderly: 0.05, mobilityImpaired: 0.02 },
  civic: { child: 0.08, adult: 0.68, elderly: 0.2, mobilityImpaired: 0.04 },
  station: { child: 0.1, adult: 0.76, elderly: 0.12, mobilityImpaired: 0.02 },
  temple: { child: 0.05, adult: 0.55, elderly: 0.36, mobilityImpaired: 0.04 },
  parking: { child: 0.04, adult: 0.86, elderly: 0.08, mobilityImpaired: 0.02 },
}

const USE_LABEL: Record<BuildingUse, string> = {
  residential: 'House',
  apartment: 'Apartment',
  office: 'Office',
  commercial: 'Commercial Building',
  retail: 'Shop',
  school: 'School',
  hospital: 'Hospital',
  factory: 'Factory',
  civic: 'Civic Hall',
  station: 'Station',
  temple: 'Temple',
  parking: 'Parking',
}

const POSITION_KEYS = [
  'position',
  'pos',
  'p',
  'center',
  'centre',
  'location',
  'coordinates',
  'coord',
  'xz',
] as const

const BUILDING_USE_SYNONYMS: Record<string, BuildingUse> = {
  house: 'residential',
  home: 'residential',
  housing: 'residential',
  detached: 'residential',
  dwelling: 'residential',
  villa: 'residential',
  townhouse: 'residential',
  machiya: 'residential',
  apartments: 'apartment',
  apt: 'apartment',
  flat: 'apartment',
  flats: 'apartment',
  condo: 'apartment',
  condominium: 'apartment',
  mansion: 'apartment',
  multifamily: 'apartment',
  danchi: 'apartment',
  offices: 'office',
  corporate: 'office',
  headquarters: 'office',
  tower: 'office',
  highrise: 'office',
  shop: 'retail',
  store: 'retail',
  shopping: 'retail',
  mall: 'retail',
  market: 'retail',
  supermarket: 'retail',
  convenience: 'retail',
  restaurant: 'commercial',
  hotel: 'commercial',
  bank: 'commercial',
  mixed: 'commercial',
  mixeduse: 'commercial',
  university: 'school',
  college: 'school',
  kindergarten: 'school',
  nursery: 'school',
  education: 'school',
  academy: 'school',
  clinic: 'hospital',
  medical: 'hospital',
  healthcare: 'hospital',
  care: 'hospital',
  nursinghome: 'hospital',
  industrial: 'factory',
  warehouse: 'factory',
  plant: 'factory',
  workshop: 'factory',
  logistics: 'factory',
  depot: 'factory',
  government: 'civic',
  cityhall: 'civic',
  townhall: 'civic',
  library: 'civic',
  museum: 'civic',
  community: 'civic',
  communitycenter: 'civic',
  firestation: 'civic',
  policestation: 'civic',
  police: 'civic',
  hall: 'civic',
  train: 'station',
  trainstation: 'station',
  railway: 'station',
  rail: 'station',
  bus: 'station',
  busterminal: 'station',
  terminal: 'station',
  metro: 'station',
  subway: 'station',
  shrine: 'temple',
  church: 'temple',
  religious: 'temple',
  jinja: 'temple',
  garage: 'parking',
  carpark: 'parking',
  parkinglot: 'parking',
}

const CONSTRUCTION_SYNONYMS: Record<string, ConstructionType> = {
  w: 'wood',
  wooden: 'wood',
  timber: 'wood',
  mokuzo: 'wood',
  frame: 'wood',
  lightgauge: 'lightSteel',
  lightgaugesteel: 'lightSteel',
  lightweightsteel: 'lightSteel',
  lgs: 'lightSteel',
  ls: 'lightSteel',
  brick: 'masonry',
  block: 'masonry',
  concreteblock: 'masonry',
  stone: 'masonry',
  cb: 'masonry',
  unreinforcedmasonry: 'masonry',
  concrete: 'rc',
  reinforced: 'rc',
  reinforcedconcrete: 'rc',
  src: 'rc',
  s: 'steel',
  steelframe: 'steel',
  ironframe: 'steel',
  prefabricated: 'prefab',
  modular: 'prefab',
  panel: 'prefab',
}

const ROOF_SYNONYMS: Record<string, RoofType> = {
  gabled: 'gable',
  pitched: 'gable',
  ridge: 'gable',
  kirizuma: 'gable',
  hipped: 'hip',
  yosemune: 'hip',
  monopitch: 'mono',
  shed: 'mono',
  skillion: 'mono',
  lean: 'mono',
  saw: 'sawtooth',
  sawtoothed: 'sawtooth',
  domed: 'dome',
  curved: 'dome',
  barrel: 'dome',
  vault: 'dome',
  terrace: 'flat',
  rooftop: 'flat',
  parapet: 'flat',
  none: 'flat',
}

const GROUND_SYNONYMS: Record<string, GroundType> = {
  bedrock: 'rock',
  granite: 'rock',
  tertiary: 'rock',
  stiff: 'hard',
  firm: 'hard',
  dense: 'hard',
  gravel: 'hard',
  diluvial: 'hard',
  terrace: 'hard',
  normal: 'medium',
  default: 'medium',
  average: 'medium',
  loam: 'medium',
  clay: 'soft',
  silt: 'soft',
  sand: 'soft',
  alluvial: 'soft',
  loose: 'soft',
  peat: 'soft',
  landfill: 'reclaimed',
  fill: 'reclaimed',
  artificial: 'reclaimed',
  reclamation: 'reclaimed',
  made: 'reclaimed',
}

const ROAD_CLASS_SYNONYMS: Record<string, RoadClass> = {
  main: 'arterial',
  primary: 'arterial',
  trunk: 'arterial',
  highway: 'arterial',
  boulevard: 'arterial',
  avenue: 'arterial',
  secondary: 'collector',
  distributor: 'collector',
  minor: 'collector',
  street: 'local',
  residential: 'local',
  tertiary: 'local',
  road: 'local',
  lane: 'alley',
  path: 'alley',
  footpath: 'alley',
  service: 'alley',
  narrow: 'alley',
  backstreet: 'alley',
  roji: 'alley',
}

const SHELTER_KIND_SYNONYMS: Record<string, ShelterKind> = {
  openspace: 'park',
  plaza: 'park',
  field: 'park',
  green: 'park',
  garden: 'park',
  playground: 'park',
  elementary: 'school',
  elementaryschool: 'school',
  juniorhigh: 'school',
  highschool: 'school',
  university: 'school',
  college: 'school',
  gymnasium: 'gym',
  arena: 'gym',
  sports: 'gym',
  sportscenter: 'gym',
  budokan: 'gym',
  hall: 'gym',
  community: 'civic',
  communitycenter: 'civic',
  communitycentre: 'civic',
  government: 'civic',
  cityhall: 'civic',
  townhall: 'civic',
  publichall: 'civic',
  center: 'civic',
  centre: 'civic',
  clinic: 'hospital',
  medical: 'hospital',
}

const DISTRICT_KIND_SYNONYMS: Record<string, DistrictKind> = {
  housing: 'residential',
  residence: 'residential',
  suburb: 'residential',
  shopping: 'commercial',
  retail: 'commercial',
  downtown: 'commercial',
  office: 'business',
  cbd: 'business',
  financial: 'business',
  factory: 'industrial',
  industry: 'industrial',
  manufacturing: 'industrial',
  port: 'industrial',
  mixeduse: 'mixed',
  general: 'mixed',
  harbour: 'waterfront',
  harbor: 'waterfront',
  bay: 'waterfront',
  coast: 'waterfront',
  coastal: 'waterfront',
  riverside: 'waterfront',
  seafront: 'waterfront',
  government: 'civic',
  public: 'civic',
  institutional: 'civic',
}

const SCENARIO_TYPES = ['earthquake', 'flood', 'tsunami', 'fire', 'typhoon'] as const
type ScenarioType = (typeof SCENARIO_TYPES)[number]

const SCENARIO_TYPE_SYNONYMS: Record<string, ScenarioType> = {
  eq: 'earthquake',
  quake: 'earthquake',
  seismic: 'earthquake',
  shock: 'earthquake',
  jishin: 'earthquake',
  inundation: 'flood',
  flooding: 'flood',
  river: 'flood',
  seismicwave: 'tsunami',
  tidalwave: 'tsunami',
  conflagration: 'fire',
  wildfire: 'fire',
  firestorm: 'fire',
  hurricane: 'typhoon',
  cyclone: 'typhoon',
  storm: 'typhoon',
  taifu: 'typhoon',
}

const SCENARIO_TYPE_LABEL: Record<ScenarioType, string> = {
  earthquake: 'Earthquake',
  flood: 'Flood',
  tsunami: 'Tsunami',
  fire: 'Fire',
  typhoon: 'Typhoon',
}

/** Unknown population-profile keys are folded onto the four known profiles. */
const PROFILE_SYNONYMS: Record<string, AgentProfile> = {
  kid: 'child',
  kids: 'child',
  children: 'child',
  minor: 'child',
  minors: 'child',
  student: 'child',
  students: 'child',
  infant: 'child',
  infants: 'child',
  young: 'child',
  youth: 'child',
  adults: 'adult',
  grown: 'adult',
  working: 'adult',
  workingage: 'adult',
  worker: 'adult',
  workers: 'adult',
  staff: 'adult',
  parent: 'adult',
  parents: 'adult',
  senior: 'elderly',
  seniors: 'elderly',
  old: 'elderly',
  aged: 'elderly',
  pensioner: 'elderly',
  retired: 'elderly',
  koreisha: 'elderly',
  disabled: 'mobilityImpaired',
  handicapped: 'mobilityImpaired',
  impaired: 'mobilityImpaired',
  mobility: 'mobilityImpaired',
  reducedmobility: 'mobilityImpaired',
  wheelchair: 'mobilityImpaired',
  assisted: 'mobilityImpaired',
}

/** Thrown when the data cannot produce a usable city. Carries every issue. */
export class CityLoadError extends Error {
  readonly issues: CityValidationIssue[]

  constructor(message: string, issues: CityValidationIssue[]) {
    super(message)
    this.name = 'CityLoadError'
    this.issues = issues
    Object.setPrototypeOf(this, CityLoadError.prototype)
  }
}

/**
 * Collects validation issues. Warnings are capped per category so that a
 * systematic problem (every building missing `floors`, say) produces a handful
 * of examples plus a count rather than thousands of lines.
 */
class IssueLog {
  private readonly issues: CityValidationIssue[]
  private readonly counts: Map<string, number>
  private readonly suppressed: Map<string, number>
  private fatalCount: number

  constructor() {
    this.issues = []
    this.counts = new Map()
    this.suppressed = new Map()
    this.fatalCount = 0
  }

  warn(category: string, path: string, message: string): void {
    this.record('warning', category, path, message)
  }

  error(category: string, path: string, message: string): void {
    this.fatalCount++
    this.record('error', category, path, message)
  }

  /** An issue that is always emitted (used for one-per-load summaries). */
  note(path: string, message: string): void {
    if (this.issues.length < MAX_TOTAL_ISSUES) {
      this.issues.push({ severity: 'warning', path, message })
    }
  }

  private record(
    severity: 'error' | 'warning',
    category: string,
    path: string,
    message: string,
  ): void {
    const seen = (this.counts.get(category) ?? 0) + 1
    this.counts.set(category, seen)
    if (seen <= MAX_ISSUES_PER_CATEGORY && this.issues.length < MAX_TOTAL_ISSUES) {
      this.issues.push({ severity, path, message })
    } else {
      this.suppressed.set(category, (this.suppressed.get(category) ?? 0) + 1)
    }
  }

  countOf(category: string): number {
    return this.counts.get(category) ?? 0
  }

  hasFatal(): boolean {
    return this.fatalCount > 0
  }

  fatalTotal(): number {
    return this.fatalCount
  }

  /** Snapshot of every issue, plus one summary line per suppressed category. */
  all(): CityValidationIssue[] {
    const out = this.issues.slice()
    for (const [category, count] of this.suppressed) {
      out.push({
        severity: 'warning',
        path: category,
        message: `${count} further "${category}" issue(s) not listed.`,
      })
    }
    return out
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** First key present with a non-null value. */
function pick(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** Finite number, accepting numeric strings. Booleans are rejected. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toInteger(value: unknown): number | null {
  const n = toNumber(value)
  return n === null ? null : Math.round(n)
}

/** Non-empty identifier, accepting numbers (they become their decimal form). */
function toId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * A list of entities may arrive as an array or as an object keyed by id.
 * Returns `{ key, value }` pairs so the object key can seed a missing `id`.
 */
function toEntryList(value: unknown): { key: string | null; value: unknown }[] {
  if (Array.isArray(value)) {
    return value.map((item) => ({ key: null, value: item as unknown }))
  }
  if (isRecord(value)) {
    return Object.keys(value).map((key) => ({ key, value: value[key] }))
  }
  return []
}

function normaliseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

function clampInt(value: number, lo: number, hi: number): number {
  const v = Math.round(value)
  return v < lo ? lo : v > hi ? hi : v
}

function wrapAngle(radians: number): number {
  const wrapped = radians % TAU
  return wrapped < 0 ? wrapped + TAU : wrapped
}

function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}

type EnumStatus = 'absent' | 'exact' | 'mapped' | 'unknown'

/**
 * Maps a loose string onto one of our enum values: exact match, then a synonym
 * table, then a substring match in either direction, then the fallback.
 */
function resolveEnum<T extends string>(
  raw: unknown,
  known: readonly T[],
  synonyms: Record<string, T>,
  fallback: T,
): { value: T; status: EnumStatus } {
  if (raw === undefined || raw === null) return { value: fallback, status: 'absent' }
  const text = toText(raw)
  if (text === null) return { value: fallback, status: 'unknown' }
  const key = normaliseKey(text)
  if (key === '') return { value: fallback, status: 'absent' }

  for (const candidate of known) {
    if (normaliseKey(candidate) === key) return { value: candidate, status: 'exact' }
  }
  const direct = synonyms[key]
  if (direct !== undefined) return { value: direct, status: 'mapped' }
  for (const candidate of known) {
    const candidateKey = normaliseKey(candidate)
    if (key.includes(candidateKey) || candidateKey.includes(key)) {
      return { value: candidate, status: 'mapped' }
    }
  }
  for (const synonymKey of Object.keys(synonyms)) {
    if (key.includes(synonymKey)) {
      const mapped = synonyms[synonymKey]
      if (mapped !== undefined) return { value: mapped, status: 'mapped' }
    }
  }
  return { value: fallback, status: 'unknown' }
}

/** `resolveEnum` plus the warnings the schema asks for on unknown values. */
function readEnum<T extends string>(
  log: IssueLog,
  path: string,
  field: string,
  raw: unknown,
  known: readonly T[],
  synonyms: Record<string, T>,
  fallback: T,
): { value: T; explicit: boolean } {
  const resolved = resolveEnum(raw, known, synonyms, fallback)
  if (resolved.status === 'unknown') {
    log.warn(
      `unknown-${field}`,
      path,
      `Unknown ${field} "${String(raw)}"; using "${resolved.value}".`,
    )
  } else if (resolved.status === 'mapped') {
    log.warn(
      `mapped-${field}`,
      path,
      `${field} "${String(raw)}" mapped to "${resolved.value}".`,
    )
  }
  return { value: resolved.value, explicit: resolved.status !== 'absent' }
}

function clampNumber(
  log: IssueLog,
  path: string,
  field: string,
  value: number,
  lo: number,
  hi: number,
): number {
  if (value < lo || value > hi) {
    const clamped = clamp(value, lo, hi)
    log.warn(
      `out-of-range-${field}`,
      path,
      `${field} ${value} is outside [${lo}, ${hi}]; clamped to ${clamped}.`,
    )
    return clamped
  }
  return value
}

/**
 * 0..1 scalar. When `allowPercent` is set, a value that is plainly a percentage
 * (1.5 < v <= 100) is divided by 100 instead of being clamped to 1 — a
 * `fireIgnitionProbability` of `6` means 6 %, not "always".
 */
function clampUnit(
  log: IssueLog,
  path: string,
  field: string,
  value: number,
  allowPercent: boolean,
): number {
  let v = value
  if (allowPercent && v > 1.5 && v <= 100) {
    v = v / 100
    log.warn(
      `percent-${field}`,
      path,
      `${field} ${value} read as a percentage; using ${v}.`,
    )
  }
  return clampNumber(log, path, field, v, 0, 1)
}

/**
 * Accepts `[x, z]`, `[x, y, z]`, `{x, z}`, `{x, y, z}`, `{x, y}` (y read as z),
 * `"x, z"` and one level of `{ position: ... }` nesting. Returns null when the
 * value cannot be read as a point on the XZ plane.
 */
export function normalizePosition(value: unknown): Vec2 | null {
  return normalizePositionAt(value, 0)
}

function normalizePositionAt(value: unknown, depth: number): Vec2 | null {
  if (depth > 3) return null

  if (Array.isArray(value)) {
    if (value.length >= 3) {
      const x = toNumber(value[0])
      const z = toNumber(value[2])
      if (x !== null && z !== null) return { x, z }
      // Tolerate [x, z, <non-numeric tag>].
      const z2 = toNumber(value[1])
      return x !== null && z2 !== null ? { x, z: z2 } : null
    }
    if (value.length === 2) {
      const x = toNumber(value[0])
      const z = toNumber(value[1])
      return x !== null && z !== null ? { x, z } : null
    }
    return null
  }

  if (isRecord(value)) {
    const x = toNumber(pick(value, ['x', 'X']))
    let z = toNumber(pick(value, ['z', 'Z']))
    // `{x, y}` with no z is the 2-D form: y is the second planar coordinate.
    if (z === null) z = toNumber(pick(value, ['y', 'Y']))
    if (x !== null && z !== null) return { x, z }
    const nested = pick(value, POSITION_KEYS)
    if (nested !== undefined) return normalizePositionAt(nested, depth + 1)
    return null
  }

  if (typeof value === 'string') {
    const parts = value.split(/[\s,;[\]()]+/).filter((part) => part.length > 0)
    if (parts.length === 2 || parts.length === 3) return normalizePositionAt(parts, depth + 1)
    return null
  }

  return null
}

/** Ray casting. Points exactly on an edge may land either way. */
export function pointInPolygon(p: Vec2, polygon: Vec2[]): boolean {
  const n = polygon.length
  if (n < 3) return false
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (!a || !b) continue
    const crosses = a.z > p.z !== b.z > p.z
    if (!crosses) continue
    const dz = b.z - a.z
    if (dz === 0 || !Number.isFinite(dz)) continue
    const cutX = a.x + ((p.z - a.z) / dz) * (b.x - a.x)
    if (Number.isFinite(cutX) && p.x < cutX) inside = !inside
  }
  return inside
}

interface ZoneBox {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/**
 * Zone bounding boxes, cached per city. `groundMultiplierAt` is called once per
 * building at start-up, so rejecting most zones with an AABB test matters when
 * a city has many ground zones.
 */
const zoneBoxCache = new WeakMap<CityModel, ZoneBox[]>()

function zoneBoxesOf(city: CityModel): ZoneBox[] {
  const cached = zoneBoxCache.get(city)
  if (cached && cached.length === city.groundZones.length) return cached
  const boxes: ZoneBox[] = city.groundZones.map((zone) => {
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const point of zone.polygon) {
      if (point.x < minX) minX = point.x
      if (point.x > maxX) maxX = point.x
      if (point.z < minZ) minZ = point.z
      if (point.z > maxZ) maxZ = point.z
    }
    return { minX, maxX, minZ, maxZ }
  })
  zoneBoxCache.set(city, boxes)
  return boxes
}

/** Amplification of the first zone containing `p`, else 1.0. */
export function groundMultiplierAt(city: CityModel, p: Vec2): number {
  const zones = city.groundZones
  if (zones.length === 0) return 1
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return 1
  const boxes = zoneBoxesOf(city)
  for (let i = 0; i < zones.length; i++) {
    const box = boxes[i]
    if (box && (p.x < box.minX || p.x > box.maxX || p.z < box.minZ || p.z > box.maxZ)) continue
    const zone = zones[i]
    if (!zone) continue
    if (pointInPolygon(p, zone.polygon)) {
      const amp = zone.amplification
      return Number.isFinite(amp) && amp > 0 ? amp : 1
    }
  }
  return 1
}

/**
 * Uniform grid over a fixed point set, used to attach every building and
 * shelter to its nearest road node without an O(buildings x nodes) scan.
 * (`RoadGraph` has its own grid, but it is not available at load time.)
 */
class PointGrid {
  private readonly xs: Float64Array
  private readonly zs: Float64Array
  private readonly minX: number
  private readonly minZ: number
  private readonly cell: number
  private readonly cols: number
  private readonly rows: number
  private readonly buckets: (number[] | undefined)[]
  private readonly count: number
  private bestIndex: number
  private bestDistanceSq: number

  constructor(points: Vec2[]) {
    this.count = points.length
    this.xs = new Float64Array(this.count)
    this.zs = new Float64Array(this.count)
    this.bestIndex = -1
    this.bestDistanceSq = Infinity

    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (let i = 0; i < this.count; i++) {
      const point = points[i]
      const x = point ? point.x : 0
      const z = point ? point.z : 0
      this.xs[i] = x
      this.zs[i] = z
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
    if (!Number.isFinite(minX)) {
      minX = 0
      maxX = 0
      minZ = 0
      maxZ = 0
    }
    this.minX = minX
    this.minZ = minZ

    const width = Math.max(1e-6, maxX - minX)
    const depth = Math.max(1e-6, maxZ - minZ)
    // Aim for ~2 points per cell, but never more than 1024 cells per axis.
    let cell = Math.sqrt((width * depth) / Math.max(1, Math.ceil(this.count / 2)))
    if (!Number.isFinite(cell) || cell <= 0) cell = 25
    cell = Math.max(cell, width / 1024, depth / 1024, 1e-3)
    this.cell = cell
    this.cols = Math.max(1, Math.ceil(width / cell))
    this.rows = Math.max(1, Math.ceil(depth / cell))

    this.buckets = new Array<number[] | undefined>(this.cols * this.rows)
    for (let i = 0; i < this.count; i++) {
      const cx = clampInt(Math.floor((this.xs[i] - this.minX) / cell), 0, this.cols - 1)
      const cz = clampInt(Math.floor((this.zs[i] - this.minZ) / cell), 0, this.rows - 1)
      const key = cz * this.cols + cx
      const bucket = this.buckets[key]
      if (bucket) bucket.push(i)
      else this.buckets[key] = [i]
    }
  }

  /** Index of the nearest point, or -1 when the grid is empty. */
  nearest(p: Vec2): number {
    if (this.count === 0) return -1
    const px = Number.isFinite(p.x) ? p.x : 0
    const pz = Number.isFinite(p.z) ? p.z : 0
    this.bestIndex = -1
    this.bestDistanceSq = Infinity

    const cx = clampInt(Math.floor((px - this.minX) / this.cell), 0, this.cols - 1)
    const cz = clampInt(Math.floor((pz - this.minZ) / this.cell), 0, this.rows - 1)
    const maxRing = Math.max(this.cols, this.rows)

    for (let r = 0; r <= maxRing; r++) {
      const x0 = cx - r
      const x1 = cx + r
      const z0 = cz - r
      const z1 = cz + r
      if (r === 0) {
        this.scanCell(cx, cz, px, pz)
      } else {
        for (let x = x0; x <= x1; x++) {
          this.scanCell(x, z0, px, pz)
          this.scanCell(x, z1, px, pz)
        }
        for (let z = z0 + 1; z <= z1 - 1; z++) {
          this.scanCell(x0, z, px, pz)
          this.scanCell(x1, z, px, pz)
        }
      }
      if (this.bestIndex >= 0) {
        // Distance to the nearest unscanned cell boundary; sides that already
        // ran past the grid edge can never yield a closer point.
        const left = x0 <= 0 ? Infinity : px - (this.minX + x0 * this.cell)
        const right = x1 >= this.cols - 1 ? Infinity : this.minX + (x1 + 1) * this.cell - px
        const near = z0 <= 0 ? Infinity : pz - (this.minZ + z0 * this.cell)
        const far = z1 >= this.rows - 1 ? Infinity : this.minZ + (z1 + 1) * this.cell - pz
        const safe = Math.min(left, right, near, far)
        if (safe > 0 && this.bestDistanceSq <= safe * safe) break
      }
    }

    if (this.bestIndex < 0) {
      // Degenerate geometry (e.g. non-finite coordinates); fall back to a scan.
      for (let i = 0; i < this.count; i++) {
        const dx = this.xs[i] - px
        const dz = this.zs[i] - pz
        const d2 = dx * dx + dz * dz
        if (d2 < this.bestDistanceSq) {
          this.bestDistanceSq = d2
          this.bestIndex = i
        }
      }
      if (this.bestIndex < 0) this.bestIndex = 0
    }
    return this.bestIndex
  }

  /** Straight-line distance to the point returned by the last `nearest` call. */
  lastDistance(): number {
    return Number.isFinite(this.bestDistanceSq) ? Math.sqrt(this.bestDistanceSq) : Infinity
  }

  private scanCell(x: number, z: number, px: number, pz: number): void {
    if (x < 0 || z < 0 || x >= this.cols || z >= this.rows) return
    const bucket = this.buckets[z * this.cols + x]
    if (!bucket) return
    for (let k = 0; k < bucket.length; k++) {
      const i = bucket[k]
      const dx = this.xs[i] - px
      const dz = this.zs[i] - pz
      const d2 = dx * dx + dz * dz
      if (d2 < this.bestDistanceSq) {
        this.bestDistanceSq = d2
        this.bestIndex = i
      }
    }
  }
}

function sanitiseBounds(bounds: CityBounds | null): CityBounds {
  if (
    bounds &&
    Number.isFinite(bounds.minX) &&
    Number.isFinite(bounds.maxX) &&
    Number.isFinite(bounds.minZ) &&
    Number.isFinite(bounds.maxZ) &&
    bounds.maxX > bounds.minX &&
    bounds.maxZ > bounds.minZ
  ) {
    return { minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: bounds.maxZ }
  }
  return { minX: -200, maxX: 200, minZ: -200, maxZ: 200 }
}

function parseFootprint(raw: unknown, container: Record<string, unknown>): Footprint | null {
  if (Array.isArray(raw)) {
    const width = toNumber(raw[0])
    const depth = toNumber(raw[1])
    if (width === null) return null
    return { width, depth: depth ?? width }
  }
  if (isRecord(raw)) {
    const width = toNumber(pick(raw, ['width', 'w', 'x', 'sizeX', 'dx']))
    const depth = toNumber(pick(raw, ['depth', 'd', 'z', 'sizeZ', 'dz', 'length']))
    if (width !== null || depth !== null) {
      const w = width ?? depth ?? DEFAULT_FOOTPRINT.width
      return { width: w, depth: depth ?? w }
    }
    return null
  }
  const square = toNumber(raw)
  if (square !== null) return { width: square, depth: square }
  // Fall back to sibling fields on the entity itself.
  const width = toNumber(pick(container, ['width', 'footprintWidth', 'sizeX']))
  const depth = toNumber(pick(container, ['depth', 'footprintDepth', 'sizeZ']))
  if (width !== null || depth !== null) {
    const w = width ?? depth ?? DEFAULT_FOOTPRINT.width
    return { width: w, depth: depth ?? w }
  }
  return null
}

/**
 * `yearBuilt` may arrive as a calendar year (1982) or as an age in years (42).
 * Anything below `AGE_YEAR_THRESHOLD` is treated as an age.
 */
function resolveYearBuilt(
  log: IssueLog,
  path: string,
  source: Record<string, unknown>,
): number {
  const ageRaw = toNumber(pick(source, ['buildingAge', 'age', 'ageYears']))
  if (ageRaw !== null) {
    const year =
      ageRaw < AGE_YEAR_THRESHOLD ? REFERENCE_YEAR - Math.abs(ageRaw) : ageRaw
    return clampInt(year, 1850, REFERENCE_YEAR)
  }
  const yearRaw = toNumber(pick(source, ['yearBuilt', 'year', 'built', 'constructionYear']))
  if (yearRaw === null) return DEFAULT_YEAR_BUILT
  if (yearRaw < AGE_YEAR_THRESHOLD) {
    // A "year" of 42 is an age; the schema allows both spellings on both keys.
    log.warn(
      'year-as-age',
      path,
      `yearBuilt ${yearRaw} read as an age; using ${REFERENCE_YEAR - Math.abs(yearRaw)}.`,
    )
    return clampInt(REFERENCE_YEAR - Math.abs(yearRaw), 1850, REFERENCE_YEAR)
  }
  if (yearRaw < 1850 || yearRaw > REFERENCE_YEAR) {
    return clampInt(
      clampNumber(log, path, 'yearBuilt', yearRaw, 1850, REFERENCE_YEAR),
      1850,
      REFERENCE_YEAR,
    )
  }
  return Math.round(yearRaw)
}

/**
 * Seismic resistance from the Japanese code milestones (1971 revision, the 1981
 * "new" standard, the 2000 timber revision), nudged by construction type.
 */
function deriveSeismicResistance(yearBuilt: number, construction: ConstructionType): number {
  const curve: [number, number][] = [
    [1950, 0.08],
    [1971, 0.2],
    [1981, 0.36],
    [1982, 0.56],
    [2000, 0.72],
    [2015, 0.85],
    [REFERENCE_YEAR, 0.9],
  ]
  let base = curve[0][1]
  if (yearBuilt >= curve[curve.length - 1][0]) {
    base = curve[curve.length - 1][1]
  } else {
    for (let i = 0; i < curve.length - 1; i++) {
      const [y0, v0] = curve[i]
      const [y1, v1] = curve[i + 1]
      if (yearBuilt >= y0 && yearBuilt < y1) {
        const span = y1 - y0
        const t = span > 0 ? (yearBuilt - y0) / span : 0
        base = v0 + (v1 - v0) * t
        break
      }
    }
  }
  return clamp(base + (CONSTRUCTION_SEISMIC_OFFSET[construction] ?? 0), 0.02, 0.99)
}

/** Normalises fractions to sum to 1, folding unknown keys onto known profiles. */
function parsePopulationProfile(
  log: IssueLog,
  path: string,
  raw: unknown,
  fallback: PopulationProfile,
): PopulationProfile {
  if (raw === undefined || raw === null) return { ...fallback }

  const totals: PopulationProfile = { child: 0, adult: 0, elderly: 0, mobilityImpaired: 0 }
  let matched = 0

  const consume = (key: string, value: unknown): void => {
    const amount = toNumber(value)
    if (amount === null || amount < 0) return
    const normalised = normaliseKey(key)
    let profile: AgentProfile | null = null
    for (const candidate of AGENT_PROFILES) {
      if (normaliseKey(candidate) === normalised) {
        profile = candidate
        break
      }
    }
    if (profile === null) {
      const synonym = PROFILE_SYNONYMS[normalised]
      if (synonym !== undefined) {
        profile = synonym
        log.warn('profile-key', path, `populationProfile key "${key}" mapped to "${synonym}".`)
      }
    }
    if (profile === null) {
      for (const candidate of AGENT_PROFILES) {
        const candidateKey = normaliseKey(candidate)
        if (normalised.includes(candidateKey) || candidateKey.includes(normalised)) {
          profile = candidate
          log.warn('profile-key', path, `populationProfile key "${key}" mapped to "${candidate}".`)
          break
        }
      }
    }
    if (profile === null) {
      log.warn('profile-key', path, `Unknown populationProfile key "${key}" ignored.`)
      return
    }
    totals[profile] += amount
    matched++
  }

  if (isRecord(raw)) {
    for (const key of Object.keys(raw)) consume(key, raw[key])
  } else if (Array.isArray(raw) && raw.length >= 4) {
    // Positional form, in AGENT_PROFILES order.
    for (let i = 0; i < AGENT_PROFILES.length; i++) consume(AGENT_PROFILES[i], raw[i])
  } else {
    log.warn('profile-shape', path, 'populationProfile is not an object; using the default.')
    return { ...fallback }
  }

  const sum = totals.child + totals.adult + totals.elderly + totals.mobilityImpaired
  if (matched === 0 || !(sum > 0) || !Number.isFinite(sum)) {
    log.warn('profile-empty', path, 'populationProfile has no usable fractions; using the default.')
    return { ...fallback }
  }
  if (Math.abs(sum - 1) > 0.01) {
    log.warn(
      'profile-sum',
      path,
      `populationProfile fractions sum to ${sum.toFixed(3)}; renormalised to 1.`,
    )
  }
  return {
    child: totals.child / sum,
    adult: totals.adult / sum,
    elderly: totals.elderly / sum,
    mobilityImpaired: totals.mobilityImpaired / sum,
  }
}

/** Unwraps module namespaces (`{ default: ... }`), `{ city: ... }` and JSON strings. */
function unwrapRoot(raw: unknown, log: IssueLog): Record<string, unknown> | null {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
      log.note('root', 'City data was supplied as a JSON string and has been parsed.')
    } catch {
      log.error('root', 'root', 'City data is a string that is not valid JSON.')
      return null
    }
  }
  for (let depth = 0; depth < 4; depth++) {
    if (!isRecord(value)) break
    const looksLikeCity =
      value['buildings'] !== undefined ||
      value['roadNetwork'] !== undefined ||
      value['roadGraph'] !== undefined ||
      value['roads'] !== undefined
    if (looksLikeCity) break
    let unwrapped = false
    for (const key of ['default', 'city', 'data']) {
      const inner = value[key]
      if (inner !== undefined && inner !== null) {
        log.note('root', `Unwrapped the city from a "${key}" wrapper.`)
        value = inner
        unwrapped = true
        break
      }
    }
    if (!unwrapped) break
  }
  if (!isRecord(value)) {
    log.error('root', 'root', 'City data must be a JSON object.')
    return null
  }
  return value
}

interface ParsedNodes {
  nodes: RoadNode[]
  byId: Map<string, number>
  explicitKind: Set<string>
}

function parseRoadNodes(raw: unknown, log: IssueLog): ParsedNodes {
  const entries = toEntryList(raw)
  const nodes: RoadNode[] = []
  const byId = new Map<string, number>()
  const explicitKind = new Set<string>()

  for (let i = 0; i < entries.length; i++) {
    const path = `roadNetwork.nodes[${i}]`
    const entry = entries[i]
    const record = isRecord(entry.value) ? entry.value : null
    const positionRaw = record ? pick(record, POSITION_KEYS) : undefined
    const position = normalizePosition(positionRaw !== undefined ? positionRaw : entry.value)
    if (!position) {
      log.error(
        'node-position',
        path,
        'Road node has no readable position; it cannot be placed in the network.',
      )
      continue
    }

    const id =
      (record ? toId(pick(record, ['id', 'nodeId', 'name'])) : null) ?? entry.key ?? `n${i}`
    if (byId.has(id)) {
      log.warn('duplicate-node', path, `Duplicate road node id "${id}"; the later one is dropped.`)
      continue
    }

    const kindResult = record
      ? readEnum(
          log,
          path,
          'road node kind',
          pick(record, ['kind', 'type', 'nodeType']),
          ['intersection', 'endpoint', 'waypoint'] as const,
          { junction: 'intersection', cross: 'intersection', deadend: 'endpoint', end: 'endpoint' },
          'waypoint',
        )
      : { value: 'waypoint' as const, explicit: false }
    if (kindResult.explicit) explicitKind.add(id)

    byId.set(id, nodes.length)
    nodes.push({ id, position, kind: kindResult.value })
  }

  return { nodes, byId, explicitKind }
}

/** Resolves a node reference given by id, or by index when the id is unknown. */
function resolveNodeRef(raw: unknown, nodes: RoadNode[], byId: Map<string, number>): string | null {
  const id = toId(raw)
  if (id !== null && byId.has(id)) return id
  const index = toNumber(raw)
  if (index !== null && Number.isInteger(index) && index >= 0 && index < nodes.length) {
    return nodes[index].id
  }
  return null
}

function classForWidth(width: number): RoadClass {
  if (width >= 18) return 'arterial'
  if (width >= 11) return 'collector'
  if (width >= 6) return 'local'
  return 'alley'
}

function parseRoadEdges(
  raw: unknown,
  nodes: RoadNode[],
  byId: Map<string, number>,
  log: IssueLog,
): RoadEdge[] {
  const entries = toEntryList(raw)
  const edges: RoadEdge[] = []
  const seenPairs = new Set<string>()
  const seenIds = new Set<string>()

  for (let i = 0; i < entries.length; i++) {
    const path = `roadNetwork.edges[${i}]`
    const entry = entries[i]
    let fromRaw: unknown
    let toRaw: unknown
    let record: Record<string, unknown> | null = null

    if (isRecord(entry.value)) {
      record = entry.value
      fromRaw = pick(record, ['from', 'a', 'start', 'source', 'u', 'n1'])
      toRaw = pick(record, ['to', 'b', 'end', 'target', 'v', 'n2'])
    } else if (Array.isArray(entry.value) && entry.value.length >= 2) {
      fromRaw = entry.value[0]
      toRaw = entry.value[1]
    }

    const from = resolveNodeRef(fromRaw, nodes, byId)
    const to = resolveNodeRef(toRaw, nodes, byId)
    if (from === null || to === null) {
      log.warn(
        'dropped-edge',
        path,
        `Road edge references unknown node(s) (from=${String(fromRaw)}, to=${String(toRaw)}); dropped.`,
      )
      continue
    }
    if (from === to) {
      log.warn('dropped-edge', path, `Road edge "${from}" -> "${to}" is a self-loop; dropped.`)
      continue
    }

    const pairKey = from < to ? `${from}|${to}` : `${to}|${from}`
    if (seenPairs.has(pairKey)) {
      log.warn(
        'duplicate-edge',
        path,
        `Duplicate road edge between "${from}" and "${to}"; collapsed into one.`,
      )
      continue
    }

    const fromIndex = byId.get(from)
    const toIndex = byId.get(to)
    if (fromIndex === undefined || toIndex === undefined) continue
    const length = distance(nodes[fromIndex].position, nodes[toIndex].position)
    if (!Number.isFinite(length) || length < MIN_EDGE_LENGTH) {
      log.warn(
        'dropped-edge',
        path,
        `Road edge between "${from}" and "${to}" has zero length; dropped.`,
      )
      continue
    }

    const widthRaw = record
      ? toNumber(pick(record, ['width', 'roadWidth', 'w', 'carriagewayWidth']))
      : null
    const classRaw = record ? pick(record, ['roadClass', 'class', 'type', 'category']) : undefined
    const hasClass = classRaw !== undefined && classRaw !== null
    const roadClass = hasClass
      ? readEnum(log, path, 'roadClass', classRaw, ROAD_CLASSES, ROAD_CLASS_SYNONYMS, 'local').value
      : widthRaw !== null
        ? classForWidth(widthRaw)
        : 'local'
    const width =
      widthRaw !== null
        ? clampNumber(log, path, 'road width', widthRaw, 1.5, 80)
        : ROAD_CLASS_WIDTH[roadClass]

    const lanesRaw = record ? toInteger(pick(record, ['lanes', 'laneCount'])) : null
    const lanes =
      lanesRaw !== null && lanesRaw > 0
        ? clampInt(lanesRaw, 1, 12)
        : Math.max(1, Math.round(width / 3.2))

    let id = (record ? toId(pick(record, ['id', 'edgeId'])) : null) ?? entry.key ?? `e${i}`
    if (seenIds.has(id)) {
      const unique = `${id}#${i}`
      log.warn('duplicate-edge-id', path, `Duplicate road edge id "${id}"; renamed to "${unique}".`)
      id = unique
    }
    seenIds.add(id)
    seenPairs.add(pairKey)
    edges.push({ id, from, to, width, roadClass, lanes, length })
  }

  return edges
}

function buildAdjacency(nodes: RoadNode[], edges: RoadEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>()
  for (const node of nodes) adjacency.set(node.id, [])
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to)
    adjacency.get(edge.to)?.push(edge.from)
  }
  return adjacency
}

function reachableFrom(adjacency: Map<string, string[]>, seeds: Iterable<string>): Set<string> {
  const seen = new Set<string>()
  const queue: string[] = []
  for (const seed of seeds) {
    if (adjacency.has(seed) && !seen.has(seed)) {
      seen.add(seed)
      queue.push(seed)
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const neighbours = adjacency.get(queue[head])
    if (!neighbours) continue
    for (const neighbour of neighbours) {
      if (!seen.has(neighbour)) {
        seen.add(neighbour)
        queue.push(neighbour)
      }
    }
  }
  return seen
}

interface ParsedBuilding {
  building: Building
  /** Raw `nearestRoadNodeId` / `roadNodeId`, resolved later against the nodes. */
  roadNodeRaw: unknown
}

function parseBuildings(raw: unknown, log: IssueLog): ParsedBuilding[] {
  const entries = toEntryList(raw)
  const parsed: ParsedBuilding[] = []
  const seenIds = new Set<string>()

  for (let i = 0; i < entries.length; i++) {
    const path = `buildings[${i}]`
    const entry = entries[i]
    if (!isRecord(entry.value)) {
      log.error('building-shape', path, 'Building entry is not an object.')
      continue
    }
    const source = entry.value

    const position = normalizePosition(pick(source, POSITION_KEYS))
    if (!position) {
      log.error('building-position', path, 'Building has no readable position.')
      continue
    }

    let id = toId(pick(source, ['id', 'buildingId'])) ?? entry.key ?? `b${i}`
    if (seenIds.has(id)) {
      const unique = `${id}#${i}`
      log.warn('duplicate-building-id', path, `Duplicate building id "${id}"; renamed to "${unique}".`)
      id = unique
    }
    seenIds.add(id)

    // --- footprint -------------------------------------------------------
    const footprintRaw = parseFootprint(pick(source, ['footprint', 'size', 'dimensions']), source)
    const footprint: Footprint = footprintRaw
      ? {
          width: clampNumber(log, path, 'footprint width', footprintRaw.width, 2, 400),
          depth: clampNumber(log, path, 'footprint depth', footprintRaw.depth, 2, 400),
        }
      : { ...DEFAULT_FOOTPRINT }

    // --- floors / height -------------------------------------------------
    const floorsRaw = toInteger(
      pick(source, ['floors', 'stories', 'storeys', 'numFloors', 'levels']),
    )
    const heightRaw = toNumber(pick(source, ['height', 'totalHeight', 'buildingHeight']))
    let floors: number
    if (floorsRaw !== null && floorsRaw > 0) {
      floors = clampInt(floorsRaw, 1, 120)
    } else if (heightRaw !== null && heightRaw > 0) {
      floors = clampInt(Math.round(heightRaw / FLOOR_HEIGHT), 1, 120)
    } else {
      floors = 2
    }

    // --- use / construction / roof ---------------------------------------
    const use = readEnum(
      log,
      path,
      'use',
      pick(source, ['use', 'type', 'category', 'usage', 'function']),
      BUILDING_USES,
      BUILDING_USE_SYNONYMS,
      'residential',
    ).value

    const constructionDefault: ConstructionType = floors <= 2 ? 'wood' : floors <= 8 ? 'rc' : 'steel'
    const constructionType = readEnum(
      log,
      path,
      'constructionType',
      pick(source, ['constructionType', 'structure', 'material', 'construction']),
      CONSTRUCTION_TYPES,
      CONSTRUCTION_SYNONYMS,
      constructionDefault,
    ).value

    const roofDefault: RoofType = floors <= 2 && constructionType === 'wood' ? 'gable' : 'flat'
    const roofType = readEnum(
      log,
      path,
      'roofType',
      pick(source, ['roofType', 'roof', 'roofShape']),
      ROOF_TYPES,
      ROOF_SYNONYMS,
      roofDefault,
    ).value

    let height: number
    if (heightRaw !== null && heightRaw > 0) {
      height = clampNumber(log, path, 'height', heightRaw, 2.2, 400)
      const minimumPlausible = floors * 2.2
      if (height < minimumPlausible) {
        log.warn(
          'height-floors',
          path,
          `height ${height} m is too low for ${floors} floors; raised to ${minimumPlausible.toFixed(1)} m.`,
        )
        height = minimumPlausible
      }
    } else {
      height = floors * FLOOR_HEIGHT + (roofType === 'flat' ? FLAT_ROOF_PARAPET : 0)
    }

    // --- rotation --------------------------------------------------------
    const rotationRaw = toNumber(
      pick(source, ['rotation', 'angle', 'heading', 'rotationY', 'yaw', 'orientation']),
    )
    const degreesField = pick(source, [
      'rotationDegrees',
      'rotationDeg',
      'angleDegrees',
      'headingDegrees',
    ])
    let rotation = rotationRaw ?? 0
    let inDegrees = false
    const degreesValue = toNumber(degreesField)
    if (degreesValue !== null) {
      rotation = degreesValue
      inDegrees = true
    } else if (degreesField === true) {
      inDegrees = true
    } else if (Math.abs(rotation) > 6.3) {
      inDegrees = true
    }
    if (inDegrees) rotation = (rotation * Math.PI) / 180
    rotation = wrapAngle(rotation)

    // --- derived quantities ----------------------------------------------
    const yearBuilt = resolveYearBuilt(log, path, source)

    const seismicRaw = toNumber(pick(source, ['seismicResistance', 'seismic', 'resistance']))
    const seismicResistance =
      seismicRaw !== null
        ? clampUnit(log, path, 'seismicResistance', seismicRaw, true)
        : deriveSeismicResistance(yearBuilt, constructionType)

    const thresholdRaw = toNumber(pick(source, ['collapseThreshold', 'threshold']))
    const collapseThreshold =
      thresholdRaw !== null
        ? clamp(clampUnit(log, path, 'collapseThreshold', thresholdRaw, true), 0.05, 0.995)
        : clamp(0.72 + 0.2 * seismicResistance, 0.05, 0.995)

    const floorArea = footprint.width * footprint.depth * floors

    const valueRaw = toNumber(pick(source, ['replacementValue', 'value', 'cost']))
    const replacementValue =
      valueRaw !== null && valueRaw > 0
        ? valueRaw
        : Math.max(1_000_000, Math.round(floorArea * (UNIT_COST[constructionType] ?? 250_000)))

    const occupancyRaw = toInteger(
      pick(source, ['occupancy', 'occupants', 'population', 'people', 'residents']),
    )
    const derivedOccupancy = Math.round(floorArea * (USE_OCCUPANT_DENSITY[use] ?? 0.04))
    const occupancy =
      occupancyRaw !== null && occupancyRaw >= 0
        ? clampInt(occupancyRaw, 0, 20_000)
        : clampInt(derivedOccupancy, use === 'parking' ? 0 : 1, 20_000)

    const populationProfile = parsePopulationProfile(
      log,
      path,
      pick(source, ['populationProfile', 'profile', 'demographics', 'population_profile']),
      USE_POPULATION_PROFILE[use] ?? USE_POPULATION_PROFILE.residential,
    )

    const igniteRaw = toNumber(
      pick(source, ['fireIgnitionProbability', 'ignitionProbability', 'fireRisk']),
    )
    const fireIgnitionProbability =
      igniteRaw !== null
        ? clampUnit(log, path, 'fireIgnitionProbability', igniteRaw, true)
        : constructionType === 'wood'
          ? 0.06
          : 0.02

    const districtId = toId(pick(source, ['districtId', 'district', 'zone', 'districtID']))
    const name = toText(pick(source, ['name', 'label'])) ?? `${USE_LABEL[use]} ${i + 1}`

    parsed.push({
      building: {
        id,
        name,
        position,
        rotation,
        footprint,
        floors,
        height,
        use,
        constructionType,
        yearBuilt,
        roofType,
        seismicResistance,
        collapseThreshold,
        replacementValue,
        occupancy,
        populationProfile,
        fireIgnitionProbability,
        fireResistance: clamp(toNumber(source.fireResistance) ?? (constructionType === 'wood' ? 0.3 : 0.8), 0, 1),
        evacuationDelaySeconds: toNumber(source.evacuationDelaySeconds),
        yearRetrofitted: toInteger(source.yearRetrofitted),
        groundZoneId: toId(source.groundZoneId),
        districtId,
        nearestRoadNodeId: null,
      },
      roadNodeRaw: pick(source, [
        'nearestRoadNodeId',
        'nearestRoadNode',
        'roadNodeId',
        'nearestNodeId',
        'roadNode',
        'nodeId',
      ]),
    })
  }

  return parsed
}

interface ParsedShelter {
  shelter: Shelter
  roadNodeRaw: unknown
}

function parseShelters(raw: unknown, log: IssueLog): ParsedShelter[] {
  const entries = toEntryList(raw)
  const parsed: ParsedShelter[] = []
  const seenIds = new Set<string>()

  for (let i = 0; i < entries.length; i++) {
    const path = `shelters[${i}]`
    const entry = entries[i]
    if (!isRecord(entry.value)) {
      log.error('shelter-shape', path, 'Shelter entry is not an object.')
      continue
    }
    const source = entry.value

    const position = normalizePosition(pick(source, POSITION_KEYS))
    if (!position) {
      log.error('shelter-position', path, 'Shelter has no readable position.')
      continue
    }

    let id = toId(pick(source, ['id', 'shelterId'])) ?? entry.key ?? `s${i}`
    if (seenIds.has(id)) {
      const unique = `${id}#${i}`
      log.warn('duplicate-shelter-id', path, `Duplicate shelter id "${id}"; renamed to "${unique}".`)
      id = unique
    }
    seenIds.add(id)

    const capacityRaw = toInteger(pick(source, ['capacity', 'maxOccupancy', 'places']))
    const capacity =
      capacityRaw !== null && capacityRaw > 0 ? clampInt(capacityRaw, 1, 200_000) : 500

    const kind = readEnum(
      log,
      path,
      'shelter kind',
      pick(source, ['kind', 'type', 'category', 'facilityType']),
      SHELTER_KINDS,
      SHELTER_KIND_SYNONYMS,
      'civic',
    ).value

    const footprintRaw = parseFootprint(pick(source, ['footprint', 'size', 'dimensions']), source)
    let footprint: Footprint
    if (footprintRaw) {
      footprint = {
        width: clampNumber(log, path, 'shelter footprint width', footprintRaw.width, 4, 400),
        depth: clampNumber(log, path, 'shelter footprint depth', footprintRaw.depth, 4, 400),
      }
    } else if (isRecord(source.bounds) && toNumber(source.bounds.maxX) !== null && toNumber(source.bounds.minX) !== null && toNumber(source.bounds.maxZ) !== null && toNumber(source.bounds.minZ) !== null) {
      footprint = {
        width: clamp(Number(source.bounds.maxX) - Number(source.bounds.minX), 4, 400),
        depth: clamp(Number(source.bounds.maxZ) - Number(source.bounds.minZ), 4, 400),
      }
    } else {
      // ~1.6 m2 of usable space per person, laid out as a slightly wide rectangle.
      const side = Math.sqrt(Math.max(16, capacity * 1.6))
      footprint = {
        width: clamp(side * 1.15, 8, 260),
        depth: clamp(side / 1.15, 8, 260),
      }
    }

    parsed.push({
      shelter: {
        id,
        name: toText(pick(source, ['name', 'label'])) ?? `Shelter ${i + 1}`,
        position,
        capacity,
        kind,
        footprint,
        roadNodeId: null,
      },
      roadNodeRaw: pick(source, ['roadNodeId', 'roadNode', 'nearestRoadNodeId', 'nearestNodeId', 'nodeId']),
    })
  }

  return parsed
}

function parseGroundZones(raw: unknown, log: IssueLog): GroundZone[] {
  const entries = toEntryList(raw)
  const zones: GroundZone[] = []

  for (let i = 0; i < entries.length; i++) {
    const path = `groundZones[${i}]`
    const entry = entries[i]
    const source = isRecord(entry.value) ? entry.value : null
    if (!source) {
      log.warn('dropped-zone', path, 'Ground zone entry is not an object; dropped.')
      continue
    }

    const polygonRaw = pick(source, ['polygon', 'points', 'boundary', 'outline', 'shape'])
    const polygon: Vec2[] = []
    if (Array.isArray(polygonRaw)) {
      for (const point of polygonRaw as unknown[]) {
        const parsedPoint = normalizePosition(point)
        if (parsedPoint) polygon.push(parsedPoint)
      }
    }
    if (polygon.length < 3) {
      log.warn(
        'dropped-zone',
        path,
        `Ground zone needs at least 3 polygon points (got ${polygon.length}); dropped.`,
      )
      continue
    }

    const groundType = readEnum(
      log,
      path,
      'groundType',
      pick(source, ['groundType', 'type', 'soil', 'soilType', 'ground']),
      GROUND_TYPES,
      GROUND_SYNONYMS,
      'medium',
    ).value

    const amplificationRaw = toNumber(pick(source, ['amplification', 'amp', 'factor']))
    const amplification =
      amplificationRaw !== null && amplificationRaw > 0
        ? clampNumber(log, path, 'amplification', amplificationRaw, 0.2, 4)
        : (GROUND_AMPLIFICATION[groundType] ?? 1)

    zones.push({
      id: toId(pick(source, ['id', 'zoneId'])) ?? entry.key ?? `ground-${i}`,
      name: toText(pick(source, ['name', 'label'])) ?? `Zone ${i + 1}`,
      groundType,
      amplification,
      polygon,
    })
  }

  return zones
}

function parseDistricts(raw: unknown, buildings: Building[], log: IssueLog): District[] {
  const entries = toEntryList(raw)
  const districts: District[] = []
  const seenIds = new Set<string>()

  // Centroids of the buildings that claim each district id.
  const sums = new Map<string, { x: number; z: number; count: number }>()
  for (const building of buildings) {
    const key = building.districtId
    if (key === null) continue
    const entry = sums.get(key)
    if (entry) {
      entry.x += building.position.x
      entry.z += building.position.z
      entry.count++
    } else {
      sums.set(key, { x: building.position.x, z: building.position.z, count: 1 })
    }
  }

  const centroidOf = (id: string): Vec2 | null => {
    const entry = sums.get(id)
    if (!entry || entry.count <= 0) return null
    return { x: entry.x / entry.count, z: entry.z / entry.count }
  }

  for (let i = 0; i < entries.length; i++) {
    const path = `districts[${i}]`
    const entry = entries[i]
    const source = isRecord(entry.value) ? entry.value : null
    if (!source) {
      log.warn('dropped-district', path, 'District entry is not an object; dropped.')
      continue
    }
    const id = toId(pick(source, ['id', 'districtId'])) ?? entry.key ?? `district-${i}`
    if (seenIds.has(id)) {
      log.warn('duplicate-district', path, `Duplicate district id "${id}"; the later one is dropped.`)
      continue
    }
    seenIds.add(id)

    const kind = readEnum(
      log,
      path,
      'district kind',
      pick(source, ['kind', 'type', 'category']),
      DISTRICT_KINDS,
      DISTRICT_KIND_SYNONYMS,
      'mixed',
    ).value

    const center =
      normalizePosition(pick(source, POSITION_KEYS)) ?? centroidOf(id) ?? { x: 0, z: 0 }
    const radiusRaw = toNumber(pick(source, ['radius', 'size', 'extent']))
    const radius =
      radiusRaw !== null && radiusRaw > 0 ? clampNumber(log, path, 'radius', radiusRaw, 5, 5000) : 150

    districts.push({
      id,
      name: toText(pick(source, ['name', 'label'])) ?? `District ${i + 1}`,
      kind,
      center,
      radius,
    })
  }

  // Buildings may reference districts the file never declared; synthesise them
  // rather than silently dropping the association.
  for (const [id, entry] of sums) {
    if (seenIds.has(id) || entry.count <= 0) continue
    const center = { x: entry.x / entry.count, z: entry.z / entry.count }
    let radius = 0
    for (const building of buildings) {
      if (building.districtId !== id) continue
      const d = distance(building.position, center)
      if (d > radius) radius = d
    }
    seenIds.add(id)
    log.warn(
      'missing-district',
      'districts',
      `Buildings reference undeclared district "${id}"; a district was synthesised for it.`,
    )
    districts.push({
      id,
      name: id,
      kind: 'mixed',
      center,
      radius: clamp(radius + 20, 20, 5000),
    })
  }

  return districts
}

function defaultEpicenter(bounds: CityBounds, seed: number, id: string): Vec2 {
  const centreX = (bounds.minX + bounds.maxX) / 2
  const centreZ = (bounds.minZ + bounds.maxZ) / 2
  const halfWidth = Math.max(1, (bounds.maxX - bounds.minX) / 2)
  const halfDepth = Math.max(1, (bounds.maxZ - bounds.minZ) / 2)
  // Deterministic bearing, so the same seed always shakes the same side hardest.
  const angle = hashUnit(seed, `epicenter:${id}`) * TAU
  return {
    x: centreX + Math.cos(angle) * halfWidth * 0.4,
    z: centreZ + Math.sin(angle) * halfDepth * 0.4,
  }
}

function synthesiseScenario(bounds: CityBounds, seed: number, index: number): DisasterScenario {
  const id = `scenario-${index}`
  return {
    id,
    type: 'earthquake',
    name: 'Earthquake',
    epicenter: defaultEpicenter(bounds, seed, id),
    depthKm: 12,
    magnitude: 7.1,
    baseIntensity: 1,
    intensityFalloff: 0.0011,
    durationSeconds: 40,
    aftershocks: [],
    intensityModel: 'exponential',
    aftershockProbability: 0,
    fireIgnitionProbability: 0.04,
  }
}

function parseAftershocks(raw: unknown, path: string, log: IssueLog): DisasterScenario['aftershocks'] {
  if (raw === undefined || raw === null) return []
  const entries = toEntryList(raw)
  const shocks: { time: number; intensityScale: number }[] = []
  for (let i = 0; i < entries.length; i++) {
    const value = entries[i].value
    let time: number | null = null
    let scale: number | null = null
    if (isRecord(value)) {
      time = toNumber(pick(value, ['time', 't', 'at', 'delay', 'offset']))
      scale = toNumber(pick(value, ['intensityScale', 'scale', 'intensity', 'strength']))
    } else if (Array.isArray(value) && value.length >= 2) {
      time = toNumber(value[0])
      scale = toNumber(value[1])
    }
    if (time === null) {
      log.warn('aftershock', `${path}.aftershocks[${i}]`, 'Aftershock has no readable time; dropped.')
      continue
    }
    shocks.push({
      time: clamp(time, 0, 24 * 3600),
      intensityScale: clamp(scale ?? 0.4, 0, 3),
    })
  }
  shocks.sort((a, b) => a.time - b.time)
  return shocks
}

function parseScenarios(
  raw: unknown,
  bounds: CityBounds,
  seed: number,
  log: IssueLog,
): DisasterScenario[] {
  const entries = toEntryList(raw)
  const scenarios: DisasterScenario[] = []
  const seenIds = new Set<string>()

  for (let i = 0; i < entries.length; i++) {
    const path = `disasterScenarios[${i}]`
    const entry = entries[i]
    const source = isRecord(entry.value) ? entry.value : null
    if (!source) {
      log.warn('dropped-scenario', path, 'Disaster scenario entry is not an object; dropped.')
      continue
    }

    let id = toId(pick(source, ['id', 'scenarioId'])) ?? entry.key ?? `scenario-${i}`
    if (seenIds.has(id)) {
      id = `${id}#${i}`
    }
    seenIds.add(id)

    const type = readEnum(
      log,
      path,
      'scenario type',
      pick(source, ['type', 'kind', 'disaster', 'disasterType']),
      SCENARIO_TYPES,
      SCENARIO_TYPE_SYNONYMS,
      'earthquake',
    ).value

    const epicenter =
      normalizePosition(pick(source, ['epicenter', 'epicentre', 'origin', 'hypocenter', 'center'])) ??
      defaultEpicenter(bounds, seed, id)

    const depthRaw = toNumber(pick(source, ['depthKm', 'depth']))
    const magnitudeRaw = toNumber(pick(source, ['magnitude', 'mag', 'moment']))
    const baseRaw = toNumber(pick(source, ['baseIntensity', 'intensity']))
    const falloffRaw = toNumber(pick(source, ['intensityFalloff', 'falloff', 'attenuation']))
    const durationRaw = toNumber(pick(source, ['durationSeconds', 'duration', 'length']))

    scenarios.push({
      id,
      type,
      name: toText(pick(source, ['name', 'label'])) ?? SCENARIO_TYPE_LABEL[type],
      epicenter,
      depthKm: depthRaw !== null ? clampNumber(log, path, 'depthKm', depthRaw, 0.5, 700) : 12,
      magnitude:
        magnitudeRaw !== null ? clampNumber(log, path, 'magnitude', magnitudeRaw, 3, 10) : 7.1,
      baseIntensity: baseRaw !== null ? clampNumber(log, path, 'baseIntensity', baseRaw, 0, 3) : 1,
      intensityFalloff:
        falloffRaw !== null
          ? clampNumber(log, path, 'intensityFalloff', falloffRaw, 0, 0.05)
          : 0.0011,
      durationSeconds:
        durationRaw !== null
          ? clampNumber(log, path, 'durationSeconds', durationRaw, 1, 600)
          : 40,
      intensityModel: source.intensityModel === 'linear' ? 'linear' : 'exponential',
      aftershockProbability: clamp(toNumber(source.aftershockProbability) ?? 0, 0, 1),
      fireIgnitionProbability: clamp(toNumber(source.fireIgnitionProbability) ?? 0.04, 0, 1),
      aftershocks: parseAftershocks(
        pick(source, ['aftershocks', 'afterShocks', 'replicas']),
        path,
        log,
      ),
    })
  }

  return scenarios
}

function fail(log: IssueLog): never {
  const issues = log.all()
  const first = issues.find((issue) => issue.severity === 'error')
  const detail = first ? `${first.path}: ${first.message}` : 'unknown problem'
  throw new CityLoadError(
    `City data is unusable (${log.fatalTotal()} fatal issue(s)). First: ${detail}`,
    issues,
  )
}

/**
 * Validates and normalises the raw city JSON.
 *
 * Throws `CityLoadError` when the data cannot produce a runnable city: no
 * buildings, no shelters, fewer than two road nodes, no usable road edges, an
 * unreadable position on a building / shelter / node, or a road network in
 * which not one building can reach any shelter. Everything else is repaired and
 * reported through `issues`.
 */
export function loadCity(raw: unknown): CityLoadResult {
  const log = new IssueLog()
  const root = unwrapRoot(raw, log)
  if (!root) fail(log)

  // --- road network ------------------------------------------------------
  const networkRaw = pick(root, ['roadNetwork', 'roads', 'roadGraph', 'network'])
  const networkRecord = isRecord(networkRaw) ? networkRaw : null
  const nodesRaw = networkRecord
    ? pick(networkRecord, ['nodes', 'vertices', 'points', 'roadNodes'])
    : pick(root, ['roadNodes', 'nodes'])
  const edgesRaw = networkRecord
    ? pick(networkRecord, ['edges', 'links', 'segments', 'roadEdges'])
    : pick(root, ['roadEdges', 'edges', 'links'])
  if (!networkRecord && networkRaw !== undefined) {
    log.warn('road-network', 'roadNetwork', 'roadNetwork is not an object; looked for top-level nodes/edges.')
  }

  const { nodes, byId, explicitKind } = parseRoadNodes(nodesRaw, log)
  const edges = parseRoadEdges(edgesRaw, nodes, byId, log)

  // --- entities ----------------------------------------------------------
  const parsedBuildings = parseBuildings(pick(root, ['buildings', 'structures']), log)
  const parsedShelters = parseShelters(
    pick(root, ['shelters', 'evacuationShelters', 'evacuation_shelters', 'refuges']),
    log,
  )
  const groundZones = parseGroundZones(
    pick(root, ['groundZones', 'zones', 'soilZones', 'groundTypes']),
    log,
  )

  // --- fatal structural checks ------------------------------------------
  if (parsedBuildings.length === 0) {
    log.error('no-buildings', 'buildings', 'The city has no usable buildings.')
  }
  if (parsedShelters.length === 0) {
    log.error('no-shelters', 'shelters', 'The city has no usable shelters.')
  }
  if (nodes.length < 2) {
    log.error(
      'no-road-nodes',
      'roadNetwork.nodes',
      `The road network needs at least 2 nodes (got ${nodes.length}).`,
    )
  }
  if (edges.length === 0) {
    log.error('no-road-edges', 'roadNetwork.edges', 'The road network has no usable edges.')
  }
  if (log.hasFatal()) fail(log)

  const buildings = parsedBuildings.map((entry) => entry.building)
  const shelters = parsedShelters.map((entry) => entry.shelter)

  // --- node kinds from degree -------------------------------------------
  const degree = new Map<string, number>()
  for (const node of nodes) degree.set(node.id, 0)
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  let isolatedNodes = 0
  for (const node of nodes) {
    const d = degree.get(node.id) ?? 0
    if (d === 0) isolatedNodes++
    if (explicitKind.has(node.id)) continue
    node.kind = d >= 3 ? 'intersection' : d === 2 ? 'waypoint' : 'endpoint'
  }
  if (isolatedNodes > 0) {
    log.note(
      'roadNetwork.nodes',
      `${isolatedNodes} road node(s) have no edges; they are ignored when attaching buildings.`,
    )
  }

  // --- meta / bounds -----------------------------------------------------
  const metaCandidate = pick(root, ['meta', 'metadata', 'info'])
  const metaRaw = isRecord(metaCandidate) ? metaCandidate : {}
  const seedRaw = toNumber(pick(metaRaw, ['simulationSeed', 'seed'])) ?? toNumber(pick(root, ['simulationSeed', 'seed']))
  const simulationSeed =
    seedRaw !== null ? Math.abs(Math.round(seedRaw)) % 4_294_967_296 || DEFAULT_SEED : DEFAULT_SEED

  let contentMinX = Infinity
  let contentMaxX = -Infinity
  let contentMinZ = Infinity
  let contentMaxZ = -Infinity
  const trackPoint = (p: Vec2, pad: number): void => {
    if (p.x - pad < contentMinX) contentMinX = p.x - pad
    if (p.x + pad > contentMaxX) contentMaxX = p.x + pad
    if (p.z - pad < contentMinZ) contentMinZ = p.z - pad
    if (p.z + pad > contentMaxZ) contentMaxZ = p.z + pad
  }
  for (const building of buildings) {
    trackPoint(building.position, Math.max(building.footprint.width, building.footprint.depth) * 0.5)
  }
  for (const node of nodes) trackPoint(node.position, 0)
  for (const shelter of shelters) {
    trackPoint(shelter.position, Math.max(shelter.footprint.width, shelter.footprint.depth) * 0.5)
  }
  const computedBounds = sanitiseBounds(
    Number.isFinite(contentMinX)
      ? {
          minX: contentMinX - BOUNDS_MARGIN,
          maxX: contentMaxX + BOUNDS_MARGIN,
          minZ: contentMinZ - BOUNDS_MARGIN,
          maxZ: contentMaxZ + BOUNDS_MARGIN,
        }
      : null,
  )

  const boundsRaw = pick(metaRaw, ['bounds', 'extent', 'bbox'])
  let bounds = computedBounds
  if (isRecord(boundsRaw)) {
    const declared = {
      minX: toNumber(pick(boundsRaw, ['minX', 'xMin', 'left'])) ?? Number.NaN,
      maxX: toNumber(pick(boundsRaw, ['maxX', 'xMax', 'right'])) ?? Number.NaN,
      minZ: toNumber(pick(boundsRaw, ['minZ', 'zMin', 'top'])) ?? Number.NaN,
      maxZ: toNumber(pick(boundsRaw, ['maxZ', 'zMax', 'bottom'])) ?? Number.NaN,
    }
    const usable =
      Number.isFinite(declared.minX) &&
      Number.isFinite(declared.maxX) &&
      Number.isFinite(declared.minZ) &&
      Number.isFinite(declared.maxZ) &&
      declared.maxX > declared.minX &&
      declared.maxZ > declared.minZ
    if (!usable) {
      log.warn('bounds', 'meta.bounds', 'meta.bounds is unusable; recomputed from the content.')
    } else {
      const expanded: CityBounds = {
        minX: Math.min(declared.minX, computedBounds.minX),
        maxX: Math.max(declared.maxX, computedBounds.maxX),
        minZ: Math.min(declared.minZ, computedBounds.minZ),
        maxZ: Math.max(declared.maxZ, computedBounds.maxZ),
      }
      if (
        expanded.minX !== declared.minX ||
        expanded.maxX !== declared.maxX ||
        expanded.minZ !== declared.minZ ||
        expanded.maxZ !== declared.maxZ
      ) {
        log.warn('bounds', 'meta.bounds', 'meta.bounds did not contain the whole city; expanded.')
      }
      bounds = sanitiseBounds(expanded)
    }
  } else if (boundsRaw !== undefined) {
    log.warn('bounds', 'meta.bounds', 'meta.bounds is not an object; recomputed from the content.')
  }

  const meta: CityMeta = {
    name: toText(pick(metaRaw, ['name', 'cityName', 'title'])) ?? 'AOBA CITY',
    version: toText(pick(metaRaw, ['version', 'schemaVersion'])) ?? '1.0.0',
    generatedBy: toText(pick(metaRaw, ['generatedBy', 'generator', 'author'])) ?? 'unknown',
    bounds,
    simulationSeed,
  }

  // --- districts and scenarios ------------------------------------------
  const districts = parseDistricts(pick(root, ['districts', 'wards', 'areas']), buildings, log)
  const scenarios = parseScenarios(
    pick(root, ['disasterScenarios', 'scenarios', 'disasters']),
    bounds,
    simulationSeed,
    log,
  )
  if (typeof metaRaw.groundIntensityInterpretation === 'string' && metaRaw.groundIntensityInterpretation.includes('Subtract intensityFalloff')) {
    for (const scenario of scenarios) scenario.intensityModel = 'linear'
  }

  if (scenarios.length === 0) {
    log.note(
      'disasterScenarios',
      'No disaster scenarios in the data; a default M7.1 earthquake was synthesised.',
    )
    scenarios.push(synthesiseScenario(bounds, simulationSeed, 0))
  } else if (!scenarios.some((scenario) => scenario.type === 'earthquake')) {
    log.note(
      'disasterScenarios',
      'No earthquake scenario in the data; a default M7.1 earthquake was appended.',
    )
    scenarios.push(synthesiseScenario(bounds, simulationSeed, scenarios.length))
  }

  // --- attach buildings and shelters to the road network -----------------
  const connectedIndices: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    if ((degree.get(nodes[i].id) ?? 0) > 0) connectedIndices.push(i)
  }
  if (connectedIndices.length === 0) {
    log.error(
      'no-road-edges',
      'roadNetwork',
      'No road node is attached to an edge; the network is unusable.',
    )
    fail(log)
  }
  const grid = new PointGrid(connectedIndices.map((index) => nodes[index].position))

  const attach = (
    position: Vec2,
    declaredRaw: unknown,
    path: string,
  ): { nodeId: string; distanceToRoad: number } => {
    const declared = resolveNodeRef(declaredRaw, nodes, byId)
    if (declared !== null && (degree.get(declared) ?? 0) > 0) {
      const index = byId.get(declared)
      const nodePosition = index !== undefined ? nodes[index].position : position
      return { nodeId: declared, distanceToRoad: distance(position, nodePosition) }
    }
    if (declaredRaw !== undefined && declaredRaw !== null) {
      log.warn(
        'bad-road-node-ref',
        path,
        `Road node "${String(declaredRaw)}" is unknown or unconnected; the nearest node was used instead.`,
      )
    }
    const gridIndex = grid.nearest(position)
    const nodeIndex = connectedIndices[gridIndex >= 0 ? gridIndex : 0]
    return { nodeId: nodes[nodeIndex].id, distanceToRoad: grid.lastDistance() }
  }

  let farFromRoad = 0
  for (let i = 0; i < shelters.length; i++) {
    const attached = attach(shelters[i].position, parsedShelters[i].roadNodeRaw, `shelters[${i}]`)
    shelters[i].roadNodeId = attached.nodeId
    if (attached.distanceToRoad > FAR_FROM_ROAD_DISTANCE) {
      log.warn(
        'far-from-road',
        `shelters[${i}]`,
        `Shelter "${shelters[i].id}" is ${attached.distanceToRoad.toFixed(0)} m from the nearest road node.`,
      )
      farFromRoad++
    }
  }
  for (let i = 0; i < buildings.length; i++) {
    const attached = attach(buildings[i].position, parsedBuildings[i].roadNodeRaw, `buildings[${i}]`)
    buildings[i].nearestRoadNodeId = attached.nodeId
    if (attached.distanceToRoad > FAR_FROM_ROAD_DISTANCE) {
      log.warn(
        'far-from-road',
        `buildings[${i}]`,
        `Building "${buildings[i].id}" is ${attached.distanceToRoad.toFixed(0)} m from the nearest road node.`,
      )
      farFromRoad++
    }
  }
  if (farFromRoad > 0) {
    log.note(
      'roadNetwork',
      `${farFromRoad} entit(ies) are more than ${FAR_FROM_ROAD_DISTANCE} m from any road node.`,
    )
  }

  // --- reachability ------------------------------------------------------
  const adjacency = buildAdjacency(nodes, edges)
  const shelterNodes: string[] = []
  for (const shelter of shelters) {
    if (shelter.roadNodeId !== null) shelterNodes.push(shelter.roadNodeId)
  }
  const reachable = reachableFrom(adjacency, shelterNodes)
  let strandedBuildings = 0
  for (const building of buildings) {
    const nodeId = building.nearestRoadNodeId
    if (nodeId === null || !reachable.has(nodeId)) strandedBuildings++
  }
  if (strandedBuildings >= buildings.length) {
    log.error(
      'unreachable',
      'roadNetwork',
      'No building can reach any shelter across the road network.',
    )
    fail(log)
  }
  if (strandedBuildings > 0) {
    log.note(
      'roadNetwork',
      `${strandedBuildings} of ${buildings.length} building(s) sit on a road component with no shelter; their occupants cannot evacuate.`,
    )
  }

  const roadNetwork: RoadNetwork = { nodes, edges }
  const city: CityModel = {
    meta,
    districts,
    groundZones,
    roadNetwork,
    buildings,
    shelters,
    disasterScenarios: scenarios,
  }

  return { city, issues: log.all() }
}

/**
 * The scenario the EARTHQUAKE button runs: the first `earthquake`, else the
 * first scenario of any type, else a default synthesised from the city bounds.
 */
export function primaryEarthquake(city: CityModel): DisasterScenario {
  const scenarios = city.disasterScenarios
  for (const scenario of scenarios) {
    if (scenario && scenario.type === 'earthquake') return scenario
  }
  if (scenarios.length > 0 && scenarios[0]) return scenarios[0]
  const seed = Number.isFinite(city.meta.simulationSeed) ? city.meta.simulationSeed : DEFAULT_SEED
  return synthesiseScenario(sanitiseBounds(city.meta.bounds), seed, 0)
}
