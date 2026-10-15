import type { FleetQuota } from '../types'
import { type Cell, type Pixels, mix, pixelsToCells } from './fleetChart'
import { THEME, cellWidth, fmtDur, fmtUsd } from './jarvis'

// The Mark XLII in miniature, 28 pixels tall, each row centered to 24: R the suit's red,
// G its gold, E the eyes and C the arc reactor in ice blue, W the glint, D the mouth plate.
export const SUIT_ART = [
  'RRRRRRRRRRRR',
  'RRRRRRRRRRRRRRRR',
  'RRRRRRRRRRRRRRRRRR',
  'RRRRRGGGGGGGGGGRRRRR',
  'RRRRGGGGGGGGGGGGRRRR',
  'RRRRGGGGGGGGGGGGGGRRRR',
  'RRRGGGGGGGGGGGGGGGGRRR',
  'RRRGGGGGGGGGGGGGGGGRRR',
  'RRRGEEEWEGGGGEWEEEGRRR',
  'RRRGGEEEEGGGGEEEEGGRRR',
  'RRRGGGGGGGGGGGGGGGGRRR',
  'RRRRGGGGGGGGGGGGGGRRRR',
  'RRRGGGGDDDDDDGGGGRRR',
  'RRRRGGGGGGGGGGGGRRRR',
  'RRRRRGGGGGGGGRRRRR',
  'RRRRRRRRRRRRRR',
  'RRRRRRRR',
  'RRRRRRRRRRRRRR',
  'RRRRRRCWWCRRRRRR',
  'GRRRRRCWWWWCRRRRRG',
  'GGRRRRRCWWCRRRRRGG',
  'CC.RRGGGCCGGGRR.CC',
  'RGGGGGGGGR',
  'RRRRRRRRRR',
  'RRRR..RRRR',
  'RRRRR..RRRRR',
  'RRRRR..RRRRR',
  '',
]

export const SUIT_COLS = 24
export const SUIT_ROWS = SUIT_ART.length / 2
// The standby suit's canvas, 32 by 32 pixels: 16 rows of 32 cells, the art 4 pixels in
// and 1 down.
export const SUIT_CANVAS_COLS = 32
export const SUIT_CANVAS_ROWS = 16
const CANVAS_PX = SUIT_CANVAS_ROWS * 2
const OX = 4
const OY = 1
// the canvas, a blank row and its two lines of text
export const SUIT_BLOCK_ROWS = SUIT_CANVAS_ROWS + 3

const SUIT_COLOR: Record<string, string> = {
  R: THEME.suitRed,
  G: THEME.suitGold,
  E: THEME.accent,
  C: THEME.accent,
  W: THEME.bright,
  D: THEME.muted,
}

// The suit's art as pixels, each row centered to SUIT_COLS: what suitCells draws as cells.
export function suitArtPixels(): Pixels {
  return SUIT_ART.map(r => {
    const left = Math.floor((SUIT_COLS - r.length) / 2)
    return [...r.padStart(left + r.length, '.').padEnd(SUIT_COLS, '.')].map(ch => SUIT_COLOR[ch])
  })
}

// The suit as cells: two pixels to a cell, half blocks only, a cell of one color the top
// half over a background of the same.
export function suitCells(): Cell[][] {
  return pixelsToCells(suitArtPixels()).map(row => row.map(c => (c.ch === '█' && c.fg ? { ch: '▀', fg: c.fg, bg: c.fg } : c)))
}

// A power readout's meter, in cells.
export const POWER_METER_W = 5
// The widest readout: `POWER 5H ▰▰▰▰▰ 100%`.
export const READOUT_MAX_W = cellWidth('POWER 5H') + 1 + POWER_METER_W + 1 + cellWidth('100%')
// The narrowest side the readouts stand in beside the suit.
export const READOUT_SIDE_MIN_W = 12
// From this many columns the readouts stand either side of the suit's sights, each in the
// first form that fits its side; below, under it.
export const SCAN_SIDE_MIN_COLS = SUIT_CANVAS_COLS + 4 + 2 * READOUT_SIDE_MIN_W
// The fewest cells a meter keeps beside the suit, or it goes.
const SIDE_METER_MIN_W = 3
// The rows the readouts take under the suit when they do not fit beside it.
export const SUIT_UNDER_ROWS = 4

