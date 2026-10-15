import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DT } from '../hooks/desktopTheme'
import { cellPx } from '../hooks/svgArt'
import { TASK_TOOL } from '../hooks/tasks'
import { EMPTY_TEXT } from '../hooks/tasksView'
import { all, complete, drawOn, engine, pressOn, spawnInput, textOf, wellFormed } from './helpers'
import type { Node } from './helpers'
import { badProps } from './allowedProps'

const native = (on: Parameters<typeof engine>[0]) => engine(on, 'agent-1', 'native')
const COLS = [50, 80, 100, 140]
// a card's inner width: the pane less its padding (2+2), the card's border (1+1) and padding (2+2)
const cardInner = (cols: number) => cols - 4 - 6

// the cells a fixed-column row takes: each child's width (a picture's in cells) and the gaps
const rowWidth = (row: Node): number => {
  const kids = (row.children ?? []).filter((c): c is Node => typeof c !== 'string')
  const widths = kids.map(k => (k.type === 'Svg' ? Number(k.props?.['width']) / cellPx(1) : Number(k.props?.['width'])))
  expect(widths.every(w => Number.isFinite(w) && w > 0)).toBe(true)
  return widths.reduce((x, y) => x + y, 0) + Number(row.props?.['gap'] ?? 0) * (kids.length - 1)
}

// the row Boxes whose children all sit in fixed widths: the table-like rows
const fixedRows = (tree: Node): Node[] =>
  all(tree, x => {
    if (x.type !== 'Box' || x.props?.['flexDirection'] !== 'row') return false
    const kids = (x.children ?? []).filter((c): c is Node => typeof c !== 'string')
    return kids.length > 1 && kids.every(k => (k.type === 'Box' || k.type === 'Svg') && k.props?.['width'] !== undefined)
  })

const isNative = (tree: Node) => tree.props?.['backgroundColor'] === DT.bg

