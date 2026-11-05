import type { Seg } from './cockpit'
import { t } from './i18n'
import { THEME, cellWidth, fitCells, fmtDate, fmtK, fmtMs, padCells } from './jarvis'
import type { HealthRow } from './ledger'
import type { Lesson, Measure } from './lessons'

// The Lessons tab's lines: dispatch health over the last 14 days, then the lessons by state,
// each press a `[Label]` the cockpit draws as a Button.

// `session`: this session's id, to tell an approval left by another session from one left by this one
export type LessonsView = { health: HealthRow[]; lessons: Lesson[]; ledgerPath: string; session: string }

export type LessonOp = 'approve' | 'reject' | 'cancel' | 'retry' | 'retryHere' | 'revert'

export type LessonAct = { op: LessonOp; key: string; label: string }

// A line and the presses drawn after it; the line is cut so they always fit.
export type LessonRow = { segs: Seg[]; acts: LessonAct[] }

// A health row whose flag rate is at least this is drawn in the error color.
export const HEALTH_WARN = 0.2
// Below this many pane columns the p90 and mean-token columns are left out.
export const NARROW_COLS = 64
// The card's border and padding.
const CARD_PAD = 4
// The least a health row's type keeps.
const TYPE_MIN = 6
const EVIDENCE_INDENT = 4

type Col = 'family' | 'runs' | 'median' | 'p90' | 'tokens' | 'flagRate' | 'topFlag'
const COL_W: Record<Col, number> = { family: 6, runs: 4, median: 6, p90: 6, tokens: 6, flagRate: 5, topFlag: 11 }
const RIGHT: ReadonlySet<Col> = new Set(['runs', 'median', 'p90', 'tokens', 'flagRate'])
const WIDE_COLS: readonly Col[] = ['family', 'runs', 'median', 'p90', 'tokens', 'flagRate', 'topFlag']
const NARROW: readonly Col[] = ['family', 'runs', 'median', 'flagRate', 'topFlag']

const VERDICT_COLOR: Record<Measure['verdict'], string> = {
  helping: THEME.success,
  'not-helping': THEME.error,
  unclear: THEME.accent,
  'too-early': THEME.frame,
}

const sp = (n: number): Seg => ({ t: ' '.repeat(Math.max(0, n)) })
const pct = (rate: number): string => `${Math.round(rate * 100)}%`

// `segs` cut to `width` cells, the one that overruns ending in an ellipsis
function fit(segs: readonly Seg[], width: number): Seg[] {
  const out: Seg[] = []
  let left = width
  for (const s of segs) {
    if (left <= 0) break
    const w = cellWidth(s.t)
    if (w <= left) {
      out.push(s)
      left -= w
    } else {
      out.push({ ...s, t: fitCells(s.t, left) })
      break
    }
  }
  return out
}

export const actSeg = (a: LessonAct): Seg => ({ t: `[${a.label}]`, color: THEME.accent, bold: true })

// the presses' cells: a space before each
const actsWidth = (acts: readonly LessonAct[]): number => acts.reduce((n, a) => n + 1 + cellWidth(actSeg(a).t), 0)

const act = (op: LessonOp, key: string): LessonAct => ({ op, key, label: t(`lessons.${op}`) })

const heading = (text: string): Seg[] => [{ t: text, color: THEME.accent, bold: true }]

function healthRows(health: readonly HealthRow[], cols: number, inner: number): Seg[][] {
  const shown = cols < NARROW_COLS ? NARROW : WIDE_COLS
  const typeW = Math.max(TYPE_MIN, inner - shown.reduce((n, c) => n + 1 + COL_W[c], 0))
  const cell = (c: Col, text: string, color: string): Seg[] => [sp(1), { t: padCells(text, COL_W[c], RIGHT.has(c) ? 'right' : 'left'), color }]
  const head: Seg[] = [
    { t: padCells(t('lessons.col.type'), typeW), color: THEME.frame },
    ...shown.flatMap(c => cell(c, t(`lessons.col.${c}`), THEME.frame)),
  ]
  const rows = health.map(h => {
    const hot = h.flagRate >= HEALTH_WARN
    const value: Record<Col, string> = {
      family: h.family,
      runs: String(h.runs),
      median: fmtMs(h.medianMs),
      p90: fmtMs(h.p90Ms),
      tokens: fmtK(Math.round(h.meanTokens)),
      flagRate: pct(h.flagRate),
      topFlag: h.topFlag ?? '',
    }
    const color = (c: Col): string => (c === 'flagRate' || c === 'topFlag' ? (hot ? THEME.error : THEME.frame) : c === 'family' ? THEME.frame : THEME.primary)
    return [{ t: padCells(h.type, typeW), color: THEME.primary }, ...shown.flatMap(c => cell(c, value[c], color(c)))]
  })
  return [head, ...rows]
}

