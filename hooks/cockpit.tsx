import type { EngineInterface, RenderElement } from 'claude-code'

import type { JarvisAgent, JarvisEvent, JarvisInflight, JarvisPage } from '../types'
import {
  CHAIN_WARN,
  FAMILY_COLOR,
  FAMILY_NAME,
  MAIN_ACTOR,
  MAX_EVENTS,
  MAX_NUMBERED,
  SLOW_MS,
  THEME,
  barLen,
  cellWidth,
  elapsedMs,
  eventRows,
  fitCells,
  fmtClock,
  fmtDate,
  fmtDur,
  fmtK,
  fmtMs,
  fmtReadout,
  fmtUsd,
  nameFamilyOf,
  padCells,
  phaseOf,
  reactorOf,
  shareLabel,
  shortModel,
  tokenTotal,
  tokensOf,
  WORKFLOW_TYPE,
} from './jarvis'
import type { BootStage, Cockpit, EventRow, Health, ListUnit, Lock, ModelShare, Outcome, Phase, Role, RoleStat } from './jarvis'

// At this many columns the stats page sets the main and dispatch cards side by side.
export const WIDE_COLS = 120
// Below this the stats page stacks the model and savings cards.
export const TINY_COLS = 64
export const MIN_EVENT_ROWS = 4
// Cells in the main chain bar: full at CHAIN_WARN calls.
const CHAIN_BAR = 16
// The least the now page gives the finished subagents (a workflow run is one unit) and
// the recent events; rows left over go to the finished ones first, then the events.
export const MIN_FINISHED = 3
export const MIN_RECENT = 3
// From this many columns a model badge carries its version: `[Sonnet 5.5]`.
export const BADGE_FULL_COLS = 90
// Cells a plain Button's hotkey takes before its label: `1: `.
const HOTKEY_W = 3
// The most rows a page is drawn for, whatever the room says.
const MAX_ROWS = 500
// Cells a chrome Button adds around its label: `[ ` and ` ]`.
const BUTTON_CHROME = 4
// From this many columns an event's actor reads `●MK-1`; below, `●1`.
const MK_ACTOR_COLS = 64

type Ui = Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Text' | 'Button'>

export type Seg = { t: string; color?: string; bg?: string; dim?: boolean; bold?: boolean; inverse?: boolean }

type Block = { node: RenderElement; h: number }

// A card line is a row of segments, or a ready node that takes `h` rows (the role boxes).
type Line = Seg[] | { node: RenderElement; h: number }

type CardSpec = { w: number; color: string; lines: Line[] }

export type Ctx = {
  cols: number
  rows: number
  // the spinner's frame, and the scan sweep's, at this tick
  frame: string
  scan: string
  // the tick count: the arc reactor's pulse
  beat: number
  // the boot screen while it plays
  boot?: BootStage
  // the key of the Button the pane's focus ring is on, '' for none
  focus: string
  page: JarvisPage
  // the subagent the detail page is about
  agentId: string
  paused: boolean
  // events recorded since the pause
  fresh: number
  go: (page: JarvisPage) => void
  open: (agentId: string) => void
  pause: () => void
}

const FRAME = THEME.frame
const PRIMARY = THEME.primary
const ACCENT = THEME.accent
const BRIGHT = THEME.bright
const ERROR = THEME.error
const MUTED = THEME.muted

export const TITLE = '⌜ J.A.R.V.I.S. ⌝'

const HEALTH_COLOR: Record<Health, string> = { ok: PRIMARY, loop: ERROR, stuck: ERROR }

export const HEALTH_TEXT: Record<Health, string> = {
  ok: 'ALL SYSTEMS NOMINAL',
  loop: 'WARNING: LOOP DETECTED',
  stuck: 'WARNING: STALL DETECTED',
}

// One color per role in the dispatch flow; the main loop is the accent gold everywhere.
export const ROLE_COLOR: Record<Role, string> = {
  Explore: '#3EC6FF',
  clerk: '#5EE6A8',
  worker: '#9B8CFF',
  verifier: '#FF8FB1',
  fork: '#E6A7FF',
  workflow: '#D4E157',
  other: MUTED,
}
export const MAIN_COLOR = ACCENT

// The frame colors of the now, log and detail pages' cards.
const LIST_COLOR = FRAME
const EVENT_COLOR = FRAME
const FLIGHT_COLOR = ACCENT
const IDLE_COLOR = MUTED

export const RECOVERED = '↻ RECOVERED'
// The recovered mark an event row too narrow for the word draws.
const RECOVERED_SHORT = '↻'

// A squad member's status words: full (the detail page), the label a card frames thinly
// when it has room, and the short form a narrow card falls back to.
const PHASE_TEXT: Record<Phase, { full: string; label: string; short: string }> = {
  init: { full: 'INITIALIZING…', label: 'INITIALIZING', short: 'INIT…' },
  active: { full: 'ACTIVE', label: 'ACTIVE', short: 'ACTIVE' },
  complete: { full: 'MISSION COMPLETE', label: 'MISSION COMPLETE', short: 'COMPLETE' },
  failed: { full: 'MISSION FAILED', label: 'MISSION FAILED', short: 'FAILED' },
  lost: { full: 'SIGNAL LOST', label: 'SIGNAL LOST', short: 'LOST' },
}

// A running squad member's target: lost while its latest call failed, relocked a moment
// after the retry worked; these words stand in for its status.
const LOCK_TEXT: Record<Lock, { full: string; short: string }> = {
  lost: { full: '⌖ TARGET LOST', short: '⌖ LOST' },
  relocked: { full: '↻ RELOCKED', short: '↻ LOCKED' },
}

// The thin frame round a card's full status label.
const frameLabel = (text: string) => `⎸${text}⎹`

// The tag after a card's elapsed readout, left out when narrow.
const ELAPSED = ' ELAPSED'

// A card's corner brackets round its mark: the number is the hotkey's, which the engine
// draws before a plain Button's label; the focused card's are the lock-on arrows. A
// compact card draws them tight.
const BRACKET = {
  live: { wide: '⌜ MK ⌝', compact: '⌜MK⌝' },
  done: { wide: '⌞ MK ⌟', compact: '⌞MK⌟' },
  locked: { wide: '► MK ◄', compact: '►MK◄' },
} as const

