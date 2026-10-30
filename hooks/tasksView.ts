import type { JarvisStatus, JarvisTaskBoard, JarvisTaskItem, JarvisTaskStatus } from '../types'
import type { Seg } from './cockpit'
import { RESULT_ICON, TASK_ICON, withIcon } from './icons'
import { localized, t } from './i18n'
import { ANIM_MS, SPINNER, THEME, cellWidth, fitCells, fmtReadout, padCells } from './jarvis'
import { boardGroups, groupStatus, isFresh, itemFresh, itemRunning, itemStartedAt, itemStatus, topicsOf } from './tasks'
import type { TaskGroup } from './tasks'

export let EMPTY_TEXT: string
localized(() => {
  EMPTY_TEXT = t('tasks.empty')
})

// a subtask row's indent under its item
export const SUB_INDENT = 4
// the narrowest a title is cut to before the right side gives up its parts
export const TITLE_MIN = 8
// a running member's tool name is cut to this many cells
export const TOOL_MAX = 12
// the fewest cells a result is drawn in: its arrow, a space and two cells of text
export const RESULT_MIN = 4

// the page's three parts in order, each under its heading
const SECTIONS = [
  ['running', 'tasks.running'],
  ['planned', 'tasks.planned'],
  ['done', 'tasks.done'],
] as const

const ICON_COLOR: Record<JarvisTaskStatus, string> = {
  pending: THEME.frame,
  in_progress: THEME.accent,
  completed: THEME.success,
}

type TitleStyle = { color: string; bold?: boolean }

const TITLE_STYLE: Record<JarvisTaskStatus, TitleStyle> = {
  pending: { color: THEME.primary },
  in_progress: { color: THEME.bright, bold: true },
  completed: { color: THEME.frame },
}

// A squad member doing a subtask: how its run stands, from jarvis's record of it.
export type AgentBadge = { status: JarvisStatus; waiting?: boolean; ms: number; tool: string }

// who does a subtask: MK-N in the member's color, with its run when the member is listed
export type OwnerMark = { t: string; color: string; agent?: AgentBadge }

// The fold choices pressed so far, by item id: true hides an item's subtasks, false shows them.
export type TaskFolds = Readonly<Record<string, boolean>>

// A drawn row; an item's row with subtasks also carries the item its icon and title fold or
// open, and whether it is folded now; a row saying how many rows are left out above or below
// carries the first row its press scrolls to.
export type TaskLine = { segs: Seg[]; item?: { id: string; folded: boolean }; scroll?: number }

// The rows drawn from the first row shown, `top` (clamped), and the last `top` can be.
export type TaskWindow = { lines: TaskLine[]; top: number; max: number }

// Whether an item's subtasks are hidden: the press's choice, else hidden once it is done.
export const isFolded = (item: JarvisTaskItem, folds: TaskFolds): boolean => folds[item.id] ?? itemStatus(item) === 'completed'

// A topic's fold choice is kept under this key, beside the items' ids.
export const topicKey = (id: string): string => `t:${id}`

// Whether a topic's requests are hidden: the press's choice, else hidden unless it runs or a
// request in it is still inside its turn (a fresh plan of waiting subtasks reads as planned).
export const topicFolded = (group: TaskGroup, folds: TaskFolds): boolean =>
  group.topic === undefined
    ? false
    : (folds[topicKey(group.topic.id)] ?? !(groupStatus(group) === 'in_progress' || group.items.some(i => i.status === 'in_progress')))

// The fold choices of the items and topics still on the board.
export const keptFolds = (folds: TaskFolds | undefined, board: JarvisTaskBoard): Record<string, boolean> =>
  Object.fromEntries(
    Object.entries(folds ?? {}).filter(([id]) => board.items.some(i => i.id === id) || topicsOf(board).some(t => topicKey(t.id) === id)),
  )

// A row's leading indent, kept apart so a button holds its icon and title alone.
export function splitLead(segs: Seg[]): { lead: Seg[]; rest: Seg[] } {
  const first = segs[0]
  return first !== undefined && first.t !== '' && first.t.trim() === '' ? { lead: [first], rest: segs.slice(1) } : { lead: [], rest: segs }
}

// The running icon: the spinner's frame at `now` and a space, as wide as a status icon.
export const spinnerAt = (now: number): string => `${SPINNER[Math.floor(now / ANIM_MS) % SPINNER.length] ?? SPINNER[0]} `

// A row's icon and title style: running spins, just completed is lit bright.
function look(status: JarvisTaskStatus, fresh: boolean, now: number): { icon: Seg; style: TitleStyle } {
  if (status === 'in_progress') return { icon: { t: spinnerAt(now), color: ICON_COLOR.in_progress }, style: TITLE_STYLE.in_progress }
  if (fresh) return { icon: { t: withIcon(TASK_ICON.completed, ''), color: THEME.bright }, style: { color: THEME.bright } }
  return { icon: { t: withIcon(TASK_ICON[status], ''), color: ICON_COLOR[status] }, style: TITLE_STYLE[status] }
}

