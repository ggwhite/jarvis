import { type Family, nameFamilyOf } from './jarvis'

// Dispatch ledger: one row per subagent dispatch, stored as JSON lines per day and session.

export type RowFamily = Family | 'other'
export type Verdict = 'pass' | 'fail' | 'partial'

export type DispatchRow = {
  v: 1
  id: string
  session: string
  project: string
  at: number
  type: string
  model: string
  family: RowFamily
  background: boolean
  desc: string
  promptLen: number
  doneAt?: number
  durationMs?: number
  reason?: 'answer' | 'aborted' | 'refusal' | 'error'
  tokens: { in: number; out: number; cr: number; cw: number }
  cost?: number
  tools: number
  toolErrors: number
  health?: ('loop' | 'stuck')[]
  verdict?: Verdict
  subtask?: string
  redispatchOf?: string
  corrected?: boolean
  backfill?: true
}

export const DESC_LEN = 120
export const RETAIN_DAYS = 60
export const HEALTH_DAYS = 14

const DAY_MS = 86_400_000
const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/

export function rowFamily(model: string): RowFamily {
  return nameFamilyOf(model) ?? 'other'
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local calendar day, `YYYY-MM-DD`. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const ledgerDir = (home: string): string => `${home}/.claude/jarvis/ledger`
export const ledgerFile = (home: string, day: string, session: string): string => `${ledgerDir(home)}/${day}/${session}.jsonl`
export const lessonsFile = (home: string, session: string): string => `${home}/.claude/jarvis/lessons/${session}.jsonl`

export function encodeRows(rows: readonly DispatchRow[]): string {
  return rows.map(r => `${JSON.stringify(r)}\n`).join('')
}

/** Skips lines that are not JSON or lack `v === 1`, `id` and `at` (a crash mid-write, a hand edit). */
export function decodeRows(text: string): DispatchRow[] {
  const out: DispatchRow[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let r: unknown
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof r !== 'object' || r === null) continue
    const o = r as Partial<DispatchRow>
    if (o.v !== 1 || typeof o.id !== 'string' || typeof o.at !== 'number') continue
    out.push(o as DispatchRow)
  }
  return out
}

/** One row per id: a live row beats a backfill row; between equals the later `doneAt` wins. */
export function dedupe(rows: readonly DispatchRow[]): DispatchRow[] {
  const byId = new Map<string, DispatchRow>()
  for (const r of rows) {
    const cur = byId.get(r.id)
    if (!cur) {
      byId.set(r.id, r)
      continue
    }
    if (cur.backfill && !r.backfill) byId.set(r.id, r)
    else if (!cur.backfill && r.backfill) continue
    else if ((r.doneAt ?? 0) > (cur.doneAt ?? 0)) byId.set(r.id, r)
  }
  return [...byId.values()]
}

/** Groups by the day a row was spawned, so a row finished after midnight is still written once. */
export function rowsByDay(rows: readonly DispatchRow[]): Map<string, DispatchRow[]> {
  const out = new Map<string, DispatchRow[]>()
  for (const r of rows) {
    const k = dayKey(r.at)
    const list = out.get(k)
    if (list) list.push(r)
    else out.set(k, [r])
  }
  return out
}

/** Day folders older than RETAIN_DAYS; names that are not a plain date are never returned. */
export function expiredDays(days: readonly string[], now: number): string[] {
  const d = new Date(now)
  const cutoff = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - RETAIN_DAYS).getTime())
  return days.filter(n => DAY_NAME.test(n) && n < cutoff)
}

export type HealthRow = {
  type: string
  family: RowFamily
  runs: number
  medianMs: number
  p90Ms: number
  meanTokens: number
  flagRate: number
  topFlag?: string
}

export function dispatchHealth(
  rows: readonly DispatchRow[],
  flagsOf: (r: DispatchRow) => readonly string[],
  now: number,
): HealthRow[] {
  const since = now - HEALTH_DAYS * DAY_MS
  const groups = new Map<string, DispatchRow[]>()
  for (const r of rows) {
    if (r.doneAt === undefined || r.at < since) continue
    const k = `${r.type}\u0000${r.family}`
    const list = groups.get(k)
    if (list) list.push(r)
    else groups.set(k, [r])
  }
  const out: HealthRow[] = []
  for (const list of groups.values()) {
    const first = list[0]!
    const ms = list.map(r => r.durationMs ?? (r.doneAt ?? r.at) - r.at).sort((a, b) => a - b)
    const n = ms.length
    const tokens = list.reduce((s, r) => s + r.tokens.in + r.tokens.cw + r.tokens.out, 0)
    const counts = new Map<string, number>()
    let flagged = 0
    for (const r of list) {
      const flags = flagsOf(r)
      if (flags.length) flagged++
      for (const f of flags) counts.set(f, (counts.get(f) ?? 0) + 1)
    }
    let topFlag: string | undefined
    let best = 0
    for (const [f, c] of counts) {
      if (c > best) {
        best = c
        topFlag = f
      }
    }
    const h: HealthRow = {
      type: first.type,
      family: first.family,
      runs: n,
      medianMs: ms[Math.floor((n - 1) / 2)]!,
      p90Ms: ms[Math.ceil(0.9 * n) - 1]!,
      meanTokens: tokens / n,
      flagRate: flagged / n,
    }
    if (topFlag !== undefined) h.topFlag = topFlag
    out.push(h)
  }
  return out.sort((a, b) => b.runs - a.runs || a.type.localeCompare(b.type))
}
