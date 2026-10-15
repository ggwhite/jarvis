import { describe, expect, test } from 'claude-code/testing'

import { BIG_ROWS, BURN_RAMP, GAUGE_RAMP, RING_BIG, RING_SMALL, bigWidth } from '../hooks/fleetChart'
import { THEME, cellWidth } from '../hooks/jarvis'
import {
  CELL_PX_H,
  CELL_PX_W,
  SVG_MAX,
  bigTextSvg,
  burnSvg,
  cellPx,
  gaugeBarSvg,
  meterSvg,
  pixelRects,
  rampBarSvg,
  reactorSvg,
  ringSvg,
  rowPx,
  ruleSvg,
  sparkSvg,
  stackedBarSvg,
  suitSvg,
  svgDoc,
  svgSafe,
} from '../hooks/svgArt'
import { framePixels, suitArtPixels } from '../hooks/suit'

// an attribute of the outer <svg>
export const attr = (svg: string, name: string): string | undefined => svg.match(new RegExp(`^<svg[^>]* ${name}="([^"]*)"`))?.[1]
export const count = (svg: string, re: RegExp): number => (svg.match(re) ?? []).length

describe('svgArt basics', () => {
  test('a cell is 8 by 19 CSS px; odd counts are none', () => {
    expect([CELL_PX_W, CELL_PX_H]).toEqual([8, 19])
    expect(cellPx(5)).toBe(40)
    expect(rowPx(3)).toBe(57)
    expect(cellPx(Number.NaN)).toBe(0)
    expect(cellPx(-2)).toBe(0)
    expect(rowPx(Number.POSITIVE_INFINITY)).toBe(0)
  })

  test('svgDoc sizes the document by cells, its viewBox the same', () => {
    const s = svgDoc(3, 2, '')
    expect(s.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(attr(s, 'width')).toBe('24')
    expect(attr(s, 'height')).toBe('38')
    expect(attr(s, 'viewBox')).toBe('0 0 24 38')
  })

  test('svgSafe refuses script, handlers, outside links, private use and size', () => {
    expect(svgSafe(svgDoc(1, 1, '<rect x="0" y="0" width="8" height="19" fill="#000"/>'))).toBe(true)
    expect(svgSafe(svgDoc(1, 1, '<script>x</script>'))).toBe(false)
    expect(svgSafe(svgDoc(1, 1, '<rect onload="x"/>'))).toBe(false)
    expect(svgSafe(svgDoc(1, 1, '<a href="javascript:x"/>'))).toBe(false)
    expect(svgSafe(svgDoc(1, 1, '<image href="https://e.com/a.png"/>'))).toBe(false)
    expect(svgSafe(svgDoc(1, 1, '<style>@import url(x)</style>'))).toBe(false)
    expect(svgSafe(svgDoc(1, 1, '<text></text>'))).toBe(false)
    expect(svgSafe(svgDoc(1, 1, 'x'.repeat(SVG_MAX)))).toBe(false)
    expect(svgSafe('<rect/>')).toBe(false)
  })

  test('meterSvg: one rect a cell, the lit ones in the color', () => {
    const s = meterSvg(2, 5, THEME.accent)
    expect(attr(s, 'width')).toBe(String(cellPx(5)))
    expect(attr(s, 'height')).toBe(String(rowPx(1)))
    expect(count(s, /<rect /g)).toBe(5)
    expect(count(s, new RegExp(`fill="${THEME.accent}"`, 'g'))).toBe(2)
    expect(count(s, new RegExp(`fill="${THEME.muted}"`, 'g'))).toBe(3)
    expect(svgSafe(s)).toBe(true)
  })

  test('meterSvg takes odd input without throwing', () => {
    const odd: [number, number][] = [[Number.NaN, 5], [9, 3], [-1, 4], [2, Number.NaN], [0, 0]]
    for (const [lit, total] of odd) expect(svgSafe(meterSvg(lit, total, THEME.primary))).toBe(true)
    expect(count(meterSvg(9, 3, THEME.primary), new RegExp(`fill="${THEME.primary}"`, 'g'))).toBe(3)
  })

  test('the meter glyphs are a cell each, so a meter seg keeps its width', () => {
    expect(cellWidth('▰▱')).toBe(2)
  })
})

const points = (svg: string): string[] => (svg.match(/points="([^"]*)"/)?.[1] ?? '').split(' ').filter(p => p !== '')

describe('svgArt bars and lines', () => {
  test('rampBarSvg: the gradient id follows the colors, so two bars in one document never share one', () => {
    const idOf = (src: string) => /<linearGradient id="([^"]+)"/.exec(src)?.[1]
    const gold = idOf(rampBarSvg(10, 0.5, ['#aa8800', '#ffeeaa']))
    const red = idOf(rampBarSvg(10, 0.5, ['#ff0000']))
    expect(gold).toBeDefined()
    expect(red).toBeDefined()
    expect(gold).not.toBe(red)
    expect(idOf(rampBarSvg(20, 0.9, ['#aa8800', '#ffeeaa']))).toBe(gold)
    const src = rampBarSvg(10, 0.5, ['#ff0000'])
    expect(src).toContain(`fill="url(#${red})"`)
  })

  test('rampBarSvg: the width in cells, a gradient fill as far as pct', () => {
    const s = rampBarSvg(10, 0.5, BURN_RAMP)
    expect(attr(s, 'width')).toBe(String(cellPx(10)))
    expect(attr(s, 'height')).toBe(String(CELL_PX_H))
    expect(s).toContain('<linearGradient')
    expect(s).toMatch(new RegExp(`class="fill"[^>]* width="${cellPx(10) / 2}"`))
    expect(count(s, /<stop /g)).toBe(BURN_RAMP.length)
  })

  test('rampBarSvg at 0% is the track alone', () => {
    expect(count(rampBarSvg(6, 0, BURN_RAMP), /class="fill"/g)).toBe(0)
  })

  test('gaugeBarSvg: red when depleted, the glow ramp otherwise', () => {
    expect(gaugeBarSvg(8, 0.4, true)).toContain(`stop-color="${THEME.error}"`)
    expect(count(gaugeBarSvg(8, 0.4, false), /<stop /g)).toBe(GAUGE_RAMP.length)
  })

  test('stackedBarSvg: a rect a part with a share, a muted track for none', () => {
    const s = stackedBarSvg(20, [{ share: 0.75, color: '#111111' }, { share: 0.25, color: '#222222' }, { share: 0, color: '#333333' }])
    expect(count(s, /class="part"/g)).toBe(2)
    expect(s).toMatch(new RegExp(`fill="#111111"[^>]*/>`))
    const empty = stackedBarSvg(20, [])
    expect(count(empty, /class="part"/g)).toBe(0)
    expect(empty).toContain(`fill="${THEME.muted}"`)
  })

  test('sparkSvg: a point a value, a flat line for one, a floor for none', () => {
    expect(points(sparkSvg([1, 3, 2, 5], 10, undefined, THEME.accent))).toHaveLength(4)
    const one = points(sparkSvg([4], 10, undefined, THEME.accent))
    expect(one).toHaveLength(2)
    expect(one[0]?.split(',')[1]).toBe(one[1]?.split(',')[1])
    const none = sparkSvg([], 10, undefined, THEME.accent)
    expect(none).not.toContain('<polyline')
    expect(none).toContain('<line')
  })

  test('sparkSvg scales to top, a value past it at the top', () => {
    const ys = points(sparkSvg([0, 20], 4, 10, THEME.accent)).map(p => Number(p.split(',')[1]))
    expect(ys[1]).toBe(3)
  })

  test('bars and lines take odd input without throwing', () => {
    const cases = [
      rampBarSvg(Number.NaN, 2, BURN_RAMP),
      rampBarSvg(-3, Number.NaN, []),
      gaugeBarSvg(5, Number.POSITIVE_INFINITY, false),
      stackedBarSvg(Number.NaN, [{ share: Number.NaN, color: '#000000' }]),
      sparkSvg([Number.NaN, -1, Number.POSITIVE_INFINITY], 6, Number.NaN, THEME.primary),
      sparkSvg([1, 2], 0, undefined, THEME.primary),
    ]
    for (const s of cases) expect(svgSafe(s)).toBe(true)
  })
})

