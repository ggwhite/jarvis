import { THEME } from './jarvis'

// A run of text in one style, as the cockpit draws it.
export type ChartSeg = { t: string; color?: string; bg?: string; bold?: boolean }

// One terminal cell: its character and colors.
export type Cell = { ch: string; fg?: string; bg?: string; bold?: boolean }

// A picture two pixels per cell tall: each a color or nothing.
export type Pixels = (string | undefined)[][]

const rgbOf = (c: string): number[] => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))

const hexOf = (n: readonly number[]): string =>
  `#${n.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0').toUpperCase()).join('')}`

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

// The color `t` of the way from `a` to `b`.
export function mix(a: string, b: string, t: number): string {
  const x = rgbOf(a)
  const y = rgbOf(b)
  const k = clamp01(t)
  return hexOf(x.map((v, i) => v + ((y[i] ?? v) - v) * k))
}

// `steps` colors between each two stops, every stop included once.
export function ramp(stops: readonly string[], steps: number): string[] {
  if (stops.length < 2) return [...stops]
  const out: string[] = []
  for (let s = 0; s + 1 < stops.length; s += 1) {
    const a = stops[s] ?? THEME.frame
    const b = stops[s + 1] ?? a
    for (let i = 0; i < steps; i += 1) out.push(mix(a, b, i / steps))
  }
  out.push(stops[stops.length - 1] ?? THEME.frame)
  return out
}

// The color `t` of the way along `colors`.
export function pick(colors: readonly string[], t: number): string {
  return colors[Math.round(clamp01(t) * (colors.length - 1))] ?? colors[0] ?? THEME.frame
}

// The arc reactor's glow, dark gold to amber to warm white; the burn chart's heat, dark
// gold to amber to suit red.
export const GAUGE_RAMP = ramp([THEME.frame, THEME.primary, THEME.bright], 4)
export const BURN_RAMP = ramp([THEME.frame, THEME.primary, THEME.suitRed], 8)

// Two rows of pixels to one row of cells: a half block in the top pixel's color, the
// bottom one its background.
export function pixelsToCells(px: Pixels): Cell[][] {
  const rows: Cell[][] = []
  for (let r = 0; r + 1 < px.length; r += 2) {
    const top = px[r] ?? []
    const bot = px[r + 1] ?? []
    const row: Cell[] = []
    for (let c = 0; c < Math.max(top.length, bot.length); c += 1) {
      const a = top[c]
      const b = bot[c]
      if (a === undefined && b === undefined) row.push({ ch: ' ' })
      else if (b === undefined) row.push({ ch: '▀', ...(a === undefined ? {} : { fg: a }) })
      else if (a === undefined) row.push({ ch: '▄', fg: b })
      else if (a === b) row.push({ ch: '█', fg: a })
      else row.push({ ch: '▀', fg: a, bg: b })
    }
    rows.push(row)
  }
  return rows
}

export type RingSpec = { w: number; h: number; rOut: number; rIn: number; tip: number }
export const RING_BIG: RingSpec = { w: 14, h: 14, rOut: 7, rIn: 4.4, tip: 0.04 }
export const RING_SMALL: RingSpec = { w: 7, h: 6, rOut: 3.4, rIn: 1.6, tip: 0.06 }

// A ring lit clockwise from twelve o'clock as far as `pct`: dark gold to warm white, a
// bright tip, red all round when the window runs out before it resets; the rest muted.
export function ringPixels(spec: RingSpec, pct: number, depleted: boolean): Pixels {
  const p = clamp01(pct)
  const cx = spec.w / 2
  const cy = spec.h / 2
  const px: Pixels = []
  for (let y = 0; y < spec.h; y += 1) {
    const row: (string | undefined)[] = []
    for (let x = 0; x < spec.w; x += 1) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const d = Math.hypot(dx, dy)
      if (d < spec.rIn || d > spec.rOut) {
        row.push(undefined)
        continue
      }
      const a = (((Math.atan2(dx, -dy) / (2 * Math.PI)) % 1) + 1) % 1
      if (a >= p) row.push(THEME.muted)
      else if (p - a < spec.tip) row.push(THEME.bright)
      else row.push(depleted ? THEME.error : pick(GAUGE_RAMP, p > 0 ? a / p : 0))
    }
    px.push(row)
  }
  return px
}

export type Overlay = { row: number; text: string; color: string; bold?: boolean }

// Each overlay's text set centered on its row, in place.
function setOverlay(cells: Cell[][], overlay: readonly Overlay[]): Cell[][] {
  for (const o of overlay) {
    const row = cells[o.row]
    if (!row) continue
    const chars = [...o.text]
    const start = Math.max(0, Math.floor((row.length - chars.length) / 2))
    chars.forEach((ch, i) => {
      if (start + i < row.length) row[start + i] = { ch, fg: o.color, ...(o.bold ? { bold: true } : {}) }
    })
  }
  return cells
}