const widthOf = (segs: readonly Seg[]): number => segs.reduce((n, s) => n + cellWidth(s.t), 0)

// parts with one space between each
const spaced = (parts: readonly Seg[]): Seg[] => parts.flatMap((p, k) => (k === 0 ? [p] : [{ t: ' ' }, p]))

const time = (ms: number): Seg => ({ t: fmtReadout(ms), color: THEME.frame })

// One row `width` cells wide: the indent, the icon, the title cut and padded, then the
// roomiest right side of `rights` that leaves the title TITLE_MIN cells (or its whole
// width when shorter), else the last. A `tail` (an item's result) follows the whole title
// where RESULT_MIN cells are left for it, cut first; with less it is not drawn.
function taskRow(
  indent: number,
  icon: Seg,
  title: string,
  style: TitleStyle,
  rights: readonly (readonly Seg[])[],
  width: number,
  tail = '',
): Seg[] {
  const head = indent + cellWidth(icon.t)
  const room = (r: readonly Seg[]) => width - head - (r.length > 0 ? widthOf(r) + 1 : 0)
  const least = Math.min(TITLE_MIN, cellWidth(title))
  const right = rights.find(r => room(r) >= least) ?? rights.at(-1) ?? []
  const avail = Math.max(1, room(right))
  const tailRoom = avail - cellWidth(title) - 1
  const shown: Seg[] =
    tail !== '' && tailRoom >= RESULT_MIN
      ? [{ t: title, ...style }, { t: ' ' }, { t: padCells(withIcon(RESULT_ICON, tail), tailRoom), color: THEME.primary }]
      : [{ t: padCells(title, avail), ...style }]
  return [
    ...(indent > 0 ? [{ t: ' '.repeat(indent) }] : []),
    icon,
    ...shown,
    ...(right.length > 0 ? [{ t: ' ' }, ...right] : []),
  ]
}

// An item's right side, roomiest first: done/total and, while running, its time; the
// time goes first.
function itemRights(item: JarvisTaskItem, running: boolean, now: number): Seg[][] {
  const done = item.subtasks.filter(s => s.status === 'completed').length
  const count: Seg[] = item.subtasks.length > 0 ? [{ t: `${done}/${item.subtasks.length}`, color: THEME.frame }] : []
  const since = running ? itemStartedAt(item) : undefined
  return since === undefined ? [count] : [spaced([...count, time(now - since)]), count]
}

// A subtask's right side, roomiest first: its member's run and MK-N (MK-N stays last), or,
// without a member, its own time while running.
function subtaskRights(status: JarvisTaskStatus, startedAt: number | undefined, owner: OwnerMark | undefined, now: number): Seg[][] {
  if (owner === undefined) return status === 'in_progress' && startedAt !== undefined ? [[time(now - startedAt)], []] : [[]]
  const mk: Seg = { t: owner.t, color: owner.color }
  const a = owner.agent
  if (a === undefined) return [[mk]]
  const took = time(a.ms)
  if (a.status === 'running' && a.waiting === true) return [spaced([{ t: t('member.waiting'), color: THEME.primary }, took, mk]), spaced([took, mk]), [mk]]
  if (a.status === 'running') {
    const tool: Seg[] = a.tool === '' ? [] : [{ t: fitCells(a.tool, TOOL_MAX), color: THEME.accent }]
    return [spaced([...tool, took, mk]), spaced([took, mk]), [mk]]
  }
  if (a.status === 'done' || a.status === 'failed') {
    const word: Seg = a.status === 'done' ? { t: t('member.done'), color: THEME.success } : { t: t('member.failed'), color: THEME.error }
    return [spaced([word, took, mk]), spaced([word, mk])]
  }
  return [spaced([{ t: t('member.stale'), color: THEME.error }, mk]), [mk]]
}

// A part's heading with its count, `width` cells.
const headingRow = (label: string, n: number, width: number): Seg[] => [{ t: padCells(`${label} ${n}`, width), color: THEME.frame, bold: true }]

// An item's row, then its subtasks unless it is folded; the item's row carries its fold
// when it has subtasks to fold.
function itemLines(
  item: JarvisTaskItem,
  width: number,
  owner: (agentId: string) => OwnerMark,
  now: number,
  folds: TaskFolds,
  indent = 0,
  title = item.title,
): TaskLine[] {
  const status = itemStatus(item)
  const running = itemRunning(item)
  // a partly done item idle between subtasks stands still: no spinner, no clock
  const head = look(status === 'in_progress' && !running ? 'pending' : status, itemFresh(item, now), now)
  const folded = isFolded(item, folds)
  const segs = taskRow(indent, head.icon, title, head.style, itemRights(item, running, now), width, item.result ?? '')
  const lines: TaskLine[] = [item.subtasks.length > 0 ? { segs, item: { id: item.id, folded } } : { segs }]
  if (folded) return lines
  for (const s of item.subtasks) {
    const l = look(s.status, isFresh(s, now), now)
    const who = s.agentId === undefined ? undefined : owner(s.agentId)
    lines.push({ segs: taskRow(indent + SUB_INDENT, l.icon, s.title, l.style, subtaskRights(s.status, s.startedAt, who, now), width) })
  }
  return lines
}

