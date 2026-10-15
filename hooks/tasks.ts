import type { JarvisSubtask, JarvisTaskBoard, JarvisTaskItem, JarvisTaskStatus } from '../types'

// The tool the model keeps the board with: its short name as registered, and the name the
// model calls it by.
export const TASK_TOOL_NAME = 'task'
export const TASK_TOOL = 'mcp__jarvis__task'
// the system prompt section that tells the model to keep the board
export const TASK_SECTION_ID = 'jarvis:tasks'

export const EMPTY_BOARD: JarvisTaskBoard = { items: [], nextItem: 1 }

export const MAX_ITEMS = 50
export const MAX_SUBTASKS = 50
// a title is kept to this many characters
export const TITLE_MAX = 120

export const TASK_STATUSES: readonly JarvisTaskStatus[] = ['pending', 'in_progress', 'completed']

const OPS = ['add', 'update', 'remove', 'list'] as const

export const TASK_PROMPT = [
  '# 任務看板',
  '使用者在 jarvis 面板的「任務」分頁看這個 session 正在做、預計要做、做完的事。jarvis 會把使用者送出的每個請求自動記成一個進行中的項目，回覆結束時自動標完成；你用 mcp__jarvis__task 補上計畫。',
  '- 多步工作（三步以上，或會派 subagent）開始前，用 add 列出細項：只帶 subtasks 會掛到本輪請求；帶 item 時，本輪請求還沒有細項就直接併入它（標題換成 item），不會多一個項目。',
  '- 開始做一個細項時標 in_progress，做完立刻標 completed，不要留到最後一起標。',
  '- 請求項目的標題取自使用者原文；原文看不出在做什麼（例如「1」「好」）時，用 update 帶 title 改成一句精簡標題。',
  '- 之後要做、這輪不做的事：用 add 只帶 item（不帶 subtasks），記成預計項目。',
  '- 計畫變了就 add 新細項，或 remove 用不到的。',
  '- 派 subagent 做某個細項後，用 update 帶 agent（Agent 工具回傳的 agentId）。',
  '- 你是 subagent 時，只 update 交給你的細項，不新增工作項目。',
  '- 一問一答不用拆細項。',
].join('\n')

export const TASK_TOOL_SPEC = {
  name: TASK_TOOL_NAME,
  description: [
    '維護本 session 的任務看板（jarvis 面板「任務」分頁）。兩層：工作項目（id 如 "2"）→ 細項（id 如 "2.3"）。',
    'op=add：item 建新項目，可同時帶 subtasks；或 to=既有項目 id，把 subtasks 加進去；不帶 item 和 to、只帶 subtasks 時，掛到本輪請求項目。帶 item 和 subtasks、本輪請求項目還沒有細項時，併入本輪請求項目（標題換成 item）。只帶 item 是預計項目。',
    'op=update：id 指項目或細項，帶 status（pending／in_progress／completed）、title 或 agent（負責這個細項的 subagent 的 agentId）。有細項的項目狀態由細項推出，把它標 completed 會把細項全部標 completed。',
    'op=remove：刪除 id 指的項目或細項。',
    'op=list：回傳整張看板。',
    '每次成功都回傳更新後的看板。',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: [...OPS] },
      item: { type: 'string', description: 'add：新工作項目的標題' },
      to: { type: 'string', description: 'add：要加細項的既有項目 id' },
      subtasks: { type: 'array', items: { type: 'string' }, description: 'add：細項標題，依執行順序' },
      id: { type: 'string', description: 'update／remove：項目 id（"2"）或細項 id（"2.3"）' },
      status: { type: 'string', enum: [...TASK_STATUSES] },
      title: { type: 'string', description: 'update：新標題' },
      agent: { type: 'string', description: 'update：負責這個細項的 subagent 的 agentId' },
    },
    required: ['op'],
  },
  isDeferred: false,
} as const

export type TaskReply = { board: JarvisTaskBoard; text: string } | { error: string }

const ITEM_ID = /^\d+$/
const SUB_ID = /^(\d+)\.\d+$/

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

// whitespace runs (newline, tab) collapse to one space so a title is always one line
export const titleOf = (v: unknown): string => [...str(v).replace(/\s+/g, ' ').trim()].slice(0, TITLE_MAX).join('')

export const isStatus = (v: unknown): v is JarvisTaskStatus =>
  typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v)