// `short` is the label beside the suit when the full one does not fit: '' for none, left out
// for the full one.
export type Readout = { label: string; short?: string; value: string; tone: 'primary' | 'bright' | 'error' | 'frame'; meter?: { pct: number } }

// How long the session has been up, as the statusline writes it: `45s`, `12m`, `7h32m`, `1d3h`.
export function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

// The meter's cells a readout keeps in `width`: it gives way a cell at a time, its label
// and value never; 0 drops the meter and its space.
export function readoutMeterW(r: Readout, width: number): number {
  if (!r.meter) return 0
  const bare = (r.label === '' ? 0 : cellWidth(r.label) + 1) + cellWidth(r.value)
  return Math.max(0, Math.min(POWER_METER_W, width - bare - 1))
}

// The form a readout takes beside the suit in `width` cells, the first that fits: with a
// meter, the full label and a meter of 3 to 5 cells, the short label and one, the short label
// alone; without, the full label, then the short. Else the value alone, never cut.
export function sideReadout(r: Readout, width: number): { label: string; meterW: number } {
  const short = r.short ?? r.label
  const forms: [string, boolean][] = r.meter ? [[r.label, true], [short, true], [short, false]] : [[r.label, false], [short, false]]
  for (const [label, meter] of forms) {
    const bare = (label === '' ? 0 : cellWidth(label) + 1) + cellWidth(r.value)
    if (meter) {
      const meterW = Math.min(POWER_METER_W, width - bare - 1)
      if (meterW >= SIDE_METER_MIN_W) return { label, meterW }
    } else if (bare <= width) {
      return { label, meterW: 0 }
    }
  }
  return { label: '', meterW: 0 }
}

const powerTone = (pct: number): Readout['tone'] => (pct >= 80 ? 'error' : pct >= 50 ? 'bright' : 'primary')

// The scan station's readouts: power, crew spend and uptime on the left; the crew's count
// and the last event's age on the right. No quota file, no power lines.
export function standbyReadouts(input: {
  quota?: FleetQuota
  crewCost: number
  uptimeMs?: number
  done: number
  active: number
  failed: number
  lastAgoMs?: number
}): { left: Readout[]; right: Readout[] } {
  const left: Readout[] = []
  const q = input.quota
  if (q?.fiveHour) {
    left.push({ label: 'POWER 5H', short: '5H', value: `${Math.round(q.fiveHour.usedPct)}%`, tone: powerTone(q.fiveHour.usedPct), meter: { pct: q.fiveHour.usedPct / 100 } })
  }
  if (q?.sevenDay) {
    left.push({ label: 'POWER 7D', short: '7D', value: `${Math.round(q.sevenDay.usedPct)}%`, tone: powerTone(q.sevenDay.usedPct), meter: { pct: q.sevenDay.usedPct / 100 } })
  }
  left.push({ label: 'CREW', short: '', value: fmtUsd(input.crewCost), tone: 'primary' })
  left.push({ label: 'UPTIME', short: 'UP', value: input.uptimeMs === undefined ? '--' : fmtUptime(input.uptimeMs), tone: 'primary' })
  const right: Readout[] = [
    { label: 'CREW', short: '', value: `${input.done} DOCKED`, tone: 'primary' },
    { label: '', value: `${input.active} ACTIVE`, tone: input.active > 0 ? 'bright' : 'frame' },
    { label: '', value: `${input.failed} FAIL`, tone: input.failed > 0 ? 'error' : 'frame' },
    { label: 'LAST', value: input.lastAgoMs === undefined ? '--' : fmtDur(input.lastAgoMs), tone: 'frame' },
  ]
  return { left, right }
}

// ---- 待機動作 ----

export type Pose = 'STANDBY' | 'WAVE' | 'HOVER' | 'REPULSOR' | 'CHARGE'

// The standby suit's frame time, and how long each pose holds, in turn.
export const SUIT_TICK_MS = 250
export const STANDBY_MS = 6000
export const WAVE_MS = 3000
export const HOVER_MS = 4000
export const REPULSOR_MS = 3000
export const CHARGE_MS = 2000
// a minute without a stir the suit rests: STANDBY, no scan line, a frame a second
export const SUIT_REST_AFTER_MS = 60_000
export const SUIT_REST_TICK_MS = 1000
// the arc reactor's breath, and while the main loop has a call out
const BREATH_MS = 2000
const BREATH_BUSY_MS = 1000
const BLINK_MS = 3000
// a deployed crew member: the eyes and palms flash this many frames, the line shows this long
const CREW_FLASH_FRAMES = 2
export const CREW_SHOW_MS = 2000
// the scan line's pull toward bright, and the charge's last frame's
const SCAN_MIX = 0.35
const CHARGE_FLASH_MIX = 0.25
// the frames a charging palm takes from accent to bright
const CHARGE_RAMP_FRAMES = 4

