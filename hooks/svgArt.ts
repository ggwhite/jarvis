import { BIG_ROWS, BURN_RAMP, GAUGE_RAMP, bigPixels, bigWidth, pick } from './fleetChart'
import type { Pixels, RingSpec, StackPart } from './fleetChart'
import { THEME } from './jarvis'

// One cell of the Desktop pane in CSS px, measured with svgprobe on 2026-10-15: bodyColumns
// 49 over 392pt, rows 19pt apart.
export const CELL_PX_W = 8
export const CELL_PX_H = 19
// The most an Svg's source may hold.
export const SVG_MAX = 131072

const whole = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0)

export const cellPx = (cells: number): number => whole(cells) * CELL_PX_W
export const rowPx = (rows: number): number => whole(rows) * CELL_PX_H

// a number as an attribute: two decimals at most, 0 for what is not finite
export const num = (x: number): string => (Number.isFinite(x) ? String(Math.round(x * 100) / 100) : '0')

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

// A whole document `cols` cells wide and `rows` rows tall, in CSS px.
export function svgDoc(cols: number, rows: number, body: string): string {
  const w = cellPx(cols)
  const h = rowPx(rows)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`
}

const FORBIDDEN = /<script|\son[a-z]+\s*=|javascript:|@import|(?:href|src)\s*=\s*["']?(?:https?:)?\/\//i
const PRIVATE_USE = /[\uE000-\uF8FF]/

// Whether a source may go to the surface: a whole svg within SVG_MAX, no script, no handler,
// no outside resource, no Nerd Font glyph.
export function svgSafe(source: string): boolean {
  return source.length <= SVG_MAX && source.startsWith('<svg') && !FORBIDDEN.test(source) && !PRIVATE_USE.test(source)
}

// where a one-row bar's track and fill sit in its row
export const BAR_Y = 5
export const BAR_H = CELL_PX_H - 2 * BAR_Y

// `total` cells of meter, the first `lit` in `color`, the rest muted: what `▰▱` draw.
export function meterSvg(lit: number, total: number, color: string): string {
  const n = whole(total)
  const k = Math.min(n, whole(lit))
  let body = ''
  for (let i = 0; i < n; i += 1) {
    body += `<rect x="${i * CELL_PX_W + 1}" y="${BAR_Y}" width="${CELL_PX_W - 2}" height="${BAR_H}" rx="1.5" fill="${i < k ? color : THEME.muted}"/>`
  }
  return svgDoc(n, 1, body)
}

// A gradient across the fill's own box, `colors` evenly from its start to its end.
const gradient = (id: string, colors: readonly string[]): string => {
  const cs = colors.length === 0 ? [THEME.frame] : colors
  const stops = cs.map((c, i) => `<stop offset="${num(cs.length > 1 ? i / (cs.length - 1) : 0)}" stop-color="${c}"/>`).join('')
  return `<linearGradient id="${id}" x1="0" x2="1" y1="0" y2="0">${stops}</linearGradient>`
}

const track = (w: number): string => `<rect x="0" y="${BAR_Y}" width="${w}" height="${BAR_H}" rx="2" fill="${THEME.muted}"/>`

// A bar `width` cells long filled to `pct`, the fill shaded along `colors`; the rest a muted track.
export function rampBarSvg(width: number, pct: number, colors: readonly string[]): string {
  const n = whole(width)
  const w = cellPx(n)
  const fill = w * clamp01(pct)
  const id = `g-${colors.join('').replace(/[^0-9a-zA-Z]/g, '')}`
  const bar =
    fill > 0
      ? `<defs>${gradient(id, colors)}</defs><rect class="fill" x="0" y="${BAR_Y}" width="${num(fill)}" height="${BAR_H}" rx="2" fill="url(#${id})"/>`
      : ''
  return svgDoc(n, 1, track(w) + bar)
}

// The arc reactor as a bar: dark gold to warm white, red when depleted.
export function gaugeBarSvg(width: number, pct: number, depleted: boolean): string {
  return rampBarSvg(width, pct, depleted ? [THEME.error] : GAUGE_RAMP)
}

// One bar the width, its parts side by side by share in their colors; nothing to show, a
// muted track.
export function stackedBarSvg(width: number, parts: readonly StackPart[]): string {
  const n = whole(width)
  const w = cellPx(n)
  const live = parts.filter(p => Number.isFinite(p.share) && p.share > 0)
  const total = live.reduce((s, p) => s + p.share, 0)
  if (total <= 0) return svgDoc(n, 1, track(w))
  let x = 0
  const body = live
    .map(p => {
      const pw = (p.share / total) * w
      const r = `<rect class="part" x="${num(x)}" y="${BAR_Y}" width="${num(pw)}" height="${BAR_H}" fill="${p.color}"/>`
      x += pw
      return r
    })
    .join('')
  return svgDoc(n, 1, body)
}

// `vals` as a line `width` cells long, scaled to `top` when given (a value past it drawn at
// the top), else to its own highest; one value a flat line, none a muted floor.
export function sparkSvg(vals: readonly number[], width: number, top: number | undefined, color: string): string {
  const n = whole(width)
  const w = cellPx(n)
  const pad = 3
  const floor = CELL_PX_H - pad
  const vs = vals.map(v => (Number.isFinite(v) ? Math.max(0, v) : 0))
  if (vs.length === 0 || w === 0) {
    return svgDoc(n, 1, `<line x1="0" y1="${floor}" x2="${w}" y2="${floor}" stroke="${THEME.muted}" stroke-width="1"/>`)
  }
  const max = top !== undefined && Number.isFinite(top) && top > 0 ? top : Math.max(0, ...vs)
  const ys = vs.map(v => floor - (max > 0 ? Math.min(1, v / max) : 0) * (CELL_PX_H - 2 * pad))
  const first = ys[0] ?? floor
  const pts = vs.length === 1 ? [`0,${num(first)}`, `${w},${num(first)}`] : ys.map((y, i) => `${num((i * w) / (vs.length - 1))},${num(y)}`)
  return svgDoc(
    n,
    1,
    `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`,
  )
}

// Pixels two to a row of cells, CELL_PX_W wide and half a row tall, from (`x0`, `y0`); a run
// of one color in a row is one rect. `keep` leaves out the colors it says no to.
export function pixelRects(px: Pixels, x0 = 0, y0 = 0, keep?: (color: string) => boolean): string {
  const pw = CELL_PX_W
  const ph = CELL_PX_H / 2
  let out = ''
  px.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const c = row[x]
      if (c === undefined || (keep && !keep(c))) {
        x += 1
        continue
      }
      let end = x + 1
      while (end < row.length && row[end] === c) end += 1
      out += `<rect x="${num(x0 + x * pw)}" y="${num(y0 + y * ph)}" width="${num((end - x) * pw)}" height="${num(ph)}" fill="${c}" shape-rendering="crispEdges"/>`
      x = end
    }
  })
  return out
}

// `busy` quickens the breath, `crewFlash` the eyes; `paused` and `still` hold every motion;
// `sights` a blank cell and a corner either side, as the standby suit stands in.
export type SuitLook = { busy?: boolean; crewFlash?: boolean; paused?: boolean; still?: boolean; sights?: boolean }

// the sights' four corners round a `w` by `h` picture
const corners = (w: number, h: number): string => {
  const a = 8
  const i = 2
  const d = [
    `M${i} ${i + a}V${i}H${i + a}`,
    `M${w - i - a} ${i}H${w - i}V${i + a}`,
    `M${i} ${h - i - a}V${h - i}H${i + a}`,
    `M${w - i - a} ${h - i}H${w - i}V${h - i - a}`,
  ]
  return `<path d="${d.join('')}" fill="none" stroke="${THEME.frame}" stroke-width="1.5"/>`
}

// The suit as one picture: its breath, its eyes' glow and the scan line its own animations,
// so nothing but the look decides the source.
export function suitSvg(px: Pixels, look: SuitLook): string {
  const cols = Math.max(0, ...px.map(r => r.length))
  const rows = Math.ceil(px.length / 2)
  const pad = look.sights ? 2 : 0
  const w = cellPx(cols + 2 * pad)
  const h = rowPx(rows)
  const x0 = cellPx(pad)
  const glows = (c: string) => c === THEME.accent
  const moving = look.still !== true && look.paused !== true
  const breath = moving
    ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 2;0 0" dur="${look.busy ? '1.5s' : '3s'}" repeatCount="indefinite"/>`
    : ''
  const glow = moving
    ? `<animate attributeName="opacity" values="1;0.35;1" dur="${look.crewFlash ? '0.3s' : '2s'}" repeatCount="indefinite"/>`
    : ''
  const scan =
    moving && h > CELL_PX_H
      ? `<rect class="scan" x="${x0}" y="0" width="${cellPx(cols)}" height="${CELL_PX_H}" fill="${THEME.bright}" opacity="0.18"><animate attributeName="y" values="0;${h - CELL_PX_H};0" dur="2s" repeatCount="indefinite"/></rect>`
      : ''
  const body = `<g>${breath}${pixelRects(px, x0, 0, c => !glows(c))}<g>${glow}${pixelRects(px, x0, 0, glows)}</g></g>`
  return svgDoc(cols + 2 * pad, rows, `${look.sights ? corners(w, h) : ''}${body}${scan}`)
}

