import type { RenderElement } from 'claude-code'

import { MIN_EVENT_ROWS } from './cockpit'
import type { Ctx } from './cockpit'
import { DT } from './desktopTheme'
import type { DesktopUi } from './desktopView'
import { MAX_EVENTS, ROLES, eventRows, fmtClock, fmtDate, fmtMs } from './jarvis'
import type { Cockpit, EventRow } from './jarvis'
import type { JarvisEvent, JarvisPage } from '../types'

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
export const A_PAGES: readonly JarvisPage[] = ['log']

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

// One of A_PAGES as `page` (from shownPageA).
export function drawPageA(kit: KitA, page: JarvisPage): RenderElement {
  return page === 'log' ? logPage(kit) : logPage(kit)
}
