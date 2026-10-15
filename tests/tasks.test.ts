import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { JarvisTaskBoard, JarvisTaskItem } from '../types'
import {
  EMPTY_BOARD,
  FRESH_MS,
  MAX_ITEMS,
  MAX_SUBTASKS,
  REQUEST_ORIGIN,
  REQUEST_TITLE_MAX,
  TASKS_TITLE,
  TASK_PROMPT,
  TASK_SECTION_ID,
  TASK_TOOL,
  TASK_TOOL_SPEC,
  TITLE_MAX,
  TODO_TITLE,
  applyTask,
  boardCounts,
  boardLive,
  itemRunning,
  boardText,
  countsText,
  currentRequest,
  dropIdle,
  itemWorked,
  markWorked,
  endTurn,
  fromTaskCreate,
  fromTaskUpdate,
  fromTodos,
  itemFresh,
  itemStartedAt,
  itemStatus,
  lineOf,
  makeRoom,
  openRequest,
  putItem,
  recordsRequest,
  requestContext,
  requestTitle,
  requestsEnding,
  boardSections,
  closeResults,
  startTurn,
  withResult,
  withSummaryTitle,
} from '../hooks/tasks'
import type { Seg } from '../hooks/cockpit'
import { RESULT_ICON, TASK_ICON, withIcon } from '../hooks/icons'
import { ANIM_MS, IDLE_MS, SPINNER, THEME, cellWidth, fitCells, fmtReadout, padCells } from '../hooks/jarvis'
import {
  RESULT_MAX,
  SUMMARY_INPUT_MAX,
  SUMMARY_MODEL,
  SUMMARY_SYSTEM,
  SUMMARY_TIMEOUT_MS,
  SUMMARY_TITLE_MAX,
  cleanSummary,
  resultAsk,
  titleAsk,
} from '../hooks/summary'
import type { TaskReply } from '../hooks/tasks'
import { EMPTY_TEXT, SUB_INDENT, TITLE_MIN, TOOL_MAX, isFolded, keptFolds, spinnerAt, taskLines, taskRows } from '../hooks/tasksView'
import type { AgentBadge, OwnerMark } from '../hooks/tasksView'

const ok = (r: TaskReply): JarvisTaskBoard => {
  if ('error' in r) throw new Error(r.error)
  return r.board
}

// the ops run in order from an empty board, each by the main loop
const build = (...ops: Record<string, unknown>[]): JarvisTaskBoard =>
  ops.reduce<JarvisTaskBoard>((b, op) => ok(applyTask(b, op)), EMPTY_BOARD)

const errorOf = (board: JarvisTaskBoard, op: Record<string, unknown>, actor?: string): string => {
  const r = applyTask(board, op, actor)
  return 'error' in r ? r.error : ''
}

describe('task board ops', () => {
  test('the tool is mcp__jarvis__task, its schema in the prompt from the start, no reserved field names', () => {
    expect(TASK_TOOL).toBe('mcp__jarvis__task')
    expect(`mcp__jarvis__${TASK_TOOL_SPEC.name}`).toBe(TASK_TOOL)
    expect(TASK_TOOL_SPEC.isDeferred).toBe(false)
    const props = Object.keys(TASK_TOOL_SPEC.inputSchema.properties)
    for (const reserved of ['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta']) expect(props).not.toContain(reserved)
    expect(props).toContain('agent')
  })

  test('add makes an item with numbered subtasks; item ids count up and are not reused', () => {
    const b = build(
      { op: 'add', item: '加看板', subtasks: ['調查', '實作'] },
      { op: 'add', item: '修 bug' },
      { op: 'remove', id: '2' },
      { op: 'add', item: '寫文件' },
    )
    expect(b.items.map(i => i.id)).toEqual(['1', '3'])
    expect(b.items[0]?.subtasks.map(s => [s.id, s.title, s.status])).toEqual([
      ['1.1', '調查', 'pending'],
      ['1.2', '實作', 'pending'],
    ])
    expect(b.items[0]?.subtasks.every(s => s.agentId === undefined)).toBe(true)
  })

  test('add with to appends subtasks, numbering on past a removed one', () => {
    const b = build(
      { op: 'add', item: 'A', subtasks: ['a1', 'a2'] },
      { op: 'remove', id: '1.2' },
      { op: 'add', to: '1', subtasks: ['a3'] },
    )
    expect(b.items[0]?.subtasks.map(s => s.id)).toEqual(['1.1', '1.3'])
  })

  test('add refuses: no item and no to, a blank item, an unknown to, to with no subtasks', () => {
    expect(errorOf(EMPTY_BOARD, { op: 'add' })).toContain('item')
    expect(errorOf(EMPTY_BOARD, { op: 'add', item: '   ' })).toContain('item')
    expect(errorOf(EMPTY_BOARD, { op: 'add', to: '9', subtasks: ['x'] })).toContain('找不到項目 9')
    expect(errorOf(build({ op: 'add', item: 'A' }), { op: 'add', to: '1', subtasks: [] })).toContain('subtasks')
  })

  test('titles are trimmed and kept to TITLE_MAX characters; blank subtasks are dropped', () => {
    const b = build({ op: 'add', item: `  ${'長'.repeat(200)}  `, subtasks: ['', '  ', ' ok ', 3] })
    expect([...(b.items[0]?.title ?? '')].length).toBe(TITLE_MAX)
    expect(b.items[0]?.subtasks.map(s => s.title)).toEqual(['ok'])
  })

  test('update sets a subtask status and title', () => {
    const b = build(
      { op: 'add', item: 'A', subtasks: ['a1'] },
      { op: 'update', id: '1.1', status: 'in_progress', title: 'a1 改名' },
    )
    expect(b.items[0]?.subtasks[0]).toMatchObject({ id: '1.1', title: 'a1 改名', status: 'in_progress' })
  })

  test("a subagent's update marks the subtask its own; agent names the owner; a later main update keeps it", () => {
    const b0 = build({ op: 'add', item: 'A', subtasks: ['a1', 'a2'] })
    const b1 = ok(applyTask(b0, { op: 'update', id: '1.1', status: 'in_progress' }, 'agent-7'))
    expect(b1.items[0]?.subtasks[0]?.agentId).toBe('agent-7')
    const b2 = ok(applyTask(b1, { op: 'update', id: '1.2', agent: 'agent-9' }))
    expect(b2.items[0]?.subtasks[1]?.agentId).toBe('agent-9')
    const b3 = ok(applyTask(b2, { op: 'update', id: '1.1', status: 'completed' }))
    expect(b3.items[0]?.subtasks[0]).toMatchObject({ status: 'completed', agentId: 'agent-7' })
  })

  test('subtasks a subagent adds are its own', () => {
    const b0 = build({ op: 'add', item: 'A' })
    const b1 = ok(applyTask(b0, { op: 'add', to: '1', subtasks: ['x'] }, 'agent-7'))
    expect(b1.items[0]?.subtasks[0]?.agentId).toBe('agent-7')
  })

  test('update refuses: an unknown id, a bad status, a blank title, nothing to change, an item with subtasks set running', () => {
    const b = build({ op: 'add', item: 'A', subtasks: ['a1'] }, { op: 'add', item: 'B' })
    expect(errorOf(b, { op: 'update', id: '9', status: 'completed' })).toContain('找不到項目 9')
    expect(errorOf(b, { op: 'update', id: '1.9', status: 'completed' })).toContain('找不到 1.9')
    expect(errorOf(b, { op: 'update', id: 'x', status: 'completed' })).toContain('找不到 x')
    expect(errorOf(b, { op: 'update', id: '1.1', status: 'done' })).toContain('status')
    expect(errorOf(b, { op: 'update', id: '1.1', title: '  ' })).toContain('title')
    expect(errorOf(b, { op: 'update', id: '1.1' })).toContain('update')
    expect(errorOf(b, { op: 'update', id: '2' })).toContain('update')
    expect(errorOf(b, { op: 'update', id: '1', status: 'in_progress' })).toContain('有細項')
  })

  test('an item with subtasks set completed completes every subtask; one without keeps its own status', () => {
    const b = build(
      { op: 'add', item: 'A', subtasks: ['a1', 'a2'] },
      { op: 'add', item: 'B' },
      { op: 'update', id: '1', status: 'completed' },
      { op: 'update', id: '2', status: 'in_progress', title: 'B2' },
    )
    expect(b.items[0]?.subtasks.map(s => s.status)).toEqual(['completed', 'completed'])
    expect(b.items[1]).toMatchObject({ title: 'B2', status: 'in_progress' })
  })

  test('remove drops an item or a subtask; unknown ids are refused', () => {
    const b = build({ op: 'add', item: 'A', subtasks: ['a1', 'a2'] }, { op: 'remove', id: '1.1' })
    expect(b.items[0]?.subtasks.map(s => s.id)).toEqual(['1.2'])
    expect(build({ op: 'add', item: 'A' }, { op: 'remove', id: '1' }).items).toEqual([])
    expect(errorOf(b, { op: 'remove', id: '1.1' })).toContain('找不到 1.1')
    expect(errorOf(b, { op: 'remove', id: '5' })).toContain('找不到項目 5')
  })

  test('list answers the board unchanged; an unknown op is refused', () => {
    const b = build({ op: 'add', item: 'A' })
    const r = applyTask(b, { op: 'list' })
    expect(ok(r)).toBe(b)
    expect(errorOf(b, { op: 'clear' })).toContain('op')
    expect(errorOf(b, {})).toContain('op')
  })

  test('caps: MAX_ITEMS items, MAX_SUBTASKS subtasks per item', () => {
    let b = EMPTY_BOARD
    for (let i = 0; i < MAX_ITEMS; i += 1) b = ok(applyTask(b, { op: 'add', item: `i${i}` }))
    expect(errorOf(b, { op: 'add', item: 'one more' })).toContain(String(MAX_ITEMS))
    const many = Array.from({ length: MAX_SUBTASKS }, (_, k) => `s${k}`)
    const full = build({ op: 'add', item: 'A', subtasks: many })
    expect(errorOf(full, { op: 'add', to: '1', subtasks: ['x'] })).toContain(String(MAX_SUBTASKS))
    expect(errorOf(EMPTY_BOARD, { op: 'add', item: 'A', subtasks: [...many, 'x'] })).toContain(String(MAX_SUBTASKS))
  })
})

describe('task board status and order', () => {
  test('an item with subtasks: all done is done, any running or some done is running, else pending', () => {
    const b = build(
      { op: 'add', item: 'A', subtasks: ['a1', 'a2'] },
      { op: 'update', id: '1.1', status: 'completed' },
    )
    const item = b.items[0]
    if (!item) throw new Error('no item')
    expect(itemStatus(item)).toBe('in_progress')
    expect(itemStatus({ ...item, subtasks: item.subtasks.map(s => ({ ...s, status: 'pending' as const })) })).toBe('pending')
    expect(itemStatus({ ...item, subtasks: item.subtasks.map(s => ({ ...s, status: 'completed' as const })) })).toBe('completed')
    expect(itemStatus({ ...item, subtasks: [{ ...item.subtasks[0]!, status: 'in_progress' }] })).toBe('in_progress')
    expect(itemStatus({ ...item, status: 'completed', subtasks: [] })).toBe('completed')
  })

  test('boardSections: running and planned in the order added, done newest first', () => {
    const b = build(
      { op: 'add', item: 'A' },
      { op: 'add', item: 'B', subtasks: ['b1'] },
      { op: 'add', item: 'C', subtasks: ['c1'] },
      { op: 'add', item: 'D', subtasks: ['d1', 'd2'] },
      { op: 'add', item: 'E' },
      { op: 'add', item: 'F' },
      { op: 'update', id: '2.1', status: 'completed' },
      { op: 'update', id: '3.1', status: 'in_progress' },
      { op: 'update', id: '4.1', status: 'completed' },
      { op: 'update', id: '5', status: 'in_progress' },
      { op: 'update', id: '6', status: 'completed' },
    )
    const s = boardSections(b)
    expect(s.running.map(i => i.title)).toEqual(['C', 'D', 'E'])
    expect(s.planned.map(i => i.title)).toEqual(['A'])
    expect(s.done.map(i => i.title)).toEqual(['F', 'B'])
  })

  test('counts, and the text the model reads in the order added', () => {
    const b = build(
      { op: 'add', item: '加看板', subtasks: ['調查', '實作'] },
      { op: 'add', item: '寫文件' },
      { op: 'update', id: '1.1', status: 'completed' },
      { op: 'update', id: '1.2', status: 'in_progress', agent: 'agent-7' },
    )
    expect(boardCounts(b)).toEqual({ items: 2, itemsDone: 0, subtasks: 2, subtasksDone: 1 })
    expect(countsText(boardCounts(b))).toBe('0/2 項目 · 細項 1/2')
    expect(boardText(b)).toBe(
      ['任務看板（0/2 項目 · 細項 1/2）', '[>] 1 加看板', '  [x] 1.1 調查', '  [>] 1.2 實作 (agent agent-7)', '[ ] 2 寫文件'].join('\n'),
    )
    expect(boardText(EMPTY_BOARD)).toBe('任務看板是空的。')
  })
})

