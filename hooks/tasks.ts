import type { JarvisSubtask, JarvisTaskBoard, JarvisTaskItem, JarvisTaskStatus, JarvisTopic } from '../types'
import { localized, t } from './i18n'

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
// how long a just-completed item or subtask stays lit
export const FRESH_MS = 1500

export const TASK_STATUSES: readonly JarvisTaskStatus[] = ['pending', 'in_progress', 'completed']

const OPS = ['add', 'update', 'remove', 'list'] as const

const taskPrompt = (): string =>
  [
    t('prompt.head'),
    t('prompt.intro'),
    t('prompt.plan'),
    t('prompt.mark'),
    t('prompt.title'),
    t('prompt.later'),
    t('prompt.change'),
    t('prompt.agent'),
    t('prompt.subagent'),
    t('prompt.single'),
  ].join('\n')

const taskToolSpec = () =>
  ({
    name: TASK_TOOL_NAME,
    description: [t('tool.intro'), t('tool.add'), t('tool.update'), t('tool.remove'), t('tool.list'), t('tool.reply')].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: [...OPS] },
        item: { type: 'string', description: t('tool.item') },
        to: { type: 'string', description: t('tool.to') },
        subtasks: { type: 'array', items: { type: 'string' }, description: t('tool.subtasks') },
        id: { type: 'string', description: t('tool.id') },
        status: { type: 'string', enum: [...TASK_STATUSES] },
        title: { type: 'string', description: t('tool.title') },
        agent: { type: 'string', description: t('tool.agent') },
      },
      required: ['op'],
    },
    isDeferred: false,
  }) as const

// the board's instructions and its tool, in the current locale
export let TASK_PROMPT: string
export let TASK_TOOL_SPEC: ReturnType<typeof taskToolSpec>
localized(() => {
  TASK_PROMPT = taskPrompt()
  TASK_TOOL_SPEC = taskToolSpec()
})

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
  extra: Partial<Pick<JarvisTaskItem, 'status' | 'origin' | 'key' | 'turnId' | 'queued' | 'startedAt' | 'rid'>> = {},
): JarvisTaskBoard {
  const item = withSubtasks({ id: String(board.nextItem), title, status: 'pending', subtasks: [], nextSub: 1, ...extra }, subtasks, actor)
  return { ...board, items: [...board.items, item], nextItem: board.nextItem + 1 }
}

// The item and subtask a subtask id names, if both exist.
export function findSub(board: JarvisTaskBoard, id: string): { item: JarvisTaskItem; sub: JarvisSubtask } | undefined {
  const m = SUB_ID.exec(id)
  const item = m ? board.items.find(i => i.id === m[1]) : undefined
  const sub = item?.subtasks.find(s => s.id === id)
  return item && sub ? { item, sub } : undefined
}

type Timed = { status: JarvisTaskStatus; startedAt?: number; endedAt?: number }

// `x` moved to `status` at `now`: running starts its clock, completed stops it, pending
// clears both; the same status, or no clock, stamps nothing.
function stamped<T extends Timed>(x: T, status: JarvisTaskStatus, now: number | undefined): T {
  if (status === x.status || now === undefined) return { ...x, status }
  const { startedAt: _s, endedAt: _e, ...rest } = x
  if (status === 'in_progress') return { ...rest, status, startedAt: now } as T
  if (status === 'completed') return { ...rest, status, ...(x.startedAt === undefined ? {} : { startedAt: x.startedAt }), endedAt: now } as T
  return { ...rest, status } as T
}

