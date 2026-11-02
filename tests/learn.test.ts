import { describe, expect, test } from 'claude-code/testing'

import { createLearn, type LearnIo } from '../hooks/learn'
import { type DispatchRow, decodeRows, encodeRows, ledgerFile, lessonsFile } from '../hooks/ledger'
import { decodeEvents } from '../hooks/lessons'

const HOME = '/h'
const MIN = 60_000
const DAY = 86_400_000
// local noon, so the day key never depends on the time zone
const NOW = new Date(2026, 9, 15, 12).getTime()
const TODAY = '2026-10-15'

type Fake = LearnIo & { files: Map<string, string>; mtimes: Map<string, number>; runs: string[][]; writes: string[]; result: { exitCode: number; stdout: string; stderr: string } | undefined }

function fakeIo(files = new Map<string, string>()): Fake {
  const io: Fake = {
    files,
    mtimes: new Map(),
    runs: [],
    writes: [],
    result: { exitCode: 0, stdout: '{"id":1901}', stderr: '' },
    stat: async path => {
      const text = io.files.get(path)
      if (text !== undefined) return { kind: 'file', size: text.length, mtimeMs: io.mtimes.get(path) ?? 0 }
      for (const k of io.files.keys()) if (k.startsWith(`${path}/`)) return { kind: 'dir', size: 0, mtimeMs: 0 }
      return undefined
    },
    read: async path => io.files.get(path),
    write: async (path, text) => {
      io.writes.push(path)
      io.files.set(path, text)
      return true
    },
    run: async argv => {
      io.runs.push(argv)
      return io.result
    },
    list: async dir => {
      const out = new Map<string, string>()
      for (const k of io.files.keys()) {
        if (!k.startsWith(`${dir}/`)) continue
        const rest = k.slice(dir.length + 1)
        const i = rest.indexOf('/')
        out.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'dir')
      }
      return [...out].map(([name, kind]) => ({ name, kind }))
    },
  }
  return io
}

const opts = (session = 's1') => ({ home: HOME, session, project: 'proj' })
const spawnOf = (id: string, over: Partial<{ type: string; model: string; at: number; desc: string }> = {}) => ({
  id,
  type: over.type ?? 'Explore',
  model: over.model ?? 'claude-haiku-5-5',
  background: false,
  desc: over.desc ?? 'find x',
  promptLen: 10,
  at: over.at ?? NOW - 10 * MIN,
})
const done = (answer = 'ok') => ({ reason: 'answer', durationMs: 5000, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }, answer, cost: 0.01 })

const row = (id: string, over: Partial<DispatchRow> = {}): DispatchRow => ({
  v: 1,
  id,
  session: 'other',
  project: 'p',
  at: NOW - DAY,
  type: 'Explore',
  model: 'claude-haiku-5-5',
  family: 'haiku',
  background: false,
  desc: 'd',
  promptLen: 1,
  doneAt: NOW - DAY + 1000,
  durationMs: 1000,
  reason: 'answer',
  tokens: { in: 1, out: 1, cr: 0, cw: 0 },
  tools: 1,
  toolErrors: 0,
  ...over,
})

const ownRows = (io: Fake, day = TODAY, session = 's1'): DispatchRow[] => decodeRows(io.files.get(ledgerFile(HOME, day, session)) ?? '')

// two tiny Explore dispatches in another session: a candidate lesson tiny:Explore:haiku
const KEY = 'tiny:Explore:haiku'
function candidateFs(): Map<string, string> {
  return new Map([[ledgerFile(HOME, '2026-10-14', 'other'), encodeRows([row('o1'), row('o2', { at: NOW - DAY + 5 })])]])
}