describe('task board requests', () => {
  const statusOf = (item: JarvisTaskItem | undefined) => itemStatus(item as JarvisTaskItem)

  test('requestTitle: the first non-blank line, one line, cut to REQUEST_TITLE_MAX with an ellipsis', () => {
    expect(requestTitle('\n  修  jarvis\t的 bug  \n第二行')).toBe('修 jarvis 的 bug')
    expect(requestTitle('   \n\t')).toBe('')
    const long = requestTitle('長'.repeat(100))
    expect([...long].length).toBe(REQUEST_TITLE_MAX)
    expect(long.endsWith('…')).toBe(true)
  })

  test("recordsRequest: the person's own prompts; not a slash command, a hidden prompt, another source or a blank", () => {
    const sub = (over: Record<string, unknown> = {}) =>
      ({ text: '做事', origin: { kind: 'composer' }, ...over }) as Parameters<typeof recordsRequest>[0]
    expect(recordsRequest(sub())).toBe(true)
    expect(recordsRequest(sub({ origin: { kind: 'bridge' } }))).toBe(true)
    expect(recordsRequest(sub({ command: { name: 'jarvis', args: '' } }))).toBe(false)
    expect(recordsRequest(sub({ isMeta: true }))).toBe(false)
    for (const kind of ['task-notification', 'peer', 'plugin', 'scheduled-trigger', 'sdk', 'unclassified']) {
      expect(recordsRequest(sub({ origin: { kind } }))).toBe(false)
    }
    expect(recordsRequest(sub({ text: '  \n ' }))).toBe(false)
  })

  test('openRequest: a running request item; one typed over a turn is tied to it and marked queued', () => {
    const idle = openRequest(EMPTY_BOARD, '修 bug')
    expect(idle.id).toBe('1')
    expect(idle.board.items[0]).toMatchObject({ id: '1', title: '修 bug', status: 'in_progress', origin: REQUEST_ORIGIN, key: '修 bug', subtasks: [] })
    expect(idle.board.items[0]?.turnId).toBeUndefined()
    expect(idle.board.items[0]?.queued).toBeUndefined()
    const typedOver = openRequest(idle.board, '再加測試', 't1')
    expect(typedOver.id).toBe('2')
    expect(typedOver.board.items[1]).toMatchObject({ turnId: 't1', queued: true })
    expect(openRequest(EMPTY_BOARD, '  ')).toEqual({ board: EMPTY_BOARD })
  })

  test('a turn takes up the waiting requests and its end completes them; interrupted or failed, they wait again', () => {
    const b = startTurn(openRequest(EMPTY_BOARD, 'A').board, 't1', 'A')
    expect(b.items[0]?.turnId).toBe('t1')
    expect(currentRequest(b)?.id).toBe('1')
    const done = endTurn(b, 't1', 'answer')
    expect(done.items[0]?.status).toBe('completed')
    expect(done.items[0]?.turnId).toBeUndefined()
    expect(currentRequest(done)).toBeUndefined()
    expect(endTurn(b, 't1', 'refusal').items[0]?.status).toBe('completed')
    expect(endTurn(b, 't1', 'aborted').items[0]?.status).toBe('pending')
    expect(endTurn(b, 't1', 'error').items[0]?.status).toBe('pending')
    expect(endTurn(b, 't9', 'answer')).toBe(b)
  })

  test("a turn's end leaves the model's own items alone; a request with subtasks shows what its subtasks say", () => {
    let b = ok(applyTask(EMPTY_BOARD, { op: 'add', item: '跨輪工作', subtasks: ['s1', 's2'] }))
    b = ok(applyTask(b, { op: 'update', id: '1.1', status: 'in_progress' }))
    b = startTurn(openRequest(b, 'B').board, 't1', 'B')
    b = ok(applyTask(b, { op: 'add', to: '2', subtasks: ['b1'] }))
    const after = endTurn(b, 't1', 'answer')
    expect(after.items[0]).toEqual(b.items[0])
    expect(statusOf(after.items[0])).toBe('in_progress')
    expect(after.items[1]?.status).toBe('completed')
    expect(statusOf(after.items[1])).toBe('pending')
  })

  test('a request typed over a turn closes with it, and runs again when its own turn begins with it', () => {
    let b = startTurn(openRequest(EMPTY_BOARD, 'A').board, 't1', 'A')
    b = openRequest(b, 'B', 't1').board
    b = endTurn(b, 't1', 'answer')
    expect(b.items.map(i => i.status)).toEqual(['completed', 'completed'])
    expect(startTurn(b, 't2', '背景任務完成通知')).toBe(b)
    b = startTurn(b, 't3', 'B')
    expect(b.items[1]).toMatchObject({ status: 'in_progress', turnId: 't3' })
    expect(b.items[1]?.queued).toBeUndefined()
    expect(endTurn(b, 't3', 'answer').items[1]?.status).toBe('completed')
  })

  test('a prompt typed over a running turn does not take over the current request; the plan folds into the one the turn runs', () => {
    let b = startTurn(openRequest(EMPTY_BOARD, 'A').board, 't1', 'A')
    b = openRequest(b, 'B', 't1').board
    expect(currentRequest(b)?.id).toBe('1')
    b = ok(applyTask(b, { op: 'add', item: '計畫', subtasks: ['s1'] }))
    expect(b.items.map(i => [i.id, i.title, i.subtasks.length])).toEqual([
      ['1', '計畫', 1],
      ['2', 'B', 0],
    ])
  })

  test('a waiting request is tied to the turn even when a queued one has the same prompt', () => {
    let b = startTurn(openRequest(EMPTY_BOARD, 'A').board, 't1', 'A')
    b = openRequest(b, 'B', 't1').board
    b = endTurn(b, 't1', 'answer')
    b = openRequest(b, 'B').board
    b = startTurn(b, 't2', 'B')
    expect(b.items.map(i => [i.id, i.status, i.turnId])).toEqual([
      ['1', 'completed', undefined],
      ['2', 'completed', undefined],
      ['3', 'in_progress', 't2'],
    ])
  })

  test('a full board makes room by dropping its oldest done item; full of unfinished work, no request item is made', () => {
    let b = EMPTY_BOARD
    for (let i = 0; i < MAX_ITEMS; i += 1) b = ok(applyTask(b, { op: 'add', item: `i${i}` }))
    expect(makeRoom(b)).toBe(b)
    expect(openRequest(b, 'A')).toEqual({ board: b })
    b = ok(applyTask(b, { op: 'update', id: '3', status: 'completed' }))
    b = ok(applyTask(b, { op: 'update', id: '5', status: 'completed' }))
    const made = openRequest(b, 'A')
    expect(made.id).toBe(String(MAX_ITEMS + 1))
    expect(made.board.items).toHaveLength(MAX_ITEMS)
    expect(made.board.items.some(i => i.id === '3')).toBe(false)
    expect(made.board.items.some(i => i.id === '5')).toBe(true)
  })
})

describe('the model and the request items', () => {
  const asked = (text = '加看板') => startTurn(openRequest(EMPTY_BOARD, text).board, 't1', text)

  test('add with only subtasks hangs them on the request being worked on; with none, it is refused', () => {
    const b = ok(applyTask(asked(), { op: 'add', subtasks: ['調查', '實作'] }))
    expect(b.items).toHaveLength(1)
    expect(b.items[0]?.subtasks.map(s => s.id)).toEqual(['1.1', '1.2'])
    expect(errorOf(EMPTY_BOARD, { op: 'add', subtasks: ['x'] })).toContain('item')
  })

  test('an item with subtasks folds into the request that has none yet, taking its title', () => {
    const b = ok(applyTask(asked('1'), { op: 'add', item: '合併任務看板', subtasks: ['測試', '合併'] }))
    expect(b.items).toHaveLength(1)
    expect(b.items[0]).toMatchObject({ id: '1', title: '合併任務看板', origin: REQUEST_ORIGIN })
    expect(b.items[0]?.subtasks.map(s => s.title)).toEqual(['測試', '合併'])
    const again = ok(applyTask(b, { op: 'add', item: '另一件事', subtasks: ['x'] }))
    expect(again.items.map(i => i.title)).toEqual(['合併任務看板', '另一件事'])
  })

  test('an item with no subtasks is a planned item of its own; a subagent never folds into the request', () => {
    const planned = ok(applyTask(asked(), { op: 'add', item: '之後查 general-purpose' }))
    expect(planned.items.map(i => [i.title, i.status])).toEqual([
      ['加看板', 'in_progress'],
      ['之後查 general-purpose', 'pending'],
    ])
    const sub = ok(applyTask(asked(), { op: 'add', item: '子工作', subtasks: ['x'] }, 'agent-7'))
    expect(sub.items).toHaveLength(2)
    expect(errorOf(asked(), { op: 'add', subtasks: ['x'] }, 'agent-7')).toContain('item')
  })

  test('add on a full board drops the oldest done item; full of unfinished work it is refused', () => {
    let b = EMPTY_BOARD
    for (let i = 0; i < MAX_ITEMS; i += 1) b = ok(applyTask(b, { op: 'add', item: `i${i}` }))
    expect(errorOf(b, { op: 'add', item: 'more' })).toContain(String(MAX_ITEMS))
    b = ok(applyTask(b, { op: 'update', id: '2', status: 'completed' }))
    const more = ok(applyTask(b, { op: 'add', item: 'more' }))
    expect(more.items).toHaveLength(MAX_ITEMS)
    expect(more.items.some(i => i.id === '2')).toBe(false)
    expect(more.items.at(-1)?.title).toBe('more')
  })

  test('the text the model reads marks the request being worked on', () => {
    expect(boardText(asked())).toBe(['任務看板（0/1 項目 · 細項 0/0）', '[>] 1 加看板（本輪請求）'].join('\n'))
  })

  test('the prompt and the note beside each request tell the model what jarvis records and what is its to do', () => {
    expect(TASK_PROMPT).toContain('自動')
    expect(TASK_PROMPT).toContain('預計')
    expect(TASK_TOOL_SPEC.description).toContain('本輪請求')
    const note = requestContext('7')
    expect(note).toContain('項目 7')
    expect(note).toContain('id=7')
  })
})