const notFound = (id: string): string => t('board.notFound', { id })

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
    if (!item) return t('board.itemNotFound', { id: to })
    if (titles.length === 0) return t('board.toNeedsSubtasks')
    if (item.subtasks.length + titles.length > MAX_SUBTASKS) return t('board.maxSubtasks', { max: MAX_SUBTASKS })
    return replaceItem(board, withSubtasks(item, titles, actor))
  }
  const title = titleOf(input['item'])
  // the request being worked on, which the main loop's plans hang on; a subagent's never do
  const current = actor === undefined ? currentRequest(board) : undefined
  if (title === '') {
    if (!current || titles.length === 0) return t('board.addNeeds')
    if (current.subtasks.length + titles.length > MAX_SUBTASKS) return t('board.maxSubtasks', { max: MAX_SUBTASKS })
    return replaceItem(board, withSubtasks(current, titles, actor))
  }
  if (titles.length > MAX_SUBTASKS) return t('board.maxSubtasks', { max: MAX_SUBTASKS })
  // a plan for the request being worked on folds into its item rather than standing beside it
  if (current && current.subtasks.length === 0 && titles.length > 0) {
    return replaceItem(board, withSubtasks({ ...current, title, titleBy: 'model' }, titles, actor))
  }
  const roomy = makeRoom(board)
  if (roomy.items.length >= MAX_ITEMS) return t('board.maxItems', { max: MAX_ITEMS })
  return putItem(roomy, title, titles, actor)
}

function update(board: JarvisTaskBoard, input: Readonly<Record<string, unknown>>, actor: string | undefined, now: number | undefined): JarvisTaskBoard | string {
  const id = str(input['id'])
  const status = input['status']
  if (status !== undefined && !isStatus(status)) return t('board.badStatus')
  const title = input['title'] === undefined ? undefined : titleOf(input['title'])
  if (title === '') return t('board.emptyTitle')
  const agent = str(input['agent'])
  if (ITEM_ID.test(id)) {
    const item = board.items.find(i => i.id === id)
    if (!item) return t('board.itemNotFound', { id })
    if (status === undefined && title === undefined) return t('board.itemUpdateNeeds')
    const hasSubs = item.subtasks.length > 0
    if (status !== undefined && hasSubs && status !== 'completed') return t('board.itemHasSubtasks', { id })
    const titled: JarvisTaskItem = title === undefined ? item : { ...item, title, titleBy: 'model' }
    if (status === undefined) return replaceItem(board, titled)
    return replaceItem(
      board,
      hasSubs ? { ...titled, subtasks: item.subtasks.map(s => stamped(s, 'completed', now)) } : stamped(titled, status, now),
    )
  }
  const found = findSub(board, id)
  if (!found) return notFound(id)
  const { item, sub } = found
  if (status === undefined && title === undefined && agent === '') return t('board.subUpdateNeeds')
  const owner = agent !== '' ? agent : (actor ?? sub.agentId)
  const next: JarvisSubtask = {
    ...(status === undefined ? sub : stamped(sub, status, now)),
    ...(title === undefined ? {} : { title }),
    ...(owner === undefined ? {} : { agentId: owner }),
  }
  return replaceItem(board, { ...item, subtasks: item.subtasks.map(s => (s.id === id ? next : s)) })
}

function remove(board: JarvisTaskBoard, input: Readonly<Record<string, unknown>>): JarvisTaskBoard | string {
  const id = str(input['id'])
  if (ITEM_ID.test(id)) {
    if (!board.items.some(i => i.id === id)) return t('board.itemNotFound', { id })
    return { ...board, items: board.items.filter(i => i.id !== id) }
  }
  const found = findSub(board, id)
  if (!found) return notFound(id)
  return replaceItem(board, { ...found.item, subtasks: found.item.subtasks.filter(s => s.id !== id) })
}

// One call of the board's tool: the board it leaves and the text the model reads, or why
// it was refused. `actor` is the subagent that called it; absent for the main loop. `now` stamps status changes.
export function applyTask(board: JarvisTaskBoard, input: Readonly<Record<string, unknown>>, actor?: string, now?: number): TaskReply {
  const op = input['op']
  const next =
    op === 'list'
      ? board
      : op === 'add'
        ? add(board, input, actor)
        : op === 'update'
          ? update(board, input, actor, now)
          : op === 'remove'
            ? remove(board, input)
            : t('board.badOp', { ops: OPS.join(t('common.listSep')) })
  if (typeof next === 'string') return { error: next }
  const settled = planResults(board, next)
  return { board: settled, text: boardText(settled) }
}

