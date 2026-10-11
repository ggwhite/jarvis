import type { FleetQuota, FleetSession, FleetStatus, QuotaWindow } from '../types'
import {
  CONTEXT_ALERT,
  CONTEXT_WARN,
  DECOMMISSION_MS,
  beatsOf,
  decommissionCount,
  emptyHours,
  fmtAgo,
  fmtBig,
  forecast,
  quotaStale,
} from './fleet'
import { RING_BIG, RING_SMALL, brailleLine, cellsToSegs, gaugeBar, gaugeCells } from './fleetChart'
import type { ChartSeg } from './fleetChart'
import { THEME, cellWidth, fitCells, fmtClock, fmtDate, fmtUsd, padCells, shortModel } from './jarvis'

// A suit as drawn: `chip` the label of its number Button, `top` what follows it on its
// first row, `body` the rows below; the caller sets the hotkey cells before them.
export type CardLines = { chip: ChartSeg[]; top: ChartSeg[]; body: ChartSeg[][] }
// `idleMax`: the highest hour of today among the idle suits (idleHourMax), the top every
// idle suit's day is scaled to; without it each is scaled to its own.
export type SuitOpts = { now: number; self: boolean; idleMax?: number }

export const TITLE_MIN = 8
export const SELF_TEXT = 'THIS'

const F = THEME.frame
const P = THEME.primary
const A = THEME.accent
const B = THEME.bright
const E = THEME.error
const M = THEME.muted

const sp = (n: number): ChartSeg => ({ t: ' '.repeat(Math.max(0, n)) })

export const segsWidth = (segs: readonly ChartSeg[]): number => segs.reduce((n, s) => n + cellWidth(s.t), 0)

// A view kept from before the burn chart has no hours: 24 zeros then.
export function hourlyOf(v: { hourly?: readonly number[] }): number[] {
  return v.hourly && v.hourly.length === 24 ? [...v.hourly] : emptyHours()
}

// ── TITLE ───── right ──, `w` cells.
export function sectionHeader(title: string, w: number, right?: string): ChartSeg[] {
  const tail = right === undefined ? '──' : ` ${right} ──`
  const fill = Math.max(0, w - cellWidth(`── ${title} `) - cellWidth(tail))
  return [
    { t: '── ', color: F },
    { t: title, color: P, bold: true },
    { t: ` ${'─'.repeat(fill)}`, color: F },
    ...(right === undefined ? [{ t: '──', color: F }] : [{ t: ' ', color: F }, { t: right, color: B, bold: true }, { t: ' ──', color: F }]),
  ]
}

export type Foot = { t: string; color: string; depleted: boolean }

const resetText = (ts: number, now: number): string => {
  const hm = fmtClock(ts).slice(0, 5)
  return ts - now < 86_400_000 ? hm : `${fmtDate(ts)} ${hm}`
}

// What a quota window says under its gauge: when it resets; when it runs out first (at
// the pace so far, measured at the cache's time); used up; stale with its reset kept.
export function windowFoot(w: QuotaWindow, q: FleetQuota, now: number, long: boolean): Foot {
  const reset = `RESET ${resetText(w.resetsAt, now)}`
  if (quotaStale(q, now)) return { t: `STALE · ${reset}`, color: F, depleted: false }
  const f = forecast(w, q.fetchedAt)
  if (f?.beforeReset) {
    if (w.usedPct >= 100) return { t: 'DEPLETED', color: E, depleted: true }
    return { t: `${long ? 'DEPLETED IN ~' : 'DEPLETED ~'}${fmtAgo(Math.max(0, f.depleteAt - now))}`, color: E, depleted: true }
  }
  return { t: reset, color: F, depleted: false }
}

export type GaugeIn = { label: string; used: number; foot: Foot }

const pctText = (used: number): string => `${Math.round(used)}%`

const bigBlock = (g: GaugeIn, hw: number): ChartSeg[][] => {
  const cells = gaugeCells(RING_BIG, g.used / 100, g.foot.depleted, [
    { row: 2, text: g.label, color: F, bold: true },
    { row: 3, text: pctText(g.used), color: B, bold: true },
  ])
  const left = Math.max(0, Math.floor((hw - RING_BIG.w) / 2))
  const rows = cells.map(r => [sp(left), ...cellsToSegs(r), sp(hw - RING_BIG.w - left)])
  const foot = fitCells(g.foot.t, hw)
  const fl = Math.floor((hw - cellWidth(foot)) / 2)
  return [...rows, [sp(fl), { t: foot, color: g.foot.color, bold: true }, sp(hw - cellWidth(foot) - fl)]]
}