describe('task board times', () => {
  test('a status change is stamped: running starts the clock, completed stops it, pending clears both; no clock stamps nothing', () => {
    let b = ok(applyTask(EMPTY_BOARD, { op: 'add', item: 'A', subtasks: ['a1'] }, undefined, 5))
    expect(b.items[0]?.subtasks[0]?.startedAt).toBeUndefined()
    b = ok(applyTask(b, { op: 'update', id: '1.1', status: 'in_progress' }, undefined, 10))
    expect(b.items[0]?.subtasks[0]).toMatchObject({ startedAt: 10 })
    b = ok(applyTask(b, { op: 'update', id: '1.1', status: 'in_progress', title: 'a1!' }, undefined, 15))
    expect(b.items[0]?.subtasks[0]?.startedAt).toBe(10)
    b = ok(applyTask(b, { op: 'update', id: '1.1', status: 'completed' }, undefined, 20))
    expect(b.items[0]?.subtasks[0]).toMatchObject({ startedAt: 10, endedAt: 20 })
    b = ok(applyTask(b, { op: 'update', id: '1.1', status: 'pending' }, undefined, 30))
    expect(b.items[0]?.subtasks[0]?.startedAt).toBeUndefined()
    expect(b.items[0]?.subtasks[0]?.endedAt).toBeUndefined()
    const plain = ok(applyTask(build({ op: 'add', item: 'B' }), { op: 'update', id: '1', status: 'in_progress' }))
    expect(plain.items[0]?.startedAt).toBeUndefined()
  })

  test("an item's own status is stamped; completing an item with subtasks stamps each", () => {
    const own = ok(applyTask(build({ op: 'add', item: 'A' }), { op: 'update', id: '1', status: 'in_progress' }, undefined, 7))
    expect(own.items[0]?.startedAt).toBe(7)
    const subs = ok(applyTask(build({ op: 'add', item: 'A', subtasks: ['a1', 'a2'] }), { op: 'update', id: '1', status: 'completed' }, undefined, 9))
    expect(subs.items[0]?.subtasks.map(s => s.endedAt)).toEqual([9, 9])
  })

  test('a request is stamped when sent and when its turn ends; a queued one is stamped again when it runs again', () => {
    let b = openRequest(EMPTY_BOARD, 'A', undefined, 100).board
    expect(b.items[0]?.startedAt).toBe(100)
    b = startTurn(b, 't1', 'A', 110)
    expect(b.items[0]?.startedAt).toBe(100)
    expect(endTurn(b, 't1', 'answer', 200).items[0]).toMatchObject({ startedAt: 100, endedAt: 200 })
    let q = openRequest(b, 'B', 't1', 150).board
    q = endTurn(q, 't1', 'answer', 200)
    q = startTurn(q, 't2', 'B', 300)
    expect(q.items[1]?.startedAt).toBe(300)
    expect(q.items[1]?.endedAt).toBeUndefined()
  })

  test("itemStartedAt: the item's own start, else its earliest subtask's", () => {
    let b = build({ op: 'add', item: 'A', subtasks: ['a1', 'a2'] })
    expect(itemStartedAt(b.items[0] as JarvisTaskItem)).toBeUndefined()
    b = ok(applyTask(b, { op: 'update', id: '1.2', status: 'in_progress' }, undefined, 50))
    b = ok(applyTask(b, { op: 'update', id: '1.1', status: 'in_progress' }, undefined, 40))
    expect(itemStartedAt(b.items[0] as JarvisTaskItem)).toBe(40)
    expect(itemStartedAt(openRequest(EMPTY_BOARD, 'R', undefined, 5).board.items[0] as JarvisTaskItem)).toBe(5)
  })

  test('boardLive: running work, or work completed within FRESH_MS', () => {
    expect(boardLive(EMPTY_BOARD, 0)).toBe(false)
    expect(boardLive(build({ op: 'add', item: 'A' }), 0)).toBe(false)
    const running = ok(applyTask(build({ op: 'add', item: 'A', subtasks: ['a1'] }), { op: 'update', id: '1.1', status: 'in_progress' }, undefined, 0))
    expect(boardLive(running, 0)).toBe(true)
    const done = ok(applyTask(running, { op: 'update', id: '1.1', status: 'completed' }, undefined, 1000))
    expect(boardLive(done, 1000 + FRESH_MS - 1)).toBe(true)
    expect(boardLive(done, 1000 + FRESH_MS)).toBe(false)
    expect(itemFresh(done.items[0] as JarvisTaskItem, 1000 + FRESH_MS - 1)).toBe(true)
    expect(itemFresh(done.items[0] as JarvisTaskItem, 1000 + FRESH_MS)).toBe(false)
  })
})

describe('built-in task tools mirrored', () => {
  const todo = (content: string, status: string) => ({ content, status, activeForm: `${content}中` })

  test('putItem: extra.status overrides the default pending', () => {
    expect(putItem(EMPTY_BOARD, 'x', [], undefined, { status: 'completed' }).items[0]?.status).toBe('completed')
    expect(putItem(EMPTY_BOARD, 'x', [], undefined).items[0]?.status).toBe('pending')
  })

  test("TodoWrite: one item per actor, each call replacing its subtasks; an empty list removes it", () => {
    let b = fromTodos(EMPTY_BOARD, [todo('讀檔', 'completed'), todo('改檔', 'in_progress')])
    expect(b.items).toHaveLength(1)
    expect(b.items[0]).toMatchObject({ id: '1', title: TODO_TITLE, origin: 'todo:main' })
    expect(b.items[0]?.subtasks.map(s => [s.id, s.title, s.status])).toEqual([
      ['1.1', '讀檔', 'completed'],
      ['1.2', '改檔', 'in_progress'],
    ])
    b = fromTodos(b, [todo('讀檔', 'completed'), todo('改檔', 'completed'), todo('測試', 'pending')])
    expect(b.items[0]?.subtasks.map(s => s.status)).toEqual(['completed', 'completed', 'pending'])
    b = fromTodos(b, [todo('x', 'pending')], 'agent-7')
    expect(b.items.map(i => i.origin)).toEqual(['todo:main', 'todo:agent-7'])
    expect(b.items[1]?.subtasks[0]?.agentId).toBe('agent-7')
    b = fromTodos(b, [])
    expect(b.items.map(i => i.origin)).toEqual(['todo:agent-7'])
  })

  test('TodoWrite: a bad status reads pending; a blank or broken entry is skipped; not a list is nothing', () => {
    const b = fromTodos(EMPTY_BOARD, [todo('a', 'weird'), todo('  ', 'pending'), null, 3])
    expect(b.items[0]?.subtasks.map(s => [s.title, s.status])).toEqual([['a', 'pending']])
    expect(fromTodos(EMPTY_BOARD, 'nope')).toBe(EMPTY_BOARD)
  })

  test('TaskCreate adds a subtask under 內建任務 once per task id; TaskUpdate sets status and subject, deleted removes', () => {
    let b = fromTaskCreate(EMPTY_BOARD, '7', '跑測試')
    b = fromTaskCreate(b, '8', '寫文件', 'agent-7')
    b = fromTaskCreate(b, '8', '寫文件')
    expect(b.items[0]).toMatchObject({ title: TASKS_TITLE, origin: 'tasks' })
    expect(b.items[0]?.subtasks.map(s => [s.id, s.title, s.extId, s.agentId])).toEqual([
      ['1.1', '跑測試', '7', undefined],
      ['1.2', '寫文件', '8', 'agent-7'],
    ])
    b = fromTaskUpdate(b, { taskId: '7', status: 'completed', subject: '跑全部測試' })
    expect(b.items[0]?.subtasks[0]).toMatchObject({ title: '跑全部測試', status: 'completed' })
    b = fromTaskUpdate(b, { taskId: '8', status: 'deleted' })
    expect(b.items[0]?.subtasks.map(s => s.extId)).toEqual(['7'])
    expect(fromTaskUpdate(b, { taskId: '99', status: 'completed' })).toBe(b)
    expect(fromTaskCreate(b, undefined, 'x')).toBe(b)
  })

  test('TaskUpdate without a taskId leaves a model-added subtask alone', () => {
    let b = fromTaskCreate(EMPTY_BOARD, '7', '跑測試')
    b = ok(applyTask(b, { op: 'add', to: '1', subtasks: ['mine'] }))
    expect(fromTaskUpdate(b, { status: 'deleted' })).toBe(b)
    expect(fromTaskUpdate(b, { taskId: '', status: 'deleted' })).toBe(b)
  })

  test('mirroring respects the caps', () => {
    const many = Array.from({ length: MAX_SUBTASKS + 5 }, (_, k) => todo(`t${k}`, 'pending'))
    expect(fromTodos(EMPTY_BOARD, many).items[0]?.subtasks).toHaveLength(MAX_SUBTASKS)
    let full = EMPTY_BOARD
    for (let i = 0; i < MAX_ITEMS; i += 1) full = ok(applyTask(full, { op: 'add', item: `i${i}` }))
    expect(fromTodos(full, [todo('a', 'pending')])).toBe(full)
    expect(fromTaskCreate(full, '1', 'a')).toBe(full)
  })
})

describe('task board rows', () => {
  const MEMBER = '#E879F9'
  const owner = (id: string) => (id === 'agent-7' ? { t: 'MK-1', color: MEMBER } : { t: 'MK', color: THEME.frame })
  const text = (row: readonly Seg[]) => row.map(s => s.t).join('')
  const board = () =>
    build(
      { op: 'add', item: 'A', subtasks: ['a1', 'a2'] },
      { op: 'add', item: 'B', subtasks: ['b1'] },
      { op: 'add', item: 'C' },
      { op: 'update', id: '2.1', status: 'completed' },
      { op: 'update', id: '1.1', status: 'in_progress' },
      { op: 'update', id: '1.2', agent: 'agent-7' },
    )

  test('a title with newline or tab collapses to one line; every row is exactly width cells', () => {
    const b = build({ op: 'add', item: 'a\nb\tc', subtasks: ['x\ny'] })
    const rows = taskRows(b, 40, 10, owner)
    for (const row of rows) {
      const t = row.map(s => s.t).join('')
      expect(t).not.toMatch(/[\n\t]/)
      expect(cellWidth(t)).toBe(40)
    }
    expect(rows[1]?.map(s => s.t).join('')).toContain('a b c')
  })


  test('an empty board is one row of EMPTY_TEXT', () => {
    expect(taskRows(EMPTY_BOARD, 76, 10, owner).map(text)).toEqual([EMPTY_TEXT])
  })

  test('three parts under their headings: running, planned, done; a done item folded, counts at the right, subtasks indented', () => {
    const rows = taskRows(board(), 60, 20, owner).map(text)
    expect(rows).toHaveLength(8)
    expect(rows[0]?.trimEnd()).toBe('進行中 1')
    expect(rows[1]?.startsWith(`${spinnerAt(0)}A`)).toBe(true)
    expect(rows[1]?.endsWith(' 0/2')).toBe(true)
    expect(rows[2]?.startsWith(`${' '.repeat(SUB_INDENT)}${spinnerAt(0)}a1`)).toBe(true)
    expect(rows[3]?.startsWith(`${' '.repeat(SUB_INDENT)}${TASK_ICON.pending} a2`)).toBe(true)
    expect(rows[3]?.endsWith(' MK-1')).toBe(true)
    expect(rows[4]?.trimEnd()).toBe('預計 1')
    expect(rows[5]?.trimEnd()).toBe(`${TASK_ICON.pending} C`)
    expect(rows[6]?.trimEnd()).toBe('已完成 1')
    expect(rows[7]?.startsWith(`${TASK_ICON.completed} B`)).toBe(true)
    expect(rows[7]?.endsWith(' 1/1')).toBe(true)
  })

  test('an empty part draws no heading', () => {
    const rows = taskRows(build({ op: 'add', item: 'A' }), 40, 10, owner).map(text)
    expect(rows.map(r => r.trimEnd())).toEqual(['預計 1', `${TASK_ICON.pending} A`])
  })

  test('colors by status, headings in bold frame; the owner mark in its color, an unknown owner a bare MK in frame', () => {
    const rows = taskRows(board(), 60, 20, owner)
    expect(rows[0]).toEqual([{ t: padCells('進行中 1', 60), color: THEME.frame, bold: true }])
    expect(rows[1]?.[0]).toEqual({ t: spinnerAt(0), color: THEME.accent })
    expect(rows[1]?.[1]).toMatchObject({ color: THEME.bright, bold: true })
    expect(rows[3]?.[1]).toEqual({ t: `${TASK_ICON.pending} `, color: THEME.frame })
    expect(rows[3]?.[2]).toMatchObject({ color: THEME.primary })
    expect(rows[3]?.at(-1)).toEqual({ t: 'MK-1', color: MEMBER })
    expect(rows[7]?.[0]).toEqual({ t: `${TASK_ICON.completed} `, color: THEME.success })
    expect(rows[7]?.[1]).toMatchObject({ color: THEME.frame })
    const stranger = build({ op: 'add', item: 'A', subtasks: ['a1'] }, { op: 'update', id: '1.1', agent: 'agent-x' })
    expect(taskRows(stranger, 40, 5, owner)[2]?.at(-1)).toEqual({ t: 'MK', color: THEME.frame })
  })

  test('every row is exactly width cells; long CJK titles end in an ellipsis', () => {
    const long = build({ op: 'add', item: '很長的工作項目標題'.repeat(6), subtasks: ['很長的細項標題'.repeat(8)] }, { op: 'update', id: '1.1', agent: 'agent-7' })
    for (const width of [24, 40, 76]) {
      const rows = taskRows(long, width, 10, owner)
      for (const row of rows) expect(cellWidth(text(row))).toBe(width)
      expect(text(rows[1] ?? []).includes('…')).toBe(true)
      expect(text(rows[2] ?? []).endsWith(' MK-1')).toBe(true)
    }
  })

  test('more rows than room: the last row says how many are left out, the oldest done first; no room draws nothing', () => {
    const rows = taskRows(board(), 60, 3, owner).map(text)
    expect(rows).toHaveLength(3)
    expect(rows[0]?.trimEnd()).toBe('進行中 1')
    expect(rows[2]).toBe('還有 6 列')
    expect(taskRows(board(), 60, 0, owner)).toEqual([])
    expect(taskRows(board(), 60, 1, owner).map(text)).toEqual(['還有 8 列'])
  })
})

