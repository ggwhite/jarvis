import type { RenderElement } from 'claude-code'

import type { Ctx, Ui } from './cockpit'
import { DT, GLASS } from './desktopTheme'
import { CONTEXT_ALERT, CONTEXT_WARN, DECOMMISSION_MS, beatsOf, fleetSections, fleetTotals, fmtAgo, fmtBig, wrapCells } from './fleet'
import { hourlyOf, idleHourMax, windowFoot } from './fleetCards'
import { RING_BIG, RING_SMALL } from './fleetChart'
import { CHANGE_ICON, COMMIT_ICON, TAB_ICON, forDesktop } from './icons'
import { MAIN_ACTOR, cellWidth, fmtUsd, shortModel } from './jarvis'
import type { Cockpit } from './jarvis'
import { MAX_DIFF_ROWS, MAX_LISTED } from './changesView'
import type { ChangeEntry, ChangeGroup } from './changesView'
import type { ChangeMode } from './changes'
import { isFailed } from './gitDiff'
import type { DiffRow, Failed, NumstatRow } from './gitDiff'
import { commitRows, relTime } from './commitsView'
import type { CommitsCtx, RefLabel, RepoPage } from './commitsView'
import { graphWidth } from './commitGraph'
import { MAX_REMOTES } from './repoViews'
import type { BranchList, BranchRow, RepoView, StashInfo, WorktreeRow } from './repoViews'
import { burnSvg, meterSvg, ringSvg, sparkSvg } from './svgArt'
import type { FleetQuota, FleetSession, FleetStatus, JarvisPage, QuotaWindow } from '../types'

// The native Desktop pages of the fleet and the changes: the fleet, one session, the changes,
// one file's diff, a repo's tree, a commit's and a stash's diff.
export const B_PAGES: readonly JarvisPage[] = ['fleet', 'fleetDetail']

// the tab a sub-page lights: the session page the fleet's, the diff and tree pages the changes'
export const tabOfB = (page: JarvisPage): JarvisPage | undefined =>
  page === 'fleetDetail' ? 'fleet' : page === 'changeDiff' || page === 'commitTree' || page === 'commitDiff' || page === 'stashDiff' ? 'changes' : undefined

// What drawDesktop lends these pages: the elements, the room, and its picture, pill and card.
export type KitB = {
  ui: Ui
  cardInner: number
  wide: boolean
  picture: (source: string, alt: string, wide: number, tall: number, animated?: boolean) => RenderElement
  pill: (key: string, label: string, solid: boolean, onPress: () => void) => RenderElement
  card: (top: RenderElement, body: readonly RenderElement[], accent?: string, grow?: boolean) => RenderElement
  head: (icon: string, title: string, right?: string) => RenderElement
  tile: (body: readonly RenderElement[]) => RenderElement
}

// The least a row's flexible column keeps before a column gives way.
const DESC_MIN = 8

// Which of `widths` a row of `room` cells keeps, dropping `drop` in order until the flexible
// column has DESC_MIN, and what the flexible column gets: every column one cell apart.
export function fitColumns<W extends Record<string, number>>(widths: W, drop: readonly (keyof W & string)[], room: number): { on: (k: keyof W & string) => boolean; rest: number } {
  const shown = new Set(Object.keys(widths) as (keyof W & string)[])
  const fixed = () => [...shown].reduce((sum, k) => sum + (widths[k] ?? 0), 0) + shown.size
  for (const k of drop) if (fixed() + DESC_MIN > room) shown.delete(k)
  return { on: k => shown.has(k), rest: Math.max(1, room - fixed()) }
}

const QUOTA_WINDOWS = [
  { key: 'fiveHour', label: '5H' },
  { key: 'sevenDay', label: '7D' },
] as const

const FLEET_STATUS: Record<FleetStatus, { icon: string; label: string; color: string; accent?: string }> = {
  blocked: { icon: '!', label: 'AWAITING ORDERS', color: DT.fail, accent: DT.fail },
  working: { icon: '▶', label: 'IN FLIGHT', color: DT.data, accent: DT.orangeEdge },
  idle: { icon: '◇', label: 'STANDBY', color: DT.textSub },
}