const smallBlock = (g: GaugeIn, hw: number): ChartSeg[][] => {
  const cells = gaugeCells(RING_SMALL, g.used / 100, g.foot.depleted, [])
  const tw = Math.max(0, hw - 1 - RING_SMALL.w - 2)
  const texts: ChartSeg[][] = [
    [{ t: g.label, color: F, bold: true }, sp(2), { t: pctText(g.used), color: B, bold: true }],
    [{ t: fitCells(g.foot.t, tw), color: g.foot.color, bold: true }],
    [],
  ]
  return cells.map((r, i) => {
    const t = texts[i] ?? []
    return [sp(1), ...cellsToSegs(r), sp(2), ...t, sp(tw - segsWidth(t))]
  })
}

const BAR_FIXED = 12

const shortFoot = (t: string): string => t.replace(/^RESET /, '').replace(/^DEPLETED (IN )?/, '')

const barRows = (gauges: readonly GaugeIn[], w: number): ChartSeg[][] => {
  let feet = gauges.map(g => g.foot.t)
  let bar = w - BAR_FIXED - Math.max(0, ...feet.map(cellWidth))
  if (bar < 8) {
    feet = feet.map(shortFoot)
    bar = Math.max(4, w - BAR_FIXED - Math.max(0, ...feet.map(cellWidth)))
  }
  return gauges.map((g, i) => [
    sp(1),
    { t: g.label, color: F, bold: true },
    sp(1),
    { t: '▕', color: F },
    ...cellsToSegs(gaugeBar(bar, g.used / 100, g.foot.depleted)),
    { t: '▏', color: F },
    sp(1),
    { t: padCells(pctText(g.used), 4, 'right'), color: B, bold: true },
    sp(1),
    { t: fitCells(feet[i] ?? '', Math.max(0, w - BAR_FIXED - bar)), color: g.foot.color, bold: true },
  ])
}

// The arc reactor section's rows: two rings side by side (big or small), or a bar a window.
export function reactorRows(form: 'big' | 'small' | 'bar', gauges: readonly GaugeIn[], w: number): ChartSeg[][] {
  if (form === 'bar') return barRows(gauges, w)
  const halves = [Math.floor(w / 2), w - Math.floor(w / 2)]
  const height = form === 'big' ? 8 : 3
  const blocks = halves.map((hw, i) => {
    const g = gauges[i]
    if (!g) return Array.from({ length: height }, () => [sp(hw)])
    return form === 'big' ? bigBlock(g, hw) : smallBlock(g, hw)
  })
  return Array.from({ length: height }, (_, r) => blocks.flatMap((b, i) => b[r] ?? [sp(halves[i] ?? 0)]))
}

const STATUS: Record<FleetStatus, { icon: string; color: string; badge: string; badgeFg: string; badgeBg: string }> = {
  blocked: { icon: '▲', color: E, badge: ' AWAITING ', badgeFg: B, badgeBg: E },
  working: { icon: '◆', color: A, badge: ' ACTIVE ', badgeFg: M, badgeBg: A },
  idle: { icon: '◇', color: F, badge: ' STANDBY ', badgeFg: P, badgeBg: M },
}

// The title in at most `room` cells, THIS after it on this session's while the title keeps
// TITLE_MIN cells.
const titled = (title: string, room: number, self: boolean, color: string): ChartSeg[] => {
  const selfW = cellWidth(SELF_TEXT) + 1
  const withSelf = self && room - selfW >= TITLE_MIN
  const tw = Math.max(1, Math.min(cellWidth(title), withSelf ? room - selfW : room))
  return [{ t: fitCells(title, tw), color, bold: true }, ...(withSelf ? [sp(1), { t: SELF_TEXT, color: F, bold: true }] : [])]
}

