import type { EngineInterface, RenderElement } from 'claude-code'

import type {
  FleetQuota,
  FleetSession,
  FleetStatus,
  FleetView,
  JarvisAgent,
  JarvisEvent,
  JarvisInflight,
  JarvisPage,
  QuotaWindow,
} from '../types'
import { fleetSections, fmtAgo, fmtBig, wrapCells } from './fleet'
import { BURN_RAMP, bigText, bigWidth, brailleLine, burnChart, cellsToSegs, rampBar, stackedBar } from './fleetChart'
import type { Cell, StackPart } from './fleetChart'
import { idlePerRow, planFleet } from './fleetLayout'
import type { FleetMode, FleetPlan } from './fleetLayout'
import { FAIL_WARN, planStats, roleBeats, successRate } from './statsView'
import {
  SCAN_SIDE_MIN_COLS,
  SUIT_BLOCK_ROWS,
  SUIT_CANVAS_COLS,
  SUIT_COLS,
  SUIT_REST_TICK_MS,
  SUIT_ROWS,
  SUIT_TICK_MS,
  SUIT_UNDER_ROWS,
  crewDeployed,
  readoutMeterW,
  sideReadout,
  standbyReadouts,
  suitCells,
  suitFrame,
  suitResting,
} from './suit'
import type { Readout } from './suit'
import { CHANGE_ICON, PHASE_ICON, ROLE_ICON, SECTION_ICON, TAB_ICON, TITLE_ICON, withIcon } from './icons'
import { MAX_LISTED, diffLines } from './changesView'
import type { ChangeEntry, ChangeGroup, ChangesView } from './changesView'
import { isFailed } from './gitDiff'
import type { DiffRow, Failed } from './gitDiff'
import { tailCells } from './changes'
import type { ChangeMode } from './changes'
import { hourlyOf, idleHourMax, idleSummary, reactorRows, sectionHeader, smallCard, suitLine, wideCard, windowFoot } from './fleetCards'
import type { CardLines } from './fleetCards'
import {
  CHAIN_WARN,
  FAMILY_COLOR,
  FAMILY_NAME,
  JARVIS_PALETTE,
  MAIN_ACTOR,
  MAX_EVENTS,
  SLOW_MS,
  THEME,
  cellWidth,
  dispatchRoleOf,
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
  roleModels,
  shareLabel,
  shortModel,
  tokenTotal,
  tokensOf,
  topTools,
  WORKFLOW_TYPE,
} from './jarvis'
import type { BootStage, Cockpit, EventRow, Health, ListUnit, Lock, ModelShare, Outcome, Phase, Role, RoleStat } from './jarvis'

export const MIN_EVENT_ROWS = 4
// The dispatch card draws each role's last hour once its inside is this wide.
export const BEATS_MIN_INNER = 56
// The braille line a role gets, and the room after its counts.
const ROLE_BEAT_W = 10
const ROLE_EXTRA_W = 12
// The dispatch card's model column at its widest: `Sonnet+`, a longer unknown name cut.
const MODEL_COL_MAX = 8
// The now page's rows, in this order: every running subagent; the standby suit over the
// latest MIN_SUIT_FINISHED finished (a workflow run is one unit), or without it the latest
// MIN_FINISHED; the in-flight card; the recent events, MIN_RECENT of them or the card left
// out; then more finished, then more events.
export const MIN_FINISHED = 8
const MIN_SUIT_FINISHED = 3
export const MIN_RECENT = 3
// The suit is drawn only with this many cells beside its canvas (or, booting, its art).
const SUIT_MARGIN = 4
// The boot's rows below the title with the suit: a blank, the suit and a blank, ONLINE
// and the loading two.
const BOOT_SUIT_H = 1 + SUIT_ROWS + 1 + 3
// The standby suit in its sights: a blank cell and a corner either side of the canvas.
const SCAN_FRAME_W = SUIT_CANVAS_COLS + 4
// From this many columns a model badge carries its version: `[Sonnet 5.5]`.
export const BADGE_FULL_COLS = 90
// The most rows a page is drawn for, whatever the room says.
const MAX_ROWS = 500
// Cells between two buttons of the tab bar.
const TAB_GAP = 2
// From this many columns an event's actor reads `MK-1`; below, `1`.
const MK_ACTOR_COLS = 64

type Ui = Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Text' | 'Button'>

export type Seg = { t: string; color?: string; bg?: string; bold?: boolean; inverse?: boolean }

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
  page: JarvisPage
  // the subagent the detail page is about
  agentId: string
  paused: boolean
  // events recorded since the pause
  fresh: number
  go: (page: JarvisPage) => void
  open: (agentId: string) => void
  pause: () => void
  // the fleet page: what the last refresh saw, whether herdr is there to ask, the session
  // its detail page is about, and this session's id (its row is marked THIS)
  fleet: FleetView
  herdr: boolean
  paneId: string
  sessionId: string
  openFleet: (paneId: string) => void
  jump: (paneId: string) => void
  // the standby suit's readouts: the usagebar cache, and when the session started
  quota?: FleetQuota
  startedAt?: number
  // the standby suit's frame, and when a crew member was last deployed
  suitTick?: number
  deployedAt?: number
  // the standby suit held still by a press, and the press that holds or plays it
  suitPaused?: boolean
  toggleSuit?: () => void
  // told each drawing whether the standby suit was drawn, and drawn and playing, its frame time
  onStandby?: (drawn: boolean, periodMs?: number) => void
  // the changes page: what it lists, and the presses that switch its mode, ask git again
  // and open one file's diff page
  changes?: ChangesView
  setChangesMode?: (mode: ChangeMode) => void
  refreshChanges?: () => void
  openDiff?: (key: string) => void
  // the diff page: the row's key it is about, and its diff as git gave it; undefined
  // while git works it out
  diff?: { key: string; rows: DiffRow[] | Failed | undefined }
}

const FRAME = THEME.frame
const PRIMARY = THEME.primary
const ACCENT = THEME.accent
const BRIGHT = THEME.bright
const ERROR = THEME.error
const MUTED = THEME.muted
const SUCCESS = THEME.success

export const TITLE = '⌜ J.A.R.V.I.S. ⌝'

const HEALTH_COLOR: Record<Health, string> = { ok: PRIMARY, loop: ERROR, stuck: ERROR }

export const HEALTH_TEXT: Record<Health, string> = {
  ok: 'ALL SYSTEMS NOMINAL',
  loop: 'WARNING: LOOP DETECTED',
  stuck: 'WARNING: STALL DETECTED',
}

// One color per role in the dispatch flow, from the squad palette; the main loop is the
// accent ice blue everywhere.
export const ROLE_COLOR: Record<Role, string> = {
  Explore: JARVIS_PALETTE[0],
  clerk: JARVIS_PALETTE[1],
  worker: JARVIS_PALETTE[2],
  verifier: JARVIS_PALETTE[3],
  fork: JARVIS_PALETTE[5],
  workflow: JARVIS_PALETTE[4],
  other: FRAME,
}
export const MAIN_COLOR = ACCENT

// The frame colors of the now, log and detail pages' cards.
const LIST_COLOR = FRAME
const EVENT_COLOR = FRAME
const FLIGHT_COLOR = ACCENT
const IDLE_COLOR = MUTED
// A tool's name in an event or in flight: a label in the frame gold, bold, beside the
// amber of what it did.
const TOOL_COLOR = FRAME

export const RECOVERED = '↻'

// A squad member's status words: full (the detail page), the label a card frames thinly
// when it has room, and the short form a narrow card falls back to.
const PHASE_TEXT: Record<Phase, { full: string; label: string; short: string }> = {
  init: { full: 'INITIALIZING…', label: 'INITIALIZING', short: 'INIT…' },
  active: { full: 'ACTIVE', label: 'ACTIVE', short: 'ACTIVE' },
  waiting: { full: 'WAITING ON BACKGROUND', label: 'WAITING', short: 'WAIT' },
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

// A card's corner brackets round its mark, `⌜MK-N⌝` while it runs and `⌞MK-N⌟` once done: the
// MK-N the events name. A workflow member, which has no number, draws a bare `MK`.
const BRACKET = {
  live: ['⌜', '⌝'],
  done: ['⌞', '⌟'],
} as const

// How a squad card fits its width, roomiest first: the ELAPSED tag, the full status words,
// the model badge, the type, the full scan icon and token gap, the tokens. The first
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

const TABS: { page: JarvisPage; icon: string; label: string }[] = [
  { page: 'now', icon: TAB_ICON.now, label: '現況' },
  { page: 'log', icon: TAB_ICON.log, label: '事件流' },
  { page: 'stats', icon: TAB_ICON.stats, label: '統計' },
  { page: 'fleet', icon: TAB_ICON.fleet, label: '艦隊' },
  { page: 'changes', icon: TAB_ICON.changes, label: '異動' },
]

// The burn chart's width at each breakpoint but wide (which takes the pane less 4).
const BURN_MID_W = 48
const BURN_NARROW_W = 24
const QUOTA_WINDOWS = [
  { key: 'fiveHour', label: '5H' },
  { key: 'sevenDay', label: '7D' },
] as const

const FLEET_STATUS_TEXT: Record<FleetStatus, { t: string; color: string }> = {
  blocked: { t: 'AWAITING ORDERS', color: THEME.error },
  working: { t: 'IN FLIGHT', color: THEME.accent },
  idle: { t: 'STANDBY', color: THEME.frame },
}

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
  return { t: fmtMs(ms), color: ms > SLOW_MS ? ACCENT : FRAME }
}