// How a squad card fits its width, roomiest first: the ELAPSED tag, the full status words,
// the model badge, the type, the spaced brackets and full scan icon, the tokens. The first
// whose description keeps its least is drawn, else NARROWEST.
type RowFit = { tag: boolean; full: boolean; badge: boolean; name: boolean; compact: boolean; tokens: boolean }
const ROW_FITS: RowFit[] = [
  { tag: true, full: true, badge: true, name: true, compact: false, tokens: true },
  { tag: false, full: true, badge: true, name: true, compact: false, tokens: true },
  { tag: false, full: false, badge: true, name: true, compact: false, tokens: true },
  { tag: false, full: false, badge: false, name: true, compact: false, tokens: true },
  { tag: false, full: false, badge: false, name: false, compact: false, tokens: true },
  { tag: false, full: false, badge: false, name: false, compact: true, tokens: true },
]
const NARROWEST: RowFit = { tag: false, full: false, badge: false, name: false, compact: true, tokens: false }

// The least a squad card's description keeps before its status words go short, and
// beside the ELAPSED tag.
const DESC_MIN = 8
const TAG_DESC_MIN = 20

const TABS: { page: JarvisPage; hotkey: string; label: string }[] = [
  { page: 'now', hotkey: 'n', label: '現況' },
  { page: 'log', hotkey: 'l', label: '事件流' },
  { page: 'stats', hotkey: 's', label: '統計' },
]

const BLANK: Seg[] = [{ t: ' ' }]

const typeLabel = (type: string): string => (type === WORKFLOW_TYPE ? 'workflow' : type)

const sp = (n: number): Seg => ({ t: ' '.repeat(Math.max(0, n)) })

const segsWidth = (segs: readonly Seg[]): number => segs.reduce((n, s) => n + cellWidth(s.t), 0)

// Cuts a line to `width` cells; the segment that overruns ends in an ellipsis, unless
// only its trailing padding was cut.
function clip(segs: readonly Seg[], width: number): Seg[] {
  const out: Seg[] = []
  let left = width
  for (const s of segs) {
    if (left <= 0) break
    const w = cellWidth(s.t)
    if (w <= left) {
      out.push(s)
      left -= w
    } else {
      const bare = s.t.trimEnd()
      out.push({ ...s, t: cellWidth(bare) <= left ? padCells(bare, left) : fitCells(s.t, left) })
      break
    }
  }
  return out
}

function centered(segs: readonly Seg[], width: number): Seg[] {
  const clipped = clip(segs, width)
  const gap = Math.max(0, width - segsWidth(clipped))
  const left = Math.floor(gap / 2)
  return [sp(left), ...clipped, sp(gap - left)]
}

// `left` and `right` on one line of `width` cells, the gap between them.
function leftRight(left: readonly Seg[], right: readonly Seg[], width: number): Seg[] {
  const r = clip(right, width)
  const l = clip(left, Math.max(0, width - segsWidth(r) - 1))
  return [...l, sp(width - segsWidth(l) - segsWidth(r)), ...r]
}

// `n` cells split into `count` columns `gap` apart: the first columns take the remainder.
export function splitCols(total: number, count: number, gap = 1): number[] {
  const avail = Math.max(count, total - (count - 1) * gap)
  const base = Math.floor(avail / count)
  const extra = avail - base * count
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0))
}

export function eventDuration(ms: number): Seg {
  return ms > SLOW_MS ? { t: fmtMs(ms), color: ACCENT } : { t: fmtMs(ms), dim: true }
}

// How a role box shows its counts: `執行中 1 · 完成 3` on one line, the two on two
// lines, or `▶1 ✓3`.
export type RoleFormat = 'full' | 'two' | 'compact'

export type RoleLayout = {
  // boxes per row, and each box's outer width in a row
  perRow: number
  widths: number[]
  format: RoleFormat
  // false only when even one box to a row cannot hold the text: the text is then cut
  fits: boolean
}

export const roleName = (r: RoleStat): string => (r.failed > 0 ? `${r.label} ✗${r.failed}` : r.label)

export function roleStatLines(r: RoleStat, format: RoleFormat): string[] {
  if (format === 'full') return [`執行中 ${r.running} · 完成 ${r.done}`]
  if (format === 'two') return [`執行中 ${r.running}`, `完成 ${r.done}`]
  return [`▶${r.running} ✓${r.done}`]
}

// The fewest rows of role boxes, `inner` cells across, whose text fits each box inside
// its border; the full line keeps a cell of room either side.
export function roleLayout(roles: readonly RoleStat[], inner: number): RoleLayout {
  const count = Math.max(1, roles.length)
  const need = (format: RoleFormat) =>
    Math.max(
      0,
      ...roles.map(r =>
        Math.max(cellWidth(roleName(r)), ...roleStatLines(r, format).map(cellWidth)) + (format === 'full' ? 2 : 0),
      ),
    )
  for (let rows = 1; rows <= count; rows += 1) {
    const perRow = Math.ceil(count / rows)
    const widths = splitCols(inner, perRow)
    const boxInner = Math.min(...widths) - 2
    for (const format of ['full', 'two', 'compact'] as const) {
      if (need(format) <= boxInner) return { perRow, widths, format, fits: true }
    }
  }
  return { perRow: 1, widths: [inner], format: 'compact', fits: false }
}

