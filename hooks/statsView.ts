import type { JarvisAgent, JarvisEvent } from '../types'
import { BEAT_MS, BEATS } from './fleet'
import type { FleetMode, GaugeForm } from './fleetLayout'
import { modeOf } from './fleetLayout'
import { dispatchRoleOf, MAIN_ACTOR } from './jarvis'
import type { Role } from './jarvis'

// A failure rate this high turns the success ring red.
export const FAIL_WARN = 0.1

export function successRate(ok: number, fail: number): number | undefined {
  const n = ok + fail
  return n > 0 ? ok / n : undefined
}

// Each role's tool calls in the last hour: BEATS buckets of BEAT_MS, the newest last. The
// main loop's calls and calls from agents no longer listed count for no role.
export function roleBeats(events: readonly JarvisEvent[], agents: readonly JarvisAgent[], now: number): Map<Role, number[]> {
  const roleOf = new Map(agents.map(a => [a.id, dispatchRoleOf(a)] as const))
  const out = new Map<Role, number[]>()
  for (const e of events) {
    if (e.actor === MAIN_ACTOR) continue
    const role = roleOf.get(e.actor)
    if (role === undefined) continue
    const age = now - e.ts
    if (age < 0 || age >= BEATS * BEAT_MS) continue
    const row = out.get(role) ?? Array.from({ length: BEATS }, () => 0)
    const i = BEATS - 1 - Math.floor(age / BEAT_MS)
    row[i] = (row[i] ?? 0) + 1
    out.set(role, row)
  }
  return out
}

export type StatsShape = { cols: number; room: number; roles: number; models: number }
// `roleCut`: rows left for the dispatch roles, the last one `… 還有 N 種`.
export type StatsPlan = { mode: FleetMode; gauge: GaugeForm; height: number; roleCut?: number }

const GAUGES: Record<FleetMode, GaugeForm[]> = { wide: ['big', 'small', 'bar'], mid: ['small', 'bar'], narrow: ['bar'] }
const RING_ROWS: Record<GaugeForm, number> = { big: 7, small: 3, bar: 0 }

// The main card: its border, the head, then the ring beside four lines (big: seven rows) or
// the bar's four lines.
export function mainRows(g: GaugeForm): number {
  return 2 + 1 + (g === 'big' ? RING_ROWS.big : 4)
}

// The model card: its border, the head, then a line a model and the two savings lines,
// beside the ring when there is one; nothing dispatched is one line and the savings.
export function modelsRows(g: GaugeForm, models: number): number {
  if (models === 0) return 2 + 1 + 3
  const text = models + 2
  return 2 + 1 + (g === 'bar' ? text : Math.max(RING_ROWS[g], text))
}

export function dispatchRows(roles: number): number {
  return 2 + 1 + roles
}

// Wide: main and models side by side over the dispatch card; else the three stacked.
export function statsHeight(mode: FleetMode, g: GaugeForm, s: StatsShape, roles = s.roles): number {
  const top = mode === 'wide' ? Math.max(mainRows(g), modelsRows(g, s.models)) : mainRows(g) + modelsRows(g, s.models)
  return top + dispatchRows(roles)
}

// The biggest ring that fits; at the smallest, the dispatch roles cut to the rows left.
export function planStats(s: StatsShape): StatsPlan {
  const mode = modeOf(s.cols)
  const forms = GAUGES[mode]
  for (const gauge of forms) {
    const height = statsHeight(mode, gauge, s)
    if (height <= s.room) return { mode, gauge, height }
  }
  const gauge = forms[forms.length - 1] ?? 'bar'
  const fixed = statsHeight(mode, gauge, s, 0)
  const roleCut = Math.min(s.roles - 1, Math.max(1, s.room - fixed))
  return { mode, gauge, height: fixed + roleCut, roleCut }
}
