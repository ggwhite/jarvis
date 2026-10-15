import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { BIG_ROWS, bigWidth } from '../hooks/fleetChart'
import { BOOT_MS, CHAIN_WARN, cellWidth } from '../hooks/jarvis'
import { EMOJI_OF, TAB_ICON, desktopTree } from '../hooks/icons'
import { SUIT_CANVAS_ROWS, SUIT_ROWS, SUIT_TICK_MS } from '../hooks/suit'
import { CELL_PX_H, cellPx, rowPx, svgSafe } from '../hooks/svgArt'

export type Node = { type?: string; props?: Record<string, unknown>; children?: (Node | string)[] }
export type Surface = 'terminal' | 'desktop' | 'mobile'

export const HAIKU = 'claude-haiku-5-5'

export const textOf = (n: Node | string): string =>
  typeof n === 'string' ? n : [...(typeof n.props?.['label'] === 'string' ? [n.props['label']] : []), ...(n.children ?? []).map(textOf)].join('')

export const all = (n: Node | string, pred: (x: Node) => boolean, out: Node[] = []): Node[] => {
  if (typeof n === 'string') return out
  if (pred(n)) out.push(n)
  for (const k of n.children ?? []) all(k, pred, out)
  return out
}

export const svgs = (n: Node): Node[] => all(n, x => x.type === 'Svg')
export const altOf = (n: Node): string => String(n.props?.['alt'] ?? '')
export const sourceOf = (n: Node): string => String(n.props?.['source'] ?? '')

const PANE = (rows: number, cols: number) => ({
  title: 'Jarvis',
  isFocused: true,
  bodyColumns: cols,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: rows },
  view: {},
})

export const drawOn = async ($: Engine, surface: Surface, rows = 45, cols = 80): Promise<Node> =>
  (await $.ui.render({
    surface,
    component: 'Pane',
    requestId: 'jarvis',
    viewport: { columns: cols + 20, rows: rows + 10 },
    props: PANE(rows, cols),
  })) as RenderElement as Node

export const pressOn = async ($: Engine, surface: Surface, key: string, rows = 45, cols = 80) => {
  const ui = await $.ui.mount({
    plugin: 'jarvis',
    surface,
    component: 'Pane',
    requestId: 'jarvis',
    props: PANE(rows, cols),
    viewport: { columns: cols + 20, rows: rows + 10 },
  })
  await ui.press({ key })
  await ui.unmount()
}

