/**
 * Deterministic pseudo-random numbers (§27).
 *
 * Everything stochastic in the simulation draws from a seeded stream so that
 * the same `simulationSeed` always produces the same disaster — including
 * after RESET.
 */

/** 32-bit string hash, used to derive stable per-entity sub-seeds. */
export function hashString(str: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** Mix two integers into a new 32-bit seed. */
export function mixSeed(a: number, b: number): number {
  let h = (a ^ Math.imul(b ^ 0x9e3779b9, 0x85ebca6b)) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x2545f491) >>> 0
  h ^= h >>> 13
  return h >>> 0
}

export class Rng {
  private state: number

  constructor(seed: number) {
    this.state = (seed >>> 0) || 0x9e3779b9
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1))
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p
  }

  /** Approximately standard-normal (Irwin–Hall, mean 0, sd ~1). */
  normal(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.1547
  }

  /** Normal clamped to [min, max]. */
  clampedNormal(mean: number, sd: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, mean + this.normal() * sd))
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))]
  }

  /** Pick an index from a weight array (weights need not be normalised). */
  weightedIndex(weights: readonly number[]): number {
    let total = 0
    for (let i = 0; i < weights.length; i++) total += Math.max(0, weights[i])
    if (total <= 0) return 0
    let r = this.next() * total
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i])
      if (r <= 0) return i
    }
    return weights.length - 1
  }

  /** Fisher–Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      const tmp = items[i]
      items[i] = items[j]
      items[j] = tmp
    }
    return items
  }

  /** Derive an independent stream, stable for a given key. */
  fork(key: string): Rng {
    return new Rng(mixSeed(this.state, hashString(key)))
  }
}

/** A stream keyed by seed + label, reproducible without ordering constraints. */
export function streamFor(seed: number, label: string): Rng {
  return new Rng(mixSeed(seed, hashString(label)))
}

/** Deterministic value in [0,1) from a seed and an arbitrary key — no state. */
export function hashUnit(seed: number, key: string): number {
  return new Rng(mixSeed(seed, hashString(key))).next()
}