const ctxBar = (pct: number | undefined, n: number): ChartSeg[] => {
  const tone = pct === undefined ? F : pct >= CONTEXT_ALERT ? E : pct >= CONTEXT_WARN ? A : P
  const fill = pct === undefined ? 0 : Math.min(n, Math.max(0, Math.round((pct * n) / 100)))
  return [
    { t: 'CTX ', color: F },
    { t: '▰'.repeat(fill), color: tone },
    { t: '▱'.repeat(n - fill), color: M },
    sp(1),
    { t: pct === undefined ? '  --' : padCells(`${pct}%`, 4, 'right'), color: tone, bold: true },
  ]
}

const ctxTone = (pct: number | undefined): string =>
  pct === undefined ? F : pct >= CONTEXT_ALERT ? E : pct >= CONTEXT_WARN ? A : P

const bottom = (w: number): ChartSeg[] => [{ t: `╰${'─'.repeat(Math.max(0, w - 2))}╯`, color: F }]

const sparkOf = (s: FleetSession, now: number, width: number): string => brailleLine(beatsOf(s.stamps, now), width)

// An idle suit's line: today by the hour, scaled to the fleet's idle peak when given.
const daySparkOf = (s: FleetSession, width: number, top: number | undefined): string => brailleLine(hourlyOf(s), width, top)

// The highest hour of today among `idle`: what SuitOpts.idleMax asks.
export function idleHourMax(idle: readonly FleetSession[]): number {
  return Math.max(0, ...idle.flatMap(s => hourlyOf(s)))
}

// A busy suit's card, `w` cells: its title and badge in the top border; the last hour's
// line, the model, the tool in flight and how long this run has gone; the context and
// what it burned today.
export function wideCard(s: FleetSession, w: number, o: SuitOpts): CardLines {
  const st = STATUS[s.status]
  const badgeW = cellWidth(st.badge)
  const chip: ChartSeg[] = [{ t: '╭─ ', color: F }, { t: st.icon, color: st.color, bold: true }]
  const title = titled(s.title, w - 9 - badgeW, o.self, B)
  const fill = Math.max(1, w - 8 - segsWidth(title) - badgeW)
  const top: ChartSeg[] = [
    sp(1),
    ...title,
    { t: ` ${'─'.repeat(fill)}`, color: F },
    { t: st.badge, color: st.badgeFg, bg: st.badgeBg, bold: true },
    { t: '─╮', color: F },
  ]
  const inner = Math.max(0, w - 4)
  const S = Math.min(inner, Math.max(2, Math.round(inner * 0.55)))
  const run = s.runSince === undefined ? undefined : fmtAgo(o.now - s.runSince)
  const parts = [s.model ? shortModel(s.model) : undefined, s.tool, run].filter((x): x is string => x !== undefined && x !== '')
  const info = fitCells(parts.join(' · '), Math.max(0, inner - S - 1))
  const row1: ChartSeg[] = [
    { t: '│ ', color: F },
    { t: sparkOf(s, o.now, S), color: st.color },
    sp(inner - S - cellWidth(info)),
    { t: info, color: F },
    { t: ' │', color: F },
  ]
  const bar = ctxBar(s.contextPct, 10)
  const today = fitCells(`TODAY ${fmtBig(s.todayTokens)} · ${fmtUsd(s.todayCost)}`, Math.max(0, inner - segsWidth(bar) - 1))
  const row2: ChartSeg[] = [
    { t: '│ ', color: F },
    ...bar,
    sp(inner - segsWidth(bar) - cellWidth(today)),
    { t: today, color: A },
    { t: ' │', color: F },
  ]
  return { chip, top, body: [row1, row2, bottom(w)] }
}

const idleTag = (s: FleetSession, now: number): ChartSeg => {
  const ms = s.lastAt === undefined ? undefined : now - s.lastAt
  if (ms !== undefined && ms > DECOMMISSION_MS) return { t: 'RETIRE', color: F, bold: true }
  return { t: `IDLE ${ms === undefined ? '--' : fmtAgo(ms)}`, color: F }
}

