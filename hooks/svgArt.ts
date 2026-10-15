import { GAUGE_RAMP } from './fleetChart'
import type { StackPart } from './fleetChart'
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
  const bar =
    fill > 0
      ? `<defs>${gradient('g', colors)}</defs><rect class="fill" x="0" y="${BAR_Y}" width="${num(fill)}" height="${BAR_H}" rx="2" fill="url(#g)"/>`
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
