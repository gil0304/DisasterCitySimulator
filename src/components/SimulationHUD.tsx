/**
 * §5, §6, §7, §46, §48, §53, §54 — the DOM overlay.
 *
 * Rendered as a sibling of <Canvas>, never inside it. Deliberately minimal:
 * an identity mark and clock, a disclaimer, one row of controls, a compact
 * stat block and the click-to-inspect card. The city carries everything else.
 */

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { DISASTER_LABELS } from '../simulation/EnvironmentalDisaster'
import type { DisasterType } from '../simulation/EnvironmentalDisaster'
import { useSimulationStore } from '../store/simulationStore'
import type { SelectedBuildingInfo, SelectedShelterInfo } from '../types/simulation'

/** Card footprint used for on-screen clamping; matches `.card` in index.css. */
const CARD_WIDTH = 200
const CARD_HEIGHT = 180
const CARD_OFFSET = 14
const VIEWPORT_MARGIN = 8

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

/** ¥1,240 / ¥8.2M / ¥8.2B / ¥8.2T — never more than four significant glyphs. */
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

function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1280 : window.innerWidth,
    height: typeof window === 'undefined' ? 720 : window.innerHeight,
  }))
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

function StatRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  )
}

function SelectionCard({
  selection,
  onClose,
}: {
  selection: SelectedBuildingInfo | SelectedShelterInfo
  onClose: () => void
}): JSX.Element {
  const viewport = useViewport()

  // Keep the whole card on screen; if the window is narrower than the card the
  // margin wins so it is still anchored rather than pushed off the left edge.
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - CARD_WIDTH - VIEWPORT_MARGIN)
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - CARD_HEIGHT - VIEWPORT_MARGIN)
  const rawX = Number.isFinite(selection.screenX) ? selection.screenX : 0
  const rawY = Number.isFinite(selection.screenY) ? selection.screenY : 0
  const left = Math.min(maxLeft, Math.max(VIEWPORT_MARGIN, rawX + CARD_OFFSET))
  const top = Math.min(maxTop, Math.max(VIEWPORT_MARGIN, rawY + CARD_OFFSET))

  if (selection.kind === 'shelter') {
    const capacity = selection.capacity > 0 ? selection.capacity : 0
    const occupancy = Number.isFinite(selection.occupancy) ? Math.max(0, selection.occupancy) : 0
    const fill = capacity > 0 ? clamp01(occupancy / capacity) : 0
    return (
      <div
        className="card"
        style={{ left, top }}
        onClick={onClose}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onClose()
        }}
        role="button"
        tabIndex={0}
        aria-label={`${selection.name} — click to dismiss`}
      >
        <div className="card-title">{selection.name}</div>
        <div className="card-sub">Shelter</div>
        <div className="card-rule" />
        <div className="card-count">
          {formatCount(occupancy)} / {formatCount(capacity)}
        </div>
        <div className="card-bar">
          <div className="card-bar-fill" style={{ width: `${(fill * 100).toFixed(1)}%` }} />
        </div>
      </div>
    )
  }

  const seismic = Number.isFinite(selection.seismicResistance)
    ? selection.seismicResistance.toFixed(2)
    : '—'

  return (
    <div
      className="card"
      style={{ left, top }}
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onClose()
      }}
      role="button"
      tabIndex={0}
      aria-label={`${selection.name} — click to dismiss`}
    >
      <div className="card-title">{selection.name}</div>
      <div className="card-sub">
        {selection.use} · Built {Number.isFinite(selection.yearBuilt) ? selection.yearBuilt : '—'}
      </div>
      <div className="card-rule" />
      <div className="card-line">
        <span>Occupancy</span>
        <span>{formatCount(selection.occupancy)}</span>
      </div>
      <div className="card-line">
        <span>Seismic</span>
        <span>{seismic}</span>
      </div>
      <div className="card-line">
        <span>Damage</span>
        <span className="card-state">{{ intact: '無被害', minor: '軽微', major: '半壊・中破', severe: '大破', collapsed: '全壊' }[selection.damageState]}</span>
      </div>
    </div>
  )
}

