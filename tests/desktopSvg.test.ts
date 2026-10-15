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

  test('desktopTree sets every Text in the monospaced face, keeping a mono already set', () => {
    const tree: Node = {
      type: 'Box',
      props: {},
      children: [
        { type: 'Text', props: { color: 'red' }, children: ['a', { type: 'Text', children: ['b'] }] },
        { type: 'Text', props: { mono: false }, children: ['c'] },
      ],
    }
    const out = desktopTree(tree)
    const ts = all(out, x => x.type === 'Text')
    expect(ts.map(t => t.props?.['mono'])).toEqual([true, true, false])
    expect(ts[0]?.props?.['color']).toBe('red')
    expect(out.props?.['mono']).toBeUndefined()
  })

  for (const key of ['tab-now', 'tab-stats', 'tab-fleet']) {
    test(`${key}: every Text on Desktop is mono, none on the terminal`, async ($, on) => {
      engine(on)
      await $.agent.spawn(spawnInput('find files', 'Explore'))
      await pressOn($, 'desktop', key)
      const desk = all(await drawOn($, 'desktop'), x => x.type === 'Text')
      expect(desk.length).toBeGreaterThan(0)
      for (const t of desk) expect(t.props?.['mono']).toBe(true)
      const term = all(await drawOn($, 'terminal'), x => x.type === 'Text')
      expect(term.length).toBeGreaterThan(0)
      for (const t of term) expect(t.props?.['mono']).toBeUndefined()
    })
  }

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