// A pixel of the suit: a code below, or a color of its own.
// R G D the suit's red, gold and mouth plate; E Y the eyes and their glint; C K the arc
// reactor and its glint; A plain accent; H a palm; P a palm firing.
const PX_COLOR: Record<string, string> = {
  R: THEME.suitRed,
  G: THEME.suitGold,
  D: THEME.muted,
  E: THEME.accent,
  Y: THEME.bright,
  C: THEME.accent,
  K: THEME.bright,
  A: THEME.accent,
  H: THEME.accent,
  P: THEME.bright,
}

type Sprite = Map<number, string>
type Px = [number, number, string]

const key = (r: number, c: number) => r * 64 + c
const rc = (k: number): [number, number] => [Math.floor(k / 64), k % 64]

// the palms, art row 21, two pixels at each side
const HANDS = new Set([key(21, 3), key(21, 4), key(21, 19), key(21, 20)])
const RIGHT_ARM = new Set([key(19, 20), key(20, 19), key(20, 20), key(21, 19), key(21, 20)])

function buildBase(): Sprite {
  const base: Sprite = new Map()
  SUIT_ART.forEach((row, r) => {
    const left = Math.floor((SUIT_COLS - row.length) / 2)
    ;[...row].forEach((ch, i) => {
      const c = left + i
      if (ch === '.') return
      const k = key(r, c)
      const code =
        (ch === 'E' || ch === 'W') && r < 15
          ? ch === 'E' ? 'E' : 'Y'
          : (ch === 'C' || ch === 'W') && r >= 18 && r <= 20
            ? ch === 'C' ? 'C' : 'K'
            : HANDS.has(k)
              ? 'H'
              : ch === 'C'
                ? 'A'
                : ch
      base.set(k, code)
    })
  })
  return base
}

const BASE = buildBase()

const withoutRightArm = (): Sprite => new Map([...BASE].filter(([k]) => !RIGHT_ARM.has(k)))

const put = (sprite: Sprite, cells: readonly Px[]): Sprite => {
  for (const [r, c, v] of cells) sprite.set(key(r, c), v)
  return sprite
}

const WAVE_NEAR: Px[] = [
  [18, 20, 'G'], [18, 21, 'G'], [17, 21, 'R'], [17, 22, 'R'], [16, 22, 'R'], [16, 23, 'R'],
  [15, 23, 'R'], [15, 24, 'R'], [14, 23, 'R'], [14, 24, 'R'], [13, 23, 'G'], [13, 24, 'G'],
  [12, 23, 'G'], [12, 24, 'G'], [11, 23, 'R'], [11, 24, 'R'],
  [10, 23, 'H'], [10, 24, 'H'], [9, 23, 'H'], [9, 24, 'H'], [8, 23, 'H'], [8, 24, 'H'], [7, 24, 'H'],
]
const WAVE_FAR: Px[] = [
  [18, 20, 'G'], [18, 21, 'G'], [17, 21, 'R'], [17, 22, 'R'], [16, 22, 'R'], [16, 23, 'R'],
  [15, 23, 'R'], [15, 24, 'R'], [14, 24, 'R'], [14, 25, 'R'], [13, 24, 'G'], [13, 25, 'G'],
  [12, 25, 'G'], [12, 26, 'G'], [11, 25, 'R'], [11, 26, 'R'],
  [10, 26, 'H'], [10, 27, 'H'], [9, 26, 'H'], [9, 27, 'H'], [8, 26, 'H'], [8, 27, 'H'], [7, 27, 'H'],
]
const REPULSOR_ARM: Px[] = [
  [18, 20, 'G'], [18, 21, 'R'], [18, 22, 'R'], [19, 20, 'G'], [19, 21, 'R'], [19, 22, 'R'],
  [18, 23, 'P'], [19, 23, 'P'],
]
const FOOT_CENTERS = [8, 15]

const ticksOf = (ms: number) => Math.max(1, Math.round(ms / SUIT_TICK_MS))

// 0 to 1 and back over a phase of 0 to 1
const tri = (phase: number) => 1 - Math.abs(2 * phase - 1)

