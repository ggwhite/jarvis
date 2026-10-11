import { describe, expect, test } from 'claude-code/testing'

import { THEME, cellWidth } from '../hooks/jarvis'
import {
  BURN_RAMP,
  GAUGE_RAMP,
  RING_BIG,
  RING_SMALL,
  brailleLine,
  burnChart,
  cellsToSegs,
  gaugeBar,
  gaugeCells,
  mix,
  pick,
  pixelsToCells,
  ramp,
  ringPixels,
} from '../hooks/fleetChart'

const lit = (px: (string | undefined)[][]) => px.flat().filter(c => c !== undefined && c !== THEME.muted)

describe('fleet chart colors', () => {
  test('ramps run between theme colors, ends exact', () => {
    expect(mix(THEME.frame, THEME.accent, 0)).toBe(THEME.frame)
    expect(mix(THEME.frame, THEME.accent, 1)).toBe(THEME.accent)
    expect(GAUGE_RAMP).toHaveLength(9)
    expect([GAUGE_RAMP[0], GAUGE_RAMP.at(-1)]).toEqual([THEME.primary, THEME.accent])
    expect(BURN_RAMP).toHaveLength(17)
    expect([BURN_RAMP[0], BURN_RAMP[8], BURN_RAMP.at(-1)]).toEqual([THEME.frame, THEME.accent, THEME.suitRed])
    expect(ramp([THEME.error], 4)).toEqual([THEME.error])
  })

  test('pick clamps to the ends', () => {
    expect(pick(GAUGE_RAMP, -1)).toBe(THEME.primary)
    expect(pick(GAUGE_RAMP, 2)).toBe(THEME.accent)
  })
})

describe('fleet chart pixels', () => {
  test('two pixels make one cell: empty, top, bottom, both alike, both different', () => {
    const a = THEME.frame
    const b = THEME.error
    expect(pixelsToCells([[undefined, a, undefined, a, a], [undefined, undefined, b, a, b]])).toEqual([
      [{ ch: ' ' }, { ch: '▀', fg: a }, { ch: '▄', fg: b }, { ch: '█', fg: a }, { ch: '▀', fg: a, bg: b }],
    ])
  })

  test('a ring lights from twelve o\'clock clockwise, as much as is used', () => {
    expect(lit(ringPixels(RING_BIG, 0, false))).toHaveLength(0)
    expect(ringPixels(RING_BIG, 1, false).flat().filter(c => c === THEME.muted)).toHaveLength(0)
    const q = ringPixels(RING_BIG, 0.25, false)
    q.forEach((row, y) =>
      row.forEach((c, x) => {
        if (c === undefined || c === THEME.muted) return
        expect(x + 0.5 >= RING_BIG.w / 2).toBe(true)
        expect(y + 0.5 <= RING_BIG.h / 2).toBe(true)
      }),
    )
  })

  test('a depleted ring burns red but for its bright tip', () => {
    const px = lit(ringPixels(RING_BIG, 0.9, true))
    expect(px.length).toBeGreaterThan(0)
    expect(px.every(c => c === THEME.error || c === THEME.bright)).toBe(true)
    expect(px.filter(c => c === THEME.bright).length).toBeGreaterThan(0)
  })

  test('gauges: the big one 7 rows of 14 with its label and percent set in its middle; the small one 3 of 7', () => {
    const big = gaugeCells(RING_BIG, 0.42, false, [
      { row: 2, text: '5H', color: THEME.frame, bold: true },
      { row: 3, text: '42%', color: THEME.bright, bold: true },
    ])
    expect(big).toHaveLength(7)
    expect(big.every(r => r.length === 14)).toBe(true)
    expect(big[2]?.map(c => c.ch).join('')).toContain('5H')
    expect(big[3]?.map(c => c.ch).join('')).toContain('42%')
    const small = gaugeCells(RING_SMALL, 0.42, false, [])
    expect(small).toHaveLength(3)
    expect(small.every(r => r.length === 7)).toBe(true)
  })

  test('a bar fills in eighths, the rest shaded', () => {
    expect(gaugeBar(10, 0.5, false).map(c => c.ch).join('')).toBe('█████░░░░░')
    expect(gaugeBar(10, 0.55, false).map(c => c.ch).join('')).toBe('█████▌░░░░')
    expect(gaugeBar(10, 0, false).every(c => c.ch === '░' && c.fg === THEME.muted)).toBe(true)
    expect(gaugeBar(4, 1, true).every(c => c.fg === THEME.error)).toBe(true)
  })
})