export const replaceItem = (board: JarvisTaskBoard, item: JarvisTaskItem): JarvisTaskBoard => ({
  ...board,
  items: board.items.map(i => (i.id === item.id ? item : i)),
})

// A new item last on the board, numbered from `nextItem`; every way of making an item goes
// through here. `extra` carries what the caller knows of it (status, origin, a request's key and turn). The caps are
// the caller's to enforce: `add` and the mirrors check MAX_ITEMS and MAX_SUBTASKS themselves.
export function putItem(
  board: JarvisTaskBoard,
  title: string,
  subtasks: readonly string[],
  actor: string | undefined,
  extra: Partial<Pick<JarvisTaskItem, 'status' | 'origin' | 'key' | 'turnId' | 'queued'>> = {},
): JarvisTaskBoard {
  const item = withSubtasks({ id: String(board.nextItem), title, status: 'pending', subtasks: [], nextSub: 1, ...extra }, subtasks, actor)
  return { items: [...board.items, item], nextItem: board.nextItem + 1 }
}

// The item and subtask a subtask id names, if both exist.
export function findSub(board: JarvisTaskBoard, id: string): { item: JarvisTaskItem; sub: JarvisSubtask } | undefined {
  const m = SUB_ID.exec(id)
  const item = m ? board.items.find(i => i.id === m[1]) : undefined
  const sub = item?.subtasks.find(s => s.id === id)
  return item && sub ? { item, sub } : undefined
}

const notFound = (id: string): string => `找不到 ${id}：id 是項目（如 "2"）或細項（如 "2.3"）`

// An item's subtasks with `titles` added after the last; a subagent's own are marked its.
function withSubtasks(item: JarvisTaskItem, titles: readonly string[], actor: string | undefined): JarvisTaskItem {
  const subs = titles.map(
    (title, k): JarvisSubtask => ({
      id: `${item.id}.${item.nextSub + k}`,
      title,
      status: 'pending',
      ...(actor === undefined ? {} : { agentId: actor }),
    }),
  )
  return { ...item, subtasks: [...item.subtasks, ...subs], nextSub: item.nextSub + titles.length }
}

function add(board: JarvisTaskBoard, input: Readonly<Record<string, unknown>>, actor: string | undefined): JarvisTaskBoard | string {
  const raw = input['subtasks']
  const titles = Array.isArray(raw) ? raw.map(titleOf).filter(t => t !== '') : []
  const to = str(input['to'])
  if (to !== '') {
    const item = board.items.find(i => i.id === to)
    if (!item) return `找不到項目 ${to}`
    if (titles.length === 0) return 'add 帶 to 時，subtasks 至少要有一個細項'
    if (item.subtasks.length + titles.length > MAX_SUBTASKS) return `一個項目最多 ${MAX_SUBTASKS} 個細項`
    return replaceItem(board, withSubtasks(item, titles, actor))
  }
  const title = titleOf(input['item'])
  // the request being worked on, which the main loop's plans hang on; a subagent's never do
  const current = actor === undefined ? currentRequest(board) : undefined
  if (title === '') {
    if (!current || titles.length === 0) return 'add 要帶 item（新項目標題）或 to（既有項目 id）'
    if (current.subtasks.length + titles.length > MAX_SUBTASKS) return `一個項目最多 ${MAX_SUBTASKS} 個細項`
    return replaceItem(board, withSubtasks(current, titles, actor))
  }
  if (titles.length > MAX_SUBTASKS) return `一個項目最多 ${MAX_SUBTASKS} 個細項`
  // a plan for the request being worked on folds into its item rather than standing beside it
  if (current && current.subtasks.length === 0 && titles.length > 0) {
    return replaceItem(board, withSubtasks({ ...current, title }, titles, actor))
  }
  const roomy = makeRoom(board)
  if (roomy.items.length >= MAX_ITEMS) return `看板最多 ${MAX_ITEMS} 個項目，先 remove 用不到的項目`
  return putItem(roomy, title, titles, actor)
}