export function drawCockpit(ui: Ui, view: Cockpit, ctx: Ctx): RenderElement {
  const { Box, Text, Button } = ui
  const cols = ctx.cols
  // a room the surface could not measure is drawn as if 40 rows tall
  const rows = Number.isFinite(ctx.rows) && ctx.rows > 0 ? Math.min(ctx.rows, MAX_ROWS) : 40

  const style = (s: Seg) => ({
    ...(s.color ? { color: s.color } : {}),
    ...(s.bg ? { backgroundColor: s.bg } : {}),
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

  const title = (icon: string, text: string, color: string): Seg => ({ t: withIcon(icon, text), color, bold: true })

  // the model as a badge: `[Sonnet 5.5]`, or below BADGE_FULL_COLS the bare family name
  const badgeText = (model: string): string => {
    if (cols >= BADGE_FULL_COLS) return `[${shortModel(model)}]`
    const family = nameFamilyOf(model)
    return family ? FAMILY_NAME[family] : fitCells(shortModel(model), 8)
  }

  const badge = (model: string): Seg => {
    const family = nameFamilyOf(model)
    return { t: badgeText(model), color: family ? FAMILY_COLOR[family] : FRAME }
  }

  // who ran a call: the main loop by name, a listed squad member as `MK-N` (narrow, `N`)
  // in its color; the column widens for a number of three digits or more
  const mkActor = cols >= MK_ACTOR_COLS
  const actorText = (n: number) => (mkActor ? `MK-${n}` : String(n))
  const ACTOR_W = Math.max(mkActor ? 5 : cellWidth('主線'), ...[...view.roster.values()].map(x => cellWidth(actorText(x.n))))
  const actorSeg = (actor: string): Seg => {
    if (actor === MAIN_ACTOR) return { t: padCells('主線', ACTOR_W), color: MAIN_COLOR, bold: true }
    const member = view.roster.get(actor)
    return member
      ? { t: padCells(actorText(member.n), ACTOR_W), color: member.color }
      : { t: padCells('?', ACTOR_W), color: FRAME }
  }

  const fleetView = ctx.fleet
  const fleetSelected = ctx.page === 'fleetDetail' ? fleetView.sessions.find(s => s.paneId === ctx.paneId) : undefined
  const listed = [...view.running, ...view.stale, ...view.finished]
  const selected = ctx.page === 'detail' ? listed.find(a => a.id === ctx.agentId) : undefined
  // the changes page's rows in the order listed, and the one the diff page is about
  const diffOrder = (ctx.changes?.groups ?? []).flatMap(g => g.entries.map(e => ({ g, e })))
  const diffAt = ctx.page === 'changeDiff' && ctx.diff ? diffOrder.findIndex(x => x.e.key === ctx.diff?.key) : -1
  // a detail page whose subagent, session or file left the list is its list page
  const page: JarvisPage =
    ctx.page === 'detail' && !selected
      ? 'now'
      : ctx.page === 'fleetDetail' && !fleetSelected
        ? 'fleet'
        : ctx.page === 'changeDiff' && diffAt < 0
          ? 'changes'
          : ctx.page
  const onFleet = page === 'fleet' || page === 'fleetDetail'

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
    const right: Seg =
      !onFleet || view.health !== 'ok'
        ? health
        : fleetView.linkLost
          ? { t: 'FLEET LINK LOST', color: ERROR, bold: true }
          : { t: `IRON LEGION · ${fleetView.sessions.length} SUITS`, color: PRIMARY, bold: true }
    return { h: 1, node: lineNode(leftRight(left, [right], cols)) }
  }

  // ---- 分頁列 -------------------------------------------------------------

  const tabBar = (): Block => {
    const actions: { key: string; label: string; run: () => void }[] = []
    if (page === 'detail') actions.push({ key: 'back', label: '返回', run: () => ctx.go('now') })
    if (page === 'fleetDetail') {
      actions.push({ key: 'back', label: '返回', run: () => ctx.go('fleet') })
      if (fleetSelected) {
        const paneId = fleetSelected.paneId
        actions.push({ key: 'jump', label: '跳轉', run: () => ctx.jump(paneId) })
      }
    }
    if (page === 'changeDiff') actions.push({ key: 'back', label: '返回', run: () => ctx.go('changes') })
    if (page === 'log') actions.push({ key: 'pause', label: ctx.paused ? '繼續' : '暫停', run: ctx.pause })
    const tabText = (tab: (typeof TABS)[number], compact: boolean) =>
      compact && tab.page !== page ? withIcon(tab.icon, '') : withIcon(tab.icon, tab.label)
    const actionText = (a: (typeof actions)[number], compact: boolean) => (compact ? [...a.label][0] ?? a.label : a.label)
    const widthOf = (tabsCompact: boolean, actionsCompact: boolean) =>
      [
        ...TABS.map(tab => cellWidth(tabText(tab, tabsCompact))),
        ...actions.map(a => cellWidth(actionText(a, actionsCompact))),
      ].reduce((n, w) => n + w, 0) +
      (TABS.length + actions.length - 1) * TAB_GAP
    // too wide for every label: the tabs not shown keep only their icon, then the actions their first character
    const tabsCompact = widthOf(false, false) > cols
    const actionsCompact = tabsCompact && widthOf(true, false) > cols
    const nodes: RenderElement[] = TABS.map(tab => {
      // the diff page is the changes tab's
      const current = tab.page === page || (page === 'changeDiff' && tab.page === 'changes')
      const text = tabText(tab, tabsCompact)
      return (
        <Button key={`tab-${tab.page}`} plain onPress={() => ctx.go(tab.page)}>
          {current ? (
            <Text bold inverse color={ACCENT}>
              {text}
            </Text>
          ) : (
            <Text color={FRAME}>{text}</Text>
          )}
        </Button>
      )
    })
    for (const a of actions) {
      nodes.push(
        <Button key={a.key} plain onPress={a.run}>
          <Text color={FRAME}>{actionText(a, actionsCompact)}</Text>
        </Button>,
      )
    }
    return {
      h: 1,
      node: (
        <Box flexDirection="row" gap={TAB_GAP}>
          {nodes}
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
        ? { t: padCells(RECOVERED, markW), color: BRIGHT, bold: true }
        : { t: padCells('[✗]', markW), color: ERROR, bold: true }

  // the description's cells in an event row `inner` wide, its mark `markW`
  const eventDescW = (inner: number, toolW: number, markW: number, withActor: boolean) =>
    inner - (8 + 1 + (withActor ? ACTOR_W + 1 : 0) + toolW + 1) - (1 + 6 + 1 + markW)

  // `withActor` false leaves out who ran the call: the detail page's events are all one agent's
  const eventLine = (ev: JarvisEvent, outcome: Outcome, inner: number, toolW: number, markW: number, withActor: boolean): Seg[] => {
    const durW = 6
    const descW = Math.max(4, eventDescW(inner, toolW, markW, withActor))
    const dur = eventDuration(ev.ms)
    const tone = outcome === 'failed' ? ERROR : outcome === 'recovered' ? BRIGHT : PRIMARY
    return [
      { t: fmtClock(ev.ts), color: FRAME },
      sp(1),
      ...(withActor ? [actorSeg(ev.actor), sp(1)] : []),
      { t: padCells(ev.tool, toolW), color: TOOL_COLOR, bold: true },
      sp(1),
      { t: padCells(ev.desc, descW), color: tone },
      sp(1),
      { ...dur, t: padCells(dur.t, durW, 'right') },
      sp(1),
      mark(outcome, markW),
    ]
  }

  // the rule between two runs of events more than BREAK_MS apart, dated by the later one:
  // the rule dark brown, the date in the frame gold
  const breakLine = (ts: number, inner: number): Seg[] => {
    const date = fmtDate(ts)
    return [
      { t: '── ', color: MUTED },
      { t: date, color: FRAME },
      { t: ` ${'─'.repeat(Math.max(0, inner - 4 - cellWidth(date)))}`, color: MUTED },
    ]
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
    // `[✓]`, `[✗]` or the recovered arrow
    const markW = 3
    const line = (r: EventRow): Seg[] =>
      r.kind === 'break' ? breakLine(r.ts, inner) : eventLine(r.ev, r.outcome, inner, toolW, markW, withActor)
    const body: Line[] = shown.length === 0 ? [[{ t: empty, color: FRAME }]] : shown.map(line)
    return card({ w: cols, color: EVENT_COLOR, lines: [head, ...body] }, fill ? Math.max(room, body.length + 3) : body.length + 3)
  }

  // ---- 統計 ---------------------------------------------------------------

  const m = view.main
  const warn = m.chain >= CHAIN_WARN
  const rate = successRate(m.ok, m.fail)
  const failHigh = rate !== undefined && m.fail / (m.ok + m.fail) >= FAIL_WARN
  const pctText = rate === undefined ? '--' : `${Math.round(rate * 100)}%`
  const statsRoles = view.dispatch.filter(
    r => (r.role !== 'other' && r.role !== 'workflow') || r.running + r.done + r.failed > 0,
  )
  const sum = view.summary
  const savedPct = sum.savedPct === undefined ? undefined : Math.round(sum.savedPct)

  const chartLine = (cells: readonly Cell[]): Seg[] => cellsToSegs(cells)

  // `segs` padded with blanks to `width` cells
  const padSegs = (segs: readonly Seg[], width: number): Seg[] => [...segs, sp(width - segsWidth(segs))]

  const mainStatsSpec = (w: number, mode: FleetMode): CardSpec => {
    const inner = w - 4
    const family = nameFamilyOf(m.model)
    const head: Seg[] = [title(TITLE_ICON.main, 'MAIN LINE', PRIMARY)]
    if (m.model !== '') head.push({ t: ` · ${shortModel(m.model)}`, color: family ? FAMILY_COLOR[family] : FRAME })
    const state: Seg = m.isRunning ? { t: '● 執行中', color: PRIMARY } : { t: '○ 閒置', color: FRAME }
    const lit = Math.min(m.chain, CHAIN_WARN)
    const chain: Seg[] = [
      { t: 'CHAIN ', color: FRAME },
      { t: '▰'.repeat(lit), color: warn ? ERROR : ACCENT },
      { t: '▱'.repeat(CHAIN_WARN - lit), color: MUTED },
      { t: ` ${m.chain}/${CHAIN_WARN}`, color: warn ? ERROR : PRIMARY, bold: warn },
    ]
    const last: Seg[] =
      m.lastTool === ''
        ? [{ t: 'LAST ', color: FRAME }, { t: '--', color: FRAME }]
        : [
            { t: 'LAST ', color: FRAME },
            { t: m.lastTool, color: TOOL_COLOR, bold: true },
            { t: m.lastDesc === '' ? '' : ` ${m.lastDesc}`, color: PRIMARY },
          ]
    const headLine = leftRight(head, [state], inner)
    const digits = bigText(pctText, failHigh ? ERROR : PRIMARY)
    const dW = bigWidth(pctText)
    const top = topTools(m.toolCounts, 2)
    const col1: Seg[][] = [
      [{ t: 'OK ', color: FRAME }, { t: String(m.ok), color: PRIMARY, bold: true }],
      [{ t: 'FAIL ', color: FRAME }, { t: String(m.fail), color: m.fail > 0 ? ERROR : FRAME, bold: m.fail > 0 }],
      [{ t: 'SUCCESS RATE', color: FRAME }],
    ]
    const col2: Seg[][] = [
      chain,
      top.length === 0
        ? [{ t: 'TOP ', color: FRAME }, { t: '--', color: FRAME }]
        : [
            { t: 'TOP ', color: FRAME },
            ...top.flatMap((x, i): Seg[] => [
              ...(i > 0 ? [{ t: ' · ', color: MUTED }] : []),
              { t: x.tool, color: TOOL_COLOR, bold: true },
              { t: ` ${x.count}`, color: PRIMARY },
            ]),
          ],
      last,
    ]
    const col1W = Math.max(...col1.map(segsWidth))
    if (mode === 'wide') {
      // half the pane leaves too little room beside the digits for both tools on one line
      const tool = (x: { tool: string; count: number }): Seg[] => [
        { t: x.tool, color: TOOL_COLOR, bold: true },
        { t: ` ${x.count}`, color: PRIMARY },
      ]
      const [first, second] = top
      const col2W: Seg[][] = [
        chain,
        [{ t: 'TOP ', color: FRAME }, ...(first ? tool(first) : [{ t: '--', color: FRAME }])],
        second ? [sp(cellWidth('TOP ')), ...tool(second)] : [],
        last,
      ]
      const rows = [0, 1, 2, 3].map(i => [
        ...(digits[i] ? chartLine(digits[i]) : [sp(dW)]),
        sp(2),
        ...padSegs(col1[i] ?? [], col1W),
        sp(2),
        ...clip(col2W[i] ?? [], Math.max(0, inner - dW - 2 - col1W - 2)),
      ])
      return { w, color: FRAME, lines: [headLine, ...rows] }
    }
    if (mode === 'narrow') {
      const under = [0, 1, 2].map(i => clip([...padSegs(col1[i] ?? [], col1W), sp(2), ...(col2[i] ?? [])], inner))
      return { w, color: FRAME, lines: [headLine, ...digits.map(r => chartLine(r)), ...under] }
    }
    const rows = [0, 1, 2].map(i => [
      ...chartLine(digits[i] ?? []),
      sp(2),
      ...padSegs(col1[i] ?? [], col1W),
      sp(2),
      ...clip(col2[i] ?? [], Math.max(0, inner - dW - 2 - col1W - 2)),
    ])
    return { w, color: FRAME, lines: [headLine, ...rows] }
  }

  // `cut`: rows for the roles, the last one saying how many more there are.
  const dispatchStatsSpec = (w: number, cut: number | undefined): CardSpec => {
    const inner = w - 4
    const showBeats = inner >= BEATS_MIN_INNER
    const beats = showBeats ? roleBeats(view.events, [...view.running, ...view.stale, ...view.finished], view.now) : new Map()
    const nameW = Math.max(4, ...statsRoles.map(r => cellWidth(r.label)))
    const numW = Math.max(1, ...statsRoles.map(r => String(r.done).length))
    const maxDone = Math.max(1, ...statsRoles.map(r => r.done))
    const models = roleModels([...view.running, ...view.stale, ...view.finished])
    const modelText = (role: Role) => {
      const x = models.get(role)
      return x ? x.label + (x.mixed ? '+' : '') : ''
    }
    const modelW = Math.min(MODEL_COL_MAX, Math.max(0, ...statsRoles.map(r => cellWidth(modelText(r.role)))))
    const barW = Math.max(
      3,
      inner - (2 + nameW + 1 + modelW + (modelW > 0 ? 1 : 0) + 1 + numW + 1 + ROLE_EXTRA_W + (showBeats ? 2 + ROLE_BEAT_W : 0)),
    )
    const extras = (r: RoleStat): Seg[] => {
      const parts: Seg[] = []
      if (r.running > 0) parts.push({ t: `▶${r.running}`, color: ACCENT, bold: true })
      if (r.failed > 0) parts.push({ t: `${parts.length > 0 ? ' ' : ''}FAIL ${r.failed}`, color: ERROR })
      const shown = clip(parts, ROLE_EXTRA_W)
      return [...shown, sp(ROLE_EXTRA_W - segsWidth(shown))]
    }
    const modelSeg = (role: Role): Seg => {
      const family = models.get(role)?.family
      return { t: padCells(fitCells(modelText(role), modelW), modelW), color: family ? FAMILY_COLOR[family] : FRAME }
    }
    const row = (r: RoleStat): Seg[] => {
      const active = r.running > 0
      const segs: Seg[] = [
        active ? { t: ROLE_ICON[r.role], color: ACCENT, bold: true } : { t: ROLE_ICON[r.role], color: FRAME },
        sp(1),
        { t: padCells(r.label, nameW), color: ROLE_COLOR[r.role], bold: true },
        sp(1),
        ...(modelW > 0 ? [modelSeg(r.role), sp(1)] : []),
        ...chartLine(rampBar(barW, r.done / maxDone, BURN_RAMP)),
        sp(1),
        { t: padCells(String(r.done), numW, 'right'), color: r.done > 0 ? BRIGHT : FRAME, bold: r.done > 0 },
        sp(1),
        ...extras(r),
      ]
      if (showBeats) segs.push(sp(2), { t: brailleLine(beats.get(r.role) ?? [], ROLE_BEAT_W), color: active ? ACCENT : FRAME })
      return segs
    }
    // one row only: every role on it, its done count and ▶ while running, cut to the card
    if (cut !== undefined && cut <= 1) {
      const brief: Seg[] = statsRoles.flatMap((r, i): Seg[] => [
        ...(i > 0 ? [{ t: ' · ', color: FRAME }] : []),
        { t: r.label, color: FRAME },
        ...(r.done > 0 || r.running === 0 ? [{ t: ` ${r.done}`, color: FRAME }] : []),
        ...(r.running > 0 ? [sp(1), { t: `▶${r.running}`, color: ACCENT, bold: true }] : []),
      ])
      return { w, color: ACCENT, lines: [[title(TITLE_ICON.dispatch, 'DISPATCH', ACCENT)], clip(brief, inner)] }
    }
    const shown = cut === undefined ? statsRoles : statsRoles.slice(0, Math.max(0, cut - 1))
    const more: Seg[][] = cut === undefined ? [] : [[{ t: `… 還有 ${statsRoles.length - shown.length} 種`, color: FRAME }]]
    return { w, color: ACCENT, lines: [[title(TITLE_ICON.dispatch, 'DISPATCH', ACCENT)], ...shown.map(row), ...more] }
  }

  const modelsStatsSpec = (w: number): CardSpec => {
    const inner = w - 4
    const head: Seg[] = [title(TITLE_ICON.models, 'MODELS', PRIMARY)]
    const verdict: Seg[] =
      savedPct === undefined
        ? [{ t: 'UNPRICED', color: FRAME, bold: true }]
        : savedPct >= 0
          ? [{ t: 'SAVED ', color: ACCENT, bold: true }, { t: `${savedPct}%`, color: BRIGHT, bold: true }]
          : [{ t: 'OVER ', color: ERROR, bold: true }, { t: `${-savedPct}%`, color: ERROR, bold: true }]
    const figures: Seg[] =
      savedPct === undefined
        ? [{ t: '沒有可計價的模型', color: FRAME }]
        : [{ t: `≈${fmtUsd(sum.cost)} vs Opus ${fmtUsd(sum.opusCost)}`, color: PRIMARY }]
    if (view.models.length === 0) return { w, color: FRAME, lines: [head, [{ t: '還沒有 subagent', color: FRAME }], verdict, figures] }
    const colorOf = (r: ModelShare) => (r.family ? FAMILY_COLOR[r.family] : FRAME)
    const labelW = Math.max(4, ...view.models.map(r => cellWidth(r.label)))
    const countW = Math.max(0, ...view.models.map(r => cellWidth(`×${r.count}`)))
    const shareText = (r: ModelShare) => (r.family ? shareLabel(r.share) : '未計價')
    const shareW = Math.max(4, ...view.models.map(r => cellWidth(shareText(r))))
    const share = (r: ModelShare): Seg => ({ t: padCells(shareText(r), shareW, 'right'), color: r.family ? PRIMARY : FRAME })
    const parts: StackPart[] = view.models.filter(r => r.family).map(r => ({ share: r.share, color: colorOf(r) }))
    const rows = view.models.map((r): Seg[] => [
      { t: padCells(r.label, labelW), color: colorOf(r), bold: true },
      sp(1),
      share(r),
      sp(1),
      { t: padCells(`×${r.count}`, countW), color: FRAME },
    ])
    return { w, color: FRAME, lines: [head, chartLine(stackedBar(inner, parts)), ...rows, verdict, figures] }
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
      running: { t: `執行中 (${view.running.length})`, color: FRAME },
      stale: { t: `失聯 (${view.stale.length})`, color: FRAME },
      finished: { t: `已完成 (${view.finished.length})`, color: FRAME },
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
      ...(done > 0 ? [{ t: `${done} 完成`, color: FRAME }] : []),
      ...(failed > 0 ? [{ t: `${failed} 失敗`, color: ERROR }] : []),
      ...(view.stale.length > 0 ? [{ t: `?${view.stale.length} 失聯`, color: FRAME }] : []),
    ]
    const right = counts.flatMap((x, i): Seg[] => (i === 0 ? [x] : [{ t: ' · ', color: MUTED }, x]))
    const head: Line = leftRight([title(TITLE_ICON.agents, '子代理', PRIMARY)], right, inner)
    if (view.sections.length === 0) {
      return cardRow([{ w: cols, color: LIST_COLOR, lines: [head, [{ t: '還沒有派工。派出 subagent 後這裡會即時顯示。', color: FRAME }]] }])
    }

    const items = listItems(shownFinished)
    const agentsShown = items.flatMap(x => (x.kind === 'agent' ? [x] : []))
    const phase = (a: JarvisAgent) => phaseOf(a, view.now)
    // a compact card's scan sweep is one cell of it
    const icon = (a: JarvisAgent, compact: boolean): string => {
      const p = phase(a)
      if (p === 'init') return compact ? [...ctx.scan][0] ?? '' : ctx.scan
      return p === 'active'
        ? ctx.frame
        : p === 'waiting'
          ? PHASE_ICON.waiting
          : p === 'complete'
            ? PHASE_ICON.complete
            : p === 'failed'
              ? PHASE_ICON.failed
              : '?'
    }
    const iconW = (compact: boolean) => Math.max(1, ...agentsShown.map(x => cellWidth(icon(x.a, compact))))
    const nameText = (a: JarvisAgent) => withIcon(ROLE_ICON[dispatchRoleOf(a)], typeLabel(a.type))
    const nameW = Math.min(15, Math.max(4, ...agentsShown.filter(x => !x.member).map(x => cellWidth(nameText(x.a)))))
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
    const width = inner
    const markOf = (a: JarvisAgent) => {
      const [open, close] = BRACKET[a.status === 'running' ? 'live' : 'done']
      const n = memberOf(a).n
      return `${open}${n < 1 ? 'MK' : `MK-${n}`}${close}`
    }
    // every mark is padded to the widest, so the icons after them line up
    const markW = Math.max(...agentsShown.map(x => cellWidth(markOf(x.a))))
    // the left part before the description, and the right column: status, elapsed, tokens
    const leftW = (f: RowFit) =>
      markW +
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

    const row = (a: JarvisAgent, member?: 'mid' | 'last'): Line => {
      const p = phase(a)
      const { n, color } = memberOf(a)
      const live = p === 'init' || p === 'active' || p === 'waiting'
      const lock = view.locks.get(a.id)
      // a finished, failed or lost card reads in the frame gold; its brackets and mark are
      // the dark brown
      const tone: Partial<Seg> = live ? {} : { color: FRAME }
      const statusColor =
        lock === 'lost'
          ? ERROR
          : lock === 'relocked'
            ? BRIGHT
            : p === 'init'
              ? PRIMARY
              : p === 'active' || p === 'waiting'
                ? ACCENT
                : p === 'failed'
                  ? ERROR
                  : FRAME
      const name: Seg = member
        ? { t: padCells(member === 'last' ? '└─' : '├─', nameW), color: live ? ROLE_COLOR.workflow : MUTED }
        : { t: padCells(nameText(a), nameW), bold: true, color: live ? color : FRAME }
      const b = badge(a.model)
      const left: Seg[] = [
        {
          t: markOf(a),
          color: lock === 'lost' ? ERROR : live ? color : FRAME,
          bold: live,
        },
        sp(markW - cellWidth(markOf(a)) + 1),
        { t: padCells(icon(a, compact), icW), color: live ? color : p === 'failed' ? ERROR : p === 'complete' ? SUCCESS : MUTED },
        sp(1),
        ...(rowFit.name ? [name, sp(1)] : []),
        ...(rowFit.badge ? [{ ...b, t: padCells(b.t, badgeW), ...tone }, sp(1)] : []),
        { t: padCells(a.description, descW), color: live ? PRIMARY : FRAME },
      ]
      const rightCol: Seg[] = [
        sp(1),
        { t: padCells(statusOf(a, full), stW, 'right'), color: statusColor, bold: live },
        sp(1),
        { t: padCells(readoutOf(a), readW, 'right'), ...(live ? { color: BRIGHT, bold: true } : tone) },
        ...(tag ? [{ t: ELAPSED, color: FRAME }] : []),
        ...(rowFit.tokens ? [sp(compact ? 1 : 2), { t: padCells(metaOf(a), metaW, 'right'), color: FRAME }] : []),
      ]
      // too narrow for the left part whole: it gives way, the right column stays
      const segs = [...clip(left, Math.max(0, width - segsWidth(rightCol))), ...clip(rightCol, width)]
      if (n < 1) return segs
      // Only the mark is the Button, so a pointer over the card inverts it alone.
      const [mark, ...rest] = segs
      const chip: Seg[] = [mark && mark.t !== '' ? mark : sp(1)]
      return {
        h: 1,
        node: (
          <Box flexDirection="row">
            <Button key={`agent-${n}`} plain onPress={() => ctx.open(a.id)}>
              {texts(chip)}
            </Button>
            {texts(rest)}
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
        { t: '▾ ', color: ROLE_COLOR.workflow },
        { t: 'workflow', bold: true, color: ROLE_COLOR.workflow },
        { t: ` ${id}`, color: FRAME },
        { t: ` · ${parts.join(' · ')}`, color: FRAME },
      ]
    }

    const body: Line[] = items.map(x =>
      x.kind === 'section'
        ? [x.seg]
        : x.kind === 'group'
          ? groupHead(x.u)
          : x.kind === 'more'
            ? [{ t: `… 還有 ${x.n} 個`, color: FRAME }]
            : row(x.a, x.member),
    )
    const fit = Math.max(4, room - 3)
    const lines =
      body.length > fit
        ? [...body.slice(0, fit - 1), [{ t: `… 還有 ${body.length - fit + 1} 列未顯示`, color: FRAME }] as Seg[]]
        : body
    return cardRow([{ w: cols, color: LIST_COLOR, lines: [head, ...lines] }])
  }

  // ---- 進行中 -------------------------------------------------------------

  const idleFlight: Line[] = [[{ t: '目前沒有執行中的工具呼叫', color: FRAME }]]

  // at most `cap` rows of calls, those that do not fit folded into `… 還有 N 個`
  const inflightBlock = (cap = Infinity): Block => {
    const inner = cols - 4
    const list = view.inflight
    const color = list.length > 0 ? FLIGHT_COLOR : IDLE_COLOR
    // the frame dark brown when idle, the title still in the frame gold
    const head = leftRight(
      [title(TITLE_ICON.inflight, '進行中', list.length > 0 ? FLIGHT_COLOR : FRAME)],
      list.length > 0 ? [{ t: `${list.length} 個`, color: FRAME }] : [],
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
        { t: padCells(f.tool, toolW), color: TOOL_COLOR, bold: true },
        sp(1),
        { t: padCells(f.desc ?? '', descW), color: PRIMARY },
        sp(1),
        { ...dur, t: padCells(dur.t, durW, 'right') },
      ]
    }
    const body: Line[] =
      list.length === 0
        ? idleFlight
        : list.length > cap
          ? [...list.slice(0, cap - 1).map(line), [{ t: `… 還有 ${list.length - cap + 1} 個`, color: FRAME }]]
          : list.map(line)
    return cardRow([{ w: cols, color, lines: [head, ...body] }])
  }

  // ---- 細節頁 -------------------------------------------------------------

  // a token count: 1.2k, 61k, 2.4M
  const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : fmtK(n))

  const detailBlock = (a: JarvisAgent): Block => {
    const labelW = 9
    const color = memberOf(a).color
    const field = (label: string, value: Seg[]): Seg[] => [{ t: padCells(label, labelW), color: FRAME }, ...value]
    const p = phaseOf(a, view.now)
    const words = PHASE_TEXT[p].full
    const status: Seg[] =
      p === 'init'
        ? [{ t: `${ctx.scan} ${words}`, color: PRIMARY, bold: true }]
        : p === 'active'
          ? [{ t: `${ctx.frame} ${words}`, color: ACCENT, bold: true }, ...(a.tool !== '' ? [{ t: ` · ${a.tool}`, color: FRAME }] : [])]
          : p === 'waiting'
            ? [{ t: withIcon(PHASE_ICON.waiting, words), color: ACCENT, bold: true }]
            : p === 'complete'
              ? [{ t: withIcon(PHASE_ICON.complete, ''), color: SUCCESS }, { t: words, color: FRAME }]
              : p === 'failed'
                ? [{ t: withIcon(PHASE_ICON.failed, words), color: ERROR }]
                : [{ t: `? ${words}`, color: FRAME }]
    const lines: Line[] = [
      [
        { t: `${a.status === 'running' ? `⌜ ${mkOf(a)} ⌝` : `⌞ ${mkOf(a)} ⌟`} `, color, bold: true },
        title(TITLE_ICON.agents, '子代理', color),
        { t: ` · ${typeLabel(a.type)}`, bold: true, color },
      ],
      field('類型', [{ t: a.type, bold: true, color }]),
      field('模型', [{ ...badge(a.model), t: shortModel(a.model) }]),
      field('狀態', status),
      field('任務', [{ t: a.description, color: PRIMARY }]),
      field('開始', [{ t: fmtClock(a.runStartedAt), color: PRIMARY }]),
      field('耗時', [{ t: fmtDur(elapsedMs(a, view.now)), color: BRIGHT, bold: true }]),
      field('Token', [{ t: `輸入 ${tokens(a.input)} · 輸出 ${tokens(a.output)}`, color: PRIMARY }]),
      // cache traffic is most of a subagent's input: shown so the counts match the cost
      ...(a.cacheRead + a.cacheWrite > 0
        ? [
            field('快取', [
              {
                t: [
                  ...(a.cacheRead > 0 ? [`讀取 ${tokens(a.cacheRead)}`] : []),
                  ...(a.cacheWrite > 0 ? [`寫入 ${tokens(a.cacheWrite)}`] : []),
                ].join(' · '),
                color: PRIMARY,
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
          ...(a.agentIndex !== undefined ? [{ t: ` · 第 ${a.agentIndex} 個`, color: FRAME }] : []),
        ]),
      )
    }
    return cardRow([{ w: cols, color, lines }])
  }

  // ---- 艦隊 ---------------------------------------------------------------

  const suitIcon = (s: FleetSession): Seg =>
    s.status === 'blocked'
      ? { t: '!', color: ERROR, bold: true }
      : s.status === 'working'
        ? { t: ctx.frame, color: ACCENT }
        : { t: '⣀', color: FRAME }

  // A suit's Button: the card's corner and icon (or a line's icon). Its `n` only keys it: the
  // order shifts as suits go busy or idle, so it is not drawn.
  const suitChip = (s: FleetSession, n: number, chip: Seg[]) => (
    <Button key={`suit-${n}`} plain onPress={() => ctx.openFleet(s.paneId)}>
      {texts(chip)}
    </Button>
  )

  // One card or line: the Button and its first row, the rows below.
  const suitBlock = (s: FleetSession, n: number, c: CardLines): Block => ({
    h: 1 + c.body.length,
    node: (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {suitChip(s, n, c.chip)}
          {texts(c.top)}
        </Box>
        {c.body.map(r => lineNode(r))}
      </Box>
    ),
  })

  // Cards side by side, one cell apart.
  const suitGrid = (group: { s: FleetSession; n: number; c: CardLines }[]): Block => {
    const tall = Math.max(0, ...group.map(g => g.c.body.length))
    return {
      h: 1 + tall,
      node: (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {group.flatMap((g, i) => [...(i > 0 ? texts([sp(1)]) : []), suitChip(g.s, g.n, g.c.chip), ...texts(g.c.top)])}
          </Box>
          {Array.from({ length: tall }, (_, j) =>
            lineNode(group.flatMap((g, i) => [...(i > 0 ? [sp(1)] : []), ...(g.c.body[j] ?? [])])),
          )}
        </Box>
      ),
    }
  }

  // The legion: the busy suits first (cards or lines), then the idle (cards, lines or the
  // summary), numbered in that order; cut by rows with a count when even lines do not fit.
  const legionBlocks = (plan: FleetPlan, active: FleetSession[], idle: FleetSession[]): Block[] => {
    if (active.length + idle.length === 0) {
      return [{ h: 1, node: lineNode([{ t: fleetView.at === 0 ? '掃描艦隊中…' : '艦隊目前沒有 Claude session', color: FRAME }]) }]
    }
    const now = view.now
    // every idle suit's day is scaled to the fleet's idle peak
    const idleMax = idleHourMax(idle)
    const opts = (s: FleetSession) => ({ now, self: ctx.sessionId !== '' && s.sessionId === ctx.sessionId, idleMax })
    const w = cols
    const spark = plan.mode === 'narrow' ? 6 : 10
    const units: { b: Block; suits: number }[] = []
    let n = 0
    for (const s of active) {
      n += 1
      const c = plan.active === 'cards' ? wideCard(s, w, opts(s)) : suitLine(s, w, { ...opts(s), spark })
      units.push({ b: suitBlock(s, n, c), suits: 1 })
    }
    if (idle.length > 0 && plan.idle === 'summary') {
      units.push({ b: { h: 1, node: lineNode(clip(idleSummary(idle, now), cols)) }, suits: idle.length })
    } else if (idle.length > 0 && plan.idle === 'lines') {
      for (const s of idle) {
        n += 1
        units.push({ b: suitBlock(s, n, suitLine(s, w, { ...opts(s), spark: 0 })), suits: 1 })
      }
    } else if (idle.length > 0) {
      const per = idlePerRow(plan.mode)
      const cw = Math.floor((cols - (per - 1)) / per)
      for (let i = 0; i < idle.length; i += per) {
        const group = idle.slice(i, i + per).map(s => {
          n += 1
          return { s, n, c: smallCard(s, cw, opts(s)) }
        })
        units.push({ b: suitGrid(group), suits: group.length })
      }
    }
    const height = units.reduce((h, u) => h + u.b.h, 0)
    if (plan.cut === undefined || height <= plan.cut) return units.map(u => u.b)
    // the units whose rows fit above the count line
    const kept: typeof units = []
    let used = 0
    for (const u of units) {
      if (used + u.b.h > plan.cut - 1) break
      kept.push(u)
      used += u.b.h
    }
    const hidden = active.length + idle.length - kept.reduce((k, u) => k + u.suits, 0)
    return [...kept.map(u => u.b), { h: 1, node: lineNode(clip([{ t: `… 還有 ${hidden} 艘`, color: FRAME }], cols)) }]
  }

  const fleetBlocks = (room: number): Block[] => {
    if (!ctx.herdr) {
      return [
        cardRow([
          {
            w: cols,
            color: FRAME,
            lines: [[title(TITLE_ICON.fleet, '艦隊', PRIMARY)], [{ t: '需要 herdr：艦隊頁從 herdr 讀取所有 Claude session', color: FRAME }]],
          },
        ]),
      ]
    }
    const now = view.now
    const q = fleetView.quota
    const hourly = hourlyOf(fleetView)
    const wins = q ? QUOTA_WINDOWS.flatMap(x => (q[x.key] ? [{ label: x.label, w: q[x.key] as QuotaWindow }] : [])) : []
    const sec = fleetSections(fleetView.sessions)
    const active = [...sec.blocked, ...sec.working]
    const plan = planFleet({ cols, room, windows: wins.length, active: active.length, idle: sec.idle.length })
    const line = (segs: Seg[]): Block => ({ h: 1, node: lineNode(clip(segs, cols)) })
    const total = hourly.reduce((a, b) => a + b, 0)
    const sigma = fleetView.scanning ? 'Σ SCANNING…' : `Σ ${fmtBig(total)} TOK`
    const sections: Block[][] = []
    if (plan.gauge !== 'none' && q && wins.length > 0) {
      const gauges = wins.map(x => ({ label: x.label, used: x.w.usedPct, foot: windowFoot(x.w, q, now, plan.gauge === 'big') }))
      sections.push([line(sectionHeader(withIcon(SECTION_ICON.reactor, 'ARC REACTOR'), cols)), ...reactorRows(plan.gauge, gauges, cols).map(line)])
    }
    if (plan.burnRows > 0) {
      const w = plan.mode === 'wide' ? cols - 4 : plan.mode === 'mid' ? BURN_MID_W : BURN_NARROW_W
      const ticks = plan.mode === 'narrow' ? [0, 12] : [0, 6, 12, 18]
      const chart = burnChart(hourly, w, plan.burnRows, new Date(now).getHours(), ticks)
      sections.push([line(sectionHeader(withIcon(SECTION_ICON.burn, 'TODAY BURN'), cols, sigma)), ...chart.map(r => line([sp(2), ...cellsToSegs(r)]))])
    }
    sections.push([line(sectionHeader(withIcon(SECTION_ICON.legion, 'IRON LEGION'), cols, plan.burnRows === 0 ? sigma : undefined)), ...legionBlocks(plan, active, sec.idle)])
    return sections.flatMap((s, i) => (i > 0 && plan.blanks ? [line(BLANK), ...s] : s))
  }

  const fleetDetailBlock = (s: FleetSession): Block => {
    const labelW = 9
    const inner = cols - 4
    const field = (label: string, value: Seg[]): Seg[] => [{ t: padCells(label, labelW), color: FRAME }, ...value]
    const orNone = (text: string | undefined, color: string): Seg => (text ? { t: text, color } : { t: '（無）', color: FRAME })
    // a paragraph under its label: wrapped to the card, at most `max` lines
    const para = (label: string, text: string | undefined, max: number, color: string): Seg[][] => {
      const wrapped = wrapCells(text ?? '', Math.max(1, inner - labelW), max)
      if (wrapped.length === 0) return [field(label, [orNone(undefined, color)])]
      return wrapped.map((l, i) => [{ t: padCells(i === 0 ? label : '', labelW), color: FRAME }, { t: l, color }])
    }
    const family = s.model ? nameFamilyOf(s.model) : undefined
    // one line however many herdr wrote on stderr
    const jumpText = fleetView.jumpError?.paneId === s.paneId ? fleetView.jumpError.text : undefined
    const jumpError = jumpText === undefined ? undefined : fitCells(jumpText.split('\n').map(l => l.trim()).find(l => l !== '') ?? '', inner)
    const lines: Line[] = [
      [suitIcon(s), sp(1), { t: s.title, color: PRIMARY, bold: true }],
      field('狀態', [FLEET_STATUS_TEXT[s.status]]),
      field('工作區', [orNone(s.workspace, PRIMARY)]),
      field('目錄', [orNone(s.cwd, PRIMARY)]),
      field('模型', [orNone(s.model && shortModel(s.model), family ? FAMILY_COLOR[family] : FRAME)]),
      field('閒置', [orNone(s.lastAt === undefined ? undefined : fmtAgo(view.now - s.lastAt), PRIMARY)]),
      field('今日', [{ t: `${fmtBig(s.todayTokens)} tok · ${fmtUsd(s.todayCost)}`, color: BRIGHT, bold: true }]),
      field('近期工具', [{ t: `${s.tools} 次`, color: PRIMARY }]),
      ...para('最後提問', s.lastUser, 3, PRIMARY),
      ...para('最後回覆', s.lastReply, 5, BRIGHT),
      ...(jumpError ? [[{ t: jumpError, color: ERROR, bold: true }]] : []),
    ]
    const spec: CardSpec = { w: cols, color: FRAME, lines }
    return card(spec, heightOf(spec))
  }

  // ---- 待機戰甲 -----------------------------------------------------------

  const suitFits = cols >= SUIT_CANVAS_COLS + SUIT_MARGIN
  const artFits = cols >= SUIT_COLS + SUIT_MARGIN

  const suitArt = (): Seg[][] => suitCells().map(r => centered(cellsToSegs(r), cols))

  // the readouts beside the suit from this width; below it, under the suit
  const scanSide = cols >= SCAN_SIDE_MIN_COLS
  // the rows the standby suit takes, its readouts under it when they do not fit beside
  const suitH = SUIT_BLOCK_ROWS + (scanSide ? 0 : SUIT_UNDER_ROWS)

  // a main-loop call out, or a squad member running (not waiting), quickens the suit's breath
  // and keeps it awake
  const suitBusy = view.inflight.some(f => f.actor === MAIN_ACTOR) || view.running.some(a => a.waiting !== true)
  const suitPaused = ctx.suitPaused === true
  const suitRests = suitResting({
    now: view.now,
    busy: suitBusy,
    ...(view.events.length > 0 ? { lastEventAt: Math.max(...view.events.map(ev => ev.ts + ev.ms)) } : {}),
    ...(ctx.deployedAt === undefined ? {} : { deployedAt: ctx.deployedAt }),
    ...(ctx.startedAt === undefined ? {} : { startedAt: ctx.startedAt }),
  })

  const READOUT_COLOR: Record<Readout['tone'], string> = { primary: PRIMARY, bright: BRIGHT, error: ERROR, frame: FRAME }

  // `LABEL ▰▱▱▱▱ value` in the form given: the label in frame, a meter when it keeps one, the
  // value in its tone
  const readoutSegs = (r: Readout | undefined, form: (r: Readout) => { label: string; meterW: number }): Seg[] => {
    if (r === undefined) return []
    const color = READOUT_COLOR[r.tone]
    const { label, meterW } = form(r)
    const lit = r.meter ? Math.min(meterW, Math.max(0, Math.ceil(r.meter.pct * meterW))) : 0
    return [
      ...(label === '' ? [] : [{ t: label, color: FRAME }, sp(1)]),
      ...(meterW > 0 ? [{ t: '▰'.repeat(lit), color }, { t: '▱'.repeat(meterW - lit), color: MUTED }, sp(1)] : []),
      { t: r.value, color },
    ]
  }

  // the frame in its sights: corners on its first and last rows, a blank cell between
  const sightedArt = (frame: readonly Cell[][]): Seg[][] =>
    frame.map((r, i) => {
      const [open, close] = i === 0 ? ['⌜', '⌝'] : i === frame.length - 1 ? ['⌞', '⌟'] : [' ', ' ']
      return [{ t: open, color: FRAME }, sp(1), ...cellsToSegs(r), sp(1), { t: close, color: FRAME }]
    })

  // the suit at rest over its two lines: standing by, and whether any order ever came; its
  // readouts either side when wide, under the two lines when narrow
  const standbyBlock = (): Block => {
    const now = view.now
    const lastEv = view.events.at(-1)
    const r = standbyReadouts({
      ...(ctx.quota ? { quota: ctx.quota } : {}),
      crewCost: view.summary.cost,
      ...(ctx.startedAt === undefined ? {} : { uptimeMs: now - ctx.startedAt }),
      done: view.finished.filter(a => a.status === 'done').length,
      active: view.running.length,
      failed: view.finished.filter(a => a.status === 'failed').length,
      ...(lastEv ? { lastAgoMs: now - (lastEv.ts + lastEv.ms) } : {}),
    })
    const frame = suitFrame(ctx.suitTick ?? 0, {
      busy: suitBusy,
      now,
      resting: suitRests,
      still: suitPaused,
      ...(ctx.deployedAt === undefined ? {} : { deployedAt: ctx.deployedAt }),
    })
    const sighted = sightedArt(frame.cells)
    // each row of the suit, corners and all, a press that holds or plays it; beside it what
    // the row holds either side
    let art: { pre: Seg[]; suit: Seg[]; post: Seg[] }[]
    let under: Seg[][] = []
    if (scanSide) {
      const side = Math.floor((cols - SCAN_FRAME_W) / 2)
      const rest = cols - SCAN_FRAME_W - side
      // the readouts from the art's second row, each in the first form that fits its side
      art = sighted.map((row, i) => {
        const l = clip(readoutSegs(r.left[i - 1], x => sideReadout(x, side)), side)
        const rt = clip(readoutSegs(r.right[i - 1], x => sideReadout(x, rest)), rest)
        return { pre: [sp(side - segsWidth(l)), ...l], suit: row, post: [...rt, sp(rest - segsWidth(rt))] }
      })
    } else {
      const side = Math.floor((cols - SCAN_FRAME_W) / 2)
      art = sighted.map(row => ({ pre: [sp(side)], suit: row, post: [sp(cols - SCAN_FRAME_W - side)] }))
      // under the suit the full labels, the meter giving way a cell at a time
      const full = (width: number) => (x: Readout) => ({ label: x.label, meterW: readoutMeterW(x, width) })
      under = Array.from({ length: SUIT_UNDER_ROWS }, (_, i) => {
        const rt = readoutSegs(r.right[i], full(cols))
        return leftRight(readoutSegs(r.left[i], full(cols - segsWidth(rt) - 1)), rt, cols)
      })
    }
    const toggle = () => ctx.toggleSuit?.()
    const artNodes = art.map(({ pre, suit, post }, i) => (
      <Box flexDirection="row">
        {texts(pre)}
        <Button key={`suit-row-${i}`} plain onPress={toggle}>
          {texts(suit)}
        </Button>
        {texts(post)}
      </Box>
    ))
    // the line under the suit, its p drawn before it, centered as one
    const mark = clip(
      [
        suitPaused
          ? { t: 'MARK XLII · PAUSED', color: FRAME }
          : crewDeployed(now, ctx.deployedAt)
            ? { t: '◆ CREW DEPLOYED', color: ACCENT }
            : { t: `MARK XLII · ${frame.pose}`, color: FRAME },
      ],
      cols,
    )
    const markGap = cols - segsWidth(mark)
    const markNode = (
      <Box flexDirection="row">
        {texts([sp(Math.floor(markGap / 2))])}
        <Button key="suit-mark" plain onPress={toggle}>
          {texts(mark)}
        </Button>
        {texts([sp(markGap - Math.floor(markGap / 2))])}
      </Box>
    )
    const lines: Seg[][] = [
      centered(
        [
          {
            t:
              view.running.length > 0
                ? 'CREW DEPLOYED, SIR.'
                : view.sections.length === 0
                  ? 'AWAITING ORDERS, SIR.'
                  : 'ALL CREW DOCKED, SIR.',
            color: PRIMARY,
          },
        ],
        cols,
      ),
      ...under,
    ]
    return {
      h: artNodes.length + 2 + lines.length,
      node: (
        <Box flexDirection="column">
          {artNodes}
          {lineNode(BLANK)}
          {markNode}
          {lines.map(lineNode)}
        </Box>
      ),
    }
  }

  // ---- 開機 ---------------------------------------------------------------

  const bootBlock = (stage: BootStage): Block => {
    const art = artFits && rows >= 1 + BOOT_SUIT_H ? [...suitArt(), BLANK] : []
    const lines: Seg[][] = [BLANK, ...art, centered([{ t: 'J.A.R.V.I.S. ONLINE', color: BRIGHT, bold: true }], cols)]
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
    ctx.onStandby?.(false)
    return (
      <Box flexDirection="column">
        {titleBar().node}
        {bootBlock(ctx.boot).node}
      </Box>
    )
  }

  // ---- 異動 ---------------------------------------------------------------

  const CHANGE_MODES: { mode: ChangeMode; label: string }[] = [
    { mode: 'session', label: '本次 session' },
    { mode: 'unpushed', label: '未推送' },
  ]

  // who changed a file: the main loop by name, a squad member by its card's mark, more
  // than one as the first and `+N`; `其他` for an unpushed file this session did not touch
  const changeActor = (actors: readonly string[]): Seg[] => {
    const [first] = actors
    if (first === undefined) return [{ t: '其他', color: MUTED }]
    const more: Seg[] = actors.length > 1 ? [{ t: `+${actors.length - 1}`, color: FRAME }] : []
    if (first === MAIN_ACTOR) return [{ t: '主線', color: MAIN_COLOR, bold: true }, ...more]
    const member = view.roster.get(first)
    if (!member) return [{ t: 'MK', color: FRAME }, ...more]
    const [open, close] = view.running.some(a => a.id === first) ? BRACKET.live : BRACKET.done
    return [{ t: `${open}MK-${member.n}${close}`, color: member.color }, ...more]
  }

  const countSegs = (e: Pick<ChangeEntry, 'add' | 'del' | 'note' | 'pending'>): Seg[] =>
    e.pending
      ? [{ t: '…', color: FRAME }]
      : e.note !== undefined
        ? [{ t: e.note, color: MUTED }]
        : [
            { t: `+${e.add}`, color: SUCCESS },
            { t: ' ' },
            { t: `−${e.del}`, color: ERROR },
          ]

  const changesBlock = (room: number): Block => {
    const inner = cols - 4
    const cv = ctx.changes ?? { mode: 'session' as const, groups: [], pending: false, total: 0 }
    const files = cv.groups.reduce((n, g) => n + g.entries.length, 0)
    const head = leftRight([title(TAB_ICON.changes, '異動', PRIMARY)], [{ t: `${files} 檔`, color: FRAME }], inner)
    const modeRow = (
      <Box flexDirection="row" gap={TAB_GAP}>
        {CHANGE_MODES.map(m => (
          <Button key={`chg-mode-${m.mode}`} plain onPress={() => ctx.setChangesMode?.(m.mode)}>
            {m.mode === cv.mode ? (
              <Text bold inverse color={ACCENT}>
                {m.label}
              </Text>
            ) : (
              <Text color={FRAME}>{m.label}</Text>
            )}
          </Button>
        ))}
        {cv.mode === 'unpushed' ? (
          <Button key="chg-refresh" plain onPress={() => ctx.refreshChanges?.()}>
            <Text color={FRAME}>重新整理</Text>
          </Button>
        ) : null}
      </Box>
    )
    const lines: Line[] = [head, { node: modeRow, h: 1 }]
    const markW = Math.max(
      cellWidth('主線'),
      ...cv.groups.flatMap(g => g.entries.map(e => segsWidth(changeActor(e.actors)))),
    )
    const countW = Math.max(1, ...cv.groups.flatMap(g => g.entries.map(e => segsWidth(countSegs(e)))))
    const pathW = Math.max(4, inner - 1 - markW - 1 - 1 - countW)
    const groupLine = (g: ChangeGroup): Seg[] =>
      leftRight(
        [
          { t: withIcon(CHANGE_ICON.repo, g.name), color: PRIMARY, bold: true },
          ...(g.ahead ? [{ t: ` ↑${g.ahead}`, color: ACCENT, bold: true }] : []),
        ],
        [
          { t: `${g.entries.length} 檔  `, color: FRAME },
          { t: `+${g.add}`, color: SUCCESS },
          { t: ' ' },
          { t: `−${g.del}`, color: ERROR },
        ],
        inner,
      )
    const fileLine = (e: ChangeEntry): Line => {
      const actor = changeActor(e.actors)
      const segs: Seg[] = [
        sp(1),
        ...actor,
        sp(markW - segsWidth(actor) + 1),
        { t: padCells(tailCells(e.label, pathW), pathW) },
        sp(1),
        sp(countW - segsWidth(countSegs(e))),
        ...countSegs(e),
      ]
      return {
        h: 1,
        node: (
          <Button key={`chg-${e.key}`} plain onPress={() => ctx.openDiff?.(e.key)}>
            <Text>{texts(clip(segs, inner))}</Text>
          </Button>
        ),
      }
    }
    const body: Line[] = []
    if (cv.groups.length === 0) {
      body.push([
        {
          t: cv.mode === 'session' ? '這個 session 還沒改過檔案' : '這個 session 還沒碰過任何 git repo',
          color: FRAME,
        },
      ])
    }
    for (const g of cv.groups) {
      body.push(groupLine(g))
      if (g.note !== undefined) body.push([sp(1), { t: g.note, color: MUTED }])
      if (g.error !== undefined) body.push([sp(1), { t: g.error, color: MUTED }])
      else if (g.entries.length === 0) body.push([sp(1), { t: g.pending ? '計算中…' : '沒有未推送的改動', color: MUTED }])
      for (const e of g.entries) body.push(fileLine(e))
    }
    const height = Math.max(6, room)
    const fit = Math.max(1, height - 2 - lines.length)
    // file rows are the ready nodes (Buttons); a cut list says how many files it left out,
    // those past MAX_LISTED included
    const beyond = cv.mode === 'session' ? Math.max(0, cv.total - MAX_LISTED) : 0
    if (body.length + (beyond > 0 ? 1 : 0) > fit) {
      const shownFiles = body.slice(0, fit - 1).filter(l => !Array.isArray(l)).length
      lines.push(...body.slice(0, fit - 1), [{ t: `… 還有 ${files - shownFiles + beyond} 檔`, color: FRAME }])
    } else {
      lines.push(...body)
      if (beyond > 0) lines.push([{ t: `… 還有 ${beyond} 檔`, color: FRAME }])
    }
    return card({ w: cols, color: FRAME, lines }, height)
  }

  // One file's diff, `room` rows tall at least and taller when the diff is: its path, who
  // changed it, its counts and the mode, ‹ › to the files listed beside it, then the diff
  // with line numbers.
  const diffBlock = (room: number): Block => {
    const inner = cols - 4
    const { g, e } = diffOrder[diffAt] ?? { g: undefined, e: undefined }
    if (!g || !e) return card({ w: cols, color: FRAME, lines: [] }, Math.max(3, room))
    const mode = CHANGE_MODES.find(m => m.mode === (ctx.changes?.mode ?? 'session'))?.label ?? ''
    const right: Seg[] = [...changeActor(e.actors), sp(2), ...countSegs(e), sp(2), { t: mode, color: FRAME }]
    const pathW = Math.max(1, inner - segsWidth(right) - 1)
    const head = leftRight([{ t: tailCells(`${g.name}/${e.label}`, pathW), color: PRIMARY, bold: true }], right, inner)
    const step = (by: number) => () => {
      const next = diffOrder[diffAt + by]
      if (next) ctx.openDiff?.(next.e.key)
    }
    const nav = (
      <Box flexDirection="row" gap={TAB_GAP}>
        <Button key="diff-prev" plain onPress={step(-1)}>
          <Text color={FRAME}>‹</Text>
        </Button>
        <Text color={FRAME}>{`${diffAt + 1} / ${diffOrder.length}`}</Text>
        <Button key="diff-next" plain onPress={step(1)}>
          <Text color={FRAME}>›</Text>
        </Button>
      </Box>
    )
    const rows = ctx.diff?.rows
    const body: Line[] =
      rows === undefined
        ? [[{ t: '計算中…', color: MUTED }]]
        : isFailed(rows)
          ? [[{ t: rows.error, color: MUTED }]]
          : diffLines(rows, inner)
    const lines: Line[] = [head, { node: nav, h: 1 }, ...body]
    return card({ w: cols, color: FRAME, lines }, Math.max(room, 2 + lines.length))
  }

  // ---- 組版 ---------------------------------------------------------------

  const blocks: Block[] = [titleBar(), tabBar()]
  const left = () => rows - blocks.reduce((n, b) => n + b.h, 0)
  let footer: RenderElement | undefined

  let standby = false
  if (page === 'now') {
    // in MIN_FINISHED's order: every running subagent and the least finished, whatever the
    // room; the suit when it fits over its least finished; the in-flight card; the recent
    // events' least or no card; then the rows left over, finished subagents first, then events
    // the suit makes room for the in-flight card at its idle height and caps it there while
    // drawn: calls coming and going neither take the suit away nor stop its tick
    const capped = inflightBlock(idleFlight.length)
    // event rows: a dated rule takes a row like an event
    const total = eventRows(view.events).length
    const recentH = (n: number) => Math.max(1, n) + 3
    const suitLeast = Math.min(finishedUnits.length, MIN_SUIT_FINISHED)
    const suit = suitFits && left() - listHeight(suitLeast) - suitH - capped.h >= 0 ? standbyBlock() : undefined
    standby = suit !== undefined
    const least = suit ? suitLeast : Math.min(finishedUnits.length, MIN_FINISHED)
    const flight = suit ? capped : inflightBlock()
    const room = left() - flight.h - (suit?.h ?? 0)
    let recent = Math.min(total, MIN_RECENT)
    const withRecent = room - listHeight(least) >= recentH(recent)
    const recentRoom = () => (withRecent ? recentH(recent) : 0)
    let shown = least
    while (shown < finishedUnits.length && listHeight(shown + 1) + recentRoom() <= room) shown += 1
    if (withRecent) recent = Math.max(recent, Math.min(total, room - listHeight(shown) - 3))
    blocks.push(...(suit ? [suit] : []), agentBlock(shown, listHeight(shown)), flight)
    if (withRecent) blocks.push(eventCard([title(TITLE_ICON.recent, '最近事件', PRIMARY)], view.events, recentH(recent), '還沒有工具呼叫', false))
  } else if (page === 'log') {
    const total = view.events.length
    const list = ctx.paused ? view.events.slice(0, Math.max(0, total - ctx.fresh)) : view.events
    const head = leftRight(
      [
        title(TITLE_ICON.log, '事件流', PRIMARY),
        ...(ctx.paused ? [sp(1), { t: `⏸ 已暫停 · 新增 ${ctx.fresh} 則`, color: ACCENT, bold: true }] : []),
      ],
      [{ t: `${total}/${MAX_EVENTS} 則`, color: FRAME }],
      cols - 4,
    )
    blocks.push(eventCard(head, list, Math.max(MIN_EVENT_ROWS + 3, left()), '還沒有工具呼叫', true))
  } else if (page === 'detail' && selected) {
    blocks.push(detailBlock(selected))
    const own = view.events.filter(ev => ev.actor === selected.id)
    const head = leftRight(
      [title(TITLE_ICON.log, '事件流', PRIMARY), { t: ' · 這個 subagent', color: FRAME }],
      [{ t: `${own.length} 則`, color: FRAME }],
      cols - 4,
    )
    blocks.push(eventCard(head, own, Math.max(MIN_EVENT_ROWS + 3, left()), '這個 subagent 還沒有工具呼叫', true, false))
  } else if (page === 'fleet') {
    blocks.push(...fleetBlocks(left()))
  } else if (page === 'fleetDetail' && fleetSelected) {
    blocks.push(fleetDetailBlock(fleetSelected))
  } else if (page === 'changes') {
    blocks.push(changesBlock(left()))
  } else if (page === 'changeDiff') {
    blocks.push(diffBlock(left()))
  } else {
    const hint = view.summary.groups.length === 0
    const plan = planStats({ cols, room: left() - (hint ? 1 : 0), roles: statsRoles.length, models: view.models.length })
    const dispatchCard = dispatchStatsSpec(cols, plan.roleCut)
    if (plan.mode === 'wide') {
      const [lw = cols, rw = cols] = splitCols(cols, 2)
      blocks.push(cardRow([mainStatsSpec(lw, plan.mode), modelsStatsSpec(rw)]), cardRow([dispatchCard]))
    } else {
      blocks.push(
        cardRow([mainStatsSpec(cols, plan.mode)]),
        cardRow([dispatchCard]),
        cardRow([modelsStatsSpec(cols)]),
      )
    }
    if (hint) {
      footer = <Text color={FRAME}>{fitCells('還沒有派工。派出 subagent 後這裡會即時顯示。', cols)}</Text>
    }
  }

  // held still, the suit asks for no frames
  ctx.onStandby?.(standby, suitPaused ? undefined : suitRests ? SUIT_REST_TICK_MS : SUIT_TICK_MS)

  return (
    <Box flexDirection="column">
      {blocks.map(b => b.node)}
      {footer ?? null}
    </Box>
  )
}
