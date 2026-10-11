import type { FleetQuota } from '../types'
import { type Cell, type Pixels, pixelsToCells } from './fleetChart'
import { THEME, fmtDur, fmtUsd } from './jarvis'

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
// the art, a blank row and its two lines of text
export const SUIT_BLOCK_ROWS = SUIT_ROWS + 3

const SUIT_COLOR: Record<string, string> = {
  R: THEME.suitRed,
  G: THEME.suitGold,
  E: THEME.accent,
  C: THEME.accent,
  W: THEME.bright,
  D: THEME.muted,
}

// The suit as cells: two pixels to a cell, half blocks only, a cell of one color the top
// half over a background of the same.
export function suitCells(): Cell[][] {
  const px: Pixels = SUIT_ART.map(r => {
    const left = Math.floor((SUIT_COLS - r.length) / 2)
    return [...r.padStart(left + r.length, '.').padEnd(SUIT_COLS, '.')].map(ch => SUIT_COLOR[ch])
  })
  return pixelsToCells(px).map(row => row.map(c => (c.ch === '█' && c.fg ? { ch: '▀', fg: c.fg, bg: c.fg } : c)))
}

// From this many columns the readouts stand either side of the suit; below, under it.
export const SCAN_SIDE_MIN_COLS = 64
// The rows the readouts take under the suit when they do not fit beside it.
export const SUIT_UNDER_ROWS = 4

export type Readout = { label: string; value: string; tone: 'primary' | 'bright' | 'error' | 'frame'; meter?: { pct: number } }

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
    left.push({ label: 'POWER 5H', value: `${Math.round(q.fiveHour.usedPct)}%`, tone: powerTone(q.fiveHour.usedPct), meter: { pct: q.fiveHour.usedPct / 100 } })
  }
  if (q?.sevenDay) {
    left.push({ label: 'POWER 7D', value: `${Math.round(q.sevenDay.usedPct)}%`, tone: powerTone(q.sevenDay.usedPct), meter: { pct: q.sevenDay.usedPct / 100 } })
  }
  left.push({ label: 'CREW', value: fmtUsd(input.crewCost), tone: 'primary' })
  left.push({ label: 'UPTIME', value: input.uptimeMs === undefined ? '--' : fmtDur(input.uptimeMs), tone: 'primary' })
  const right: Readout[] = [
    { label: 'CREW', value: `${input.done} DOCKED`, tone: 'primary' },
    { label: '', value: `${input.active} ACTIVE`, tone: input.active > 0 ? 'bright' : 'frame' },
    { label: '', value: `${input.failed} FAIL`, tone: input.failed > 0 ? 'error' : 'frame' },
    { label: 'LAST', value: input.lastAgoMs === undefined ? '--' : fmtDur(input.lastAgoMs), tone: 'frame' },
  ]
  return { left, right }
}