function update(board: JarvisTaskBoard, input: Readonly<Record<string, unknown>>, actor: string | undefined): JarvisTaskBoard | string {
  const id = str(input['id'])
  const status = input['status']
  if (status !== undefined && !isStatus(status)) return 'status 只能是 pending、in_progress、completed'
  const title = input['title'] === undefined ? undefined : titleOf(input['title'])
  if (title === '') return 'title 不能是空的'
  const agent = str(input['agent'])
  if (ITEM_ID.test(id)) {
    const item = board.items.find(i => i.id === id)
    if (!item) return `找不到項目 ${id}`
    if (status === undefined && title === undefined) return 'update 項目要帶 status 或 title'
    const hasSubs = item.subtasks.length > 0
    if (status !== undefined && hasSubs && status !== 'completed') return `項目 ${id} 有細項，狀態由細項決定；請 update 細項`
    return replaceItem(board, {
      ...item,
      ...(title === undefined ? {} : { title }),
      ...(status === undefined
        ? {}
        : hasSubs
          ? { subtasks: item.subtasks.map(s => ({ ...s, status: 'completed' as const })) }
          : { status }),
    })
  }
  const found = findSub(board, id)
  if (!found) return notFound(id)
  const { item, sub } = found
  if (status === undefined && title === undefined && agent === '') return 'update 細項要帶 status、title 或 agent'
  const owner = agent !== '' ? agent : (actor ?? sub.agentId)
  const next: JarvisSubtask = {
    ...sub,
    ...(title === undefined ? {} : { title }),
    ...(status === undefined ? {} : { status }),
    ...(owner === undefined ? {} : { agentId: owner }),
  }
  return replaceItem(board, { ...item, subtasks: item.subtasks.map(s => (s.id === id ? next : s)) })
}

function remove(board: JarvisTaskBoard, input: Readonly<Record<string, unknown>>): JarvisTaskBoard | string {
  const id = str(input['id'])
  if (ITEM_ID.test(id)) {
    if (!board.items.some(i => i.id === id)) return `找不到項目 ${id}`
    return { ...board, items: board.items.filter(i => i.id !== id) }
  }
  const found = findSub(board, id)
  if (!found) return notFound(id)
  return replaceItem(board, { ...found.item, subtasks: found.item.subtasks.filter(s => s.id !== id) })
}

// One call of the board's tool: the board it leaves and the text the model reads, or why
// it was refused. `actor` is the subagent that called it; absent for the main loop.
export function applyTask(board: JarvisTaskBoard, input: Readonly<Record<string, unknown>>, actor?: string): TaskReply {
  const op = input['op']
  const next =
    op === 'list'
      ? board
      : op === 'add'
        ? add(board, input, actor)
        : op === 'update'
          ? update(board, input, actor)
          : op === 'remove'
            ? remove(board, input)
            : `op 只能是 ${OPS.join('、')}`
  return typeof next === 'string' ? { error: next } : { board: next, text: boardText(next) }
}

// An item with subtasks is done when all are, running when any is, else waiting; one
// without has its own status.
export function itemStatus(item: JarvisTaskItem): JarvisTaskStatus {
  const subs = item.subtasks
  if (subs.length === 0) return item.status
  if (subs.every(s => s.status === 'completed')) return 'completed'
  if (subs.some(s => s.status === 'in_progress')) return 'in_progress'
  return 'pending'
}

export type BoardSections = { running: JarvisTaskItem[]; planned: JarvisTaskItem[]; done: JarvisTaskItem[] }

// The board in the page's three parts: running and planned in the order added, done newest
// first so the latest work reads first.
export function boardSections(board: JarvisTaskBoard): BoardSections {
  const inStatus = (s: JarvisTaskStatus) => board.items.filter(i => itemStatus(i) === s)
  return { running: inStatus('in_progress'), planned: inStatus('pending'), done: inStatus('completed').reverse() }
}

export type BoardCounts = { items: number; itemsDone: number; subtasks: number; subtasksDone: number }

export function boardCounts(board: JarvisTaskBoard): BoardCounts {
  const subs = board.items.flatMap(i => i.subtasks)
  return {
    items: board.items.length,
    itemsDone: board.items.filter(i => itemStatus(i) === 'completed').length,
    subtasks: subs.length,
    subtasksDone: subs.filter(s => s.status === 'completed').length,
  }
}

export const countsText = (c: BoardCounts): string => `${c.itemsDone}/${c.items} 項目 · 細項 ${c.subtasksDone}/${c.subtasks}`

const MARK: Record<JarvisTaskStatus, string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]' }