export function SimulationHUD(): JSX.Element {
  const snapshot = useSimulationStore((s) => s.snapshot)
  const selection = useSimulationStore((s) => s.selection)
  const debug = useSimulationStore((s) => s.debug)

  // Zustand actions are stable references, so selecting them adds no renders.
  const triggerDisaster = useSimulationStore((s) => s.triggerDisaster)
  const engine = useSimulationStore((s) => s.engine)
  const [chosenDisaster, setChosenDisaster] = useState<DisasterType>('earthquake')
  const togglePause = useSimulationStore((s) => s.togglePause)
  const cycleSpeed = useSimulationStore((s) => s.cycleSpeed)
  const reset = useSimulationStore((s) => s.reset)
  const setSelection = useSimulationStore((s) => s.setSelection)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Shift is not excluded so that a capital "D" still reaches us.
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        if (target.isContentEditable) return
      }
      const store = useSimulationStore.getState()
      if (event.key === 'd' || event.key === 'D') {
        event.preventDefault()
        store.toggleDebug()
      } else if (event.key === ' ' || event.key === 'Spacebar') {
        if (store.snapshot.phase === 'idle') return
        event.preventDefault()
        store.togglePause()
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault()
        store.reset()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  let liveSelection = selection
  if (selection?.kind === 'building') {
    const b = engine?.buildings.find(b => b.id === selection.id)
    if (b) liveSelection = { ...selection, damageState: b.state, damageScore: b.damageScore }
  } else if (selection?.kind === 'shelter') {
    const s = engine?.shelters.find(s => s.id === selection.id)
    if (s) liveSelection = { ...selection, occupancy: s.occupancy, capacity: s.capacity }
  }
  const stats = snapshot.stats
  const idle = snapshot.phase === 'idle'
  // The result panel restates every one of these, so the block steps aside.
  const showStats = !idle && snapshot.phase !== 'finished'
  const speed = Number.isFinite(snapshot.speed) ? Math.round(snapshot.speed) : 1

  return (
    <div className="hud">
      <div className="hud-tl">
        <div className="hud-mark">Aoba City</div>
        <div className="hud-submark">Disaster Simulation</div>
        <div className="hud-clock">{formatClock(snapshot.time)}</div>
        {!idle && <div className="hud-disaster">{DISASTER_LABELS[snapshot.disasterType]}{snapshot.paused ? ' · 一時停止' : snapshot.phase === 'finished' ? ' · 終了' : ''}</div>}
      </div>

      <div className="hud-tr">
        <div className="hud-note">Simulation model</div>
        <div className="hud-note">Not a real-world prediction</div>
        {debug ? <div className="hud-note hud-note-active">Debug</div> : null}
      </div>

      {showStats ? (
        <div className="hud-stats">
          <StatRow label="Evacuated" value={formatCount(stats.evacuated)} />
          <StatRow label="Sheltered" value={formatCount(stats.sheltered)} />
          <StatRow label="Trapped" value={formatCount(stats.trapped)} />
          <StatRow label="Injured" value={formatCount(stats.injured)} />
          <StatRow
            label="全壊"
            value={`${formatCount(stats.collapsedBuildings)} / ${formatCount(stats.totalBuildings)}`}
          />
          <StatRow label="半壊 / 大破" value={`${formatCount(stats.majorBuildings)} / ${formatCount(stats.severeBuildings)}`} />
          {stats.floodedBuildings > 0 && <StatRow label="浸水" value={formatCount(stats.floodedBuildings)} />}
          <StatRow label="Loss" value={formatJpy(stats.economicLoss)} />
        </div>
      ) : null}

      <div className="hud-controls">
        {idle ? (
          <>
            <select className="disaster-select" aria-label="災害の種類" value={chosenDisaster} onChange={event => setChosenDisaster(event.target.value as DisasterType)}>
              {(Object.keys(DISASTER_LABELS) as DisasterType[]).map(type => <option key={type} value={type}>{DISASTER_LABELS[type]}</option>)}
            </select>
            <button type="button" className="btn btn-lead" onClick={() => triggerDisaster(chosenDisaster)}>
              {chosenDisaster === 'earthquake' ? 'Earthquake' : chosenDisaster === 'fire' ? 'Fire' : chosenDisaster === 'flood' ? 'Flood' : chosenDisaster === 'tsunami' ? 'Tsunami' : 'Typhoon'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={togglePause} title="Space">
              {snapshot.paused ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              className="btn btn-speed"
              onClick={cycleSpeed}
              title="Simulation speed"
            >
              ×{speed}
            </button>
            <button type="button" className="btn" onClick={reset} title="R">
              Reset
            </button>
          </>
        )}
      </div>

      {liveSelection ? (
        <SelectionCard selection={liveSelection} onClose={() => setSelection(null)} />
      ) : null}
    </div>
  )
}