// A ring's cells, each overlay's text set centered on its row.
export function gaugeCells(spec: RingSpec, pct: number, depleted: boolean, overlay: readonly Overlay[]): Cell[][] {
  return setOverlay(pixelsToCells(ringPixels(spec, pct, depleted)), overlay)
}

export type RingPart = { share: number; color: string }

// A ring cut into arcs clockwise from twelve o'clock, each part `share` of the turn in its
// color, in order; what the parts leave over muted.
export function partsRingPixels(spec: RingSpec, parts: readonly RingPart[]): Pixels {
  const cx = spec.w / 2
  const cy = spec.h / 2
  const px: Pixels = []
  for (let y = 0; y < spec.h; y += 1) {
    const row: (string | undefined)[] = []
    for (let x = 0; x < spec.w; x += 1) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const d = Math.hypot(dx, dy)
      if (d < spec.rIn || d > spec.rOut) {
        row.push(undefined)
        continue
      }
      const a = (((Math.atan2(dx, -dy) / (2 * Math.PI)) % 1) + 1) % 1
      let acc = 0
      let color: string = THEME.muted
      for (const part of parts) {
        acc += Math.max(0, part.share)
        if (a < acc) {
          color = part.color
          break
        }
      }
      row.push(color)
    }
    px.push(row)
  }
  return px
}

export function partsGaugeCells(spec: RingSpec, parts: readonly RingPart[], overlay: readonly Overlay[]): Cell[][] {
  return setOverlay(pixelsToCells(partsRingPixels(spec, parts)), overlay)
}

const EIGHTHS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']

// A bar `width` cells long filled to `pct` in eighths of a cell, each cell colored by how
// far along the fill it sits; the rest shaded.
export function rampBar(width: number, pct: number, colors: readonly string[]): Cell[] {
  const p = clamp01(pct)
  const eighths = Math.round(p * width * 8)
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  const out: Cell[] = []
  for (let i = 0; i < width; i += 1) {
    const c = pick(colors, p > 0 ? (i + 0.5) / (p * width) : 0)
    if (i < full) out.push({ ch: '█', fg: c })
    else if (i === full && part > 0) out.push({ ch: EIGHTHS[part] ?? '█', fg: c })
    else out.push({ ch: '░', fg: THEME.muted })
  }
  return out
}

// The arc reactor as a bar: dark gold to warm white, red when depleted.
export function gaugeBar(width: number, pct: number, depleted: boolean): Cell[] {
  return rampBar(width, pct, depleted ? [THEME.error] : GAUGE_RAMP)
}

// A 3×5 pixel font, row by row, `#` lit: the digits, % and -. Drawn as half blocks it is
// BIG_ROWS cells tall (the sixth pixel row blank).
const FONT: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  '-': ['...', '...', '###', '...', '...'],
}
const GLYPH_W = 3
const GLYPH_GAP = 1
export const BIG_ROWS = 3

export function bigWidth(text: string): number {
  const n = [...text].length
  return n === 0 ? 0 : n * GLYPH_W + (n - 1) * GLYPH_GAP
}

// `text` in the pixel font, one color; a character the font lacks is a blank glyph.
export function bigText(text: string, color: string): Cell[][] {
  const glyphs = [...text].map(ch => FONT[ch] ?? ['...', '...', '...', '...', '...'])
  const px: Pixels = Array.from({ length: BIG_ROWS * 2 }, (_, y) =>
    glyphs.flatMap((g, i) => [
      ...(i > 0 ? Array<string | undefined>(GLYPH_GAP).fill(undefined) : []),
      ...[...(g[y] ?? '...')].map(c => (c === '#' ? color : undefined)),
    ]),
  )
  return pixelsToCells(px)
}

export type StackPart = { share: number; color: string }

// One bar the width, its parts side by side by share (largest remainder), each part with
// any share at least a cell; nothing to show is a muted track.
export function stackedBar(width: number, parts: readonly StackPart[]): Cell[] {
  const w = Math.max(0, Math.floor(width))
  const live = parts.filter(p => p.share > 0)
  const total = live.reduce((s, p) => s + p.share, 0)
  if (w === 0) return []
  if (total <= 0) return Array.from({ length: w }, () => ({ ch: '░', fg: THEME.muted }))
  const raw = live.map(p => (p.share / total) * w)
  const cells = raw.map(r => Math.floor(r))
  let left = w - cells.reduce((s, n) => s + n, 0)
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac)
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) {
    const i = order[k]?.i ?? 0
    cells[i] = (cells[i] ?? 0) + 1
  }
  for (let i = 0; i < cells.length; i += 1) {
    if ((cells[i] ?? 0) > 0) continue
    const most = Math.max(...cells)
    if (most <= 1) break
    cells[cells.indexOf(most)] = most - 1
    cells[i] = 1
  }
  return live.flatMap((p, i) => Array.from({ length: cells[i] ?? 0 }, () => ({ ch: '█', fg: p.color })))
}