// A pose's pixels at its frame `t`: the sprite, how far it is lifted and what it fires.
type Shot = { sprite: Sprite; dy: number; beam: Map<number, string> }

// standing by `ms` into its breath, the eyes gold when `blink`
function standbyAt(ms: number, busy: boolean, blink: boolean): Shot {
  const sprite: Sprite = new Map(BASE)
  const breath = busy ? BREATH_BUSY_MS : BREATH_MS
  const reactor = mix(THEME.accent, THEME.bright, tri((ms % breath) / breath))
  for (const [k, v] of sprite) {
    if (v === 'C' || v === 'K') sprite.set(k, reactor)
    else if (blink && (v === 'E' || v === 'Y')) sprite.set(k, 'G')
  }
  return { sprite, dy: 0, beam: new Map() }
}

function standby(t: number, busy: boolean): Shot {
  return standbyAt(t * SUIT_TICK_MS, busy, t % ticksOf(BLINK_MS) === ticksOf(BLINK_MS) - 1)
}

// at rest the breath and the blink go by the clock, a second at a time
function resting(now: number, busy: boolean): Shot {
  const n = Math.round(BLINK_MS / SUIT_REST_TICK_MS)
  return standbyAt(now, busy, Math.floor(now / SUIT_REST_TICK_MS) % n === n - 1)
}

function wave(t: number): Shot {
  return { sprite: put(withoutRightArm(), Math.floor(t / 2) % 2 === 0 ? WAVE_NEAR : WAVE_FAR), dy: 0, beam: new Map() }
}

function hover(t: number): Shot {
  const sprite: Sprite = new Map(BASE)
  const flame = [THEME.bright, THEME.accent, THEME.suitGold]
  for (const cx of FOOT_CENTERS) {
    const shape: [number, number[]][] = [
      [27, [-1, 0, 1]],
      [28, t % 2 === 1 ? [-1, 0, 1] : [0]],
      [29, [0]],
    ]
    shape.forEach(([r, offs], i) => {
      for (const d of offs) sprite.set(key(r, cx + d), flame[(i + t) % 3] ?? THEME.bright)
    })
  }
  return { sprite, dy: -(Math.floor(t / 2) % 2), beam: new Map() }
}

function repulsor(t: number): Shot {
  const n = ticksOf(REPULSOR_MS)
  const stage = Math.min(3, Math.floor((t * 4) / n))
  // the beam from the palm to the canvas's right edge, never past it
  const reach = SUIT_CANVAS_COLS - (OX + SUIT_COLS)
  const length = [1, 2, reach, reach][stage] ?? reach
  const flash = t === n - 1
  const beam = new Map<number, string>()
  for (let i = 0; i < length; i += 1) {
    const c = SUIT_COLS + i
    beam.set(key(17, c), flash ? THEME.bright : THEME.accent)
    beam.set(key(18, c), THEME.bright)
    beam.set(key(19, c), THEME.bright)
    beam.set(key(20, c), flash ? THEME.bright : THEME.accent)
  }
  return { sprite: put(withoutRightArm(), REPULSOR_ARM), dy: 0, beam }
}

function charge(t: number): Shot {
  const sprite: Sprite = new Map(BASE)
  const palm = mix(THEME.accent, THEME.bright, Math.min(1, t / (CHARGE_RAMP_FRAMES - 1)))
  for (const [k, v] of sprite) {
    if (v === 'C' || v === 'K') sprite.set(k, THEME.bright)
    else if (HANDS.has(k)) sprite.set(k, palm)
  }
  // fully lit, each palm a pixel larger: a ring of glow where the suit is not
  if (t >= CHARGE_RAMP_FRAMES - 1) {
    for (const h of HANDS) {
      const [r, c] = rc(h)
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const k = key(r + dr, c + dc)
          if (!sprite.has(k)) sprite.set(k, THEME.accent)
        }
      }
    }
  }
  return { sprite, dy: 0, beam: new Map() }
}

const POSES: { pose: Pose; ms: number; shot: (t: number, busy: boolean) => Shot }[] = [
  { pose: 'STANDBY', ms: STANDBY_MS, shot: standby },
  { pose: 'WAVE', ms: WAVE_MS, shot: wave },
  { pose: 'HOVER', ms: HOVER_MS, shot: hover },
  { pose: 'REPULSOR', ms: REPULSOR_MS, shot: repulsor },
  { pose: 'CHARGE', ms: CHARGE_MS, shot: charge },
]
const CYCLE = POSES.reduce((n, p) => n + ticksOf(p.ms), 0)

