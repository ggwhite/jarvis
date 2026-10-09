import type { EngineInterface, RenderElement } from 'claude-code'

import type { CrewAgent, CrewEvent, CrewInflight, CrewPage } from '../types'
import {
  CHAIN_WARN,
  FAMILY_COLOR,
  MAX_EVENTS,
  SLOW_MS,
  barLen,
  cellWidth,
  elapsedMs,
  fitCells,
  fmtClock,
  fmtDur,
  fmtK,
  fmtMs,
  fmtUsd,
  nameFamilyOf,
  padCells,
  roleOf,
  shareLabel,
  shortModel,
  summaryLine,
  tokenTotal,
  tokensOf,
} from './crew'
import type { Cockpit, Health, ListUnit, ModelShare, Role, RoleStat } from './crew'

// At this many columns the stats page sets the main and dispatch cards side by side.
export const WIDE_COLS = 120
// Below this the stats page stacks the model and savings cards.
export const TINY_COLS = 64
export const MIN_EVENT_ROWS = 4
// Events the now page shows, newest last.
export const RECENT_EVENTS = 5
// Cells in the main chain bar: full at CHAIN_WARN calls.
const CHAIN_BAR = 16
// Cells a plain Button's hotkey takes before its label: `1: `.
const HOTKEY_W = 3
// Cells a chrome Button adds around its label: `[ ` and ` ]`.
const BUTTON_CHROME = 4

type Ui = Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Text' | 'Button'>

export type Seg = { t: string; color?: string; dim?: boolean; bold?: boolean; inverse?: boolean }

type Block = { node: RenderElement; h: number }

// A card line is a row of segments, or a ready node that takes `h` rows (the role boxes).
type Line = Seg[] | { node: RenderElement; h: number }

type CardSpec = { w: number; color: string; lines: Line[] }

export type Ctx = {
  cols: number
  rows: number
  frame: string
  page: CrewPage
  // the subagent the detail page is about
  agentId: string
  paused: boolean
  // events recorded since the pause
  fresh: number
  go: (page: CrewPage) => void
  open: (agentId: string) => void
  pause: () => void
}

const HEALTH_COLOR: Record<Health, string> = { ok: 'green', loop: 'red', stuck: 'yellow' }

const HEALTH_TEXT: Record<Health, string> = { ok: '✓ 正常', loop: '⚠ 可能在繞圈', stuck: '⚠ 可能卡住' }

const SOURCE_COLOR: Record<Role, string> = {
  Explore: 'cyan',
  clerk: 'green',
  worker: 'blue',
  verifier: 'magenta',
  fork: 'white',
  workflow: 'gray',
  other: 'gray',
}

const TABS: { page: CrewPage; hotkey: string; label: string }[] = [
  { page: 'now', hotkey: 'n', label: '現況' },
  { page: 'log', hotkey: 'l', label: '事件流' },
  { page: 'stats', hotkey: 's', label: '統計' },
]

const BLANK: Seg[] = [{ t: ' ' }]

const sp = (n: number): Seg => ({ t: ' '.repeat(Math.max(0, n)) })

const segsWidth = (segs: readonly Seg[]): number => segs.reduce((n, s) => n + cellWidth(s.t), 0)

// Cuts a line to `width` cells; the segment that overruns ends in an ellipsis.
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
      out.push({ ...s, t: fitCells(s.t, left) })
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
  return ms > SLOW_MS ? { t: fmtMs(ms), color: 'yellow' } : { t: fmtMs(ms), dim: true }
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
// its border; on one row the full line keeps a cell of room either side.
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
      if (rows > 1 && format === 'full') continue
      if (need(format) <= boxInner) return { perRow, widths, format, fits: true }
    }
  }
  return { perRow: 1, widths: [inner], format: 'compact', fits: false }
}

