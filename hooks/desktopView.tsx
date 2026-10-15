import type { ElementConstructor, MarkdownProps, RenderElement } from 'claude-code'

import { HEALTH_TEXT, TABS } from './cockpit'
import type { Ctx, Ui } from './cockpit'
import { DT, LIGHT, backdropSvg } from './desktopTheme'
import { BIG_ROWS, bigWidth } from './fleetChart'
import { ROLE_ICON, forDesktop } from './icons'
import { CHAIN_WARN, MAIN_ACTOR, MAIN_SOURCE, ROLE_LABEL, THEME, elapsedMs, fitCells, fmtClock, fmtDur, fmtK, fmtMs, fmtUsd, phaseOf, roleModels, roleOf, shareLabel, shortModel, tokenTotal, tokensOf, topTools } from './jarvis'
import type { Cockpit, Phase } from './jarvis'
import { POWER_METER_W, SUIT_CANVAS_COLS, SUIT_CANVAS_ROWS, crewDeployed, framePixels, standbyReadouts } from './suit'
import type { Readout } from './suit'
import { bigTextSvg, cellPx, clamp01, meterSvg, rampBarSvg, reactorSvg, rowPx, stackedBarSvg, suitSvg, svgSafe } from './svgArt'
import type { JarvisAgent, JarvisPage } from '../types'

export type DesktopUi = Ui & { Markdown?: ElementConstructor<MarkdownProps> }

// The pages the native Desktop layout draws; every other page keeps drawCockpit.
export const DESKTOP_PAGES: readonly JarvisPage[] = ['now', 'stats']

// Whether the native layout draws this page: not while the boot screen plays.
export const desktopPage = (page: JarvisPage, ctx: Pick<Ctx, 'boot'>): boolean => ctx.boot === undefined && DESKTOP_PAGES.includes(page)

