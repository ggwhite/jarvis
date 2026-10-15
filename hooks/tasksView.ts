import type { JarvisStatus, JarvisTaskBoard, JarvisTaskItem, JarvisTaskStatus } from '../types'
import type { Seg } from './cockpit'
import { TASK_ICON, withIcon } from './icons'
import { ANIM_MS, SPINNER, THEME, cellWidth, fitCells, fmtReadout, padCells } from './jarvis'
import { boardSections, isFresh, itemFresh, itemStartedAt, itemStatus } from './tasks'

export const EMPTY_TEXT = '還沒有任務。送出請求後，這裡會列出正在做、預計要做和做完的事。'

// a subtask row's indent under its item
export const SUB_INDENT = 4
// the narrowest a title is cut to before the right side gives up its parts
export const TITLE_MIN = 8
// a running member's tool name is cut to this many cells
export const TOOL_MAX = 12

// the page's three parts in order, each under its heading
const SECTIONS = [
  ['running', '進行中'],
  ['planned', '預計'],
  ['done', '已完成'],
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
// open, and whether it is folded now.
export type TaskLine = { segs: Seg[]; item?: { id: string; folded: boolean } }

// Whether an item's subtasks are hidden: the press's choice, else hidden once it is done.
export const isFolded = (item: JarvisTaskItem, folds: TaskFolds): boolean => folds[item.id] ?? itemStatus(item) === 'completed'

// The fold choices of the items still on the board.
export const keptFolds = (folds: TaskFolds | undefined, board: JarvisTaskBoard): Record<string, boolean> =>
  Object.fromEntries(Object.entries(folds ?? {}).filter(([id]) => board.items.some(i => i.id === id)))

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
// width when shorter), else the last.
function taskRow(indent: number, icon: Seg, title: string, style: TitleStyle, rights: readonly (readonly Seg[])[], width: number): Seg[] {
  const head = indent + cellWidth(icon.t)
  const room = (r: readonly Seg[]) => width - head - (r.length > 0 ? widthOf(r) + 1 : 0)
  const least = Math.min(TITLE_MIN, cellWidth(title))
  const right = rights.find(r => room(r) >= least) ?? rights.at(-1) ?? []
  return [
    ...(indent > 0 ? [{ t: ' '.repeat(indent) }] : []),
    icon,
    { t: padCells(title, Math.max(1, room(right))), ...style },
    ...(right.length > 0 ? [{ t: ' ' }, ...right] : []),
  ]
}

// An item's right side, roomiest first: done/total and, while running, its time; the
// time goes first.
function itemRights(item: JarvisTaskItem, status: JarvisTaskStatus, now: number): Seg[][] {
  const done = item.subtasks.filter(s => s.status === 'completed').length
  const count: Seg[] = item.subtasks.length > 0 ? [{ t: `${done}/${item.subtasks.length}`, color: THEME.frame }] : []
  const since = status === 'in_progress' ? itemStartedAt(item) : undefined
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
  if (a.status === 'running' && a.waiting === true) return [spaced([{ t: '等待', color: THEME.primary }, took, mk]), spaced([took, mk]), [mk]]
  if (a.status === 'running') {
    const tool: Seg[] = a.tool === '' ? [] : [{ t: fitCells(a.tool, TOOL_MAX), color: THEME.accent }]
    return [spaced([...tool, took, mk]), spaced([took, mk]), [mk]]
  }
  if (a.status === 'done' || a.status === 'failed') {
    const word: Seg = a.status === 'done' ? { t: '完成', color: THEME.success } : { t: '失敗', color: THEME.error }
    return [spaced([word, took, mk]), spaced([word, mk])]
  }
  return [spaced([{ t: '失聯', color: THEME.error }, mk]), [mk]]
}

// A part's heading with its count, `width` cells.
const headingRow = (label: string, n: number, width: number): Seg[] => [{ t: padCells(`${label} ${n}`, width), color: THEME.frame, bold: true }]

// An item's row, then its subtasks unless it is folded; the item's row carries its fold
// when it has subtasks to fold.
function itemLines(item: JarvisTaskItem, width: number, owner: (agentId: string) => OwnerMark, now: number, folds: TaskFolds): TaskLine[] {
  const status = itemStatus(item)
  const head = look(status, itemFresh(item, now), now)
  const folded = isFolded(item, folds)
  const segs = taskRow(0, head.icon, item.title, head.style, itemRights(item, status, now), width)
  const lines: TaskLine[] = [item.subtasks.length > 0 ? { segs, item: { id: item.id, folded } } : { segs }]
  if (folded) return lines
  for (const s of item.subtasks) {
    const l = look(s.status, isFresh(s, now), now)
    const who = s.agentId === undefined ? undefined : owner(s.agentId)
    lines.push({ segs: taskRow(SUB_INDENT, l.icon, s.title, l.style, subtaskRights(s.status, s.startedAt, who, now), width) })
  }
  return lines
}

// The board as lines at `now` in three parts (進行中, 預計, 已完成), each under its heading,
// an empty part left out; past `room` lines the last says how many are left out.
export function taskLines(
  board: JarvisTaskBoard,
  width: number,
  room: number,
  owner: (agentId: string) => OwnerMark,
  now = 0,
  folds: TaskFolds = {},
): TaskLine[] {
  if (room <= 0) return []
  if (board.items.length === 0) return [{ segs: [{ t: fitCells(EMPTY_TEXT, width), color: THEME.frame }] }]
  const parts = boardSections(board)
  const lines: TaskLine[] = []
  for (const [key, label] of SECTIONS) {
    const items = parts[key]
    if (items.length === 0) continue
    lines.push({ segs: headingRow(label, items.length, width) })
    for (const item of items) lines.push(...itemLines(item, width, owner, now, folds))
  }
  if (lines.length <= room) return lines
  const kept = lines.slice(0, room - 1)
  return [...kept, { segs: [{ t: fitCells(`還有 ${lines.length - kept.length} 列`, width), color: THEME.frame }] }]
}

// The board's lines as segments alone.
export function taskRows(
  board: JarvisTaskBoard,
  width: number,
  room: number,
  owner: (agentId: string) => OwnerMark,
  now = 0,
  folds: TaskFolds = {},
): Seg[][] {
  return taskLines(board, width, room, owner, now, folds).map(l => l.segs)
}