// Today's tokens by hour as an area chart `rows` cells tall and `width` wide, heat by
// height, the hour now bright, an hour of nothing a muted floor; then the axis with its
// ticks and the hour now marked ▲, then the tick hours.
export function burnChart(hours: readonly number[], width: number, rows: number, nowHour: number, ticks: readonly number[]): Cell[][] {
  const H = rows * 2
  const max = Math.max(0, ...hours)
  const per = width / 24
  const px: Pixels = Array.from({ length: H }, () => Array.from({ length: width }, () => undefined as string | undefined))
  for (let x = 0; x < width; x += 1) {
    const h = Math.floor((x * 24) / width)
    const start = Math.ceil(h * per)
    const end = Math.ceil((h + 1) * per)
    if (end - start >= 3 && x === end - 1) continue
    const v = hours[h] ?? 0
    const tall = v > 0 && max > 0 ? Math.max(1, Math.round((v / max) * H)) : 0
    for (let k = 0; k < H; k += 1) {
      const row = px[H - 1 - k]
      if (!row) continue
      if (k < tall) row[x] = h === nowHour ? THEME.bright : pick(BURN_RAMP, H > 1 ? k / (H - 1) : 0)
      else if (k === 0) row[x] = h === nowHour ? THEME.bright : THEME.muted
    }
  }
  const axis: Cell[] = Array.from({ length: width }, () => ({ ch: '─', fg: THEME.muted }))
  const labels: Cell[] = Array.from({ length: width }, () => ({ ch: ' ' }))
  for (const t of ticks) {
    const x = Math.ceil(t * per)
    if (x < width) axis[x] = { ch: '┴', fg: THEME.muted }
    ;[...String(t).padStart(2, '0')].forEach((ch, i) => {
      if (x + i < width) labels[x + i] = { ch, fg: THEME.frame }
    })
  }
  const nowX = Math.ceil(nowHour * per)
  if (nowX < width) axis[nowX] = { ch: '▲', fg: THEME.bright }
  return [...pixelsToCells(px), axis, labels]
}

const DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

// `vals` as one row of braille `width` cells wide: a line four dots tall, scaled to `top`
// when given (a value past it drawn at the top) or else its own highest value, each dot
// joined to the one before it.
export function brailleLine(vals: readonly number[], width: number, top?: number): string {
  if (width <= 0) return ''
  const dw = width * 2
  const dh = 4
  const n = vals.length
  const max = top ?? Math.max(0, ...vals)
  const ys: number[] = []
  for (let x = 0; x < dw; x += 1) {
    const f = n > 1 && dw > 1 ? (x * (n - 1)) / (dw - 1) : 0
    const i = Math.min(Math.floor(f), Math.max(0, n - 2))
    const a = vals[i] ?? 0
    const b = vals[i + 1] ?? a
    const v = a + (b - a) * (f - i)
    ys.push(Math.round((1 - (max > 0 ? Math.min(1, v / max) : 0)) * (dh - 1)))
  }
  const dots = new Set<string>()
  ys.forEach((y, x) => {
    const prev = x > 0 ? (ys[x - 1] ?? y) : y
    for (let yy = Math.min(y, prev); yy <= Math.max(y, prev); yy += 1) dots.add(`${x},${yy}`)
  })
  let out = ''
  for (let c = 0; c < width; c += 1) {
    let bits = 0
    for (let dx = 0; dx < 2; dx += 1) {
      for (let dy = 0; dy < dh; dy += 1) {
        if (dots.has(`${c * 2 + dx},${dy}`)) bits |= DOTS[dx]?.[dy] ?? 0
      }
    }
    out += String.fromCodePoint(0x2800 + bits)
  }
  return out
}

// Cells to segments, neighbours of one style merged.
export function cellsToSegs(cells: readonly Cell[]): ChartSeg[] {
  const out: ChartSeg[] = []
  for (const c of cells) {
    const last = out.at(-1)
    if (last && last.color === c.fg && last.bg === c.bg && !!last.bold === !!c.bold) {
      last.t += c.ch
      continue
    }
    out.push({ t: c.ch, ...(c.fg ? { color: c.fg } : {}), ...(c.bg ? { bg: c.bg } : {}), ...(c.bold ? { bold: true } : {}) })
  }
  return out
}
