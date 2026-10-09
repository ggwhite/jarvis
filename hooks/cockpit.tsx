import type { EngineInterface, RenderElement } from 'claude-code'

import type { CrewAgent, CrewEvent } from '../types'
import {
  CHAIN_WARN,
  FAMILY_COLOR,
  MAIN_SOURCE,
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

type Ui = Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Text'>

export type Seg = { t: string; color?: string; dim?: boolean; bold?: boolean }

type Block = { node: RenderElement; h: number }

type CardSpec = { w: number; color: string; lines: Seg[][]; dim?: boolean }

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
    const border = { borderColor: spec.color, ...(spec.dim ? { borderDimColor: true } : {}) }
    return {
      h: height,
      node: (
        <Box
          flexDirection="column"
          width={spec.w}
          height={height}
          borderStyle="round"
          paddingX={1}
          {...border}
        >
          {spec.lines.map(l => lineNode(clip(l, inner)))}
        </Box>
      ),
    }
  }

  const heightOf = (spec: CardSpec) => spec.lines.length + 2

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
    const twoLine = roles.some((r, i) => cellWidth(fullStat(r)) > (widths[i] ?? 0) - 2 && cellWidth(`執行中 ${r.running}·完成 ${r.done}`) > (widths[i] ?? 0) - 2)
    const boxH = twoLine ? 5 : 4

    const box = (r: RoleStat, bw: number) => {
      const active = r.running > 0
      const iw = bw - 2
      const tone: Seg = active ? { t: '', color: 'yellow', bold: true } : { t: '', dim: true }
      const name: Seg[] = [{ t: r.label, bold: true }]
      if (r.failed > 0) name.push({ t: ` ✗${r.failed}`, color: 'red' })
      const stat: Seg[][] = twoLine
        ? [
            [{ t: `執行中 ${r.running}`, ...(active ? { color: 'yellow', bold: true } : { dim: true }) }],
            [{ t: `完成 ${r.done}`, dim: r.done === 0, ...(r.done > 0 ? { color: 'green' } : {}) }],
          ]
        : [
            [
              {
                t: cellWidth(fullStat(r)) <= iw ? fullStat(r) : `執行中 ${r.running}·完成 ${r.done}`,
                ...(active ? { color: 'yellow', bold: true } : { dim: true }),
              },
            ],
          ]
      void tone
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

    const roleRow = (
      <Box flexDirection="row" gap={1}>
        {roles.map((r, i) => box(r, widths[i] ?? 4))}
      </Box>
    )

    const arrow: Seg[] = centered([{ t: '▼', color: 'yellow' }], inner)
    const top: Seg[] = centered(
      [{ t: m.model === '' ? '主 session' : `主 session · ${shortModel(m.model)}`, bold: true }],
      inner,
    )
    const back: Seg[] = centered([{ t: '回主線', bold: true }], inner)

    // the role boxes are a node, not a text line: the card is assembled by hand
    return { w, color: 'yellow', lines: [[title('派工流程', 'yellow')], top, arrow, ...Array.from({ length: boxH }, () => BLANK), arrow, back], extra: roleRow, extraAt: 3 } as CardSpec & {
      extra: RenderElement
      extraAt: number
    }
  }

  return <Box flexDirection="column" />
}
