import { type FlagKind, sessionFlags } from './flags'
import { type MsgKey, t } from './i18n'
import { type DispatchRow, dayKey } from './ledger'

// Lessons: flag keys folded with the lesson event log into states, metrics and the texts Jarvis injects.

export type LessonEventKind = 'approve' | 'memory' | 'memory-error' | 'apply-cancel' | 'applied' | 'reject' | 'revert-request' | 'reverted'

export type LessonEvent = {
  key: string
  kind: LessonEventKind
  at: number
  session: string
  memoryId?: number
  file?: string
  error?: string
}

export type LessonState = 'watching' | 'candidate' | 'approved' | 'applied' | 'rejected' | 'reverted'

export type Measure = {
  verdict: 'helping' | 'not-helping' | 'unclear' | 'too-early'
  beforeRate: number
  afterRate: number
  beforeN: number
  afterN: number
}

export type Evidence = { at: number; project: string; desc: string; detail: string }

export type Lesson = {
  key: string
  kind: FlagKind
  type: string
  family: string
  state: LessonState
  strikes: number
  evidence: Evidence[]
  approvedIn?: string
  memoryId?: number
  memoryError?: string
  file?: string
  appliedAt?: number
  measure?: Measure
  revertRequested?: boolean
  /** This session injected the apply request and the turn ended without `applied`. */
  waiting?: boolean
  /** New strikes since a reject or revert that are not yet enough to reopen it; 0 otherwise. */
  muted: number
}

export const LESSON_DAYS = 30
export const REOPEN_STRIKES = 3
export const MEASURE_MIN = 8
export const INJECT_MAX = 3

const DAY_MS = 86_400_000
const WINDOW_MS = LESSON_DAYS * DAY_MS
const CANDIDATE_STRIKES = 2
const EVIDENCE_MAX = 3
const ANY_FAMILY = '*'
// the imperative word the rule must start with, kept out of the en dictionary (no CJK there)
const MUST = '一律'

const FLAG_KINDS: readonly string[] = ['verify-fail', 'redispatch', 'loop', 'stuck', 'error-end', 'tool-errors', 'tiny', 'heavy', 'corrected']
const EVENT_KINDS: readonly string[] = ['approve', 'memory', 'memory-error', 'apply-cancel', 'applied', 'reject', 'revert-request', 'reverted']

export function lessonKey(kind: FlagKind, row: DispatchRow): string {
  return `${kind}:${row.type}:${kind === 'corrected' ? ANY_FAMILY : row.family}`
}

type KeyParts = { kind: FlagKind; type: string; family: string }

// The type may itself hold a colon (`plugin:agent`), so kind is the first part and family the last.
// A kind that is not a flag kind (a hand edit) has no lesson text, so the key is not a lesson.
function keyParts(key: string): KeyParts | undefined {
  const first = key.indexOf(':')
  const last = key.lastIndexOf(':')
  if (first < 0 || last <= first || !FLAG_KINDS.includes(key.slice(0, first))) return undefined
  return { kind: key.slice(0, first) as FlagKind, type: key.slice(first + 1, last), family: key.slice(last + 1) }
}

const sameGroup = (p: KeyParts, r: DispatchRow): boolean => r.type === p.type && (p.family === ANY_FAMILY || r.family === p.family)

export function encodeEvents(events: readonly LessonEvent[]): string {
  return events.map(e => `${JSON.stringify(e)}\n`).join('')
}

/** Skips lines that are not JSON or lack a lesson `key`, a string `session`, a known `kind` and a numeric `at`. */
export function decodeEvents(text: string): LessonEvent[] {
  const out: LessonEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let e: unknown
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof e !== 'object' || e === null) continue
    const o = e as Partial<LessonEvent>
    if (typeof o.key !== 'string' || !keyParts(o.key) || typeof o.session !== 'string' || typeof o.at !== 'number') continue
    if (typeof o.kind !== 'string' || !EVENT_KINDS.includes(o.kind)) continue
    out.push(o as LessonEvent)
  }
  return out
}