// A request item's plan that completes drops any older result and owes a new one; one that
// opens again (a new or reopened subtask) drops both. Every other item is left as it is.
function planResults(before: JarvisTaskBoard, after: JarvisTaskBoard): JarvisTaskBoard {
  const settle = (i: JarvisTaskItem): JarvisTaskItem => {
    const was = before.items.find(b => b.id === i.id)
    if (!isRequest(i) || i.subtasks.length === 0 || !was) return i
    const done = itemStatus(i) === 'completed'
    if (done === (itemStatus(was) === 'completed')) return i
    const { result: _r, resultDue: _d, ...rest } = i
    return done ? { ...rest, resultDue: true as const } : rest
  }
  const items = after.items.map(settle)
  return items.every((i, k) => i === after.items[k]) ? after : { ...after, items }
}

// An item with subtasks is done when all are, running when any is running or some (not all)
// are done, else waiting; one without has its own status.
export function itemStatus(item: JarvisTaskItem): JarvisTaskStatus {
  const subs = item.subtasks
  if (subs.length === 0) return item.status
  if (subs.every(s => s.status === 'completed')) return 'completed'
  if (subs.some(s => s.status === 'in_progress' || s.status === 'completed')) return 'in_progress'
  return 'pending'
}

// Whether something is actually running in an item: a subtask, or the item itself when it has
// none. A partly done item is in_progress by status but idle between subtasks.
export function itemRunning(item: JarvisTaskItem): boolean {
  return item.subtasks.length === 0 ? item.status === 'in_progress' : item.subtasks.some(s => s.status === 'in_progress')
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

export const countsText = (c: BoardCounts): string => t('tasks.counts', c)

const MARK: Record<JarvisTaskStatus, string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]' }