describe('desktop native: event log', () => {
  test('the log tab draws natively: a header row over fixed columns, the pause pill above', async ($, on) => {
    native(on)
    await $.tool.call({ tool: 'Bash', command: 'echo a | b' } as never)
    await pressOn($, 'desktop', 'tab-log')
    const tree = await drawOn($, 'desktop', 50, 100)
    expect(isNative(tree)).toBe(true)
    expect(textOf(tree)).toContain('事件流')
    expect(textOf(tree)).toContain('echo a | b')
    expect(all(tree, x => x.type === 'Button' && x.props?.['key'] === 'pause')).toHaveLength(1)
    const header = all(tree, x => x.type === 'Box' && x.props?.['flexDirection'] === 'row' && textOf(x).includes('描述') && textOf(x).includes('結果')).at(-1)
    expect(header).toBeDefined()
    expect(badProps(tree)).toEqual([])
    wellFormed(tree, 100)
  })

  test('empty: one line says there is nothing yet', async ($, on) => {
    native(on)
    await pressOn($, 'desktop', 'tab-log')
    const tree = await drawOn($, 'desktop')
    expect(textOf(tree)).toContain('還沒有工具呼叫')
    expect(badProps(tree)).toEqual([])
  })

  test('the pause pill holds the list and says how many came since; pressed again it resumes', async ($, on) => {
    native(on)
    await $.tool.call({ tool: 'Bash', command: 'first' } as never)
    await pressOn($, 'desktop', 'tab-log')
    await pressOn($, 'desktop', 'pause')
    await $.tool.call({ tool: 'Bash', command: 'second' } as never)
    let text = textOf(await drawOn($, 'desktop', 50, 100))
    expect(text).toContain('已暫停 · 新增 1 則')
    expect(text).toContain('first')
    expect(text).not.toContain('second')
    expect(text).toContain('繼續')
    await pressOn($, 'desktop', 'pause')
    text = textOf(await drawOn($, 'desktop', 50, 100))
    expect(text).toContain('second')
    expect(text).toContain('暫停')
  })

  test('a subagent call names its MK; the main loop its own name', async ($, on) => {
    native(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await $.turn.complete(complete('agent-1'))
    await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
    await pressOn($, 'desktop', 'tab-log')
    expect(textOf(await drawOn($, 'desktop', 50, 100))).toContain('主線')
  })

  test('an event row never reaches past its card, the time giving way when narrow', async ($, on) => {
    native(on)
    await $.tool.call({ tool: 'Bash', command: 'a command long enough to need cutting short in a narrow card '.repeat(3) } as never)
    await pressOn($, 'desktop', 'tab-log')
    for (const cols of COLS) {
      const tree = await drawOn($, 'desktop', 50, cols)
      const rows = fixedRows(tree)
      expect(rows.length).toBeGreaterThanOrEqual(2)
      for (const row of rows) expect(rowWidth(row)).toBeLessThanOrEqual(cardInner(cols))
      const header = rows.find(r => textOf(r).includes('描述')) as Node
      if (cols === 50) expect(textOf(header)).not.toContain('時間')
      if (cols === 140) expect(textOf(header)).toContain('時間')
      expect(badProps(tree)).toEqual([])
    }
  })
})

const task = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: TASK_TOOL, ...input } as never)
const withTasks = (on: Parameters<typeof engine>[0]) => {
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__jarvis__${e.name}` } }))
  return native(on)
}

describe('desktop native: task board', () => {
  test('empty: the board says what will show here', async ($, on) => {
    withTasks(on)
    await pressOn($, 'desktop', 'tab-tasks')
    const tree = await drawOn($, 'desktop')
    expect(isNative(tree)).toBe(true)
    expect(textOf(tree)).toContain(EMPTY_TEXT)
    expect(badProps(tree)).toEqual([])
  })

  test('items as tiles under their parts; status, done/total, subtasks with their marks and MK', async ($, on) => {
    withTasks(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await task($, { op: 'add', item: '加看板', subtasks: ['調查', '實作'] })
    await task($, { op: 'update', id: '1.1', status: 'completed' })
    await task($, { op: 'update', id: '1.2', status: 'in_progress', agent: 'agent-1' })
    await task($, { op: 'add', item: '之後再做' })
    await pressOn($, 'desktop', 'tab-tasks', 50, 100)
    const tree = await drawOn($, 'desktop', 50, 100)
    const text = textOf(tree)
    expect(text).toContain('任務')
    expect(text).toContain('進行中 1')
    expect(text).toContain('預計 1')
    expect(text).toContain('加看板')
    expect(text).toContain('1/2')
    expect(text).toContain('✓')
    expect(text).toContain('◉')
    expect(text).toContain('MK-1')
    expect(text).toContain('之後再做')
    expect(all(tree, x => x.type === 'Box' && x.props?.['backgroundColor'] === DT.glassRaised).length).toBeGreaterThanOrEqual(2)
    expect(badProps(tree)).toEqual([])
  })

  test("an item's title is the button that folds its subtasks and opens them again", async ($, on) => {
    withTasks(on)
    await task($, { op: 'add', item: '加看板', subtasks: ['調查'] })
    await pressOn($, 'desktop', 'tab-tasks')
    const btn = all(await drawOn($, 'desktop'), x => x.type === 'Button' && x.props?.['key'] === 'task-1')[0]
    expect(btn).toBeDefined()
    expect(textOf(btn as Node)).toContain('加看板')
    expect(textOf(await drawOn($, 'desktop'))).toContain('調查')
    await pressOn($, 'desktop', 'task-1')
    expect(textOf(await drawOn($, 'desktop'))).not.toContain('調查')
    await pressOn($, 'desktop', 'task-1')
    expect(textOf(await drawOn($, 'desktop'))).toContain('調查')
  })

  test('a task row never reaches past its tile at any width', async ($, on) => {
    withTasks(on)
    await $.agent.spawn(spawnInput('find files', 'Explore'))
    await task($, { op: 'add', item: 'an item title long enough to need cutting short in a narrow tile '.repeat(2), subtasks: ['a subtask title long enough to be cut short '.repeat(2)] })
    await task($, { op: 'update', id: '1.1', status: 'in_progress', agent: 'agent-1' })
    await pressOn($, 'desktop', 'tab-tasks')
    for (const cols of COLS) {
      const tree = await drawOn($, 'desktop', 50, cols)
      const rows = fixedRows(tree)
      expect(rows.length).toBeGreaterThanOrEqual(2)
      // a tile's inside: the card's less the tile's frame (1+1) and padding (1+1)
      for (const row of rows) expect(rowWidth(row)).toBeLessThanOrEqual(cardInner(cols) - 4)
      expect(badProps(tree)).toEqual([])
    }
  })
})