// A topic's lines: its row (icon and look by the topic's status, its newest result, requests
// done/total and, while one runs, the time since the first began), then its requests one
// indent in unless folded. A topic of one request, or an item alone, is that item's lines,
// under the topic's title unless the model titled the item.
function groupLines(group: TaskGroup, width: number, owner: (agentId: string) => OwnerMark, now: number, folds: TaskFolds): TaskLine[] {
  const topic = group.topic
  const [only] = group.items
  if (only !== undefined && (topic === undefined || group.items.length === 1)) {
    const title = topic !== undefined && only.titleBy !== 'model' ? topic.title : only.title
    return itemLines(only, width, owner, now, folds, 0, title)
  }
  if (topic === undefined) return []
  const status = groupStatus(group)
  const running = group.items.some(itemRunning)
  const fresh = status === 'completed' && group.items.some(i => itemFresh(i, now))
  const head = look(status === 'in_progress' && !running ? 'pending' : status, fresh, now)
  const done = group.items.filter(i => itemStatus(i) === 'completed').length
  const count: Seg[] = [{ t: `${done}/${group.items.length}`, color: THEME.frame }]
  const starts = group.items.map(itemStartedAt).filter((t): t is number => t !== undefined)
  const since = running && starts.length > 0 ? Math.min(...starts) : undefined
  const rights = since === undefined ? [count] : [spaced([...count, time(now - since)]), count]
  const result = group.items.findLast(i => i.result !== undefined)?.result ?? ''
  const folded = topicFolded(group, folds)
  const lines: TaskLine[] = [
    { segs: taskRow(0, head.icon, topic.title, head.style, rights, width, result), item: { id: topicKey(topic.id), folded } },
  ]
  if (folded) return lines
  for (const item of group.items) lines.push(...itemLines(item, width, owner, now, folds, SUB_INDENT))
  return lines
}

// The board as lines at `now` in three parts (進行中, 預計, 已完成), each under its heading,
// an empty part left out; past `room` lines the window from line `top` is drawn, the first row
// saying how many are left out above and the last how many below. A press on either scrolls
// a page less one row; with fewer than three rows of room it stays at the top.
export function taskWindow(
  board: JarvisTaskBoard,
  width: number,
  room: number,
  owner: (agentId: string) => OwnerMark,
  now = 0,
  folds: TaskFolds = {},
  top = 0,
): TaskWindow {
  if (room <= 0) return { lines: [], top: 0, max: 0 }
  if (board.items.length === 0) return { lines: [{ segs: [{ t: fitCells(EMPTY_TEXT, width), color: THEME.frame }] }], top: 0, max: 0 }
  const parts = boardGroups(board)
  const lines: TaskLine[] = []
  for (const [key, label] of SECTIONS) {
    const groups = parts[key]
    if (groups.length === 0) continue
    lines.push({ segs: headingRow(t(label), groups.length, width) })
    for (const group of groups) lines.push(...groupLines(group, width, owner, now, folds))
  }
  if (lines.length <= room) return { lines, top: 0, max: 0 }
  const more = (key: 'tasks.moreRows' | 'tasks.moreAbove', n: number): Seg[] => [{ t: fitCells(t(key, { n }), width), color: THEME.frame }]
  if (room < 3) {
    const kept = lines.slice(0, room - 1)
    return { lines: [...kept, { segs: more('tasks.moreRows', lines.length - kept.length) }], top: 0, max: 0 }
  }
  // at the bottom the rows under the above row run to the end
  const max = lines.length - (room - 1)
  const at = Math.min(max, Math.max(0, Math.floor(top)))
  // a page in the middle, less the row kept in view
  const step = Math.max(1, room - 3)
  const body = lines.slice(at, at + room - (at > 0 ? 1 : 0) - (at < max ? 1 : 0))
  const below = lines.length - at - body.length
  return {
    lines: [
      ...(at > 0 ? [{ segs: more('tasks.moreAbove', at), scroll: Math.max(0, at - step) }] : []),
      ...body,
      ...(below > 0 ? [{ segs: more('tasks.moreRows', below), scroll: Math.min(max, at + Math.max(1, body.length - 1)) }] : []),
    ],
    top: at,
    max,
  }
}

// The window's rows alone.
export function taskLines(
  board: JarvisTaskBoard,
  width: number,
  room: number,
  owner: (agentId: string) => OwnerMark,
  now = 0,
  folds: TaskFolds = {},
  top = 0,
): TaskLine[] {
  return taskWindow(board, width, room, owner, now, folds, top).lines
}

// The board's lines as segments alone.
export function taskRows(
  board: JarvisTaskBoard,
  width: number,
  room: number,
  owner: (agentId: string) => OwnerMark,
  now = 0,
  folds: TaskFolds = {},
  top = 0,
): Seg[][] {
  return taskLines(board, width, room, owner, now, folds, top).map(l => l.segs)
}
