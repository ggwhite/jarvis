import type { JarvisTaskBoard, JarvisTaskItem, JarvisTaskStatus } from '../types'
import type { Seg } from './cockpit'
import { TASK_ICON, withIcon } from './icons'
import { THEME, cellWidth, fitCells, padCells } from './jarvis'
import { boardSections, itemStatus } from './tasks'

export const EMPTY_TEXT = '還沒有任務。送出請求後，這裡會列出正在做、預計要做和做完的事。'

// a subtask row's indent under its item
export const SUB_INDENT = 4

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

const TITLE_STYLE: Record<JarvisTaskStatus, { color: string; bold?: boolean }> = {
  pending: { color: THEME.primary },
  in_progress: { color: THEME.bright, bold: true },
  completed: { color: THEME.frame },
}

// who does a subtask, drawn at its row's right: MK-N in the member's color
export type OwnerMark = { t: string; color: string }

// One row `width` cells wide: the indent, the status icon, the title cut and padded to
// leave `right` its room, then `right`.
function taskRow(indent: number, status: JarvisTaskStatus, title: string, right: OwnerMark | undefined, width: number): Seg[] {
  const icon = withIcon(TASK_ICON[status], '')
  const rightW = right ? cellWidth(right.t) + 1 : 0
  const titleW = Math.max(1, width - indent - cellWidth(icon) - rightW)
  return [
    ...(indent > 0 ? [{ t: ' '.repeat(indent) }] : []),
    { t: icon, color: ICON_COLOR[status] },
    { t: padCells(title, titleW), ...TITLE_STYLE[status] },
    ...(right ? [{ t: ' ' }, { t: right.t, color: right.color }] : []),
  ]
}

// A part's heading with its count, `width` cells.
const headingRow = (label: string, n: number, width: number): Seg[] => [{ t: padCells(`${label} ${n}`, width), color: THEME.frame, bold: true }]

// An item's row, its subtasks under it unless it is done.
function itemRows(item: JarvisTaskItem, width: number, owner: (agentId: string) => OwnerMark): Seg[][] {
  const status = itemStatus(item)
  const done = item.subtasks.filter(s => s.status === 'completed').length
  const count = item.subtasks.length > 0 ? { t: `${done}/${item.subtasks.length}`, color: THEME.frame } : undefined
  const rows = [taskRow(0, status, item.title, count, width)]
  if (status === 'completed') return rows
  for (const s of item.subtasks) {
    rows.push(taskRow(SUB_INDENT, s.status, s.title, s.agentId === undefined ? undefined : owner(s.agentId), width))
  }
  return rows
}

// The board as rows in three parts (進行中, 預計, 已完成), each under its heading, an empty
// part left out; past `room` rows the last says how many are left out.
export function taskRows(board: JarvisTaskBoard, width: number, room: number, owner: (agentId: string) => OwnerMark): Seg[][] {
  if (room <= 0) return []
  if (board.items.length === 0) return [[{ t: fitCells(EMPTY_TEXT, width), color: THEME.frame }]]
  const parts = boardSections(board)
  const rows: Seg[][] = []
  for (const [key, label] of SECTIONS) {
    const items = parts[key]
    if (items.length === 0) continue
    rows.push(headingRow(label, items.length, width))
    for (const item of items) rows.push(...itemRows(item, width, owner))
  }
  if (rows.length <= room) return rows
  const kept = rows.slice(0, room - 1)
  return [...kept, [{ t: fitCells(`還有 ${rows.length - kept.length} 列`, width), color: THEME.frame }]]
}