describe('task board folds', () => {
  const owner = () => ({ t: 'MK', color: THEME.frame })
  const text = (segs: readonly Seg[]) => segs.map(s => s.t).join('')
  const board = () =>
    build(
      { op: 'add', item: 'A', subtasks: ['a1', 'a2'] },
      { op: 'add', item: 'B', subtasks: ['b1'] },
      { op: 'add', item: 'C' },
      { op: 'update', id: '1.1', status: 'in_progress' },
      { op: 'update', id: '2.1', status: 'completed' },
    )

  test('a done item is folded and others open, unless a press chose otherwise', () => {
    const b = board()
    const [a, done] = [b.items[0]!, b.items[1]!]
    expect(isFolded(a, {})).toBe(false)
    expect(isFolded(done, {})).toBe(true)
    expect(isFolded(a, { '1': true })).toBe(true)
    expect(isFolded(done, { '2': false })).toBe(false)
  })

  test("an item's row carries its fold when it has subtasks; subtask and heading rows carry none", () => {
    const lines = taskLines(board(), 40, 20, owner)
    const items = lines.filter(l => l.item !== undefined)
    expect(items.map(l => l.item)).toEqual([
      { id: '1', folded: false },
      { id: '2', folded: true },
    ])
    expect(lines.find(l => text(l.segs).includes('C'))?.item).toBeUndefined()
    expect(lines.find(l => text(l.segs).includes('a1'))?.item).toBeUndefined()
    expect(taskRows(board(), 40, 20, owner)).toEqual(lines.map(l => l.segs))
  })

  test('a fold choice hides a running item\'s subtasks and shows a done item\'s; done/total stays', () => {
    const lines = taskLines(board(), 40, 20, owner, 0, { '1': true, '2': false })
    const texts = lines.map(l => text(l.segs))
    expect(texts.some(t => t.includes('a1'))).toBe(false)
    expect(texts.find(t => t.includes('A'))?.trimEnd()).toMatch(/0\/2$/)
    expect(texts.some(t => t.includes('b1'))).toBe(true)
    expect(lines.find(l => l.item?.id === '1')?.item?.folded).toBe(true)
    expect(lines.find(l => l.item?.id === '2')?.item?.folded).toBe(false)
    for (const t of texts) expect(cellWidth(t)).toBe(40)
  })

  test('keptFolds drops the choices of items no longer on the board', () => {
    const b = board()
    expect(keptFolds({ '1': true, '9': false }, b)).toEqual({ '1': true })
    expect(keptFolds(undefined, b)).toEqual({})
  })
})

describe('a partly done item', () => {
  const text = (row: readonly Seg[]) => row.map(s => s.t).join('')
  const partial = () =>
    ok(applyTask(build({ op: 'add', item: 'A', subtasks: ['a1', 'a2'] }), { op: 'update', id: '1.1', status: 'completed' }, undefined, 0))

  test('sits in 進行中 and reads [>], with no subtask running', () => {
    const b = partial()
    expect(boardSections(b).running.map(i => i.title)).toEqual(['A'])
    expect(boardSections(b).planned).toEqual([])
    expect(boardText(b).split('\n')[1]).toBe('[>] 1 A')
  })

  test('the idle tick stops: nothing running means no live board once the fresh window passes', () => {
    const b = partial()
    expect(boardLive(b, FRESH_MS - 1)).toBe(true)
    expect(boardLive(b, FRESH_MS)).toBe(false)
    expect(itemRunning(b.items[0] as JarvisTaskItem)).toBe(false)
    const next = ok(applyTask(b, { op: 'update', id: '1.2', status: 'in_progress' }, undefined, 5000))
    expect(boardLive(next, 1e9)).toBe(true)
    expect(itemRunning(next.items[0] as JarvisTaskItem)).toBe(true)
  })

  test('idle: no spinner and no elapsed time on the item row; running: both', () => {
    const b = partial()
    const idle = taskLines(b, 60, 10, () => ({ t: 'MK', color: THEME.frame }), 70_000)
    const head = idle[1]?.segs ?? []
    expect(head[0]).toEqual({ t: withIcon(TASK_ICON.pending, ''), color: THEME.frame })
    expect(text(head).endsWith(' 1/2')).toBe(true)
    const b2 = ok(applyTask(b, { op: 'update', id: '1.2', status: 'in_progress' }, undefined, 5000))
    const run = taskLines(b2, 60, 10, () => ({ t: 'MK', color: THEME.frame }), 70_000)[1]?.segs ?? []
    expect(run[0]).toEqual({ t: spinnerAt(70_000), color: THEME.accent })
    expect(text(run).endsWith(' 1/2 1:05')).toBe(true)
  })

  test('endTurn on a request with a partly done subtask list keeps it in 進行中', () => {
    let b = startTurn(openRequest(EMPTY_BOARD, 'R', undefined, 0).board, 't1', 'R')
    b = ok(applyTask(b, { op: 'add', to: '1', subtasks: ['x', 'y'] }))
    b = ok(applyTask(b, { op: 'update', id: '1.1', status: 'completed' }))
    const after = endTurn(b, 't1', 'answer', 10)
    expect(after.items[0]?.status).toBe('completed')
    expect(itemStatus(after.items[0] as JarvisTaskItem)).toBe('in_progress')
    expect(currentRequest(after)).toBeUndefined()
  })
})

describe('task board motion', () => {
  const text = (row: readonly Seg[]) => row.map(s => s.t).join('')
  const mk = (agent?: AgentBadge): OwnerMark => ({ t: 'MK-1', color: '#E879F9', ...(agent ? { agent } : {}) })
  const running = (now: number) =>
    ok(applyTask(build({ op: 'add', item: 'A', subtasks: ['a1'] }), { op: 'update', id: '1.1', status: 'in_progress' }, undefined, now))

  test('a running row spins with the clock; pending and done rows stand still', () => {
    expect(spinnerAt(0)).toBe(`${SPINNER[0]} `)
    expect(spinnerAt(ANIM_MS)).toBe(`${SPINNER[1]} `)
    expect(spinnerAt(ANIM_MS * SPINNER.length)).toBe(`${SPINNER[0]} `)
    expect(cellWidth(spinnerAt(0))).toBe(cellWidth(withIcon(TASK_ICON.pending, '')))
    const b = running(0)
    expect(taskRows(b, 40, 10, () => mk(), 0)[1]?.[0]).toEqual({ t: spinnerAt(0), color: THEME.accent })
    const rowsAt = (now: number) => taskRows(b, 40, 10, () => mk(), now).map(text)
    expect(rowsAt(0)[2]).not.toBe(rowsAt(ANIM_MS)[2])
    const still = build({ op: 'add', item: 'P' }, { op: 'add', item: 'D' }, { op: 'update', id: '2', status: 'completed' })
    expect(taskRows(still, 40, 10, () => mk(), 0).map(text)).toEqual(taskRows(still, 40, 10, () => mk(), ANIM_MS).map(text))
  })

  test('running work shows its time: an item from its start, a subtask without a member from its own', () => {
    let b = openRequest(EMPTY_BOARD, '修 bug', undefined, 0).board
    b = ok(applyTask(b, { op: 'add', subtasks: ['查'] }, undefined, 0))
    b = ok(applyTask(b, { op: 'update', id: '1.1', status: 'in_progress' }, undefined, 5_000))
    const rows = taskRows(b, 60, 10, () => mk(), 65_000).map(text)
    expect(rows[1]?.endsWith(' 0/1 1:05')).toBe(true)
    expect(rows[2]?.endsWith(' 1:00')).toBe(true)
    // a narrow item row keeps its count and gives up its time
    const narrow = taskRows(b, 15, 10, () => mk(), 65_000).map(text)
    expect(narrow[1]?.endsWith(' 0/1')).toBe(true)
  })

  test('a just completed subtask is lit bright for FRESH_MS, then done colors', () => {
    const b = ok(
      applyTask(
        ok(applyTask(build({ op: 'add', item: 'A', subtasks: ['a1', 'a2'] }), { op: 'update', id: '1.2', status: 'in_progress' }, undefined, 0)),
        { op: 'update', id: '1.1', status: 'completed' },
        undefined,
        1000,
      ),
    )
    const lit = taskRows(b, 40, 10, () => mk(), 1000 + FRESH_MS - 1)[2]
    expect(lit?.[1]).toEqual({ t: withIcon(TASK_ICON.completed, ''), color: THEME.bright })
    expect(lit?.[2]).toMatchObject({ color: THEME.bright })
    const after = taskRows(b, 40, 10, () => mk(), 1000 + FRESH_MS)[2]
    expect(after?.[1]).toEqual({ t: withIcon(TASK_ICON.completed, ''), color: THEME.success })
    expect(after?.[2]).toMatchObject({ color: THEME.frame })
  })

  test('a request item done by its subtasks, still running by its own status, is lit from its last subtask for FRESH_MS', () => {
    let b = openRequest(EMPTY_BOARD, '修 bug', undefined, 0).board
    b = ok(applyTask(b, { op: 'add', subtasks: ['查'] }, undefined, 0))
    b = ok(applyTask(b, { op: 'update', id: '1.1', status: 'completed' }, undefined, 1000))
    expect(b.items[0]?.status).toBe('in_progress')
    const lit = taskRows(b, 40, 10, () => mk(), 1000 + FRESH_MS - 1)
    expect(text(lit[0] ?? [])).toContain('已完成 1')
    expect(lit[1]?.[0]).toEqual({ t: withIcon(TASK_ICON.completed, ''), color: THEME.bright })
    expect(lit[1]?.[1]).toMatchObject({ color: THEME.bright })
    expect(text(lit[1] ?? []).trimEnd().endsWith(' 1/1')).toBe(true)
    const after = taskRows(b, 40, 10, () => mk(), 1000 + FRESH_MS)[1]
    expect(after?.[0]).toEqual({ t: withIcon(TASK_ICON.completed, ''), color: THEME.success })
    expect(after?.[1]).toMatchObject({ color: THEME.frame })
  })

  test("a member's run beside its subtask: tool and time running, waiting, done or failed with the time taken, lost", () => {
    const b = ok(applyTask(running(0), { op: 'update', id: '1.1', agent: 'agent-7' }))
    const right = (agent: AgentBadge) => {
      const row = taskRows(b, 60, 10, () => mk(agent), 0)[2] ?? []
      return { text: text(row).trimEnd(), segs: row }
    }
    const bash = right({ status: 'running', ms: 65_000, tool: 'Bash' })
    expect(bash.text.endsWith(' Bash 1:05 MK-1')).toBe(true)
    expect(bash.segs.find(s => s.t === 'Bash')?.color).toBe(THEME.accent)
    expect(right({ status: 'running', ms: 5_000, tool: '' }).text.endsWith(' 0:05 MK-1')).toBe(true)
    expect(right({ status: 'running', waiting: true, ms: 5_000, tool: 'Bash' }).text.endsWith(' 等待 0:05 MK-1')).toBe(true)
    const done = right({ status: 'done', ms: 120_000, tool: 'Read' })
    expect(done.text.endsWith(' 完成 2:00 MK-1')).toBe(true)
    expect(done.segs.find(s => s.t === '完成')?.color).toBe(THEME.success)
    const failed = right({ status: 'failed', ms: 3_000, tool: 'Read' })
    expect(failed.text.endsWith(' 失敗 0:03 MK-1')).toBe(true)
    expect(failed.segs.find(s => s.t === '失敗')?.color).toBe(THEME.error)
    expect(right({ status: 'stale', ms: 3_000, tool: 'Read' }).text.endsWith(' 失聯 MK-1')).toBe(true)
    expect(right({ status: 'running', ms: 0, tool: 'mcp__jarvis__task_long' }).text).toContain(fitCells('mcp__jarvis__task_long', TOOL_MAX))
  })

  test('a narrow row cuts the title to TITLE_MIN first, then gives up the tool, then the time; MK-N stays', () => {
    expect(TITLE_MIN).toBe(8)
    const b = ok(applyTask(running(0), { op: 'update', id: '1.1', agent: 'agent-7', title: '很長的細項標題很長' }))
    const at = (width: number) => text(taskRows(b, width, 10, () => mk({ status: 'running', ms: 65_000, tool: 'Bash' }), 0)[2] ?? [])
    expect(at(30).endsWith(' Bash 1:05 MK-1')).toBe(true)
    expect(at(28).endsWith(' 1:05 MK-1')).toBe(true)
    expect(at(28)).not.toContain('Bash')
    expect(at(18).endsWith(' MK-1')).toBe(true)
    expect(at(18)).not.toContain('1:05')
    for (const w of [30, 28, 18]) expect(cellWidth(at(w))).toBe(w)
    const failed = text(taskRows(b, 24, 10, () => mk({ status: 'failed', ms: 65_000, tool: 'Bash' }), 0)[2] ?? [])
    expect(failed.endsWith(' 失敗 MK-1')).toBe(true)
  })

  test('a done or failed row keeps its word and MK-N past the time; the title shrinks instead', () => {
    const b = ok(applyTask(running(0), { op: 'update', id: '1.1', agent: 'agent-7', title: '很長的細項標題很長' }))
    const at = (width: number, status: 'done' | 'failed') =>
      text(taskRows(b, width, 10, () => mk({ status, ms: 65_000, tool: 'Bash' }), 0)[2] ?? [])
    // 17: the title down to its last cell
    for (const w of [18, 17]) {
      expect(at(w, 'failed').endsWith(' 失敗 MK-1')).toBe(true)
      expect(at(w, 'done').endsWith(' 完成 MK-1')).toBe(true)
      expect(cellWidth(at(w, 'failed'))).toBe(w)
    }
  })

  test('a title shorter than TITLE_MIN gives up nothing while it fits whole', () => {
    const b = ok(applyTask(running(0), { op: 'update', id: '1.1', agent: 'agent-7', title: 's1' }))
    const row = text(taskRows(b, 26, 10, () => mk({ status: 'running', ms: 3_725_000, tool: 'Bash' }), 0)[2] ?? [])
    expect(row.endsWith(` s1 Bash ${fmtReadout(3_725_000)} MK-1`)).toBe(true)
    expect(cellWidth(row)).toBe(26)
  })
})

