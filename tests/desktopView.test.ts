import { describe, expect, test } from 'claude-code/testing'

import { DT } from '../hooks/desktopTheme'
import { mdCell } from '../hooks/desktopView'
import { SUIT_CANVAS_COLS, SUIT_CANVAS_ROWS, SUIT_TICK_MS } from '../hooks/suit'
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
  test('the root fills the pane in the dark background, in flow, growing with its content', async ($, on) => {
    native(on)
    const tree = await drawOn($, 'desktop', 45, 80)
    expect(tree.type).toBe('Box')
    expect(tree.props?.['backgroundColor']).toBe(DT.bg)
    expect(tree.props?.['minHeight']).toBe(45)
    expect(tree.props?.['paddingX']).toBe(2)
    expect(tree.props?.['paddingY']).toBe(1)
    expect(tree.props?.['flexDirection']).toBe('column')
    expect(all(tree, x => x.props?.['position'] !== undefined)).toHaveLength(0)
  })

  test('the title bar, tabs and page sit in flow; the glow strip is in the title card, under the title', async ($, on) => {
    native(on)
    const tree = await drawOn($, 'desktop', 45, 80)
    const [title, tabs, page] = (tree.children ?? []) as Node[]
    expect(textOf(title as Node)).toContain('J.A.R.V.I.S.')
    expect(title?.props?.['backgroundColor']).toBe(DT.glass)
    expect(textOf(tabs as Node)).toContain('統計')
    expect(svgs(page as Node).some(s => altOf(s) === 'MARK XLII')).toBe(true)
    const strip = (title?.children ?? []).filter((c): c is Node => typeof c !== 'string').at(-1)
    expect(strip?.type).toBe('Svg')
    expect(altOf(strip as Node)).toBe('背景')
    expect(strip?.props?.['width']).toBe(cellPx(80 - 4 - 6))
    expect(strip?.props?.['height']).toBe(rowPx(1))
    wellFormed(tree, 80)
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

  test('the tabs are orange glass pills: the current lit, the rest faint glass; no native variant anywhere', async ($, on) => {
    native(on)
    const tree = await drawOn($, 'desktop')
    const tabs = pills(tree).filter(p => textOf(p).includes('現況') || textOf(p).includes('統計'))
    const now = tabs.find(p => textOf(p).includes('現況'))
    const stats = tabs.find(p => textOf(p).includes('統計'))
    expect(now?.props?.['backgroundColor']).toBe(DT.orangeFill)
    expect(now?.props?.['borderColor']).toBe(DT.orange)
    expect(stats?.props?.['backgroundColor']).toBe(DT.pillBg)
    expect(stats?.props?.['borderColor']).toBe(DT.orangeLine)
    expect(all(tree, x => x.type === 'Button' && x.props?.['variant'] !== undefined)).toHaveLength(0)
    expect(textOf(tree)).toContain('J.A.R.V.I.S.')
  })

  test('pressing the stats pill opens the stats page, still native', async ($, on) => {
    native(on)
    await pressOn($, 'desktop', 'tab-stats')
    const tree = await drawOn($, 'desktop')
    expect(tree.props?.['backgroundColor']).toBe(DT.bg)
    const stats = pills(tree).find(p => textOf(p).includes('統計'))
    expect(stats?.props?.['backgroundColor']).toBe(DT.orangeFill)
  })

  test('an inactive tab reads in orange, the current one in bright orange and bold', async ($, on) => {
    native(on)
    const tree = await drawOn($, 'desktop')
    const label = (word: string) => all(pills(tree).find(p => textOf(p).includes(word)) as Node, x => x.type === 'Text')[0]
    expect(label('統計')?.props?.['color']).toBe(DT.orange)
    expect(label('統計')?.props?.['bold']).toBeFalsy()
    expect(label('現況')?.props?.['color']).toBe(DT.orangeBright)
    expect(label('現況')?.props?.['bold']).toBe(true)
  })

  test('the MARK line is orange, not a faint tone', async ($, on) => {
    native(on)
    const tree = await drawOn($, 'desktop', 50, 100)
    const mark = all(tree, x => x.type === 'Text' && textOf(x) === 'MARK XLII · STANDBY')[0]
    expect(mark?.props?.['color']).toBe(DT.orange)
  })

  test('only props Desktop 2.1.295 accepts', async ($, on) => {
    native(on)
    expect(badProps(await drawOn($, 'desktop'))).toEqual([])
    await pressOn($, 'desktop', 'tab-stats')
    expect(badProps(await drawOn($, 'desktop'))).toEqual([])
  })

  test('the terminal and mobile keep the old drawing', async ($, on) => {
    native(on)
    expect((await drawOn($, 'terminal')).props?.['backgroundColor']).not.toBe(DT.bg)
    expect((await drawOn($, 'mobile')).props?.['backgroundColor']).not.toBe(DT.bg)
  })

  test('the cells layout by name keeps the old desktop now page', async ($, on) => {
    engine(on, 'agent-1', 'cells')
    expect((await drawOn($, 'desktop')).props?.['backgroundColor']).not.toBe(DT.bg)
  })
})