describe('learn: recording', () => {
  test('spawn, tool, finish produce one finished row with tokens and counts', async () => {
    const io = fakeIo()
    const l = createLearn(io, opts())
    l.spawn(spawnOf('a1'))
    l.tool('a1', true)
    l.tool('a1', false)
    l.tool('a1', true)
    l.finish('a1', done(), NOW)
    await l.flush(NOW)
    const rows = ownRows(io)
    expect(rows.length).toBe(1)
    const r = rows[0]!
    expect(r.doneAt).toBe(NOW)
    expect(r.durationMs).toBe(5000)
    expect(r.tokens).toEqual({ in: 10, out: 5, cr: 100, cw: 20 })
    expect(r.cost).toBe(0.01)
    expect(r.tools).toBe(3)
    expect(r.toolErrors).toBe(1)
    expect(r.family).toBe('haiku')
    expect(r.session).toBe('s1')
    expect(r.project).toBe('proj')
    expect(r.reason).toBe('answer')
  })

  test("a verifier's VERDICT line sets its verdict", async () => {
    const io = fakeIo()
    const l = createLearn(io, opts())
    l.spawn(spawnOf('v1', { type: 'verifier' }))
    l.spawn(spawnOf('w1', { type: 'worker' }))
    l.finish('v1', done('checked\nVERDICT: FAIL'), NOW)
    l.finish('w1', done('VERDICT: FAIL'), NOW)
    await l.flush(NOW)
    const rows = ownRows(io)
    expect(rows.find(r => r.id === 'v1')!.verdict).toBe('fail')
    expect(rows.find(r => r.id === 'w1')!.verdict).toBeUndefined()
  })

  test('health adds loop and stuck once each', async () => {
    const io = fakeIo()
    const l = createLearn(io, opts())
    l.spawn(spawnOf('a1'))
    l.health(['a1'], ['a1'])
    l.health(['a1'], [])
    await l.flush(NOW)
    expect(ownRows(io)[0]!.health).toEqual(['loop', 'stuck'])
  })

  test('subtask sets redispatchOf only when the previous agent is finished', async () => {
    const io = fakeIo()
    const l = createLearn(io, opts())
    l.spawn(spawnOf('a1'))
    l.spawn(spawnOf('a2'))
    l.subtask('a2', '1.1', 'a1')
    l.finish('a1', done(), NOW - 5 * MIN)
    l.spawn(spawnOf('a3'))
    l.subtask('a3', '1.1', 'a1')
    await l.flush(NOW)
    const rows = ownRows(io)
    expect(rows.find(r => r.id === 'a2')!.subtask).toBe('1.1')
    expect(rows.find(r => r.id === 'a2')!.redispatchOf).toBeUndefined()
    expect(rows.find(r => r.id === 'a3')!.redispatchOf).toBe('a1')
  })

  test('flush writes only this session\'s file, grouped by spawn day', async () => {
    const io = fakeIo()
    const l = createLearn(io, opts())
    l.spawn(spawnOf('a1', { at: NOW - DAY }))
    l.spawn(spawnOf('a2'))
    // finished after midnight: still the spawn day
    l.finish('a1', done(), NOW)
    await l.flush(NOW)
    expect([...io.writes].sort()).toEqual([ledgerFile(HOME, '2026-10-14', 's1'), ledgerFile(HOME, TODAY, 's1')])
    expect(ownRows(io, '2026-10-14').map(r => r.id)).toEqual(['a1'])
    expect(ownRows(io).map(r => r.id)).toEqual(['a2'])
    expect(l.due(NOW + 5000)).toBe(false)
    io.writes.length = 0
    await l.flush(NOW + 5000)
    expect(io.writes).toEqual([])
    l.tool('a2', true)
    expect(l.due(NOW + 1000)).toBe(false)
    expect(l.due(NOW + 2000)).toBe(true)
  })
})

