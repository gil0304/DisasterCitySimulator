/**
 * §14 — the city's colour vocabulary.
 *
 * The palette is a muted, overcast-daylight one: everything sits in a narrow
 * band of desaturated warm greys and stone tones. There are deliberately **no**
 * red / orange / yellow alert colours anywhere. Damage is communicated purely
 * by *value* (things get darker and greyer) and by geometry (things fall over),
 * never by hue. That keeps the model reading as a physical miniature rather
 * than as a dashboard.
 *
 * Colours are authored as sRGB hex strings. `three`'s colour management
 * converts them into the linear working space when a `Color` is built from one,
 * so every numeric operation in this file happens in linear light.
 */

import type { Color } from 'three'
import type { AgentProfile, BuildingUse } from '../types/city'
import type { DamageState } from '../types/simulation'

/** Wall / body colour per building use. */
export const USE_COLORS: Record<BuildingUse, string> = {
  residential: '#d8cbb8',
  apartment: '#cac7bf',
  office: '#b6babe',
  commercial: '#d4cfc2',
  retail: '#d9d2c4',
  school: '#e3ded1',
  hospital: '#eeece7',
  factory: '#8e9195',
  civic: '#c8c3b5',
  station: '#bfc1c1',
  temple: '#b9aa95',
  parking: '#a9aaa5',
}

/** Roof / cap colour per building use — always darker than the wall. */
export const ROOF_COLORS: Record<BuildingUse, string> = {
  residential: '#7c7267',
  apartment: '#9a978f',
  office: '#83878b',
  commercial: '#918e87',
  retail: '#948f86',
  school: '#9d988c',
  hospital: '#bcbab4',
  factory: '#6e7175',
  civic: '#8a8578',
  station: '#888b8b',
  temple: '#5c554c',
  parking: '#85857e',
}

export const GROUND_COLOR = '#b9b8a4'
export const ROAD_COLOR = '#84857f'
export const SHELTER_COLOR = '#9cb2a4'

/** Glazing. Used for window bands, shopfronts and north-light factory roofs. */
export const WINDOW_COLOR = '#4e565c'
/** Deeper glazing for recessed ground floors and openings. */
export const WINDOW_DARK_COLOR = '#3b4146'
/** Collapsed-building debris, and rubble spilled onto roads. */
export const RUBBLE_COLOR = '#7b746a'

export const AGENT_COLORS: Record<AgentProfile | 'sheltered' | 'trapped' | 'injured', string> = {
  adult: '#4f5763',
  child: '#6d8091',
  elderly: '#7b7365',
  mobilityImpaired: '#6a6478',
  sheltered: '#7ea390',
  trapped: '#57503f',
  injured: '#8b7370',
}

/** §14 — multiplicative brightness per damage state. */
export const DAMAGE_VALUE: Record<DamageState, number> = {
  intact: 1,
  minor: 0.86,
  major: 0.68,
  severe: 0.5,
  collapsed: 0.34,
}

/** How much of the remaining chroma is drained as a surface darkens. */
const DESATURATION = 0.75

/** Soot: near-black with a faint warm bias so charring doesn't read as blue. */
const SOOT_R = 0.085
const SOOT_G = 0.07
const SOOT_B = 0.06
/** Even a fully burnt-out shell keeps a little of its own colour. */
const SOOT_STRENGTH = 0.88

/** Rec.709 luminance weights (the working colour space is linear sRGB). */
const LUM_R = 0.2126
const LUM_G = 0.7152
const LUM_B = 0.0722

/**
 * The damage tint is affine in the source colour, so it can be collapsed into a
 * single 3×3 matrix plus an offset. That lets `buildingGeometry` re-tint a few
 * thousand vertex colours with a tight arithmetic loop instead of a per-vertex
 * `Color` round-trip.
 */
export interface TintTransform {
  /** Row-major 3×3, applied to (r, g, b). */
  m: Float32Array
  /** Additive per-channel offset (the soot term). */
  o: Float32Array
}

export function createTintTransform(): TintTransform {
  const t: TintTransform = { m: new Float32Array(9), o: new Float32Array(3) }
  t.m[0] = 1
  t.m[4] = 1
  t.m[8] = 1
  return t
}

/** Fills `out` with the value + desaturation + soot ramp for this state. */
export function damageTintTransform(
  state: DamageState,
  burn: number,
  out: TintTransform,
): TintTransform {
  const raw = DAMAGE_VALUE[state]
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1
  // NaN-safe clamp: the comparison is false for NaN, so `b` falls back to 0.
  const b = burn > 0 ? (burn < 1 ? burn : 1) : 0
  const t = b * SOOT_STRENGTH
  const k = (1 - value) * DESATURATION
  const keep = 1 - k
  const s = (1 - t) * value

  const m = out.m
  m[0] = s * (keep + k * LUM_R)
  m[1] = s * (k * LUM_G)
  m[2] = s * (k * LUM_B)
  m[3] = s * (k * LUM_R)
  m[4] = s * (keep + k * LUM_G)
  m[5] = s * (k * LUM_B)
  m[6] = s * (k * LUM_R)
  m[7] = s * (k * LUM_G)
  m[8] = s * (keep + k * LUM_B)

  const o = out.o
  o[0] = t * SOOT_R
  o[1] = t * SOOT_G
  o[2] = t * SOOT_B
  return out
}

const scratchTransform = createTintTransform()

/**
 * §14 — darkens (and desaturates) `base` according to the damage state, then
 * mixes toward soot by `burn` (0..1). Writes into `out` and returns it.
 */
export function damageTint(base: Color, state: DamageState, burn: number, out: Color): Color {
  const { m, o } = damageTintTransform(state, burn, scratchTransform)
  const r = base.r
  const g = base.g
  const b = base.b
  out.setRGB(
    m[0] * r + m[1] * g + m[2] * b + o[0],
    m[3] * r + m[4] * g + m[5] * b + o[1],
    m[6] * r + m[7] * g + m[8] * b + o[2],
  )
  return out
}

/** Safe lookup — the data may carry a use string we don't know about. */
export function wallColorFor(use: BuildingUse): string {
  const hex = USE_COLORS[use]
  return typeof hex === 'string' ? hex : USE_COLORS.residential
}

export function roofColorFor(use: BuildingUse): string {
  const hex = ROOF_COLORS[use]
  return typeof hex === 'string' ? hex : ROOF_COLORS.residential
}
