import { describe, expect, test } from 'claude-code/testing'

import { BURN_RAMP, GAUGE_RAMP } from '../hooks/fleetChart'
import { THEME, cellWidth } from '../hooks/jarvis'
import {
  CELL_PX_H,
  CELL_PX_W,
  SVG_MAX,
  cellPx,
  gaugeBarSvg,
  meterSvg,
  pixelRects,
  rampBarSvg,
  rowPx,
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
