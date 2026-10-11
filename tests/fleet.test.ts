import { describe, expect, test } from 'claude-code/testing'

import { costAt } from '../hooks/jarvis'
import {
  BEATS,
  BEAT_MS,
  addToday,
  contextPctOf,
  dayKey,
  fleetStatus,
  freshFile,
  parsePanes,
  projectDir,
  resumeFrom,
  splitLines,
  tailOf,
  transcriptPath,
  utf8Len,
} from '../hooks/fleet'

// ---- fixtures：結構照 herdr 0.9.1 與 Claude Code 的真實輸出，內容全是假的 ----

const pane = (over: Record<string, unknown> = {}) => ({
  agent: 'claude',
  agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'sess-a' },
  agent_status: 'idle',
  cwd: '/srv/alpha',
  focused: false,
  label: 'Alpha review',
  pane_id: 'w1:p1',
  tab_id: 'w1:t1',
  terminal_title_stripped: 'Alpha review',
  tokens: { context: '⛁ 43% (430k)', limit: '5h 97%', provider: 'claude', title: 'Alpha review' },
  workspace_id: 'w1',
  ...over,
})

const paneJson = (panes: unknown[]) => JSON.stringify({ id: 'cli:pane:list', result: { panes, type: 'pane_list' } })

const workspaceJson = JSON.stringify({
  id: 'cli:workspace:list',
  result: {
    type: 'workspace_list',
    workspaces: [
      { workspace_id: 'w1', label: 'Acme', agent_status: 'idle', number: 1 },
      { workspace_id: 'w2', label: '~', agent_status: 'working', number: 2 },
    ],
  },
})

const near = (got: number | undefined, want: number, digits: number) =>
  expect(got !== undefined && Math.abs(got - want) < 10 ** -digits).toBe(true)

const T0 = new Date(2026, 9, 11, 15, 0, 0).getTime()
const MIN = 60_000
const iso = (ts: number) => new Date(ts).toISOString()

const human = (ts: number, text: string) =>
  JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text }, origin: { kind: 'human' }, promptSource: 'typed', timestamp: iso(ts) })
const toolResult = (ts: number) =>
  JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }] }, timestamp: iso(ts) })
const meta = (ts: number, text: string) =>
  JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: text }, timestamp: iso(ts) })
const use = (i: number, o: number, cr = 0, cw = 0) => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cw,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cw },
  service_tier: 'standard',
})
const reply = (ts: number, id: string, content: unknown[], usage = use(10, 20), model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { model, id, type: 'message', role: 'assistant', content, stop_reason: 'end_turn', usage }, timestamp: iso(ts) })
const text = (t: string) => ({ type: 'text', text: t })
const thinking = { type: 'thinking', thinking: '', signature: 'sig' }
const toolUse = (name: string) => ({ type: 'tool_use', id: 'toolu_x', name, input: {} })
const lastPrompt = (t: string) => JSON.stringify({ type: 'last-prompt', lastPrompt: t, sessionId: 'sess-a' })
const jsonl = (...lines: string[]) => lines.map(l => `${l}\n`).join('')
const rowsOf = (...lines: string[]) => splitLines(jsonl(...lines), false).rows

describe('fleet paths and panes', () => {
  test('a cwd maps to its projects folder, every non alphanumeric a dash', () => {
    expect(projectDir('/Users/u/Documents/my.site')).toBe('-Users-u-Documents-my-site')
    expect(projectDir('/private/tmp/claude-501/-Users-u/x')).toBe('-private-tmp-claude-501--Users-u-x')
    expect(transcriptPath('/home/u', '/srv/app', 's1')).toBe('/home/u/.claude/projects/-srv-app/s1.jsonl')
  })

  test('herdr status: blocked and working kept, the rest idle', () => {
    expect(fleetStatus('blocked')).toBe('blocked')
    expect(fleetStatus('working')).toBe('working')
    expect(['idle', 'done', 'unknown', undefined].map(fleetStatus)).toEqual(['idle', 'idle', 'idle', 'idle'])
  })

  test('context percent read from the herdr token text', () => {
    expect(contextPctOf('⛁ 43% (430k)')).toBe(43)
    expect(contextPctOf('')).toBeUndefined()
    expect(contextPctOf(undefined)).toBeUndefined()
  })

  test('herdr panes: only claude, workspace named, session id kept, no id is empty', () => {
    const panes = parsePanes(
      paneJson([
        pane({ agent_status: 'blocked' }),
        pane({ pane_id: 'w2:p2', tab_id: 'w2:t2', label: 'Bravo build', agent_status: 'working', workspace_id: 'w2', agent_session: undefined, tokens: {} }),
        pane({ pane_id: 'w2:p3', agent: 'codex', label: 'Codex job' }),
        pane({ pane_id: 'w9:p4', tab_id: undefined, label: '', terminal_title_stripped: 'From title', workspace_id: 'w9' }),
      ]),
      workspaceJson,
    )
    expect(panes?.map(p => [p.paneId, p.tabId, p.title, p.status, p.workspace, p.sessionId, p.contextPct])).toEqual([
      ['w1:p1', 'w1:t1', 'Alpha review', 'blocked', 'Acme', 'sess-a', 43],
      ['w2:p2', 'w2:t2', 'Bravo build', 'working', '~', '', undefined],
      ['w9:p4', '', 'From title', 'idle', 'w9', 'sess-a', 43],
    ])
  })

  test('a herdr answer that is not JSON or has no panes is undefined; a bad workspace list only loses names', () => {
    expect(parsePanes('nope', workspaceJson)).toBeUndefined()
    expect(parsePanes(JSON.stringify({ result: {} }), workspaceJson)).toBeUndefined()
    expect(parsePanes(paneJson([pane()]), 'nope')?.[0]?.workspace).toBe('w1')
  })
})

