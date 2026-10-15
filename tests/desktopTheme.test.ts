import { describe, expect, test } from 'claude-code/testing'

import { DT, GLASS, backdropSvg } from '../hooks/desktopTheme'
import { DARK, meterSvg, rampBarSvg, reactorSvg, sparkSvg, stackedBarSvg, suitSvg, svgSafe, cellPx, rowPx } from '../hooks/svgArt'
import { THEME } from '../hooks/jarvis'
import { framePixels } from '../hooks/suit'
import { badProps } from './allowedProps'

describe('desktop theme: palettes', () => {
  test('the default palette is the dark one: every picture byte-identical to passing DARK', () => {
    const px = framePixels(0, { busy: false, now: 0, still: true }).px
    expect(meterSvg(2, 5, THEME.primary)).toBe(meterSvg(2, 5, THEME.primary, DARK))
    expect(rampBarSvg(10, 0.5, [THEME.frame, THEME.primary])).toBe(rampBarSvg(10, 0.5, [THEME.frame, THEME.primary], DARK))
    expect(stackedBarSvg(10, [])).toBe(stackedBarSvg(10, [], DARK))
    expect(sparkSvg([], 10, undefined, THEME.accent)).toBe(sparkSvg([], 10, undefined, THEME.accent, DARK))
    expect(suitSvg(px, { sights: true })).toBe(suitSvg(px, { sights: true }, DARK))
    expect(reactorSvg(false)).toBe(reactorSvg(false, DARK))
  })

  test('the glass palette paints the muted parts in its own tones', () => {
    expect(meterSvg(1, 3, DT.orange, GLASS)).toContain(`fill="${GLASS.muted}"`)
    expect(meterSvg(1, 3, DT.orange, GLASS)).not.toContain(THEME.muted)
    expect(rampBarSvg(10, 0, [DT.orangeBright], GLASS)).toContain(`fill="${GLASS.muted}"`)
    expect(reactorSvg(true, GLASS)).toContain(`fill="${DT.data}"`)
    const px = framePixels(0, { busy: false, now: 0, still: true }).px
    expect(suitSvg(px, { sights: true }, GLASS)).toContain(`stroke="${DT.orange}"`)
  })

  test('the backdrop fills the pane: gradient, glows, dots; safe; only cols and rows decide it', () => {
    const s = backdropSvg(80, 45)
    expect(svgSafe(s)).toBe(true)
    expect(s).toContain(`width="${cellPx(80)}"`)
    expect(s).toContain(`height="${rowPx(45)}"`)
    expect(s).toContain('linearGradient')
    expect(s).toContain('radialGradient')
    expect(s).toContain('<pattern')
    expect(backdropSvg(80, 45)).toBe(s)
  })

  test('the backdrop is dark: charcoal to navy, an orange glow, a blue glow, faint white dots', () => {
    const s = backdropSvg(80, 1)
    expect(s).toContain(`stop-color="${DT.bg}"`)
    expect(s).toContain(`stop-color="${DT.bgTo}"`)
    expect(s).toContain(`stop-color="${DT.orange}" stop-opacity="0.18"`)
    expect(s).toContain(`stop-color="${DT.blue}" stop-opacity="0.12"`)
    expect(s).toContain('fill="#FFFFFF" fill-opacity="0.04"')
  })
})

describe('desktop theme: allowed props', () => {
  test('a prop outside the 2.1.295 list is reported by element and name', () => {
    const tree = {
      type: 'Box',
      props: { gap: 1, flexDirection: 'column' },
      children: [
        { type: 'Text', props: { color: '#000', mono: true }, children: ['x'] },
        { type: 'Button', props: { key: 'k', plain: true, onPress: () => undefined }, children: [{ type: 'Text', props: {}, children: ['y'] }] },
      ],
    }
    expect(badProps(tree)).toEqual(['Text.mono'])
  })

  test('an element type outside the list is reported', () => {
    expect(badProps({ type: 'Client', props: {} })).toEqual(['Client'])
  })

  test('key is for Button and Markdown only; onPress for Button only; onLinkPress for Markdown only', () => {
    expect(badProps({ type: 'Box', props: { key: 'k' } })).toEqual(['Box.key'])
    expect(badProps({ type: 'Svg', props: { key: 'k' } })).toEqual(['Svg.key'])
    expect(badProps({ type: 'Text', props: { onPress: () => undefined } })).toEqual(['Text.onPress'])
    expect(badProps({ type: 'Button', props: { key: 'k', onPress: () => undefined } })).toEqual([])
    expect(badProps({ type: 'Markdown', props: { key: 'k', onLinkPress: () => undefined } })).toEqual([])
    expect(badProps({ type: 'Markdown', props: { onPress: () => undefined } })).toEqual(['Markdown.onPress'])
  })

  test('weight passes only as the engine echo of bold', () => {
    expect(badProps({ type: 'Text', props: { bold: true, weight: 'semibold' } })).toEqual([])
    expect(badProps({ type: 'Text', props: { weight: 'bold' } })).toEqual(['Text.weight'])
    expect(badProps({ type: 'Text', props: { bold: true, weight: 'bold' } })).toEqual(['Text.weight'])
    expect(badProps({ type: 'Text', props: { weight: 'semibold' } })).toEqual(['Text.weight'])
  })
})
