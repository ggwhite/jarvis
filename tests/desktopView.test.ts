import { describe, expect, test } from 'claude-code/testing'

import { DT } from '../hooks/desktopTheme'
import { cellPx, rowPx } from '../hooks/svgArt'
import { all, drawOn, engine, pressOn, svgs, textOf } from './desktopSvg.test'
import type { Node } from './desktopSvg.test'
import { badProps } from './allowedProps'

const native = (on: Parameters<typeof engine>[0]) => engine(on, 'agent-1', 'native')
const pills = (tree: Node) =>
  all(tree, x => x.type === 'Box' && x.props?.['borderStyle'] === 'round' && (x.children ?? []).some(c => typeof c !== 'string' && c.type === 'Button'))

describe('desktop native: frame', () => {
  test('the root fills the pane in the light background with the backdrop behind', async ($, on) => {
    native(on)
    const tree = await drawOn($, 'desktop', 45, 80)
    expect(tree.type).toBe('Box')
    expect(tree.props?.['backgroundColor']).toBe(DT.bg)
    expect(tree.props?.['minHeight']).toBe(45)
    expect(tree.props?.['position']).toBe('relative')
    const layer = (tree.children ?? [])[0] as Node
    expect(layer.props?.['position']).toBe('absolute')
    const bd = svgs(layer)[0]
    expect(bd?.props?.['width']).toBe(cellPx(80))
    expect(bd?.props?.['height']).toBe(rowPx(45))
  })

  test('the tabs are orange pills: the current solid, the rest pale; no native variant anywhere', async ($, on) => {
    native(on)
    const tree = await drawOn($, 'desktop')
    const tabs = pills(tree).filter(p => textOf(p).includes('現況') || textOf(p).includes('統計'))
    const now = tabs.find(p => textOf(p).includes('現況'))
    const stats = tabs.find(p => textOf(p).includes('統計'))
    expect(now?.props?.['backgroundColor']).toBe(DT.orange500)
    expect(stats?.props?.['backgroundColor']).toBe(DT.orange50)
    expect(all(tree, x => x.type === 'Button' && x.props?.['variant'] !== undefined)).toHaveLength(0)
    expect(textOf(tree)).toContain('J.A.R.V.I.S.')
  })

  test('pressing the stats pill opens the stats page, still native', async ($, on) => {
    native(on)
    await pressOn($, 'desktop', 'tab-stats')
    const tree = await drawOn($, 'desktop')
    expect(tree.props?.['backgroundColor']).toBe(DT.bg)
    const stats = pills(tree).find(p => textOf(p).includes('統計'))
    expect(stats?.props?.['backgroundColor']).toBe(DT.orange500)
  })

  test('only props Desktop 2.1.295 accepts', async ($, on) => {
    native(on)
    expect(badProps(await drawOn($, 'desktop'))).toEqual([])
    await pressOn($, 'desktop', 'tab-stats')
    expect(badProps(await drawOn($, 'desktop'))).toEqual([])
  })

  test('other pages, the terminal, mobile and JARVIS_DESKTOP_LAYOUT=cells keep the old drawing', async ($, on) => {
    native(on)
    await pressOn($, 'desktop', 'tab-fleet')
    expect((await drawOn($, 'desktop')).props?.['backgroundColor']).not.toBe(DT.bg)
    await pressOn($, 'desktop', 'tab-now')
    expect((await drawOn($, 'terminal')).props?.['backgroundColor']).not.toBe(DT.bg)
    expect((await drawOn($, 'mobile')).props?.['backgroundColor']).not.toBe(DT.bg)
  })

  test('the cells layout by name keeps the old desktop now page', async ($, on) => {
    engine(on, 'agent-1', 'cells')
    expect((await drawOn($, 'desktop')).props?.['backgroundColor']).not.toBe(DT.bg)
  })
})