export function drawCockpit(ui: Ui, view: Cockpit, ctx: Ctx): RenderElement {
  const { Box, Text, Button } = ui
  const cols = ctx.cols
  // a room the surface could not measure is drawn as if 40 rows tall
  const rows = Number.isFinite(ctx.rows) && ctx.rows > 0 ? Math.min(ctx.rows, MAX_ROWS) : 40
  const wide = cols >= WIDE_COLS

  const style = (s: Seg) => ({
    ...(s.color ? { color: s.color } : {}),
    ...(s.bg ? { backgroundColor: s.bg } : {}),
    ...(s.dim ? { dimColor: true } : {}),
    ...(s.bold ? { bold: true } : {}),
    ...(s.inverse ? { inverse: true } : {}),
  })

  const texts = (segs: readonly Seg[]) => segs.filter(s => s.t !== '').map(s => <Text {...style(s)}>{s.t}</Text>)

  const lineNode = (segs: readonly Seg[]) => <Box flexDirection="row">{texts(segs)}</Box>

  const card = (spec: CardSpec, height: number): Block => {
    const inner = Math.max(1, spec.w - 4)
    return {
      h: height,
      node: (
        <Box
          flexDirection="column"
          width={spec.w}
          height={height}
          borderStyle="round"
          paddingX={1}
          borderColor={spec.color}
        >
          {spec.lines.map(l => (Array.isArray(l) ? lineNode(clip(l, inner)) : l.node))}
        </Box>
      ),
    }
  }

  const heightOf = (spec: CardSpec) =>
    spec.lines.reduce((n, l) => n + (Array.isArray(l) ? 1 : l.h), 2)

  // The card `h` rows tall, the room it gains split above and below what follows its title.
  const stretched = (spec: CardSpec, h: number): CardSpec => {
    const extra = Math.max(0, h - heightOf(spec))
    const [head, ...rest] = spec.lines
    const top = Math.floor(extra / 2)
    const blank = (n: number): Line[] => Array.from({ length: n }, () => BLANK)
    return { ...spec, lines: [...(head ? [head] : []), ...blank(top), ...rest, ...blank(extra - top)] }
  }

  // Cards stacked in one column `height` rows tall: the last one takes the rows left over.
  const column = (specs: CardSpec[], height: number): RenderElement => {
    const used = specs.slice(0, -1).reduce((n, x) => n + heightOf(x), 0)
    return (
      <Box flexDirection="column">
        {specs.map((x, i) => {
          const last = i === specs.length - 1
          const spec = last ? stretched(x, height - used) : x
          return card(spec, heightOf(spec)).node
        })}
      </Box>
    )
  }

  // Cards on one row, as tall as the tallest; `center` sets each one's body in its middle.
  const cardRow = (specs: CardSpec[], center = false): Block => {
    const tall = Math.max(...specs.map(heightOf))
    return {
      h: tall,
      node: (
        <Box flexDirection="row" gap={1}>
          {specs.map(s => card(center ? stretched(s, tall) : s, tall).node)}
        </Box>
      ),
    }
  }

  const title = (text: string, color: string): Seg => ({ t: text, color, bold: true })

  // the model as a badge: `[Sonnet 5.5]`, or below BADGE_FULL_COLS the bare family name
  const badgeText = (model: string): string => {
    if (cols >= BADGE_FULL_COLS) return `[${shortModel(model)}]`
    const family = nameFamilyOf(model)
    return family ? FAMILY_NAME[family] : fitCells(shortModel(model), 8)
  }

  const badge = (model: string): Seg => {
    const family = nameFamilyOf(model)
    return family ? { t: badgeText(model), color: FAMILY_COLOR[family] } : { t: badgeText(model), dim: true }
  }

  // who ran a call: the main loop by name, a listed squad member as `●MK-N` (narrow, `●N`)
  // in its color
  const mkActor = cols >= MK_ACTOR_COLS
  const ACTOR_W = mkActor ? 6 : 5
  const actorSeg = (actor: string): Seg => {
    if (actor === MAIN_ACTOR) return { t: padCells('主線', ACTOR_W), color: MAIN_COLOR, bold: true }
    const member = view.roster.get(actor)
    return member
      ? { t: padCells(mkActor ? `●MK-${member.n}` : `●${member.n}`, ACTOR_W), color: member.color }
      : { t: padCells('●?', ACTOR_W), color: MUTED }
  }

  const listed = [...view.running, ...view.stale, ...view.finished]
  const selected = ctx.page === 'detail' ? listed.find(a => a.id === ctx.agentId) : undefined
  // a detail page whose subagent left the list is the now page
  const page: JarvisPage = ctx.page === 'detail' && !selected ? 'now' : ctx.page

  // ---- 標題列 -------------------------------------------------------------

  // the title in the suit's red and gold, the arc reactor pulsing while a squad member
  // runs, and the health on the right
  const titleBar = (): Block => {
    const reactor = reactorOf(ctx.beat, view.running.length > 0)
    const left: Seg[] = [
      { t: '⌜ ', color: THEME.suitGold, bold: true },
      { t: 'J.A.R.V.I.S.', color: THEME.suitRed, bold: true },
      { t: ' ⌝', color: THEME.suitGold, bold: true },
      sp(1),
      { t: reactor.glyph, color: reactor.color },
    ]
    const health: Seg = { t: HEALTH_TEXT[view.health], color: HEALTH_COLOR[view.health], bold: true }
    return { h: 1, node: lineNode(leftRight(left, [health], cols)) }
  }

  // ---- 分頁列 -------------------------------------------------------------

  const tabBar = (): Block => {
    const buttons: { node: RenderElement; w: number }[] = TABS.map(tab => {
      const current = tab.page === page
      const text = `${tab.hotkey} ${tab.label}`
      return {
        w: cellWidth(text) + BUTTON_CHROME,
        node: (
          <Button
            key={`tab-${tab.page}`}
            hotkey={tab.hotkey}
            onPress={() => ctx.go(tab.page)}
            {...(current ? { variant: 'primary' as const } : { dimColor: true })}
          >
            {current ? <Text bold inverse>{text}</Text> : text}
          </Button>
        ),
      }
    })
    const action = (key: string, hotkey: string, label: string, run: () => void) => {
      const text = `${hotkey} ${label}`
      buttons.push({
        w: cellWidth(text) + BUTTON_CHROME,
        node: (
          <Button key={key} hotkey={hotkey} onPress={run}>
            {text}
          </Button>
        ),
      })
    }
    if (page === 'detail') action('back', '0', '返回', () => ctx.go('now'))
    if (page === 'log') action('pause', 'p', ctx.paused ? '繼續' : '暫停', ctx.pause)

    return {
      h: 1,
      node: (
        <Box flexDirection="row" gap={1}>
          {buttons.map(b => b.node)}
        </Box>
      ),
    }
  }

  // ---- 事件 ---------------------------------------------------------------

  // The tool column: as wide as the widest tool listed, 4 to 12 cells.
  const toolWidth = (tools: readonly string[]) => Math.min(12, Math.max(4, ...tools.map(cellWidth)))

  const mark = (outcome: Outcome, markW: number): Seg =>
    outcome === 'ok'
      ? { t: padCells('[✓]', markW), color: PRIMARY }
      : outcome === 'recovered'
        ? { t: padCells(markW < cellWidth(RECOVERED) ? RECOVERED_SHORT : RECOVERED, markW), color: BRIGHT, bold: true }
        : { t: padCells('[✗]', markW), color: ERROR, bold: true }

  // the description's cells in an event row `inner` wide, its mark `markW`
  const eventDescW = (inner: number, toolW: number, markW: number, withActor: boolean) =>
    inner - (8 + 1 + (withActor ? ACTOR_W + 1 : 0) + toolW + 1) - (1 + 6 + 1 + markW)

  // `withActor` false leaves out who ran the call: the detail page's events are all one agent's
  const eventLine = (ev: JarvisEvent, outcome: Outcome, inner: number, toolW: number, markW: number, withActor: boolean): Seg[] => {
    const durW = 6
    const descW = Math.max(4, eventDescW(inner, toolW, markW, withActor))
    const dur = eventDuration(ev.ms)
    const tone: Partial<Seg> = outcome === 'failed' ? { color: ERROR } : outcome === 'recovered' ? { color: BRIGHT } : {}
    return [
      { t: fmtClock(ev.ts), dim: true },
      sp(1),
      ...(withActor ? [actorSeg(ev.actor), sp(1)] : []),
      { t: padCells(ev.tool, toolW), bold: true },
      sp(1),
      { t: padCells(ev.desc, descW), ...tone },
      sp(1),
      { ...dur, t: padCells(dur.t, durW, 'right') },
      sp(1),
      mark(outcome, markW),
    ]
  }

  // the rule between two runs of events more than BREAK_MS apart, dated by the later one
  const breakLine = (ts: number, inner: number): Seg[] => {
    const label = `── ${fmtDate(ts)} `
    return [{ t: label + '─'.repeat(Math.max(0, inner - cellWidth(label))), color: MUTED }]
  }

  // A card of events, the newest `room - 3` rows of `list` (dated rules count) at the
  // bottom; `fill` makes it `room` rows tall however few there are.
  const eventCard = (
    head: Seg[],
    list: readonly JarvisEvent[],
    room: number,
    empty: string,
    fill: boolean,
    withActor = true,
  ): Block => {
    const inner = cols - 4
    const shown = eventRows(list).slice(-Math.max(1, room - 3))
    const evs = shown.flatMap(r => (r.kind === 'event' ? [r] : []))
    const toolW = toolWidth(evs.map(r => r.ev.tool))
    // the recovered word when the description keeps its least beside it, else the short mark
    const wordW = cellWidth(RECOVERED)
    const markW =
      evs.some(r => r.outcome === 'recovered') && eventDescW(inner, toolW, wordW, withActor) >= DESC_MIN ? wordW : 3
    const line = (r: EventRow): Seg[] =>
      r.kind === 'break' ? breakLine(r.ts, inner) : eventLine(r.ev, r.outcome, inner, toolW, markW, withActor)
    const body: Line[] = shown.length === 0 ? [[{ t: empty, dim: true }]] : shown.map(line)
    return card({ w: cols, color: EVENT_COLOR, lines: [head, ...body] }, fill ? Math.max(room, body.length + 3) : body.length + 3)
  }

  // ---- 主線 -------------------------------------------------------------

  const m = view.main
  const warn = m.chain >= CHAIN_WARN

  const mainSpec = (w: number): CardSpec => {
    const inner = w - 4
    const family = nameFamilyOf(m.model)
    const head: Seg[] = [title('主線', PRIMARY)]
    if (m.model !== '') {
      head.push({ t: ` · ${shortModel(m.model)}`, ...(family ? { color: FAMILY_COLOR[family] } : { dim: true }) })
    }
    const state: Seg = m.isRunning ? { t: '● 執行中', color: PRIMARY } : { t: '○ 閒置', dim: true }

    const labelW = 8
    const barW = Math.max(4, Math.min(CHAIN_BAR, inner - labelW - 1 - 1 - 5))
    const fill = Math.min(barW, Math.round((Math.min(m.chain, CHAIN_WARN) / CHAIN_WARN) * barW))
    const barColor = warn ? ERROR : PRIMARY
    const chain: Seg[] = [
      { t: padCells('連續呼叫', labelW), dim: true },
      sp(1),
      { t: '█'.repeat(fill), color: barColor },
      { t: '░'.repeat(barW - fill), dim: true },
      sp(1),
      warn
        ? { t: `${m.chain}/${CHAIN_WARN}`, color: ERROR, bold: true }
        : { t: `${m.chain}/${CHAIN_WARN}` },
    ]

    const scale = Math.max(m.ok, m.fail, 1)
    const outW = Math.max(4, Math.min(24, inner - labelW - 1 - 1 - 4))
    const outcome = (label: string, n: number, color: string): Seg[] => [
      { t: padCells(label, labelW), color },
      sp(1),
      { t: '█'.repeat(barLen(n, scale, outW)), color },
      sp(1),
      { t: String(n), bold: true },
    ]

    const last: Seg[] =
      m.lastTool === ''
        ? [{ t: padCells('最近', labelW), dim: true }, sp(1), { t: '—', dim: true }]
        : [
            { t: padCells('最近', labelW), dim: true },
            sp(1),
            { t: m.lastTool, bold: true },
            { t: m.lastDesc === '' ? '' : ` ${m.lastDesc}`, dim: true },
          ]

    return {
      w,
      color: FRAME,
      // the wide card sits beside the taller dispatch flow and spaces its parts out
      lines: wide
        ? [leftRight(head, [state], inner), BLANK, chain, BLANK, outcome('成功', m.ok, PRIMARY), outcome('失敗', m.fail, ERROR), BLANK, last]
        : [leftRight(head, [state], inner), chain, outcome('成功', m.ok, PRIMARY), outcome('失敗', m.fail, ERROR), last],
    }
  }

  // ---- 派工流程 ---------------------------------------------------------

  // `extra`: rows to grow by, kept as even space above and below the flow; an odd row
  // lengthens the arrow from the main session.
  const dispatchSpec = (w: number, extra = 0): CardSpec => {
    const inner = w - 4
    const roles = view.dispatch.filter(
      r => (r.role !== 'other' && r.role !== 'workflow') || r.running + r.done + r.failed > 0,
    )
    const layout = roleLayout(roles, inner)
    const boxH = 2 + 1 + (layout.format === 'two' ? 2 : 1)

    const box = (r: RoleStat, bw: number) => {
      const active = r.running > 0
      const iw = bw - 2
      const tone: Partial<Seg> = active ? { color: ACCENT, bold: true } : { dim: true }
      const name: Seg[] = [{ t: r.label, bold: true, color: ROLE_COLOR[r.role] }]
      if (r.failed > 0) name.push({ t: ` ✗${r.failed}`, color: ERROR })
      const stats = roleStatLines(r, layout.format)
      const stat: Seg[][] =
        layout.format === 'two'
          ? [
              [{ t: stats[0] ?? '', ...tone }],
              [{ t: stats[1] ?? '', ...(r.done > 0 ? { color: PRIMARY } : { dim: true }) }],
            ]
          : [[{ t: stats[0] ?? '', ...tone }]]
      return (
        <Box
          key={`role-${r.role}`}
          flexDirection="column"
          width={bw}
          height={boxH}
          borderStyle="round"
          borderColor={active ? ACCENT : MUTED}
        >
          {[name, ...stat].map(l => lineNode(centered(l, iw)))}
        </Box>
      )
    }

    const boxRows: RoleStat[][] = []
    for (let i = 0; i < roles.length; i += layout.perRow) boxRows.push(roles.slice(i, i + layout.perRow))
    const roleRows = {
      h: boxH * boxRows.length,
      node: (
        <Box flexDirection="column">
          {boxRows.map(row => (
            <Box flexDirection="row" gap={1}>
              {row.map((r, i) => box(r, layout.widths[i] ?? 4))}
            </Box>
          ))}
        </Box>
      ),
    }

    const arrow = centered([{ t: '▼', color: ACCENT }], inner)
    const top = centered(
      [{ t: m.model === '' ? '主 session' : `主 session · ${shortModel(m.model)}`, bold: true }],
      inner,
    )
    return {
      w,
      color: ACCENT,
      lines: [
        [title('派工流程', ACCENT)],
        ...Array.from({ length: Math.floor(extra / 2) }, () => BLANK),
        top,
        ...(extra % 2 === 1 ? [centered([{ t: '│', color: ACCENT }], inner)] : []),
        arrow,
        roleRows,
        arrow,
        centered([{ t: '回主線', bold: true }], inner),
        ...Array.from({ length: Math.floor(extra / 2) }, () => BLANK),
      ],
    }
  }

  // ---- 模型、省錢 ---------------------------------------------------------

  const sum = view.summary
  const savedPct = sum.savedPct === undefined ? undefined : Math.round(sum.savedPct)
  const savedBig: Seg =
    savedPct === undefined
      ? { t: '未計價', dim: true, bold: true }
      : savedPct >= 0
        ? { t: `省${savedPct}%`, color: BRIGHT, bold: true }
        : { t: `多花${-savedPct}%`, color: ERROR, bold: true }
  const savedSub: Seg =
    savedPct === undefined
      ? { t: '沒有可計價的模型', dim: true }
      : { t: `≈${fmtUsd(sum.cost)} vs Opus ${fmtUsd(sum.opusCost)}` }

  // The shares with each family's dispatch count, a rule, then the savings: one line, or
  // two when the figures do not fit beside the verdict.
  const modelSpec = (w: number): CardSpec => {
    const inner = w - 4
    const labelW = 7
    const pctW = 4
    const countOf = (r: ModelShare) => `×${r.count}`
    const countW = Math.max(0, ...view.models.map(r => cellWidth(countOf(r))))
    const barW = Math.max(3, inner - labelW - countW - 2 - pctW)
    const row = (r: ModelShare): Seg[] => {
      const color = r.family ? FAMILY_COLOR[r.family] : MUTED
      const head: Seg[] = [{ t: padCells(r.label, labelW), color }, { t: padCells(countOf(r), countW), dim: true }, sp(1)]
      if (!r.family) return [...head, { t: '未計價', dim: true }]
      const len = Math.max(1, barLen(r.share, 1, barW))
      return [
        ...head,
        { t: '█'.repeat(len), color },
        { t: '░'.repeat(barW - len), dim: true },
        { t: padCells(shareLabel(r.share), pctW + 1, 'right') },
      ]
    }
    const body: Seg[][] =
      view.models.length === 0 ? [[{ t: '還沒有 subagent', dim: true }]] : view.models.map(row)
    const verdict: Seg[] = [title('省錢', ACCENT), sp(2), savedBig]
    const figures: Seg[] = [savedSub]
    const savings: Seg[][] =
      segsWidth(verdict) + 1 + segsWidth(figures) <= inner
        ? [leftRight(verdict, figures, inner)]
        : [verdict, leftRight([], figures, inner)]
    return {
      w,
      color: FRAME,
      lines: [[title('模型', PRIMARY)], ...body, [{ t: '─'.repeat(inner), color: FRAME }], ...savings],
    }
  }

  // ---- 子代理清單 ---------------------------------------------------------

  type Group = Extract<ListUnit, { kind: 'workflow' }>
  type Item =
    | { kind: 'section'; seg: Seg }
    | { kind: 'agent'; a: JarvisAgent; member?: 'mid' | 'last' }
    | { kind: 'group'; u: Group }
    | { kind: 'more'; n: number }

  const finishedUnits = view.sections.find(x => x.status === 'finished')?.units ?? []
  const agentsIn = (u: ListUnit) => (u.kind === 'agent' ? 1 : u.agents.length)

  // The list's rows, top to bottom, with the latest `shownFinished` finished units.
  const listItems = (shownFinished: number): Item[] => {
    const label: Record<string, Seg> = {
      running: { t: `執行中 (${view.running.length})`, dim: true },
      stale: { t: `失聯 (${view.stale.length})`, color: MUTED },
      finished: { t: `已完成 (${view.finished.length})`, dim: true },
    }
    const items: Item[] = []
    for (const section of view.sections) {
      // one section needs no header: the title's counts already say what it is
      if (view.sections.length > 1) items.push({ kind: 'section', seg: label[section.status] ?? { t: '' } })
      const cap = section.status === 'finished' ? shownFinished : Infinity
      for (const u of section.units.slice(0, cap)) {
        if (u.kind === 'agent') {
          items.push({ kind: 'agent', a: u.agent })
        } else {
          items.push({ kind: 'group', u })
          u.agents.forEach((a, i) => items.push({ kind: 'agent', a, member: i === u.agents.length - 1 ? 'last' : 'mid' }))
        }
      }
      const hidden = section.units.slice(cap).reduce((n, u) => n + agentsIn(u), 0)
      if (hidden > 0) items.push({ kind: 'more', n: hidden })
    }
    return items
  }

  // rows the list card takes with `shownFinished` finished units: its border, title and rows
  const listHeight = (shownFinished: number) =>
    view.sections.length === 0 ? 4 : listItems(shownFinished).length + 3

  const memberOf = (a: JarvisAgent) => view.roster.get(a.id) ?? { n: 0, color: PRIMARY }

  // a squad member's mark: MK-1, MK-2, ...
  const mkOf = (a: JarvisAgent) => `MK-${memberOf(a).n}`

  const agentBlock = (shownFinished: number, room: number): Block => {
    const inner = cols - 4
    const done = view.finished.filter(a => a.status === 'done').length
    const failed = view.finished.length - done
    const counts: Seg[] = [
      ...(view.running.length > 0 ? [{ t: `▶${view.running.length} 執行中`, color: PRIMARY, bold: true }] : []),
      ...(done > 0 ? [{ t: `✓${done} 完成`, color: MUTED }] : []),
      ...(failed > 0 ? [{ t: `✗${failed} 失敗`, color: ERROR }] : []),
      ...(view.stale.length > 0 ? [{ t: `?${view.stale.length} 失聯`, color: MUTED }] : []),
    ]
    const right = counts.flatMap((x, i): Seg[] => (i === 0 ? [x] : [{ t: ' · ', dim: true }, x]))
    const head: Line = leftRight([title('子代理', PRIMARY)], right, inner)
    if (view.sections.length === 0) {
      return cardRow([{ w: cols, color: LIST_COLOR, lines: [head, [{ t: '還沒有派工。派出 subagent 後這裡會即時顯示。', dim: true }]] }])
    }

    const items = listItems(shownFinished)
    const agentsShown = items.flatMap(x => (x.kind === 'agent' ? [x] : []))
    const phase = (a: JarvisAgent) => phaseOf(a, view.now)
    // a compact card's scan sweep is one cell of it
    const icon = (a: JarvisAgent, compact: boolean): string => {
      const p = phase(a)
      if (p === 'init') return compact ? [...ctx.scan][0] ?? '' : ctx.scan
      return p === 'active' ? ctx.frame : p === 'complete' ? '✓' : p === 'failed' ? '✗' : '?'
    }
    const iconW = (compact: boolean) => Math.max(1, ...agentsShown.map(x => cellWidth(icon(x.a, compact))))
    const nameW = Math.min(15, Math.max(4, ...agentsShown.filter(x => !x.member).map(x => cellWidth(typeLabel(x.a.type)))))
    const badgeW = Math.max(...agentsShown.map(x => cellWidth(badgeText(x.a.model))))
    const readoutOf = (a: JarvisAgent) => fmtReadout(elapsedMs(a, view.now))
    const metaOf = (a: JarvisAgent) => {
      const n = tokenTotal(tokensOf(a))
      return a.status === 'running' && n === 0 ? '' : fmtK(n)
    }
    const statusOf = (a: JarvisAgent, full: boolean): string => {
      const lock = view.locks.get(a.id)
      if (lock) return full ? LOCK_TEXT[lock].full : LOCK_TEXT[lock].short
      const p = phase(a)
      if (!full) return PHASE_TEXT[p].short
      const label = frameLabel(PHASE_TEXT[p].label)
      return p === 'active' && a.tool !== '' ? `${label} ${fitCells(a.tool, 10)}` : label
    }
    const readW = Math.max(...agentsShown.map(x => cellWidth(readoutOf(x.a))))
    const metaW = Math.max(...agentsShown.map(x => cellWidth(metaOf(x.a))))
    const statusW = (full: boolean) => Math.max(...agentsShown.map(x => cellWidth(statusOf(x.a, full))))
    const width = inner - HOTKEY_W
    // the left part before the description, and the right column: status, elapsed, tokens
    const leftW = (f: RowFit) =>
      cellWidth(f.compact ? BRACKET.live.compact : BRACKET.live.wide) +
      1 +
      iconW(f.compact) +
      1 +
      (f.name ? nameW + 1 : 0) +
      (f.badge ? badgeW + 1 : 0)
    const rightW = (f: RowFit) =>
      1 +
      statusW(f.full) +
      1 +
      readW +
      (f.tag ? cellWidth(ELAPSED) : 0) +
      (f.tokens ? (f.compact ? 1 : 2) + metaW : 0)
    const descOf = (f: RowFit) => width - leftW(f) - rightW(f)
    const rowFit = ROW_FITS.find(f => descOf(f) >= (f.tag ? TAG_DESC_MIN : DESC_MIN)) ?? NARROWEST
    const { full, tag, compact } = rowFit
    const stW = statusW(full)
    const descW = Math.max(0, descOf(rowFit))
    const icW = iconW(compact)
    const bracketOf = (kind: keyof typeof BRACKET) => (compact ? BRACKET[kind].compact : BRACKET[kind].wide)

    // the focused card, locked on: under the engine's inverse every text's color becomes
    // the bar's background, so each takes the dark blue and puts what it shows behind it;
    // what is dark blue already shows ice blue, or it would vanish into the bar
    const lockOn = (segs: readonly Seg[]): Seg[] =>
      segs.map((s, i) => ({
        t: i === 0 ? bracketOf('locked') : s.t,
        color: MUTED,
        bg: i === 0 ? ACCENT : s.color === undefined || s.color === MUTED ? PRIMARY : s.color,
        ...(s.bold || i === 0 ? { bold: true } : {}),
      }))

    const row = (a: JarvisAgent, member?: 'mid' | 'last'): Line => {
      const p = phase(a)
      const { n, color } = memberOf(a)
      const live = p === 'init' || p === 'active'
      const lock = view.locks.get(a.id)
      // a finished, failed or lost card is all in the muted tone
      const tone: Partial<Seg> = live ? {} : { color: MUTED }
      const statusColor =
        lock === 'lost'
          ? ERROR
          : lock === 'relocked'
            ? BRIGHT
            : p === 'init'
              ? PRIMARY
              : p === 'active'
                ? ACCENT
                : p === 'failed'
                  ? ERROR
                  : MUTED
      const name: Seg = member
        ? { t: padCells(member === 'last' ? '└─' : '├─', nameW), color: live ? ROLE_COLOR.workflow : MUTED }
        : { t: padCells(typeLabel(a.type), nameW), bold: true, color: live ? color : MUTED }
      const b = badge(a.model)
      const left: Seg[] = [
        {
          t: bracketOf(a.status === 'running' ? 'live' : 'done'),
          color: lock === 'lost' ? ERROR : live ? color : MUTED,
          bold: live,
        },
        sp(1),
        { t: padCells(icon(a, compact), icW), color: live ? color : p === 'failed' ? ERROR : MUTED },
        sp(1),
        ...(rowFit.name ? [name, sp(1)] : []),
        ...(rowFit.badge ? [{ ...b, t: padCells(b.t, badgeW), ...tone }, sp(1)] : []),
        { t: padCells(a.description, descW), ...tone },
      ]
      const rightCol: Seg[] = [
        sp(1),
        { t: padCells(statusOf(a, full), stW, 'right'), color: statusColor, bold: live },
        sp(1),
        { t: padCells(readoutOf(a), readW, 'right'), ...(live ? { color: BRIGHT, bold: true } : tone) },
        ...(tag ? [{ t: ELAPSED, color: MUTED }] : []),
        ...(rowFit.tokens
          ? [sp(compact ? 1 : 2), { t: padCells(metaOf(a), metaW, 'right'), ...(live ? { dim: true } : tone) }]
          : []),
      ]
      // too narrow for the left part whole: it gives way, the right column stays
      const segs = [...clip(left, Math.max(0, width - segsWidth(rightCol))), ...clip(rightCol, width)]
      if (n < 1 || n > MAX_NUMBERED) return [{ t: padCells(n < 1 ? '' : `${n}:`, HOTKEY_W), dim: true }, ...segs]
      const key = `agent-${n}`
      return {
        h: 1,
        node: (
          <Box flexDirection="row">
            <Button key={key} hotkey={String(n)} plain onPress={() => ctx.open(a.id)}>
              {texts(ctx.focus === key ? lockOn(segs) : segs)}
            </Button>
          </Box>
        ),
      }
    }

    const groupHead = (u: Group): Seg[] => {
      const count = (st: JarvisAgent['status']) => u.agents.filter(a => a.status === st).length
      const parts = [
        `${u.agents.length} 個`,
        ...([
          ['執行中', count('running')],
          ['完成', count('done')],
          ['失敗', count('failed')],
          ['失聯', count('stale')],
        ] as const)
          .filter(([, n]) => n > 0)
          .map(([text, n]) => `${text} ${n}`),
      ]
      const id = u.runId === '' ? '(無 id)' : fitCells(u.runId, 8)
      return [
        sp(HOTKEY_W),
        { t: '▾ ', color: ROLE_COLOR.workflow },
        { t: 'workflow', bold: true, color: ROLE_COLOR.workflow },
        { t: ` ${id}`, color: MUTED },
        { t: ` · ${parts.join(' · ')}`, dim: true },
      ]
    }

    const body: Line[] = items.map(x =>
      x.kind === 'section'
        ? [x.seg]
        : x.kind === 'group'
          ? groupHead(x.u)
          : x.kind === 'more'
            ? [sp(HOTKEY_W), { t: `… 還有 ${x.n} 個`, dim: true }]
            : row(x.a, x.member),
    )
    const fit = Math.max(4, room - 3)
    const lines =
      body.length > fit
        ? [...body.slice(0, fit - 1), [sp(HOTKEY_W), { t: `… 還有 ${body.length - fit + 1} 列未顯示`, dim: true }] as Seg[]]
        : body
    return cardRow([{ w: cols, color: LIST_COLOR, lines: [head, ...lines] }])
  }

  // ---- 進行中 -------------------------------------------------------------

  const inflightBlock = (): Block => {
    const inner = cols - 4
    const list = view.inflight
    const color = list.length > 0 ? FLIGHT_COLOR : IDLE_COLOR
    const head = leftRight(
      [title('進行中', color)],
      list.length > 0 ? [{ t: `${list.length} 個`, dim: true }] : [],
      inner,
    )
    const toolW = toolWidth(list.map(f => f.tool))
    const durW = 6
    const descW = Math.max(4, inner - (ACTOR_W + 1 + toolW + 1) - (1 + durW))
    const line = (f: JarvisInflight): Seg[] => {
      const dur = eventDuration(view.now - f.startedAt)
      return [
        actorSeg(f.actor),
        sp(1),
        { t: padCells(f.tool, toolW), bold: true },
        sp(1),
        { t: padCells(f.desc ?? '', descW) },
        sp(1),
        { ...dur, t: padCells(dur.t, durW, 'right') },
      ]
    }
    const body: Line[] =
      list.length === 0 ? [[{ t: '目前沒有執行中的工具呼叫', dim: true }]] : list.map(line)
    return cardRow([{ w: cols, color, lines: [head, ...body] }])
  }

  // ---- 細節頁 -------------------------------------------------------------

  // a token count: 1.2k, 61k, 2.4M
  const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : fmtK(n))

  const detailBlock = (a: JarvisAgent): Block => {
    const labelW = 9
    const color = memberOf(a).color
    const field = (label: string, value: Seg[]): Seg[] => [{ t: padCells(label, labelW), dim: true }, ...value]
    const p = phaseOf(a, view.now)
    const words = PHASE_TEXT[p].full
    const status: Seg[] =
      p === 'init'
        ? [{ t: `${ctx.scan} ${words}`, color: PRIMARY, bold: true }]
        : p === 'active'
          ? [{ t: `${ctx.frame} ${words}`, color: ACCENT, bold: true }, ...(a.tool !== '' ? [{ t: ` · ${a.tool}`, dim: true }] : [])]
          : p === 'complete'
            ? [{ t: `✓ ${words}`, color: MUTED }]
            : p === 'failed'
              ? [{ t: `✗ ${words}`, color: ERROR }]
              : [{ t: `? ${words}`, color: MUTED }]
    const lines: Line[] = [
      [
        { t: `${a.status === 'running' ? `⌜ ${mkOf(a)} ⌝` : `⌞ ${mkOf(a)} ⌟`} `, color, bold: true },
        title('子代理', color),
        { t: ` · ${typeLabel(a.type)}`, bold: true, color },
      ],
      field('類型', [{ t: a.type, bold: true, color }]),
      field('模型', [{ ...badge(a.model), t: shortModel(a.model) }]),
      field('狀態', status),
      field('任務', [{ t: a.description }]),
      field('開始', [{ t: fmtClock(a.runStartedAt) }]),
      field('耗時', [{ t: fmtDur(elapsedMs(a, view.now)), color: BRIGHT, bold: true }]),
      field('Token', [{ t: `輸入 ${tokens(a.input)} · 輸出 ${tokens(a.output)}` }]),
      // cache traffic is most of a subagent's input: shown so the counts match the cost
      ...(a.cacheRead + a.cacheWrite > 0
        ? [
            field('快取', [
              {
                t: [
                  ...(a.cacheRead > 0 ? [`讀取 ${tokens(a.cacheRead)}`] : []),
                  ...(a.cacheWrite > 0 ? [`寫入 ${tokens(a.cacheWrite)}`] : []),
                ].join(' · '),
              },
            ]),
          ]
        : []),
    ]
    if (a.runId !== undefined) {
      const id = a.runId === '' ? '(無 id)' : a.runId
      lines.push(
        field('Workflow', [
          { t: id, color: ROLE_COLOR.workflow },
          ...(a.agentIndex !== undefined ? [{ t: ` · 第 ${a.agentIndex} 個`, dim: true }] : []),
        ]),
      )
    }
    return cardRow([{ w: cols, color, lines }])
  }

  // ---- 開機 ---------------------------------------------------------------

  const bootBlock = (stage: BootStage): Block => {
    const lines: Seg[][] = [BLANK, centered([{ t: 'J.A.R.V.I.S. ONLINE', color: BRIGHT, bold: true }], cols)]
    if (stage.phase === 'loading') {
      const barW = Math.max(4, Math.min(24, cols - 8))
      const fill = Math.round((stage.pct / 100) * barW)
      lines.push(
        centered([{ t: 'LOADING CREW MANIFEST… ', color: PRIMARY }, { t: `${stage.pct}%`, color: ACCENT, bold: true }], cols),
        centered([{ t: '█'.repeat(fill), color: ACCENT }, { t: '░'.repeat(barW - fill), color: MUTED }], cols),
      )
    }
    return { h: lines.length, node: <Box flexDirection="column">{lines.map(lineNode)}</Box> }
  }

  if (ctx.boot) {
    return (
      <Box flexDirection="column">
        {titleBar().node}
        {bootBlock(ctx.boot).node}
      </Box>
    )
  }

  // ---- 組版 ---------------------------------------------------------------

  const blocks: Block[] = [titleBar(), tabBar()]
  const left = () => rows - blocks.reduce((n, b) => n + b.h, 0)
  let footer: RenderElement | undefined

  if (page === 'now') {
    // the least each card needs, then the rows left over: finished subagents first, then events
    const flight = inflightBlock()
    // event rows: a dated rule takes a row like an event
    const total = eventRows(view.events).length
    const recentH = (n: number) => Math.max(1, n) + 3
    const room = left() - flight.h
    let shown = Math.min(finishedUnits.length, MIN_FINISHED)
    let recent = Math.min(total, MIN_RECENT)
    while (shown < finishedUnits.length && listHeight(shown + 1) + recentH(recent) <= room) shown += 1
    recent = Math.max(recent, Math.min(total, room - listHeight(shown) - 3))
    blocks.push(agentBlock(shown, room - recentH(recent)), flight)
    blocks.push(eventCard([title('最近事件', PRIMARY)], view.events, recentH(recent), '還沒有工具呼叫', false))
  } else if (page === 'log') {
    const total = view.events.length
    const list = ctx.paused ? view.events.slice(0, Math.max(0, total - ctx.fresh)) : view.events
    const head = leftRight(
      [
        title('事件流', PRIMARY),
        ...(ctx.paused ? [sp(1), { t: `⏸ 已暫停 · 新增 ${ctx.fresh} 則`, color: ACCENT, bold: true }] : []),
      ],
      [{ t: `${total}/${MAX_EVENTS} 則`, dim: true }],
      cols - 4,
    )
    blocks.push(eventCard(head, list, Math.max(MIN_EVENT_ROWS + 3, left()), '還沒有工具呼叫', true))
  } else if (page === 'detail' && selected) {
    blocks.push(detailBlock(selected))
    const own = view.events.filter(ev => ev.actor === selected.id)
    const head = leftRight(
      [title('事件流', PRIMARY), { t: ' · 這個 subagent', dim: true }],
      [{ t: `${own.length} 則`, dim: true }],
      cols - 4,
    )
    blocks.push(eventCard(head, own, Math.max(MIN_EVENT_ROWS + 3, left()), '這個 subagent 還沒有工具呼叫', true, false))
  } else {
    if (wide) {
      // main over model (the savings under its shares) beside the dispatch flow, one height
      const side = Math.max(44, Math.min(64, cols - 115))
      const leftSpecs = [mainSpec(side), modelSpec(side)]
      const leftH = leftSpecs.reduce((n, x) => n + heightOf(x), 0)
      const flow = dispatchSpec(cols - side - 1)
      const right = dispatchSpec(cols - side - 1, Math.max(0, leftH - heightOf(flow)))
      const tall = Math.max(leftH, heightOf(right))
      blocks.push({
        h: tall,
        node: (
          <Box flexDirection="row" gap={1}>
            {column(leftSpecs, tall)}
            {column([right], tall)}
          </Box>
        ),
      })
    } else {
      blocks.push(cardRow([mainSpec(cols)]), cardRow([dispatchSpec(cols)]), cardRow([modelSpec(cols)]))
    }
    if (view.summary.groups.length === 0) {
      footer = <Text dimColor>{fitCells('還沒有派工。派出 subagent 後這裡會即時顯示。', cols)}</Text>
    }
  }

  return (
    <Box flexDirection="column">
      {blocks.map(b => b.node)}
      {footer ?? null}
    </Box>
  )
}
