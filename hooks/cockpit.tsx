import type { EngineInterface, RenderElement } from 'claude-code'

import type { CrewAgent, CrewEvent } from '../types'
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
  paceChart,
  padCells,
  roleOf,
  shortModel,
  summaryLine,
  tokenTotal,
  tokensOf,
} from './crew'
import type { Cockpit, Health, ModelShare, Role, RoleStat } from './crew'

// At this many columns the top row and the four middle cards sit side by side.
export const WIDE_COLS = 120
// Below this the middle row keeps only the savings and health cards.
export const TINY_COLS = 64
export const MIN_EVENT_ROWS = 4
// Cells in the main chain bar: full at CHAIN_WARN calls.
const CHAIN_BAR = 16

type Ui = Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Text'>

export type Seg = { t: string; color?: string; dim?: boolean; bold?: boolean }

type Block = { node: RenderElement; h: number }

// A card line is a row of segments, or a ready node that takes `h` rows (the role boxes).
type Line = Seg[] | { node: RenderElement; h: number }

type CardSpec = { w: number; color: string; lines: Line[] }

export type Ctx = { cols: number; rows: number; frame: string }

const HEALTH_COLOR: Record<Health, string> = { ok: 'green', loop: 'red', stuck: 'yellow' }

const SOURCE_COLOR: Record<Role, string> = {
  Explore: 'cyan',
  clerk: 'green',
  worker: 'blue',
  verifier: 'magenta',
  fork: 'white',
  other: 'gray',
}

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