// The numbers that tripped the rule, as ledger field names: the same in every locale.
function detailOf(r: DispatchRow): string {
  const tokens = r.tokens.in + r.tokens.cw + r.tokens.out
  const ms = r.durationMs ?? (r.doneAt ?? r.at) - r.at
  return `tools=${r.tools} toolErrors=${r.toolErrors} tokens=${tokens} ms=${ms}${r.reason ? ` reason=${r.reason}` : ''}`
}

export function foldLessons(rows: readonly DispatchRow[], events: readonly LessonEvent[], now: number): Lesson[] {
  const flags = sessionFlags(rows)
  // key to its flagged rows, oldest first
  const flagged = new Map<string, DispatchRow[]>()
  const addFlagged = (key: string, r: DispatchRow): void => {
    const list = flagged.get(key)
    if (list) list.push(r)
    else flagged.set(key, [r])
  }
  for (const r of rows) {
    for (const kind of flags.get(r.id) ?? []) addFlagged(lessonKey(kind, r), r)
  }
  for (const list of flagged.values()) list.sort((a, b) => a.at - b.at)

  const byKey = new Map<string, LessonEvent[]>()
  // a stable sort, so events at the same time keep file order
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const list = byKey.get(e.key)
    if (list) list.push(e)
    else byKey.set(e.key, [e])
  }

  const out: Lesson[] = []
  for (const key of new Set([...flagged.keys(), ...byKey.keys()])) {
    const parts = keyParts(key)
    if (!parts) continue
    const hits = flagged.get(key) ?? []
    const strikes = (since: number): number => {
      const from = Math.max(now - WINDOW_MS, since)
      return hits.filter(r => r.at >= from).length
    }

    let state: LessonState | undefined
    let cut = 0
    const l: Lesson = { key, ...parts, state: 'watching', strikes: 0, evidence: [], muted: 0 }
    for (const e of byKey.get(key) ?? []) {
      switch (e.kind) {
        case 'approve':
          state = 'approved'
          l.approvedIn = e.session
          delete l.memoryError
          break
        case 'memory':
          if (e.memoryId !== undefined) l.memoryId = e.memoryId
          break
        case 'memory-error':
          if (e.error !== undefined) l.memoryError = e.error
          break
        case 'apply-cancel':
          state = undefined
          break
        case 'applied':
          state = 'applied'
          l.appliedAt = e.at
          if (e.file !== undefined) l.file = e.file
          l.revertRequested = false
          break
        case 'reject':
          state = 'rejected'
          cut = e.at
          break
        case 'revert-request':
          l.revertRequested = true
          break
        case 'reverted':
          state = 'reverted'
          cut = e.at
          l.revertRequested = false
          break
      }
    }

    if (state === 'rejected' || state === 'reverted') {
      const fresh = strikes(cut)
      if (fresh >= REOPEN_STRIKES) state = undefined
      else l.muted = fresh
    }
    l.strikes = strikes(0)
    if (state === undefined) {
      if (l.strikes >= CANDIDATE_STRIKES) state = 'candidate'
      else if (l.strikes === 1) state = 'watching'
      else continue
    }
    l.state = state
    const from = now - WINDOW_MS
    l.evidence = hits
      .filter(r => r.at >= from)
      .slice(-EVIDENCE_MAX)
      .reverse()
      .map(r => ({ at: r.at, project: r.project, desc: r.desc, detail: detailOf(r) }))
    if (state === 'applied' && l.appliedAt !== undefined) l.measure = measureOf(rows, key, l.appliedAt)
    out.push(l)
  }
  return out.sort((a, b) => b.strikes - a.strikes || a.key.localeCompare(b.key))
}

/** Flag rate of the key's group in the 30 days before `appliedAt` against the rate since. */
export function measureOf(rows: readonly DispatchRow[], key: string, appliedAt: number): Measure {
  const parts = keyParts(key)
  const flags = sessionFlags(rows)
  let beforeN = 0
  let afterN = 0
  let beforeHit = 0
  let afterHit = 0
  if (parts) {
    for (const r of rows) {
      if (r.doneAt === undefined || !sameGroup(parts, r)) continue
      const hit = (flags.get(r.id) ?? []).includes(parts.kind)
      if (r.at >= appliedAt) {
        afterN++
        if (hit) afterHit++
      } else if (r.at >= appliedAt - WINDOW_MS) {
        beforeN++
        if (hit) beforeHit++
      }
    }
  }
  const beforeRate = beforeN ? beforeHit / beforeN : 0
  const afterRate = afterN ? afterHit / afterN : 0
  let verdict: Measure['verdict']
  if (afterN < MEASURE_MIN) verdict = 'too-early'
  else if (afterRate <= 0.5 * beforeRate) verdict = 'helping'
  else if (afterRate >= beforeRate) verdict = 'not-helping'
  else verdict = 'unclear'
  return { verdict, beforeRate, afterRate, beforeN, afterN }
}

