import type { RenderElement } from 'claude-code'

import { MIN_EVENT_ROWS } from './cockpit'
import type { Ctx } from './cockpit'
import { DT } from './desktopTheme'
import type { DesktopUi } from './desktopView'
import { MAX_EVENTS, ROLES, elapsedMs, eventRows, fitCells, fmtClock, fmtDate, fmtMs, fmtReadout } from './jarvis'
import type { Cockpit, EventRow } from './jarvis'
import { EMPTY_BOARD, boardCounts, boardGroups, countsText, groupStatus, isFresh, itemFresh, itemRunning, itemStartedAt, itemStatus } from './tasks'
import type { TaskGroup } from './tasks'
import { EMPTY_TEXT, TOOL_MAX, isFolded, topicFolded, topicKey } from './tasksView'
import type { JarvisEvent, JarvisPage, JarvisSubtask, JarvisTaskItem, JarvisTaskStatus } from '../types'

// What the native layout's skeleton hands these pages: the elements, what to draw, and its
// card, heading, tile, pill and picture, all already sized to the pane.
export type KitA = {
  ui: DesktopUi
  view: Cockpit
  ctx: Ctx
  rows: number
  cardInner: number
  card: (top: RenderElement, body: readonly RenderElement[], accent?: string, grow?: boolean) => RenderElement
  head: (icon: string, title: string, right?: string) => RenderElement
  tile: (body: readonly RenderElement[]) => RenderElement
  pill: (key: string, label: string, solid: boolean, onPress: () => void) => RenderElement
  picture: (source: string, alt: string, wide: number, tall: number, animated?: boolean) => RenderElement
  actorName: (actor: string) => string
}

// The pages drawn here: the event log, the task board, a subagent's and a role's page.
export const A_PAGES: readonly JarvisPage[] = ['log', 'tasks']

export const isPageA = (page: JarvisPage): boolean => A_PAGES.includes(page)

// The page drawn for `ctx.page`: a detail page whose subagent left the list is the page it was
// opened from, a role page of no known role the stats page.
export function shownPageA(view: Cockpit, ctx: Pick<Ctx, 'page' | 'agentId' | 'role' | 'detailFrom'>): JarvisPage {
  const roleShown = ROLES.find(r => r === ctx.role)
  if (ctx.page === 'detail' && ![...view.running, ...view.stale, ...view.finished].some(a => a.id === ctx.agentId))
    return ctx.detailFrom === 'roleDetail' && roleShown ? 'roleDetail' : 'now'
  if (ctx.page === 'roleDetail' && !roleShown) return 'stats'
  return ctx.page
}

// the least a row's description keeps before its other columns give way
const DESC_MIN = 8

// A card's top line: its title on the left (maybe more beside it), words on the right.
function topLine(ui: DesktopUi, left: readonly RenderElement[], right?: RenderElement): RenderElement {
  const { Box } = ui
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row" gap={1}>
        {left}
      </Box>
      {right ?? null}
    </Box>
  )
}

