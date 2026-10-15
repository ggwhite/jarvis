import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { CHAIN_WARN, cellWidth } from '../hooks/jarvis'
import { EMOJI_OF, TAB_ICON, desktopTree } from '../hooks/icons'
import { CELL_PX_H, cellPx, svgSafe } from '../hooks/svgArt'

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