export function lessonText(kind: FlagKind, type: string, family: string): string {
  return t(`lesson.text.${kind}` as MsgKey, { type, family })
}

export function lessonLine(l: Lesson): string {
  return t('lesson.line', { n: l.strikes, key: l.key, text: lessonText(l.kind, l.type, l.family) })
}

/** Candidate lines, most strikes first, leaving out keys already shown at their current count or more. */
export function injectLines(lessons: readonly Lesson[], shown: ReadonlyMap<string, number>): { lines: string[]; shown: Map<string, number> } {
  const next = new Map(shown)
  const picked = lessons
    .filter(l => l.state === 'candidate' && (shown.get(l.key) ?? -1) < l.strikes)
    .sort((a, b) => b.strikes - a.strikes || a.key.localeCompare(b.key))
    .slice(0, INJECT_MAX)
  for (const l of picked) next.set(l.key, l.strikes)
  return { lines: picked.map(lessonLine), shown: next }
}

const evidenceText = (l: Lesson): string => l.evidence.map(e => `${dayKey(e.at)} ${e.project}: ${e.desc} (${e.detail})`).join('; ')

const percent = (rate: number, n: number): string => `${Math.round(rate * 100)}% (n=${n})`

export function applyRequest(l: Lesson, file: string): string {
  return t('lesson.apply', {
    key: l.key,
    n: l.strikes,
    text: lessonText(l.kind, l.type, l.family),
    evidence: evidenceText(l),
    id: l.memoryId ?? '',
    file,
    must: MUST,
  })
}

export function revertRequest(l: Lesson): string {
  const m = l.measure
  return t('lesson.revert', {
    key: l.key,
    before: m ? percent(m.beforeRate, m.beforeN) : '',
    after: m ? percent(m.afterRate, m.afterN) : '',
    id: l.memoryId ?? '',
    file: l.file ?? '',
  })
}

const ROUTING_KINDS: readonly FlagKind[] = ['tiny', 'heavy', 'redispatch']

/** The rule file to suggest for a lesson (spec §4); `agentFiles` are the names in `~/dotfiles/claude/agents/`. */
export function suggestedFile(kind: FlagKind, type: string, home: string, agentFiles: readonly string[]): string {
  const routing = `${home}/dotfiles/claude/skills/model-routing/SKILL.md`
  const agents = `${home}/dotfiles/claude/agents`
  if (ROUTING_KINDS.includes(kind)) return routing
  if (kind === 'verify-fail') return `${agents}/worker.md`
  if (kind === 'corrected') return `${home}/dotfiles/agents/core.md`
  return agentFiles.includes(`${type}.md`) ? `${agents}/${type}.md` : routing
}

export function memoryArgv(home: string, l: Lesson): string[] {
  const text = `${lessonText(l.kind, l.type, l.family)} Evidence: ${l.evidence[0]?.desc ?? ''}`
  return [`${home}/.local/bin/memory-mcp`, 'store', '--json', '-t', 'feedback', '--tags', `jarvis-lesson,${l.kind}`, text]
}

/** The stored memory's id: the JSON `id` field, else the first number in the output. */
export function memoryIdOf(stdout: string): number | undefined {
  try {
    const o: unknown = JSON.parse(stdout)
    if (typeof o === 'object' && o !== null) {
      const id = (o as { id?: unknown }).id
      if (typeof id === 'number' && Number.isFinite(id)) return id
    }
  } catch {
    // not JSON: read the text
  }
  const m = /#?(\d+)/.exec(stdout)
  return m ? Number(m[1]) : undefined
}
