import { describe, expect, test } from 'claude-code/testing'

import type { JarvisAgent, JarvisEvent } from '../types'
import { BEAT_MS, BEATS } from '../hooks/fleet'
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
  test('card heights: main 10 with the big ring, 7 otherwise; models fit their rows; dispatch a row a role', () => {
    expect(mainRows('big')).toBe(10)
    expect(mainRows('small')).toBe(7)
    expect(mainRows('bar')).toBe(7)
    expect(modelsRows('big', 3)).toBe(10)
    expect(modelsRows('small', 3)).toBe(8)
    expect(modelsRows('bar', 3)).toBe(8)
    expect(modelsRows('small', 0)).toBe(6)
    expect(dispatchRows(5)).toBe(8)
  })

  test('each width picks its ring: big when wide, small at mid, a bar when narrow', () => {
    const s = { room: 60, roles: 5, models: 3 }
    expect(planStats({ ...s, cols: 120 })).toEqual({ mode: 'wide', gauge: 'big', height: 18 })
    expect(planStats({ ...s, cols: 80 })).toEqual({ mode: 'mid', gauge: 'small', height: 23 })
    expect(planStats({ ...s, cols: 50 })).toEqual({ mode: 'narrow', gauge: 'bar', height: 23 })
  })

  test('short of rows the ring shrinks, then the roles are cut, the cut counted in rows', () => {
    expect(planStats({ cols: 120, room: 16, roles: 5, models: 3 })).toEqual({ mode: 'wide', gauge: 'small', height: 16 })
    expect(planStats({ cols: 80, room: 20, roles: 5, models: 3 })).toEqual({
      mode: 'mid',
      gauge: 'bar',
      height: 20,
      roleCut: 2,
    })
  })

  test('a single role is never cut: short of rows it keeps its own row, counted in the height', () => {
    expect(planStats({ cols: 80, room: 10, roles: 1, models: 3 })).toEqual({ mode: 'mid', gauge: 'bar', height: 19 })
    expect(planStats({ cols: 80, room: 10, roles: 0, models: 3 })).toEqual({ mode: 'mid', gauge: 'bar', height: 18 })
  })

  test('whatever the size, a plan that fits stays inside the room', () => {
    for (const cols of [40, 63, 64, 80, 99, 100, 140]) {
      for (let room = 8; room <= 60; room += 1) {
        for (const roles of [5, 6, 8]) {
          for (const models of [0, 1, 3]) {
            const s = { cols, room, roles, models }
            const p = planStats(s)
            const floor = statsHeight(p.mode, p.gauge, s, 0) + 1
            if (p.roleCut === undefined || room >= floor) expect([s, p.height <= room]).toEqual([s, true])
            if (p.roleCut !== undefined) expect(p.roleCut).toBeLessThan(roles)
          }
        }
      }
    }
  })
})