// The arc reactor beside the title, a cell: an ice-blue core pulsing while a squad member
// runs, a dark one at rest.
export function reactorSvg(live: boolean): string {
  const cx = CELL_PX_W / 2
  const cy = num(CELL_PX_H / 2)
  if (!live) return svgDoc(1, 1, `<circle cx="${cx}" cy="${cy}" r="3" fill="${THEME.muted}"/>`)
  return svgDoc(
    1,
    1,
    `<circle cx="${cx}" cy="${cy}" r="3.5" fill="${THEME.accent}"><animate attributeName="r" values="2;3.8;2" dur="1.2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.6;1;0.6" dur="1.2s" repeatCount="indefinite"/></circle>`,
  )
}

// `text` in the pixel font, one color, BIG_ROWS rows tall.
export function bigTextSvg(text: string, color: string): string {
  return svgDoc(bigWidth(text), BIG_ROWS, pixelRects(bigPixels(text, color)))
}

const MONO = 'ui-monospace,Menlo,monospace'

// words centered on a cell row: what an overlay on a ring sets
export type RingLabel = { row: number; text: string; color: string; bold?: boolean }

// A ring lit clockwise from twelve o'clock as far as `pct` (red when depleted), the rest a
// muted track; `labels` centered on their rows. `box`: a larger canvas, the ring at its top
// center (a big gauge with its foot under it).
export function ringSvg(spec: RingSpec, pct: number, depleted: boolean, labels: readonly RingLabel[], box?: { cols: number; rows: number }): string {
  const ringCols = whole(spec.w)
  const ringRows = Math.ceil(whole(spec.h) / 2)
  const cols = box ? Math.max(whole(box.cols), ringCols) : ringCols
  const rows = box ? Math.max(whole(box.rows), ringRows) : ringRows
  const cx = cellPx(cols) / 2
  const cy = rowPx(ringRows) / 2
  const half = Math.min(cellPx(ringCols), rowPx(ringRows)) / 2
  const k = spec.w > 0 ? half / (spec.w / 2) : 0
  const r = ((spec.rOut + spec.rIn) / 2) * k
  const sw = Math.max(1, (spec.rOut - spec.rIn) * k)
  const p = clamp01(pct)
  const len = 2 * Math.PI * r
  const color = depleted ? THEME.error : pick(GAUGE_RAMP, p)
  const at = `cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="none" stroke-width="${num(sw)}"`
  const trackRing = `<circle ${at} stroke="${THEME.muted}"/>`
  const arc = p > 0 ? `<circle class="arc" ${at} stroke="${color}" stroke-dasharray="${num(len * p)} ${num(len)}" transform="rotate(-90 ${num(cx)} ${num(cy)})"/>` : ''
  const words = labels
    .map(
      l =>
        `<text x="${num(cx)}" y="${num(rowPx(l.row) + CELL_PX_H * 0.72)}" text-anchor="middle" font-family="${MONO}" font-size="13" fill="${l.color}"${l.bold ? ' font-weight="bold"' : ''}>${esc(l.text)}</text>`,
    )
    .join('')
  return svgDoc(cols, rows, trackRing + arc + words)
}