export function drawCockpit(ui: Ui, view: Cockpit, ctx: Ctx): RenderElement {
  const { Box, Text, Button } = ui
  const { cols, rows } = ctx
  const wide = cols >= WIDE_COLS
  const tiny = cols < TINY_COLS

  const style = (s: Seg) => ({
    ...(s.color ? { color: s.color } : {}),
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

  // Cards on one row, as tall as the tallest.
  const cardRow = (specs: CardSpec[]): Block => {
    const tall = Math.max(...specs.map(heightOf))
    return {
      h: tall,
      node: (
        <Box flexDirection="row" gap={1}>
          {specs.map(s => card(s, tall).node)}
        </Box>
      ),
    }
  }

  const title = (text: string, color: string): Seg => ({ t: text, color, bold: true })

  const badge = (model: string): Seg => {
    const family = nameFamilyOf(model)
    return family ? { t: `[${shortModel(model)}]`, color: FAMILY_COLOR[family] } : { t: `[${shortModel(model)}]`, dim: true }
  }

  const listed = [...view.running, ...view.stale, ...view.finished]
  const selected = ctx.page === 'detail' ? listed.find(a => a.id === ctx.agentId) : undefined
  // a detail page whose subagent left the list is the now page
  const page: CrewPage = ctx.page === 'detail' && !selected ? 'now' : ctx.page

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

    const used = buttons.reduce((n, b) => n + b.w, 0) + (buttons.length - 1)
    const room = Math.max(0, cols - used - 1)
    const health = fitCells(HEALTH_TEXT[view.health], room)
    const gap = Math.max(0, cols - used - cellWidth(health))
    return {
      h: 1,
      node: (
        <Box flexDirection="row">
          <Box flexDirection="row" gap={1}>
            {buttons.map(b => b.node)}
          </Box>
          {gap > 0 ? <Text>{' '.repeat(gap)}</Text> : null}
          {health === '' ? null : (
            <Text color={HEALTH_COLOR[view.health]} bold>
              {health}
            </Text>
          )}
        </Box>
      ),
    }
  }

  // ---- 事件 ---------------------------------------------------------------

  const eventLine = (ev: CrewEvent, inner: number): Seg[] => {
    const timeW = 8
    const srcW = 8
    const toolW = 12
    const durW = 6
    const markW = 3
    const descW = Math.max(4, inner - (timeW + 1 + srcW + 1 + toolW + 1) - (1 + durW + 1 + markW))
    const dur = eventDuration(ev.ms)
    return [
      { t: fmtClock(ev.ts), dim: true },
      sp(1),
      { t: padCells(ev.source, srcW), color: ev.isMain ? 'yellow' : SOURCE_COLOR[roleOf(ev.source)], bold: ev.isMain },
      sp(1),
      { t: padCells(ev.tool, toolW), bold: true },
      sp(1),
      { t: padCells(ev.desc, descW), ...(ev.ok ? {} : { color: 'red' }) },
      sp(1),
      { ...dur, t: padCells(dur.t, durW, 'right') },
      sp(1),
      ev.ok ? { t: '[✓]', color: 'green' } : { t: '[✗]', color: 'red', bold: true },
    ]
  }

  // A card of events, the newest `room - 3` of `list` at the bottom.
  const eventCard = (head: Seg[], list: readonly CrewEvent[], room: number, empty: string): Block => {
    const inner = cols - 4
    const shown = list.slice(-Math.max(1, room - 3))
    const body: Line[] = shown.length === 0 ? [[{ t: empty, dim: true }]] : shown.map(ev => eventLine(ev, inner))
    return card({ w: cols, color: 'white', lines: [head, ...body] }, body.length + 3)
  }

  // ---- 主線 -------------------------------------------------------------

  const m = view.main
  const warn = m.chain >= CHAIN_WARN

  const mainSpec = (w: number): CardSpec => {
    const inner = w - 4
    const family = nameFamilyOf(m.model)
    const head: Seg[] = [title('主線', 'cyan')]
    if (m.model !== '') {
      head.push({ t: ` · ${shortModel(m.model)}`, ...(family ? { color: FAMILY_COLOR[family] } : { dim: true }) })
    }
    const state: Seg = m.isRunning ? { t: '● 執行中', color: 'green' } : { t: '○ 閒置', dim: true }

    const labelW = 8
    const barW = Math.max(4, Math.min(CHAIN_BAR, inner - labelW - 1 - 1 - 5))
    const fill = Math.min(barW, Math.round((Math.min(m.chain, CHAIN_WARN) / CHAIN_WARN) * barW))
    const barColor = warn ? 'yellow' : 'cyan'
    const chain: Seg[] = [
      { t: padCells('連續呼叫', labelW), dim: true },
      sp(1),
      { t: '█'.repeat(fill), color: barColor },
      { t: '░'.repeat(barW - fill), dim: true },
      sp(1),
      warn
        ? { t: `${m.chain}/${CHAIN_WARN}`, color: 'yellow', bold: true }
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
      color: 'cyan',
      lines: [
        leftRight(head, [state], inner),
        BLANK,
        chain,
        BLANK,
        outcome('成功', m.ok, 'green'),
        outcome('失敗', m.fail, 'red'),
        BLANK,
        last,
      ],
    }
  }

  // ---- 派工流程 ---------------------------------------------------------

  const dispatchSpec = (w: number): CardSpec => {
    const inner = w - 4
    const roles = view.dispatch.filter(
      r => (r.role !== 'other' && r.role !== 'workflow') || r.running + r.done + r.failed > 0,
    )
    const layout = roleLayout(roles, inner)
    const boxH = 2 + 1 + (layout.format === 'two' ? 2 : 1)

    const box = (r: RoleStat, bw: number) => {
      const active = r.running > 0
      const iw = bw - 2
      const tone: Partial<Seg> = active ? { color: 'yellow', bold: true } : { dim: true }
      const name: Seg[] = [{ t: r.label, bold: true }]
      if (r.failed > 0) name.push({ t: ` ✗${r.failed}`, color: 'red' })
      const stats = roleStatLines(r, layout.format)
      const stat: Seg[][] =
        layout.format === 'two'
          ? [
              [{ t: stats[0] ?? '', ...tone }],
              [{ t: stats[1] ?? '', ...(r.done > 0 ? { color: 'green' } : { dim: true }) }],
            ]
          : [[{ t: stats[0] ?? '', ...tone }]]
      return (
        <Box
          key={`role-${r.role}`}
          flexDirection="column"
          width={bw}
          height={boxH}
          borderStyle="round"
          borderColor={active ? 'yellow' : 'gray'}
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

    const arrow = centered([{ t: '▼', color: 'yellow' }], inner)
    const top = centered(
      [{ t: m.model === '' ? '主 session' : `主 session · ${shortModel(m.model)}`, bold: true }],
      inner,
    )
    return {
      w,
      color: 'yellow',
      lines: [[title('派工流程', 'yellow')], top, arrow, roleRows, arrow, centered([{ t: '回主線', bold: true }], inner)],
    }
  }

  // ---- 模型、省錢 ---------------------------------------------------------

  const modelSpec = (w: number): CardSpec => {
    const inner = w - 4
    const labelW = 7
    const pctW = 4
    const barW = Math.max(3, inner - labelW - 1 - pctW)
    const row = (r: ModelShare): Seg[] => {
      const color = r.family ? FAMILY_COLOR[r.family] : 'gray'
      if (!r.family) {
        return [{ t: padCells(r.label, labelW), color }, { t: `未計價 ×${r.count}`, dim: true }]
      }
      const len = Math.max(1, barLen(r.share, 1, barW))
      return [
        { t: padCells(r.label, labelW), color },
        { t: '█'.repeat(len), color },
        { t: '░'.repeat(barW - len), dim: true },
        { t: padCells(shareLabel(r.share), pctW + 1, 'right') },
      ]
    }
    const body: Seg[][] =
      view.models.length === 0 ? [[{ t: '還沒有 subagent', dim: true }]] : view.models.map(row)
    return { w, color: 'blue', lines: [[title('模型', 'blue')], ...body] }
  }

  const sum = view.summary
  const saveSpec = (w: number): CardSpec => {
    const inner = w - 4
    const pct = sum.savedPct === undefined ? undefined : Math.round(sum.savedPct)
    const big: Seg =
      pct === undefined
        ? { t: '未計價', dim: true, bold: true }
        : pct >= 0
          ? { t: `省${pct}%`, color: 'green', bold: true }
          : { t: `多花${-pct}%`, color: 'red', bold: true }
    const sub: Seg =
      pct === undefined
        ? { t: '沒有可計價的模型', dim: true }
        : { t: `≈${fmtUsd(sum.cost)} vs ${fmtUsd(sum.opusCost)}` }
    return {
      w,
      color: 'magenta',
      lines: [
        [title('省錢', 'magenta')],
        BLANK,
        centered([big], inner),
        centered([sub], inner),
        centered([{ t: '對比全程 Opus', dim: true }], inner),
      ],
    }
  }

  // ---- 子代理清單 ---------------------------------------------------------

  const agentBlock = (room: number): Block => {
    const inner = cols - 4
    const head: Line = [title('子代理', 'gray')]
    if (view.sections.length === 0) {
      return cardRow([{ w: cols, color: 'gray', lines: [head, [{ t: '還沒有派工。派出 subagent 後這裡會即時顯示。', dim: true }]] }])
    }
    const shown = listed
    const typeW = Math.max(6, Math.min(15, Math.max(...shown.map(a => cellWidth(a.type)))))
    const badgeW = Math.max(...shown.map(a => cellWidth(`[${shortModel(a.model)}]`)))
    const numberOf = new Map(view.numbered.map((a, i) => [a.id, i + 1]))

    const row = (a: CrewAgent, indent: number): Line => {
      let icon: Seg
      let right: Seg[]
      let tone: Partial<Seg>
      if (a.status === 'running') {
        icon = { t: ctx.frame, color: 'cyan' }
        right = [...(a.tool !== '' ? [{ t: `${a.tool} `, dim: true }] : []), { t: fmtDur(elapsedMs(a, view.now)) }]
        tone = {}
      } else if (a.status === 'stale') {
        icon = { t: '?', color: 'gray' }
        right = [{ t: `失聯 · ${fmtDur(elapsedMs(a, view.now))}`, color: 'gray' }]
        tone = { color: 'gray' }
      } else {
        icon = a.status === 'done' ? { t: '✓', color: 'green' } : { t: '✗', color: 'red' }
        right = [{ t: `${fmtDur(elapsedMs(a, view.now))} · ${fmtK(tokenTotal(tokensOf(a)))}`, dim: true }]
        tone = { dim: true }
      }
      const width = inner - HOTKEY_W
      const lead: Seg[] = [sp(indent), icon, sp(1), { t: padCells(a.type, typeW), bold: true, ...tone }, sp(1)]
      const b = badge(a.model)
      lead.push({ ...b, t: padCells(b.t, badgeW), ...(tone.color ? tone : {}) }, sp(1))
      const descW = Math.max(4, width - segsWidth(lead) - segsWidth(right) - 1)
      const segs = clip([...lead, { t: padCells(a.description, descW), ...tone }, sp(1), ...right], width)
      const n = numberOf.get(a.id)
      if (n === undefined) return lineNode([sp(HOTKEY_W), ...segs]) as unknown as Line
      return {
        h: 1,
        node: (
          <Box flexDirection="row">
            <Button key={`agent-${n}`} hotkey={String(n)} plain onPress={() => ctx.open(a.id)}>
              {texts(segs)}
            </Button>
          </Box>
        ),
      }
    }

    const groupHead = (u: Extract<ListUnit, { kind: 'workflow' }>): Seg[] => {
      const count = (s: CrewAgent['status']) => u.agents.filter(a => a.status === s).length
      const parts = [
        `${u.agents.length} 個`,
        ...([
          ['執行中', count('running')],
          ['完成', count('done')],
          ['失敗', count('failed')],
          ['失聯', count('stale')],
        ] as const)
          .filter(([, n]) => n > 0)
          .map(([label, n]) => `${label} ${n}`),
      ]
      const id = u.runId === '' ? '(無 id)' : fitCells(u.runId, 8)
      return [sp(HOTKEY_W), { t: 'workflow', bold: true }, { t: ` ${id} · ${parts.join(' · ')}`, dim: true }]
    }

    const label: Record<string, Seg> = {
      running: { t: `執行中 (${view.running.length})`, dim: true },
      stale: { t: `失聯 (${view.stale.length})`, color: 'gray' },
      finished: { t: `已完成 (${view.finished.length})`, dim: true },
    }
    const body: Line[] = []
    for (const section of view.sections) {
      body.push([label[section.status] ?? { t: '' }])
      for (const u of section.units) {
        if (u.kind === 'agent') {
          body.push(row(u.agent, 0))
        } else {
          body.push(groupHead(u))
          for (const a of u.agents) body.push(row(a, 2))
        }
      }
    }
    const fit = Math.max(4, room - 3)
    const lines =
      body.length > fit
        ? [...body.slice(0, fit - 1), [{ t: `… 還有 ${body.length - fit + 1} 列未顯示`, dim: true }] as Seg[]]
        : body
    return cardRow([{ w: cols, color: 'gray', lines: [head, ...lines] }])
  }

  // ---- 進行中 -------------------------------------------------------------

  const inflightBlock = (): Block => {
    const inner = cols - 4
    const list = view.inflight
    const head = leftRight(
      [title('進行中', 'green')],
      list.length > 0 ? [{ t: `${list.length} 個`, dim: true }] : [],
      inner,
    )
    const srcW = 8
    const toolW = 12
    const durW = 6
    const descW = Math.max(4, inner - (srcW + 1 + toolW + 1) - (1 + durW))
    const line = (f: CrewInflight): Seg[] => {
      const isMain = f.actor === 'main'
      const dur = eventDuration(view.now - f.startedAt)
      return [
        { t: padCells(f.source, srcW), color: isMain ? 'yellow' : SOURCE_COLOR[roleOf(f.source)], bold: isMain },
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
    return cardRow([{ w: cols, color: 'green', lines: [head, ...body] }])
  }

  // ---- 細節頁 -------------------------------------------------------------

  const detailBlock = (a: CrewAgent): Block => {
    const inner = cols - 4
    const labelW = 9
    const field = (label: string, value: Seg[]): Seg[] => [{ t: padCells(label, labelW), dim: true }, ...value]
    const status: Seg[] =
      a.status === 'running'
        ? [{ t: `${ctx.frame} 執行中`, color: 'cyan' }, ...(a.tool !== '' ? [{ t: ` · ${a.tool}`, dim: true }] : [])]
        : a.status === 'done'
          ? [{ t: '✓ 完成', color: 'green' }]
          : a.status === 'failed'
            ? [{ t: '✗ 失敗', color: 'red' }]
            : [{ t: '? 失聯', color: 'gray' }]
    const lines: Line[] = [
      leftRight([title('子代理', 'gray'), { t: ` · ${a.type}`, bold: true }], status, inner),
      field('類型', [{ t: a.type, bold: true }]),
      field('模型', [badge(a.model)]),
      field('狀態', status),
      field('任務', [{ t: a.description }]),
      field('開始', [{ t: fmtClock(a.runStartedAt) }]),
      field('耗時', [{ t: fmtDur(elapsedMs(a, view.now)) }]),
      field('Token', [{ t: `輸入 ${fmtK(a.input)} · 輸出 ${fmtK(a.output)}` }]),
    ]
    if (a.runId !== undefined) {
      const id = a.runId === '' ? '(無 id)' : a.runId
      lines.push(field('Workflow', [{ t: id }, ...(a.agentIndex !== undefined ? [{ t: ` · 第 ${a.agentIndex} 個`, dim: true }] : [])]))
    }
    return cardRow([{ w: cols, color: 'gray', lines }])
  }

  // ---- 組版 ---------------------------------------------------------------

  const blocks: Block[] = [tabBar()]
  const left = () => rows - blocks.reduce((n, b) => n + b.h, 0)
  let footer: RenderElement | undefined

  if (page === 'now') {
    const flight = inflightBlock()
    const recent = view.events.slice(-RECENT_EVENTS)
    const recentRoom = Math.max(1, recent.length) + 3
    blocks.push(agentBlock(left() - flight.h - recentRoom), flight)
    blocks.push(eventCard([title('最近事件', 'white')], recent, recentRoom, '還沒有工具呼叫'))
  } else if (page === 'log') {
    const total = view.events.length
    const list = ctx.paused ? view.events.slice(0, Math.max(0, total - ctx.fresh)) : view.events
    const head = leftRight(
      [
        title('事件流', 'white'),
        ...(ctx.paused ? [sp(1), { t: `⏸ 已暫停 · 新增 ${ctx.fresh} 則`, color: 'yellow', bold: true }] : []),
      ],
      [{ t: `${total}/${MAX_EVENTS} 則`, dim: true }],
      cols - 4,
    )
    blocks.push(eventCard(head, list, Math.max(MIN_EVENT_ROWS + 3, left()), '還沒有工具呼叫'))
  } else if (page === 'detail' && selected) {
    blocks.push(detailBlock(selected))
    const own = view.events.filter(ev => ev.actor === selected.id)
    const head = leftRight(
      [title('事件流', 'white'), { t: ' · 這個 subagent', dim: true }],
      [{ t: `${own.length} 則`, dim: true }],
      cols - 4,
    )
    blocks.push(eventCard(head, own, Math.max(MIN_EVENT_ROWS + 3, left()), '這個 subagent 還沒有工具呼叫'))
  } else {
    if (wide) {
      const side = Math.max(44, Math.min(64, cols - 115))
      blocks.push(cardRow([mainSpec(side), dispatchSpec(cols - side - 1)]))
    } else {
      blocks.push(cardRow([mainSpec(cols)]), cardRow([dispatchSpec(cols)]))
    }
    if (tiny) {
      blocks.push(cardRow([modelSpec(cols)]), cardRow([saveSpec(cols)]))
    } else {
      const [a, b] = splitCols(cols, 2) as [number, number]
      blocks.push(cardRow([modelSpec(a), saveSpec(b)]))
    }
    footer =
      view.summary.groups.length === 0 ? (
        <Text dimColor wrap="truncate-end">還沒有派工。派出 subagent 後這裡會即時顯示。</Text>
      ) : (
        <Text bold wrap="truncate-end">{summaryLine(view.summary)}</Text>
      )
  }

  return (
    <Box flexDirection="column">
      {blocks.map(b => b.node)}
      {footer ?? null}
    </Box>
  )
}
