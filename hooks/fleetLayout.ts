export type FleetMode = 'wide' | 'mid' | 'narrow'
export type GaugeForm = 'big' | 'small' | 'bar'

// What the fleet page has to fit: its columns, its rows, how many quota windows it has,
// how many suits are busy (waiting or working) and how many idle.
export type FleetShape = { cols: number; room: number; windows: number; active: number; idle: number }

export type FleetStage = {
  gauge: GaugeForm | 'none'
  burnRows: number
  active: 'cards' | 'lines'
  idle: 'cards' | 'lines' | 'summary'
  blanks: boolean
}

// The stage that fits, its breakpoint and height; `cut` caps the legion's body in rows, not suits (its last
// one then says how many more) when even the last stage does not fit.
export type FleetPlan = FleetStage & { mode: FleetMode; height: number; cut?: number }

export const WIDE_MIN = 100
export const MID_MIN = 64
export const BURN_ROWS: Record<FleetMode, number> = { wide: 6, mid: 4, narrow: 3 }
export const WIDE_CARD_ROWS = 4
export const SMALL_CARD_ROWS = 3

export function modeOf(cols: number): FleetMode {
  return cols >= WIDE_MIN ? 'wide' : cols >= MID_MIN ? 'mid' : 'narrow'
}

export function idlePerRow(mode: FleetMode): number {
  return mode === 'wide' ? 3 : 2
}

const GAUGE_OF: Record<FleetMode, GaugeForm> = { wide: 'big', mid: 'small', narrow: 'bar' }

// A big ring 7 rows and its footnote, a small one 3, a bar one row per window.
export function gaugeRows(form: GaugeForm | 'none', windows: number): number {
  if (form === 'none' || windows <= 0) return 0
  return form === 'big' ? 8 : form === 'small' ? 3 : windows
}

export function legionRows(s: FleetShape, mode: FleetMode, st: FleetStage): number {
  if (s.active + s.idle === 0) return 1
  const active = st.active === 'cards' ? s.active * WIDE_CARD_ROWS : s.active
  const idle =
    s.idle === 0 ? 0 : st.idle === 'cards' ? Math.ceil(s.idle / idlePerRow(mode)) * SMALL_CARD_ROWS : st.idle === 'lines' ? s.idle : 1
  return active + idle
}

export function fleetHeight(s: FleetShape, mode: FleetMode, st: FleetStage): number {
  const g = gaugeRows(st.gauge, s.windows)
  const gauge = g > 0 ? 1 + g : 0
  const burn = st.burnRows > 0 ? st.burnRows + 3 : 0
  const legion = 1 + legionRows(s, mode, st)
  const sections = (gauge > 0 ? 1 : 0) + (burn > 0 ? 1 : 0) + 1
  return gauge + burn + legion + (st.blanks ? sections - 1 : 0)
}

// The stage that fit may have given up more than it had to: take back, while it still fits,
// the burn (its full rows, else two), then the idle suits' lines, then the blank rows.
function refill(s: FleetShape, mode: FleetMode, st: FleetStage, base: number): FleetStage {
  const fits = (x: FleetStage) => fleetHeight(s, mode, x) <= s.room
  let best = st
  const burn = [base, Math.min(2, base)].find(n => n > best.burnRows && fits({ ...best, burnRows: n }))
  if (burn !== undefined) best = { ...best, burnRows: burn }
  if (best.idle === 'summary' && fits({ ...best, idle: 'lines' })) best = { ...best, idle: 'lines' }
  if (!best.blanks && fits({ ...best, blanks: true })) best = { ...best, blanks: true }
  return best
}

export function planFleet(s: FleetShape): FleetPlan {
  const mode = modeOf(s.cols)
  const narrow = mode === 'narrow'
  const base = BURN_ROWS[mode]
  const s0: FleetStage = {
    gauge: s.windows > 0 ? GAUGE_OF[mode] : 'none',
    burnRows: base,
    active: narrow ? 'lines' : 'cards',
    idle: narrow ? 'lines' : 'cards',
    blanks: true,
  }
  const s1: FleetStage = { ...s0, idle: 'lines' }
  const s2: FleetStage = { ...s1, idle: 'summary' }
  const s3: FleetStage = { ...s2, blanks: false }
  const s4: FleetStage = { ...s3, burnRows: Math.min(2, base) }
  const s5: FleetStage = { ...s4, burnRows: 0 }
  const s6: FleetStage = { ...s5, active: 'lines' }
  const s7: FleetStage = { ...s6, gauge: s6.gauge === 'big' ? 'small' : s6.gauge }
  const s8: FleetStage = { ...s7, gauge: s7.gauge === 'none' ? 'none' : 'bar' }
  for (const st of [s0, s1, s2, s3, s4, s5, s6, s7, s8]) {
    if (fleetHeight(s, mode, st) > s.room) continue
    const best = refill(s, mode, st, base)
    return { ...best, mode, height: fleetHeight(s, mode, best) }
  }
  const full = fleetHeight(s, mode, s8)
  const body = legionRows(s, mode, s8)
  const cut = Math.max(1, body - (full - s.room))
  return { ...s8, mode, cut, height: full - body + cut }
}