// what the small model is asked, as a test's Haiku reads it
type Asked = { model: string; prompt: string; system?: string; maxTokens?: number; timeoutMs?: number }

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
// the small model with nothing to say
const NO_REPLY = { isAnswered: false, reason: 'empty-reply', usage: USAGE } as const
// the small model's answer
const said = (text: string) => ({ isAnswered: true, text, usage: USAGE }) as const

// the test-side bottom of the chain, standing for the engine; `reply` stands for Haiku
const TASK_CREATE_ID = '7'
const world = (on: On, outcome: Record<string, unknown> = {}, reply: (e: Asked) => Promise<unknown> = async () => NO_REPLY) => {
  const registered: { name: string; isDeferred?: boolean }[] = []
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, {})
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', async () => ({}))
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'agent-7' }))
  on('agent.list', async () => ({ value: [{ id: 'agent-7', status: 'running', type: 'worker', description: 'd' }] as never }))
  on('tool.register', async (_$, e) => {
    registered.push({ name: e.name, ...(e.isDeferred === undefined ? {} : { isDeferred: e.isDeferred }) })
    return { value: { tool: `mcp__jarvis__${e.name}` } }
  })
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'intro', scope: 'shared' as const }] }))
  on('prompt.submit', async (_$, e) =>
    e.text === '丟掉' ? { drop: 'no' } : { text: e.text.replace('hunter2', '***'), ...(e.context === undefined ? {} : { context: e.context }) },
  )
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('model.complete', async (_$, e) => ({ value: (await reply(e)) as never }))
  on('tool.call', async (_$, e) =>
    'deny' in outcome
      ? (outcome as never)
      : {
          result: (e.tool === 'TaskCreate' ? { task: { id: TASK_CREATE_ID, subject: 's' } } : {}) as never,
          ...outcome,
        },
  )
  return { registered, clock }
}

const startSession = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

// a call of the board's tool; `agentId` as the engine stamps a subagent's call
const task = ($: Engine, input: Record<string, unknown>, agentId?: string) =>
  $.tool.call({ tool: TASK_TOOL, ...input, ...(agentId === undefined ? {} : { agentId }) } as never)

const boardOf = async ($: Engine): Promise<string> => String((await task($, { op: 'list' })).result)

// a full prompt.compose input offering `tools`
const composeFor = (tools: string[]) => ({
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: [],
  tools,
  outputStyle: null,
  traits: [],
})

// the person sends a prompt; `over` sets what the engine stamps (origin, command, isMeta, turnId)
const send = ($: Engine, text: string, over: Record<string, unknown> = {}) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...over } as never)

const turnStarts = ($: Engine, turnId: string, text: string, agentId?: string) =>
  $.turn.start({ text, turnId, ...(agentId === undefined ? {} : { agentId }) })

const turnEnds = ($: Engine, turnId: string, reason = 'answer', agentId?: string) =>
  $.turn.complete({
    answer: 'ok',
    durationMs: 1,
    isAborted: reason === 'aborted',
    turnId,
    reason,
    ...(agentId === undefined ? {} : { agentId }),
  } as never)

// a main-loop tool call, as the model doing something for the request its turn runs
const work = ($: Engine) => $.tool.call({ tool: 'Read', file_path: '/tmp/a.md' } as never)

describe('task board tool', () => {
  test('session.start registers the board tool, its schema in the prompt', async ($, on) => {
    const w = world(on)
    await startSession($)
    expect(w.registered).toContainEqual({ name: 'task', isDeferred: false })
  })

  test('a call answers with the board; a bad call is refused and changes nothing', async ($, on) => {
    world(on)
    const added = await task($, { op: 'add', item: '加看板', subtasks: ['調查', '實作'] })
    expect(added.deny).toBeUndefined()
    expect(String(added.result)).toContain('[ ] 1.1 調查')
    const bad = await task($, { op: 'update', id: '9.9', status: 'completed' })
    expect(bad.deny).toContain('找不到')
    expect(await boardOf($)).toBe(String(added.result))
  })

  test("a subagent's update marks the subtask its own", async ($, on) => {
    world(on)
    await task($, { op: 'add', item: 'A', subtasks: ['a1'] })
    await task($, { op: 'update', id: '1.1', status: 'in_progress' }, 'agent-7')
    expect(await boardOf($)).toContain('[>] 1.1 a1 (agent agent-7)')
  })

  test('parallel calls each land on the board', async ($, on) => {
    world(on)
    await task($, { op: 'add', item: 'A', subtasks: ['a1', 'a2', 'a3'] })
    await Promise.all(['1.1', '1.2', '1.3'].map((id, k) => task($, { op: 'update', id, status: 'completed' }, `agent-${k}`)))
    expect(await boardOf($)).toContain('[x] 1 A')
  })

  test('session.start again (a hot reload) keeps the board', async ($, on) => {
    world(on)
    await startSession($)
    await task($, { op: 'add', item: 'A' })
    await startSession($)
    expect(await boardOf($)).toContain('[ ] 1 A')
  })

  test('the system prompt gains the board section only where the request offers the tool', async ($, on) => {
    world(on)
    const withTool = await $.prompt.compose(composeFor([TASK_TOOL]))
    expect(withTool.sections.at(-1)).toEqual({ id: TASK_SECTION_ID, text: TASK_PROMPT, scope: 'session' })
    expect(withTool.sections.filter(s => s.id === TASK_SECTION_ID)).toHaveLength(1)
    const without = await $.prompt.compose(composeFor(['Read']))
    expect(without.sections.some(s => s.id === TASK_SECTION_ID)).toBe(false)
  })

  test('TodoWrite, TaskCreate and TaskUpdate are mirrored onto the board', async ($, on) => {
    world(on)
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: '讀檔', status: 'completed', activeForm: '讀檔中' },
        { content: '改檔', status: 'in_progress', activeForm: '改檔中' },
      ],
    })
    await $.tool.call({ tool: 'TaskCreate', subject: '跑測試', description: 'd' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: TASK_CREATE_ID, status: 'completed' })
    const text = await boardOf($)
    expect(text).toContain('[>] 1 TodoWrite')
    expect(text).toContain('  [x] 1.1 讀檔')
    expect(text).toContain('  [>] 1.2 改檔')
    expect(text).toContain('[x] 2 內建任務')
    expect(text).toContain('  [x] 2.1 跑測試')
  })

  const mirrorNothing = async ($: Engine) => {
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: '讀檔', status: 'pending', activeForm: '讀檔中' }] })
    await $.tool.call({ tool: 'TaskCreate', subject: '跑測試', description: 'd' })
    expect(await boardOf($)).toBe('任務看板是空的。')
  }

  test('an isError result is not mirrored onto the board', async ($, on) => {
    world(on, { isError: true })
    await mirrorNothing($)
  })

  test('a denied call is not mirrored onto the board', async ($, on) => {
    world(on, { deny: 'no' })
    await mirrorNothing($)
  })

  test('a new, cleared or resumed session empties the board; a compaction keeps it', async ($, on) => {
    world(on)
    for (const source of ['startup', 'clear', 'resume']) {
      await task($, { op: 'add', item: 'A' })
      await $.classic.SessionStart({ source: 'compact' } as never)
      expect(await boardOf($)).toContain('[ ] 1 A')
      await $.classic.SessionStart({ source } as never)
      expect(await boardOf($)).toBe('任務看板是空的。')
    }
  })
})

type Node = { type?: string; props?: Record<string, unknown>; children?: (Node | string)[] }

const textOf = (n: Node | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''))

// One string per drawn row, a row's pieces joined with nothing between them.
const linesOf = (n: Node | string): string[] => {
  if (typeof n === 'string') return [n]
  if (n.type === 'Text' || n.type === 'Button' || n.props?.['flexDirection'] === 'row') return [textOf(n)]
  return (n.children ?? []).flatMap(linesOf)
}

const paneProps = (rows: number, cols: number) => ({
  title: 'Jarvis',
  isFocused: true,
  bodyColumns: cols,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: rows },
  view: {},
})

const draw = async ($: Engine, rows = 30, cols = 80): Promise<Node> =>
  (await $.ui.render({
    surface: 'terminal',
    component: 'Pane',
    requestId: 'jarvis',
    viewport: { columns: cols + 20, rows: rows + 10 },
    props: paneProps(rows, cols),
  })) as RenderElement as Node

const pressKey = async ($: Engine, key: string, rows = 30, cols = 80) => {
  const ui = await $.ui.mount({
    plugin: 'jarvis',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'jarvis',
    props: paneProps(rows, cols),
    viewport: { columns: cols + 20, rows: rows + 10 },
  })
  await ui.press({ key })
  await ui.unmount()
}

const openTasks = ($: Engine, rows = 30, cols = 80) => pressKey($, 'tab-tasks', rows, cols)

// the color of the first drawn completed icon
const iconColor = (n: Node | string): unknown => {
  if (typeof n === 'string') return undefined
  if (textOf(n) === withIcon(TASK_ICON.completed, '') && n.props?.['color'] !== undefined) return n.props['color']
  for (const c of n.children ?? []) {
    const found = iconColor(c)
    if (found !== undefined) return found
  }
  return undefined
}

// how many times the mod has written its tick: counted beneath the mod, at the state bottom
const tickWrites = (on: On) => {
  const count = { n: 0 }
  on('state.set', { plugin: 'jarvis', key: 'tick' }, async (_$, e, next) => {
    count.n += 1
    return next(e)
  })
  return count
}

const spawnWorker = ($: Engine) =>
  $.agent.spawn({
    tool_use_id: 'tu-1',
    prompt: 'p',
    description: '實作看板',
    subagentType: 'worker',
    provider: { plugin: 'engine', tier: 'core' } as const,
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })

describe('task board requests wired', () => {
  test('a sent request becomes a running item and its turn end completes it; the model reads its id beside the prompt', async ($, on) => {
    world(on)
    const out = await send($, '修 jarvis 的 bug\n細節在下面')
    expect(out.context).toContain(requestContext('1'))
    expect(await boardOf($)).toContain('[>] 1 修 jarvis 的 bug（本輪請求）')
    await turnStarts($, 't1', '修 jarvis 的 bug\n細節在下面')
    await work($)
    await turnEnds($, 't1')
    expect(await boardOf($)).toContain('[x] 1 修 jarvis 的 bug')
  })

  test('slash commands, hidden prompts and other sources are not recorded', async ($, on) => {
    world(on)
    await send($, '/jarvis', { command: { name: 'jarvis', args: '' } })
    await send($, '背景任務完成', { origin: { kind: 'task-notification' } })
    await send($, '看不到的', { isMeta: true })
    expect(await boardOf($)).toBe('任務看板是空的。')
  })

  test("an interrupted turn leaves its request pending; a subagent's turn closes nothing", async ($, on) => {
    world(on)
    await send($, 'A')
    await turnStarts($, 'ts', 'sub work', 'agent-7')
    await turnEnds($, 'ts', 'answer', 'agent-7')
    expect(await boardOf($)).toContain('[>] 1 A（本輪請求）')
    await turnStarts($, 't1', 'A')
    await work($)
    await turnStarts($, 'ta', 'sub work', 'agent-7')
    await turnEnds($, 'ta', 'answer', 'agent-7')
    expect(await boardOf($)).toContain('[>] 1 A')
    await turnEnds($, 't1', 'aborted')
    expect(await boardOf($)).toContain('[ ] 1 A')
  })

  test("the model's own item across turns is left alone; its plan folds into the request", async ($, on) => {
    world(on)
    await send($, '1')
    await turnStarts($, 't1', '1')
    await task($, { op: 'add', item: '任務看板改版', subtasks: ['寫計畫', '實作'] })
    await task($, { op: 'update', id: '1.1', status: 'in_progress' })
    await turnEnds($, 't1')
    let text = await boardOf($)
    expect(text).toContain('[>] 1 任務看板改版')
    expect(text).not.toContain('[x] 1')
    await turnStarts($, 't2', '背景任務完成通知')
    await turnEnds($, 't2')
    await send($, '好')
    await turnStarts($, 't3', '好')
    await turnEnds($, 't3')
    text = await boardOf($)
    expect(text).toContain('[>] 1 任務看板改版')
    expect(text).not.toContain('好')
  })

  test('a prompt typed mid-turn leaves the plan to the request the turn runs', async ($, on) => {
    world(on)
    await send($, 'A')
    await turnStarts($, 't1', 'A')
    await send($, 'B', { turnId: 't1' })
    await task($, { op: 'add', item: '計畫', subtasks: ['s1'] })
    const text = await boardOf($)
    expect(text).toContain('[ ] 1 計畫（本輪請求）\n  [ ] 1.1 s1')
    expect(text).toContain('[>] 2 B')
    expect(text).not.toContain('2.1')
  })

  test('a prompt typed while a turn runs closes with it, and runs again when it starts its own turn', async ($, on) => {
    world(on)
    await send($, 'A')
    await turnStarts($, 't1', 'A')
    await send($, 'B', { turnId: 't1' })
    await turnEnds($, 't1')
    expect(await boardOf($)).toContain('[x] 2 B')
    await turnStarts($, 't2', 'B')
    expect(await boardOf($)).toContain('[>] 2 B（本輪請求）')
    await work($)
    await turnEnds($, 't2')
    expect(await boardOf($)).toContain('[x] 2 B')
  })

  test('a dropped prompt leaves no item', async ($, on) => {
    world(on)
    const out = await send($, '丟掉')
    expect(out.drop).toBe('no')
    expect(await boardOf($)).toBe('任務看板是空的。')
  })
})