describe('fleet lines', () => {
  test('utf8Len counts bytes', () => {
    expect(utf8Len('a中😀')).toBe(1 + 3 + 4)
  })

  test('split lines: complete lines only, broken ones skipped, a cut first line dropped, bytes in UTF-8', () => {
    const a = JSON.stringify({ type: 'a', v: '中' })
    const text = `${a}\nnot json\n${a}\n{"type":"par`
    const r = splitLines(text, false)
    expect(r.rows).toHaveLength(2)
    expect(r.bytes).toBe(utf8Len(`${a}\nnot json\n${a}\n`))
    // a read that began inside a character: the first line is thrown away, not parsed
    expect(splitLines(`��pe":"x"}\n${a}\n`, true).rows).toHaveLength(1)
    // even a first line that parses is dropped: it may be the tail of a longer line
    expect(splitLines(`${a}\n${a}\n`, true).rows).toHaveLength(1)
    expect(splitLines('no newline', false)).toEqual({ rows: [], bytes: 0 })
  })

  test('dayKey is the local date', () => {
    expect(dayKey(new Date(2026, 9, 11, 23, 59).getTime())).toBe('2026-10-11')
    expect(dayKey(new Date(2026, 9, 12, 0, 0).getTime())).toBe('2026-10-12')
  })
})

describe('fleet transcript tail', () => {
  test('the tail: last human prompt, last reply text, model, tools, last spoke, replies in the hour once each', () => {
    const rows = rowsOf(
      human(T0 - 70 * MIN, 'old ask'),
      reply(T0 - 70 * MIN, 'm0', [text('old answer')]),
      human(T0 - 10 * MIN, 'fix the login'),
      reply(T0 - 9 * MIN, 'm1', [thinking]),
      reply(T0 - 9 * MIN, 'm1', [toolUse('Bash')]),
      toolResult(T0 - 8 * MIN),
      meta(T0 - 8 * MIN, '<system-reminder>x</system-reminder>'),
      reply(T0 - 2 * MIN, 'm2', [text('done, tests pass')]),
    )
    const t = tailOf(rows, T0)
    expect(t.lastUser).toBe('fix the login')
    expect(t.lastReply).toBe('done, tests pass')
    expect(t.model).toBe('claude-opus-5-5')
    expect(t.tools).toBe(1)
    expect(t.lastAt).toBe(T0 - 2 * MIN)
    expect(t.stamps).toEqual([T0 - 9 * MIN, T0 - 2 * MIN])
  })

  test('a later last-prompt line is the last prompt; an empty tail has nothing', () => {
    expect(tailOf(rowsOf(human(T0 - 5 * MIN, 'first'), lastPrompt('typed later')), T0).lastUser).toBe('typed later')
    expect(tailOf([], T0)).toEqual({ stamps: [], tools: 0 })
  })

  test('the heartbeat window is BEATS buckets of BEAT_MS', () => {
    expect(BEATS * BEAT_MS).toBe(60 * MIN)
  })
})

describe('fleet today', () => {
  test('today: one message split over lines counts once, yesterday is left out', () => {
    const rows = rowsOf(
      reply(new Date(2026, 9, 10, 23, 0).getTime(), 'y1', [text('late')], use(1000, 1000)),
      reply(T0 - 5 * MIN, 'm1', [thinking], use(100, 50, 1000, 200)),
      reply(T0 - 5 * MIN, 'm1', [toolUse('Read')], use(100, 50, 1000, 200)),
      toolResult(T0 - 4 * MIN),
      reply(T0 - 3 * MIN, 'm2', [text('ok')], use(10, 5)),
    )
    const f = addToday(freshFile(T0), rows, 500, T0)
    expect(f.tokens).toBe(150 + 15)
    near(
      f.cost,
      costAt({ input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 }, 'opus') +
        costAt({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, 'opus'),
      9,
    )
    expect(f.offset).toBe(500)
    expect(f.lastMsgId).toBe('m2')
  })

  test('a message split across two reads still counts once', () => {
    const a = addToday(freshFile(T0), rowsOf(reply(T0 - MIN, 'm1', [thinking], use(100, 50))), 10, T0)
    const b = addToday(a, rowsOf(reply(T0 - MIN, 'm1', [toolUse('Bash')], use(100, 50))), 10, T0)
    expect(b.tokens).toBe(150)
    expect(b.offset).toBe(20)
  })

  test('a read from a line boundary moves the offset by the UTF-8 bytes of its whole lines only', () => {
    const whole = jsonl(reply(T0 - MIN, 'm1', [text('修好了 ✓')], use(4, 6)))
    const read = splitLines(`${whole}{"type":"assist`, false)
    const f = addToday(freshFile(T0), read.rows, read.bytes, T0)
    expect(f.offset).toBe(new TextEncoder().encode(whole).length)
    expect(f.tokens).toBe(10)
  })

  test('an unpriced model counts its tokens, not a cost', () => {
    const f = addToday(freshFile(T0), rowsOf(reply(T0 - MIN, 'm1', [text('x')], use(7, 3), 'claude-haiku-4-5')), 1, T0)
    expect(f.tokens).toBe(10)
    expect(f.cost).toBe(0)
  })

  test('today resumes on the same day and a grown file, restarts on a new day or a shrunk file', () => {
    const f = { ...freshFile(T0), offset: 400, tokens: 9 }
    expect(resumeFrom(f, 500, T0)?.tokens).toBe(9)
    expect(resumeFrom(f, 300, T0)).toBeUndefined()
    expect(resumeFrom(f, 500, T0 + 24 * 60 * MIN)).toBeUndefined()
    expect(resumeFrom(undefined, 500, T0)).toBeUndefined()
  })
})
