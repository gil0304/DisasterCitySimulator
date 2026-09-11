/**
 * §51 — the end-of-run summary.
 *
 * A quiet left-hand panel, not a modal: the city stays fully visible and fully
 * interactive behind it. The figures count up once over ~1.2 s, driven by a
 * single rAF progress value sampled at 30 Hz so React re-renders the panel
 * about 36 times in total rather than once per number per frame.
 */

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useSimulationStore } from '../store/simulationStore'
import type { SimulationPhase } from '../types/simulation'

const COUNT_UP_MS = 1200
const EMIT_INTERVAL_MS = 1000 / 30

function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const minutes = Math.floor(total / 60)
  const rest = total - minutes * 60
  const mm = minutes < 10 ? `0${minutes}` : String(minutes)
  const ss = rest < 10 ? `0${rest}` : String(rest)
  return `${mm}:${ss}`
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.round(Math.max(0, value)).toLocaleString('en-US')
}

function formatJpy(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '¥0'
  if (value >= 1e12) return `¥${(value / 1e12).toFixed(1)}T`
  if (value >= 1e9) return `¥${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `¥${(value / 1e6).toFixed(1)}M`
  return `¥${Math.round(value).toLocaleString('en-US')}`
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function ResultDisplay(): JSX.Element | null {
  const snapshot = useSimulationStore((s) => s.snapshot)
  const phase = snapshot.phase
  const [reduceMotion] = useState(prefersReducedMotion)
  const [run, setRun] = useState<{ phase: SimulationPhase; progress: number }>(() => ({
    phase,
    progress: 0,
  }))

  // Render-phase reset: a RESET followed by a second run replays the count-up.
  if (run.phase !== phase) {
    setRun({ phase, progress: phase === 'finished' && reduceMotion ? 1 : 0 })
  }

  useEffect(() => {
    if (phase !== 'finished' || reduceMotion) return
    let frame = 0
    let startedAt = -1
    let lastEmit = -Infinity
    // One progress value, sampled at 30 Hz; every figure is derived from it.
    const tick = (now: number) => {
      if (startedAt < 0) startedAt = now
      const t = clamp01((now - startedAt) / COUNT_UP_MS)
      if (t >= 1) {
        setRun({ phase: 'finished', progress: 1 })
        return
      }
      if (now - lastEmit >= EMIT_INTERVAL_MS) {
        lastEmit = now
        setRun({ phase: 'finished', progress: t })
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [phase, reduceMotion])

  if (phase !== 'finished') return null

  const stats = snapshot.stats
  const inv = 1 - (run.phase === 'finished' ? run.progress : 0)
  const eased = 1 - inv * inv * inv

  const figures: { label: string; value: string }[] = [
    { label: 'Evacuated', value: formatCount(stats.evacuated * eased) },
    { label: 'Sheltered', value: formatCount(stats.sheltered * eased) },
    { label: 'Trapped', value: formatCount(stats.trapped * eased) },
    { label: 'Injured', value: formatCount(stats.injured * eased) },
    { label: '半壊 / 大破', value: `${formatCount(stats.majorBuildings * eased)} / ${formatCount(stats.severeBuildings * eased)}` },
    { label: 'Fatalities', value: formatCount(stats.fatalities * eased) },
    {
      label: 'Collapsed',
      value: `${formatCount(stats.collapsedBuildings * eased)} / ${formatCount(
        stats.totalBuildings,
      )}`,
    },
    {
      label: 'Road blockage',
      value: `${Math.round(clamp01(stats.roadBlockageRatio) * 100 * eased)}%`,
    },
    { label: 'Economic loss', value: formatJpy(stats.economicLoss * eased) },
  ]

  return (
    <div className="result-layer">
      <section className="result" aria-label="Simulation result">
        <div className="result-clock">{formatClock(snapshot.time)}</div>
        <div className="result-caption">Elapsed</div>
        <div className="result-figures">
          {figures.map((figure) => (
            <div key={figure.label}>
              <div className="result-label">{figure.label}</div>
              <div className="result-value">{figure.value}</div>
            </div>
          ))}
        </div>
        <p className="result-note">Simulation model — not a real-world prediction</p>
      </section>
    </div>
  )
}