// every Button in a drawn tree
const buttonsOf = (n: Node | string): Node[] =>
  typeof n === 'string' ? [] : [...(n.type === 'Button' ? [n] : []), ...(n.children ?? []).flatMap(buttonsOf)]

const taskButton = (root: Node, id: string): Node | undefined =>
  buttonsOf(root).find(b => b.props?.['key'] === `task-${id}`)

describe('task board page', () => {
  test('the 任務 tab follows 異動 and opens on an empty board', async ($, on) => {
    world(on)
    const tabs = linesOf(await draw($)).find(l => l.includes('異動')) ?? ''
    expect(tabs.indexOf('任務')).toBeGreaterThan(tabs.indexOf('異動'))
    await openTasks($)
    const lines = linesOf(await draw($))
    expect(lines.some(l => l.includes(EMPTY_TEXT))).toBe(true)
    expect(lines.some(l => l.includes('0/0 項目 · 細項 0/0'))).toBe(true)
  })

  test('items, subtasks, counts and the owner MK-N on the page', async ($, on) => {
    world(on)
    await spawnWorker($)
    await task($, { op: 'add', item: '加看板', subtasks: ['調查', '實作'] })
    await task($, { op: 'update', id: '1.1', status: 'completed' })
    await task($, { op: 'update', id: '1.2', status: 'in_progress' }, 'agent-7')
    await openTasks($)
    const lines = linesOf(await draw($))
    expect(lines.some(l => l.includes('0/1 項目 · 細項 1/2'))).toBe(true)
    expect(lines.find(l => l.includes('加看板'))?.trimEnd()).toMatch(/1\/2 0:00$/)
    expect(lines.find(l => l.includes('實作') && !l.includes('加看板'))?.trimEnd().endsWith('MK-1')).toBe(true)
  })

  test('a narrow pane cuts long titles; no row is wider than the pane', async ($, on) => {
    world(on)
    await task($, { op: 'add', item: '很長的工作項目標題'.repeat(5), subtasks: ['很長的細項標題'.repeat(6)] })
    await openTasks($, 30, 40)
    const lines = linesOf(await draw($, 30, 40))
    for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(40)
    expect(lines.some(l => l.includes('很長的工作項目標題') && l.includes('…'))).toBe(true)
  })

  test("a member's run beside its subtask, and running times that move with the clock", async ($, on) => {
    const { clock } = world(on)
    await spawnWorker($)
    await task($, { op: 'add', item: '加看板', subtasks: ['實作'] })
    await task($, { op: 'update', id: '1.1', status: 'in_progress', agent: 'agent-7' })
    await openTasks($)
    await clock.advance(65_000)
    const lines = linesOf(await draw($))
    expect(lines.find(l => l.includes('實作') && !l.includes('加看板'))?.trimEnd()).toMatch(/1:05 MK-1$/)
    expect(lines.find(l => l.includes('加看板'))?.trimEnd()).toMatch(/0\/1 1:05$/)
  })

  test('the tasks page ticks every ANIM_MS while it has running work and is drawn; not on another page; not once the work is done', async ($, on) => {
    const { clock } = world(on)
    const count = tickWrites(on)
    await startSession($)
    await task($, { op: 'add', item: '工作', subtasks: ['a'] })
    await task($, { op: 'update', id: '1.1', status: 'in_progress' })
    await openTasks($)
    await draw($)
    let base = count.n
    await clock.advance(ANIM_MS * 10)
    expect(count.n - base).toBe(10)
    await pressKey($, 'tab-now')
    await draw($)
    await clock.advance(IDLE_MS)
    base = count.n
    await clock.advance(ANIM_MS * 10)
    expect(count.n).toBe(base)
    await openTasks($)
    await task($, { op: 'update', id: '1.1', status: 'completed' })
    await draw($)
    await clock.advance(FRESH_MS + IDLE_MS)
    base = count.n
    await clock.advance(IDLE_MS * 3)
    expect(count.n).toBe(base)
  })

  test('after a turn ends the page ticks once more past FRESH_MS to drop the highlight, then stops', async ($, on) => {
    const { clock } = world(on)
    const count = tickWrites(on)
    await startSession($)
    await send($, 'A')
    await turnStarts($, 't1', 'A')
    await work($)
    await openTasks($)
    await draw($)
    await clock.advance(1000)
    await turnEnds($, 't1')
    await draw($)
    expect(iconColor(await draw($))).toBe(THEME.bright)
    await clock.advance(FRESH_MS)
    const base = count.n
    await clock.advance(ANIM_MS * 4)
    expect(count.n).toBeGreaterThan(base)
    expect(iconColor(await draw($))).toBe(THEME.success)
    const after = count.n
    await clock.advance(IDLE_MS * 3)
    expect(count.n).toBe(after)
  })

  test('a tick running late past FRESH_MS still repaints the highlight away', async ($, on) => {
    const late = { ms: 0 }
    on('clock.every', { ms: ANIM_MS }, async (_$, e, next) => {
      if (late.ms > 0) await clock.sleep(late.ms)
      return next(e)
    })
    const { clock } = world(on)
    const count = tickWrites(on)
    await startSession($)
    await send($, 'A')
    await turnStarts($, 't1', 'A')
    await work($)
    await openTasks($)
    await draw($)
    await clock.advance(1000)
    await turnEnds($, 't1')
    await draw($)
    await clock.advance(FRESH_MS - ANIM_MS)
    late.ms = ANIM_MS * 2
    await clock.advance(ANIM_MS)
    const base = count.n
    await clock.advance(ANIM_MS * 3)
    expect(count.n).toBeGreaterThan(base)
    expect(iconColor(await draw($))).toBe(THEME.success)
  })

  test('a /clear empties the page', async ($, on) => {
    world(on)
    await task($, { op: 'add', item: 'A' })
    await openTasks($)
    await $.classic.SessionStart({ source: 'clear' } as never)
    expect(linesOf(await draw($)).some(l => l.includes(EMPTY_TEXT))).toBe(true)
  })

  test("pressing an item's title folds its subtasks and pressing again opens them; done/total stays", async ($, on) => {
    world(on)
    await task($, { op: 'add', item: '加看板', subtasks: ['調查', '實作'] })
    await openTasks($)
    expect(linesOf(await draw($)).some(l => l.includes('調查'))).toBe(true)
    await pressKey($, 'task-1')
    let lines = linesOf(await draw($))
    expect(lines.some(l => l.includes('調查'))).toBe(false)
    expect(lines.find(l => l.includes('加看板'))?.trimEnd()).toMatch(/0\/2$/)
    await pressKey($, 'task-1')
    lines = linesOf(await draw($))
    expect(lines.some(l => l.includes('調查'))).toBe(true)
  })

  test('a done item opens on a press and stays open while the board changes', async ($, on) => {
    world(on)
    await task($, { op: 'add', item: '加看板', subtasks: ['調查'] })
    await task($, { op: 'update', id: '1', status: 'completed' })
    await openTasks($)
    expect(linesOf(await draw($)).some(l => l.includes('調查'))).toBe(false)
    await pressKey($, 'task-1')
    expect(linesOf(await draw($)).some(l => l.includes('調查'))).toBe(true)
    await task($, { op: 'add', item: '下一件', subtasks: ['x'] })
    expect(linesOf(await draw($)).some(l => l.includes('調查'))).toBe(true)
  })

  test('only the icon and title are the Button; items without subtasks and subtask rows have none', async ($, on) => {
    world(on)
    await task($, { op: 'add', item: '加看板', subtasks: ['調查'] })
    await task($, { op: 'add', item: '沒細項' })
    await openTasks($)
    const root = await draw($)
    const b = taskButton(root, '1')
    expect(b).toBeDefined()
    const t = textOf(b!)
    expect(t).toContain('加看板')
    expect(t).toBe(t.trimEnd())
    expect(t).not.toContain('0/1')
    expect(taskButton(root, '2')).toBeUndefined()
    expect(buttonsOf(root).some(n => textOf(n).includes('調查'))).toBe(false)
  })

  test('a narrow pane keeps every row within the pane with a pressable title', async ($, on) => {
    world(on)
    await task($, { op: 'add', item: '很長的工作項目標題'.repeat(5), subtasks: ['細項'] })
    await openTasks($, 30, 40)
    const root = await draw($, 30, 40)
    for (const l of linesOf(root)) expect(cellWidth(l)).toBeLessThanOrEqual(40)
    expect(textOf(taskButton(root, '1')!)).toContain('…')
  })

  test('a /clear forgets the fold choices: the new item 1 opens', async ($, on) => {
    world(on)
    await task($, { op: 'add', item: '舊的', subtasks: ['舊細項'] })
    await openTasks($)
    await pressKey($, 'task-1')
    await $.classic.SessionStart({ source: 'clear' } as never)
    await task($, { op: 'add', item: '新的', subtasks: ['新細項'] })
    await openTasks($)
    expect(linesOf(await draw($)).some(l => l.includes('新細項'))).toBe(true)
  })

  test('folding leaves the board the model reads unchanged', async ($, on) => {
    world(on)
    await task($, { op: 'add', item: '加看板', subtasks: ['調查'] })
    const before = await boardOf($)
    await openTasks($)
    await pressKey($, 'task-1')
    expect(await boardOf($)).toBe(before)
  })
})

