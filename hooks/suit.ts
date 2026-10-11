import { type Cell, type Pixels, pixelsToCells } from './fleetChart'
import { THEME } from './jarvis'

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
