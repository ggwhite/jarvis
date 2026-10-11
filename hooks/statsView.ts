import type { JarvisAgent, JarvisEvent } from '../types'
import { beatsOf } from './fleet'
import { BIG_ROWS } from './fleetChart'
import type { FleetMode } from './fleetLayout'
import { modeOf } from './fleetLayout'
import { dispatchRoleOf, MAIN_ACTOR } from './jarvis'
import type { Role } from './jarvis'

// A failure rate this high turns the success rate red.
export const FAIL_WARN = 0.1

export function successRate(ok: number, fail: number): number | undefined {
  const n = ok + fail
  return n > 0 ? ok / n : undefined
}

// Each role's tool calls in the last hour: BEATS buckets of BEAT_MS, the newest last. The
// main loop's calls and calls from agents no longer listed count for no role.
export function roleBeats(events: readonly JarvisEvent[], agents: readonly JarvisAgent[], now: number): Map<Role, number[]> {
  const roleOf = new Map(agents.map(a => [a.id, dispatchRoleOf(a)] as const))
  const stamps = new Map<Role, number[]>()
  for (const e of events) {
    if (e.actor === MAIN_ACTOR) continue
    const role = roleOf.get(e.actor)
    if (role === undefined) continue
    const ts = stamps.get(role) ?? []
    ts.push(e.ts)
    stamps.set(role, ts)
  }
  const out = new Map<Role, number[]>()
  for (const [role, ts] of stamps) {
    const beats = beatsOf(ts, now)
    if (beats.some(n => n > 0)) out.set(role, beats)
  }
  return out
}

export type StatsShape = { cols: number; room: number; roles: number; models: number }
// `roleCut`: rows left for the dispatch roles, the last one `… 還有 N 種`; a single row is a
// summary line of every role instead.
export type StatsPlan = { mode: FleetMode; height: number; roleCut?: number }

// The main card: its border, the head, then the big digits with the readouts beside them
// (wide: a line more, TOP's second tool under its first), or under them when narrow.
export function mainRows(mode: FleetMode): number {
  return 2 + 1 + (mode === 'narrow' ? BIG_ROWS + 3 : mode === 'wide' ? BIG_ROWS + 1 : BIG_ROWS)
}

// The model card: its border, the head, the stacked bar, a line a model and the two savings
// lines; nothing dispatched is one line and the savings.
export function modelsRows(models: number): number {
  return models === 0 ? 2 + 1 + 3 : 2 + 1 + 1 + models + 2
}

export function dispatchRows(roles: number): number {
  return 2 + 1 + roles
}

// Wide: main and models side by side over the dispatch card; else the three stacked.
export function statsHeight(mode: FleetMode, s: StatsShape, roles = s.roles): number {
  const top = mode === 'wide' ? Math.max(mainRows(mode), modelsRows(s.models)) : mainRows(mode) + modelsRows(s.models)
  return top + dispatchRows(roles)
}

// Short of rows, the dispatch roles cut to the rows left, unless there is just one: its own
// row says more than `… 還有 1 種`.
export function planStats(s: StatsShape): StatsPlan {
  const mode = modeOf(s.cols)
  const height = statsHeight(mode, s)
  if (height <= s.room || s.roles <= 1) return { mode, height }
  const fixed = statsHeight(mode, s, 0)
  const roleCut = Math.min(s.roles - 1, Math.max(1, s.room - fixed))
  return { mode, height: fixed + roleCut, roleCut }
}
