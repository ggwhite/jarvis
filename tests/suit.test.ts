import { describe, expect, test } from 'claude-code/testing'

import { THEME } from '../hooks/jarvis'
import { SUIT_ART, SUIT_BLOCK_ROWS, SUIT_COLS, SUIT_ROWS, standbyReadouts, suitCells } from '../hooks/suit'

describe('suit', () => {
  test('the art is 14 rows of 24 cells, a block of 17 rows with its two lines', () => {
    expect(SUIT_ROWS).toBe(14)
    expect(SUIT_COLS).toBe(24)
    expect(SUIT_BLOCK_ROWS).toBe(17)
    const cells = suitCells()
    expect(cells).toHaveLength(SUIT_ROWS)
    for (const row of cells) expect(row).toHaveLength(SUIT_COLS)
  })

  test('cells are half blocks or blank, colored only from the theme', () => {
    const allowed = new Set<string>([THEME.suitRed, THEME.suitGold, THEME.accent, THEME.bright, THEME.muted])
    for (const c of suitCells().flat()) {
      expect(['▀', '▄', ' ']).toContain(c.ch)
      if (c.ch === ' ') {
        expect(c.fg).toBeUndefined()
        expect(c.bg).toBeUndefined()
      } else {
        expect(allowed.has(c.fg ?? '')).toBe(true)
        if (c.bg !== undefined) expect(allowed.has(c.bg)).toBe(true)
      }
    }
  })

  test('each art row centered to 24 pixels, two pixels to a cell', () => {
    const color: Record<string, string> = {
      R: THEME.suitRed,
      G: THEME.suitGold,
      E: THEME.accent,
      C: THEME.accent,
      W: THEME.bright,
      D: THEME.muted,
    }
    const px = SUIT_ART.map(r => {
      const left = Math.floor((SUIT_COLS - r.length) / 2)
      return [...'.'.repeat(left) + r + '.'.repeat(SUIT_COLS - r.length - left)].map(ch => color[ch])
    })
    const cells = suitCells()
    for (let y = 0; y < SUIT_ROWS; y += 1) {
      for (let x = 0; x < SUIT_COLS; x += 1) {
        const top = px[y * 2]?.[x]
        const bot = px[y * 2 + 1]?.[x]
        const c = cells[y]?.[x]
        if (top !== undefined) expect(c).toEqual({ ch: '▀', fg: top, ...(bot === undefined ? {} : { bg: bot }) })
        else if (bot !== undefined) expect(c).toEqual({ ch: '▄', fg: bot })
        else expect(c).toEqual({ ch: ' ' })
      }
    }
    // the helmet's top: 12 red pixels from column 6, over 16 from column 4
    expect(cells[0]?.slice(0, 4).map(c => c.ch).join('')).toBe('    ')
    expect(cells[0]?.slice(4, 6).map(c => c.ch).join('')).toBe('▄▄')
    expect(cells[0]?.[6]).toEqual({ ch: '▀', fg: THEME.suitRed, bg: THEME.suitRed })
    // the eyes: accent with a warm white glint
    expect(cells[4]?.some(c => c.fg === THEME.bright)).toBe(true)
  })

  test('the art is the approved prototype', () => {
    expect(SUIT_ART).toHaveLength(28)
    expect(SUIT_ART[8]).toBe('RRRGEEEWEGGGGEWEEEGRRR')
    expect(SUIT_ART[21]).toBe('CC.RRGGGCCGGGRR.CC')
    expect(SUIT_ART[27]).toBe('')
  })
})

describe('standby readouts', () => {
  test('power from the quota, crew spend and uptime on the left', () => {
    const r = standbyReadouts({
      quota: { fiveHour: { usedPct: 9, resetsAt: 0, windowMin: 300 }, sevenDay: { usedPct: 96, resetsAt: 0, windowMin: 10080 }, fetchedAt: 0 },
      crewCost: 65.48, uptimeMs: 7 * 3600_000 + 32 * 60_000, done: 50, active: 0, failed: 4, lastAgoMs: 120_000,
    })
    expect(r.left.map(x => x.label)).toEqual(['POWER 5H', 'POWER 7D', 'CREW', 'UPTIME'])
    expect(Math.abs((r.left[0]?.meter?.pct ?? 0) - 0.09) < 1e-9).toBe(true)
    expect(r.left[0]?.value).toBe('9%')
    expect(r.left[0]?.tone).toBe('primary')
    expect(r.left[1]?.tone).toBe('error')
    expect(r.left[2]?.value).toBe('$65.48')
    expect(r.left[3]?.value).toBe('452m00s')
    expect(r.right.map(x => x.value)).toEqual(['50 DOCKED', '0 ACTIVE', '4 FAIL', '2m00s'])
    expect(r.right.map(x => x.label)).toEqual(['CREW', '', '', 'LAST'])
    expect(r.right[2]?.tone).toBe('error')
  })

  test('power tone: bright from 50%, error from 80%', () => {
    const tone = (usedPct: number) =>
      standbyReadouts({ quota: { fiveHour: { usedPct, resetsAt: 0, windowMin: 300 }, fetchedAt: 0 }, crewCost: 0, done: 0, active: 0, failed: 0 }).left[0]?.tone
    expect([tone(49), tone(50), tone(79), tone(80)]).toEqual(['primary', 'bright', 'bright', 'error'])
  })

  test('no quota file: no power lines; no event yet: LAST --', () => {
    const r = standbyReadouts({ crewCost: 0, done: 0, active: 0, failed: 0 })
    expect(r.left.map(x => x.label)).toEqual(['CREW', 'UPTIME'])
    expect(r.left[1]?.value).toBe('--')
    expect(r.right[2]?.tone).toBe('frame')
    expect(r.right[3]?.value).toBe('--')
  })
})
