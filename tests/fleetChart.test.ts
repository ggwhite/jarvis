import { describe, expect, test } from 'claude-code/testing'

import { FAMILY_COLOR, THEME, cellWidth } from '../hooks/jarvis'
import {
  BIG_ROWS,
  BURN_RAMP,
  GAUGE_RAMP,
  RING_BIG,
  RING_SMALL,
  bigText,
  bigWidth,
  brailleLine,
  burnChart,
  cellsToSegs,
  gaugeBar,
  gaugeCells,
  mix,
  partsGaugeCells,
  partsRingPixels,
  pick,
  pixelsToCells,
  ramp,
  rampBar,
  ringPixels,
  stackedBar,
} from '../hooks/fleetChart'

const lit = (px: (string | undefined)[][]) => px.flat().filter(c => c !== undefined && c !== THEME.muted)

describe('fleet chart colors', () => {
  test('ramps run between theme colors, ends exact', () => {
    expect(mix(THEME.frame, THEME.accent, 0)).toBe(THEME.frame)
    expect(mix(THEME.frame, THEME.accent, 1)).toBe(THEME.accent)
    expect(GAUGE_RAMP).toHaveLength(9)
    expect([GAUGE_RAMP[0], GAUGE_RAMP[4], GAUGE_RAMP.at(-1)]).toEqual([THEME.frame, THEME.primary, THEME.bright])
    expect(BURN_RAMP).toHaveLength(17)
    expect([BURN_RAMP[0], BURN_RAMP[8], BURN_RAMP.at(-1)]).toEqual([THEME.frame, THEME.primary, THEME.suitRed])
    expect(ramp([THEME.error], 4)).toEqual([THEME.error])
  })

  test('pick clamps to the ends', () => {
    expect(pick(GAUGE_RAMP, -1)).toBe(THEME.frame)
    expect(pick(GAUGE_RAMP, 2)).toBe(THEME.bright)
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

describe('parts ring', () => {
  test('arcs run clockwise from twelve in the order of the parts; what is left is muted', () => {
    const px = partsRingPixels(RING_BIG, [
      { share: 0.25, color: '#111111' },
      { share: 0.25, color: '#222222' },
    ])
    const at = (x: number, y: number) => px[y]?.[x]
    expect(at(10, 1)).toBe('#111111') // upper right: the first quarter
    expect(at(10, 12)).toBe('#222222') // lower right: the second
    expect(at(3, 12)).toBe(THEME.muted) // lower left: nothing
    expect(at(3, 1)).toBe(THEME.muted) // upper left: nothing
    expect(at(7, 7)).toBeUndefined() // the hole
  })

  test('parts that fill the turn leave nothing muted', () => {
    const flat = partsRingPixels(RING_SMALL, [
      { share: 0.6, color: '#111111' },
      { share: 0.4, color: '#222222' },
    ]).flat()
    expect(flat.filter(c => c === THEME.muted)).toHaveLength(0)
    expect(flat.includes('#111111')).toBe(true)
    expect(flat.includes('#222222')).toBe(true)
  })

  test('each arc starts where the one before ends: straight down begins the second half', () => {
    const px = partsRingPixels(RING_SMALL, [
      { share: 0.5, color: '#111111' },
      { share: 0.5, color: '#222222' },
    ])
    expect(px[0]?.[3]).toBe('#111111') // straight up: the turn starts
    expect(px[5]?.[3]).toBe('#222222') // straight down: half a turn
  })

  test('partsGaugeCells sets each overlay centered on its row', () => {
    const cells = partsGaugeCells(RING_BIG, [{ share: 1, color: '#111111' }], [
      { row: 3, text: '42%', color: THEME.bright, bold: true },
    ])
    const row = cells[3] ?? []
    expect(row.map(c => c.ch).join('').includes('42%')).toBe(true)
    expect(row.find(c => c.ch === '4')).toMatchObject({ fg: THEME.bright, bold: true })
  })
})

describe('ramp bar', () => {
  test('fills to eighths of a cell, colors along the ramp, shades the rest', () => {
    const cells = rampBar(4, 0.5, ['#111111', '#222222'])
    expect(cells.map(c => c.ch).join('')).toBe('██░░')
    expect(cells[0]?.fg).toBe('#111111')
    expect(cells[1]?.fg).toBe('#222222')
    expect(cells[2]?.fg).toBe(THEME.muted)
    expect(rampBar(4, 0.53, ['#111111']).map(c => c.ch).join('')).toBe('██▏░')
    expect(rampBar(3, 0, ['#111111']).map(c => c.ch).join('')).toBe('░░░')
  })

  test('gaugeBar is rampBar on the gauge glow, all red when depleted', () => {
    expect(gaugeBar(6, 0.5, false)).toEqual(rampBar(6, 0.5, GAUGE_RAMP))
    expect(gaugeBar(6, 0.5, true)).toEqual(rampBar(6, 0.5, [THEME.error]))
  })
})

describe('big digits', () => {
  test('three rows, three cells a glyph and one between', () => {
    const cells = bigText('98%', THEME.primary)
    expect(cells.length).toBe(BIG_ROWS)
    expect(bigWidth('98%')).toBe(11)
    for (const row of cells) expect(row.length).toBe(11)
  })
  test('only half blocks and spaces, in the one color', () => {
    for (const row of bigText('0123456789%-', THEME.error)) {
      for (const c of row) {
        expect([' ', '▀', '▄', '█']).toContain(c.ch)
        if (c.ch !== ' ') expect(c.fg).toBe(THEME.error)
      }
    }
  })
  test('every digit differs from every other', () => {
    const shape = (d: string) => bigText(d, THEME.primary).map(r => r.map(c => c.ch).join('')).join('|')
    const shapes = new Set('0123456789'.split('').map(shape))
    expect(shapes.size).toBe(10)
  })
  test('the column between glyphs is blank', () => {
    for (const row of bigText('88', THEME.primary)) expect(row[3]?.ch).toBe(' ')
  })
})

describe('stacked bar', () => {
  test('fills the width, each part its share, at least a cell each', () => {
    const bar = stackedBar(20, [{ share: 0.85, color: FAMILY_COLOR.opus }, { share: 0.14, color: FAMILY_COLOR.sonnet }, { share: 0.01, color: FAMILY_COLOR.haiku }])
    expect(bar.length).toBe(20)
    expect(bar.filter(c => c.fg === FAMILY_COLOR.opus).length).toBe(16)
    expect(bar.filter(c => c.fg === FAMILY_COLOR.sonnet).length).toBe(3)
    expect(bar.filter(c => c.fg === FAMILY_COLOR.haiku).length).toBe(1)
    expect(bar.every(c => c.ch === '█')).toBe(true)
  })
  test('nothing priced is an empty track', () => {
    const bar = stackedBar(8, [])
    expect(bar.map(c => c.ch).join('')).toBe('░'.repeat(8))
    expect(bar.every(c => c.fg === THEME.muted)).toBe(true)
  })
})
