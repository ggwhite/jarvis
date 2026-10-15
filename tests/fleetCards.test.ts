import { describe, expect, test } from 'claude-code/testing'

import type { FleetQuota, FleetSession } from '../types'
import { THEME, cellWidth } from '../hooks/jarvis'
import { beatsOf, emptyHours } from '../hooks/fleet'
import { brailleLine } from '../hooks/fleetChart'
import { SECTION_ICON, withIcon } from '../hooks/icons'
import {
  hourlyOf,
  idleHourMax,
  idleSummary,
  reactorRows,
  sectionHeader,
  segsWidth,
  smallCard,
  suitLine,
  wideCard,
  windowFoot,
} from '../hooks/fleetCards'
import type { CardLines } from '../hooks/fleetCards'

const T0 = new Date(2026, 9, 11, 15, 0, 0).getTime()
const MIN = 60_000
const textOf = (segs: readonly { t: string }[]) => segs.map(s => s.t).join('')

const suit = (over: Partial<FleetSession> = {}): FleetSession => ({
  paneId: 'w1:p1',
  tabId: 'w1:t1',
  sessionId: 'sess-a',
  title: 'Alpha review',
  status: 'working',
  cwd: '/srv/alpha',
  workspace: 'Acme',
  stamps: [T0 - 4 * MIN, T0 - 3 * MIN, T0 - 30 * MIN],
  tools: 3,
  todayTokens: 182_000,
  todayCost: 52.3,
  contextPct: 44,
  model: 'claude-opus-5-5',
  tool: 'Bash',
  runSince: T0 - 2 * MIN,
  lastAt: T0 - MIN,
  ...over,
})

const widths = (c: CardLines) => [segsWidth(c.chip) + segsWidth(c.top), ...c.body.map(segsWidth)]

