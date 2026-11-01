import { describe, expect, test } from 'claude-code/testing'

import {
  type DispatchRow,
  HEALTH_DAYS,
  RETAIN_DAYS,
  dayKey,
  decodeRows,
  dedupe,
  dispatchHealth,
  encodeRows,
  expiredDays,
  ledgerDir,
  ledgerFile,
  lessonsFile,
  rowFamily,
  rowsByDay,
} from '../hooks/ledger'

const row = (over: Partial<DispatchRow> = {}): DispatchRow => ({
  v: 1,
  id: 'a1',
  session: 's1',
  project: 'p',
  at: new Date(2026, 10, 2, 10, 0).getTime(),
  type: 'Explore',
  model: 'claude-haiku-5-5',
  family: 'haiku',
  background: false,
  desc: 'find x',
  promptLen: 10,
  tokens: { in: 1, out: 2, cr: 3, cw: 4 },
  tools: 1,
  toolErrors: 0,
  ...over,
})

describe('ledger rows', () => {
  test('rowFamily maps ids and aliases', () => {
    expect(rowFamily('claude-opus-5-5')).toBe('opus')
    expect(rowFamily('opus')).toBe('opus')
    expect(rowFamily('claude-sonnet-5-5')).toBe('sonnet')
    expect(rowFamily('claude-haiku-5-5')).toBe('haiku')
    expect(rowFamily('claude-fable-5-1')).toBe('fable')
    expect(rowFamily('')).toBe('other')
  })

  test('paths', () => {
    expect(ledgerDir('/h')).toBe('/h/.claude/jarvis/ledger')
    expect(ledgerFile('/h', '2026-11-02', 's1')).toBe('/h/.claude/jarvis/ledger/2026-11-02/s1.jsonl')
    expect(lessonsFile('/h', 's1')).toBe('/h/.claude/jarvis/lessons/s1.jsonl')
  })

  test('encode then decode round-trips', () => {
    const rows = [row(), row({ id: 'a2', verdict: 'pass', health: ['loop'] })]
    const text = encodeRows(rows)
    expect(text.endsWith('\n')).toBe(true)
    expect(text.split('\n').length).toBe(3)
    expect(decodeRows(text)).toEqual(rows)
  })

  test('decodeRows skips bad lines', () => {
    const good = JSON.stringify(row())
    const good2 = JSON.stringify(row({ id: 'a2' }))
    const text = `${good}\n{oops\n{"v":2,"id":"x","at":1}\n\n${good2}`
    expect(decodeRows(text).map(r => r.id)).toEqual(['a1', 'a2'])
  })

  test('a row goes to the day of its spawn', () => {
    const at = new Date(2026, 10, 2, 23, 59).getTime()
    const r = row({ at, doneAt: at + 120_000 })
    const days = rowsByDay([r])
    expect([...days.keys()]).toEqual(['2026-11-02'])
    expect(dayKey(at)).toBe('2026-11-02')
  })

  test('dedupe prefers the live row over backfill', () => {
    const live = row({ doneAt: 5 })
    const back = row({ backfill: true, doneAt: 9 })
    expect(dedupe([back, live])).toEqual([live])
    expect(dedupe([live, back])).toEqual([live])
    const b1 = row({ id: 'b', backfill: true, doneAt: 1 })
    const b2 = row({ id: 'b', backfill: true, doneAt: 2 })
    expect(dedupe([b1, b2])).toEqual([b2])
  })

  test('expiredDays keeps 60 days and ignores odd names', () => {
    const now = new Date(2026, 10, 2, 12, 0).getTime()
    expect(expiredDays(['2026-08-01', '2026-10-30', 'notes', '2026-1-1'], now)).toEqual(['2026-08-01'])
    expect(RETAIN_DAYS).toBe(60)
  })
})

describe('dispatchHealth', () => {
  const now = new Date(2026, 10, 2, 12, 0).getTime()
  const fin = (id: string, ms: number, over: Partial<DispatchRow> = {}) =>
    row({ id, at: now - 3600_000, doneAt: now - 3600_000 + ms, durationMs: ms, ...over })
  const flagsOf = (r: DispatchRow) => (r.id === 'e1' ? ['tiny'] : [])

  test('groups by type and family with median, p90 and flag rate', () => {
    const rows = [
      fin('e1', 1000),
      fin('e2', 2000),
      fin('e3', 10_000),
      fin('w1', 5000, { type: 'worker', model: 'opus', family: 'opus' }),
    ]
    const out = dispatchHealth(rows, flagsOf, now)
    expect(out.length).toBe(2)
    expect(out[0]).toMatchObject({ type: 'Explore', family: 'haiku', runs: 3, medianMs: 2000, p90Ms: 10_000, flagRate: 1 / 3, topFlag: 'tiny' })
    expect(out[1]?.type).toBe('worker')
    expect(out[1]?.topFlag).toBeUndefined()
  })

  test('excludes old and unfinished rows', () => {
    const old = fin('o1', 1000, { at: now - (HEALTH_DAYS + 1) * 86_400_000, doneAt: now - (HEALTH_DAYS + 1) * 86_400_000 + 1000 })
    const open = row({ id: 'u1', at: now - 1000 })
    expect(dispatchHealth([old, open], () => [], now)).toEqual([])
  })
})
