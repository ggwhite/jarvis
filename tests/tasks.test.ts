import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { JarvisTaskBoard, JarvisTaskItem } from '../types'
import {
  EMPTY_BOARD,
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
  boardText,
  countsText,
  currentRequest,
  endTurn,
  fromTaskCreate,
  fromTaskUpdate,
  fromTodos,
  itemStatus,
  makeRoom,
  openRequest,
  putItem,
  recordsRequest,
  requestContext,
  requestTitle,
  boardSections,
  startTurn,
} from '../hooks/tasks'
import type { Seg } from '../hooks/cockpit'
import { TASK_ICON } from '../hooks/icons'
import { THEME, cellWidth, padCells } from '../hooks/jarvis'
import type { TaskReply } from '../hooks/tasks'
import { EMPTY_TEXT, SUB_INDENT, taskRows } from '../hooks/tasksView'

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
  test('an item with subtasks: all done is done, any running is running, else pending', () => {
    const b = build(
      { op: 'add', item: 'A', subtasks: ['a1', 'a2'] },
      { op: 'update', id: '1.1', status: 'completed' },
    )
    const item = b.items[0]
    if (!item) throw new Error('no item')
    expect(itemStatus(item)).toBe('pending')
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
    expect(s.running.map(i => i.title)).toEqual(['C', 'E'])
    expect(s.planned.map(i => i.title)).toEqual(['A', 'D'])
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
    expect(rows[1]?.startsWith(`${TASK_ICON.in_progress} A`)).toBe(true)
    expect(rows[1]?.endsWith(' 0/2')).toBe(true)
    expect(rows[2]?.startsWith(`${' '.repeat(SUB_INDENT)}${TASK_ICON.in_progress} a1`)).toBe(true)
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
    expect(rows[1]?.[0]).toEqual({ t: `${TASK_ICON.in_progress} `, color: THEME.accent })
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

// the test-side bottom of the chain, standing for the engine
const TASK_CREATE_ID = '7'
const world = (on: On, outcome: Record<string, unknown> = {}) => {
  const registered: { name: string; isDeferred?: boolean }[] = []
  mock.clock(on, { now: 0 })
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
    e.text === '丟掉' ? { drop: 'no' } : { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) },
  )
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async (_$, e) =>
    'deny' in outcome
      ? (outcome as never)
      : {
          result: (e.tool === 'TaskCreate' ? { task: { id: TASK_CREATE_ID, subject: 's' } } : {}) as never,
          ...outcome,
        },
  )
  return { registered }
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

const openTasks = async ($: Engine, rows = 30, cols = 80) => {
  const ui = await $.ui.mount({
    plugin: 'jarvis',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'jarvis',
    props: paneProps(rows, cols),
    viewport: { columns: cols + 20, rows: rows + 10 },
  })
  await ui.press({ key: 'tab-tasks' })
  await ui.unmount()
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
    await turnStarts($, 't1', 'A')
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
    expect(text).toContain('[x] 2 好')
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
    expect(lines.find(l => l.includes('加看板'))?.trimEnd().endsWith('1/2')).toBe(true)
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

  test('a /clear empties the page', async ($, on) => {
    world(on)
    await task($, { op: 'add', item: 'A' })
    await openTasks($)
    await $.classic.SessionStart({ source: 'clear' } as never)
    expect(linesOf(await draw($)).some(l => l.includes(EMPTY_TEXT))).toBe(true)
  })
})