describe('fleet cards', () => {
  test('hourlyOf: a view without hours reads 24 zeros', () => {
    expect(hourlyOf({})).toEqual(emptyHours())
    expect(hourlyOf({ hourly: [1, 2] })).toEqual(emptyHours())
    const h = emptyHours()
    h[3] = 7
    expect(hourlyOf({ hourly: h })[3]).toBe(7)
  })

  test('a section header fills its width: rule, title, rule, what is on its right', () => {
    const h = sectionHeader('TODAY BURN', 50, 'Σ 165 TOK')
    expect(segsWidth(h)).toBe(50)
    expect(textOf(h)).toMatch(/^── TODAY BURN ─+ Σ 165 TOK ──$/)
    expect(segsWidth(sectionHeader('IRON LEGION', 40))).toBe(40)
    const iconed = sectionHeader(withIcon(SECTION_ICON.legion, 'IRON LEGION'), 40, 'Σ 1 TOK')
    expect(segsWidth(iconed)).toBe(40)
    expect(textOf(iconed)).toMatch(/^── \uf132 IRON LEGION ─+ Σ 1 TOK ──$/)
  })

  test('a window foot: when it resets, when it runs out first, used up, stale', () => {
    const q = (used: number, fetchedAt = T0): FleetQuota => ({ fetchedAt, sevenDay: { usedPct: used, resetsAt: T0 + 900 * MIN, windowMin: 10080 } })
    const w = (x: FleetQuota) => x.sevenDay ?? { usedPct: 0, resetsAt: 0, windowMin: 0 }
    expect(windowFoot(w(q(10)), q(10), T0, true)).toEqual({ t: 'RESET 06:00', color: THEME.frame, depleted: false })
    expect(windowFoot(w(q(92)), q(92), T0, true)).toMatchObject({ t: expect.stringMatching(/^DEPLETED IN ~\d+h$/), color: THEME.error, depleted: true })
    expect(windowFoot(w(q(92)), q(92), T0, false).t).toMatch(/^DEPLETED ~\d+h$/)
    expect(windowFoot(w(q(100)), q(100), T0, false)).toMatchObject({ t: 'DEPLETED', depleted: true })
    const stale = q(92, T0 - 16 * MIN)
    expect(windowFoot(w(stale), stale, T0, false)).toEqual({ t: 'STALE · RESET 06:00', color: THEME.frame, depleted: false })
  })

  test('reactor rows: big 8, small 3, bars one a window; every row the width asked', () => {
    const g = [
      { label: '5H', used: 10, foot: { t: 'RESET 18:40', color: THEME.frame, depleted: false } },
      { label: '7D', used: 93, foot: { t: 'DEPLETED ~11h', color: THEME.error, depleted: true } },
    ]
    const big = reactorRows('big', g, 120)
    expect(big).toHaveLength(8)
    expect(big.every(r => segsWidth(r) === 120)).toBe(true)
    expect(big.map(textOf).join('\n')).toMatch(/5H[\s\S]*93%/)
    const small = reactorRows('small', g, 65)
    expect(small).toHaveLength(3)
    expect(small.every(r => segsWidth(r) === 65)).toBe(true)
    expect(textOf(small[0] ?? [])).toMatch(/5H  10%.*7D  93%/)
    expect(textOf(small[1] ?? [])).toMatch(/RESET 18:40.*DEPLETED ~11h/)
    const bars = reactorRows('bar', g, 44)
    expect(bars).toHaveLength(2)
    expect(bars.every(r => segsWidth(r) <= 44)).toBe(true)
    expect(textOf(bars[1] ?? [])).toMatch(/7D ▕.*▏  93%/)
    expect(reactorRows('small', [g[0] as (typeof g)[0]], 65).every(r => segsWidth(r) === 65)).toBe(true)
  })

  test('bars too narrow for their feet keep the times only, the bar still readable', () => {
    const g = [
      { label: '5H', used: 10, foot: { t: 'RESET 18:40', color: THEME.frame, depleted: false } },
      { label: '7D', used: 93, foot: { t: 'DEPLETED ~11h', color: THEME.error, depleted: true } },
    ]
    const bars = reactorRows('bar', g, 30)
    expect(bars.every(r => segsWidth(r) <= 30)).toBe(true)
    expect(textOf(bars[0] ?? [])).toMatch(/5H ▕.{8,}▏  10% 18:40$/)
    expect(textOf(bars[1] ?? [])).toMatch(/~11h$/)
    expect(bars.map(textOf).join('\n')).not.toMatch(/RESET|DEPLETED/)
  })

  test('a wide card: the whole title, its badge, the line and readouts, today', () => {
    const c = wideCard(suit(), 62, { now: T0, self: false })
    expect(widths(c)).toEqual([62, 62, 62, 62])
    expect(textOf(c.chip)).toBe('╭─ ◆')
    const all = [textOf(c.top), ...c.body.map(textOf)].join('\n')
    expect(all).toContain('Alpha review')
    expect(all).toContain(' ACTIVE ')
    expect(all).toContain('Opus 5.5 · Bash · 2m')
    expect(all).toMatch(/CTX ▰▰▰▰▱▱▱▱▱▱  44%/)
    expect(all).toContain('TODAY 182k · $52.30')
    expect(c.top.find(s => s.t === ' ACTIVE ')).toMatchObject({ bg: THEME.accent })
    const waiting = wideCard(suit({ status: 'blocked' }), 62, { now: T0, self: true })
    expect(textOf(waiting.chip)).toBe('╭─ ▲')
    expect(textOf(waiting.top)).toContain('Alpha review THIS')
    expect(waiting.top.find(s => s.t === ' AWAITING ')).toMatchObject({ bg: THEME.error })
  })

  test('a small card: idle time, RETIRE past a day, the line and context', () => {
    const idle = smallCard(suit({ status: 'idle', lastAt: T0 - 4 * 60 * MIN, contextPct: 95 }), 29, { now: T0, self: false })
    expect(widths(idle)).toEqual([29, 29, 29])
    expect(textOf(idle.chip)).toBe('╭─ ◇')
    expect(textOf(idle.top)).toContain('IDLE 4h')
    expect(idle.body[0]?.find(s => s.t.trim() === '95%')?.color).toBe(THEME.error)
    const old = smallCard(suit({ status: 'idle', lastAt: T0 - 26 * 60 * MIN }), 29, { now: T0, self: false })
    expect(textOf(old.top)).toContain('RETIRE')
  })

  test('cards are exactly as wide as asked, long CJK titles included', () => {
    const long = '事件指令失敗原因與後續追蹤以及其他非常長的標題文字'
    for (let w = 24; w <= 120; w += 1) {
      for (const title of ['A', 'Alpha review', long]) {
        for (const self of [false, true]) {
          const s = suit({ title })
          if (w >= 40) expect(widths(wideCard(s, w, { now: T0, self })).every(x => x === w)).toBe(true)
          expect(widths(smallCard({ ...s, status: 'idle' }, w, { now: T0, self })).every(x => x === w)).toBe(true)
          for (const spark of [0, 6, 10]) {
            const l = suitLine(s, w, { now: T0, self, spark })
            expect(segsWidth(l.chip) + segsWidth(l.top)).toBe(w)
          }
        }
      }
    }
  })

  test('a line: icon, title, context; idle time when idle; the line only with room', () => {
    const l = suitLine(suit({ status: 'idle', lastAt: T0 - 90 * MIN }), 60, { now: T0, self: false, spark: 0 })
    expect(textOf(l.chip)).toBe('◇')
    expect(textOf(l.top)).toMatch(/Alpha review +44% +1h$/)
    expect(l.body).toEqual([])
    const busy = suitLine(suit(), 60, { now: T0, self: false, spark: 10 })
    expect(textOf(busy.chip)).toBe('◆')
    expect(textOf(busy.top)).toMatch(/[\u2800-\u28FF]{10}/)
  })

  test('the standby summary counts the idle and those up for retirement', () => {
    const idle = [suit({ status: 'idle', lastAt: T0 - 26 * 60 * MIN }), suit({ status: 'idle', lastAt: T0 - MIN })]
    expect(textOf(idleSummary(idle, T0))).toBe('◇ STANDBY 2 艘 · 1 艘可退役')
    expect(textOf(idleSummary([suit({ status: 'idle', lastAt: T0 })], T0))).toBe('◇ STANDBY 1 艘')
  })

  test('no card shows what was said', () => {
    const s = suit({ lastUser: 'SECRET-PROMPT', lastReply: 'SECRET-REPLY' })
    const all = [wideCard(s, 62, { now: T0, self: false }), smallCard(s, 29, { now: T0, self: false }), suitLine(s, 60, { now: T0, self: false, spark: 6 })]
      .flatMap(c => [textOf(c.chip), textOf(c.top), ...c.body.map(textOf)])
      .join('\n')
    expect(all).not.toContain('SECRET')
    expect(cellWidth(all)).toBeGreaterThan(0)
  })
  test('an idle card draws today by the hour, scaled to the idlest fleet peak; a wide card the last hour', () => {
    const h = emptyHours()
    h[9] = 40
    h[14] = 10
    const s = suit({ status: 'idle', lastAt: T0 - 90 * MIN, hourly: h })
    const other = suit({ status: 'idle', hourly: (() => { const o = emptyHours(); o[3] = 80; return o })() })
    expect(idleHourMax([s, other])).toBe(80)
    expect(idleHourMax([])).toBe(0)
    const small = smallCard(s, 40, { now: T0, self: false, idleMax: 80 })
    const spark = small.body[0]?.find(x => /^[\u2800-\u28FF]+$/.test(x.t))?.t ?? ''
    expect([...spark]).toHaveLength(10)
    expect(spark).toBe(brailleLine(h, 10, 80))
    expect(spark).not.toBe(brailleLine(h, 10))
    expect(spark).not.toBe(brailleLine(beatsOf(s.stamps, T0), 10))
    const line = suitLine(s, 60, { now: T0, self: false, spark: 10, idleMax: 80 })
    expect(textOf(line.top)).toContain(brailleLine(h, 10, 80))
    const wide = wideCard(suit({ hourly: h }), 62, { now: T0, self: false, idleMax: 80 })
    const wideSpark = wide.body[0]?.find(x => /^[\u2800-\u28FF]+$/.test(x.t))?.t ?? ''
    expect(wideSpark).toBe(brailleLine(beatsOf(suit().stamps, T0), [...wideSpark].length))
    const busyLine = suitLine(suit({ hourly: h }), 60, { now: T0, self: false, spark: 10 })
    expect(textOf(busyLine.top)).toContain(brailleLine(beatsOf(suit().stamps, T0), 10))
  })

  test('a suit quiet for days draws a flat line, whatever the fleet peak', () => {
    const stale = suit({ status: 'idle', lastAt: T0 - 3 * 24 * 60 * MIN, stamps: [T0 - 5 * MIN], hourly: emptyHours() })
    for (const idleMax of [0, 80, undefined]) {
      const c = smallCard(stale, 40, { now: T0, self: false, ...(idleMax === undefined ? {} : { idleMax }) })
      const spark = c.body[0]?.find(x => /^[\u2800-\u28FF]+$/.test(x.t))?.t ?? ''
      expect(spark).toBe('⣀'.repeat(10))
    }
    const old = smallCard(suit({ status: 'idle', lastAt: T0 - 3 * 24 * 60 * MIN }), 40, { now: T0, self: false, idleMax: 80 })
    expect(old.body[0]?.find(x => /^[\u2800-\u28FF]+$/.test(x.t))?.t).toBe('⣀'.repeat(10))
  })
})

