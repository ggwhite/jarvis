import { describe, expect, test } from 'claude-code/testing'

import type { JarvisAgent, JarvisEvent } from '../types'
import { BEAT_MS, BEATS } from '../hooks/fleet'
import { BIG_ROWS } from '../hooks/fleetChart'
import { MAIN_ACTOR } from '../hooks/jarvis'
import {
  FAIL_WARN,
  dispatchRows,
  mainRows,
  modelsRows,
  planStats,
  roleBeats,
  statsHeight,
  successRate,
} from '../hooks/statsView'

const NOW = 10_000_000
const agent = (id: string, type: string): JarvisAgent => ({ id, type, status: 'done' }) as unknown as JarvisAgent
const ev = (actor: string, ago: number): JarvisEvent =>
  ({ ts: NOW - ago, actor, source: 'x', isMain: actor === MAIN_ACTOR, tool: 'Bash', desc: '', ms: 1, ok: true }) as JarvisEvent

describe('stats figures', () => {
  test('the success rate is ok over all calls; none yet is undefined', () => {
    expect(successRate(150, 3)).toBe(150 / 153)
    expect(successRate(0, 0)).toBeUndefined()
    expect(FAIL_WARN).toBe(0.1)
  })

  test('role beats: each role\'s calls in the last hour, newest bucket last', () => {
    const agents = [agent('w1', 'worker'), agent('v1', 'verifier')]
    const beats = roleBeats(
      [
        ev('w1', 60_000), // a minute ago: the last bucket
        ev('w1', 61 * 60_000), // over an hour: dropped
        ev('v1', BEAT_MS * 2 + 1), // the third bucket from the end
        ev(MAIN_ACTOR, 1000), // the main loop: no role
        ev('ghost', 1000), // no such agent
      ],
      agents,
      NOW,
    )
    expect(beats.get('worker')).toEqual([...Array.from({ length: BEATS - 1 }, () => 0), 1])
    expect(beats.get('verifier')?.[BEATS - 3]).toBe(1)
    expect([...beats.keys()].sort()).toEqual(['verifier', 'worker'])
  })

  test('role beats: the main loop counts for no role, even beside an agent of its id', () => {
    const beats = roleBeats([ev(MAIN_ACTOR, 1000)], [agent(MAIN_ACTOR, 'worker')], NOW)
    expect([...beats.keys()]).toEqual([])
  })

  test('role beats: a call stamped in the future is dropped', () => {
    const beats = roleBeats([ev('w1', -1000), ev('v1', -1), ev('v1', 1000)], [agent('w1', 'worker'), agent('v1', 'verifier')], NOW)
    expect([...beats.keys()]).toEqual(['verifier'])
    expect(beats.get('verifier')).toEqual([...Array.from({ length: BEATS - 1 }, () => 0), 1])
  })

  test('role beats: a role with nothing in the last hour gets no row', () => {
    const beats = roleBeats([ev('e1', BEATS * BEAT_MS), ev('e1', 2 * BEATS * BEAT_MS)], [agent('e1', 'Explore')], NOW)
    expect([...beats.keys()]).toEqual([])
  })
})

describe('stats plan', () => {
  test('main card: border, head and the big digits; wide adds TOP\'s second line, narrow puts the readouts under', () => {
    expect(mainRows('wide')).toBe(2 + 1 + BIG_ROWS + 1)
    expect(mainRows('mid')).toBe(2 + 1 + BIG_ROWS)
    expect(mainRows('narrow')).toBe(2 + 1 + BIG_ROWS + 3)
  })

  test('models card: border, head, the bar, a line a model and the two savings lines; dispatch a row a role', () => {
    expect(modelsRows(0)).toBe(6)
    expect(modelsRows(3)).toBe(2 + 1 + 1 + 3 + 2)
    expect(dispatchRows(5)).toBe(8)
  })

  test('each width picks its mode: main beside models when wide, stacked at mid and narrow', () => {
    const s = { room: 60, roles: 5, models: 3 }
    expect(planStats({ ...s, cols: 120 })).toEqual({ mode: 'wide', height: 17 })
    expect(planStats({ ...s, cols: 80 })).toEqual({ mode: 'mid', height: 23 })
    expect(planStats({ ...s, cols: 50 })).toEqual({ mode: 'narrow', height: 26 })
  })

  test('plan: fits whole, else cuts the roles, the cut counted in rows', () => {
    const s = { cols: 80, room: 100, roles: 6, models: 2 }
    expect(planStats(s).roleCut).toBeUndefined()
    const tight = planStats({ ...s, room: statsHeight('mid', s, 0) + 2 })
    expect(tight.roleCut).toBe(2)
    expect(planStats({ cols: 120, room: 16, roles: 5, models: 3 })).toEqual({ mode: 'wide', height: 16, roleCut: 4 })
    expect(planStats({ cols: 80, room: 20, roles: 5, models: 3 })).toEqual({ mode: 'mid', height: 20, roleCut: 2 })
  })

  test('a single role is never cut: short of rows it keeps its own row, counted in the height', () => {
    expect(planStats({ cols: 80, room: 5, roles: 1, models: 2 }).roleCut).toBeUndefined()
    expect(planStats({ cols: 80, room: 10, roles: 1, models: 3 })).toEqual({ mode: 'mid', height: 19 })
    expect(planStats({ cols: 80, room: 10, roles: 0, models: 3 })).toEqual({ mode: 'mid', height: 18 })
  })

  test('whatever the size, a plan that fits stays inside the room', () => {
    for (const cols of [40, 63, 64, 80, 99, 100, 140]) {
      for (let room = 8; room <= 60; room += 1) {
        for (const roles of [5, 6, 8]) {
          for (const models of [0, 1, 3]) {
            const s = { cols, room, roles, models }
            const p = planStats(s)
            const floor = statsHeight(p.mode, s, 0) + 1
            if (p.roleCut === undefined || room >= floor) expect([s, p.height <= room]).toEqual([s, true])
            if (p.roleCut !== undefined) expect(p.roleCut).toBeLessThan(roles)
          }
        }
      }
    }
  })
})