export function drawPageB(kit: KitB, view: Cockpit, ctx: Ctx): RenderElement {
  const { Box, Text, Button } = kit.ui
  const { cardInner, wide, picture, pill, card, head, tile } = kit
  const now = view.now

  // ---- 共用 -------------------------------------------------------------

  type Col = { w: number; node: RenderElement; end?: boolean }
  const cell = (c: Col): RenderElement => (
    <Box width={c.w} flexShrink={0} overflow="hidden" {...(c.end ? { justifyContent: 'flex-end' } : {})}>
      {c.node}
    </Box>
  )
  // a row of fixed columns one cell apart; the caller keeps their sum within the card
  const row = (cols: readonly (Col | null | false)[]): RenderElement => (
    <Box flexDirection="row" gap={1} alignItems="center">
      {cols.filter((c): c is Col => c !== null && c !== false && c.w > 0).map(cell)}
    </Box>
  )
  // rows set close, no blank row between two
  const list = (rows: readonly RenderElement[]): RenderElement => <Box flexDirection="column">{rows}</Box>
  const say = (t: string, color: string = DT.textSub, bold = false): RenderElement => (
    <Text color={color} wrap="truncate" {...(bold ? { bold: true } : {})}>
      {t}
    </Text>
  )
  const sayStart = (t: string, color: string = DT.text, bold = false): RenderElement => (
    <Text color={color} wrap="truncate-start" {...(bold ? { bold: true } : {})}>
      {t}
    </Text>
  )
  const press = (key: string, onPress: () => void, body: RenderElement): RenderElement => (
    <Button key={key} plain onPress={onPress}>
      {body}
    </Button>
  )
  const note = (t: string, color: string = DT.textSub): RenderElement => (
    <Text color={color} wrap="wrap">
      {t}
    </Text>
  )
  // a card's title on the left in orange and words in their own colors on the right
  const headWith = (icon: string, title: string, right: RenderElement): RenderElement => (
    <Box flexDirection="row" justifyContent="space-between" gap={1}>
      <Box flexShrink={1} overflow="hidden">
        <Text color={DT.orange} bold wrap="truncate">
          {`${icon} ${title}`}
        </Text>
      </Box>
      <Box flexDirection="row" gap={1} flexShrink={0}>
        {right}
      </Box>
    </Box>
  )
  const actions = (items: readonly RenderElement[]): RenderElement => (
    <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
      {items}
    </Box>
  )
  const counts = (add: number, del: number, deleted = false): RenderElement[] => [
    ...(deleted ? [] : [<Text color={DT.ok}>{`+${add}`}</Text>]),
    <Text color={DT.fail}>{`−${del}`}</Text>,
  ]
  const countsW = (add: number, del: number, deleted = false): number => (deleted ? 0 : cellWidth(`+${add}`) + 1) + cellWidth(`−${del}`)

  // ---- 艦隊 -------------------------------------------------------------

  const fleet = ctx.fleet
  const fleetSelected = ctx.page === 'fleetDetail' ? fleet.sessions.find(s => s.paneId === ctx.paneId) : undefined

  const ctxColor = (pct: number | undefined): string =>
    pct === undefined ? DT.textFaint : pct >= CONTEXT_ALERT ? DT.fail : pct >= CONTEXT_WARN ? DT.orangeBright : DT.data

  const idleText = (s: FleetSession): string => {
    const ms = s.lastAt === undefined ? undefined : now - s.lastAt
    if (ms !== undefined && ms > DECOMMISSION_MS) return 'RETIRE'
    return `IDLE ${ms === undefined ? '--' : fmtAgo(ms)}`
  }

  const SELF_W = 4
  const SCOL = { spark: 10, meter: 10, pct: 4, today: 22 }

  // One session as a glass card: its status and title (the press that opens it), THIS for this
  // session, its badge; its last hour (today by the hour when idle), model, tool and run, its
  // context and today's use.
  const suitCard = (s: FleetSession, n: number, idleMax: number): RenderElement => {
    const st = FLEET_STATUS[s.status]
    const self = ctx.sessionId !== '' && s.sessionId === ctx.sessionId
    const badge = s.status === 'idle' ? idleText(s) : st.label
    const badgeW = cellWidth(badge)
    const titleW = Math.max(1, cardInner - badgeW - 1 - (self ? SELF_W + 1 : 0))
    const top = row([
      {
        w: titleW,
        node: press(
          `suit-${n}`,
          () => ctx.openFleet(s.paneId),
          <Text color={s.status === 'idle' ? DT.text : DT.orangeBright} bold wrap="truncate">{`${st.icon} ${s.title}`}</Text>,
        ),
      },
      self ? { w: SELF_W, node: say('THIS', DT.data, true) } : null,
      { w: badgeW, node: say(badge, st.color, true), end: true },
    ])
    const today = `TODAY ${fmtBig(s.todayTokens)} · ${fmtUsd(s.todayCost)}`
    const fit = fitColumns({ ...SCOL, today: Math.min(SCOL.today, cellWidth(today)) }, ['today', 'spark', 'meter'], cardInner)
    const idle = s.status === 'idle'
    const vals = idle ? hourlyOf(s) : beatsOf(s.stamps, now)
    const run = s.runSince === undefined ? undefined : fmtAgo(now - s.runSince)
    const info = (idle ? [s.model ? shortModel(s.model) : undefined, `${s.tools} 次工具`] : [s.model ? shortModel(s.model) : undefined, s.tool, run])
      .filter((x): x is string => x !== undefined && x !== '')
      .join(' · ')
    const pct = s.contextPct
    const body = row([
      fit.on('spark')
        ? { w: SCOL.spark, node: picture(sparkSvg(vals, SCOL.spark, idle ? idleMax : undefined, idle ? DT.orange : st.color, GLASS), idle ? '今日每小時' : '最近一小時', SCOL.spark, 1) }
        : null,
      { w: fit.rest, node: say(info === '' ? '--' : info) },
      fit.on('meter')
        ? { w: SCOL.meter, node: picture(meterSvg(Math.round((pct ?? 0) / 10), SCOL.meter, ctxColor(pct), GLASS), `CONTEXT ${pct ?? '--'}%`, SCOL.meter, 1) }
        : null,
      { w: SCOL.pct, node: say(pct === undefined ? '--' : `${pct}%`, ctxColor(pct), true), end: true },
      fit.on('today') ? { w: Math.min(SCOL.today, cellWidth(today)), node: say(today, DT.orange), end: true } : null,
    ])
    return idle ? (
      <Box flexDirection="column" backgroundColor={DT.glass} borderStyle="round" borderColor={DT.glassBorder} paddingX={2}>
        {top}
        {body}
      </Box>
    ) : (
      card(top, [body], st.accent)
    )
  }

  const fleetPage = (): RenderElement => {
    if (!ctx.herdr) {
      return card(head(forDesktop(TAB_ICON.fleet), '艦隊', '需要 herdr'), [
        <Box flexDirection="row" gap={2} alignItems="center">
          {picture(ringSvg(RING_SMALL, 0, false, [], undefined, GLASS), 'herdr 未連線', RING_SMALL.w, Math.ceil(RING_SMALL.h / 2))}
          <Box flexDirection="column" flexShrink={1}>
            <Text color={DT.text} bold wrap="wrap">
              需要 herdr：艦隊頁從 herdr 讀取所有 Claude session
            </Text>
            {note('在 herdr 裡執行 Claude Code（HERDR_ENV=1）後，這裡會列出每個 session 的狀態、今日用量與額度。')}
          </Box>
        </Box>,
      ], DT.orangeEdge)
    }
    const sec = fleetSections(fleet.sessions)
    const active = [...sec.blocked, ...sec.working]
    const hourly = hourlyOf(fleet)
    const total = hourly.reduce((a, b) => a + b, 0)
    const sigma = fleet.scanning ? 'Σ SCANNING…' : `Σ ${fmtBig(total)} TOK`
    const totals = fleetTotals(fleet.sessions)
    const stat = (label: string, value: string, color: string): RenderElement =>
      tile([<Text color={DT.textSub}>{label}</Text>, <Text color={color} bold>{value}</Text>])
    const legion = card(
      headWith(
        forDesktop(TAB_ICON.fleet),
        'IRON LEGION',
        fleet.linkLost ? <Text color={DT.fail} bold>FLEET LINK LOST</Text> : <Text color={DT.textSub}>{`${fleet.sessions.length} SUITS`}</Text>,
      ),
      [
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {stat('AWAITING', String(sec.blocked.length), sec.blocked.length > 0 ? DT.fail : DT.textFaint)}
          {stat('IN FLIGHT', String(sec.working.length), sec.working.length > 0 ? DT.data : DT.textFaint)}
          {stat('STANDBY', String(sec.idle.length), DT.text)}
          {stat('TODAY', `${fmtBig(totals.tokens)} · ${fmtUsd(totals.cost)}`, DT.orange)}
        </Box>,
      ],
      fleet.linkLost ? DT.fail : undefined,
    )

    const q: FleetQuota | undefined = fleet.quota
    const wins = q ? QUOTA_WINDOWS.flatMap(x => (q[x.key] ? [{ label: x.label, w: q[x.key] as QuotaWindow }] : [])) : []
    const ring = wide ? RING_BIG : RING_SMALL
    const reactor =
      q && wins.length > 0
        ? card(head('⚡', 'ARC REACTOR', '額度'), [
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {wins.map(x => {
                const foot = windowFoot(x.w, q, now, wide)
                const used = `${Math.round(x.w.usedPct)}%`
                return tile([
                  <Box flexDirection="row" gap={2} alignItems="center">
                    {picture(ringSvg(ring, x.w.usedPct / 100, foot.depleted, [], undefined, GLASS), `${x.label} ${used}`, ring.w, Math.ceil(ring.h / 2))}
                    <Box flexDirection="column">
                      <Text color={DT.orange} bold>
                        {x.label}
                      </Text>
                      <Text color={foot.depleted ? DT.fail : DT.text} bold>
                        {used}
                      </Text>
                      <Text color={foot.depleted ? DT.fail : DT.textSub}>{foot.t}</Text>
                    </Box>
                  </Box>,
                ])
              })}
            </Box>,
          ])
        : null

    const burnRows = wide ? 5 : 3
    const nowHour = new Date(now).getHours()
    const ticks = cardInner >= 48 ? [0, 6, 12, 18] : [0, 12]
    const burn = card(head('🔥', 'TODAY BURN', sigma), [
      picture(burnSvg(hourly, cardInner, burnRows, nowHour, ticks, GLASS), `TODAY BURN ${sigma}`, cardInner, burnRows + 2),
    ])

    const idleMax = idleHourMax(sec.idle)
    let n = 0
    const activeCards = active.map(s => suitCard(s, (n += 1), idleMax))
    const idleCards = sec.idle.map(s => suitCard(s, (n += 1), idleMax))
    const section = (label: string, count: number, color: string): RenderElement => (
      <Text color={color} bold>{`${label} · ${count}`}</Text>
    )
    const suits =
      fleet.sessions.length === 0
        ? [card(head(forDesktop(TAB_ICON.fleet), '艦隊'), [say(fleet.at === 0 ? '掃描艦隊中…' : '艦隊目前沒有 Claude session')])]
        : [
            ...(activeCards.length > 0 ? [section('▶ ACTIVE', activeCards.length, DT.orange), ...activeCards] : []),
            ...(idleCards.length > 0 ? [section('◇ STANDBY', idleCards.length, DT.textSub), ...idleCards] : []),
          ]
    return (
      <Box flexDirection="column" gap={1}>
        {legion}
        {reactor}
        {burn}
        {suits}
      </Box>
    )
  }

  const fleetDetailPage = (s: FleetSession): RenderElement => {
    const st = FLEET_STATUS[s.status]
    const LABEL_W = 8
    const valueW = Math.max(1, cardInner - LABEL_W - 1)
    const field = (label: string, value: string | undefined, color: string = DT.text): RenderElement =>
      row([
        { w: LABEL_W, node: say(label) },
        { w: valueW, node: value ? say(value, color) : say('（無）', DT.textFaint) },
      ])
    const para = (label: string, text: string | undefined, max: number, color: string): RenderElement[] => {
      const lines = wrapCells(text ?? '', valueW, max)
      if (lines.length === 0) return [field(label, undefined)]
      return lines.map((l, i) => row([{ w: LABEL_W, node: say(i === 0 ? label : '') }, { w: valueW, node: say(l, color) }]))
    }
    const jumpText = fleet.jumpError?.paneId === s.paneId ? fleet.jumpError.text : undefined
    const jumpError = jumpText === undefined ? undefined : (jumpText.split('\n').map(l => l.trim()).find(l => l !== '') ?? '')
    const paneId = s.paneId
    return (
      <Box flexDirection="column" gap={1}>
        {actions([pill('back', '返回', false, () => ctx.go('fleet')), pill('jump', '跳轉', true, () => ctx.jump(paneId))])}
        {card(
          headWith(`${st.icon}`, s.title, <Text color={st.color} bold>{s.status === 'idle' ? idleText(s) : st.label}</Text>),
          [
            list([
              field('工作區', s.workspace),
              field('目錄', s.cwd),
              field('模型', s.model && shortModel(s.model), DT.data),
              field('閒置', s.lastAt === undefined ? undefined : fmtAgo(now - s.lastAt)),
              row([
                { w: LABEL_W, node: say('今日') },
                { w: valueW, node: say(`${fmtBig(s.todayTokens)} tok · ${fmtUsd(s.todayCost)}`, DT.orange, true) },
              ]),
              row([
                { w: LABEL_W, node: say('Context') },
                { w: valueW, node: say(s.contextPct === undefined ? '--' : `${s.contextPct}%`, ctxColor(s.contextPct), true) },
              ]),
              field('近期工具', `${s.tools} 次`),
            ]),
            list(para('最後提問', s.lastUser, 3, DT.text)),
            list(para('最後回覆', s.lastReply, 5, DT.orangeBright)),
            ...(jumpError !== undefined ? [say(jumpError, DT.fail, true)] : []),
          ],
          st.accent,
        )}
      </Box>
    )
  }

  // ---- 分流 -------------------------------------------------------------

  // a sub-page whose session, file, repo, commit or stash left is the page above it
  if (ctx.page === 'fleetDetail') return fleetSelected ? fleetDetailPage(fleetSelected) : fleetPage()
  return fleetPage()
}
