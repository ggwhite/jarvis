import { describe, expect, test } from 'claude-code/testing'

import { type DispatchRow } from '../hooks/ledger'
import { isCorrection, parseVerdict, rowFlags, sessionFlags } from '../hooks/flags'

const row = (over: Partial<DispatchRow> = {}): DispatchRow => ({
  v: 1,
  id: 'a1',
  session: 's1',
  project: 'p',
  at: 1_000,
  type: 'Explore',
  model: 'claude-haiku-5-5',
  family: 'haiku',
  background: false,
  desc: 'find x',
  promptLen: 10,
  doneAt: 2_000,
  durationMs: 1_000,
  reason: 'answer',
  tokens: { in: 1, out: 2, cr: 3, cw: 4 },
  tools: 5,
  toolErrors: 0,
  ...over,
})

describe('parseVerdict', () => {
  test('parseVerdict reads the VERDICT line', () => {
    expect(parseVerdict('done\nVERDICT: FAIL')).toBe('fail')
    expect(parseVerdict('**VERDICT:** pass')).toBe('pass')
  })

  test('parseVerdict falls back to the 結論 line', () => {
    expect(parseVerdict('- **結論**：不通過')).toBe('fail')
    expect(parseVerdict('結論：部分未驗證')).toBe('partial')
    expect(parseVerdict('結論：通過')).toBe('pass')
    expect(parseVerdict('Conclusion: fail')).toBe('fail')
    expect(parseVerdict('all good')).toBeUndefined()
  })
})

describe('isCorrection', () => {
  test('matches corrections and not near-misses', () => {
    expect(isCorrection('你不是說要先測試？')).toBe(true)
    expect(isCorrection("That's wrong")).toBe(true)
    expect(isCorrection('ok, go ahead')).toBe(false)
    expect(isCorrection('不錯')).toBe(false)
  })
})

describe('rowFlags', () => {
  test('tiny', () => {
    expect(rowFlags(row({ tools: 2 }))).toEqual(['tiny'])
    expect(rowFlags(row({ type: 'verifier', tools: 1 }))).toEqual([])
    expect(rowFlags(row({ tools: 3 }))).toEqual([])
  })

  test('heavy', () => {
    expect(rowFlags(row({ tokens: { in: 100_000, cw: 100_000, out: 100_001, cr: 9_000_000 } }))).toEqual(['heavy'])
    expect(rowFlags(row({ type: 'worker', tokens: { in: 1_000_000, cw: 0, out: 0, cr: 0 } }))).toEqual([])
    expect(rowFlags(row({ type: 'clerk', durationMs: 11 * 60_000 }))).toEqual(['heavy'])
  })

  test('tool-errors', () => {
    expect(rowFlags(row({ tools: 10, toolErrors: 3 }))).toEqual(['tool-errors'])
    expect(rowFlags(row({ tools: 11, toolErrors: 3 }))).toEqual([])
    expect(rowFlags(row({ tools: 2, toolErrors: 2 }))).toEqual(['tiny'])
  })

  test('error-end', () => {
    expect(rowFlags(row({ reason: 'refusal' }))).toEqual(['error-end'])
    expect(rowFlags(row({ reason: 'answer' }))).toEqual([])
    expect(rowFlags(row({ reason: 'aborted' }))).toEqual(['error-end'])
    expect(rowFlags(row({ reason: 'aborted', backfill: true }))).toEqual(['error-end'])
  })

  test('health and corrected come from the row', () => {
    expect(rowFlags(row({ health: ['loop', 'stuck'], corrected: true }))).toEqual(['loop', 'stuck', 'corrected'])
  })

  test('unfinished rows get no flags', () => {
    expect(rowFlags(row({ doneAt: undefined, tools: 0, health: ['loop'] }))).toEqual([])
  })

  test('backfilled rows trip only four kinds', () => {
    expect(rowFlags(row({ backfill: true, corrected: true, health: ['loop'] }))).toEqual([])
    expect(rowFlags(row({ backfill: true, tools: 1, reason: 'error' }))).toEqual(['error-end', 'tiny'])
  })
})

describe('sessionFlags', () => {
  const worker = (id: string, doneAt: number, session = 's1'): DispatchRow =>
    row({ id, type: 'worker', session, at: doneAt - 5, doneAt })

  test('verify-fail lands on the latest earlier worker', () => {
    const rows = [
      worker('A', 10),
      worker('B', 20),
      worker('C', 30),
      row({ id: 'V', type: 'verifier', at: 25, doneAt: 40, verdict: 'fail' }),
    ]
    const flags = sessionFlags(rows)
    expect(flags.get('B')).toEqual(['verify-fail'])
    expect(flags.get('A')).toEqual([])
    expect(flags.get('C')).toEqual([])
  })

  test('verify-fail ignores other sessions and non-fail verdicts', () => {
    const rows = [
      worker('A', 10, 's2'),
      worker('B', 12),
      row({ id: 'V', type: 'verifier', at: 25, doneAt: 40, verdict: 'pass' }),
      row({ id: 'W', type: 'verifier', at: 25, doneAt: 40, verdict: 'fail' }),
    ]
    const flags = sessionFlags(rows)
    expect(flags.get('A')).toEqual([])
    expect(flags.get('B')).toEqual(['verify-fail'])
  })

  test('redispatch flags the previous row', () => {
    const rows = [worker('A', 10), row({ id: 'B', type: 'worker', at: 20, doneAt: 30, redispatchOf: 'A' })]
    const flags = sessionFlags(rows)
    expect(flags.get('A')).toEqual(['redispatch'])
    expect(flags.get('B')).toEqual([])
  })
})