describe('svg form: ctx meter', () => {
  test('svg: the CTX meter is one seg carrying its picture, the glyphs kept for width', () => {
    const c = wideCard(suit(), 60, { now: T0, self: false, svg: true })
    const row2 = c.body[1] ?? []
    const meter = row2.find(s => s.svg !== undefined)
    expect(meter?.t).toBe('▰▰▰▰▱▱▱▱▱▱')
    expect(meter?.alt).toBe('CTX 44%')
    expect(segsWidth(row2)).toBe(segsWidth(wideCard(suit(), 60, { now: T0, self: false }).body[1] ?? []))
  })

  test('no svg: the CTX meter is two glyph segs, no picture', () => {
    const c = smallCard(suit({ status: 'idle' }), 40, { now: T0, self: false })
    expect((c.body[0] ?? []).some(s => s.svg !== undefined)).toBe(false)
  })
})

describe('svg form: lines', () => {
  test('a busy card: the last hour line carries its picture', () => {
    const c = wideCard(suit(), 60, { now: T0, self: false, svg: true })
    const line = (c.body[0] ?? []).find(s => s.svg !== undefined)
    expect(line?.alt).toBe('最近一小時')
    expect(line?.svg).toContain('<polyline')
    expect(cellWidth(line?.t ?? '')).toBe(cellWidth(brailleLine(beatsOf(suit().stamps, T0), cellWidth(line?.t ?? ''))))
  })

  test('an idle card and line: today by the hour carries its picture', () => {
    const idle = suit({ status: 'idle', hourly: [0, 1, 2, 3, ...Array<number>(20).fill(0)] })
    expect((smallCard(idle, 40, { now: T0, self: false, svg: true }).body[0] ?? []).some(s => s.alt === '今日每小時')).toBe(true)
    expect(suitLine(idle, 60, { now: T0, self: false, spark: 6, svg: true }).top.some(s => s.alt === '今日每小時')).toBe(true)
  })

  test('no svg: no card carries a picture', () => {
    const c = wideCard(suit(), 60, { now: T0, self: false })
    expect([...c.body.flat(), ...c.top].some(s => s.svg !== undefined)).toBe(false)
  })
})