// A card of events, oldest first, the newest `limit` rows (dated rules count), as the now
// page's recent events: fixed columns under a header, the time and then the tool giving way
// where the card is narrow. `withActor` false leaves out who ran each call.
function eventsCard(kit: KitA, top: RenderElement, list: readonly JarvisEvent[], limit: number, empty: string, withActor: boolean): RenderElement {
  const { Box, Text } = kit.ui
  const inner = kit.cardInner
  const ECOL = { time: 8, who: 6, tool: 10, took: 6, mark: 4 }
  const shown = new Set<keyof typeof ECOL>(['time', 'tool', 'took', 'mark', ...(withActor ? (['who'] as const) : [])])
  const fixedW = () => [...shown].reduce((sum, k) => sum + ECOL[k], 0) + shown.size
  for (const k of ['time', 'tool'] as const) if (fixedW() + DESC_MIN > inner) shown.delete(k)
  const descW = Math.max(1, inner - fixedW())
  const cell = (w: number, body: RenderElement, end = false): RenderElement => (
    <Box width={w} flexShrink={0} overflow="hidden" {...(end ? { justifyContent: 'flex-end' } : {})}>
      {body}
    </Box>
  )
  const sub = (t: string): RenderElement => (
    <Text color={DT.textSub} wrap="truncate">
      {t}
    </Text>
  )
  const row = (c: Record<keyof typeof ECOL | 'desc', RenderElement>): RenderElement => (
    <Box flexDirection="row" gap={1} alignItems="center">
      {shown.has('time') ? cell(ECOL.time, c.time) : null}
      {shown.has('who') ? cell(ECOL.who, c.who) : null}
      {shown.has('tool') ? cell(ECOL.tool, c.tool) : null}
      {cell(descW, c.desc)}
      {cell(ECOL.took, c.took, true)}
      {cell(ECOL.mark, c.mark, true)}
    </Box>
  )
  const line = (r: EventRow): RenderElement => {
    if (r.kind === 'break')
      return (
        <Box width={inner} flexShrink={0} overflow="hidden">
          <Text color={DT.textFaint} wrap="truncate">{`── ${fmtDate(r.ts)} ${'─'.repeat(inner)}`}</Text>
        </Box>
      )
    const { ev, outcome } = r
    const tone = outcome === 'failed' ? DT.fail : outcome === 'recovered' ? DT.orangeBright : DT.text
    return row({
      time: sub(fmtClock(ev.ts)),
      who: (
        <Text color={DT.orange} wrap="truncate">
          {kit.actorName(ev.actor)}
        </Text>
      ),
      tool: (
        <Text color={DT.text} bold wrap="truncate">
          {ev.tool}
        </Text>
      ),
      desc: (
        <Text color={tone} wrap="truncate">
          {ev.desc.replace(/\r\n?|\n/g, ' ')}
        </Text>
      ),
      took: sub(fmtMs(ev.ms)),
      mark: (
        <Text color={outcome === 'ok' ? DT.ok : outcome === 'recovered' ? DT.orangeBright : DT.fail} bold wrap="truncate">
          {outcome === 'ok' ? '✓' : outcome === 'recovered' ? '↻' : '✗'}
        </Text>
      ),
    })
  }
  const rowsShown = eventRows(list).slice(-Math.max(1, limit))
  return kit.card(
    top,
    rowsShown.length === 0
      ? [<Text color={DT.textSub}>{empty}</Text>]
      : [row({ time: sub('時間'), who: sub('誰'), tool: sub('工具'), desc: sub('描述'), took: sub('耗時'), mark: sub('結果') }), ...rowsShown.map(line)],
    undefined,
    true,
  )
}

// The rows an event card keeps: the room left under the title, tabs and the card's own frame.
const eventLimit = (rows: number, used: number): number => Math.max(MIN_EVENT_ROWS, rows - used)

// The event log: every call this session kept, held at the pause while paused.
function logPage(kit: KitA): RenderElement {
  const { Box, Text } = kit.ui
  const { view, ctx } = kit
  const total = view.events.length
  const list = ctx.paused ? view.events.slice(0, Math.max(0, total - ctx.fresh)) : view.events
  const top = topLine(
    kit.ui,
    [
      <Text color={DT.orange} bold>
        📜 事件流
      </Text>,
      ...(ctx.paused
        ? [
            <Text color={DT.data} bold>
              {`⏸ 已暫停 · 新增 ${ctx.fresh} 則`}
            </Text>,
          ]
        : []),
    ],
    <Text color={DT.textSub}>{`${total}/${MAX_EVENTS} 則`}</Text>,
  )
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {kit.pill('pause', ctx.paused ? '▶ 繼續' : '⏸ 暫停', ctx.paused, ctx.pause)}
      </Box>
      {eventsCard(kit, top, list, eventLimit(kit.rows, 14), '還沒有工具呼叫', true)}
    </Box>
  )
}

// ---- 任務 ----

// a task row's column past its title: its width, and when it gives way (higher first)
type Col = { w: number; node: RenderElement; drop: number }

const STATUS_WORD: Record<JarvisTaskStatus, { t: string; color: string }> = {
  in_progress: { t: '進行中', color: DT.data },
  pending: { t: '預計', color: DT.textSub },
  completed: { t: '完成', color: DT.ok },
}

// the board's three parts in order, each under its heading
const TASK_SECTIONS = [
  ['running', '進行中'],
  ['planned', '預計'],
  ['done', '已完成'],
] as const

// an item's or a subtask's indent under the row it belongs to
const TASK_INDENT = 2
// a status icon's cells
const ICON_W = 2

// A status's icon and its title's look: running lit, just completed bright.
function taskLook(status: JarvisTaskStatus, running: boolean, fresh: boolean): { icon: string; iconColor: string; title: string; bold: boolean } {
  if (status === 'in_progress' && running) return { icon: '◉', iconColor: DT.data, title: DT.orangeBright, bold: true }
  if (status === 'completed') return { icon: '✓', iconColor: fresh ? DT.orangeBright : DT.ok, title: fresh ? DT.orangeBright : DT.textSub, bold: false }
  return { icon: '○', iconColor: DT.textSub, title: DT.text, bold: false }
}

