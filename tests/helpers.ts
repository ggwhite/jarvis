import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock } from 'claude-code/testing'

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
export const engine = (on: On, agentId = 'agent-1', layout: 'cells' | 'native' = 'cells') => {
  const clock = mock.clock(on, { now: 0 })
  // the old desktop tests check the cell-grid layout; the native one is asked for by name
  mock.env(on, layout === 'cells' ? { JARVIS_DESKTOP_LAYOUT: 'cells' } : {})
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