describe('request summaries', () => {
  // a request sent and answered, its rid r1, at 0 and 5
  const sent = (text = '算一下 7*6', rid = 'r1') => openRequest(EMPTY_BOARD, text, undefined, 0, rid).board
  const answered = (text = '算一下 7*6', rid = 'r1') => endTurn(startTurn(sent(text, rid), 't1', text), 't1', 'answer', 5)

  test('lineOf keeps the first non-blank line as one line, cut with an ellipsis', () => {
    expect(lineOf('\n  a  b\tc \nnext', 10)).toBe('a b c')
    expect(lineOf('一二三四五六', 4)).toBe('一二三…')
    expect(requestTitle('長'.repeat(100))).toBe(lineOf('長'.repeat(100), REQUEST_TITLE_MAX))
  })

  test('a reply is cleaned to one line: no quotes, no full stop, cut to its cap', () => {
    expect(cleanSummary('「計算 7*6」。\n多的', SUMMARY_TITLE_MAX)).toBe('計算 7*6')
    expect(cleanSummary('"42"', RESULT_MAX)).toBe('42')
    expect(cleanSummary('   \n', RESULT_MAX)).toBe('')
    expect([...cleanSummary('字'.repeat(80), RESULT_MAX)]).toHaveLength(RESULT_MAX)
  })

  test('a reply loses the symbols that render two cells wide', () => {
    expect(cleanSummary('A → B × C — D – E', RESULT_MAX)).toBe('A -> B x C - D - E')
    expect(cleanSummary('它的 ‘x’ 與 “y” 值', RESULT_MAX)).toBe("它的 'x' 與 \"y\" 值")
  })

  test('the asks carry the request and the answer, each cut to SUMMARY_INPUT_MAX', () => {
    const long = 'x'.repeat(SUMMARY_INPUT_MAX + 500)
    expect(titleAsk('算 7*6')).toContain('算 7*6')
    expect(titleAsk(long)).toContain('x'.repeat(SUMMARY_INPUT_MAX))
    expect(titleAsk(long)).not.toContain('x'.repeat(SUMMARY_INPUT_MAX + 1))
    const r = resultAsk('算 7*6', '答案是 42')
    expect(r).toContain('算 7*6')
    expect(r).toContain('回答：\n答案是 42')
    expect(resultAsk('q', long)).not.toContain('x'.repeat(SUMMARY_INPUT_MAX + 1))
  })

  test('a request item keeps its rid', () => {
    expect(sent().items[0]).toMatchObject({ id: '1', rid: 'r1', title: '算一下 7*6' })
    expect(openRequest(EMPTY_BOARD, '算').board.items[0]?.rid).toBeUndefined()
  })

  test('a summary title replaces the prompt line by rid; a gone item, a blank summary or the model title stay', () => {
    const b = sent()
    expect(withSummaryTitle(b, 'r1', '計算 7*6').items[0]).toMatchObject({ title: '計算 7*6', titleBy: 'haiku', key: '算一下 7*6' })
    expect(withSummaryTitle(b, 'nope', '計算')).toBe(b)
    expect(withSummaryTitle(b, 'r1', '')).toBe(b)
    const renamed = ok(applyTask(b, { op: 'update', id: '1', title: '模型的標題' }))
    expect(renamed.items[0]?.titleBy).toBe('model')
    expect(withSummaryTitle(renamed, 'r1', '計算 7*6')).toBe(renamed)
  })

  test('a plan folded into the request keeps its title from a later summary', () => {
    const b = startTurn(sent(), 't1', '算一下 7*6')
    const folded = ok(applyTask(b, { op: 'add', item: '計畫', subtasks: ['s1'] }))
    expect(folded.items[0]).toMatchObject({ title: '計畫', titleBy: 'model' })
    expect(withSummaryTitle(folded, 'r1', '計算')).toBe(folded)
  })

  test('a result lands on its item by rid and shows in the text the model reads', () => {
    const b = answered()
    const done = withResult(b, 'r1', '42')
    expect(done.items[0]?.result).toBe('42')
    expect(boardText(done)).toContain('[x] 1 算一下 7*6 → 42')
    expect(withResult(b, 'nope', '42')).toBe(b)
    expect(withResult(b, 'r1', '')).toBe(b)
  })

  test("the requests a turn's end answers: tied to it, running, not typed over it", () => {
    let b = openRequest(EMPTY_BOARD, 'A', undefined, 0, 'ra').board
    b = startTurn(b, 't1', 'A')
    b = openRequest(b, 'B', 't1', 0, 'rb').board
    b = ok(applyTask(b, { op: 'add', item: '模型自己的' }))
    expect(requestsEnding(b, 't1')).toEqual([{ rid: 'ra', title: 'A', subtasks: [] }])
    expect(requestsEnding(b, 't9')).toEqual([])
  })

  test('an item row shows its result after the title; a narrow row cuts the result first, then drops it', () => {
    const b = withResult(answered('計算 7*6'), 'r1', '比較後交換的無鎖原子更新')
    const owner = (): OwnerMark => ({ t: 'MK', color: THEME.frame })
    const row = (w: number) => (taskRows(b, w, 10, owner, 10_000)[1] ?? []).map(s => s.t).join('')
    for (const w of [60, 30, 20, 16, 12]) expect(cellWidth(row(w))).toBe(w)
    expect(row(60)).toContain(`計算 7*6 ${withIcon(RESULT_ICON, '比較後交換的無鎖原子更新')}`)
    expect(row(30)).toContain('計算 7*6')
    expect(row(30)).toContain(RESULT_ICON)
    expect(row(30)).toContain('…')
    expect(row(12)).not.toContain(RESULT_ICON)
    expect(row(12)).toContain('計算 7*6')
  })
})