describe('fleet burn chart', () => {
  const hours = Array.from({ length: 24 }, (_, h) => (h === 14 ? 100 : h === 10 ? 50 : 0))

  test('rows of the chart, then the axis and its hours, all as wide as asked', () => {
    const out = burnChart(hours, 48, 4, 15, [0, 6, 12, 18])
    expect(out).toHaveLength(6)
    expect(out.every(r => r.length === 48)).toBe(true)
    expect(out[4]?.map(c => c.ch).join('')).toContain('▲')
    expect(out[5]?.map(c => c.ch).join('')).toMatch(/^00 +06 +12 +18/)
  })

  test('the busiest hour reaches the top; an hour of nothing is a muted floor; the hour now is bright', () => {
    const out = burnChart(hours, 48, 4, 10, [0, 6, 12, 18])
    const col = (h: number) => h * 2
    expect(out[0]?.[col(14)]?.ch).not.toBe(' ')
    expect(out[3]?.[col(3)]).toEqual({ ch: '▄', fg: THEME.muted })
    expect(out[3]?.[col(10)]?.fg).toBe(THEME.bright)
  })

  test('nothing burned is a muted floor across', () => {
    const out = burnChart(Array.from({ length: 24 }, () => 0), 24, 3, 0, [0, 12])
    expect(out[2]?.every(c => c.ch === '▄')).toBe(true)
  })
})

describe('fleet braille line', () => {
  test('silence lies on the floor', () => {
    expect(brailleLine([0, 0, 0], 5)).toBe('⣀⣀⣀⣀⣀')
  })

  test('a rise climbs from the floor to the top, unbroken', () => {
    const s = brailleLine([0, 1, 2, 3, 4], 8)
    expect([...s]).toHaveLength(8)
    expect([...s].every(ch => ch !== '⠀')).toBe(true)
    const first = (s.codePointAt(0) ?? 0) - 0x2800
    const last = ([...s].at(-1)?.codePointAt(0) ?? 0) - 0x2800
    expect(first & 0xc0).not.toBe(0)
    expect(last & 0x09).not.toBe(0)
  })

  test('a sudden leap is drawn as a wall, not two lone dots', () => {
    expect(brailleLine([0, 1], 1)).toBe('⣸')
  })

  test('a line scaled to a given top: below it stays low, past it pins the top', () => {
    expect(brailleLine([0, 10], 1, 40)).not.toBe(brailleLine([0, 10], 1))
    expect(brailleLine([0, 10], 1, 10)).toBe(brailleLine([0, 10], 1))
    expect(brailleLine([0, 99], 1, 10)).toBe(brailleLine([0, 10], 1))
    expect([...brailleLine([0, 99], 6, 10)].every(ch => ch !== '⠀')).toBe(true)
    expect(brailleLine([0, 0], 3, 50)).toBe('⣀⣀⣀')
  })

  test('no width, no line', () => {
    expect(brailleLine([1, 2], 0)).toBe('')
  })
})

describe('fleet cells to segments', () => {
  test('alike neighbours merge; the text and its width stay', () => {
    const cells = [
      { ch: '▀', fg: THEME.frame },
      { ch: '▀', fg: THEME.frame },
      { ch: '█', fg: THEME.error },
      { ch: ' ' },
    ]
    const segs = cellsToSegs(cells)
    expect(segs).toEqual([{ t: '▀▀', color: THEME.frame }, { t: '█', color: THEME.error }, { t: ' ' }])
    expect(cellWidth(segs.map(s => s.t).join(''))).toBe(4)
  })
})