// the pose at frame `f` of the cycle, and the frame within it
function poseAt(f: number): { i: number; t: number } {
  let t = ((f % CYCLE) + CYCLE) % CYCLE
  for (let i = 0; i < POSES.length; i += 1) {
    const n = ticksOf(POSES[i]?.ms ?? 0)
    if (t < n) return { i, t }
    t -= n
  }
  return { i: 0, t: 0 }
}

// Whether the suit rests: SUIT_REST_AFTER_MS since the latest stir, an event's end, a crew
// member deployed or the session's start; never while the main loop has a call out, nor
// when none is known.
export function suitResting(input: { now: number; busy: boolean; lastEventAt?: number; deployedAt?: number; startedAt?: number }): boolean {
  const stirs = [input.lastEventAt, input.deployedAt, input.startedAt].filter((t): t is number => t !== undefined)
  return !input.busy && stirs.length > 0 && input.now - Math.max(...stirs) >= SUIT_REST_AFTER_MS
}

// Whether the line under the suit reads `◆ CREW DEPLOYED`: for CREW_SHOW_MS after a spawn.
export function crewDeployed(now: number, deployedAt: number | undefined): boolean {
  return deployedAt !== undefined && now >= deployedAt && now - deployedAt < CREW_SHOW_MS
}

// The standby suit's pixels at frame `tick`, and its pose: what suitFrame draws as cells.
export function framePixels(
  tick: number,
  opts: { busy: boolean; deployedAt?: number; now: number; resting?: boolean; still?: boolean },
): { px: Pixels; pose: Pose } {
  const f = Number.isFinite(tick) ? Math.max(0, Math.floor(tick)) : 0
  const { i, t } = opts.resting || opts.still ? { i: 0, t: 0 } : poseAt(f)
  const at = POSES[i] ?? POSES[0]
  const pose = at?.pose ?? 'STANDBY'
  const { sprite, dy, beam } = opts.still
    ? standbyAt(0, false, false)
    : opts.resting
      ? resting(opts.now, opts.busy)
      : at
        ? at.shot(t, opts.busy)
        : standby(t, opts.busy)
  const since = opts.deployedAt === undefined || opts.still ? -1 : opts.now - opts.deployedAt
  const flash = since >= 0 && since < CREW_FLASH_FRAMES * SUIT_TICK_MS
  const lit = pose === 'CHARGE' && t === ticksOf(CHARGE_MS) - 1
  const px: Pixels = Array.from({ length: CANVAS_PX }, () => Array<string | undefined>(SUIT_CANVAS_COLS).fill(undefined))
  const plot = (y: number, x: number, color: string) => {
    const row = px[y]
    if (row && x >= 0 && x < SUIT_CANVAS_COLS) row[x] = color
  }
  for (const [k, v] of sprite) {
    const [r, c] = rc(k)
    const color =
      flash && (v === 'E' || v === 'Y' || v === 'H' || v === 'P' || HANDS.has(k)) ? THEME.bright : (PX_COLOR[v] ?? v)
    plot(r + OY + dy, c + OX, lit ? mix(color, THEME.bright, CHARGE_FLASH_MIX) : color)
  }
  for (const [k, color] of beam) {
    const [r, c] = rc(k)
    plot(r + OY, c + OX, color)
  }
  const scan = opts.resting || opts.still ? undefined : px[f % CANVAS_PX]
  if (scan) scan.forEach((color, x) => (scan[x] = color === undefined ? undefined : mix(color, THEME.bright, SCAN_MIX)))
  return { px, pose }
}

// The standby suit at frame `tick`: the poses in turn, the scan line a pixel row lower each
// frame, the eyes and palms flashing just after a spawn; `resting`, standing by with no scan
// line whatever the tick; `still`, standing by at the start of its breath whatever the tick,
// the times or a spawn. Nothing but the tick and the times decide it.
export function suitFrame(
  tick: number,
  opts: { busy: boolean; deployedAt?: number; now: number; resting?: boolean; still?: boolean },
): { cells: Cell[][]; pose: Pose } {
  const { px, pose } = framePixels(tick, opts)
  const cells = pixelsToCells(px).map(row => row.map(c => (c.ch === '█' && c.fg ? { ch: '▀', fg: c.fg, bg: c.fg } : c)))
  return { cells, pose }
}
