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
