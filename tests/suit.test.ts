import { describe, expect, test } from 'claude-code/testing'

import { THEME } from '../hooks/jarvis'
import type { Cell } from '../hooks/fleetChart'
import { mix } from '../hooks/fleetChart'
import {
  CHARGE_MS,
  HOVER_MS,
  READOUT_MAX_W,
  REPULSOR_MS,
  SCAN_SIDE_MIN_COLS,
  STANDBY_MS,
  SUIT_ART,
  SUIT_BLOCK_ROWS,
  SUIT_CANVAS_COLS,
  SUIT_CANVAS_ROWS,
  SUIT_COLS,
  SUIT_ROWS,
  SUIT_TICK_MS,
  WAVE_MS,
  crewDeployed,
  fmtUptime,
  readoutMeterW,
  standbyReadouts,
  suitCells,
  suitFrame,
} from '../hooks/suit'
import type { Readout } from '../hooks/suit'

describe('suit', () => {
  test('the art is 14 rows of 24 cells', () => {
    expect(SUIT_ROWS).toBe(14)
    expect(SUIT_COLS).toBe(24)
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
    expect(r.left[3]?.value).toBe('7h32m')
    expect(r.right.map(x => x.value)).toEqual(['50 DOCKED', '0 ACTIVE', '4 FAIL', '2m00s'])
    expect(r.right.map(x => x.label)).toEqual(['CREW', '', '', 'LAST'])
    expect(r.right[2]?.tone).toBe('error')
  })

  test('uptime as the statusline writes it: seconds, minutes, hours and minutes, days and hours', () => {
    expect(fmtUptime(45_000)).toBe('45s')
    expect(fmtUptime(59_999)).toBe('59s')
    expect(fmtUptime(60_000)).toBe('1m')
    expect(fmtUptime(12 * 60_000 + 30_000)).toBe('12m')
    expect(fmtUptime(3600_000 - 1)).toBe('59m')
    expect(fmtUptime(3600_000)).toBe('1h0m')
    expect(fmtUptime(7 * 3600_000 + 32 * 60_000 + 59_000)).toBe('7h32m')
    expect(fmtUptime(24 * 3600_000 - 1)).toBe('23h59m')
    expect(fmtUptime(27 * 3600_000 + 59 * 60_000)).toBe('1d3h')
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

describe('suit frames', () => {
  const T = SUIT_TICK_MS
  const idle = (tick: number, over: Partial<{ busy: boolean; deployedAt: number; now: number }> = {}) =>
    suitFrame(tick, { busy: false, now: 0, ...over })
  // the pixel at canvas row `y`, column `x`: a cell's top half, or its bottom
  const px = (cells: Cell[][], y: number, x: number): string | undefined => {
    const c = cells[Math.floor(y / 2)]?.[x]
    if (c === undefined || c.ch === ' ') return undefined
    if (y % 2 === 0) return c.ch === '▀' ? c.fg : undefined
    return c.ch === '▄' ? c.fg : c.bg
  }
  // canvas pixels of the art: column + 4, row + 1
  const at = (cells: Cell[][], r: number, c: number) => px(cells, r + 1, c + 4)
  const rgb = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
  // a theme color, or one on the line between two
  const onTheme = (c: string): boolean => {
    const theme = Object.values(THEME) as string[]
    const z = rgb(c)
    return theme.some(a =>
      theme.some(b => {
        const x = rgb(a)
        const y = rgb(b)
        const spans = x.map((v, i) => Math.abs((y[i] ?? v) - v))
        const k = spans.indexOf(Math.max(...spans))
        if ((spans[k] ?? 0) === 0) return z.every((v, i) => Math.abs(v - (x[i] ?? 0)) <= 1)
        const t = ((z[k] ?? 0) - (x[k] ?? 0)) / ((y[k] ?? 0) - (x[k] ?? 0))
        if (t < -0.01 || t > 1.01) return false
        return z.every((v, i) => Math.abs(v - ((x[i] ?? 0) + ((y[i] ?? 0) - (x[i] ?? 0)) * t)) <= 2)
      }),
    )
  }
  const CYCLE = (STANDBY_MS + WAVE_MS + HOVER_MS + REPULSOR_MS + CHARGE_MS) / T

  test('a 32 by 32 pixel canvas, 16 rows of 32 half-block cells', () => {
    expect([SUIT_CANVAS_COLS, SUIT_CANVAS_ROWS, SUIT_BLOCK_ROWS]).toEqual([32, 16, 19])
    for (let f = 0; f < CYCLE; f += 1) {
      const { cells } = idle(f)
      expect(cells).toHaveLength(16)
      for (const row of cells) {
        expect(row).toHaveLength(32)
        for (const c of row) expect(['▀', '▄', ' ']).toContain(c.ch)
      }
    }
  })

  test('the poses in turn: standby 6 s, wave 3 s, hover 4 s, repulsor 3 s, charge 2 s, round again', () => {
    expect([STANDBY_MS, WAVE_MS, HOVER_MS, REPULSOR_MS, CHARGE_MS, SUIT_TICK_MS]).toEqual([6000, 3000, 4000, 3000, 2000, 250])
    const pose = (f: number) => idle(f).pose
    expect([pose(0), pose(23), pose(24), pose(35), pose(36), pose(51), pose(52), pose(63), pose(64), pose(71)]).toEqual([
      'STANDBY', 'STANDBY', 'WAVE', 'WAVE', 'HOVER', 'HOVER', 'REPULSOR', 'REPULSOR', 'CHARGE', 'CHARGE',
    ])
    expect(pose(72)).toBe('STANDBY')
    expect(pose(72 + 24)).toBe('WAVE')
  })

  test('the same tick draws the same frame', () => {
    for (const f of [0, 11, 30, 40, 60, 71]) expect(idle(f)).toEqual(idle(f))
  })

  test('the scan line: one pixel row a frame, lit 35% toward bright, round the canvas', () => {
    // the helmet's top-left pixel, art row 0 column 6: canvas row 1
    expect(at(idle(1).cells, 0, 6)).toBe(mix(THEME.suitRed, THEME.bright, 0.35))
    expect(at(idle(2).cells, 0, 6)).toBe(THEME.suitRed)
    // the next frame lights the next row: art row 1, column 4
    expect(at(idle(2).cells, 1, 4)).toBe(mix(THEME.suitRed, THEME.bright, 0.35))
    expect(at(idle(1).cells, 1, 4)).toBe(THEME.suitRed)
    // round the 32 rows, in any pose: tick 33 is the wave, scanning row 1 again
    expect(at(idle(33).cells, 0, 6)).toBe(mix(THEME.suitRed, THEME.bright, 0.35))
  })

  test('standby: the arc reactor breathes accent to bright every 2 s, every 1 s while the main loop has a call out', () => {
    // the reactor's first pixel: art row 18, column 10
    const reactor = (f: number, busy: boolean) => at(idle(f, { busy }).cells, 18, 10)
    expect(reactor(0, false)).toBe(THEME.accent)
    expect(reactor(4, false)).toBe(THEME.bright)
    expect(reactor(2, false)).toBe(mix(THEME.accent, THEME.bright, 0.5))
    expect(reactor(8, false)).toBe(THEME.accent)
    expect(reactor(2, true)).toBe(THEME.bright)
    expect(reactor(4, true)).toBe(THEME.accent)
    expect(reactor(6, true)).toBe(THEME.bright)
  })

  test('standby: a blink every 3 s, one frame, the eyes gold', () => {
    // an eye pixel (art row 8, column 5) and its glint (column 8)
    const eye = (f: number) => [at(idle(f).cells, 8, 5), at(idle(f).cells, 8, 8)]
    expect(eye(10)).toEqual([THEME.accent, THEME.bright])
    expect(eye(11)).toEqual([THEME.suitGold, THEME.suitGold])
    expect(eye(12)).toEqual([THEME.accent, THEME.bright])
    expect(eye(23)).toEqual([THEME.suitGold, THEME.suitGold])
  })

  test('wave: the right arm raised by the head, two frames in turn', () => {
    const hand = (f: number) => [at(idle(f).cells, 9, 23), at(idle(f).cells, 9, 26)]
    expect(hand(24)).toEqual([THEME.accent, undefined])
    expect(hand(26)).toEqual([undefined, THEME.accent])
    expect(hand(28)).toEqual([THEME.accent, undefined])
    // the arm left its side
    expect(at(idle(24).cells, 21, 20)).toBeUndefined()
  })

  test('hover: up a pixel every 2 frames, three rows of flame under each foot in turn', () => {
    // the helmet's top row: canvas row 1 at rest, row 0 lifted
    expect(px(idle(36).cells, 0, 10)).toBeUndefined()
    expect(px(idle(38).cells, 0, 10)).toBe(THEME.suitRed)
    expect(px(idle(40).cells, 0, 10)).toBeUndefined()
    // the flame under the left foot (column 8): art rows 27, 28, 29
    const flame = (f: number) => [27, 28, 29].map(r => at(idle(f).cells, r, 8))
    expect(flame(36)).toEqual([THEME.bright, THEME.accent, THEME.suitGold])
    expect(flame(37)).toEqual([THEME.accent, THEME.suitGold, THEME.bright])
    // the right foot's (column 15) the same
    expect(at(idle(36).cells, 27, 15)).toBe(THEME.bright)
    // three pixels wide on odd frames in the middle row, one on even
    expect([at(idle(36).cells, 28, 7), at(idle(37).cells, 28, 7)]).toEqual([undefined, THEME.suitGold])
  })

  test('repulsor: the right arm out, the beam in steps to the canvas edge and no further, bright on the last frame', () => {
    const beam = (f: number) => [28, 29, 30, 31].map(x => px(idle(f).cells, 18 + 1, x))
    expect(beam(52)).toEqual([THEME.bright, undefined, undefined, undefined])
    expect(beam(55)).toEqual([THEME.bright, THEME.bright, undefined, undefined])
    expect(beam(58)).toEqual([THEME.bright, THEME.bright, THEME.bright, THEME.bright])
    // its edges accent until the last frame
    expect(px(idle(62).cells, 17 + 1, 31)).toBe(THEME.accent)
    expect(px(idle(63).cells, 17 + 1, 31)).toBe(THEME.bright)
    expect(px(idle(63).cells, 20 + 1, 31)).toBe(THEME.bright)
    // the palm bright at the arm's end
    expect(at(idle(60).cells, 18, 23)).toBe(THEME.bright)
    for (let f = 52; f < 64; f += 1) for (const row of idle(f).cells) expect(row).toHaveLength(SUIT_CANVAS_COLS)
  })

  test('charge: hands at the sides, the palms accent to bright in 4 frames with a pixel of glow, the reactor bright, the last frame lit 25%', () => {
    // the left palm (art row 21, column 3) and the glow beside it (column 2)
    const palm = (f: number) => at(idle(f).cells, 21, 3)
    expect([palm(64), palm(65), palm(66), palm(67), palm(70)]).toEqual([
      THEME.accent,
      mix(THEME.accent, THEME.bright, 1 / 3),
      mix(THEME.accent, THEME.bright, 2 / 3),
      THEME.bright,
      THEME.bright,
    ])
    expect(at(idle(66).cells, 21, 2)).toBeUndefined()
    expect(at(idle(67).cells, 21, 2)).toBe(THEME.accent)
    expect(at(idle(67).cells, 22, 20)).toBe(THEME.accent)
    // the right hand down at its side, as at rest
    expect(at(idle(64).cells, 21, 20)).toBe(THEME.accent)
    expect(at(idle(64).cells, 18, 10)).toBe(THEME.bright)
    // the whole suit 25% toward bright on the last frame only
    expect(at(idle(70).cells, 0, 6)).toBe(THEME.suitRed)
    expect(at(idle(71).cells, 0, 6)).toBe(mix(THEME.suitRed, THEME.bright, 0.25))
    expect(at(idle(71).cells, 4, 8)).toBe(mix(THEME.suitGold, THEME.bright, 0.25))
  })

  test('a crew member deployed: eyes and palms bright 2 frames, the line under the suit for 2 s', () => {
    const eyeAndPalm = (now: number) => [at(idle(0, { deployedAt: 1000, now }).cells, 8, 5), at(idle(0, { deployedAt: 1000, now }).cells, 21, 3)]
    expect(eyeAndPalm(1000)).toEqual([THEME.bright, THEME.bright])
    expect(eyeAndPalm(1000 + 2 * T - 1)).toEqual([THEME.bright, THEME.bright])
    expect(eyeAndPalm(1000 + 2 * T)).toEqual([THEME.accent, THEME.accent])
    expect(eyeAndPalm(999)).toEqual([THEME.accent, THEME.accent])
    expect(crewDeployed(1000, 1000)).toBe(true)
    expect(crewDeployed(2999, 1000)).toBe(true)
    expect(crewDeployed(3000, 1000)).toBe(false)
    expect(crewDeployed(999, 1000)).toBe(false)
    expect(crewDeployed(1000, undefined)).toBe(false)
  })

  test('every color a theme color or a blend of two', () => {
    for (const busy of [false, true]) {
      for (let f = 0; f < CYCLE; f += 1) {
        for (const c of idle(f, { busy, deployedAt: 0, now: (f % 3) * T }).cells.flat()) {
          if (c.fg !== undefined) expect([c.fg, onTheme(c.fg)]).toEqual([c.fg, true])
          if (c.bg !== undefined) expect([c.bg, onTheme(c.bg)]).toEqual([c.bg, true])
        }
      }
    }
    expect(onTheme('#123456')).toBe(false)
  })
})

describe('readout meter', () => {
  const power: Readout = { label: 'POWER 5H', value: '100%', tone: 'error', meter: { pct: 1 } }
  test('the meter gives way cell by cell, the number never', () => {
    expect(readoutMeterW(power, 19)).toBe(5)
    expect(readoutMeterW(power, 40)).toBe(5)
    expect(readoutMeterW(power, 18)).toBe(4)
    expect(readoutMeterW(power, 15)).toBe(1)
    expect(readoutMeterW(power, 14)).toBe(0)
    expect(readoutMeterW({ label: 'CREW', value: '$1.00', tone: 'primary' }, 40)).toBe(0)
    expect(READOUT_MAX_W).toBe(19)
    expect(SCAN_SIDE_MIN_COLS).toBe(SUIT_CANVAS_COLS + 4 + 2 * READOUT_MAX_W)
  })
})