describe('learn: reading', () => {
  test('load merges other sessions and dedupes', async () => {
    const files = new Map([
      [ledgerFile(HOME, '2026-10-14', 'other'), encodeRows([row('o1'), row('o2')])],
      [ledgerFile(HOME, '2026-10-14', 'backfill'), encodeRows([row('o1', { backfill: true, tools: 9 }), row('b1', { backfill: true })])],
    ])
    const io = fakeIo(files)
    const l = createLearn(io, opts())
    await l.load(NOW)
    const h = l.health14(NOW)
    expect(h.length).toBe(1)
    expect(h[0]!.runs).toBe(3)
  })

  test('load treats a row without tokens as zero and never throws', async () => {
    const bad = '{"v":1,"id":"x","at":' + (NOW - DAY) + ',"type":"Explore","family":"haiku","doneAt":' + (NOW - DAY + 1) + '}\nnot json\n'
    const io = fakeIo(new Map([[ledgerFile(HOME, '2026-10-14', 'other'), bad]]))
    const l = createLearn(io, opts())
    await l.load(NOW)
    expect(l.health14(NOW)[0]!.meanTokens).toBe(0)
    expect(l.lessons(NOW).length).toBe(1)
  })

  test('load skips within 60 s unless forced', async () => {
    const io = fakeIo()
    const l = createLearn(io, opts())
    await l.load(NOW)
    io.files.set(ledgerFile(HOME, '2026-10-14', 'other'), encodeRows([row('o1')]))
    await l.load(NOW + 30_000)
    expect(l.health14(NOW).length).toBe(0)
    await l.load(NOW + 30_000, true)
    expect(l.health14(NOW).length).toBe(1)
  })

  test('retention removes only expired day dirs', async () => {
    const io = fakeIo(
      new Map([
        [ledgerFile(HOME, '2026-08-01', 'x'), ''],
        [ledgerFile(HOME, '2026-09-01', 'x'), ''],
        [`${HOME}/.claude/jarvis/ledger/junk/x.jsonl`, ''],
      ]),
    )
    const l = createLearn(io, opts())
    await l.load(NOW)
    await l.load(NOW, true)
    expect(io.runs).toEqual([['/bin/rm', '-rf', `${HOME}/.claude/jarvis/ledger/2026-08-01`]])
  })

  test('backfill writes backfill.jsonl once', async () => {
    const io = fakeIo()
    const base = `${HOME}/.claude/projects/-Users-x-proj/sess9/subagents`
    const meta = JSON.stringify({ agentType: 'Explore', description: 'find', model: 'claude-haiku-5-5', finished: true })
    const t0 = new Date(NOW - 2 * DAY).toISOString()
    const t1 = new Date(NOW - 2 * DAY + 4000).toISOString()
    const jsonl = [
      { type: 'user', timestamp: t0, cwd: '/Users/x/proj', message: { content: 'go' } },
      { type: 'assistant', timestamp: t1, message: { id: 'm1', content: [{ type: 'text', text: 'done' }] } },
    ]
      .map(x => JSON.stringify(x))
      .join('\n')
    io.files.set(`${base}/agent-a9.meta.json`, meta)
    io.files.set(`${base}/agent-a9.jsonl`, jsonl)
    io.mtimes.set(`${base}/agent-a9.meta.json`, NOW - 2 * DAY)
    // too old
    io.files.set(`${base}/agent-old.meta.json`, meta)
    io.files.set(`${base}/agent-old.jsonl`, jsonl)
    io.mtimes.set(`${base}/agent-old.meta.json`, NOW - 20 * DAY)
    // empty transcript: no time, skipped
    io.files.set(`${base}/agent-e.meta.json`, meta)
    io.files.set(`${base}/agent-e.jsonl`, '')
    io.mtimes.set(`${base}/agent-e.meta.json`, NOW)

    const l = createLearn(io, opts())
    await l.load(NOW)
    expect(await l.backfill(NOW)).toBe(1)
    const file = `${HOME}/.claude/jarvis/ledger/2026-10-13/backfill.jsonl`
    const rows = decodeRows(io.files.get(file) ?? '')
    expect(rows.map(r => [r.id, r.session, r.project, r.backfill])).toEqual([['a9', 'sess9', 'proj', true]])
    expect(l.health14(NOW)[0]!.runs).toBe(1)

    const again = createLearn(io, opts('s2'))
    await again.load(NOW)
    expect(await again.backfill(NOW)).toBe(0)
  })
})

