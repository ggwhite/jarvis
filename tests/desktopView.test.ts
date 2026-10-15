import { describe, expect, test } from 'claude-code/testing'

import { DT } from '../hooks/desktopTheme'
import { eventsTable, mdCell } from '../hooks/desktopView'
import { SUIT_TICK_MS } from '../hooks/suit'
import { cellPx, rowPx } from '../hooks/svgArt'
import { all, altOf, complete, drawOn, engine, pressOn, sourceOf, spawnInput, svgs, textOf, wellFormed } from './helpers'
import type { Node } from './helpers'
import { badProps } from './allowedProps'

const native = (on: Parameters<typeof engine>[0]) => engine(on, 'agent-1', 'native')
// a Markdown table row's cells, split as GFM does: on each pipe no backslash escapes
const cells = (line: string): string[] => {
  const out: string[] = []
  let cell = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? ''
    if (ch === '\\') {
      cell += ch + (line[i + 1] ?? '')
      i++
    } else if (ch === '|') {
      out.push(cell.trim())
      cell = ''
    } else cell += ch
  }
  return out.slice(1)
}
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

  test('the title bar, tabs and page sit in an absolute box after the absolute backdrop, painted over it', async ($, on) => {
    native(on)
    const tree = await drawOn($, 'desktop', 45, 80)
    const [layer, content] = (tree.children ?? []) as Node[]
    expect(layer?.props?.['position']).toBe('absolute')
    expect(tree.props?.['position']).toBe('relative')
    expect(content?.props?.['position']).toBe('absolute')
    expect(content?.props?.['top']).toBe(1)
    expect(content?.props?.['left']).toBe(2)
    expect(content?.props?.['width']).toBe(76)
    expect(content?.props?.['flexDirection']).toBe('column')
    expect(content?.props?.['gap']).toBe(1)
    expect(textOf(content as Node)).toContain('J.A.R.V.I.S.')
    expect(svgs(content as Node).some(s => altOf(s) === 'MARK XLII')).toBe(true)
  })

  test('a throw in the native layout draws the cell grid instead of a blank pane', async ($, on) => {
    on('ui.resolve', { surface: 'desktop' }, async (_$, e, next) => {
      const table = (await next(e)) as unknown as Record<string, (props: Record<string, unknown>) => unknown>
      const svg = table['Svg']
      // only the native layout draws the backdrop
      return { ...table, Svg: (props: Record<string, unknown>) => (props['alt'] === '背景' ? (() => { throw new Error('boom') })() : svg?.(props)) } as never
    })
    native(on)
    const tree = await drawOn($, 'desktop', 45, 80)
    expect(tree.props?.['backgroundColor']).not.toBe(DT.bg)
    expect(textOf(tree)).toContain('J.A.R.V.I.S.')
    expect(svgs(tree).some(s => altOf(s) === '背景')).toBe(false)
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

describe('desktop native: now page', () => {
  test('the suit is a glass card: the moving MARK XLII picture between two KPI tiles', async ($, on) => {
    native(on)
    const tree = await drawOn($, 'desktop', 50, 100)
    const suit = svgs(tree).find(s => altOf(s) === 'MARK XLII')
    expect(suit?.props?.['isInteractive']).toBe(true)
    expect(textOf(tree)).toContain('MARK XLII · STANDBY')
    expect(textOf(tree)).toContain('UPTIME')
    expect(all(tree, x => x.type === 'Box' && x.props?.['backgroundColor'] === DT.glassRaised).length).toBeGreaterThanOrEqual(2)
    wellFormed(tree, 100)
  })

  test('a subagent row: only MK-n in its button, the columns beside it; the press opens its detail', async ($, on) => {
    native(on)
    await $.agent.spawn(spawnInput('find the | files', 'Explore'))
    const tree = await drawOn($, 'desktop', 50, 100)
    const btn = all(tree, x => x.type === 'Button' && x.props?.['key'] === 'agent-agent-1')[0]
    expect(btn).toBeDefined()
    // the engine echoes a lone Text child as the label; the children are MK-n alone
    expect(((btn as Node).children ?? []).map(textOf).join('')).toBe('MK-1')
    expect(textOf(tree)).toContain('find the | files')
    await pressOn($, 'desktop', 'agent-agent-1', 50, 100)
    // the detail page is not native: drawCockpit draws it
    expect((await drawOn($, 'desktop', 50, 100)).props?.['backgroundColor']).not.toBe(DT.bg)
  })

  test('a subagent row never reaches past its card: fixed columns add up within the card', async ($, on) => {
    native(on)
    await $.agent.spawn(spawnInput('a description long enough to need cutting short in a narrow card '.repeat(3), 'Explore'))
    for (const cols of [50, 80, 100, 140]) {
      const tree = await drawOn($, 'desktop', 50, cols)
      const row = all(tree, x => x.type === 'Box' && x.props?.['flexDirection'] === 'row' && all(x, y => y.type === 'Button' && y.props?.['key'] === 'agent-agent-1').length > 0)
      const inner = row.at(-1) as Node
      const kids = (inner.children ?? []).filter((c): c is Node => typeof c !== 'string')
      const widths = kids.map(k => Number(k.props?.['width']))
      expect(widths.every(w => Number.isFinite(w) && w > 0)).toBe(true)
      const gap = Number(inner.props?.['gap'] ?? 0)
      // the card's inner width: the pane less its padding (2+2), the card's border (1+1) and padding (2+2)
      expect(widths.reduce((x, y) => x + y, 0) + gap * (kids.length - 1)).toBeLessThanOrEqual(cols - 4 - 6)
    }
  })

  test('recent events are a Markdown table; a | in a description is escaped', async ($, on) => {
    native(on)
    await $.agent.spawn(spawnInput('a | b', 'Explore'))
    await $.turn.complete(complete('agent-1'))
    await $.tool.call({ tool: 'Bash', command: 'echo a | b' } as never)
    const tree = await drawOn($, 'desktop', 50, 100)
    const md = all(tree, x => x.type === 'Markdown')[0]
    const text = String(md?.props?.['text'] ?? '')
    expect(text).toContain('| 時間 |')
    expect(text).toContain('echo a \\| b')
    expect(text.split('\n').filter(l => l.startsWith('|')).every(l => !/[^\\]\|[^|]*[^\\]\|.*a \| b/.test(l))).toBe(true)
  })

  test('mdCell escapes backslashes, Markdown marks and lone carriage returns', () => {
    expect(mdCell('a\\|b')).toBe('a\\\\\\|b')
    expect(cells(`| ${mdCell('a\\|b')} |`)).toHaveLength(1)
    expect(mdCell('__init__.py')).toBe('\\_\\_init\\_\\_.py')
    expect(mdCell('a\rb\r\nc')).toBe('a b c')
    expect(mdCell('`x` *y* [z] <w> ~v~')).toBe('\\`x\\` \\*y\\* \\[z\\] \\<w\\> \\~v\\~')
  })

  test('a description with an escaped pipe keeps the row to its six columns', () => {
    const t = eventsTable([{ time: '10:00:00', who: '主線', tool: 'Grep', desc: "grep 'a\\|b' x", took: '1.2s', mark: '✓' }])
    const row = cells(t.split('\n')[2] ?? '')
    expect(row).toHaveLength(6)
    expect(row[3]).toBe("grep 'a\\\\\\|b' x")
    expect(row[4]).toBe('1.2s')
  })

  test('mdCell escapes pipes and flattens line breaks; eventsTable writes a header and one row each', () => {
    expect(mdCell('a|b\nc')).toBe('a\\|b c')
    const t = eventsTable([{ time: '10:00:00', who: '主線', tool: 'Bash', desc: 'x|y', took: '1.2s', mark: '✓' }])
    const lines = t.split('\n')
    expect(lines[0]).toBe('| 時間 | 誰 | 工具 | 描述 | 耗時 | |')
    expect(lines[1]).toBe('|---|---|---|---|---:|:-:|')
    expect(lines[2]).toBe('| 10:00:00 | 主線 | Bash | x\\|y | 1.2s | ✓ |')
    expect(eventsTable([])).toBe('')
  })

  test('the tick never changes a picture while nothing else does', async ($, on) => {
    const clock = native(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await clock.advance(3000)
    const before = svgs(await drawOn($, 'desktop', 50, 100)).map(sourceOf).sort()
    await clock.advance(SUIT_TICK_MS * 3)
    const after = svgs(await drawOn($, 'desktop', 50, 100)).map(sourceOf).sort()
    expect(after).toEqual(before)
  })

  test('50 columns: every picture fits, the KPI tiles go under the suit', async ($, on) => {
    native(on)
    const tree = await drawOn($, 'desktop', 50, 50)
    wellFormed(tree, 50)
    const row = all(tree, x => x.type === 'Box' && svgs(x).some(s => altOf(s) === 'MARK XLII') && x.props?.['flexDirection'] !== undefined)
    expect(row.some(x => x.props?.['flexDirection'] === 'column')).toBe(true)
    expect(badProps(tree)).toEqual([])
  })

  test('only allowed props with a subagent, a call in flight and events', async ($, on) => {
    // beneath the mod the in-flight list keeps its last call, as if it never returned
    let kept: unknown[] = []
    on('state.set', { plugin: 'jarvis', key: 'inflight' }, async (_$, e, next) => {
      if (e.value.length > 0) kept = [...e.value]
      return next({ ...e, value: kept as typeof e.value })
    })
    native(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await $.turn.complete(complete('agent-1'))
    await $.tool.call({ tool: 'Bash', command: 'echo a | b', description: 'still going' } as never)
    const tree = await drawOn($, 'desktop', 50, 100)
    expect(textOf(tree)).toContain('still going')
    expect(badProps(tree)).toEqual([])
  })

  test('the in-flight tool column cuts a long tool name short rather than wrapping', async ($, on) => {
    let kept: unknown[] = []
    on('state.set', { plugin: 'jarvis', key: 'inflight' }, async (_$, e, next) => {
      if (e.value.length > 0) kept = [...e.value]
      return next({ ...e, value: kept as typeof e.value })
    })
    native(on)
    await $.tool.call({ tool: 'mcp__github__search_code', q: 'x' } as never)
    const tree = await drawOn($, 'desktop', 50, 100)
    const col = all(tree, x => x.type === 'Box' && x.props?.['width'] === 10 && textOf(x) === 'mcp__github__search_code')[0]
    expect(col?.props?.['overflow']).toBe('hidden')
    const label = all(col as Node, x => x.type === 'Text')[0]
    expect(label?.props?.['wrap']).toBe('truncate')
  })

  test('the subagent card counts only the successful as done', async ($, on) => {
    native(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await $.turn.complete(complete('agent-1', { reason: 'error' }))
    const text = textOf(await drawOn($, 'desktop', 50, 100))
    expect(text).toContain('0 完成')
    expect(text).not.toContain('1 完成')
  })

  test('the still suit asks the clock for no 250 ms frames', async ($, on) => {
    const periods: number[] = []
    on('clock.every', { ms: SUIT_TICK_MS }, async (_$, e, next) => {
      periods.push(e.ms)
      return next(e)
    })
    const clock = native(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.advance(10_000)
    const tree = await drawOn($, 'desktop', 50, 100)
    expect(svgs(tree).some(s => altOf(s) === 'MARK XLII')).toBe(true)
    await clock.advance(SUIT_TICK_MS * 4)
    expect(periods.filter(ms => ms === SUIT_TICK_MS)).toEqual([])
  })
})

describe('desktop native: stats page', () => {
  test('MAIN LINE: the success rate in big pixel digits, the CHAIN meter, OK and FAIL', async ($, on) => {
    native(on)
    await pressOn($, 'desktop', 'tab-stats')
    const tree = await drawOn($, 'desktop', 50, 100)
    expect(textOf(tree)).toContain('MAIN LINE')
    expect(svgs(tree).some(s => altOf(s).startsWith('SUCCESS RATE'))).toBe(true)
    expect(svgs(tree).some(s => altOf(s).startsWith('CHAIN'))).toBe(true)
    expect(textOf(tree)).toContain('OK')
    expect(textOf(tree)).toContain('FAIL')
    wellFormed(tree, 100)
  })

  test('DISPATCH: a row per role, the role name alone in its button; its press opens the role page', async ($, on) => {
    native(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await $.turn.complete(complete('agent-1'))
    await pressOn($, 'desktop', 'tab-stats', 50, 100)
    const tree = await drawOn($, 'desktop', 50, 100)
    const btn = all(tree, x => x.type === 'Button' && x.props?.['key'] === 'role-Explore')[0]
    expect(btn).toBeDefined()
    // the engine echoes a lone Text child as the label; read the children alone
    expect(((btn as Node).children ?? []).map(textOf).join('')).toContain('Explore')
    expect(svgs(btn as Node)).toHaveLength(0)
    const bars = svgs(tree).filter(s => /^(Explore|clerk|worker|verifier|fork) /.test(altOf(s)))
    expect(bars.length).toBeGreaterThan(0)
    expect(new Set(bars.map(s => s.props?.['width'])).size).toBe(1)
    await pressOn($, 'desktop', 'role-Explore', 50, 100)
    expect(textOf(await drawOn($, 'desktop', 50, 100))).toContain('返回')
  })

  test('a DISPATCH row never reaches past its card', async ($, on) => {
    native(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await pressOn($, 'desktop', 'tab-stats')
    for (const cols of [50, 80, 100, 140]) {
      const tree = await drawOn($, 'desktop', 50, cols)
      const row = all(tree, x => x.type === 'Box' && x.props?.['flexDirection'] === 'row' && all(x, y => y.type === 'Button' && y.props?.['key'] === 'role-Explore').length > 0)
      const inner = row.at(-1) as Node
      const kids = (inner.children ?? []).filter((c): c is Node => typeof c !== 'string')
      const widths = kids.map(k => (k.type === 'Svg' ? Number(k.props?.['width']) / cellPx(1) : Number(k.props?.['width'])))
      expect(widths.every(w => Number.isFinite(w) && w > 0)).toBe(true)
      const gap = Number(inner.props?.['gap'] ?? 0)
      expect(widths.reduce((x, y) => x + y, 0) + gap * (kids.length - 1)).toBeLessThanOrEqual(cols - 4 - 6)
    }
  })

  test('MODELS: one stacked bar and a Markdown table; SAVED and the cost line', async ($, on) => {
    native(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await $.turn.complete(complete('agent-1'))
    await pressOn($, 'desktop', 'tab-stats', 50, 100)
    const tree = await drawOn($, 'desktop', 50, 100)
    expect(svgs(tree).filter(s => altOf(s) === 'MODELS')).toHaveLength(1)
    const md = all(tree, x => x.type === 'Markdown').map(x => String(x.props?.['text'] ?? ''))
    expect(md.some(t => t.startsWith('| 模型 |'))).toBe(true)
    expect(textOf(tree)).toContain('SAVED')
    expect(badProps(tree)).toEqual([])
  })

  test('50 columns and allowed props', async ($, on) => {
    native(on)
    await pressOn($, 'desktop', 'tab-stats', 50, 50)
    const tree = await drawOn($, 'desktop', 50, 50)
    wellFormed(tree, 50)
    expect(badProps(tree)).toEqual([])
  })
})