export function drawCockpit(ui: Ui, view: Cockpit, ctx: Ctx): RenderElement {
  const { Box, Text } = ui
  const { cols, rows } = ctx
  const wide = cols >= WIDE_COLS
  const tiny = cols < TINY_COLS

  const style = (s: Seg) => ({
    ...(s.color ? { color: s.color } : {}),
    ...(s.dim ? { dimColor: true } : {}),
    ...(s.bold ? { bold: true } : {}),
  })

  const lineNode = (segs: readonly Seg[]) => (
    <Box flexDirection="row">
      {segs
        .filter(s => s.t !== '')
        .map(s => (
          <Text {...style(s)}>{s.t}</Text>
        ))}
    </Box>
  )

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
    const h = Math.max(...specs.map(heightOf))
    return {
      h,
      node: (
        <Box flexDirection="row" gap={1}>
          {specs.map(s => card(s, h).node)}
        </Box>
      ),
    }
  }

  const title = (text: string, color: string): Seg => ({ t: text, color, bold: true })

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
    const roles = view.dispatch.filter(r => r.role !== 'other' || r.running + r.done + r.failed > 0)
    const widths = splitCols(inner, roles.length)
    const fullStat = (r: RoleStat) => `執行中 ${r.running} · 完成 ${r.done}`
    const tightStat = (r: RoleStat) => `執行中 ${r.running}·完成 ${r.done}`
    const twoLine = roles.some((r, i) => cellWidth(tightStat(r)) > (widths[i] ?? 0) - 2)
    const boxH = twoLine ? 5 : 4

    const box = (r: RoleStat, bw: number) => {
      const active = r.running > 0
      const iw = bw - 2
      const tone: Partial<Seg> = active ? { color: 'yellow', bold: true } : { dim: true }
      const name: Seg[] = [{ t: r.label, bold: true }]
      if (r.failed > 0) name.push({ t: ` ✗${r.failed}`, color: 'red' })
      const stat: Seg[][] = twoLine
        ? [
            [{ t: `執行中 ${r.running}`, ...tone }],
            [{ t: `完成 ${r.done}`, ...(r.done > 0 ? { color: 'green' } : { dim: true }) }],
          ]
        : [[{ t: cellWidth(fullStat(r)) <= iw ? fullStat(r) : tightStat(r), ...tone }]]
      return (
        <Box
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

    const roleRow = {
      h: boxH,
      node: (
        <Box flexDirection="row" gap={1}>
          {roles.map((r, i) => box(r, widths[i] ?? 4))}
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
      lines: [[title('派工流程', 'yellow')], top, arrow, roleRow, arrow, centered([{ t: '回主線', bold: true }], inner)],
    }
  }

  // ---- 中排四張卡 ---------------------------------------------------------

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
      const len = barLen(r.share, 1, barW)
      return [
        { t: padCells(r.label, labelW), color },
        { t: '█'.repeat(len), color },
        { t: '░'.repeat(barW - len), dim: true },
        { t: padCells(`${Math.round(r.share * 100)}%`, pctW + 1, 'right') },
      ]
    }
    const body: Seg[][] =
      view.models.length === 0 ? [[{ t: '還沒有 subagent', dim: true }]] : view.models.map(row)
    return { w, color: 'blue', lines: [[title('模型', 'blue')], ...body] }
  }

  const paceSpec = (w: number): CardSpec => {
    const inner = w - 4
    const barWidth = inner >= 29 ? 2 : 1
    const chartW = view.pace.length * barWidth + (view.pace.length - 1)
    const lead = Math.max(0, Math.floor((inner - chartW) / 2))
    const peak = Math.max(0, ...view.pace)
    const chart = paceChart(view.pace, 4, barWidth).map<Seg[]>(r => [sp(lead), { t: r, color: 'green' }])
    return {
      w,
      color: 'green',
      lines: [[title('節奏', 'green')], ...chart, centered([{ t: `每分鐘一根 · 峰值 ${peak}`, dim: true }], inner)],
    }
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

  const healthSpec = (w: number): CardSpec => {
    const inner = w - 4
    const color = HEALTH_COLOR[view.health]
    const text =
      view.health === 'loop' ? '⚠ 可能在繞圈' : view.health === 'stuck' ? '⚠ 可能卡住' : '✓ 正常'
    const hint =
      view.health === 'loop'
        ? '同一工具連續失敗'
        : view.health === 'stuck'
          ? '執行中，但好一陣子沒動靜'
          : '沒有異常'
    return {
      w,
      color,
      lines: [
        [title('健康', color)],
        BLANK,
        centered([{ t: text, color, bold: true }], inner),
        centered([{ t: hint, dim: true }], inner),
      ],
    }
  }

  // ---- 子代理清單 ---------------------------------------------------------

  const badge = (model: string): Seg => {
    const family = nameFamilyOf(model)
    return family ? { t: `[${shortModel(model)}]`, color: FAMILY_COLOR[family] } : { t: `[${shortModel(model)}]`, dim: true }
  }

  const agentSpec = (w: number): CardSpec | undefined => {
    const { running, stale, finished } = view
    if (running.length + stale.length + finished.length === 0) return undefined
    const inner = w - 4
    const shown = [
      ...running.slice(0, 8),
      ...stale.slice(0, 4),
      ...finished.slice(0, wide ? 5 : 3),
    ]
    const typeW = Math.max(6, Math.min(15, Math.max(...shown.map(a => cellWidth(a.type)))))
    const badgeW = Math.max(...shown.map(a => cellWidth(`[${shortModel(a.model)}]`)))

    const row = (icon: Seg, a: CrewAgent, right: Seg[], tone: Partial<Seg>): Seg[] => {
      const head: Seg[] = [icon, sp(1), { t: padCells(a.type, typeW), bold: true, ...tone }, sp(1)]
      const b = badge(a.model)
      head.push({ ...b, t: padCells(b.t, badgeW), ...(tone.color ? tone : {}) }, sp(1))
      const descW = Math.max(4, inner - segsWidth(head) - segsWidth(right) - 1)
      return [...head, { t: padCells(a.description, descW), ...tone }, sp(1), ...right]
    }

    const lines: Line[] = [[title('子代理', 'gray')]]
    if (running.length > 0) {
      lines.push([{ t: `執行中 (${running.length})`, dim: true }])
      for (const a of running.slice(0, 8)) {
        lines.push(
          row({ t: ctx.frame, color: 'cyan' }, a, [
            ...(a.tool !== '' ? [{ t: `${a.tool} `, dim: true }] : []),
            { t: fmtDur(elapsedMs(a, view.now)) },
          ], {}),
        )
      }
    }
    if (stale.length > 0) {
      lines.push([{ t: `失聯 (${stale.length})`, color: 'gray' }])
      for (const a of stale.slice(0, 4)) {
        lines.push(row({ t: '?', color: 'gray' }, a, [{ t: `失聯 · ${fmtDur(elapsedMs(a, view.now))}`, color: 'gray' }], { color: 'gray' }))
      }
    }
    if (finished.length > 0) {
      lines.push([{ t: `已完成 (${finished.length})`, dim: true }])
      for (const a of finished.slice(0, wide ? 5 : 3)) {
        lines.push(
          row(
            a.status === 'done' ? { t: '✓', color: 'green' } : { t: '✗', color: 'red' },
            a,
            [{ t: `${fmtDur(elapsedMs(a, view.now))} · ${fmtK(tokenTotal(tokensOf(a)))}`, dim: true }],
            { dim: true },
          ),
        )
      }
    }
    return { w, color: 'gray', lines }
  }

  // ---- 事件流 -------------------------------------------------------------

  const eventBlock = (w: number, room: number): Block => {
    const inner = w - 4
    const total = view.events.length
    const rowsShown = Math.max(1, room - 3)
    const list = view.events.slice(-rowsShown)
    const timeW = 8
    const srcW = 8
    const toolW = 12
    const durW = 6
    const markW = 3
    const descW = Math.max(4, inner - (timeW + 1 + srcW + 1 + toolW + 1) - (1 + durW + 1 + markW))

    const line = (ev: CrewEvent): Seg[] => {
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

    const head = leftRight([title('事件流', 'white')], [{ t: `${total}/${MAX_EVENTS} 則`, dim: true }], inner)
    const body: Line[] = list.length === 0 ? [[{ t: '還沒有工具呼叫', dim: true }]] : list.map(line)
    return card({ w, color: 'white', lines: [head, ...body] }, body.length + 3)
  }

  // ---- 組版 ---------------------------------------------------------------

  const blocks: Block[] = []

  if (wide) {
    const left = Math.max(46, Math.min(64, cols - 109))
    const specs = [mainSpec(left), dispatchSpec(cols - left - 1)]
    blocks.push(cardRow(specs))
  } else {
    blocks.push(cardRow([mainSpec(cols)]), cardRow([dispatchSpec(cols)]))
  }

  if (wide) {
    const [a, b, c, d] = splitCols(cols, 4) as [number, number, number, number]
    blocks.push(cardRow([modelSpec(a), paceSpec(b), saveSpec(c), healthSpec(d)]))
  } else if (tiny) {
    const [a, b] = splitCols(cols, 2) as [number, number]
    blocks.push(cardRow([saveSpec(a), healthSpec(b)]))
  } else {
    const [a, b] = splitCols(cols, 2) as [number, number]
    blocks.push(cardRow([modelSpec(a), paceSpec(b)]), cardRow([saveSpec(a), healthSpec(b)]))
  }

  const agents = agentSpec(cols)
  if (agents) blocks.push(cardRow([agents]))

  const used = blocks.reduce((n, b) => n + b.h, 0)
  blocks.push(eventBlock(cols, Math.max(MIN_EVENT_ROWS + 3, rows - used - 1)))

  return (
    <Box flexDirection="column">
      {blocks.map(b => b.node)}
      {view.summary.groups.length === 0 ? (
        <Text dimColor wrap="truncate-end">還沒有派工。派出 subagent 後這裡會即時顯示。</Text>
      ) : (
        <Text bold wrap="truncate-end">{summaryLine(view.summary)}</Text>
      )}
    </Box>
  )
}