// Today's tokens by hour as bars `rows` rows tall and `width` cells wide, heat by height, the
// hour now bright, an hour of nothing a muted floor; then the axis with its ticks and the hour
// now marked, then the tick hours: `rows + 2` rows in all.
export function burnSvg(hours: readonly number[], width: number, rows: number, nowHour: number, ticks: readonly number[]): string {
  const n = whole(width)
  const R = whole(rows)
  const w = cellPx(n)
  const h = rowPx(R)
  const vs = Array.from({ length: 24 }, (_, i) => {
    const v = hours[i] ?? 0
    return Number.isFinite(v) && v > 0 ? v : 0
  })
  const max = Math.max(0, ...vs)
  const per = w / 24
  const gap = per >= 6 ? 1.5 : 0.5
  const bw = Math.max(0, per - gap)
  let body = ''
  vs.forEach((v, i) => {
    const x = num(i * per)
    const lit = i === nowHour
    if (v > 0 && max > 0) {
      const bh = Math.max(2, (v / max) * h)
      body += `<rect class="bar" x="${x}" y="${num(h - bh)}" width="${num(bw)}" height="${num(bh)}" fill="${lit ? THEME.bright : pick(BURN_RAMP, v / max)}"/>`
    } else {
      body += `<rect class="floor" x="${x}" y="${num(h - 2)}" width="${num(bw)}" height="2" fill="${lit ? THEME.bright : THEME.muted}"/>`
    }
  })
  const axisY = h + CELL_PX_H / 2
  body += `<line x1="0" y1="${num(axisY)}" x2="${w}" y2="${num(axisY)}" stroke="${THEME.muted}" stroke-width="1"/>`
  for (const t of ticks) {
    const x = t * per
    if (!Number.isFinite(x) || x >= w) continue
    body += `<line x1="${num(x)}" y1="${num(axisY - 3)}" x2="${num(x)}" y2="${num(axisY + 3)}" stroke="${THEME.muted}" stroke-width="1"/>`
    body += `<text x="${num(x)}" y="${num(h + CELL_PX_H + CELL_PX_H * 0.72)}" font-family="${MONO}" font-size="11" fill="${THEME.frame}">${String(t).padStart(2, '0')}</text>`
  }
  if (Number.isInteger(nowHour) && nowHour >= 0 && nowHour < 24 && w > 0) {
    const nx = nowHour * per + bw / 2
    body += `<path class="now" d="M${num(nx - 4)} ${num(axisY + 6)}L${num(nx)} ${num(axisY)}L${num(nx + 4)} ${num(axisY + 6)}Z" fill="${THEME.bright}"/>`
  }
  return svgDoc(n, R + 2, body)
}