describe('request summaries wired', () => {
  test('a sent request is titled by the small model; its answered turn gets a result', async ($, on) => {
    const asked: Asked[] = []
    const { clock } = world(on, {}, async e => {
      asked.push(e)
      return said(e.prompt.includes('回答：') ? '42' : '計算 7*6')
    })
    await send($, '幫我算一下 7*6 等於多少，只回數字')
    await clock.settle()
    expect(await boardOf($)).toContain('[>] 1 計算 7*6（本輪請求）')
    await turnStarts($, 't1', '幫我算一下 7*6 等於多少，只回數字')
    await work($)
    await $.turn.complete({ answer: '42', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.settle()
    expect(await boardOf($)).toContain('[x] 1 計算 7*6 → 42')
    expect(asked).toHaveLength(2)
    expect(asked[0]).toMatchObject({ model: SUMMARY_MODEL, system: SUMMARY_SYSTEM, timeoutMs: SUMMARY_TIMEOUT_MS })
    expect(asked[0]?.prompt).toContain('幫我算一下 7*6')
    expect(asked[1]?.prompt).toContain('幫我算一下 7*6')
    expect(asked[1]?.prompt).toContain('回答：\n42')
  })

  test('a dropped prompt is never sent to the small model; a rewritten one is sent as rewritten', async ($, on) => {
    const asked: Asked[] = []
    const { clock } = world(on, {}, async e => {
      asked.push(e)
      return said('計算')
    })
    await send($, '丟掉')
    await clock.settle()
    expect(asked).toHaveLength(0)
    await send($, '密碼是 hunter2')
    await clock.settle()
    expect(asked).toHaveLength(1)
    expect(asked[0]?.prompt).toContain('密碼是 ***')
    expect(asked[0]?.prompt).not.toContain('hunter2')
  })

  test('no summary leaves the prompt line and no result: a refused call, an API error', async ($, on) => {
    let n = 0
    const { clock } = world(on, {}, async () => {
      n += 1
      if (n === 1) throw new Error('blocked model')
      return { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage: USAGE }
    })
    await send($, '算 1+1')
    await clock.settle()
    await turnStarts($, 't1', '算 1+1')
    await work($)
    await turnEnds($, 't1')
    await clock.settle()
    const text = await boardOf($)
    expect(text).toContain('[x] 1 算 1+1')
    expect(text).not.toContain('→')
    expect(n).toBe(2)
  })

  test('a title the model set is not replaced by a summary that comes back later', async ($, on) => {
    const { clock } = world(on, {}, async () => {
      await clock.sleep(1000)
      return said('計算')
    })
    await send($, '算一下')
    await clock.settle()
    await task($, { op: 'update', id: '1', title: '模型的標題' })
    await clock.advance(1000)
    expect(await boardOf($)).toContain('[>] 1 模型的標題（本輪請求）')
  })

  test('a summary that comes back after /clear is dropped, even onto a new item 1', async ($, on) => {
    let n = 0
    const { clock } = world(on, {}, async () => {
      n += 1
      if (n > 1) return NO_REPLY
      await clock.sleep(5000)
      return said('舊的標題')
    })
    await send($, '同一句話')
    await clock.settle()
    await $.classic.SessionStart({ source: 'clear' } as never)
    await send($, '同一句話')
    await clock.settle()
    await clock.advance(5000)
    const text = await boardOf($)
    expect(text).toContain('[>] 1 同一句話（本輪請求）')
    expect(text).not.toContain('舊的標題')
  })

  test('a slash command, a subagent turn and an interrupted turn ask nothing; a queued request takes no answer of another turn', async ($, on) => {
    const asked: string[] = []
    const { clock } = world(on, {}, async e => {
      asked.push(e.prompt)
      return NO_REPLY
    })
    await send($, '/jarvis', { command: { name: 'jarvis', args: '' } })
    await send($, '做一件事')
    await clock.settle()
    expect(asked).toHaveLength(1)
    await turnStarts($, 'ta', 'sub', 'agent-7')
    await turnEnds($, 'ta', 'answer', 'agent-7')
    await turnStarts($, 't1', '做一件事')
    await turnEnds($, 't1', 'aborted')
    await clock.settle()
    expect(asked).toHaveLength(1)
    await send($, 'C')
    await turnStarts($, 't2', 'C')
    await work($)
    await send($, 'D', { turnId: 't2' })
    await clock.settle()
    await turnEnds($, 't2')
    await clock.settle()
    // titles of C and D, then the result of C alone
    expect(asked).toHaveLength(4)
    expect(asked[3]).toContain('C')
    expect(asked[3]).not.toContain('\nD')
  })

  test('the page shows a result after the title, outside the Button', async ($, on) => {
    const { clock } = world(on, {}, async e => said(e.prompt.includes('回答：') ? '42' : '計算 7*6'))
    await send($, '算 7*6')
    await turnStarts($, 't1', '算 7*6')
    await task($, { op: 'add', subtasks: ['算'] })
    await task($, { op: 'update', id: '1.1', status: 'completed' })
    await $.turn.complete({ answer: '42', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.settle()
    await openTasks($)
    const root = await draw($)
    expect(linesOf(root).find(l => l.includes('計算 7*6')) ?? '').toContain(withIcon(RESULT_ICON, '42'))
    const b = taskButton(root, '1')
    expect(b).toBeDefined()
    expect(textOf(b!)).toContain('計算 7*6')
    expect(textOf(b!)).not.toContain('42')
  })

  test('the prompt and the note tell the model titles and results are summed up for it', () => {
    expect(TASK_PROMPT).toContain('自動摘成一句')
    const note = requestContext('7')
    expect(note).toContain('項目 7')
    expect(note).toContain('id=7')
    expect(note).toContain('記下結果')
  })
})

describe('results of work over many turns', () => {
  // a request sent, its turn t1 started, a plan of two subtasks hung on it
  const planned = () => {
    const b = startTurn(openRequest(EMPTY_BOARD, '做一件大事', undefined, 0, 'r1').board, 't1', '做一件大事')
    return ok(applyTask(b, { op: 'add', subtasks: ['調查', '實作'] }))
  }
  const finish = (b: JarvisTaskBoard, ...ids: string[]) =>
    ids.reduce((x, id) => ok(applyTask(x, { op: 'update', id, status: 'completed' })), b)

  test('a request item with unfinished subtasks is not answered by its turn end', () => {
    const b = finish(planned(), '1.1')
    expect(requestsEnding(b, 't1')).toEqual([])
  })

  test('the plan completing marks the result due, wherever its turn is; the end answers it with the subtask titles', () => {
    const b = endTurn(finish(planned(), '1.1'), 't1', 'answer', 5)
    const done = finish(b, '1.2')
    expect(done.items[0]?.resultDue).toBe(true)
    expect(requestsEnding(done, 't2')).toEqual([{ rid: 'r1', title: '做一件大事', subtasks: ['調查', '實作'] }])
  })

  test('a plan done within its own turn is answered once', () => {
    const b = finish(planned(), '1.1', '1.2')
    expect(requestsEnding(b, 't1')).toEqual([{ rid: 'r1', title: '做一件大事', subtasks: ['調查', '實作'] }])
  })

  test('the item marked completed, or its last open subtask removed, completes the plan too', () => {
    expect(ok(applyTask(planned(), { op: 'update', id: '1', status: 'completed' })).items[0]?.resultDue).toBe(true)
    expect(ok(applyTask(finish(planned(), '1.1'), { op: 'remove', id: '1.2' })).items[0]?.resultDue).toBe(true)
  })

  test('a completion drops an older result; reopening clears both result and due', () => {
    // an interim result left by the old rule, before plans waited for their completion
    const ended = endTurn(planned(), 't1', 'answer', 5)
    const stale: JarvisTaskBoard = { ...ended, items: ended.items.map(i => ({ ...i, result: '撰寫中' })) }
    const done = finish(stale, '1.1', '1.2')
    expect(done.items[0]?.result).toBeUndefined()
    const answered = withResult(closeResults(done, true), 'r1', '做完了')
    expect(answered.items[0]).toMatchObject({ result: '做完了' })
    expect(answered.items[0]?.resultDue).toBeUndefined()
    const reopened = ok(applyTask(answered, { op: 'add', to: '1', subtasks: ['補測試'] }))
    expect(reopened.items[0]?.result).toBeUndefined()
    expect(reopened.items[0]?.resultDue).toBeUndefined()
    expect(finish(reopened, '1.3').items[0]?.resultDue).toBe(true)
  })

  test('a result that comes back onto an unfinished plan is dropped', () => {
    const b = endTurn(finish(planned(), '1.1'), 't1', 'answer', 5)
    expect(withResult(b, 'r1', '撰寫中')).toBe(b)
  })

  test('closeResults: an answered end takes the due marks; any end clears results of unfinished plans', () => {
    const done = finish(endTurn(planned(), 't1', 'answer', 5), '1.1', '1.2')
    expect(closeResults(done, false)).toBe(done)
    expect(closeResults(done, true).items[0]?.resultDue).toBeUndefined()
    const stale: JarvisTaskBoard = { ...planned(), items: planned().items.map(i => ({ ...i, result: '撰寫中' })) }
    expect(closeResults(stale, false).items[0]?.result).toBeUndefined()
  })

  test("the model's own items and the mirrored lists are never due", () => {
    const own = finish(ok(applyTask(EMPTY_BOARD, { op: 'add', item: '自己的', subtasks: ['a'] })), '1.1')
    expect(own.items[0]?.resultDue).toBeUndefined()
    expect(requestsEnding(own, 't1')).toEqual([])
  })

  test('the result ask carries the subtask titles, cut to SUMMARY_INPUT_MAX', () => {
    const r = resultAsk('做一件大事', '都做完了', ['調查', '實作'])
    expect(r).toContain('細項：\n- 調查\n- 實作')
    expect(r).toContain('回答：\n都做完了')
    expect(resultAsk('q', 'a', ['x'.repeat(SUMMARY_INPUT_MAX + 500)])).not.toContain('x'.repeat(SUMMARY_INPUT_MAX))
    expect(resultAsk('q', 'a')).not.toContain('細項')
  })
})

describe('results of work over many turns wired', () => {
  const ends = ($: Engine, turnId: string, answer: string, reason = 'answer') =>
    $.turn.complete({ answer, durationMs: 1, isAborted: reason === 'aborted', turnId, reason } as never)
  const results = (asked: Asked[]) => asked.filter(a => a.prompt.includes('回答：'))
  // Haiku: titles 做大事; a result 已合併進 master for an answer saying 全部完成, after `wait` ms
  const haiku = (asked: Asked[], sleep: (ms: number) => Promise<void>, wait = 0) => async (e: Asked) => {
    asked.push(e)
    if (!e.prompt.includes('回答：')) return said('做大事')
    if (wait > 0) await sleep(wait)
    return said(e.prompt.includes('全部完成') ? '已合併進 master' : '撰寫中')
  }

  test('no interim result; the turn where the last subtask completes gets it, from prompt, subtasks and answer', async ($, on) => {
    const asked: Asked[] = []
    const { clock } = world(on, {}, e => haiku(asked, ms => clock.sleep(ms))(e))
    await send($, '請把功能做完並合併')
    await turnStarts($, 't1', '請把功能做完並合併')
    await task($, { op: 'add', subtasks: ['寫 spec', '實作'] })
    await task($, { op: 'update', id: '1.1', status: 'completed' })
    await ends($, 't1', '先寫好 spec，接著實作')
    await clock.settle()
    expect(results(asked)).toHaveLength(0)
    expect(await boardOf($)).not.toContain('→')
    await turnStarts($, 't2', '')
    await task($, { op: 'update', id: '1.2', status: 'completed' })
    await ends($, 't2', '全部完成，已合併')
    await clock.settle()
    expect(results(asked)).toHaveLength(1)
    const p = results(asked)[0]?.prompt ?? ''
    expect(p).toContain('請把功能做完並合併')
    expect(p).toContain('- 寫 spec\n- 實作')
    expect(p).toContain('回答：\n全部完成，已合併')
    expect(await boardOf($)).toContain('[x] 1 做大事 → 已合併進 master')
    // one result per completion: a later turn asks nothing more
    await turnStarts($, 't3', '')
    await ends($, 't3', '全部完成')
    await clock.settle()
    expect(results(asked)).toHaveLength(1)
  })

  test('reopening clears the result until the plan completes again', async ($, on) => {
    const asked: Asked[] = []
    const { clock } = world(on, {}, e => haiku(asked, ms => clock.sleep(ms))(e))
    await send($, '做功能')
    await turnStarts($, 't1', '做功能')
    await task($, { op: 'add', subtasks: ['實作'] })
    await task($, { op: 'update', id: '1.1', status: 'completed' })
    await ends($, 't1', '全部完成')
    await clock.settle()
    expect(await boardOf($)).toContain('→ 已合併進 master')
    await turnStarts($, 't2', '')
    await task($, { op: 'add', to: '1', subtasks: ['補測試'] })
    expect(await boardOf($)).not.toContain('→')
    await ends($, 't2', '補測試中')
    await clock.settle()
    expect(results(asked)).toHaveLength(1)
    expect(await boardOf($)).not.toContain('→')
    await turnStarts($, 't3', '')
    await task($, { op: 'update', id: '1.2', status: 'completed' })
    await ends($, 't3', '全部完成')
    await clock.settle()
    expect(results(asked)).toHaveLength(2)
    expect(results(asked)[1]?.prompt).toContain('做功能')
    expect(await boardOf($)).toContain('→ 已合併進 master')
  })

  test('a completion in an aborted turn waits for the next answered turn', async ($, on) => {
    const asked: Asked[] = []
    const { clock } = world(on, {}, e => haiku(asked, ms => clock.sleep(ms))(e))
    await send($, '做功能')
    await turnStarts($, 't1', '做功能')
    await task($, { op: 'add', subtasks: ['實作'] })
    await ends($, 't1', '開始實作')
    await turnStarts($, 't2', '')
    await task($, { op: 'update', id: '1.1', status: 'completed' })
    await ends($, 't2', '全部完成', 'aborted')
    await clock.settle()
    expect(results(asked)).toHaveLength(0)
    await turnStarts($, 't3', '')
    await ends($, 't3', '全部完成')
    await clock.settle()
    expect(results(asked)).toHaveLength(1)
    expect(await boardOf($)).toContain('→ 已合併進 master')
  })

  test('a completion result that comes back after /clear is dropped', async ($, on) => {
    const asked: Asked[] = []
    const { clock } = world(on, {}, e => haiku(asked, ms => clock.sleep(ms), 5000)(e))
    await send($, '做功能')
    await turnStarts($, 't1', '做功能')
    await task($, { op: 'add', subtasks: ['實作'] })
    await ends($, 't1', '開始實作')
    await turnStarts($, 't2', '')
    await task($, { op: 'update', id: '1.1', status: 'completed' })
    await ends($, 't2', '全部完成')
    await clock.settle()
    expect(results(asked)).toHaveLength(1)
    await $.classic.SessionStart({ source: 'clear' } as never)
    await send($, '做功能')
    // the new item 1 has no plan: only its rid keeps the old result off it
    await turnStarts($, 't3', '做功能')
    await clock.advance(5000)
    const text = await boardOf($)
    expect(text).toContain('1 做大事')
    expect(text).not.toContain('→')
  })
})

describe('requests that did nothing', () => {
  test('itemWorked: a request that called a tool or holds a plan', () => {
    const b = startTurn(openRequest(EMPTY_BOARD, 'A').board, 't1', 'A')
    const item = b.items[0]!
    expect(itemWorked(item)).toBe(false)
    expect(itemWorked({ ...item, worked: true })).toBe(true)
    expect(itemWorked(ok(applyTask(b, { op: 'add', subtasks: ['s1'] })).items[0]!)).toBe(true)
  })

  test("markWorked marks the request the running turn runs; not one waiting, typed over it, or the model's own", () => {
    let b = openRequest(EMPTY_BOARD, 'W').board
    expect(markWorked(b)).toBe(b)
    b = startTurn(b, 't1', 'W')
    b = openRequest(b, 'Q', 't1').board
    b = ok(applyTask(b, { op: 'add', item: '模型自己的' }))
    const marked = markWorked(b)
    expect(marked.items.map(i => [i.title, i.worked])).toEqual([
      ['W', true],
      ['Q', undefined],
      ['模型自己的', undefined],
    ])
    expect(markWorked(marked)).toBe(marked)
  })

  test("dropIdle takes off the turn's requests that did nothing; keeps worked, planned, typed-over, other turns' and the model's", () => {
    let b = openRequest(EMPTY_BOARD, 'idle').board
    b = openRequest(b, 'did').board
    b = openRequest(b, 'plan').board
    b = startTurn(b, 't1', 'idle')
    b = { ...b, items: b.items.map(i => (i.title === 'did' ? { ...i, worked: true as const } : i)) }
    b = ok(applyTask(b, { op: 'add', to: '3', subtasks: ['s'] }))
    b = openRequest(b, 'typed', 't1').board
    b = ok(applyTask(b, { op: 'add', item: '模型自己的' }))
    b = openRequest(b, 'later').board
    const after = dropIdle(b, 't1')
    expect(after.items.map(i => i.title)).toEqual(['did', 'plan', 'typed', '模型自己的', 'later'])
    expect(dropIdle(after, 't1')).toBe(after)
    expect(dropIdle(b, 't9')).toBe(b)
  })

  test('the prompt and the note tell the model a request that did nothing is taken off', () => {
    expect(TASK_PROMPT).toContain('自動移除')
    expect(requestContext('7')).toContain('自動移除')
  })
})

describe('requests that did nothing wired', () => {
  test('a question answered with no tool call leaves the board', async ($, on) => {
    world(on)
    await send($, 'CAS 是什麼')
    await turnStarts($, 't1', 'CAS 是什麼')
    expect(await boardOf($)).toContain('[>] 1 CAS 是什麼（本輪請求）')
    await turnEnds($, 't1')
    expect(await boardOf($)).toBe('任務看板是空的。')
  })

  test("a main-loop tool call keeps the request; the board's own tool does not count", async ($, on) => {
    world(on)
    await send($, '改標題就好')
    await turnStarts($, 't1', '改標題就好')
    await task($, { op: 'update', id: '1', title: '只改標題' })
    await task($, { op: 'update', id: '1', status: 'in_progress' })
    await turnEnds($, 't1')
    expect(await boardOf($)).toBe('任務看板是空的。')
    await send($, '讀檔')
    await turnStarts($, 't2', '讀檔')
    await work($)
    await turnEnds($, 't2')
    expect(await boardOf($)).toContain('[x] 2 讀檔')
  })

  test('only the first main-loop tool call of a turn writes the board', async ($, on) => {
    world(on)
    const writes = { n: 0 }
    on('state.set', { plugin: 'jarvis', key: 'tasks' }, async (_$, e, next) => {
      writes.n += 1
      return next(e)
    })
    await send($, '讀兩個檔')
    await turnStarts($, 't1', '讀兩個檔')
    const before = writes.n
    await work($)
    await work($)
    expect(writes.n - before).toBe(1)
  })

  test("a plan keeps the request; an Agent call keeps it; a subagent's own calls do not", async ($, on) => {
    world(on)
    await send($, '計畫')
    await turnStarts($, 't1', '計畫')
    await task($, { op: 'add', subtasks: ['s1'] })
    await turnEnds($, 't1')
    expect(await boardOf($)).toContain('1 計畫')
    await send($, '派人')
    await turnStarts($, 't2', '派人')
    await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'worker' } as never)
    await turnEnds($, 't2')
    expect(await boardOf($)).toContain('[x] 2 派人')
    await send($, '問一下')
    await turnStarts($, 't3', '問一下')
    await $.tool.call({ tool: 'Read', file_path: '/tmp/a.md', agentId: 'agent-7' } as never)
    await turnEnds($, 't3')
    expect(await boardOf($)).not.toContain('問一下')
  })

  test('an interrupted question leaves the board; an interrupted request that did something waits in 預計', async ($, on) => {
    world(on)
    await send($, 'A')
    await turnStarts($, 't1', 'A')
    await turnEnds($, 't1', 'aborted')
    expect(await boardOf($)).toBe('任務看板是空的。')
    await send($, 'B')
    await turnStarts($, 't2', 'B')
    await work($)
    await turnEnds($, 't2', 'aborted')
    expect(await boardOf($)).toContain('[ ] 2 B')
  })

  test('a prompt typed over a turn stays when that turn ends; its own turn decides', async ($, on) => {
    world(on)
    await send($, 'A')
    await turnStarts($, 't1', 'A')
    await work($)
    await send($, 'B', { turnId: 't1' })
    await turnEnds($, 't1')
    let text = await boardOf($)
    expect(text).toContain('[x] 1 A')
    expect(text).toContain('[x] 2 B')
    await turnStarts($, 't2', 'B')
    await turnEnds($, 't2')
    text = await boardOf($)
    expect(text).toContain('[x] 1 A')
    expect(text).not.toContain('2 B')
  })

  test('a request that did nothing gets no result; its late title summary writes nothing', async ($, on) => {
    const asked: Asked[] = []
    const { clock } = world(on, {}, async e => {
      asked.push(e)
      await clock.sleep(1000)
      return said('解釋 CAS')
    })
    await send($, 'CAS 是什麼')
    await turnStarts($, 't1', 'CAS 是什麼')
    await $.turn.complete({ answer: '比較後交換', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.advance(1000)
    await clock.settle()
    expect(asked).toHaveLength(1)
    expect(await boardOf($)).toBe('任務看板是空的。')
  })
})