describe('desktop native: narrow panes', () => {
  const NARROW = [10, 16, 20, 24, 30]
  // the card never narrower than 16 cells inside, however narrow the pane
  const cardInner = (cols: number) => Math.max(16, cols - 4 - 6)
  const LONG = 'a description long enough to need cutting short in a narrow card '.repeat(3)
  // a row of fixed columns: each child's width (a picture's in cells), all at least a cell, and the gaps
  const rowWidth = (row: Node): number => {
    const kids = (row.children ?? []).filter((c): c is Node => typeof c !== 'string')
    const widths = kids.map(k => (k.type === 'Svg' ? Number(k.props?.['width']) / cellPx(1) : Number(k.props?.['width'])))
    expect(widths.every(w => Number.isFinite(w) && w >= 1)).toBe(true)
    return widths.reduce((x, y) => x + y, 0) + Number(row.props?.['gap'] ?? 0) * (kids.length - 1)
  }
  const fixedRows = (tree: Node): Node[] =>
    all(tree, x => {
      if (x.type !== 'Box' || x.props?.['flexDirection'] !== 'row') return false
      const kids = (x.children ?? []).filter((c): c is Node => typeof c !== 'string')
      return kids.length > 0 && kids.every(k => (k.type === 'Box' || k.type === 'Svg') && k.props?.['width'] !== undefined)
    })

  test('the subagent and recent event rows at cols 10 to 30: columns give way down to the essentials', async ($, on) => {
    native(on)
    await $.agent.spawn(spawnInput(LONG, 'Explore'))
    await $.tool.call({ tool: 'Bash', command: LONG } as never)
    for (const cols of NARROW) {
      const tree = await drawOn($, 'desktop', 50, cols)
      const agent = all(tree, x => x.type === 'Box' && x.props?.['flexDirection'] === 'row' && all(x, y => y.type === 'Button' && y.props?.['key'] === 'agent-agent-1').length > 0).at(-1) as Node
      expect(rowWidth(agent)).toBeLessThanOrEqual(cardInner(cols))
      // MK-n and its phase are always there
      expect(textOf(agent)).toContain('MK-1')
      expect(textOf(agent)).toMatch(/INIT|ACTIVE|WAITING/)
      const events = all(tree, x => x.type === 'Box' && x.props?.['flexDirection'] === 'row' && textOf(x).includes('結果'))
      const header = events.at(-1) as Node
      expect(textOf(header)).toContain('描述')
      for (const row of fixedRows(tree)) expect(rowWidth(row)).toBeLessThanOrEqual(cardInner(cols))
      expect(badProps(tree)).toEqual([])
    }
  })

  test('the in-flight rows at cols 10 to 30 and wider: every column fixed, all within the card', async ($, on) => {
    let kept: unknown[] = []
    on('state.set', { plugin: 'jarvis', key: 'inflight' }, async (_$, e, next) => {
      if (e.value.length > 0) kept = [...e.value]
      return next({ ...e, value: kept as typeof e.value })
    })
    native(on)
    await $.tool.call({ tool: 'mcp__github__search_code', q: 'x' } as never)
    for (const cols of [...NARROW, 50, 80, 100, 140]) {
      const tree = await drawOn($, 'desktop', 50, cols)
      const flightCard = all(tree, x => x.type === 'Box' && x.props?.['borderStyle'] === 'round' && textOf(((x.children ?? [])[0] ?? '') as Node).includes('進行中'))[0] as Node
      const rows = fixedRows(flightCard)
      expect(rows).toHaveLength(1)
      const row = rows[0] as Node
      // the flight card is half the pane beside the recent events when wide (gap 2)
      const room = cols >= 90 ? Math.max(16, Math.floor((cols - 4 - 2) / 2) - 6) : cardInner(cols)
      expect(rowWidth(row)).toBeLessThanOrEqual(room)
      // who and the description always stay
      expect((row.children ?? []).length).toBeGreaterThanOrEqual(2)
      if (cols >= 50) expect(textOf(row)).toContain('mcp__github__search_code')
      expect(badProps(tree)).toEqual([])
    }
  })

  test('the DISPATCH rows at cols 10 to 30', async ($, on) => {
    native(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await pressOn($, 'desktop', 'tab-stats')
    for (const cols of NARROW) {
      const tree = await drawOn($, 'desktop', 50, cols)
      const rows = all(tree, x => x.type === 'Box' && x.props?.['flexDirection'] === 'row' && (x.children ?? []).some(c => typeof c !== 'string' && all(c, y => y.type === 'Button' && String(y.props?.['key']).startsWith('role-')).length > 0))
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(rowWidth(row)).toBeLessThanOrEqual(cardInner(cols))
        expect(textOf(row)).toMatch(/\d/)
      }
      expect(badProps(tree)).toEqual([])
    }
  })
})