// a Markdown table cell: line breaks flattened, pipes and inline Markdown marks escaped
export const mdCell = (s: string): string => s.replace(/\r\n?|\n/g, ' ').replace(/[\\`*_[\]<>|~]/g, '\\$&')

export type EventCell = { time: string; who: string; tool: string; desc: string; took: string; mark: string }

// The recent events as a Markdown table, newest first as given; nothing to show, ''.
export function eventsTable(rows: readonly EventCell[]): string {
  if (rows.length === 0) return ''
  const head = ['| 時間 | 誰 | 工具 | 描述 | 耗時 | |', '|---|---|---|---|---:|:-:|']
  const body = rows.map(r => `| ${[r.time, r.who, r.tool, r.desc, r.took, r.mark].map(mdCell).join(' | ')} |`)
  return [...head, ...body].join('\n')
}

// The most rows a page is drawn for, whatever the room says.
const MAX_ROWS = 500

export function drawDesktop(ui: DesktopUi, view: Cockpit, ctx: Ctx): RenderElement {
  const { Box, Text, Button, Svg } = ui
  const cols = ctx.cols
  const rows = Number.isFinite(ctx.rows) && ctx.rows > 0 ? Math.min(ctx.rows, MAX_ROWS) : 40

  // a picture in whole cells and rows, or its words where it cannot go
  const picture = (source: string, alt: string, wide: number, tall: number, animated = false): RenderElement =>
    Svg && svgSafe(source) ? (
      <Svg source={source} alt={alt} width={cellPx(wide)} height={rowPx(tall)} {...(animated ? { isInteractive: true } : {})} />
    ) : (
      <Text color={DT.textSub}>{alt}</Text>
    )

  // an orange pill: a round box round a frameless button; solid for the current or main one
  const pill = (key: string, label: string, solid: boolean, onPress: () => void): RenderElement => (
    <Box borderStyle="round" borderColor={solid ? DT.orange500 : DT.orange200} backgroundColor={solid ? DT.orange500 : DT.orange50} paddingX={1}>
      <Button key={key} plain onPress={onPress}>
        <Text color={solid ? DT.onSolid : DT.orange700} bold={solid}>
          {label}
        </Text>
      </Button>
    </Box>
  )

  const live = view.running.length > 0
  const titleBar = (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text color={DT.orange900} bold>
          ⌜
        </Text>
        <Text color={THEME.suitRed} bold>
          J.A.R.V.I.S.
        </Text>
        <Text color={DT.orange900} bold>
          ⌝
        </Text>
        {picture(reactorSvg(live, LIGHT), live ? '反應爐運轉中' : '反應爐待機', 1, 1, live)}
      </Box>
      <Text color={view.health === 'ok' ? DT.orange700 : DT.fail} bold>
        {HEALTH_TEXT[view.health]}
      </Text>
    </Box>
  )

  const tabBar = (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {TABS.map(tab => pill(`tab-${tab.page}`, `${forDesktop(tab.icon)} ${tab.label}`, tab.page === ctx.page, () => ctx.go(tab.page)))}
    </Box>
  )

  // the pane less its padding, and a card's inside less its frame and padding
  const inner = Math.max(20, cols - 4)
  const cardInner = Math.max(16, inner - 6)
  const wide = cols >= 90

  const head = (icon: string, title: string, right?: string): RenderElement => (
    <Box flexDirection="row" justifyContent="space-between">
      <Text color={DT.orange500} bold>
        {`${icon} ${title}`}
      </Text>
      {right === undefined ? null : <Text color={DT.textSub}>{right}</Text>}
    </Box>
  )

  // a glass card: translucent white, a pale orange round frame, padded and spaced inside
  const card = (top: RenderElement, body: readonly RenderElement[], accent?: string, grow = false): RenderElement => (
    <Box
      flexDirection="column"
      backgroundColor={DT.glass}
      borderStyle="round"
      borderColor={accent ?? DT.glassBorder}
      paddingX={2}
      paddingY={1}
      gap={1}
      {...(grow ? { flexGrow: 1, flexShrink: 1 } : {})}
    >
      {top}
      {body}
    </Box>
  )

  // a raised tile inside a card
  const tile = (body: readonly RenderElement[]): RenderElement => (
    <Box flexDirection="column" backgroundColor={DT.glassRaised} borderStyle="round" borderColor={DT.orange200} paddingX={1}>
      {body}
    </Box>
  )

  const toneColor = (t: Readout['tone']): string =>
    t === 'error' ? DT.fail : t === 'bright' ? DT.orange700 : t === 'frame' ? DT.textSub : DT.orange500

  const readoutLine = (x: Readout): RenderElement => (
    <Box flexDirection="row" gap={1} alignItems="center">
      {x.label === '' ? null : <Text color={DT.textSub}>{x.label}</Text>}
      {x.meter
        ? picture(meterSvg(Math.round(clamp01(x.meter.pct) * POWER_METER_W), POWER_METER_W, toneColor(x.tone), LIGHT), `${x.label} ${x.value}`, POWER_METER_W, 1)
        : null}
      <Text color={toneColor(x.tone)} bold>
        {x.value}
      </Text>
    </Box>
  )

  const memberOf = (a: JarvisAgent) => view.roster.get(a.id) ?? { n: 0, color: DT.orange500 }
  const PHASE_TEXT: Record<Phase, string> = { init: 'INIT', active: 'ACTIVE', waiting: 'WAITING', complete: 'COMPLETE', failed: 'FAILED', lost: 'LOST' }
  const phaseColor = (p: Phase): string => (p === 'failed' || p === 'lost' ? DT.fail : p === 'complete' ? DT.ok : DT.data)
  // a row's columns in fixed widths, one cell apart; where the card is too narrow the model,
  // the tokens and then the role give way, so the row never reaches past the card
  const COL = { mk: 6, role: 12, model: 8, phase: 9, time: 6, tok: 6 }
  const DESC_MIN = 8
  const shown = new Set<keyof typeof COL>(['mk', 'role', 'model', 'phase', 'time', 'tok'])
  const fixedW = () => [...shown].reduce((sum, k) => sum + COL[k], 0) + shown.size
  for (const k of ['model', 'tok', 'role'] as const) if (fixedW() + DESC_MIN > cardInner) shown.delete(k)
  const descW = Math.max(1, cardInner - fixedW())

  const agentRow = (a: JarvisAgent): RenderElement => {
    const m = memberOf(a)
    const p = phaseOf(a, view.now)
    const role = roleOf(a.type)
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Box width={COL.mk} flexShrink={0}>
          <Button key={`agent-${a.id}`} plain onPress={() => ctx.open(a.id)}>
            <Text color={m.color} bold>{`MK-${m.n}`}</Text>
          </Button>
        </Box>
        {shown.has('role') ? (
          <Box width={COL.role} flexShrink={0} overflow="hidden">
            <Text color={DT.text} wrap="truncate">{`${ROLE_ICON[role]} ${ROLE_LABEL[role]}`}</Text>
          </Box>
        ) : null}
        {shown.has('model') ? (
          <Box width={COL.model} flexShrink={0} overflow="hidden">
            <Text color={DT.textSub} wrap="truncate">
              {shortModel(a.model)}
            </Text>
          </Box>
        ) : null}
        <Box width={descW} flexShrink={0} overflow="hidden">
          <Text color={DT.text} wrap="truncate">
            {a.description}
          </Text>
        </Box>
        <Box width={COL.phase} flexShrink={0}>
          <Text color={phaseColor(p)} bold>
            {PHASE_TEXT[p]}
          </Text>
        </Box>
        <Box width={COL.time} flexShrink={0} justifyContent="flex-end">
          <Text color={DT.textSub}>{fmtDur(elapsedMs(a, view.now))}</Text>
        </Box>
        {shown.has('tok') ? (
          <Box width={COL.tok} flexShrink={0} justifyContent="flex-end">
            <Text color={DT.textFaint}>{fmtK(tokenTotal(tokensOf(a)))}</Text>
          </Box>
        ) : null}
      </Box>
    )
  }

  const actorName = (actor: string): string => (actor === MAIN_ACTOR ? MAIN_SOURCE : `MK-${view.roster.get(actor)?.n ?? '?'}`)

  const nowPage = (): RenderElement => {
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
    const busy = view.inflight.some(f => f.actor === MAIN_ACTOR) || view.running.some(a => a.waiting !== true)
    const paused = ctx.suitPaused === true
    const crew = crewDeployed(now, ctx.deployedAt)
    const suitPic = picture(
      suitSvg(framePixels(0, { busy, now, still: true }).px, { busy, crewFlash: crew, paused, sights: true }, LIGHT),
      'MARK XLII',
      SUIT_CANVAS_COLS + 4,
      SUIT_CANVAS_ROWS,
      !paused,
    )
    const mark = `MARK XLII · ${paused ? 'PAUSED' : busy ? 'ACTIVE' : 'STANDBY'}`
    const suitCard = (
      <Box flexDirection="column" backgroundColor={DT.glass} borderStyle="round" borderColor={DT.orange500} paddingX={2} paddingY={1} gap={1} alignItems="center">
        <Box flexDirection={wide ? 'row' : 'column'} gap={2} alignItems="center">
          {tile(r.left.map(readoutLine))}
          {suitPic}
          {tile(r.right.map(readoutLine))}
        </Box>
        {ctx.toggleSuit ? (
          <Button key="suit-mark" plain onPress={ctx.toggleSuit}>
            <Text color={DT.text} bold>
              {mark}
            </Text>
          </Button>
        ) : (
          <Text color={DT.text} bold>
            {mark}
          </Text>
        )}
        <Text color={DT.orange700}>{crew ? '◆ CREW DEPLOYED' : view.running.length > 0 ? 'CREW DEPLOYED, SIR.' : 'ALL CREW DOCKED, SIR.'}</Text>
      </Box>
    )

    const agents = view.sections.flatMap(s => s.units.flatMap(u => (u.kind === 'agent' ? [u.agent] : u.agents)))
    const done = view.finished.filter(a => a.status === 'done').length
    const listCard = card(
      head('👥', '子代理', `▶${view.running.length} 執行中 · ${done} 完成`),
      agents.length === 0 ? [<Text color={DT.textSub}>還沒有派工。派出 subagent 後這裡會即時顯示。</Text>] : agents.slice(0, Math.max(3, rows - 30)).map(agentRow),
      view.running.length > 0 ? DT.data : undefined,
    )

    const flights = view.inflight.slice(-5)
    const flightCard = card(
      head('⚙️', '進行中', `${view.inflight.length} 個`),
      flights.length === 0
        ? [<Text color={DT.textSub}>目前沒有執行中的工具呼叫</Text>]
        : flights.map(f => (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Box width={6} flexShrink={0}>
                <Text color={DT.orange700}>{actorName(f.actor)}</Text>
              </Box>
              <Box width={10} flexShrink={0} overflow="hidden">
                <Text color={DT.text} bold wrap="truncate">
                  {f.tool}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text color={DT.textSub} wrap="truncate">
                  {f.desc ?? ''}
                </Text>
              </Box>
              <Text color={DT.textFaint}>{fmtDur(now - f.startedAt)}</Text>
            </Box>
          )),
      undefined,
      true,
    )

    const recentRows = view.events
      .slice(-6)
      .reverse()
      .map(ev => ({
        time: fmtClock(ev.ts),
        who: actorName(ev.actor),
        tool: ev.tool,
        desc: fitCells(ev.desc, 40),
        took: fmtMs(ev.ms),
        mark: ev.ok ? '✓' : '✗',
      }))
    const { Markdown } = ui
    const table = eventsTable(recentRows)
    const recentCard = card(
      head('🕘', '最近事件', `${view.events.length} 則`),
      table === ''
        ? [<Text color={DT.textSub}>還沒有工具呼叫</Text>]
        : [Markdown ? <Markdown key="recent-events" text={table} /> : <Text color={DT.text}>{table}</Text>],
      undefined,
      true,
    )

    // the suit drawn still: no frames asked of the clock, the quota read as ever
    ctx.onStandby?.(true, undefined)
    return (
      <Box flexDirection="column" gap={1}>
        {suitCard}
        {listCard}
        <Box flexDirection={wide ? 'row' : 'column'} gap={wide ? 2 : 1}>
          {flightCard}
          {recentCard}
        </Box>
      </Box>
    )
  }

  const MODEL_COLORS = [DT.orange500, DT.data, DT.ok, DT.orange200]

  const statsPage = (): RenderElement => {
    const m = view.main
    const total = m.ok + m.fail
    const rate = total === 0 ? undefined : Math.round((m.ok / total) * 100)
    const rateText = rate === undefined ? '--' : `${rate}%`
    const rateColor = rate === undefined ? DT.textFaint : rate >= 90 ? DT.orange500 : rate >= 70 ? DT.orange700 : DT.fail
    const chainColor = m.chain >= CHAIN_WARN ? DT.fail : DT.orange500
    const top = topTools(m.toolCounts, 1)[0]
    const mainCard = card(head('💻', 'MAIN LINE', `${shortModel(m.model)} · ${m.isRunning ? '● 運作中' : '○ 閒置'}`), [
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {tile([<Text color={DT.textSub}>SUCCESS RATE</Text>, picture(bigTextSvg(rateText, rateColor), `SUCCESS RATE ${rateText}`, bigWidth(rateText), BIG_ROWS)])}
        {tile([
          <Text color={DT.textSub}>{`OK   ${m.ok}`}</Text>,
          <Text color={m.fail > 0 ? DT.fail : DT.textSub}>{`FAIL ${m.fail}`}</Text>,
        ])}
        {tile([
          <Text color={DT.textSub}>CHAIN</Text>,
          <Box flexDirection="row" gap={1} alignItems="center">
            {picture(meterSvg(Math.min(m.chain, CHAIN_WARN), CHAIN_WARN, chainColor, LIGHT), `CHAIN ${m.chain}/${CHAIN_WARN}`, CHAIN_WARN, 1)}
            <Text color={chainColor} bold>{`${m.chain}/${CHAIN_WARN}`}</Text>
          </Box>,
        ])}
        {tile([
          <Text color={DT.textSub}>{`TOP  ${top ? `${top.tool} ${top.count}` : '--'}`}</Text>,
          <Text color={DT.text} wrap="truncate">{`LAST ${m.lastTool === '' ? '--' : `${m.lastTool} ${m.lastDesc}`}`}</Text>,
        ])}
      </Box>,
    ])

    const counts = view.dispatch.map(d => d.running + d.done + d.failed)
    const dmax = Math.max(1, ...counts)
    const models = roleModels([...view.running, ...view.stale, ...view.finished])
    // as the subagent rows: where the card is too narrow the model gives way, so the row
    // never reaches past the card
    const DCOL = { name: 14, model: 8, count: 4 }
    const BAR_MIN = 6
    const showModel = DCOL.name + DCOL.model + DCOL.count + 3 + BAR_MIN <= cardInner
    const barW = Math.max(1, cardInner - DCOL.name - DCOL.count - 2 - (showModel ? DCOL.model + 1 : 0))
    const shownRoles = view.dispatch.filter((d, i) => (d.role !== 'workflow' && d.role !== 'other') || (counts[i] ?? 0) > 0)
    const dispatchCard = card(
      head('📨', 'DISPATCH', `${counts.reduce((sum, n) => sum + n, 0)} 次派工`),
      shownRoles.map(d => {
        const n = d.running + d.done + d.failed
        return (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Box width={DCOL.name} flexShrink={0}>
              <Button key={`role-${d.role}`} plain onPress={() => ctx.openRole?.(d.role)}>
                <Text color={DT.orange700} bold>{`${ROLE_ICON[d.role]} ${d.label}`}</Text>
              </Button>
            </Box>
            {showModel ? (
              <Box width={DCOL.model} flexShrink={0} overflow="hidden">
                <Text color={DT.textSub} wrap="truncate">
                  {models.get(d.role)?.label ?? ''}
                </Text>
              </Box>
            ) : null}
            {picture(rampBarSvg(barW, n / dmax, d.failed > 0 ? [DT.orange400, DT.orange500, DT.fail] : [DT.orange400, DT.orange500], LIGHT), `${d.label} ${n}`, barW, 1)}
            <Box width={DCOL.count} flexShrink={0} justifyContent="flex-end">
              <Text color={n > 0 ? DT.text : DT.textFaint} bold={n > 0}>
                {String(n)}
              </Text>
            </Box>
          </Box>
        )
      }),
    )

    const { Markdown } = ui
    const s = view.summary
    const modelsTable =
      view.models.length === 0
        ? ''
        : ['| 模型 | 比例 | 次數 |', '|---|---:|---:|', ...view.models.map(x => `| ${mdCell(x.label)} | ${shareLabel(x.share)} | ${x.count} |`)].join('\n')
    const modelsCard = card(head('🧠', 'MODELS', s.savedPct === undefined ? undefined : `SAVED ${Math.round(s.savedPct)}%`), [
      picture(
        stackedBarSvg(cardInner, view.models.map((x, i) => ({ share: x.share, color: MODEL_COLORS[i % MODEL_COLORS.length] ?? DT.orange500 })), LIGHT),
        'MODELS',
        cardInner,
        1,
      ),
      modelsTable === '' ? (
        <Text color={DT.textSub}>還沒有模型用量</Text>
      ) : Markdown ? (
        <Markdown key="models-table" text={modelsTable} />
      ) : (
        <Text color={DT.text}>{modelsTable}</Text>
      ),
      <Text color={DT.orange700}>{`SAVED ${s.savedPct === undefined ? '--' : `${Math.round(s.savedPct)}%`}  ≈${fmtUsd(s.cost)} vs Opus ${fmtUsd(s.opusCost)}`}</Text>,
    ])

    return (
      <Box flexDirection="column" gap={1}>
        {mainCard}
        {dispatchCard}
        {modelsCard}
      </Box>
    )
  }

  const page: RenderElement = ctx.page === 'now' ? nowPage() : statsPage()
  if (ctx.page !== 'now') ctx.onStandby?.(false)

  return (
    <Box flexDirection="column" position="relative" backgroundColor={DT.bg} minHeight={rows} paddingX={2} paddingY={1}>
      {Svg ? (
        <Box position="absolute" top={0} left={0}>
          {picture(backdropSvg(cols, rows), '背景', cols, rows)}
        </Box>
      ) : null}
      {/* Desktop paints an absolute backdrop over in-flow content, so the content is absolute too, as the later sibling */}
      <Box position="absolute" top={1} left={2} width={Math.max(1, cols - 4)} flexDirection="column" gap={1}>
        {titleBar}
        {tabBar}
        {page}
      </Box>
    </Box>
  )
}
