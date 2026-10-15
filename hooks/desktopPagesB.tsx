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
export const B_PAGES: readonly JarvisPage[] = ['fleet', 'fleetDetail', 'changes', 'changeDiff', 'commitTree', 'commitDiff', 'stashDiff']

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

const CHANGE_MODES: { mode: ChangeMode; label: string }[] = [
  { mode: 'session', label: '本 session' },
  { mode: 'unpushed', label: '未推送' },
  { mode: 'commits', label: '提交' },
]

const REPO_VIEWS: { view: RepoView; label: string }[] = [
  { view: 'log', label: '提交' },
  { view: 'branches', label: '分支' },
  { view: 'stash', label: 'Stash' },
  { view: 'worktrees', label: 'Worktree' },
]

// a commit graph's lanes on dark glass, neighbours never alike
const LANE_DT: readonly string[] = [DT.data, DT.ok, DT.orange, DT.blue, DT.orangeBright, DT.textSub]
const laneDt = (lane: number): string => (lane < 0 ? DT.textFaint : (LANE_DT[lane % LANE_DT.length] ?? DT.textSub))

const oneLine = (s: string): string => s.replace(/\r\n?|\n/g, ' ')

type NumberedRow = Extract<DiffRow, { kind: 'add' | 'del' | 'ctx' }>
const numbered = (r: DiffRow): r is NumberedRow => r.kind !== 'hunk' && r.kind !== 'note'

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
    // when narrow THIS gives way, then the badge is cut, so the title keeps at least a cell
    const badgeW = Math.min(cellWidth(badge), cardInner - 2)
    const showSelf = self && cardInner - badgeW - 1 - (SELF_W + 1) >= DESC_MIN
    const titleW = Math.max(1, cardInner - badgeW - 1 - (showSelf ? SELF_W + 1 : 0))
    const top = row([
      {
        w: titleW,
        node: press(
          `suit-${n}`,
          () => ctx.openFleet(s.paneId),
          <Text color={s.status === 'idle' ? DT.text : DT.orangeBright} bold wrap="truncate">{`${st.icon} ${s.title}`}</Text>,
        ),
      },
      showSelf ? { w: SELF_W, node: say('THIS', DT.data, true) } : null,
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

  // ---- 異動 -------------------------------------------------------------

  const cv = ctx.changes ?? { mode: 'session' as const, groups: [], pending: false, total: 0 }
  const diffOrder = cv.groups.flatMap(g => g.entries.map(e => ({ g, e })))
  const diffAt = ctx.page === 'changeDiff' && ctx.diff ? diffOrder.findIndex(x => x.e.key === ctx.diff?.key) : -1

  // who changed a file: the main loop by name, a squad member by its mark, more than one as
  // the first and +N; 其他 for an unpushed file this session did not touch
  const actorOf = (actors: readonly string[]): { t: string; color: string; bold?: boolean } => {
    const [first] = actors
    const more = actors.length > 1 ? ` +${actors.length - 1}` : ''
    if (first === undefined) return { t: '其他', color: DT.textFaint }
    if (first === MAIN_ACTOR) return { t: `主線${more}`, color: DT.data, bold: true }
    const member = view.roster.get(first)
    return member ? { t: `MK-${member.n}${more}`, color: member.color } : { t: `MK${more}`, color: DT.textSub }
  }

  // a file's counts: … while git works, a word when they cannot say, else +add −del
  const entryCounts = (e: ChangeEntry): { w: number; node: RenderElement } => {
    if (e.pending) return { w: 1, node: say('…') }
    if (e.note !== undefined) return { w: cellWidth(e.note), node: say(e.note) }
    const mark = e.mark !== undefined ? `${e.mark} ` : ''
    return {
      w: cellWidth(mark) + countsW(e.add, e.del, e.deleted),
      node: (
        <Box flexDirection="row" gap={1}>
          {mark !== '' ? <Text color={DT.textSub}>{e.mark}</Text> : null}
          {counts(e.add, e.del, e.deleted)}
        </Box>
      ),
    }
  }

  const COUNT_MAX = 16
  const ACTOR_W = 8

  const groupCard = (g: ChangeGroup): RenderElement => {
    if (g.removed !== undefined) return card(head(forDesktop(CHANGE_ICON.repo), g.name), [say(`已移除（${g.removed} 檔）`)])
    const cw = Math.min(COUNT_MAX, Math.max(1, ...g.entries.map(e => entryCounts(e).w)))
    const fit = fitColumns({ actor: ACTOR_W, count: cw }, ['actor'], cardInner)
    const fileRow = (e: ChangeEntry): RenderElement => {
      const a = actorOf(e.actors)
      const c = entryCounts(e)
      const key = e.key
      return row([
        fit.on('actor') ? { w: ACTOR_W, node: say(a.t, a.color, a.bold === true) } : null,
        { w: fit.rest, node: press(`chg-${key}`, () => ctx.openDiff?.(key), sayStart(e.label)) },
        { w: cw, node: c.node, end: true },
      ])
    }
    const lines: RenderElement[] = [
      ...(g.note !== undefined ? [say(g.note)] : []),
      ...(g.error !== undefined ? [say(g.error)] : g.entries.length === 0 ? [say(g.pending ? '計算中…' : '沒有未推送的改動')] : []),
    ]
    return card(
      headWith(
        forDesktop(CHANGE_ICON.repo),
        g.name,
        <Box flexDirection="row" gap={1}>
          {g.ahead ? <Text color={DT.data} bold>{`↑${g.ahead}`}</Text> : null}
          <Text color={DT.textSub}>{`${g.entries.length} 檔`}</Text>
          {counts(g.add, g.del)}
        </Box>,
      ),
      [...lines, ...(g.entries.length > 0 ? [list(g.entries.map(fileRow))] : [])],
    )
  }

  const RCOL = { star: 1, branch: 14, ahead: 5, time: 10 }

  // the commits mode's repos: ★ those the session touched, the branch, ↑ unpushed and when
  // the last commit was made; each name opens its tree
  const repoListCard = (): RenderElement => {
    const cm = ctx.commits
    const rl = cm?.list
    const top = head(forDesktop(CHANGE_ICON.repo), cm?.cwdName ?? '提交', rl && rl.rows.length > 0 ? `${rl.total} repos` : undefined)
    if (!cm || !rl || (rl.rows.length === 0 && rl.scanning)) return card(top, [say('掃描 repo 中…')])
    if (rl.error !== undefined) return card(top, [say(rl.error)])
    if (rl.rows.length === 0) return card(top, [say('找不到 repo')])
    const fit = fitColumns(RCOL, ['branch', 'time'], cardInner)
    const rows = rl.rows.map(r => {
      const repo = r.repo
      return row([
        { w: RCOL.star, node: say(r.touched ? '★' : '', DT.data, true) },
        { w: fit.rest, node: press(`cm-repo-${repo}`, () => cm.openRepo(repo), say(r.name, r.touched ? DT.orange : DT.text, r.touched)) },
        fit.on('branch') ? { w: RCOL.branch, node: say(r.branch ?? '') } : null,
        { w: RCOL.ahead, node: say(r.ahead ? `↑${r.ahead}` : '', DT.data, true), end: true },
        fit.on('time')
          ? { w: RCOL.time, node: r.pending ? say('讀取中…', DT.textFaint) : say(r.error ?? relTime(cm.now - (r.time ?? 0)), DT.textFaint), end: true }
          : null,
      ])
    })
    return card(top, [list(rows), ...(rl.more > 0 ? [say(`… 還有 ${rl.more} 個 repo`)] : [])])
  }

  const changesPage = (): RenderElement => {
    const files = cv.groups.reduce((sum, g) => sum + g.entries.length, 0)
    const header = card(head(forDesktop(TAB_ICON.changes), '異動', cv.mode === 'commits' ? undefined : `${files} 檔`), [
      actions([
        ...CHANGE_MODES.map(m => pill(`chg-mode-${m.mode}`, m.label, m.mode === cv.mode, () => ctx.setChangesMode?.(m.mode))),
        ...(cv.mode !== 'session'
          ? [pill('chg-refresh', '重新整理', false, () => (cv.mode === 'commits' ? ctx.commits?.refreshList() : ctx.refreshChanges?.()))]
          : []),
      ]),
    ])
    if (cv.mode === 'commits') {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {repoListCard()}
        </Box>
      )
    }
    const beyond = cv.mode === 'session' ? Math.max(0, cv.total - MAX_LISTED) : 0
    const body =
      cv.groups.length === 0
        ? [card(head('📭', '沒有異動'), [say(cv.mode === 'session' ? '這個 session 還沒改過檔案' : '這個 session 還沒碰過任何 git repo')])]
        : cv.groups.map(groupCard)
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {body}
        {beyond > 0 ? say(`… 還有 ${beyond} 檔`) : null}
      </Box>
    )
  }

  // ---- diff -------------------------------------------------------------

  // a diff's rows close together: old and new line numbers, then the sign and text, added in
  // green, removed in red, hunk headers in ice blue, notes faint; a long line cut at the card
  const diffBody = (rows: readonly DiffRow[]): RenderElement => {
    const shown = rows.slice(0, MAX_DIFF_ROWS)
    const top = shown.reduce((m, r) => (numbered(r) ? Math.max(m, r.old ?? 0, r.new ?? 0) : m), 0)
    const numW = String(Math.max(1, top)).length
    const textW = Math.max(1, cardInner - 2 * (numW + 1))
    const text = (t: string) => t.replace(/\r$/, '').replace(/\t/g, '    ')
    const out = shown.map(r => {
      if (!numbered(r)) return row([{ w: cardInner, node: say(text(r.text), r.kind === 'hunk' ? DT.data : DT.textSub) }])
      const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '
      const color = r.kind === 'add' ? DT.ok : r.kind === 'del' ? DT.fail : DT.text
      return row([
        { w: numW, node: say(r.old === undefined ? '' : String(r.old), DT.textFaint), end: true },
        { w: numW, node: say(r.new === undefined ? '' : String(r.new), DT.textFaint), end: true },
        { w: textW, node: say(`${sign}${text(r.text)}`, color) },
      ])
    })
    if (rows.length > MAX_DIFF_ROWS) out.push(say(`… 還有 ${rows.length - MAX_DIFF_ROWS} 行`))
    return list(out)
  }

  const diffOf = (rows: readonly DiffRow[] | Failed | undefined): RenderElement =>
    rows === undefined ? say('計算中…') : isFailed(rows) ? say(rows.error) : rows.length === 0 ? say('沒有差異') : diffBody(rows)

  // ‹ i / n › over a set of files
  const stepper = (keys: { prev: string; next: string }, at: number, total: number, open: (i: number) => void): RenderElement[] => [
    pill(keys.prev, '‹', false, () => open(at - 1)),
    <Text color={DT.textSub}>{`${at + 1} / ${total}`}</Text>,
    pill(keys.next, '›', false, () => open(at + 1)),
  ]

  const changeDiffPage = (): RenderElement => {
    const { g, e } = diffOrder[diffAt] ?? { g: undefined, e: undefined }
    if (!g || !e) return changesPage()
    const mode = CHANGE_MODES.find(m => m.mode === cv.mode)?.label ?? ''
    const a = actorOf(e.actors)
    const c = entryCounts(e)
    const open = (i: number) => {
      const next = diffOrder[i]
      if (next) ctx.openDiff?.(next.e.key)
    }
    return (
      <Box flexDirection="column" gap={1}>
        {actions([pill('back', '返回', false, () => ctx.go('changes')), ...stepper({ prev: 'diff-prev', next: 'diff-next' }, diffAt, diffOrder.length, open)])}
        {card(
          <Box flexDirection="column">
            <Box overflow="hidden">{sayStart(`${g.name}/${e.label}`, DT.orange, true)}</Box>
            <Box flexDirection="row" gap={2}>
              <Text color={a.color} bold={a.bold === true}>
                {a.t}
              </Text>
              {c.node}
              <Text color={DT.textSub}>{mode}</Text>
            </Box>
          </Box>,
          [diffOf(ctx.diff?.rows)],
        )}
      </Box>
    )
  }

  // ---- commits ----------------------------------------------------------

  const refColor = (ref: RefLabel): string => (ref.kind === 'head' ? DT.data : ref.kind === 'branch' ? DT.ok : ref.kind === 'tag' ? DT.orangeBright : DT.orange)
  const refText = (ref: RefLabel): string => (ref.kind === 'remote' ? ref.name : `${forDesktop(ref.kind === 'tag' ? COMMIT_ICON.tag : COMMIT_ICON.branch)} ${ref.name}`)

  const remoteLines = (r: RepoPage, cm: CommitsCtx): RenderElement[] => {
    const rem = r.remotes
    if (rem === undefined) return [say('讀取 remote 中…')]
    if (isFailed(rem)) return [say(rem.error)]
    if (rem.remotes.length === 0) return [say('沒有 remote')]
    const NAME_W = 10
    const out: RenderElement[] = [
      list(
        rem.remotes.slice(0, MAX_REMOTES).map(x =>
          row([
            { w: NAME_W, node: say(`${forDesktop(COMMIT_ICON.remote)} ${x.name}`, DT.data) },
            { w: Math.max(1, cardInner - NAME_W - 1), node: sayStart(x.url, DT.textSub) },
          ]),
        ),
      ),
    ]
    if (rem.remotes.length > MAX_REMOTES) out.push(say(`還有 ${rem.remotes.length - MAX_REMOTES} 個 remote`))
    const when = rem.fetchedAt === undefined ? '從未 fetch' : `fetch ${relTime(cm.now - rem.fetchedAt)}`
    out.push(
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text color={DT.textSub}>{when}</Text>
        {r.fetching ? <Text color={DT.textFaint}>fetch 中…</Text> : pill('cm-fetch', 'fetch', false, () => cm.fetch())}
      </Box>,
    )
    if (r.fetchError !== undefined) out.push(say(r.fetchError, DT.fail))
    return out
  }

  const LCOL = { sha: 7, up: 1, refs: 18, age: 6 }

  // the commits: each row its lanes, short sha (bright when made this session), ↑ when not
  // pushed, the subject (the press that opens its diff), refs when there is room and its age
  const logBody = (t: RepoPage['tree'], cm: CommitsCtx): RenderElement[] => {
    if (t === undefined) return [say('讀取中…')]
    if (isFailed(t)) return [say(t.error)]
    if (t.commits.length === 0) return [say('這個 repo 還沒有 commit')]
    const rows = commitRows(t, cm.startedAt)
    const gw = graphWidth(rows.map(r => r.graph)) + (rows.some(r => r.graph.overflow) ? 1 : 0)
    const fit = fitColumns({ graph: gw, ...LCOL }, ['refs', 'age'], cardInner)
    return [
      list(
        rows.map(r => {
          const sha = r.commit.sha
          return row([
            {
              w: gw,
              node: (
                <Box flexDirection="row">
                  {r.graph.cells.map(c => (
                    <Text color={laneDt(c.lane)}>{forDesktop(c.ch)}</Text>
                  ))}
                  {r.graph.overflow ? <Text color={DT.textFaint}>…</Text> : null}
                </Box>
              ),
            },
            { w: LCOL.sha, node: say(sha.slice(0, 7), r.session ? DT.data : DT.textSub, r.session) },
            { w: LCOL.up, node: say(r.unpushed ? '↑' : '', DT.data, true) },
            { w: fit.rest, node: press(`cm-commit-${sha}`, () => cm.openCommit(sha), say(oneLine(r.commit.subject), DT.text)) },
            fit.on('refs')
              ? {
                  w: LCOL.refs,
                  node: (
                    <Box flexDirection="row" gap={1} overflow="hidden">
                      {r.refs.map(ref => say(refText(ref), refColor(ref)))}
                    </Box>
                  ),
                }
              : null,
            fit.on('age') ? { w: LCOL.age, node: say(fmtAgo(cm.now - r.commit.time), DT.textFaint), end: true } : null,
          ])
        }),
      ),
    ]
  }

  // the branches: ◉ the current one, 進行中, then 只在遠端 and gone each folded to one press;
  // the name opens its tree
  const branchBody = (b: BranchList | Failed | undefined, cm: CommitsCtx, open: { remote: boolean; gone: boolean }): RenderElement[] => {
    if (b === undefined) return [say('讀取中…')]
    if (isFailed(b)) return [say(b.error)]
    if (b.total === 0) return [say('沒有分支')]
    const statusOf = (r: BranchRow): string =>
      [r.ahead > 0 ? `↑${r.ahead}` : '', r.behind > 0 ? `↓${r.behind}` : '', r.gone ? 'gone' : '', r.kind !== 'remote' && !r.upstream ? '無 upstream' : '', r.merged ? '已 merge' : '']
        .filter(x => x !== '')
        .join(' ')
    const drawn = [...(b.current ? [b.current] : []), ...b.active.rows, ...(open.remote ? b.remote.rows : []), ...(open.gone ? b.gone.rows : [])]
    const statusW = Math.min(20, Math.max(0, ...drawn.map(r => cellWidth(statusOf(r)))))
    const nameW = Math.max(4, Math.min(28, cardInner - 1 - 2 - DESC_MIN, Math.max(8, ...drawn.map(r => cellWidth(r.name)))))
    const fit = fitColumns({ mark: 1, name: nameW, status: statusW, age: 4 }, ['status', 'age'], cardInner)
    const branchRow = (r: BranchRow): RenderElement => {
      const ref = r.ref
      const mark = r.kind === 'current' ? COMMIT_ICON.head : r.kind === 'local' ? COMMIT_ICON.node : forDesktop(COMMIT_ICON.remote)
      const color = r.kind === 'current' ? DT.data : r.kind === 'remote' ? DT.orange : DT.text
      const status = statusOf(r)
      return row([
        { w: 1, node: say(mark, r.kind === 'current' ? DT.data : r.kind === 'local' ? DT.ok : DT.orange) },
        { w: nameW, node: press(`cm-branch-${ref}`, () => cm.openBranch(ref), say(r.name, color, r.kind === 'current')) },
        fit.on('status') && statusW > 0 ? { w: statusW, node: say(status, r.ahead > 0 ? DT.ok : DT.textSub) } : null,
        { w: fit.rest + (fit.on('status') && statusW === 0 ? statusW + 1 : 0), node: say(oneLine(r.subject), DT.textSub) },
        fit.on('age') ? { w: 4, node: say(fmtAgo(cm.now - r.time), DT.textFaint), end: true } : null,
      ])
    }
    const more = (k: number): RenderElement[] => (k > 0 ? [say(`還有 ${k} 個分支`)] : [])
    const out: RenderElement[] = b.current ? [list([branchRow(b.current)])] : []
    if (b.active.rows.length > 0) out.push(say(`進行中 ${b.active.rows.length + b.active.more}`), list(b.active.rows.map(branchRow)), ...more(b.active.more))
    for (const [key, title, g, isOpen, toggle] of [
      ['remote', '只在遠端', b.remote, open.remote, cm.toggleRemote],
      ['gone', 'gone', b.gone, open.gone, cm.toggleGone],
    ] as const) {
      if (g.rows.length === 0) continue
      const label = `${isOpen ? '▾' : '▸'} ${title} ${g.rows.length + g.more} 個${key === 'gone' ? '（遠端已刪，多半已 merge）' : ''}`
      out.push(press(`cm-branches-${key}`, () => toggle(), say(label, DT.orange)))
      if (isOpen) out.push(list(g.rows.map(branchRow)), ...more(g.more))
    }
    return out
  }

  const SCOL_STASH = { name: 10, branch: 14, age: 4 }

  // the stashes, shared by every worktree of the repo; a message opens its diff
  const stashBody = (s: StashInfo[] | Failed | undefined, cm: CommitsCtx): RenderElement[] => {
    if (s === undefined) return [say('讀取中…')]
    if (isFailed(s)) return [say(s.error)]
    const lead = say('stash 由這個 repo 的所有 worktree 共用', DT.textFaint)
    if (s.length === 0) return [lead, say('沒有 stash')]
    const fit = fitColumns(SCOL_STASH, ['branch', 'age'], cardInner)
    return [
      lead,
      list(
        s.map(x => {
          const sha = x.sha
          return row([
            { w: SCOL_STASH.name, node: say(x.name, DT.data) },
            fit.on('branch') ? { w: SCOL_STASH.branch, node: say(x.branch === '' ? '' : `${forDesktop(COMMIT_ICON.branch)} ${x.branch}`) } : null,
            { w: fit.rest, node: press(`cm-stash-${sha}`, () => cm.openStash(sha), say(oneLine(x.message), DT.text)) },
            fit.on('age') ? { w: SCOL_STASH.age, node: say(fmtAgo(cm.now - x.time), DT.textFaint), end: true } : null,
          ])
        }),
      ),
    ]
  }

  const WCOL = { mark: 1, branch: 18, marks: 12 }

  // the worktrees: ◉ the repo's own, its branch (or the detached sha), its uncommitted files,
  // 已不存在 when pruned, locked, agent; a path (not a pruned one) opens its tree
  const worktreeBody = (w: WorktreeRow[] | Failed | undefined, cm: CommitsCtx): RenderElement[] => {
    if (w === undefined) return [say('讀取中…')]
    if (isFailed(w)) return [say(w.error)]
    if (w.length === 0) return [say('沒有 worktree')]
    const fit = fitColumns(WCOL, ['branch'], cardInner)
    return [
      list(
        w.map(x => {
          const marks = [x.prunable ? '已不存在' : '', !x.prunable && x.dirty !== undefined ? (x.dirty > 0 ? `±${x.dirty}` : '乾淨') : '', x.locked ? 'locked' : '', x.agent ? 'agent' : '']
            .filter(m => m !== '')
            .join(' ')
          const name = sayStart(x.name, x.main ? DT.data : DT.text, x.main)
          const path = x.path
          return row([
            { w: WCOL.mark, node: say(x.main ? COMMIT_ICON.head : COMMIT_ICON.node, x.main ? DT.data : DT.ok) },
            { w: fit.rest, node: x.prunable ? name : press(`cm-wt-${path}`, () => cm.openWorktree(path), name) },
            fit.on('branch')
              ? { w: WCOL.branch, node: x.branch !== undefined ? say(`${forDesktop(COMMIT_ICON.branch)} ${x.branch}`) : say(`detached ${x.head.slice(0, 7)}`, DT.textFaint) }
              : null,
            { w: WCOL.marks, node: say(marks, x.prunable ? DT.fail : x.dirty ? DT.orange : DT.textFaint), end: true },
          ])
        }),
      ),
    ]
  }

  const commitTreePage = (cm: CommitsCtx, r: RepoPage): RenderElement => {
    const t = r.tree
    const ready = t !== undefined && !isFailed(t) ? t : undefined
    const countOf = (v: RepoView) => (v === 'branches' ? r.counts.branches : v === 'stash' ? r.counts.stash : v === 'worktrees' ? r.counts.worktrees : undefined)
    const header = card(
      headWith(
        forDesktop(CHANGE_ICON.repo),
        r.name,
        <Box flexDirection="row" gap={1}>
          {ready ? <Text color={DT.textSub}>{`${forDesktop(COMMIT_ICON.branch)} ${ready.branch}`}</Text> : null}
          {ready && ready.ahead > 0 ? <Text color={DT.data} bold>{`↑${ready.ahead}`}</Text> : null}
          {ready ? <Text color={DT.textFaint}>{`${ready.commits.length} commits`}</Text> : null}
        </Box>,
      ),
      [
        ...remoteLines(r, cm),
        actions(
          REPO_VIEWS.map(v => {
            const k = countOf(v.view)
            return pill(`cm-view-${v.view}`, k === undefined ? v.label : `${v.label} ${k}`, v.view === r.view, () => cm.setView(v.view))
          }),
        ),
      ],
    )
    const label = REPO_VIEWS.find(v => v.view === r.view)?.label ?? ''
    const body =
      r.view === 'branches'
        ? branchBody(r.branches, cm, { remote: r.remoteOpen, gone: r.goneOpen })
        : r.view === 'stash'
          ? stashBody(r.stashes, cm)
          : r.view === 'worktrees'
            ? worktreeBody(r.worktrees, cm)
            : logBody(t, cm)
    return (
      <Box flexDirection="column" gap={1}>
        {actions([pill('back', '返回', false, () => cm.back()), pill('cm-refresh', '重新整理', false, () => cm.refreshTree())])}
        {header}
        {card(head(r.view === 'log' ? forDesktop(COMMIT_ICON.branch) : '📂', label), body)}
      </Box>
    )
  }

  // one file of a set at a time: its path and counts, ‹ › to the set's others, then its diff
  const fileDiffPage = (
    title: RenderElement,
    files: readonly NumstatRow[] | Failed | undefined,
    file: NumstatRow | undefined,
    rows: DiffRow[] | Failed | undefined,
    open: (path: string) => void,
    keys: { prev: string; next: string },
    empty: string,
  ): RenderElement => {
    const at = files && !isFailed(files) && file ? Math.max(0, files.findIndex(x => x.path === file.path)) : 0
    const nav =
      files && !isFailed(files) && files.length > 0 && file
        ? stepper(keys, at, files.length, i => {
            const next = files[i]
            if (next) open(next.path)
          })
        : []
    const body: RenderElement[] =
      files === undefined
        ? [say('讀取中…')]
        : isFailed(files)
          ? [say(files.error)]
          : files.length === 0 || !file
            ? [say(empty)]
            : [
                <Box flexDirection="row" gap={1}>
                  <Box flexGrow={1} flexShrink={1} overflow="hidden">
                    {sayStart(file.path, DT.orangeBright, true)}
                  </Box>
                  {file.binary ? <Text color={DT.textSub}>二進位</Text> : counts(file.add, file.del)}
                </Box>,
                diffOf(rows),
              ]
    return (
      <Box flexDirection="column" gap={1}>
        {actions([pill('back', '返回', false, () => ctx.go('commitTree')), ...nav])}
        {card(title, body)}
      </Box>
    )
  }

  const diffTitle = (mark: string, words: string, repo: string): RenderElement => (
    <Box flexDirection="row" justifyContent="space-between" gap={1}>
      <Box flexDirection="row" gap={1} flexShrink={1} overflow="hidden">
        <Text color={DT.data} bold>
          {mark}
        </Text>
        <Text color={DT.orange} bold wrap="truncate">
          {oneLine(words)}
        </Text>
      </Box>
      <Text color={DT.textSub}>{repo}</Text>
    </Box>
  )

  // ---- 分流 -------------------------------------------------------------

  const cm = ctx.commits
  // a sub-page whose session, file, repo, commit or stash left is the page above it
  if (ctx.page === 'fleetDetail') return fleetSelected ? fleetDetailPage(fleetSelected) : fleetPage()
  if (ctx.page === 'fleet') return fleetPage()
  if (ctx.page === 'changeDiff') return changeDiffPage()
  if (ctx.page === 'commitTree' || ctx.page === 'commitDiff' || ctx.page === 'stashDiff') {
    if (!cm?.repo) return changesPage()
    if (ctx.page === 'commitDiff' && cm.diff) {
      const d = cm.diff
      return fileDiffPage(diffTitle(d.commit.sha.slice(0, 7), d.commit.subject, cm.repo.name), d.files, d.file, d.rows, cm.openFile, { prev: 'cdiff-prev', next: 'cdiff-next' }, '這個 commit 沒有改檔案')
    }
    if (ctx.page === 'stashDiff' && cm.stashDiff) {
      const d = cm.stashDiff
      return fileDiffPage(diffTitle(d.stash.name, d.stash.message, cm.repo.name), d.files, d.file, d.rows, cm.openStashFile, { prev: 'sdiff-prev', next: 'sdiff-next' }, '這個 stash 沒有檔案')
    }
    return commitTreePage(cm, cm.repo)
  }
  return changesPage()
}
