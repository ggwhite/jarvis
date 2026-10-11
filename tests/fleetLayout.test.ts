import { describe, expect, test } from 'claude-code/testing'

import { fleetHeight, idlePerRow, legionRows, modeOf, planFleet } from '../hooks/fleetLayout'
import type { FleetShape } from '../hooks/fleetLayout'

describe('fleet layout', () => {
  test('breakpoints: 100 and up wide, 64 and up mid, below narrow', () => {
    expect([modeOf(140), modeOf(100), modeOf(99), modeOf(64), modeOf(63), modeOf(40)]).toEqual(['wide', 'wide', 'mid', 'mid', 'narrow', 'narrow'])
    expect([idlePerRow('wide'), idlePerRow('mid')]).toEqual([3, 2])
  })

  test('the mid pane with room to spare: small rings, a 4-row burn, wide cards, idle cards two abreast', () => {
    const p = planFleet({ cols: 65, room: 43, windows: 2, active: 1, idle: 7 })
    expect(p).toMatchObject({ mode: 'mid', gauge: 'small', burnRows: 4, active: 'cards', idle: 'cards', blanks: true })
    expect(p.cut).toBeUndefined()
    // rings 1+3, burn 1+4+2, legion 1 + 4 + 4 rows of idle cards × 3, two blank rows
    expect(p.height).toBe(4 + 7 + 17 + 2)
  })

  test('each step gives way in its order as the room shrinks', () => {
    const shape = (room: number): FleetShape => ({ cols: 65, room, windows: 2, active: 2, idle: 6 })
    const rows: [number, Record<string, unknown>][] = [
      [31, { idle: 'cards', blanks: true, burnRows: 4, active: 'cards', gauge: 'small', height: 31 }],
      [30, { idle: 'lines', height: 28 }],
      [23, { idle: 'summary', blanks: true, height: 23 }],
      [22, { idle: 'summary', blanks: false, height: 21 }],
      [20, { burnRows: 2, height: 19 }],
      [14, { burnRows: 0, height: 14 }],
      [8, { active: 'lines', gauge: 'small', height: 8 }],
      [7, { active: 'lines', gauge: 'bar', height: 7 }],
      [6, { gauge: 'bar', cut: 2, height: 6 }],
    ]
    for (const [room, want] of rows) expect(planFleet(shape(room))).toMatchObject(want)
    expect(planFleet(shape(31)).cut).toBeUndefined()
    expect(planFleet(shape(7)).cut).toBeUndefined()
  })

  test('a stage that gave up the burn or the idle rows takes back what still fits: the burn, then idle lines, then blanks', () => {
    const busy = (room: number) => planFleet({ cols: 65, room, windows: 2, active: 8, idle: 0 })
    // 65×30, eight suits working: their cards do not fit, but beside their lines the 4-row burn does
    expect(busy(28)).toMatchObject({ active: 'lines', gauge: 'small', burnRows: 4, blanks: true, height: 22 })
    expect(busy(28).cut).toBeUndefined()
    expect(busy(19)).toMatchObject({ active: 'lines', burnRows: 2, blanks: false, height: 18 })
    const mixed = (room: number) => planFleet({ cols: 65, room, windows: 2, active: 7, idle: 3 })
    expect(mixed(28)).toMatchObject({ active: 'lines', burnRows: 4, idle: 'lines', blanks: true, height: 24 })
    expect(mixed(23)).toMatchObject({ burnRows: 4, idle: 'lines', blanks: false, height: 22 })
    expect(mixed(21)).toMatchObject({ burnRows: 4, idle: 'summary', blanks: false, height: 20 })
  })

  test('wide starts with big rings and gives them up last; narrow starts on lines and bars', () => {
    const wide = (room: number) => planFleet({ cols: 120, room, windows: 2, active: 2, idle: 6 })
    expect(wide(60)).toMatchObject({ mode: 'wide', gauge: 'big', burnRows: 6, idle: 'cards' })
    expect(wide(13)).toMatchObject({ gauge: 'big', active: 'lines' })
    expect(wide(12)).toMatchObject({ gauge: 'small' })
    expect(planFleet({ cols: 44, room: 40, windows: 2, active: 2, idle: 6 })).toMatchObject({
      mode: 'narrow',
      gauge: 'bar',
      burnRows: 3,
      active: 'lines',
      idle: 'lines',
    })
  })

  test('no quota draws no rings; an empty fleet takes one row', () => {
    const p = planFleet({ cols: 65, room: 40, windows: 0, active: 0, idle: 0 })
    expect(p.gauge).toBe('none')
    expect(legionRows({ cols: 65, room: 40, windows: 0, active: 0, idle: 0 }, 'mid', p)).toBe(1)
  })

  test('any pane 8 rows tall or more fits, the active suits never folded into the summary', () => {
    for (const cols of [40, 63, 64, 65, 99, 100, 140]) {
      for (let rows = 8; rows <= 60; rows += 1) {
        for (const windows of [0, 1, 2]) {
          for (const active of [0, 1, 4, 12]) {
            for (const idle of [0, 1, 7, 30]) {
              const s: FleetShape = { cols, room: rows - 2, windows, active, idle }
              const p = planFleet(s)
              expect(p.height).toBeLessThanOrEqual(s.room)
              if (p.cut === undefined) {
                expect(p.height).toBe(fleetHeight(s, p.mode, p))
                expect(legionRows(s, p.mode, p)).toBeGreaterThanOrEqual(active)
              }
            }
          }
        }
      }
    }
  })
})