describe('desktop layout switch: JARVIS_DESKTOP_LAYOUT', () => {
  const TAB_PAGES = ['now', 'log', 'stats', 'fleet', 'changes', 'tasks'] as const
  const LABELS: Record<(typeof TAB_PAGES)[number], string> = { now: '現況', log: '事件流', stats: '統計', fleet: '艦隊', changes: '異動', tasks: '任務' }
  // each tab's Desktop drawing: whether its root is the native dark background
  const nativeByTab = async ($: Parameters<typeof drawOn>[0]) => {
    const out: Record<string, boolean> = {}
    for (const page of TAB_PAGES) {
      await pressOn($, 'desktop', `tab-${page}`)
      const tree = await drawOn($, 'desktop')
      expect(textOf(tree)).toContain('J.A.R.V.I.S.')
      out[page] = tree.props?.['backgroundColor'] === DT.bg
      // the press went through: the native page lights its own tab
      if (out[page]) expect(pills(tree).filter(p => p.props?.['backgroundColor'] === DT.orangeFill).map(textOf).join()).toContain(LABELS[page])
    }
    return out
  }
  const every = (v: boolean) => Object.fromEntries(TAB_PAGES.map(p => [p, v]))
  const withBoard = (on: Parameters<typeof engine>[0]) => on('tool.register', async (_$, e) => ({ value: { tool: `mcp__jarvis__${e.name}` } }))

  test('cells: every tab on Desktop draws the cell grid, not the native page', async ($, on) => {
    withBoard(on)
    engine(on, 'agent-1', 'cells')
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    expect(await nativeByTab($)).toEqual(every(false))
  })

  test('unset: every tab on Desktop draws the native page', async ($, on) => {
    withBoard(on)
    native(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    expect(await nativeByTab($)).toEqual(every(true))
  })

  test('cells leaves the terminal drawing as it was', async ($, on) => {
    engine(on, 'agent-1', 'cells')
    expect((await drawOn($, 'terminal')).props?.['backgroundColor']).not.toBe(DT.bg)
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

  // a cell width of a drawn node: pictures by their width, text by its length, boxes by their children, gap and frame
  const widthOf = (n: Node | string): number => {
    if (typeof n === 'string') return n.length
    if (n.type === 'Svg') return Number(n.props?.['width']) / cellPx(1)
    if (n.type === 'Text') return textOf(n).length
    const kids = (n.children ?? []).map(widthOf)
    const gap = Number(n.props?.['gap'] ?? 0)
    const framed = (n.props?.['borderStyle'] ? 2 : 0) + Number(n.props?.['paddingX'] ?? 0) * 2
    const sum = kids.reduce((x, y) => x + y, 0)
    return (n.props?.['flexDirection'] === 'row' ? sum + gap * Math.max(0, kids.length - 1) : Math.max(0, ...kids)) + framed
  }
  const suitRow = (tree: Node): Node =>
    all(tree, x => x.type === 'Box' && (x.children ?? []).some(c => typeof c !== 'string' && c.type === 'Svg' && altOf(c) === 'MARK XLII')).at(-1) as Node
  const tilesIn = (n: Node) => all(n, x => x.type === 'Box' && x.props?.['backgroundColor'] === DT.glassRaised)

  test('the suit row by the room it needs: three across, then a shrunk suit with the tiles stacked, then all stacked', async ($, on) => {
    native(on)
    const full = SUIT_CANVAS_COLS + 4
    const ratio = SUIT_CANVAS_ROWS / full
    for (const cols of [140, 100, 80, 71, 66, 60, 50]) {
      const tree = await drawOn($, 'desktop', 50, cols)
      const row = suitRow(tree)
      const cardInner = cols - 4 - 6
      expect(tilesIn(row)).toHaveLength(2)
      const kids = (row.children ?? []).filter((c): c is Node => typeof c !== 'string')
      const dir = row.props?.['flexDirection']
      const suit = svgs(row).find(s => altOf(s) === 'MARK XLII') as Node
      const w = Number(suit.props?.['width']) / cellPx(1)
      const h = Number(suit.props?.['height']) / rowPx(1)
      if (cols >= 84) {
        expect(dir).toBe('row')
        expect(kids).toHaveLength(3)
        expect(kids[1]?.type).toBe('Svg')
        expect(w).toBe(full)
        expect(h).toBe(SUIT_CANVAS_ROWS)
      } else if (cols >= 60) {
        expect(dir).toBe('row')
        expect(kids).toHaveLength(2)
        expect(kids[0]?.type).toBe('Svg')
        const col = kids[1] as Node
        expect(col.props?.['flexDirection']).toBe('column')
        expect(col.props?.['gap']).toBe(1)
        expect(tilesIn(col)).toHaveLength(2)
        expect(w).toBeGreaterThanOrEqual(24)
        expect(Math.abs(h - w * ratio)).toBeLessThanOrEqual(1)
        expect(w).toBe(Math.min(full, cardInner - 2 - widthOf(col)))
        if (cols <= 60) expect(w).toBeLessThan(full)
      } else {
        expect(dir).toBe('column')
        expect(kids.map(k => k.type)).toEqual(['Box', 'Svg', 'Box'])
        expect(w).toBe(full)
        expect(h).toBe(SUIT_CANVAS_ROWS)
      }
      expect(widthOf(row)).toBeLessThanOrEqual(cardInner)
      expect(badProps(tree)).toEqual([])
    }
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
    const detail = await drawOn($, 'desktop', 50, 100)
    expect(detail.props?.['backgroundColor']).toBe(DT.bg)
    expect(textOf(detail)).toContain('返回')
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

  test('recent events are rows of fixed columns under a header; a | in a description stays as written', async ($, on) => {
    native(on)
    await $.agent.spawn(spawnInput('a | b', 'Explore'))
    await $.turn.complete(complete('agent-1'))
    await $.tool.call({ tool: 'Bash', command: 'echo a | b' } as never)
    const tree = await drawOn($, 'desktop', 50, 100)
    expect(all(tree, x => x.type === 'Markdown' && String(x.props?.['text'] ?? '').includes('時間'))).toHaveLength(0)
    const header = all(tree, x => x.type === 'Box' && x.props?.['flexDirection'] === 'row' && textOf(x).includes('描述') && textOf(x).includes('結果')).at(-1)
    expect(header).toBeDefined()
    expect(all(header as Node, x => x.type === 'Text').every(t => t.props?.['color'] === DT.textSub)).toBe(true)
    expect(textOf(tree)).toContain('echo a | b')
  })

  test('a recent event row never reaches past its card: fixed columns add up within the card', async ($, on) => {
    native(on)
    await $.tool.call({ tool: 'Bash', command: 'a command long enough to need cutting short in a narrow card '.repeat(3) } as never)
    for (const cols of [50, 80, 100, 140]) {
      const tree = await drawOn($, 'desktop', 50, cols)
      const row = all(tree, x => x.type === 'Box' && x.props?.['flexDirection'] === 'row' && textOf(x).includes('描述') && textOf(x).includes('結果')).at(-1) as Node
      const kids = (row.children ?? []).filter((c): c is Node => typeof c !== 'string')
      const widths = kids.map(k => Number(k.props?.['width']))
      expect(widths.every(w => Number.isFinite(w) && w > 0)).toBe(true)
      expect(all(row, x => x.type === 'Text').every(t => t.props?.['wrap'] === 'truncate')).toBe(true)
      const gap = Number(row.props?.['gap'] ?? 0)
      // the card's inner width: half the pane beside the in-flight card when wide (gap 2), less the card's frame and padding
      const inner = cols - 4
      const cardInner = cols >= 90 ? Math.floor((inner - 2) / 2) - 6 : inner - 6
      expect(widths.reduce((x, y) => x + y, 0) + gap * (kids.length - 1)).toBeLessThanOrEqual(cardInner)
      if (cols === 50) expect(textOf(row)).not.toContain('時間')
    }
  })

  test('mdCell escapes backslashes, Markdown marks and lone carriage returns', () => {
    expect(mdCell('a\\|b')).toBe('a\\\\\\|b')
    expect(cells(`| ${mdCell('a\\|b')} |`)).toHaveLength(1)
    expect(mdCell('__init__.py')).toBe('\\_\\_init\\_\\_.py')
    expect(mdCell('a\rb\r\nc')).toBe('a b c')
    expect(mdCell('`x` *y* [z] <w> ~v~')).toBe('\\`x\\` \\*y\\* \\[z\\] \\<w\\> \\~v\\~')
  })

  test('mdCell escapes pipes and flattens line breaks', () => {
    expect(mdCell('a|b\nc')).toBe('a\\|b c')
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
