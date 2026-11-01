import type { DispatchRow, Verdict } from './ledger'

// Flag rules: which dispatches look like they went wrong, judged from ledger rows alone.

export type FlagKind =
  | 'verify-fail'
  | 'redispatch'
  | 'loop'
  | 'stuck'
  | 'error-end'
  | 'tool-errors'
  | 'tiny'
  | 'heavy'
  | 'corrected'

export const FLAG_RULES = {
  tinyMaxTools: 2,
  tinyExempt: ['verifier', 'clerk'],
  heavyTypes: ['Explore', 'clerk'],
  heavyTokens: 300_000,
  heavyMs: 600_000,
  toolErrorsMin: 3,
  toolErrorsRatio: 0.3,
  correctionMs: 900_000,
} as const

const VERDICT_LINE = /^\s*\**\s*VERDICT\s*\**\s*[:：]\s*\**\s*(PASS|FAIL|PARTIAL)/im
const ZH_LINE = /結論\**\s*[:：]?\s*\**\s*(.*)$/m
const EN_LINE = /conclusion\**\s*[:：]\s*\**\s*(pass|fail|partial)/im
const CORRECTION = /你不是說|不是叫你|不對|錯了|為什麼沒|為什麼又|又忘|you said|that's wrong|not what i|why didn't you|you forgot/i

/** Reads a verifier's verdict from its answer; the first matching pattern wins. */
export function parseVerdict(answer: string): Verdict | undefined {
  const line = VERDICT_LINE.exec(answer)
  if (line) return line[1]!.toLowerCase() as Verdict
  const zh = ZH_LINE.exec(answer)?.[1]
  if (zh) {
    if (zh.includes('不通過')) return 'fail'
    if (zh.includes('部分')) return 'partial'
    if (zh.includes('通過')) return 'pass'
  }
  const en = EN_LINE.exec(answer)
  if (en) return en[1]!.toLowerCase() as Verdict
  return undefined
}

export function isCorrection(text: string): boolean {
  return CORRECTION.test(text)
}

const includes = (list: readonly string[], v: string): boolean => list.includes(v)

/** Flags a single finished row earns by itself. Unfinished rows earn none. */
export function rowFlags(row: DispatchRow): FlagKind[] {
  if (row.doneAt === undefined) return []
  const out: FlagKind[] = []
  if (!row.backfill) {
    for (const h of row.health ?? []) out.push(h)
  }
  if (row.reason === 'refusal' || row.reason === 'error' || row.reason === 'aborted') out.push('error-end')
  if (row.toolErrors >= FLAG_RULES.toolErrorsMin && row.toolErrors / row.tools >= FLAG_RULES.toolErrorsRatio) out.push('tool-errors')
  if (row.tools <= FLAG_RULES.tinyMaxTools && !includes(FLAG_RULES.tinyExempt, row.type)) out.push('tiny')
  if (includes(FLAG_RULES.heavyTypes, row.type)) {
    const total = row.tokens.in + row.tokens.cw + row.tokens.out
    if (total > FLAG_RULES.heavyTokens || (row.durationMs ?? 0) > FLAG_RULES.heavyMs) out.push('heavy')
  }
  if (!row.backfill && row.corrected) out.push('corrected')
  return out
}

/** Row id to all its flags: its own plus the ones only other rows reveal. */
export function sessionFlags(rows: readonly DispatchRow[]): Map<string, FlagKind[]> {
  const out = new Map<string, FlagKind[]>()
  for (const r of rows) out.set(r.id, rowFlags(r))
  const add = (id: string, kind: FlagKind): void => {
    const list = out.get(id)
    if (list && !list.includes(kind)) list.push(kind)
  }
  for (const v of rows) {
    if (v.type !== 'verifier' || v.verdict !== 'fail') continue
    let target: DispatchRow | undefined
    for (const w of rows) {
      if (w.type !== 'worker' || w.session !== v.session || w.doneAt === undefined || w.doneAt > v.at) continue
      if (!target || w.doneAt > target.doneAt!) target = w
    }
    if (target) add(target.id, 'verify-fail')
  }
  for (const r of rows) if (r.redispatchOf) add(r.redispatchOf, 'redispatch')
  return out
}