// The board as the model reads it, in the order added so the ids read in order; the request
// being worked on is marked.
export function boardText(board: JarvisTaskBoard): string {
  if (board.items.length === 0) return t('board.empty')
  const current = currentRequest(board)
  const lines = [t('board.head', { counts: countsText(boardCounts(board)) })]
  for (const item of board.items) {
    const result = item.result === undefined ? '' : ` → ${item.result}`
    lines.push(`${MARK[itemStatus(item)]} ${item.id} ${item.title}${result}${item === current ? t('board.current') : ''}`)
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

// A text's first non-blank line as one line, cut to `max` characters with an ellipsis.
export function lineOf(text: string, max: number): string {
  const line =
    text
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .find(l => l !== '') ?? ''
  const chars = [...line]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line
}

// A prompt's first non-blank line as one line, cut to REQUEST_TITLE_MAX with an ellipsis.
export function requestTitle(text: string): string {
  return lineOf(text, REQUEST_TITLE_MAX)
}

// what of a prompt.submit decides whether it is recorded
export type RequestSubmission = { text: string; command?: unknown; isMeta?: true; origin: { kind: string } }

// a slash command's line: `/name` then a space, a line break or the end; a path's first word
// holds another slash and names none
const SLASH_LINE = /^\/([\w:.-]+)(?:\s|$)/

// The command name a prompt's text opens with, as `/name`; undefined when it opens with none.
export const slashName = (text: string): string | undefined => SLASH_LINE.exec(text)?.[1]

// The person's own prompts, typed or through Remote Control; not a slash command, not one
// the person does not see, not a notification, a peer's message or a plugin's. A slash command
// absorbed into a running turn comes as its bare line with no `command`: one opening with a
// name in `commands` is a slash command too.
export function recordsRequest(e: RequestSubmission, commands: ReadonlySet<string> = new Set()): boolean {
  const slash = slashName(e.text)
  return (
    e.command === undefined &&
    (slash === undefined || !commands.has(slash)) &&
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

// A request item for a prompt just sent, running from the start; `rid` is its own id, for
// the summaries that come back later. One typed while a turn ran (`runningTurn`) is tied to
// that turn and marked queued; any other waits for the next main-loop turn. Nothing is made
// for a blank prompt or a board full of unfinished items.
export function openRequest(
  board: JarvisTaskBoard,
  text: string,
  runningTurn?: string,
  now?: number,
  rid?: string,
): { board: JarvisTaskBoard; id?: string } {
  const key = requestTitle(text)
  const roomy = makeRoom(board)
  if (key === '' || roomy.items.length >= MAX_ITEMS) return { board }
  return {
    board: putItem(roomy, key, [], undefined, {
      status: 'in_progress',
      origin: REQUEST_ORIGIN,
      key,
      ...(now === undefined ? {} : { startedAt: now }),
      ...(rid === undefined ? {} : { rid }),
      ...(runningTurn === undefined ? {} : { turnId: runningTurn, queued: true as const }),
    }),
    id: String(roomy.nextItem),
  }
}

// A main-loop turn starts: request items waiting for a turn are tied to it. With none
// waiting, a queued request whose prompt this turn begins with (the turn before closed it)
// runs again, tied to this turn.
export function startTurn(board: JarvisTaskBoard, turnId: string, text: string, now?: number): JarvisTaskBoard {
  const waiting = board.items.filter(i => isRequest(i) && i.status === 'in_progress' && i.turnId === undefined)
  if (waiting.length > 0) return { ...board, items: board.items.map(i => (waiting.includes(i) ? { ...i, turnId } : i)) }
  const key = requestTitle(text)
  const queued = key === '' ? undefined : board.items.findLast(i => isRequest(i) && i.queued === true && i.key === key)
  if (!queued) return board
  const { queued: _q, ...rest } = queued
  return replaceItem(board, { ...stamped(rest, 'in_progress', now), turnId })
}

// A main-loop turn ends: its request items let go of it; a running one is done when the
// turn answered or refused, and waits again (pending) when it was interrupted or died on an
// error. Every other item is left as it is.
export function endTurn(board: JarvisTaskBoard, turnId: string, reason: string, now?: number): JarvisTaskBoard {
  const ends = (i: JarvisTaskItem) => isRequest(i) && i.turnId === turnId
  if (!board.items.some(ends)) return board
  const status: JarvisTaskStatus = reason === 'aborted' || reason === 'error' ? 'pending' : 'completed'
  return {
    ...board,
    items: board.items.map(i => {
      if (!ends(i)) return i
      const { turnId: _t, ...rest } = i
      return i.status === 'in_progress' ? stamped(rest, status, now) : rest
    }),
  }
}

// The request being worked on: the newest request item running by its own status that a
// main-loop turn runs (not one typed over it), else the newest running by its own status.
export function currentRequest(board: JarvisTaskBoard): JarvisTaskItem | undefined {
  const running = (i: JarvisTaskItem) => isRequest(i) && i.status === 'in_progress'
  return board.items.findLast(i => running(i) && i.turnId !== undefined && i.queued !== true) ?? board.items.findLast(running)
}

// Whether a request item did work while its turn ran: a main-loop tool call other than the
// board's own, or a plan of subtasks.
export const itemWorked = (item: JarvisTaskItem): boolean => item.worked === true || item.subtasks.length > 0

// A main-loop tool call other than the board's: the request items the running turn runs (tied
// to a turn, running by their own status, not typed over it) did work. The same board when
// none is left to mark, so a caller writes only the first time.
export function markWorked(board: JarvisTaskBoard): JarvisTaskBoard {
  const marks = (i: JarvisTaskItem) =>
    isRequest(i) && i.status === 'in_progress' && i.turnId !== undefined && i.queued !== true && i.worked !== true
  if (!board.items.some(marks)) return board
  return { ...board, items: board.items.map(i => (marks(i) ? { ...i, worked: true as const } : i)) }
}

// A main-loop turn ends: its request items that did no work (no tool call, no plan) leave the
// board, whatever the reason; one typed over the turn stays, as it may yet run a turn of its
// own. The same board when there is none.
export function dropIdle(board: JarvisTaskBoard, turnId: string): JarvisTaskBoard {
  const idle = (i: JarvisTaskItem) => isRequest(i) && i.turnId === turnId && i.queued !== true && !itemWorked(i)
  return board.items.some(idle) ? { ...board, items: board.items.filter(i => !idle(i)) } : board
}

// When an item began: its own start, else its earliest subtask's.
export function itemStartedAt(item: JarvisTaskItem): number | undefined {
  const starts = [item.startedAt, ...item.subtasks.map(s => s.startedAt)].filter((t): t is number => t !== undefined)
  return starts.length === 0 ? undefined : Math.min(...starts)
}

// completed within FRESH_MS of `now`
export const isFresh = (x: { status: JarvisTaskStatus; endedAt?: number }, now: number): boolean =>
  x.status === 'completed' && x.endedAt !== undefined && now - x.endedAt < FRESH_MS

// An item done within FRESH_MS: by its own stamp, or by a subtask's.
export function itemFresh(item: JarvisTaskItem, now: number): boolean {
  return itemStatus(item) === 'completed' && (isFresh(item, now) || item.subtasks.some(s => isFresh(s, now)))
}

// Whether the board has something that moves at `now`: running work, or work just done.
export function boardLive(board: JarvisTaskBoard, now: number): boolean {
  return board.items.some(
    i => itemRunning(i) || itemFresh(i, now) || i.subtasks.some(s => s.status === 'in_progress' || isFresh(s, now)),
  )
}

// The note beside each recorded prompt: which item it is, and what the model may do with it.
export const requestContext = (id: string): string => t('board.requestContext', { id })

// ---- what a small model makes of a request, after the fact ----

// The board with a request item's summary title, found by `rid`; unchanged when the item is
// gone, the summary is blank, or the model has set the title itself.
export function withSummaryTitle(board: JarvisTaskBoard, rid: string, title: string): JarvisTaskBoard {
  const item = board.items.find(i => i.rid === rid)
  if (!item || item.titleBy === 'model' || title === '') return board
  return replaceItem(board, { ...item, title, titleBy: 'haiku' })
}

// ---- topics: what the person's requests are about ----

// how many topics the small model is offered for a new request
export const TOPIC_CANDIDATES = 10

export const topicsOf = (board: JarvisTaskBoard): JarvisTopic[] => board.topics ?? []

// The board without the topics no item points at; the same board when there are none.
export function dropEmptyTopics(board: JarvisTaskBoard): JarvisTaskBoard {
  const topics = topicsOf(board)
  const kept = topics.filter(t => board.items.some(i => i.topic === t.id))
  return kept.length === topics.length ? board : { ...board, topics: kept }
}

// a topic offered to the small model, with the title of its newest request
export type TopicCandidate = { id: string; title: string; latest: string }

// The topics with requests, the most recently active first (by their newest request's place
// on the board), at most TOPIC_CANDIDATES.
export function topicCandidates(board: JarvisTaskBoard): TopicCandidate[] {
  const topics = topicsOf(board)
  const out: TopicCandidate[] = []
  for (const item of [...board.items].reverse()) {
    if (item.topic === undefined || out.some(c => c.id === item.topic)) continue
    const t = topics.find(x => x.id === item.topic)
    if (t) out.push({ id: t.id, title: t.title, latest: item.title })
  }
  return out.slice(0, TOPIC_CANDIDATES)
}

// where the small model put a request: an offered topic (with its title, should it be gone
// by the time the reply lands), or a new one ('' when it named none)
export type TopicChoice = { kind: 'join'; id: string; title: string } | { kind: 'new'; title: string }

// The board with a request item's summary title and its topic, found by `rid`. A topic gone
// since it was offered is opened again under its title; a new one with no title takes the
// item's. Unchanged when the item is gone; an item with a topic keeps it.
export function withClassified(board: JarvisTaskBoard, rid: string, title: string, choice: TopicChoice): JarvisTaskBoard {
  const titledBoard = withSummaryTitle(board, rid, title)
  const item = titledBoard.items.find(i => i.rid === rid)
  if (!item || item.topic !== undefined) return titledBoard
  const topics = topicsOf(titledBoard)
  if (choice.kind === 'join' && topics.some(t => t.id === choice.id)) return replaceItem(titledBoard, { ...item, topic: choice.id })
  const n = titledBoard.nextTopic ?? 1
  const id = String(n)
  return {
    ...replaceItem(titledBoard, { ...item, topic: id }),
    topics: [...topics, { id, title: choice.title !== '' ? choice.title : item.title }],
    nextTopic: n + 1,
  }
}

// a topic's requests, or an item standing alone
export type TaskGroup = { topic?: JarvisTopic; items: JarvisTaskItem[] }
export type BoardGroups = { running: TaskGroup[]; planned: TaskGroup[]; done: TaskGroup[] }

// A group runs when any item runs, else waits when any waits, else is done.
export function groupStatus(group: TaskGroup): JarvisTaskStatus {
  const s = group.items.map(itemStatus)
  return s.includes('in_progress') ? 'in_progress' : s.includes('pending') ? 'pending' : 'completed'
}

// The board in the page's three parts by group: each topic one group, every other item its
// own, placed by its newest item; running and planned oldest first, done newest first.
export function boardGroups(board: JarvisTaskBoard): BoardGroups {
  const topics = topicsOf(board)
  const byTopic = new Map<string, TaskGroup>()
  const placed: { group: TaskGroup; at: number }[] = []
  board.items.forEach((item, at) => {
    const topic = item.topic === undefined ? undefined : topics.find(t => t.id === item.topic)
    const known = topic === undefined ? undefined : byTopic.get(topic.id)
    if (known) {
      known.items.push(item)
      const p = placed.find(x => x.group === known)
      if (p) p.at = at
      return
    }
    const group: TaskGroup = topic === undefined ? { items: [item] } : { topic, items: [item] }
    if (topic !== undefined) byTopic.set(topic.id, group)
    placed.push({ group, at })
  })
  const ordered = placed.sort((a, b) => a.at - b.at).map(p => p.group)
  const inStatus = (s: JarvisTaskStatus) => ordered.filter(g => groupStatus(g) === s)
  return { running: inStatus('in_progress'), planned: inStatus('pending'), done: inStatus('completed').reverse() }
}

// a request item with a plan not yet done: no result stands beside it
const planOpen = (i: JarvisTaskItem): boolean => i.subtasks.length > 0 && itemStatus(i) !== 'completed'

// The board with what a request item's turn came to, found by `rid`; unchanged when the item
// is gone, the result blank, or its plan open again.
export function withResult(board: JarvisTaskBoard, rid: string, result: string): JarvisTaskBoard {
  const item = board.items.find(i => i.rid === rid)
  if (!item || result === '' || planOpen(item)) return board
  return replaceItem(board, { ...item, result })
}

// The request items a main-loop turn's end answers: without subtasks, tied to the turn,
// running by their own status, not typed over it; with subtasks, those whose plan completed
// and owe a result, wherever their turn. Each with its title, asked about when its prompt is
// gone, and its subtasks' titles.
export function requestsEnding(board: JarvisTaskBoard, turnId: string): { rid: string; title: string; subtasks: string[] }[] {
  const answers = (i: JarvisTaskItem) =>
    i.subtasks.length === 0
      ? i.turnId === turnId && i.status === 'in_progress' && i.queued !== true
      : i.resultDue === true
  return board.items.flatMap(i =>
    isRequest(i) && i.rid !== undefined && answers(i) ? [{ rid: i.rid, title: i.title, subtasks: i.subtasks.map(s => s.title) }] : [],
  )
}

// A main-loop turn ends: request items with an open plan lose any result; an answered end
// (`answered`) takes the results owed, as it asks for them. The same board when nothing changes.
export function closeResults(board: JarvisTaskBoard, answered: boolean): JarvisTaskBoard {
  const closes = (i: JarvisTaskItem) => isRequest(i) && ((planOpen(i) && i.result !== undefined) || (answered && i.resultDue === true))
  if (!board.items.some(closes)) return board
  return {
    ...board,
    items: board.items.map(i => {
      if (!closes(i)) return i
      const { result, resultDue: _d, ...rest } = i
      return planOpen(i) || result === undefined ? rest : { ...rest, result }
    }),
  }
}

// ---- the built-in task tools, mirrored when the session has them ----

export const TODO_TITLE = 'TodoWrite'
export const TASKS_ORIGIN = 'tasks'
export let TASKS_TITLE: string
localized(() => {
  TASKS_TITLE = t('tasks.builtin')
})

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