describe('svgArt suit', () => {
  test('pixelRects: a run of one color in a row is one rect', () => {
    const s = pixelRects([['#AA0000', '#AA0000', '#AA0000', undefined, '#00AA00'], [undefined, undefined]])
    expect(count(s, /<rect /g)).toBe(2)
    expect(s).toContain(`width="${3 * CELL_PX_W}"`)
    expect(s).toContain(`height="${CELL_PX_H / 2}"`)
    // rows sit on half-pixel edges: crisp edges keep a seam of background from showing between them
    expect(count(s, /shape-rendering="crispEdges"/g)).toBe(2)
  })

  test('suitSvg: the canvas in cells, corners when sighted', () => {
    const px = framePixels(0, { busy: false, now: 0, still: true }).px
    const s = suitSvg(px, { sights: true })
    expect(attr(s, 'width')).toBe(String(cellPx(32 + 4)))
    expect(attr(s, 'height')).toBe(String(rowPx(16)))
    expect(s).toContain(`stroke="${THEME.frame}"`)
    expect(count(s, /<rect /g)).toBeGreaterThan(20)
    expect(count(s, /<rect /g)).toBeLessThan(600)
    expect(svgSafe(s)).toBe(true)
  })

  test('suitSvg: breath quicker when busy, the eyes flash fast on a deploy', () => {
    const px = framePixels(0, { busy: false, now: 0, still: true }).px
    const dur = (s: string) => s.match(/<animateTransform[^>]* dur="([^"]+)"/)?.[1]
    expect(dur(suitSvg(px, { busy: false }))).toBe('3s')
    expect(dur(suitSvg(px, { busy: true }))).toBe('1.5s')
    expect(suitSvg(px, { crewFlash: true })).toMatch(/attributeName="opacity"[^>]* dur="0.3s"/)
  })

  test('suitSvg: paused has no scan line nor motion; still (the boot art) none either', () => {
    const px = framePixels(0, { busy: false, now: 0, still: true }).px
    expect(suitSvg(px, {})).toContain('class="scan"')
    expect(suitSvg(px, { paused: true })).not.toContain('class="scan"')
    expect(suitSvg(px, { paused: true })).not.toContain('<animate')
    expect(suitSvg(suitArtPixels(), { still: true })).not.toContain('<animate')
    expect(attr(suitSvg(suitArtPixels(), { still: true }), 'width')).toBe(String(cellPx(24)))
  })

  test('suitSvg takes an empty picture without throwing', () => {
    expect(svgSafe(suitSvg([], {}))).toBe(true)
    expect(svgSafe(suitSvg([[undefined]], { sights: true }))).toBe(true)
  })
})