describe('learn: corrections', () => {
  test('a correction prompt marks rows finished since the last prompt', async () => {
    const io = fakeIo()
    const l = createLearn(io, opts())
    l.spawn(spawnOf('a1'))
    l.finish('a1', done(), NOW - 9 * MIN)
    l.prompt('next task', NOW - 8 * MIN)
    l.spawn(spawnOf('a2'))
    l.finish('a2', done(), NOW - 2 * MIN)
    l.prompt('你不是說要先跑測試嗎', NOW)
    await l.flush(NOW)
    const rows = ownRows(io)
    expect(rows.find(r => r.id === 'a1')!.corrected).toBeUndefined()
    expect(rows.find(r => r.id === 'a2')!.corrected).toBe(true)
  })

  test('not after 15 min', async () => {
    const io = fakeIo()
    const l = createLearn(io, opts())
    l.spawn(spawnOf('a1', { at: NOW - 30 * MIN }))
    l.finish('a1', done(), NOW - 16 * MIN)
    l.prompt("that's wrong", NOW)
    await l.flush(NOW)
    expect(ownRows(io)[0]!.corrected).toBeUndefined()
  })
})

describe('learn: lessons', () => {
  test('only the approving session gets the apply request', async () => {
    const io = fakeIo(candidateFs())
    const a = createLearn(io, opts('A'))
    const b = createLearn(io, opts('B'))
    await a.load(NOW)
    await b.load(NOW)
    expect(a.lessons(NOW).find(x => x.key === KEY)!.state).toBe('candidate')
    await a.approve(KEY, NOW)
    await a.flush(NOW)
    await b.load(NOW + 61_000)
    expect(b.lessons(NOW + 61_000).find(x => x.key === KEY)!.state).toBe('approved')
    expect(b.inject(NOW + 61_000).some(s => s.includes('mcp__jarvis__lesson'))).toBe(false)
    expect(a.inject(NOW).some(s => s.includes('mcp__jarvis__lesson'))).toBe(true)
  })

  test('memory store failure keeps approved with error', async () => {
    const io = fakeIo(candidateFs())
    io.result = { exitCode: 1, stdout: '', stderr: 'boom' }
    const l = createLearn(io, opts())
    await l.load(NOW)
    await l.approve(KEY, NOW)
    const x = l.lessons(NOW).find(y => y.key === KEY)!
    expect(x.state).toBe('approved')
    expect(x.memoryError).toBe('boom')
    expect(x.memoryId).toBeUndefined()
    expect(io.runs[0]![0]).toBe(`${HOME}/.local/bin/memory-mcp`)

    io.result = undefined
    await l.approve(KEY, NOW + 1)
    expect(l.lessons(NOW).find(y => y.key === KEY)!.memoryError).toBe('no id')
  })

  test('memoryId set on success', async () => {
    const io = fakeIo(candidateFs())
    const l = createLearn(io, opts())
    await l.load(NOW)
    await l.approve(KEY, NOW)
    await l.flush(NOW)
    expect(l.lessons(NOW).find(y => y.key === KEY)!.memoryId).toBe(1901)
    const events = decodeEvents(io.files.get(lessonsFile(HOME, 's1')) ?? '')
    expect(events.map(e => e.kind)).toEqual(['approve', 'memory'])
  })

  test('the apply request is injected once; after turnEnded without applied the lesson is waiting; retry injects again', async () => {
    const io = fakeIo(candidateFs())
    const l = createLearn(io, opts())
    await l.load(NOW)
    await l.approve(KEY, NOW)
    const asks = (lines: string[]) => lines.filter(s => s.includes('mcp__jarvis__lesson')).length
    expect(asks(l.inject(NOW))).toBe(1)
    expect(asks(l.inject(NOW))).toBe(0)
    l.turnEnded()
    const x = l.lessons(NOW).find(y => y.key === KEY)!
    expect(x.state).toBe('approved')
    expect(x.waiting).toBe(true)
    l.retry(KEY)
    expect(l.lessons(NOW).find(y => y.key === KEY)!.waiting).toBeFalsy()
    expect(asks(l.inject(NOW))).toBe(1)
    l.cancel(KEY, NOW + 1)
    expect(l.lessons(NOW + 1).find(y => y.key === KEY)!.state).toBe('candidate')
  })

  test('toolCall applied moves approved to applied; applied on a candidate is an error', async () => {
    const io = fakeIo(candidateFs())
    const l = createLearn(io, opts())
    await l.load(NOW)
    expect(l.toolCall({ op: 'applied', key: KEY, file: '/f.md' }, NOW).startsWith('error:')).toBe(true)
    expect(l.toolCall({ op: 'bogus' }, NOW).startsWith('error:')).toBe(true)
    expect(l.toolCall({ op: 'applied', key: 'tiny:nope:haiku', file: '/f.md' }, NOW).startsWith('error:')).toBe(true)
    expect(l.toolCall({ op: 'list' }, NOW)).toContain(KEY)
    await l.approve(KEY, NOW)
    l.inject(NOW)
    const ok = l.toolCall({ op: 'applied', key: KEY, file: '/f.md' }, NOW + 1)
    expect(ok.startsWith('error:')).toBe(false)
    l.turnEnded()
    const x = l.lessons(NOW + 1).find(y => y.key === KEY)!
    expect(x.state).toBe('applied')
    expect(x.file).toBe('/f.md')
    expect(x.waiting).toBeFalsy()
    expect(l.toolCall({ op: 'reverted', key: KEY }, NOW + 2).startsWith('error:')).toBe(true)
    l.requestRevert(KEY, NOW + 2)
    expect(l.inject(NOW + 2).some(s => s.includes('"reverted"'))).toBe(true)
    expect(l.toolCall({ op: 'reverted', key: KEY }, NOW + 3).startsWith('error:')).toBe(false)
    expect(l.lessons(NOW + 3).find(y => y.key === KEY)!.state).toBe('reverted')
  })

  test('reject hides the candidate from injection', async () => {
    const io = fakeIo(candidateFs())
    const l = createLearn(io, opts())
    await l.load(NOW)
    l.reject(KEY, NOW)
    expect(l.lessons(NOW).find(y => y.key === KEY)!.state).toBe('rejected')
    expect(l.inject(NOW)).toEqual([])
  })

  test('no home records nothing and never throws', async () => {
    const io = fakeIo(candidateFs())
    const l = createLearn(io, { home: '', session: 's1', project: 'p' })
    l.spawn(spawnOf('a1'))
    l.tool('a1', false)
    l.finish('a1', done(), NOW)
    l.prompt('you said', NOW)
    await l.load(NOW)
    await l.approve(KEY, NOW)
    await l.flush(NOW)
    expect(await l.backfill(NOW)).toBe(0)
    expect(io.writes).toEqual([])
    expect(io.runs).toEqual([])
    expect(l.lessons(NOW)).toEqual([])
    expect(l.health14(NOW)).toEqual([])
    expect(l.inject(NOW)).toEqual([])
  })

  test('failing io never throws', async () => {
    const io = fakeIo(candidateFs())
    const boom = async (): Promise<never> => {
      throw new Error('io')
    }
    const l = createLearn({ ...io, read: boom, write: boom, list: boom, stat: boom, run: boom }, opts())
    l.spawn(spawnOf('a1'))
    await l.load(NOW)
    await l.approve(KEY, NOW)
    await l.flush(NOW)
    expect(await l.backfill(NOW)).toBe(0)
  })
})