// The board as the model reads it, in the order added so the ids read in order; the request
// being worked on is marked.
export function boardText(board: JarvisTaskBoard): string {
  if (board.items.length === 0) return '任務看板是空的。'
  const current = currentRequest(board)
  const lines = [`任務看板（${countsText(boardCounts(board))}）`]
  for (const item of board.items) {
    lines.push(`${MARK[itemStatus(item)]} ${item.id} ${item.title}${item === current ? '（本輪請求）' : ''}`)
    for (const s of item.subtasks) {
      lines.push(`  ${MARK[s.status]} ${s.id} ${s.title}${s.agentId === undefined ? '' : ` (agent ${s.agentId})`}`)
    }
  }
  return lines.join('\n')
}

// ---- the person's requests, recorded as they are sent ----

// the origin of an item jarvis made for a request the person sent
export const REQUEST_ORIGIN = 'request'
// a request item's title, taken from its prompt, is kept to this many characters
export const REQUEST_TITLE_MAX = 40

// A prompt's first non-blank line as one line, cut to REQUEST_TITLE_MAX with an ellipsis.
export function requestTitle(text: string): string {
  const line =
    text
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .find(l => l !== '') ?? ''
  const chars = [...line]
  return chars.length > REQUEST_TITLE_MAX ? `${chars.slice(0, REQUEST_TITLE_MAX - 1).join('')}…` : line
}

// what of a prompt.submit decides whether it is recorded
export type RequestSubmission = { text: string; command?: unknown; isMeta?: true; origin: { kind: string } }

// The person's own prompts, typed or through Remote Control; not a slash command, not one
// the person does not see, not a notification, a peer's message or a plugin's.
export function recordsRequest(e: RequestSubmission): boolean {
  return (
    e.command === undefined &&
    e.isMeta !== true &&
    (e.origin.kind === 'composer' || e.origin.kind === 'bridge') &&
    requestTitle(e.text) !== ''
  )
}

const isRequest = (item: JarvisTaskItem): boolean => item.origin === REQUEST_ORIGIN

// The board with room for one more item: at MAX_ITEMS its oldest done item goes; unchanged
// when there is room or nothing is done.
export function makeRoom(board: JarvisTaskBoard): JarvisTaskBoard {
  if (board.items.length < MAX_ITEMS) return board
  const oldest = board.items.find(i => itemStatus(i) === 'completed')
  return oldest ? { ...board, items: board.items.filter(i => i !== oldest) } : board
}

// A request item for a prompt just sent, running from the start. One typed while a turn ran
// (`runningTurn`) is tied to that turn and marked queued; any other waits for the next
// main-loop turn. Nothing is made for a blank prompt or a board full of unfinished items.
export function openRequest(board: JarvisTaskBoard, text: string, runningTurn?: string): { board: JarvisTaskBoard; id?: string } {
  const key = requestTitle(text)
  const roomy = makeRoom(board)
  if (key === '' || roomy.items.length >= MAX_ITEMS) return { board }
  return {
    board: putItem(roomy, key, [], undefined, {
      status: 'in_progress',
      origin: REQUEST_ORIGIN,
      key,
      ...(runningTurn === undefined ? {} : { turnId: runningTurn, queued: true as const }),
    }),
    id: String(roomy.nextItem),
  }
}

// A main-loop turn starts: request items waiting for a turn are tied to it. With none
// waiting, a queued request whose prompt this turn begins with (the turn before closed it)
// runs again, tied to this turn.
export function startTurn(board: JarvisTaskBoard, turnId: string, text: string): JarvisTaskBoard {
  const waiting = board.items.filter(i => isRequest(i) && i.status === 'in_progress' && i.turnId === undefined)
  if (waiting.length > 0) return { ...board, items: board.items.map(i => (waiting.includes(i) ? { ...i, turnId } : i)) }
  const key = requestTitle(text)
  const queued = key === '' ? undefined : board.items.findLast(i => isRequest(i) && i.queued === true && i.key === key)
  if (!queued) return board
  const { queued: _q, ...rest } = queued
  return replaceItem(board, { ...rest, status: 'in_progress', turnId })
}

// A main-loop turn ends: its request items let go of it; a running one is done when the
// turn answered or refused, and waits again (pending) when it was interrupted or died on an
// error. Every other item is left as it is.
export function endTurn(board: JarvisTaskBoard, turnId: string, reason: string): JarvisTaskBoard {
  const ends = (i: JarvisTaskItem) => isRequest(i) && i.turnId === turnId
  if (!board.items.some(ends)) return board
  const status: JarvisTaskStatus = reason === 'aborted' || reason === 'error' ? 'pending' : 'completed'
  return {
    ...board,
    items: board.items.map(i => {
      if (!ends(i)) return i
      const { turnId: _t, ...rest } = i
      return { ...rest, status: i.status === 'in_progress' ? status : i.status }
    }),
  }
}

