import { describe, expect, test } from 'claude-code/testing'

import { BACKFILL_DAYS, backfillPlan, backfillRow } from '../hooks/backfill'
import { DESC_LEN } from '../hooks/ledger'

const ctx = { id: 'a1', session: 's1', project: 'proj' }
const meta = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ agentType: 'Explore', description: 'find x', model: 'opus', requestShape: 'background', finished: true, ...over })
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }
const lines = (): string =>
  [
    { type: 'user', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'do the thing' } },
    { type: 'assistant', timestamp: '2026-10-01T00:00:01.000Z', message: { id: 'm1', usage, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    { type: 'user', timestamp: '2026-10-01T00:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'x' }] } },
    { type: 'assistant', timestamp: '2026-10-01T00:00:05.000Z', message: { id: 'm2', usage, content: [{ type: 'text', text: 'done' }] } },
    { type: 'assistant', timestamp: '2026-10-01T00:00:05.000Z', message: { id: 'm2', usage, content: [{ type: 'text', text: 'done' }] } },
  ]
    .map(l => JSON.stringify(l))
    .join('\n')

describe('backfill', () => {
  test('parses a finished transcript', () => {
    const r = backfillRow(meta(), lines(), ctx)!
    expect(r.tools).toBe(1)
    expect(r.toolErrors).toBe(1)
    expect(r.durationMs).toBe(5000)
    expect(r.doneAt! - r.at).toBe(5000)
    expect(r.tokens).toEqual({ in: 20, out: 10, cr: 200, cw: 40 })
    expect(r.reason).toBe('answer')
    expect(r.backfill).toBe(true)
    expect(r.background).toBe(true)
    expect(r.family).toBe('opus')
  })
  test('unfinished or bad meta gives undefined', () => {
    expect(backfillRow(meta({ finished: false }), lines(), ctx)).toBeUndefined()
    expect(backfillRow('{nope', lines(), ctx)).toBeUndefined()
  })
  test('isFork gives type fork', () => {
    expect(backfillRow(meta({ isFork: true }), lines(), ctx)!.type).toBe('fork')
  })
  test('desc is truncated', () => {
    expect(backfillRow(meta({ description: 'x'.repeat(500) }), lines(), ctx)!.desc.length).toBe(DESC_LEN)
  })
  test('plan covers 14 days', () => {
    expect(BACKFILL_DAYS).toBe(14)
    expect(backfillPlan('/h', 20 * 86_400_000)).toEqual({ projectsDir: '/h/.claude/projects', sinceMs: 6 * 86_400_000 })
  })
})