describe('svgArt reactor and digits', () => {
  test('reactorSvg: a cell; pulsing only when live', () => {
    expect(attr(reactorSvg(true), 'width')).toBe(String(CELL_PX_W))
    expect(reactorSvg(true)).toContain('<animate attributeName="r"')
    expect(reactorSvg(false)).not.toContain('<animate')
    expect(reactorSvg(false)).toContain(`fill="${THEME.muted}"`)
  })

  test('bigTextSvg: the digits in cells, three rows tall, one color', () => {
    const s = bigTextSvg('92%', THEME.primary)
    expect(attr(s, 'width')).toBe(String(cellPx(bigWidth('92%'))))
    expect(attr(s, 'height')).toBe(String(rowPx(BIG_ROWS)))
    expect(count(s, /<rect /g)).toBeGreaterThan(5)
    expect(count(s, new RegExp(`fill="(?!${THEME.primary})[^"]*"`, 'g'))).toBe(0)
    expect(svgSafe(bigTextSvg('', THEME.error))).toBe(true)
  })
})

describe('svgArt rings and burn', () => {
  const dash = (s: string) => s.match(/class="arc"[^>]* stroke-dasharray="([\d.]+) ([\d.]+)"/)

  test('ringSvg: the ring in cells; no arc at 0%, a whole turn at 100%', () => {
    const s = ringSvg(RING_SMALL, 0.5, false, [])
    expect(attr(s, 'width')).toBe(String(cellPx(RING_SMALL.w)))
    expect(attr(s, 'height')).toBe(String(rowPx(RING_SMALL.h / 2)))
    expect(count(ringSvg(RING_BIG, 0, false, []), /class="arc"/g)).toBe(0)
    const full = dash(ringSvg(RING_BIG, 1, false, []))
    expect(full?.[1]).toBe(full?.[2])
    const half = dash(ringSvg(RING_BIG, 0.5, false, []))
    expect(Math.abs(Number(half?.[1]) - Number(half?.[2]) / 2)).toBeLessThan(0.05)
  })

  test('ringSvg: red when depleted; labels on their rows; a box keeps the ring at its top', () => {
    expect(ringSvg(RING_BIG, 0.3, true, [])).toContain(`stroke="${THEME.error}"`)
    const s = ringSvg(RING_BIG, 0.3, false, [{ row: 7, text: 'RESET 15:00 <x>', color: THEME.frame, bold: true }], { cols: 30, rows: 8 })
    expect(attr(s, 'width')).toBe(String(cellPx(30)))
    expect(attr(s, 'height')).toBe(String(rowPx(8)))
    expect(s).toContain('RESET 15:00 &lt;x&gt;')
    expect(s).toContain('font-weight="bold"')
  })

  test('burnSvg: a bar an hour with tokens, the hour now bright, axis and ticks', () => {
    const hours = Array.from({ length: 24 }, (_, h) => (h === 3 || h === 9 || h === 15 ? h * 10 : 0))
    const s = burnSvg(hours, 48, 4, 15, [0, 6, 12, 18])
    expect(attr(s, 'width')).toBe(String(cellPx(48)))
    expect(attr(s, 'height')).toBe(String(rowPx(4 + 2)))
    expect(count(s, /class="bar"/g)).toBe(3)
    expect(count(s, /class="floor"/g)).toBe(21)
    expect(s).toMatch(new RegExp(`class="bar"[^>]* fill="${THEME.bright}"`))
    expect(count(s, /class="now"/g)).toBe(1)
    expect(s).toContain('>18</text>')
  })

  test('rings and burn take odd input without throwing', () => {
    const cases = [
      ringSvg(RING_SMALL, Number.NaN, false, []),
      ringSvg(RING_BIG, 7, false, [], { cols: Number.NaN, rows: -1 }),
      burnSvg([], 24, 3, Number.NaN, []),
      burnSvg([Number.NaN, -5, Number.POSITIVE_INFINITY], 0, 0, 30, [0, 12]),
    ]
    for (const s of cases) expect(svgSafe(s)).toBe(true)
  })
})