// An idle suit's card, `w` cells: its title and idle time (RETIRE past a day) in the top
// border, today's line by the hour and its context.
export function smallCard(s: FleetSession, w: number, o: SuitOpts): CardLines {
  const chip: ChartSeg[] = [{ t: '╭─ ', color: F }, { t: '◇', color: F, bold: true }]
  const tag = idleTag(s, o.now)
  const tagW = cellWidth(tag.t)
  const title = titled(s.title, w - 10 - tagW, o.self, P)
  const fill = Math.max(1, w - 9 - segsWidth(title) - tagW)
  const top: ChartSeg[] = [sp(1), ...title, { t: ` ${'─'.repeat(fill)} `, color: F }, tag, { t: ' ╮', color: F }]
  const inner = Math.max(0, w - 4)
  const bar = ctxBar(s.contextPct, 5)
  const room = inner - segsWidth(bar) - 1
  const S = room >= 2 ? Math.min(10, room) : 0
  const used = (S > 0 ? S + 1 : 0) + segsWidth(bar)
  const mid: ChartSeg[] = [
    { t: '│ ', color: F },
    ...(S > 0 ? [{ t: daySparkOf(s, S, o.idleMax), color: P }, sp(1)] : []),
    ...bar,
    sp(inner - used),
    { t: ' │', color: F },
  ]
  return { chip, top: fitTop(top, w - 4), body: [mid, bottom(w)] }
}

// keeps a top border within its room when the card is narrower than its title and tag
const fitTop = (top: ChartSeg[], room: number): ChartSeg[] => {
  let over = segsWidth(top) - room
  if (over <= 0) return top
  return top.map(s => {
    if (over <= 0 || !/^ ─+ $/.test(s.t)) return s
    const cut = Math.min(over, s.t.length - 3)
    over -= cut
    return { ...s, t: ` ${'─'.repeat(s.t.length - 2 - cut)} ` }
  })
}

const IDLE_W = 6

// One suit on one line, `w` cells: its icon (the Button), title, a line when `spark` cells
// are asked and there is room (the last hour; today by the hour when idle), its context,
// and how long idle.
export function suitLine(s: FleetSession, w: number, o: SuitOpts & { spark: number }): CardLines {
  const st = STATUS[s.status]
  const chip: ChartSeg[] = [{ t: st.icon, color: st.color, bold: true }]
  const ms = s.status === 'working' || s.lastAt === undefined ? undefined : o.now - s.lastAt
  const idle = ms === undefined ? '' : ms > DECOMMISSION_MS ? 'RETIRE' : fmtAgo(ms)
  // the cells beside the title: a space, the line and a space, the context, the idle time
  const fixed = (spark: number, idleOn: boolean) => 1 + 1 + (spark > 0 ? spark + 1 : 0) + 4 + (idleOn ? 1 + IDLE_W : 0)
  const tries: [number, boolean][] = [
    [o.spark, idle !== ''],
    [0, idle !== ''],
    [o.spark, false],
    [0, false],
  ]
  const [spark, idleOn] = tries.find(([sp_, id]) => w - 1 - fixed(sp_, id) >= TITLE_MIN) ?? [0, false]
  const tw = Math.max(1, w - 1 - fixed(spark, idleOn))
  const title = titled(s.title, tw, o.self, s.status === 'idle' ? P : B)
  const top: ChartSeg[] = [
    sp(1),
    ...title,
    sp(tw - segsWidth(title)),
    sp(1),
    ...(spark > 0 ? [{ t: s.status === 'idle' ? daySparkOf(s, spark, o.idleMax) : sparkOf(s, o.now, spark), color: st.color }, sp(1)] : []),
    { t: s.contextPct === undefined ? '  --' : padCells(`${s.contextPct}%`, 4, 'right'), color: ctxTone(s.contextPct), bold: true },
    ...(idleOn ? [sp(1), { t: padCells(idle, IDLE_W, 'right'), color: F }] : []),
  ]
  return { chip, top, body: [] }
}

// ◇ STANDBY N 艘 · M 艘可退役 (the second half only when some are).
export function idleSummary(idle: readonly FleetSession[], now: number): ChartSeg[] {
  const m = decommissionCount(idle, now)
  return [
    { t: '◇ ', color: F },
    { t: 'STANDBY', color: P, bold: true },
    { t: ` ${idle.length}`, color: B, bold: true },
    { t: ' 艘', color: F },
    ...(m > 0 ? [{ t: ' · ', color: M }, { t: String(m), color: A, bold: true }, { t: ' 艘可退役', color: F }] : []),
  ]
}
