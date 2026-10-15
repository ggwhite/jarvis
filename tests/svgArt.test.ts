import { describe, expect, test } from 'claude-code/testing'

import { THEME, cellWidth } from '../hooks/jarvis'
import { CELL_PX_H, CELL_PX_W, SVG_MAX, cellPx, meterSvg, rowPx, svgDoc, svgSafe } from '../hooks/svgArt'

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