// The task board: each request or topic a raised tile under its part's heading; an item's row
// its icon, title (the press that folds or opens it), status, done/total and time; each
// subtask its icon, title, the tool its member runs, how its run stands, its time and MK-N.
function tasksPage(kit: KitA): RenderElement {
  const { Box, Text, Button } = kit.ui
  const { view, ctx } = kit
  const board = ctx.tasks ?? EMPTY_BOARD
  const folds = ctx.taskFolds ?? {}
  const now = view.now
  const agentById = new Map([...view.running, ...view.stale, ...view.finished].map(a => [a.id, a] as const))
  // a tile's inside: the card's less the tile's frame and padding
  const tileInner = Math.max(12, kit.cardInner - 4)

  const cell = (w: number, body: RenderElement, end = false): RenderElement => (
    <Box width={w} flexShrink={0} overflow="hidden" {...(end ? { justifyContent: 'flex-end' } : {})}>
      {body}
    </Box>
  )
  const faint = (t: string, color: string = DT.textSub): RenderElement => (
    <Text color={color} wrap="truncate">
      {t}
    </Text>
  )

  // A row `w` cells wide: the icon, the title, then the columns kept; those that would leave
  // the title under DESC_MIN cells give way in their order.
  const row = (w: number, icon: RenderElement, title: RenderElement, cols: readonly Col[]): RenderElement => {
    const kept = [...cols]
    const fixed = () => ICON_W + 1 + kept.reduce((sum, c) => sum + c.w + 1, 0)
    while (kept.length > 0 && w - fixed() < DESC_MIN) {
      const worst = kept.reduce((x, y) => (y.drop > x.drop ? y : x))
      kept.splice(kept.indexOf(worst), 1)
    }
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        {cell(ICON_W, icon)}
        {cell(Math.max(1, w - fixed()), title)}
        {kept.map(c => cell(c.w, c.node, true))}
      </Box>
    )
  }

  // the title as the press that folds (▾) or opens (▸) what is under it, else plain words
  const titleOf = (text: string, color: string, bold: boolean, fold?: { id: string; folded: boolean }): RenderElement => {
    const toggle = ctx.toggleTask
    if (fold === undefined || toggle === undefined)
      return (
        <Text color={color} bold={bold} wrap="truncate">
          {text}
        </Text>
      )
    return (
      <Button key={`task-${fold.id}`} plain onPress={() => toggle(fold.id, !fold.folded)}>
        <Text color={color} bold={bold} wrap="truncate">
          {`${fold.folded ? '▸' : '▾'} ${text}`}
        </Text>
      </Button>
    )
  }

  const indented = (body: readonly RenderElement[]): RenderElement => (
    <Box flexDirection="column" paddingLeft={TASK_INDENT}>
      {body}
    </Box>
  )

  // what an item or topic came to, under its title
  const resultLine = (w: number, result: string | undefined): RenderElement[] =>
    result === undefined || result === ''
      ? []
      : [
          <Box flexDirection="row" gap={1}>
            {cell(ICON_W, faint(' '))}
            {cell(Math.max(1, w - ICON_W - 1), faint(`→ ${result}`))}
          </Box>,
        ]

  // an item's or topic's right columns: its status, done/total and, while running, the time
  // since it began; the time gives way first, the status last
  const progressCols = (done: number, total: number, since: number | undefined, status: JarvisTaskStatus): Col[] => {
    const word = STATUS_WORD[status]
    return [
      { w: 6, node: faint(word.t, word.color), drop: 1 },
      ...(total > 0 ? [{ w: 5, node: faint(`${done}/${total}`), drop: 2 }] : []),
      ...(since === undefined ? [] : [{ w: 7, node: faint(fmtReadout(now - since), DT.data), drop: 3 }]),
    ]
  }

  // a subtask's right columns: its member's tool, how its run stands, its time, then MK-N,
  // which never gives way; without a member, its own time while running
  const subtaskRow = (s: JarvisSubtask, w: number): RenderElement => {
    const look = taskLook(s.status, s.status === 'in_progress', isFresh(s, now))
    const cols: Col[] = []
    if (s.agentId === undefined) {
      if (s.status === 'in_progress' && s.startedAt !== undefined) cols.push({ w: 7, node: faint(fmtReadout(now - s.startedAt), DT.data), drop: 2 })
    } else {
      const member = view.roster.get(s.agentId)
      const a = agentById.get(s.agentId)
      if (a !== undefined) {
        const took: Col = { w: 7, node: faint(fmtReadout(elapsedMs(a, now))), drop: 2 }
        if (a.status === 'running' && a.waiting === true) cols.push({ w: 4, node: faint('等待', DT.data), drop: 1 }, took)
        else if (a.status === 'running') {
          if (a.tool !== '') cols.push({ w: TOOL_MAX, node: faint(fitCells(a.tool, TOOL_MAX), DT.data), drop: 3 })
          cols.push(took)
        } else if (a.status === 'done' || a.status === 'failed')
          cols.push({ w: 4, node: faint(a.status === 'done' ? '完成' : '失敗', a.status === 'done' ? DT.ok : DT.fail), drop: 1 }, took)
        else cols.push({ w: 4, node: faint('失聯', DT.fail), drop: 1 })
      }
      cols.push({ w: 6, node: faint(member ? `MK-${member.n}` : 'MK', member?.color ?? DT.orange), drop: 0 })
    }
    return row(w, faint(look.icon, look.iconColor), titleOf(s.title, look.title, look.bold), cols)
  }

  const itemBlock = (item: JarvisTaskItem, w: number, title = item.title): RenderElement[] => {
    const status = itemStatus(item)
    const running = itemRunning(item)
    // a partly done item idle between subtasks stands still
    const look = taskLook(status, running, itemFresh(item, now))
    const folded = isFolded(item, folds)
    const done = item.subtasks.filter(s => s.status === 'completed').length
    const since = running ? itemStartedAt(item) : undefined
    const head = row(
      w,
      faint(look.icon, look.iconColor),
      titleOf(title, look.title, look.bold, item.subtasks.length > 0 ? { id: item.id, folded } : undefined),
      progressCols(done, item.subtasks.length, since, status),
    )
    const subs = folded || item.subtasks.length === 0 ? [] : [indented(item.subtasks.map(s => subtaskRow(s, w - TASK_INDENT)))]
    return [head, ...resultLine(w, item.result), ...subs]
  }

  // a topic of requests, or a request alone, as one raised tile; a topic of one request is
  // that request under the topic's title unless the model titled it
  const groupTile = (group: TaskGroup): RenderElement => {
    const topic = group.topic
    const [only] = group.items
    if (only !== undefined && (topic === undefined || group.items.length === 1))
      return kit.tile(itemBlock(only, tileInner, topic !== undefined && only.titleBy !== 'model' ? topic.title : only.title))
    if (topic === undefined) return kit.tile([])
    const status = groupStatus(group)
    const running = group.items.some(itemRunning)
    const look = taskLook(status, running, status === 'completed' && group.items.some(i => itemFresh(i, now)))
    const done = group.items.filter(i => itemStatus(i) === 'completed').length
    const starts = group.items.map(itemStartedAt).filter((t): t is number => t !== undefined)
    const since = running && starts.length > 0 ? Math.min(...starts) : undefined
    const folded = topicFolded(group, folds)
    const head = row(
      tileInner,
      faint(look.icon, look.iconColor),
      titleOf(topic.title, look.title, look.bold, { id: topicKey(topic.id), folded }),
      progressCols(done, group.items.length, since, status),
    )
    const result = group.items.findLast(i => i.result !== undefined)?.result
    return kit.tile([
      head,
      ...resultLine(tileInner, result),
      ...(folded ? [] : [indented(group.items.flatMap(i => itemBlock(i, tileInner - TASK_INDENT)))]),
    ])
  }

  const parts = boardGroups(board)
  const body: RenderElement[] =
    board.items.length === 0
      ? [<Text color={DT.textSub}>{EMPTY_TEXT}</Text>]
      : TASK_SECTIONS.flatMap(([key, label]) => {
          const groups = parts[key]
          if (groups.length === 0) return []
          return [
            <Box flexDirection="column" gap={1}>
              <Text color={DT.textSub} bold>{`${label} ${groups.length}`}</Text>
              {groups.map(groupTile)}
            </Box>,
          ]
        })
  return kit.card(kit.head('✅', '任務', countsText(boardCounts(board))), body, parts.running.length > 0 ? DT.orangeEdge : undefined)
}

// One of A_PAGES as `page` (from shownPageA).
export function drawPageA(kit: KitA, page: JarvisPage): RenderElement {
  return page === 'tasks' ? tasksPage(kit) : logPage(kit)
}