// the engine beneath the mod, as jarvis.test.ts stands it
export const engine = (on: On, agentId = 'agent-1') => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, {})
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', async () => ({}))
  on('agent.spawn', async () => ({ model: HAIKU, agentId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('model.complete', async () => ({
    value: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  return clock
}

export const spawnInput = (description: string, subagentType: string, id = 'tu-1') => ({
  tool_use_id: id,
  prompt: 'p',
  description,
  subagentType,
  provider: { plugin: 'engine', tier: 'core' } as const,
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
})

export const complete = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  answer: 'ok',
  durationMs: 1000,
  isAborted: false,
  turnId: 't',
  reason: 'answer' as const,
  ...over,
})

// every Svg sized in whole cells and rows, safe, with words for a reader
export const wellFormed = (tree: Node, cols: number) => {
  for (const s of svgs(tree)) {
    expect(altOf(s).length).toBeGreaterThan(0)
    expect(svgSafe(sourceOf(s))).toBe(true)
    const w = Number(s.props?.['width'])
    const h = Number(s.props?.['height'])
    expect(w % 8).toBe(0)
    expect(h % CELL_PX_H).toBe(0)
    expect(w).toBeLessThanOrEqual(cellPx(cols))
  }
}

describe('desktop svg: pipeline', () => {
  test('desktopTree leaves an Svg whole and converts the rest', () => {
    const svg: Node = { type: 'Svg', props: { source: '<svg></svg>', alt: 'a', width: 8, height: 19 } }
    const tree: Node = { type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: [TAB_ICON.now] }, svg] }
    const out = desktopTree(tree)
    const first = out.children?.[0]
    expect(typeof first === 'string' ? first : first?.children?.[0]).toBe(EMOJI_OF[TAB_ICON.now])
    expect(out.children?.[1]).toBe(svg)
  })

  test('desktop stats page: the CHAIN meter is an Svg, no ▰▱ left', async ($, on) => {
    engine(on)
    await pressOn($, 'desktop', 'tab-stats')
    const tree = await drawOn($, 'desktop')
    const chain = svgs(tree).find(s => altOf(s).startsWith('CHAIN '))
    expect(chain).toBeDefined()
    expect(chain?.props?.['width']).toBe(cellPx(CHAIN_WARN))
    expect(chain?.props?.['height']).toBe(CELL_PX_H)
    expect(chain?.props?.['isInteractive']).toBeUndefined()
    expect(/[▰▱]/.test(textOf(tree))).toBe(false)
    wellFormed(tree, 80)
  })

  test('terminal stats page: no Svg, the meter drawn in glyphs as before', async ($, on) => {
    engine(on)
    await pressOn($, 'terminal', 'tab-stats')
    const tree = await drawOn($, 'terminal')
    expect(svgs(tree)).toHaveLength(0)
    expect(textOf(tree)).toContain('▱')
  })

  test('mobile: the pages draw whole, with no Svg', async ($, on) => {
    engine(on)
    for (const key of ['tab-now', 'tab-stats']) {
      await pressOn($, 'mobile', key)
      const tree = await drawOn($, 'mobile')
      expect(svgs(tree)).toHaveLength(0)
      expect(textOf(tree)).toContain('J.A.R.V.I.S.')
    }
  })

  test('a meter seg cut by a narrow card falls back to its glyphs', async ($, on) => {
    engine(on)
    await pressOn($, 'desktop', 'tab-stats', 45, 40)
    const tree = await drawOn($, 'desktop', 45, 40)
    wellFormed(tree, 40)
    for (const s of svgs(tree)) expect(Number(s.props?.['width'])).toBeLessThanOrEqual(cellPx(40 - 4))
    expect(cellWidth(textOf(tree))).toBeGreaterThan(0)
  })
})

describe('desktop svg: bars and lines', () => {
  test('dispatch rows: the Button holds no Svg, the bars and lines beside it; a press opens the role', async ($, on) => {
    engine(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await $.turn.complete(complete('agent-1', { usage: { model: HAIKU, input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }))
    await pressOn($, 'desktop', 'tab-stats')
    const tree = await drawOn($, 'desktop')
    const roleButtons = all(tree, x => x.type === 'Button' && String(x.props?.['key'] ?? '').startsWith('role-'))
    expect(roleButtons.length).toBeGreaterThan(0)
    for (const b of roleButtons) expect(svgs(b)).toHaveLength(0)
    expect(svgs(tree).some(s => /^Explore 1$/.test(altOf(s)))).toBe(true)
    expect(svgs(tree).some(s => altOf(s).endsWith(' 最近一小時'))).toBe(true)
    expect(svgs(tree).some(s => altOf(s) === 'MODELS')).toBe(true)
    wellFormed(tree, 80)
    await pressOn($, 'desktop', 'role-Explore')
    const role = await drawOn($, 'desktop')
    expect(all(role, x => x.type === 'Button' && x.props?.['key'] === 'back')).toHaveLength(1)
    expect(svgs(role).some(s => /次$/.test(altOf(s)))).toBe(true)
  })

  test('terminal dispatch rows: the whole row is the Button, drawn in glyphs', async ($, on) => {
    engine(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await $.turn.complete(complete('agent-1'))
    await pressOn($, 'terminal', 'tab-stats')
    const tree = await drawOn($, 'terminal')
    const b = all(tree, x => x.type === 'Button' && x.props?.['key'] === 'role-Explore')[0]
    expect(b && /[█░▏▎▍▌▋▊▉]/.test(textOf(b))).toBe(true)
    expect(svgs(tree)).toHaveLength(0)
  })

  test('40 columns: the stats page draws, every Svg within the card', async ($, on) => {
    engine(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await pressOn($, 'desktop', 'tab-stats', 45, 40)
    const tree = await drawOn($, 'desktop', 45, 40)
    wellFormed(tree, 40)
    for (const s of svgs(tree)) expect(Number(s.props?.['width'])).toBeLessThanOrEqual(cellPx(36))
  })
})

describe('desktop svg: the suit', () => {
  const sources = (tree: Node) => svgs(tree).map(sourceOf).sort()

  test('the standby suit is one moving picture in its sights, no half blocks', async ($, on) => {
    engine(on)
    const tree = await drawOn($, 'desktop', 50)
    const suit = svgs(tree).find(s => altOf(s) === 'MARK XLII')
    expect(suit?.props?.['width']).toBe(cellPx(36))
    expect(suit?.props?.['height']).toBe(rowPx(SUIT_CANVAS_ROWS))
    expect(suit?.props?.['isInteractive']).toBe(true)
    expect(/[▀▄]/.test(textOf(tree))).toBe(false)
    expect(textOf(tree)).toContain('MARK XLII · STANDBY')
    wellFormed(tree, 80)
  })

  test('the mark line is the press that holds the suit; held, it reads PAUSED and stops', async ($, on) => {
    engine(on)
    await drawOn($, 'desktop', 50)
    await pressOn($, 'desktop', 'suit-mark', 50)
    const tree = await drawOn($, 'desktop', 50)
    expect(textOf(tree)).toContain('MARK XLII · PAUSED')
    const held = svgs(tree).find(s => altOf(s) === 'MARK XLII')
    expect(sourceOf(held ?? {})).not.toContain('class="scan"')
    expect(held?.props?.['isInteractive']).toBeUndefined()
  })

  test('the tick never changes a picture while nothing else does', async ($, on) => {
    const clock = engine(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await clock.advance(3000)
    const before = sources(await drawOn($, 'desktop', 50))
    await clock.advance(SUIT_TICK_MS * 3)
    const after = sources(await drawOn($, 'desktop', 50))
    expect(before.length).toBeGreaterThan(0)
    expect(before.some(s => s.includes('class="scan"'))).toBe(true)
    expect(after).toEqual(before)
  })

  test('no Button on Desktop holds a picture: its children are glyphs', async ($, on) => {
    const clock = engine(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await clock.advance(3000)
    await pressOn($, 'desktop', 'suit-mark', 50)
    const tree = await drawOn($, 'desktop', 50)
    const buttons = all(tree, x => x.type === 'Button')
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) expect(svgs(b)).toEqual([])
  })

  test('the still suit asks the clock for no 250 ms frames on Desktop; the terminal still does', async ($, on) => {
    const periods: number[] = []
    on('clock.every', { ms: SUIT_TICK_MS }, async (_$, e, next) => {
      periods.push(e.ms)
      return next(e)
    })
    const clock = engine(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.advance(10_000)
    await drawOn($, 'desktop', 50)
    await clock.advance(SUIT_TICK_MS * 4)
    expect(periods.filter(ms => ms === SUIT_TICK_MS)).toEqual([])
    await drawOn($, 'terminal', 50)
    expect(periods.filter(ms => ms === SUIT_TICK_MS).length).toBeGreaterThan(0)
  })

  test('narrow (40): the suit centered alone, its readouts under it', async ($, on) => {
    engine(on)
    const tree = await drawOn($, 'desktop', 50, 40)
    expect(svgs(tree).some(s => altOf(s) === 'MARK XLII')).toBe(true)
    wellFormed(tree, 40)
  })

  test('boot: the art a still picture, the loading bar a picture', async ($, on) => {
    const clock = engine(on)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('command.run', async () => ({}))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.advance(BOOT_MS)
    await $.command.run({ command: 'jarvis', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
    const online = await drawOn($, 'desktop', 50)
    const art = svgs(online).find(s => altOf(s) === 'MARK XLII')
    expect(art?.props?.['height']).toBe(rowPx(SUIT_ROWS))
    expect(art?.props?.['isInteractive']).toBeUndefined()
    await clock.advance(BOOT_MS * 0.6)
    const loading = await drawOn($, 'desktop', 50)
    expect(svgs(loading).some(s => /^\d+%$/.test(altOf(s)))).toBe(true)
    expect(/[█░▀▄]/.test(textOf(loading))).toBe(false)
  })
})

describe('desktop svg: reactor and digits', () => {
  const mainCardHeight = (tree: Node): number | undefined =>
    all(tree, x => x.type === 'Box' && x.props?.['borderStyle'] === 'round' && textOf(x).includes('MAIN LINE'))
      .map(x => Number(x.props?.['height']))[0]

  test('the title reactor pulses as a picture while a subagent runs, rests dark after', async ($, on) => {
    const clock = engine(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    const live = svgs(await drawOn($, 'desktop', 50)).find(s => altOf(s) === '反應爐運轉中')
    expect(live?.props?.['isInteractive']).toBe(true)
    expect(live?.props?.['width']).toBe(8)
    await $.turn.complete(complete('agent-1'))
    await clock.advance(3000)
    const idle = svgs(await drawOn($, 'desktop', 50)).find(s => altOf(s) === '反應爐待機')
    expect(idle?.props?.['isInteractive']).toBeUndefined()
  })

  for (const cols of [120, 80, 50]) {
    test(`stats (${cols}): the success rate is one picture, the card as tall as on the terminal`, async ($, on) => {
      engine(on)
      await pressOn($, 'desktop', 'tab-stats', 45, cols)
      const desk = await drawOn($, 'desktop', 45, cols)
      const digits = svgs(desk).find(s => altOf(s) === 'SUCCESS RATE --')
      expect(digits?.props?.['width']).toBe(cellPx(bigWidth('--')))
      expect(digits?.props?.['height']).toBe(rowPx(BIG_ROWS))
      expect(/[▀▄]/.test(textOf(desk))).toBe(false)
      const term = await drawOn($, 'terminal', 45, cols)
      expect(mainCardHeight(desk)).toBe(mainCardHeight(term))
      wellFormed(desk, cols)
    })
  }
})

describe('desktop svg: segments in cell boxes', () => {
  const kids = (n: Node): Node[] => (n.children ?? []).filter((k): k is Node => typeof k !== 'string')
  // the cells a row's boxes take before the first child `stop` picks, NaN when none does
  const cellsBefore = (row: Node, stop: (x: Node) => boolean): number => {
    let n = 0
    for (const k of kids(row)) {
      if (stop(k)) return n
      n += Number(k.props?.['width'] ?? k.props?.['minWidth'] ?? NaN)
    }
    return NaN
  }

  test('dispatch rows: every bar starts at the same cell, the Button boxed to its cells', async ($, on) => {
    engine(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await pressOn($, 'desktop', 'tab-stats')
    const tree = await drawOn($, 'desktop')
    const isRoleButton = (x: Node) => x.type === 'Button' && String(x.props?.['key'] ?? '').startsWith('role-')
    const rows = all(tree, x => x.type === 'Box' && kids(x).some(k => kids(k).some(isRoleButton)))
    expect(rows.length).toBeGreaterThan(1)
    const starts = rows.map(r => cellsBefore(r, k => k.type === 'Svg'))
    for (const s of starts) expect(s).toBe(starts[0])
    expect(starts[0]).toBeGreaterThan(0)
    for (const r of rows) {
      const box = kids(r)[0] as Node
      expect(box.props?.['flexShrink']).toBe(0)
      expect(kids(box).some(isRoleButton)).toBe(true)
    }
    await pressOn($, 'desktop', 'role-Explore')
    expect(all(await drawOn($, 'desktop'), x => x.type === 'Button' && x.props?.['key'] === 'back')).toHaveLength(1)
  })

  test('a word takes at least its cells and is never truncated', async ($, on) => {
    engine(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await pressOn($, 'desktop', 'tab-now')
    const tree = await drawOn($, 'desktop')
    const words = all(tree, x => x.type === 'Box' && x.props?.['flexShrink'] === 0 && kids(x)[0]?.type === 'Text' && textOf(x) === 'UPTIME')
    expect(words.length).toBeGreaterThan(0)
    for (const b of words) {
      expect(b.props?.['minWidth']).toBe(cellWidth(textOf(b)))
      expect(b.props?.['width']).toBeUndefined()
      expect(kids(b)[0]?.props?.['wrap']).toBeUndefined()
    }
  })

  for (const key of ['tab-now', 'tab-stats', 'tab-fleet']) {
    test(`${key}: no Text carries mono on Desktop; the terminal has no cell boxes`, async ($, on) => {
      engine(on)
      await $.agent.spawn(spawnInput('find files', 'Explore'))
      await pressOn($, 'desktop', key)
      const desk = await drawOn($, 'desktop')
      for (const t of all(desk, x => x.type === 'Text')) expect(t.props?.['mono']).toBeUndefined()
      expect(all(desk, x => x.type === 'Box' && x.props?.['flexShrink'] === 0).length).toBeGreaterThan(0)
      await pressOn($, 'terminal', key)
      const term = await drawOn($, 'terminal')
      expect(all(term, x => x.props?.['flexShrink'] !== undefined || x.props?.['wrap'] !== undefined)).toHaveLength(0)
    })
  }
})

describe('desktop svg: card padding', () => {
  const kids = (n: Node): Node[] => (n.children ?? []).filter((k): k is Node => typeof k !== 'string')
  // the cells a Desktop line takes: its cell boxes and pictures side by side
  const cellsOf = (n: Node): number => {
    if (n.type === 'Svg') return Number(n.props?.['width']) / cellPx(1)
    if (n.props?.['width'] !== undefined) return Number(n.props['width'])
    if (n.props?.['minWidth'] !== undefined) return Number(n.props['minWidth'])
    if (n.type === 'Text' || n.type === 'Button') return cellWidth(textOf(n))
    const ks = kids(n)
    if (n.props?.['flexDirection'] === 'row') return ks.reduce((s, k) => s + cellsOf(k), 0) + Number(n.props['gap'] ?? 0) * Math.max(0, ks.length - 1)
    return Math.max(0, ...ks.map(cellsOf))
  }
  const cards = (tree: Node) => all(tree, x => x.props?.['borderStyle'] !== undefined)

  for (const key of ['tab-now', 'tab-stats', 'tab-changes']) {
    test(`${key}: every card padded a cell, clipped inside its border, each line within it; the terminal's cards as before`, async ($, on) => {
      engine(on)
      await $.agent.spawn(spawnInput('find files', 'Explore'))
      await pressOn($, 'desktop', key)
      const desk = await drawOn($, 'desktop')
      const found = cards(desk)
      expect(found.length).toBeGreaterThan(0)
      for (const c of found) {
        expect(c.props?.['paddingX']).toBe(1)
        expect(c.props?.['overflow']).toBe('hidden')
        const w = Number(c.props?.['width'])
        for (const line of kids(c)) expect(cellsOf(line)).toBeLessThanOrEqual(w - 4)
      }
      await pressOn($, 'terminal', key)
      for (const c of cards(await drawOn($, 'terminal'))) {
        expect(c.props?.['paddingX']).toBe(1)
        expect(c.props?.['overflow']).toBeUndefined()
      }
    })
  }
})

describe('desktop layout: card gaps and right-anchored columns', () => {
  const kids = (n: Node): Node[] => (n.children ?? []).filter((k): k is Node => typeof k !== 'string')
  const isCard = (x: Node) => x.type === 'Box' && x.props?.['borderStyle'] === 'round'
  const isGap = (x: Node) => x.type === 'Box' && x.props?.['height'] === 1 && kids(x).length === 0
  const isSpacer = (x: Node) => x.type === 'Box' && x.props?.['flexGrow'] === 1
  const hasCard = (k: Node) => all(k, isCard).length > 0
  // the page's column: the deepest column Box holding two blocks with a card in them
  const pageOf = (tree: Node): Node[] => {
    const page = all(tree, x => x.type === 'Box' && x.props?.['flexDirection'] === 'column' && kids(x).filter(hasCard).length >= 2).at(-1)
    expect(page).toBeDefined()
    return kids(page as Node)
  }
  // a block's rows: a card row as tall as its card, a gap or a line one
  const rowsOf = (k: Node): number => {
    const card = all(k, isCard)[0]
    return card ? Number(card.props?.['height']) : 1
  }
  const pageRows = (blocks: Node[]) => blocks.reduce((n, k) => n + rowsOf(k), 0)
  // what lies between each two cards of the page
  const between = (blocks: Node[]): Node[][] => {
    const at = blocks.flatMap((k, i) => (hasCard(k) ? [i] : []))
    return at.slice(1).map((j, n) => blocks.slice((at[n] as number) + 1, j))
  }

  test('now page: one blank row between the stacked cards, and the page no taller than the terminal one', async ($, on) => {
    engine(on)
    for (let i = 0; i < 30; i += 1) await $.tool.call({ tool: 'Read', file_path: `/x${i}` })
    const desk = pageOf(await drawOn($, 'desktop', 20))
    const term = pageOf(await drawOn($, 'terminal', 20))
    const gaps = between(desk)
    expect(gaps).toHaveLength(2)
    for (const g of gaps) {
      expect(g).toHaveLength(1)
      expect(isGap(g[0] as Node)).toBe(true)
    }
    for (const g of between(term)) expect(g).toHaveLength(0)
    expect(pageRows(term)).toBe(20)
    expect(pageRows(desk)).toBeLessThanOrEqual(pageRows(term))
  })

  test('now page: too few rows for the gaps leaves them out, never a card', async ($, on) => {
    engine(on)
    for (let i = 0; i < 30; i += 1) await $.tool.call({ tool: 'Read', file_path: `/x${i}` })
    // the title, the tabs, the list (4), in flight (4) and the least events (6): no row spare
    const desk = pageOf(await drawOn($, 'desktop', 16))
    const term = pageOf(await drawOn($, 'terminal', 16))
    expect(term.filter(hasCard)).toHaveLength(3)
    expect(desk.filter(hasCard)).toHaveLength(3)
    expect(desk.some(isGap)).toBe(false)
    expect(pageRows(desk)).toBe(pageRows(term))
  })

  test('stats page: one blank row between the stacked cards; short of rows the dispatch roles give way, the page no taller', async ($, on) => {
    engine(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await pressOn($, 'desktop', 'tab-stats')
    const roomy = pageOf(await drawOn($, 'desktop'))
    expect(between(roomy).map(g => g.length)).toEqual([1, 1])
    expect(pageRows(roomy)).toBeLessThanOrEqual(45)
    // the terminal page just fits: Desktop cuts the dispatch card for its gaps
    const fit = pageRows(pageOf(await drawOn($, 'terminal')))
    const desk = pageOf(await drawOn($, 'desktop', fit))
    const term = pageOf(await drawOn($, 'terminal', fit))
    expect(pageRows(term)).toBe(fit)
    expect(between(desk).map(g => g.length)).toEqual([1, 1])
    expect(between(desk).flat().every(isGap)).toBe(true)
    expect(pageRows(desk)).toBeLessThanOrEqual(fit)
    expect(textOf(desk.find(k => textOf(k).includes('DISPATCH')) as Node)).toContain('… 還有')
  })

  test('a leftRight line on Desktop: a spacer between its groups, the right group last, the row its full width', async ($, on) => {
    engine(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    const tree = await drawOn($, 'desktop')
    const rowWith = (pred: (k: Node) => boolean) =>
      all(tree, x => x.type === 'Box' && x.props?.['flexDirection'] === 'row' && kids(x).some(isSpacer) && kids(x).some(pred))[0]
    const titleRow = rowWith(k => textOf(k).includes('J.A.R.V.I.S.'))
    expect(titleRow?.props?.['width']).toBe(80)
    expect(textOf(kids(titleRow as Node).at(-1) as Node)).toBe('ALL SYSTEMS NOMINAL')
    const head = rowWith(k => textOf(k).includes('子代理'))
    expect(head?.props?.['width']).toBe(76)
    const hk = kids(head as Node)
    expect(hk.findIndex(isSpacer)).toBeLessThan(hk.length - 1)
    expect(textOf(hk.at(-1) as Node)).toContain('執行中')
    const spacer = hk.find(isSpacer)
    expect(spacer?.props?.['flexShrink']).toBe(1)
    expect(spacer?.props?.['minWidth']).toBe(1)
    // a subagent row: its description's padding the spacer, its last column at the card's end
    const row = all(tree, x => x.type === 'Box' && kids(x).some(k => kids(k).some(b => b.type === 'Button' && b.props?.['key'] === 'agent-1')))[0]
    expect(row?.props?.['width']).toBe(76)
    expect(kids(row as Node).some(isSpacer)).toBe(true)
  })

  test('terminal: no spacer, no gap box', async ($, on) => {
    engine(on)
    for (let i = 0; i < 30; i += 1) await $.tool.call({ tool: 'Read', file_path: `/x${i}` })
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    for (const key of ['tab-now', 'tab-stats']) {
      await pressOn($, 'terminal', key)
      const tree = await drawOn($, 'terminal', 20)
      expect(all(tree, isSpacer)).toHaveLength(0)
      expect(all(tree, isGap)).toHaveLength(0)
    }
  })
})