describe('svgArt rules', () => {
  test('a rule takes exactly its cells, one row, and draws a line across them', () => {
    const s = ruleSvg('──', THEME.frame)
    expect(cellWidth('──')).toBe(2)
    expect(attr(s, 'width')).toBe(String(cellPx(2)))
    expect(attr(s, 'height')).toBe(String(CELL_PX_H))
    expect(s).toContain('M0 9.5H8M8 9.5H16')
    expect(s).toContain(`stroke="${THEME.frame}"`)
    expect(svgSafe(s)).toBe(true)
  })

  test('corners, sides and tees reach the edges they join; rounded corners arc', () => {
    expect(ruleSvg('│', '#fff')).toContain('M4 0V19')
    expect(ruleSvg('┌', '#fff')).toContain('M4 9.5H8M4 9.5V19')
    expect(ruleSvg('┘', '#fff')).toContain('M0 9.5H4M4 0V9.5')
    expect(ruleSvg('┼', '#fff')).toContain('M0 9.5H8M4 0V19')
    expect(ruleSvg('╭', '#fff')).toMatch(/A4 4 0 0 1 /)
    expect(ruleSvg('╯', '#fff')).toMatch(/A4 4 0 0 0 /)
    expect(count(ruleSvg('┄', '#fff'), /M[\d.]+ 9\.5H/g)).toBe(3)
    expect(ruleSvg('━', '#fff')).toContain('stroke-width="3"')
    for (const t of ['╭─ ', ' │', '╰──╯', '├┤┬┴', '═║', '┆╌']) expect(svgSafe(ruleSvg(t, '#fff'))).toBe(true)
  })

  test('spaces take their cells and draw nothing', () => {
    const s = ruleSvg(' ─ ', '#fff')
    expect(attr(s, 'width')).toBe(String(cellPx(3)))
    expect(s).toContain('M8 9.5H16')
    expect(count(s, /<path/g)).toBe(1)
  })

  test('a glyph it cannot draw gives nothing, for the caller to fall back on', () => {
    expect(ruleSvg('─x', '#fff')).toBe('')
    expect(ruleSvg('╔═╗', '#fff')).toBe('')
  })

  test('the same rule draws the same source', () => {
    expect(ruleSvg('╭──╮', THEME.frame)).toBe(ruleSvg('╭──╮', THEME.frame))
  })
})