function candidateRows(l: Lesson): LessonRow[] {
  const head: LessonRow = {
    segs: [{ t: l.key, color: THEME.primary, bold: true }, sp(2), { t: t('lessons.strikes', { n: l.strikes }), color: THEME.accent }],
    acts: [act('approve', l.key), act('reject', l.key)],
  }
  const evidence = l.evidence.map(e => ({
    segs: [sp(EVIDENCE_INDENT), { t: [fmtDate(e.at), e.project, e.desc, e.detail].filter(Boolean).join(' · '), color: THEME.frame }],
    acts: [],
  }))
  return [head, ...evidence]
}

// An approval's request lives only in the session that queued it; one this session does not hold
// (its session ended first, or another session's) can be asked for again here, or cancelled.
function approvedRow(l: Lesson, session: string): LessonRow {
  const key: Seg = { t: l.key, color: THEME.primary, bold: true }
  const id = l.memoryId ?? ''
  if (l.waiting === true) return { segs: [key, sp(2), { t: t('lessons.waiting', { id }), color: THEME.accent }], acts: [act('retry', l.key), act('cancel', l.key)] }
  if (l.requestedHere === true) return { segs: [key, sp(2), { t: t('lessons.requested', { id }), color: THEME.frame }], acts: [] }
  if (l.memoryError !== undefined)
    return { segs: [key, sp(2), { t: t('lessons.memoryError', { error: l.memoryError }), color: THEME.error }], acts: [act('retry', l.key)] }
  const left = t(l.approvedIn === session ? 'lessons.notRequested' : 'lessons.otherSession')
  return { segs: [key, sp(2), { t: left, color: THEME.frame }], acts: [act('retryHere', l.key), act('cancel', l.key)] }
}

function appliedRow(l: Lesson): LessonRow {
  const m = l.measure
  const verdict = m?.verdict ?? 'too-early'
  const figures: Seg[] = m
    ? [{ t: t('lessons.measure', { before: pct(m.beforeRate), after: pct(m.afterRate), n: m.afterN }), color: THEME.primary }, sp(2)]
    : []
  const tail: Seg = l.revertRequested ? { t: t('lessons.revertRequested'), color: THEME.frame } : { t: t(`lessons.verdict.${verdict}`), color: VERDICT_COLOR[verdict] }
  return {
    segs: [{ t: l.key, color: THEME.primary, bold: true }, sp(2), ...figures, tail],
    // a revert request this session does not hold can be asked for again
    acts: (verdict === 'not-helping' && !l.revertRequested) || (l.revertRequested === true && l.requestedHere !== true) ? [act('revert', l.key)] : [],
  }
}

/** The tab's lines for a pane `cols` wide, each with the presses drawn after it. */
export function lessonRows(v: LessonsView, cols: number): LessonRow[] {
  const inner = Math.max(1, cols - CARD_PAD)
  const plain = (segs: Seg[]): LessonRow => ({ segs, acts: [] })
  if (v.health.length === 0 && v.lessons.length === 0) {
    return [plain([{ t: t('lessons.empty'), color: THEME.primary }]), plain([{ t: t('lessons.ledger', { path: v.ledgerPath }), color: THEME.frame }])]
  }
  const out: LessonRow[] = [plain(heading(t('lessons.health')))]
  if (v.health.length === 0) out.push(plain([{ t: t('lessons.empty'), color: THEME.frame }]))
  else out.push(...healthRows(v.health, cols, inner).map(plain))
  out.push(plain([sp(1)]), plain(heading(t('lessons.list'))))

  const of = (state: Lesson['state']) => v.lessons.filter(l => l.state === state)
  const candidates = [...of('candidate')].sort((a, b) => b.strikes - a.strikes)
  const listed: LessonRow[] = [
    ...candidates.flatMap(candidateRows),
    ...of('approved').map(l => approvedRow(l, v.session)),
    ...of('applied').map(appliedRow),
    ...of('watching').map(l => plain([{ t: `${l.key}  ${t('lessons.strikes', { n: l.strikes })}`, color: THEME.frame }])),
  ]
  if (listed.length === 0) listed.push(plain([{ t: t('lessons.none'), color: THEME.frame }]))
  const hidden = of('rejected').length + of('reverted').length
  if (hidden > 0) listed.push(plain([{ t: t('lessons.hidden', { n: hidden }), color: THEME.frame }]))
  out.push(...listed)

  // each line fits its card with its presses after it
  return out.map(r => ({ segs: fit(r.segs, Math.max(0, inner - actsWidth(r.acts))), acts: r.acts }))
}

/** The tab's lines as plain segments, each press its `[Label]`. */
export function lessonsLines(v: LessonsView, cols: number): Seg[][] {
  return lessonRows(v, cols).map(r => [...r.segs, ...r.acts.flatMap(a => [sp(1), actSeg(a)])])
}