// The request being worked on: the newest request item running by its own status.
export function currentRequest(board: JarvisTaskBoard): JarvisTaskItem | undefined {
  return board.items.findLast(i => isRequest(i) && i.status === 'in_progress')
}

// The note beside each recorded prompt: which item it is, and what the model may do with it.
export const requestContext = (id: string): string =>
  `jarvis 任務看板：這個請求已記成項目 ${id}，回覆結束時自動標完成。多步工作用 mcp__jarvis__task add 只帶 subtasks，把細項掛到這個項目；原文看不出在做什麼時，用 update id=${id} 帶 title 改成一句精簡標題。`

// ---- the built-in task tools, mirrored when the session has them ----

export const TODO_TITLE = 'TodoWrite'
export const TASKS_ORIGIN = 'tasks'
export const TASKS_TITLE = '內建任務'

// TodoWrite's whole list, one item per actor: each call replaces its subtasks (numbered
// again from .1); an empty list removes the item.
export function fromTodos(board: JarvisTaskBoard, todos: unknown, actor?: string): JarvisTaskBoard {
  if (!Array.isArray(todos)) return board
  const origin = `todo:${actor ?? 'main'}`
  const rows = todos
    .flatMap(t => {
      const o = (typeof t === 'object' && t !== null ? t : {}) as Record<string, unknown>
      const title = titleOf(o['content'])
      const status: JarvisTaskStatus = isStatus(o['status']) ? o['status'] : 'pending'
      return title === '' ? [] : [{ title, status }]
    })
    .slice(0, MAX_SUBTASKS)
  const old = board.items.find(i => i.origin === origin)
  if (rows.length === 0) return old ? { ...board, items: board.items.filter(i => i !== old) } : board
  if (!old && board.items.length >= MAX_ITEMS) return board
  const titles = rows.map(r => r.title)
  const made = old
    ? replaceItem(board, withSubtasks({ ...old, subtasks: [], nextSub: 1 }, titles, actor))
    : putItem(board, TODO_TITLE, titles, actor, { origin })
  return {
    ...made,
    items: made.items.map(i =>
      i.origin === origin ? { ...i, subtasks: i.subtasks.map((s, k) => ({ ...s, status: rows[k]?.status ?? s.status })) } : i,
    ),
  }
}

// TaskCreate's task as a subtask of the 內建任務 item, once per task id.
export function fromTaskCreate(board: JarvisTaskBoard, extId: unknown, subject: unknown, actor?: string): JarvisTaskBoard {
  const id = typeof extId === 'string' ? extId : ''
  const title = titleOf(subject)
  if (id === '' || title === '') return board
  const old = board.items.find(i => i.origin === TASKS_ORIGIN)
  if (old ? old.subtasks.some(s => s.extId === id) || old.subtasks.length >= MAX_SUBTASKS : board.items.length >= MAX_ITEMS) return board
  const made = old
    ? replaceItem(board, withSubtasks(old, [title], actor))
    : putItem(board, TASKS_TITLE, [title], actor, { origin: TASKS_ORIGIN })
  return {
    ...made,
    items: made.items.map(i =>
      i.origin === TASKS_ORIGIN ? { ...i, subtasks: i.subtasks.map((s, k, all) => (k === all.length - 1 ? { ...s, extId: id } : s)) } : i,
    ),
  }
}

// TaskUpdate on a mirrored task: its status and subject; `deleted` removes it.
export function fromTaskUpdate(board: JarvisTaskBoard, input: Readonly<Record<string, unknown>>): JarvisTaskBoard {
  const taskId = input['taskId']
  if (typeof taskId !== 'string' || taskId === '') return board
  const item = board.items.find(i => i.origin === TASKS_ORIGIN)
  const sub = item?.subtasks.find(s => s.extId === taskId)
  if (!item || !sub) return board
  const status = input['status']
  if (status === 'deleted') return replaceItem(board, { ...item, subtasks: item.subtasks.filter(s => s !== sub) })
  const title = titleOf(input['subject'])
  const next: JarvisSubtask = { ...sub, ...(isStatus(status) ? { status } : {}), ...(title === '' ? {} : { title }) }
  return replaceItem(board, { ...item, subtasks: item.subtasks.map(s => (s === sub ? next : s)) })
}
