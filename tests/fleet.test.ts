import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { FleetSession } from '../types'
import { FAMILY_COLOR, THEME, cellWidth, costAt } from '../hooks/jarvis'
import { BURN_RAMP, GAUGE_RAMP } from '../hooks/fleetChart'
import {
  BEATS,
  BEAT_GLYPHS,
  BEAT_MS,
  DECOMMISSION_MS,
  EMPTY_TAIL,
  addToday,
  beatLine,
  beatsOf,
  contextPctOf,
  dayKey,
  decommissionCount,
  emptyHours,
  fleetSections,
  fleetStatus,
  fleetTotals,
  fmtAgo,
  fmtBig,
  forecast,
  freshFile,
  parsePanes,
  parseQuota,
  projectDir,
  quotaStale,
  resumeFrom,
  splitLines,
  tailOf,
  transcriptPath,
  utf8Len,
  wrapCells,
} from '../hooks/fleet'
import { EMPTY_FLEET, FLEET_MS, LIMITS_PATH, MAX_READS, PANE_LIST, TAIL_BYTES, focusArgv, refreshFleet, withJump } from '../hooks/fleetSource'
import type { FleetIo, RunOut } from '../hooks/fleetSource'

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
// the local midnight that starts T0's day, and a time the day before
const MIDNIGHT = new Date(2026, 9, 11).getTime()
const YESTERDAY = new Date(2026, 9, 10, 22, 0, 0).getTime()
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

const suit = (over: Partial<FleetSession> = {}): FleetSession => ({
  paneId: 'w1:p1',
  tabId: 'w1:t1',
  sessionId: 'sess-a',
  title: 'Alpha review',
  status: 'idle',
  cwd: '/srv/alpha',
  workspace: 'Acme',
  stamps: [],
  tools: 0,
  todayTokens: 0,
  todayCost: 0,
  ...over,
})

// structure of ~/.claude/herdr-usagebar/claude-limits-latest.json; resetsAt in seconds
const RESET = Math.floor(T0 / 1000) + 900 * 60
const limitsJson = (used7d: number, fetchedAtMs = T0) =>
  JSON.stringify({
    fiveHour: { usedPercentage: 5, resetsAt: Math.floor(T0 / 1000) + 120 * 60, windowMinutes: 300 },
    sevenDay: { usedPercentage: used7d, resetsAt: RESET, windowMinutes: 10080 },
    fetchedAtMs,
  })

const HOME = '/home/u'
const pathOf = (cwd: string, id: string) => transcriptPath(HOME, cwd, id)
const subOf = (cwd: string, id: string, name: string) => `${HOME}/.claude/projects/${projectDir(cwd)}/${id}/subagents/${name}`

const enc = new TextEncoder()
const dec = new TextDecoder()

// `tail -c N path` and `tail -c +K path` over `content`, cut at `cap` bytes as the
// engine cuts a run's stdout at 4 MiB
const fakeTail = (content: string, argv: readonly string[], cap = Infinity): RunOut => {
  const bytes = enc.encode(content)
  const n = argv[2] ?? ''
  let slice = n.startsWith('+') ? bytes.slice(Number(n.slice(1)) - 1) : bytes.slice(Math.max(0, bytes.length - Number(n)))
  const truncated = slice.length > cap
  if (truncated) slice = slice.slice(0, cap)
  return { exitCode: 0, stdout: dec.decode(slice), stderr: '', truncated }
}

type World = {
  panes: unknown[]
  files: Record<string, string>
  mtime?: Record<string, number>
  herdr?: boolean
  quota?: string
  cap?: number
  // `herdr agent focus` answers exit 1, `no such pane`
  focusFails?: boolean
  // what a failed focus says on stderr instead of `no such pane`
  focusStderr?: string
  // the session the engine says it is
  selfId?: string
  // listing a folder fails for a moment
  listFails?: boolean
  calls: string[][]
}

const fakeIo = (w: World): FleetIo => ({
  home: HOME,
  run: async argv => {
    w.calls.push([...argv])
    const ok = (stdout: string): RunOut => ({ exitCode: 0, stdout, stderr: '', truncated: false })
    if (argv[0] === 'herdr' && argv[1] === 'pane') {
      return w.herdr === false ? { exitCode: 1, stdout: '', stderr: 'no server', truncated: false } : ok(paneJson(w.panes))
    }
    if (argv[0] === 'herdr' && argv[1] === 'workspace') return ok(workspaceJson)
    if (argv[0] === 'herdr' && argv[1] === 'agent' && w.focusFails) {
      return { exitCode: 1, stdout: '', stderr: w.focusStderr ?? 'no such pane', truncated: false }
    }
    if (argv[0] === 'tail') {
      const c = w.files[argv[3] ?? '']
      return c === undefined ? { exitCode: 1, stdout: '', stderr: 'no file', truncated: false } : fakeTail(c, argv, w.cap)
    }
    return ok('')
  },
  stat: async path => {
    const c = w.files[path]
    return c === undefined ? undefined : { size: utf8Len(c), mtimeMs: w.mtime?.[path] ?? T0 }
  },
  read: async path => (path === `${HOME}/.claude/herdr-usagebar/claude-limits-latest.json` ? w.quota : undefined),
  // a folder exists while some file is in it
  list: async dir => {
    if (w.listFails) return undefined
    const prefix = `${dir}/`
    const inside = Object.keys(w.files).filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    if (inside.length === 0) return undefined
    return inside.map(p => ({ name: p.slice(prefix.length), kind: 'file', size: utf8Len(w.files[p] ?? ''), mtimeMs: w.mtime?.[p] ?? T0 }))
  },
})

const tails = (w: World) => w.calls.filter(c => c[0] === 'tail').length

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

  test('the empty tail is frozen, its stamps too: no session pushes into another', () => {
    expect(Object.isFrozen(EMPTY_TAIL)).toBe(true)
    expect(Object.isFrozen(EMPTY_TAIL.stamps)).toBe(true)
    expect(() => EMPTY_TAIL.stamps.push(1)).toThrow()
    expect(freshFile(T0).tail.stamps).toEqual([])
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

  test('today resumes on a grown file, restarts on a shrunk file', () => {
    const f = { ...freshFile(T0), offset: 400, tokens: 9 }
    expect(resumeFrom(f, 500, T0)?.tokens).toBe(9)
    expect(resumeFrom(f, 300, T0)).toBeUndefined()
    expect(resumeFrom(undefined, 500, T0)).toBeUndefined()
  })

  test('a new day goes on from where the file was read, its count at zero', () => {
    const f = { ...freshFile(T0), offset: 400, tokens: 9, cost: 1, lastMsgId: 'm9' }
    const tomorrow = T0 + 24 * 60 * MIN
    const r = resumeFrom(f, 500, tomorrow)
    expect([r?.offset, r?.day, r?.tokens, r?.cost, r?.lastMsgId]).toEqual([400, dayKey(tomorrow), 0, 0, 'm9'])
    expect(resumeFrom(f, 300, tomorrow)).toBeUndefined()
  })
})

describe('fleet quota', () => {
  test('the usagebar cache: seconds become ms; garbage is undefined', () => {
    const q = parseQuota(limitsJson(92))
    expect(q?.sevenDay).toEqual({ usedPct: 92, resetsAt: RESET * 1000, windowMin: 10080 })
    expect(q?.fiveHour?.usedPct).toBe(5)
    expect(q?.fetchedAt).toBe(T0)
    expect(parseQuota('nope')).toBeUndefined()
    expect(parseQuota(undefined)).toBeUndefined()
    expect(parseQuota(JSON.stringify({ sevenDay: {} }))).toBeUndefined()
  })

  test('at the pace so far: 92% with 900 of 10080 minutes left runs out before the reset', () => {
    const w = { usedPct: 92, resetsAt: T0 + 900 * MIN, windowMin: 10080 }
    const f = forecast(w, T0)
    expect(f?.beforeReset).toBe(true)
    near(((f?.depleteAt ?? 0) - T0) / MIN, (8 * 9180) / 92, 6)
  })

  test('a slow pace lasts past the reset; nothing used, or a window not begun, has no forecast', () => {
    expect(forecast({ usedPct: 30, resetsAt: T0 + 5040 * MIN, windowMin: 10080 }, T0)?.beforeReset).toBe(false)
    expect(forecast({ usedPct: 0, resetsAt: T0 + 5040 * MIN, windowMin: 10080 }, T0)).toBeUndefined()
    expect(forecast({ usedPct: 10, resetsAt: T0 + 10080 * MIN, windowMin: 10080 }, T0)).toBeUndefined()
    expect(forecast({ usedPct: 100, resetsAt: T0 + 60 * MIN, windowMin: 10080 }, T0)).toEqual({ depleteAt: T0, beforeReset: true })
  })

  test('a cache older than 15 minutes is stale', () => {
    const q = parseQuota(limitsJson(92, T0))
    expect(q && quotaStale(q, T0 + 15 * MIN)).toBe(false)
    expect(q && quotaStale(q, T0 + 15 * MIN + 1)).toBe(true)
  })
})

describe('fleet order and readouts', () => {
  test('sections: waiting, working, the rest; each newest first, no time last', () => {
    const s = fleetSections([
      suit({ paneId: 'a', status: 'idle', lastAt: T0 - 60 * MIN }),
      suit({ paneId: 'b', status: 'blocked', lastAt: T0 - 5 * MIN }),
      suit({ paneId: 'c', status: 'idle' }),
      suit({ paneId: 'd', status: 'working', lastAt: T0 }),
      suit({ paneId: 'e', status: 'idle', lastAt: T0 - MIN }),
    ])
    expect([s.blocked, s.working, s.idle].map(l => l.map(x => x.paneId))).toEqual([['b'], ['d'], ['e', 'a', 'c']])
  })

  test('decommission: idle over a day; working, waiting or unknown time never', () => {
    expect(
      decommissionCount(
        [
          suit({ lastAt: T0 - DECOMMISSION_MS - 1 }),
          suit({ lastAt: T0 - DECOMMISSION_MS }),
          suit({ status: 'blocked', lastAt: T0 - 3 * DECOMMISSION_MS }),
          suit({}),
        ],
        T0,
      ),
    ).toBe(1)
  })

  test('heartbeat: a reply lands in its five-minute bucket, the newest on the right', () => {
    const beats = beatsOf([T0 - 1 * MIN, T0 - 2 * MIN, T0 - 59 * MIN, T0 - 61 * MIN, T0 + MIN], T0)
    expect(beats).toHaveLength(12)
    expect(beats[11]).toBe(2)
    expect(beats[0]).toBe(1)
    expect(beats.reduce((a, b) => a + b, 0)).toBe(3)
  })

  test('heartbeat glyphs scale to the fleet busiest; silence is the blank braille', () => {
    expect(beatLine([0, 1, 2, 4], 4)).toBe(`${BEAT_GLYPHS[0]}${BEAT_GLYPHS[1]}${BEAT_GLYPHS[2]}${BEAT_GLYPHS[4]}`)
    expect(beatLine([0, 0], 0)).toBe(`${BEAT_GLYPHS[0]}${BEAT_GLYPHS[0]}`)
    expect(cellWidth(beatLine(Array.from({ length: 12 }, () => 3), 3))).toBe(12)
  })

  test('ago, big numbers and fleet totals', () => {
    expect([45_000, 12 * MIN, 3 * 60 * MIN, 50 * 60 * MIN].map(fmtAgo)).toEqual(['45s', '12m', '3h', '2d'])
    expect(fmtBig(4_200_000)).toBe('4.2M')
    expect(fmtBig(950)).toBe('950')
    expect(fleetTotals([suit({ todayTokens: 100, todayCost: 1 }), suit({ title: 'Big', todayTokens: 5, todayCost: 2 })])).toEqual({ tokens: 105, cost: 3, top: 'Big' })
    expect(fleetTotals([suit({})]).top).toBeUndefined()
  })

  test('wrap: words flow by cells, whitespace collapses, a cut last line ends in an ellipsis', () => {
    expect(wrapCells('abc def ghi', 4, 5)).toEqual(['abc', 'def', 'ghi'])
    expect(wrapCells('a\n\n  b', 10, 2)).toEqual(['a b'])
    expect(wrapCells('一二三四五', 4, 2)).toEqual(['一二', '三…'])
    expect(wrapCells('', 4, 2)).toEqual([])
    expect(wrapCells('abc', 0, 2)).toEqual([])
  })
})

describe('fleet refresh', () => {
  const alpha = pathOf('/srv/alpha', 'sess-a')
  const alphaLog = jsonl(
    human(T0 - 10 * MIN, 'SECRET-PROMPT'),
    reply(T0 - 9 * MIN, 'm1', [thinking], use(100, 50)),
    reply(T0 - 9 * MIN, 'm1', [toolUse('Bash')], use(100, 50)),
    reply(T0 - 2 * MIN, 'm2', [text('SECRET-REPLY')], use(10, 5)),
  )

  test('a refresh lists every claude pane with its tail, today and the quota', async () => {
    const w: World = {
      panes: [
        pane({ agent_status: 'blocked' }),
        pane({ pane_id: 'w2:p2', label: 'Bravo build', agent_status: 'working', workspace_id: 'w2', agent_session: undefined }),
        pane({ pane_id: 'w2:p3', agent: 'codex' }),
      ],
      files: { [alpha]: alphaLog },
      quota: limitsJson(92),
      calls: [],
    }
    const { view, cursor } = await refreshFleet(fakeIo(w), EMPTY_FLEET, {}, T0)
    expect(view.linkLost).toBe(false)
    expect(view.scanning).toBe(false)
    expect(view.at).toBe(T0)
    expect(view.sessions.map(s => s.paneId)).toEqual(['w1:p1', 'w2:p2'])
    const a = view.sessions[0]
    expect([a?.status, a?.lastUser, a?.lastReply, a?.tools, a?.todayTokens]).toEqual(['blocked', 'SECRET-PROMPT', 'SECRET-REPLY', 1, 165])
    expect(view.sessions[1]?.lastUser).toBeUndefined()
    expect(view.quota?.sevenDay?.usedPct).toBe(92)
    expect(cursor[alpha]?.offset).toBe(utf8Len(alphaLog))
    expect(w.calls.some(c => c[0] === 'tail' && c[2] === String(TAIL_BYTES))).toBe(true)
  })

  test('an unchanged transcript is not read again', async () => {
    const w: World = { panes: [pane()], files: { [alpha]: alphaLog }, calls: [] }
    const io = fakeIo(w)
    const first = await refreshFleet(io, EMPTY_FLEET, {}, T0)
    const before = tails(w)
    const second = await refreshFleet(io, first.view, first.cursor, T0 + 5000)
    expect(tails(w)).toBe(before)
    expect(second.view.sessions[0]?.todayTokens).toBe(165)
    expect(second.view.sessions[0]?.lastReply).toBe('SECRET-REPLY')
  })

  test('herdr down keeps the last fleet, flagged lost, the cursor untouched', async () => {
    const w: World = { panes: [pane()], files: { [alpha]: alphaLog }, calls: [] }
    const first = await refreshFleet(fakeIo(w), EMPTY_FLEET, {}, T0)
    w.herdr = false
    const lost = await refreshFleet(fakeIo(w), first.view, first.cursor, T0 + 5000)
    expect(lost.view.linkLost).toBe(true)
    expect(lost.view.sessions).toEqual(first.view.sessions)
    expect(lost.cursor).toBe(first.cursor)
  })

  test('a first scan cut at the output limit resumes where complete lines end, counting nothing twice', async () => {
    const lines: string[] = []
    for (let i = 0; i < 40; i += 1) {
      lines.push(reply(T0 - 50 * MIN + i * MIN, `m${i}`, [thinking], use(10, 1)))
      lines.push(reply(T0 - 50 * MIN + i * MIN, `m${i}`, [toolUse('Read')], use(10, 1)))
    }
    const big = jsonl(...lines)
    const w: World = { panes: [pane()], files: { [alpha]: big }, cap: 700, calls: [] }
    const io = fakeIo(w)
    let state = await refreshFleet(io, EMPTY_FLEET, {}, T0)
    expect(state.view.scanning).toBe(true)
    for (let i = 0; i < 200 && (state.cursor[alpha]?.offset ?? 0) < utf8Len(big); i += 1) {
      state = await refreshFleet(io, state.view, state.cursor, T0)
    }
    expect(state.cursor[alpha]?.offset).toBe(utf8Len(big))
    expect(state.view.sessions[0]?.todayTokens).toBe(40 * 11)
    // the round that got there still had its tail cut; the next reads nothing
    expect(state.view.scanning).toBe(true)
    const before = tails(w)
    state = await refreshFleet(io, state.view, state.cursor, T0)
    expect(tails(w)).toBe(before)
    expect(state.view.scanning).toBe(false)
  })

  test('reads stop at MAX_READS; the rest wait for the next refresh', async () => {
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6']
    const files = Object.fromEntries(ids.map(id => [pathOf('/srv/alpha', id), alphaLog]))
    const w: World = {
      panes: ids.map((id, i) => pane({ pane_id: `w1:p${i}`, agent_session: { value: id } })),
      files,
      calls: [],
    }
    const io = fakeIo(w)
    const first = await refreshFleet(io, EMPTY_FLEET, {}, T0)
    expect(tails(w)).toBeLessThanOrEqual(MAX_READS)
    expect(first.view.sessions.filter(s => s.lastReply !== undefined).length).toBeLessThan(ids.length)
    expect(first.view.scanning).toBe(true)
    const second = await refreshFleet(io, first.view, first.cursor, T0 + 5000)
    expect(second.view.sessions.every(s => s.lastReply === 'SECRET-REPLY')).toBe(true)
    expect(second.view.scanning).toBe(false)
  })

  test('a refresh that spends every read, each file read to its end, is done scanning', async () => {
    const ids = ['s1', 's2', 's3', 's4']
    const files = Object.fromEntries(ids.map(id => [pathOf('/srv/alpha', id), alphaLog]))
    const w: World = { panes: ids.map((id, i) => pane({ pane_id: `w1:p${i}`, agent_session: { value: id } })), files, calls: [] }
    const first = await refreshFleet(fakeIo(w), EMPTY_FLEET, {}, T0)
    expect(tails(w)).toBe(MAX_READS)
    expect(first.view.sessions.every(s => s.lastReply === 'SECRET-REPLY')).toBe(true)
    expect(first.view.scanning).toBe(false)
  })

  describe('scanning is today\'s first catch-up, not a busy fleet', () => {
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6']
    const busy = (): World => ({
      panes: ids.map((id, i) => pane({ pane_id: `w1:p${i}`, agent_session: { value: id } })),
      files: Object.fromEntries(ids.map(id => [pathOf('/srv/alpha', id), alphaLog])),
      mtime: {},
      calls: [],
    })
    // every session speaks again: each file needs its tail and its new bytes, 12 reads a round
    const speak = (w: World, at: number, round: number) => {
      for (const id of ids) {
        const p = pathOf('/srv/alpha', id)
        w.files[p] = (w.files[p] ?? '') + jsonl(reply(at - MIN, `${id}-r${round}`, [text(`r${round}`)], use(1, 1)))
        ;(w.mtime ??= {})[p] = at + round
      }
    }

    test('six busy sessions: once every file caught up, scanning stays off though each round runs out of reads', async () => {
      const w = busy()
      const io = fakeIo(w)
      let state = await refreshFleet(io, EMPTY_FLEET, {}, T0)
      expect(state.view.scanning).toBe(true)
      const seen: boolean[] = []
      for (let r = 1; r <= 6; r += 1) {
        speak(w, T0, r)
        const before = tails(w)
        state = await refreshFleet(io, state.view, state.cursor, T0 + r * 5000)
        expect(tails(w) - before).toBe(MAX_READS)
        seen.push(state.view.scanning)
      }
      expect(ids.every(id => state.cursor[pathOf('/srv/alpha', id)]?.caughtUpDay === dayKey(T0))).toBe(true)
      expect(seen.slice(-3)).toEqual([false, false, false])
    })

    test('six busy sessions: the longest unread is read first, so every one is brought up to date in three rounds', async () => {
      const w = busy()
      const io = fakeIo(w)
      let state = await refreshFleet(io, EMPTY_FLEET, {}, T0)
      for (let r = 1; r <= 3; r += 1) {
        speak(w, T0, r)
        state = await refreshFleet(io, state.view, state.cursor, T0 + r * 5000)
      }
      expect(state.view.sessions.map(s => s.paneId)).toEqual(ids.map((_, i) => `w1:p${i}`))
      expect(state.view.sessions.every(s => /^r[123]$/.test(s.lastReply ?? ''))).toBe(true)
      expect(state.view.sessions.every(s => s.todayTokens > 165)).toBe(true)
    })

    test('a new day scans again until each file has caught up that day', async () => {
      const w = busy()
      const io = fakeIo(w)
      let state = await refreshFleet(io, EMPTY_FLEET, {}, T0)
      for (let r = 1; r <= 3; r += 1) state = await refreshFleet(io, state.view, state.cursor, T0 + r * 5000)
      expect(state.view.scanning).toBe(false)
      const tomorrow = T0 + 24 * 60 * MIN
      speak(w, tomorrow, 9)
      state = await refreshFleet(io, state.view, state.cursor, tomorrow)
      expect(state.view.scanning).toBe(true)
    })

    test('a large file cut at the output limit scans until it is read to its end', async () => {
      const lines: string[] = []
      for (let i = 0; i < 40; i += 1) lines.push(reply(T0 - 50 * MIN + i * MIN, `m${i}`, [text('x')], use(10, 1)))
      const big = jsonl(...lines)
      const w: World = { panes: [pane()], files: { [alpha]: big }, cap: 700, calls: [] }
      const io = fakeIo(w)
      let state = await refreshFleet(io, EMPTY_FLEET, {}, T0)
      while ((state.cursor[alpha]?.offset ?? 0) < utf8Len(big)) {
        expect(state.view.scanning).toBe(true)
        state = await refreshFleet(io, state.view, state.cursor, T0)
      }
      state = await refreshFleet(io, state.view, state.cursor, T0)
      expect(state.view.scanning).toBe(false)
    })
  })

  test('scanning holds before the first refresh and while herdr is lost', async () => {
    expect(EMPTY_FLEET.scanning).toBe(true)
    const w: World = { panes: [pane()], files: { [alpha]: alphaLog }, herdr: false, calls: [] }
    const lost = await refreshFleet(fakeIo(w), EMPTY_FLEET, {}, T0)
    expect([lost.view.linkLost, lost.view.scanning]).toEqual([true, true])
  })

  test('a missing transcript shows the pane from herdr alone', async () => {
    const w: World = { panes: [pane({ agent_status: 'working' }), pane({ pane_id: 'w1:p2', agent_session: { value: 'sess-b' } })], files: { [alpha]: alphaLog }, calls: [] }
    const { view } = await refreshFleet(fakeIo(w), EMPTY_FLEET, {}, T0)
    const b = view.sessions.find(s => s.paneId === 'w1:p2')
    expect([b?.title, b?.status, b?.lastReply, b?.todayTokens]).toEqual(['Alpha review', 'idle', undefined, 0])
    expect(view.sessions.find(s => s.paneId === 'w1:p1')?.lastReply).toBe('SECRET-REPLY')
  })

  test('a new day starts today at zero without reading an unchanged file', async () => {
    const sub = subOf('/srv/alpha', 'sess-a', 'agent-x.jsonl')
    const w: World = { panes: [pane()], files: { [alpha]: alphaLog, [sub]: jsonl(reply(T0 - MIN, 's1', [text('x')], use(1, 1))) }, calls: [] }
    const io = fakeIo(w)
    const first = await refreshFleet(io, EMPTY_FLEET, {}, T0)
    const before = tails(w)
    const tomorrow = T0 + 24 * 60 * MIN
    const next = await refreshFleet(io, first.view, first.cursor, tomorrow)
    expect(tails(w)).toBe(before)
    expect(next.view.sessions[0]?.todayTokens).toBe(0)
    expect(next.cursor[alpha]?.day).toBe(dayKey(tomorrow))
    expect(next.cursor[sub]?.day).toBe(dayKey(tomorrow))
  })

  test('a shrunk transcript is counted again from the start', async () => {
    const w: World = { panes: [pane()], files: { [alpha]: alphaLog }, mtime: { [alpha]: T0 + 1 }, calls: [] }
    const io = fakeIo(w)
    const first = await refreshFleet(io, EMPTY_FLEET, {}, T0)
    w.files[alpha] = jsonl(reply(T0 - MIN, 'n1', [text('fresh')], use(1, 1)))
    w.mtime = { [alpha]: T0 + 2 }
    const next = await refreshFleet(io, first.view, first.cursor, T0 + 5000)
    expect(next.view.sessions[0]?.todayTokens).toBe(2)
    expect(next.view.sessions[0]?.lastReply).toBe('fresh')
  })

  test('today counts the subagents of a session, each read again only when it grew', async () => {
    const sub = subOf('/srv/alpha', 'sess-a', 'agent-x.jsonl')
    const subLog = jsonl(reply(T0 - 3 * MIN, 's1', [text('SUB-REPLY')], use(20, 7)))
    const w: World = { panes: [pane()], files: { [alpha]: alphaLog, [sub]: subLog }, calls: [] }
    const io = fakeIo(w)
    const first = await refreshFleet(io, EMPTY_FLEET, {}, T0)
    expect(first.view.sessions[0]?.todayTokens).toBe(165 + 27)
    expect(first.view.sessions[0]?.lastReply).toBe('SECRET-REPLY')
    expect(first.view.scanning).toBe(false)
    expect(first.cursor[sub]?.offset).toBe(utf8Len(subLog))
    expect(w.calls.filter(c => c[0] === 'tail' && c[3] === sub).map(c => c[2])).toEqual(['+1'])

    const before = tails(w)
    const second = await refreshFleet(io, first.view, first.cursor, T0 + 5000)
    expect(tails(w)).toBe(before)
    expect(second.view.sessions[0]?.todayTokens).toBe(192)

    w.files[sub] = subLog + jsonl(reply(T0 - MIN, 's2', [text('more')], use(3, 3)))
    w.mtime = { [sub]: T0 + 2 }
    const third = await refreshFleet(io, second.view, second.cursor, T0 + 10_000)
    expect(third.view.sessions[0]?.todayTokens).toBe(198)
    expect(w.calls.filter(c => c[0] === 'tail' && c[3] === sub).map(c => c[2])).toEqual(['+1', `+${utf8Len(subLog) + 1}`])
  })

  test('a subagent waiting on MAX_READS keeps scanning on', async () => {
    const ids = ['s1', 's2', 's3', 's4']
    const files: Record<string, string> = {}
    for (const id of ids) {
      files[pathOf('/srv/alpha', id)] = alphaLog
      files[subOf('/srv/alpha', id, 'agent-a.jsonl')] = jsonl(reply(T0 - MIN, `${id}-a`, [text('x')], use(1, 1)))
    }
    const w: World = { panes: ids.map((id, i) => pane({ pane_id: `w1:p${i}`, agent_session: { value: id } })), files, calls: [] }
    const io = fakeIo(w)
    const first = await refreshFleet(io, EMPTY_FLEET, {}, T0)
    expect(tails(w)).toBeLessThanOrEqual(MAX_READS)
    expect(first.view.scanning).toBe(true)
    let state = first
    for (let i = 0; i < 5 && state.view.scanning; i += 1) state = await refreshFleet(io, state.view, state.cursor, T0)
    expect(state.view.scanning).toBe(false)
    expect(state.view.sessions.map(s => s.todayTokens)).toEqual([167, 167, 167, 167])
  })

  describe('a cold start reads today only', () => {
    const oldLog = jsonl(human(YESTERDAY - MIN, 'old ask'), reply(YESTERDAY, 'y1', [text('OLD-REPLY')], use(100, 50)))
    const subs = Array.from({ length: 12 }, (_, i) => subOf('/srv/alpha', 'sess-a', `agent-${i}.jsonl`))

    test('files last written before today: no use read, the main one its tail once, scanning done at once', async () => {
      const files: Record<string, string> = { [alpha]: oldLog }
      const mtime: Record<string, number> = { [alpha]: MIDNIGHT - 1 }
      for (const s of subs) {
        files[s] = jsonl(reply(YESTERDAY, s, [text('x')], use(5, 5)))
        mtime[s] = YESTERDAY
      }
      const w: World = { panes: [pane()], files, mtime, calls: [] }
      const io = fakeIo(w)
      const { view, cursor } = await refreshFleet(io, EMPTY_FLEET, {}, T0)
      expect(w.calls.filter(c => c[0] === 'tail').map(c => [c[2], c[3]])).toEqual([[String(TAIL_BYTES), alpha]])
      expect(view.scanning).toBe(false)
      expect([view.sessions[0]?.todayTokens, view.sessions[0]?.lastReply]).toEqual([0, 'OLD-REPLY'])
      for (const p of [alpha, ...subs]) {
        const f = cursor[p]
        expect([f?.offset, f?.size, f?.day, f?.tokens, f?.caughtUpDay]).toEqual([utf8Len(files[p] ?? ''), utf8Len(files[p] ?? ''), dayKey(T0), 0, dayKey(T0)])
      }
      expect(cursor[subs[0] ?? '']?.readAt).toBeUndefined()
      const before = tails(w)
      const next = await refreshFleet(io, view, cursor, T0 + 5000)
      expect(tails(w)).toBe(before)
      expect(next.view.sessions[0]?.lastReply).toBe('OLD-REPLY')
    })

    test('a file written today is counted from its start as before', async () => {
      const sub = subOf('/srv/alpha', 'sess-a', 'agent-t.jsonl')
      const w: World = {
        panes: [pane()],
        files: { [alpha]: alphaLog, [sub]: jsonl(reply(T0 - 3 * MIN, 's1', [text('x')], use(20, 7))) },
        mtime: { [alpha]: MIDNIGHT + MIN, [sub]: T0 - MIN },
        calls: [],
      }
      const { view } = await refreshFleet(fakeIo(w), EMPTY_FLEET, {}, T0)
      expect(w.calls.filter(c => c[0] === 'tail' && c[2] === '+1').map(c => c[3])).toEqual([alpha, sub])
      expect([view.sessions[0]?.todayTokens, view.scanning]).toEqual([165 + 27, false])
    })

    test('a new day goes on from the last offset of a file that grew today', async () => {
      const w: World = { panes: [pane()], files: { [alpha]: oldLog }, mtime: { [alpha]: YESTERDAY }, calls: [] }
      const io = fakeIo(w)
      const first = await refreshFleet(io, EMPTY_FLEET, {}, YESTERDAY + MIN)
      expect(first.view.sessions[0]?.todayTokens).toBe(150)
      w.files[alpha] = oldLog + jsonl(reply(T0 - MIN, 'n1', [text('NEW-REPLY')], use(1, 1)))
      w.mtime = { [alpha]: T0 - MIN }
      const next = await refreshFleet(io, first.view, first.cursor, T0)
      expect(w.calls.filter(c => c[0] === 'tail' && c[2]?.startsWith('+')).map(c => c[2])).toEqual(['+1', `+${utf8Len(oldLog) + 1}`])
      expect([next.view.sessions[0]?.todayTokens, next.view.sessions[0]?.lastReply, next.view.scanning]).toEqual([2, 'NEW-REPLY', false])
    })
  })

  test('a subagents folder that fails to list for a moment keeps its files as they were', async () => {
    const sub = subOf('/srv/alpha', 'sess-a', 'agent-x.jsonl')
    const w: World = { panes: [pane()], files: { [alpha]: alphaLog, [sub]: jsonl(reply(T0 - 3 * MIN, 's1', [text('x')], use(20, 7))) }, calls: [] }
    const io = fakeIo(w)
    const first = await refreshFleet(io, EMPTY_FLEET, {}, T0)
    w.listFails = true
    const second = await refreshFleet(io, first.view, first.cursor, T0 + 5000)
    expect(second.cursor[sub]).toEqual(first.cursor[sub])
    expect(second.view.sessions[0]?.todayTokens).toBe(192)
    w.listFails = false
    const before = tails(w)
    const third = await refreshFleet(io, second.view, second.cursor, T0 + 10_000)
    expect(tails(w)).toBe(before)
    expect(third.view.sessions[0]?.todayTokens).toBe(192)
  })

  test('no subagents folder is no subagents', async () => {
    const w: World = { panes: [pane()], files: { [alpha]: alphaLog }, calls: [] }
    const { view } = await refreshFleet(fakeIo(w), EMPTY_FLEET, {}, T0)
    expect([view.sessions[0]?.todayTokens, view.scanning]).toEqual([165, false])
  })

  test('jump: herdr focuses the pane; an error is kept per pane until cleared', () => {
    expect(focusArgv('w1:p1')).toEqual(['herdr', 'agent', 'focus', 'w1:p1'])
    const err = withJump(EMPTY_FLEET, { paneId: 'w1:p1', text: 'x' })
    expect(err.jumpError).toEqual({ paneId: 'w1:p1', text: 'x' })
    expect(withJump(err, undefined).jumpError).toBeUndefined()
  })

  test('the herdr pane list is the first command of a refresh', async () => {
    const w: World = { panes: [], files: {}, calls: [] }
    await refreshFleet(fakeIo(w), EMPTY_FLEET, {}, T0)
    expect(w.calls[0]).toEqual([...PANE_LIST])
  })
})

type Node = { type?: string; props?: Record<string, unknown>; children?: (Node | string)[] }

const textOf = (n: Node | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''))

const linesOf = (n: Node | string): string[] => {
  if (typeof n === 'string') return [n]
  if (n.type === 'Text') return [textOf(n)]
  const kids = n.children ?? []
  if (n.props?.flexDirection === 'row') return [kids.map(textOf).join('')]
  return kids.flatMap(linesOf)
}

// every row of texts side by side
const rowNodes = (n: Node | string, out: Node[] = []): Node[] => {
  if (typeof n === 'string') return out
  const kids = n.children ?? []
  if (n.props?.flexDirection === 'row' && kids.length > 0 && kids.every(k => typeof k !== 'string' && k.type === 'Text')) out.push(n)
  for (const k of kids) rowNodes(k, out)
  return out
}

const allTexts = (n: Node | string, out: Node[] = []): Node[] => {
  if (typeof n === 'string') return out
  if (n.type === 'Text') out.push(n)
  for (const k of n.children ?? []) allTexts(k, out)
  return out
}

const buttons = (n: Node | string, out: Node[] = []): Node[] => {
  if (typeof n === 'string') return out
  if (n.type === 'Button') out.push(n)
  for (const k of n.children ?? []) buttons(k, out)
  return out
}

// each drawn row's width: a row of texts and plain Buttons side by side, a plain Button's
// hotkey drawn as `1: ` before its label
const rowWidths = (n: Node | string): number[] => {
  if (typeof n === 'string') return [cellWidth(n)]
  if (n.type === 'Text') return [cellWidth(textOf(n))]
  const kids = n.children ?? []
  const cells = (k: Node) =>
    cellWidth(textOf(k)) + (k.type === 'Button' && k.props?.['hotkey'] ? cellWidth(`${String(k.props['hotkey'])}: `) : 0)
  if (
    n.props?.flexDirection === 'row' &&
    kids.every(k => typeof k !== 'string' && (k.type === 'Text' || (k.type === 'Button' && k.props?.['plain'])))
  ) {
    return [kids.reduce((sum, k) => sum + cells(k as Node), 0)]
  }
  return kids.flatMap(rowWidths)
}

const tabBarButtons = (tree: Node): Node[] =>
  buttons(tree).filter(b => /^(tab-|back$|pause$|jump$)/.test(String(b.props?.['key'] ?? '')))

// the tab bar's width: each plain Button is `N: ` + label, one cell apart
const tabBarWidth = (tree: Node): number => {
  const tabs = tabBarButtons(tree)
  return tabs.reduce((n, b) => n + cellWidth(`${String(b.props?.['hotkey'])}: `) + cellWidth(textOf(b)), 0) + Math.max(0, tabs.length - 1)
}

const draw = async ($: Engine, rows = 40, cols = 80): Promise<Node> =>
  (await $.ui.render({
    surface: 'terminal',
    component: 'Pane',
    requestId: 'jarvis',
    viewport: { columns: cols + 20, rows: rows + 10 },
    props: { title: 'Jarvis', isFocused: false, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
  })) as RenderElement as Node

const press = async ($: Engine, key: string, rows = 40, cols = 80) => {
  const ui = await $.ui.mount({
    plugin: 'jarvis',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'jarvis',
    props: { title: 'Jarvis', isFocused: true, bodyColumns: cols, placement: 'dock' as const, scroll: { offset: 0, bodyRows: rows }, view: {} },
    viewport: { columns: cols + 20, rows: rows + 10 },
  })
  await ui.press({ key })
  await ui.unmount()
}

// the world beneath the mod: herdr, the transcripts, the usagebar cache, all fake
const fleetEngine = (on: On, w: World) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME, HERDR_ENV: '1', HERDR_PANE_ID: 'w2:p9' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('process.run', async (_$, e) => {
    const out = (await fakeIo(w).run(e.argv)) ?? { exitCode: 1, stdout: '', stderr: '', truncated: false }
    return { value: { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr, isStdoutTruncated: out.truncated, isStderrTruncated: false } }
  })
  on('fs.stat', async (_$, e) => {
    const c = w.files[e.path]
    if (c === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: utf8Len(c), mtimeMs: w.mtime?.[e.path] ?? T0, isLink: false } }
  })
  on('fs.read', async (_$, e) => {
    if (e.path === `${HOME}/${LIMITS_PATH}` && w.quota !== undefined) return { value: w.quota }
    throw new Error('ENOENT')
  })
  on('fs.list', async (_$, e) => {
    const out = await fakeIo(w).list(e.path)
    if (out === undefined) return { deny: 'ENOENT' }
    return { value: out.map(x => ({ ...x, kind: 'file' as const, isLink: false })) }
  })
  on('session.id', async () => ({ value: w.selfId ?? 'sess-self' }))
  return clock
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

const SAMPLE_PANES = [
  pane({ pane_id: 'w1:p1', label: 'Alpha review', agent_status: 'blocked' }),
  pane({ pane_id: 'w2:p2', label: 'Bravo build', agent_status: 'working', workspace_id: 'w2', agent_session: { value: 'sess-b' }, cwd: '/srv/bravo' }),
  pane({ pane_id: 'w1:p3', label: 'Charlie docs', agent_session: { value: 'sess-c' }, cwd: '/srv/charlie', tokens: { context: '⛁ 95% (950k)' } }),
  pane({ pane_id: 'w1:p4', agent: 'codex', label: 'Codex job' }),
]

const sampleWorld = (over: Partial<World> = {}): World => ({
  panes: SAMPLE_PANES,
  files: {
    [pathOf('/srv/alpha', 'sess-a')]: jsonl(human(T0 - 3 * MIN, 'SECRET-PROMPT'), reply(T0 - 2 * MIN, 'a1', [text('SECRET-REPLY')], use(100, 50))),
    [pathOf('/srv/bravo', 'sess-b')]: jsonl(reply(T0 - MIN, 'b1', [toolUse('Bash')], use(10, 5))),
    [pathOf('/srv/charlie', 'sess-c')]: jsonl(reply(T0 - 26 * 60 * MIN, 'c1', [text('old')], use(1, 1))),
  },
  quota: limitsJson(92),
  calls: [],
  ...over,
})

// opens the fleet page and lets its first refresh land
const openFleet = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, rows = 40, cols = 80) => {
  await start($)
  await press($, 'tab-fleet', rows, cols)
  await draw($, rows, cols)
  await clock.advance(10)
  return draw($, rows, cols)
}

const paneLists = (w: World) => w.calls.filter(c => c[0] === 'herdr' && c[1] === 'pane' && c[2] === 'list').length

const ALLOWED = new Set<string>([...Object.values(THEME), ...Object.values(FAMILY_COLOR), ...GAUGE_RAMP, ...BURN_RAMP])

describe('fleet page', () => {
  test('the list never shows what was said', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    const lines = linesOf(await openFleet($, clock)).join('\n')
    expect(lines).not.toContain('SECRET-PROMPT')
    expect(lines).not.toContain('SECRET-REPLY')
  })

  for (const cols of [40, 64, 80]) {
    test(`no row is wider than ${cols} columns, the tab bar included`, async ($, on) => {
      const w = sampleWorld()
      const clock = fleetEngine(on, w)
      const tree = await openFleet($, clock, 40, cols)
      expect(Math.max(...rowWidths(tree))).toBeLessThanOrEqual(cols)
      expect(tabBarWidth(tree)).toBeLessThanOrEqual(cols)
    })
  }

  for (const cols of [40, 64, 80]) {
    for (const [name, quota] of [['stale', limitsJson(92, T0 - 16 * MIN)], ['used-up', limitsJson(100)]] as const) {
      test(`a ${name} quota stays within ${cols} columns`, async ($, on) => {
        const w = sampleWorld({ quota })
        const clock = fleetEngine(on, w)
        const tree = await openFleet($, clock, 40, cols)
        expect(Math.max(...rowWidths(tree))).toBeLessThanOrEqual(cols)
      })
    }
  }

  test('the tab bar fits 40 columns on every page', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    await openFleet($, clock, 40, 40)
    for (const key of ['tab-now', 'tab-log', 'tab-stats', 'tab-fleet', 'suit-1']) {
      await press($, key, 40, 40)
      const tree = await draw($, 40, 40)
      expect(tabBarWidth(tree)).toBeLessThanOrEqual(40)
      for (const b of tabBarButtons(tree)) expect([b.props?.['key'], b.props?.['plain']]).toEqual([b.props?.['key'], true])
    }
  })

  test('herdr down: FLEET LINK LOST, the last suits kept', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    await openFleet($, clock)
    w.herdr = false
    await clock.advance(FLEET_MS)
    const lines = linesOf(await draw($)).join('\n')
    expect(lines).toContain('FLEET LINK LOST')
    expect(lines).toContain('Alpha review')
  })

  test('herdr is asked only while the fleet page is in view', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    await start($)
    await draw($)
    await clock.advance(20_000)
    expect(paneLists(w)).toBe(0)
    await press($, 'tab-fleet')
    await draw($)
    await clock.advance(FLEET_MS + 10)
    expect(paneLists(w)).toBeGreaterThanOrEqual(2)
    await press($, 'tab-now')
    await draw($)
    await clock.advance(30_000)
    const settled = paneLists(w)
    await clock.advance(30_000)
    expect(paneLists(w)).toBe(settled)
  })

  test('leaving the fleet page stops the poll at its next tick', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    await openFleet($, clock)
    await press($, 'tab-now')
    await draw($)
    const before = paneLists(w)
    await clock.advance(FLEET_MS)
    expect(paneLists(w)).toBe(before)
  })

  test('a drawing that lands after the next tick does not stop the poll', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    await openFleet($, clock)
    const before = paneLists(w)
    await clock.advance(FLEET_MS + 800)
    // the drawing after that refresh is late: the next tick comes first
    await clock.advance(FLEET_MS)
    expect(paneLists(w) - before).toBe(2)
    await draw($)
    await clock.advance(FLEET_MS)
    expect(paneLists(w) - before).toBe(3)
  })

  test('a session started again leaves one fleet poll: one pane list each FLEET_MS', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    await openFleet($, clock)
    await start($)
    await draw($)
    await clock.advance(10)
    for (let i = 0; i < 3; i += 1) {
      const before = paneLists(w)
      await draw($)
      await clock.advance(FLEET_MS)
      expect(paneLists(w) - before).toBe(1)
    }
  })

  test('the dashboard: rings, the burn, then the legion, the waiting before the working before the idle', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    const lines = linesOf(await openFleet($, clock)).join('\n')
    expect(lines).toContain('IRON LEGION · 3 SUITS')
    const order: number[] = []
    for (const t of ['ARC REACTOR', 'TODAY BURN', '── IRON LEGION', 'Alpha review', 'AWAITING', 'Bravo build', 'ACTIVE', 'Charlie docs', 'RETIRE']) {
      order.push(lines.indexOf(t, (order.at(-1) ?? -1) + 1))
    }
    expect(order.every(x => x >= 0)).toBe(true)
    expect(lines).not.toContain('Codex job')
  })

  test('ARC REACTOR: 92% weekly runs out before the reset, 5h resets, the burn adds up today', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    const lines = linesOf(await openFleet($, clock)).join('\n')
    expect(lines).toMatch(/7D  92%/)
    expect(lines).toMatch(/DEPLETED ~\d+h/)
    expect(lines).toMatch(/5H  5%/)
    expect(lines).toMatch(/RESET \d\d:\d\d/)
    expect(lines).toMatch(/TODAY BURN ─+ Σ 165 TOK ──/)
  })

  test('a busy card reads the model, the tool in flight, the run and today', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    const lines = linesOf(await openFleet($, clock)).join('\n')
    expect(lines).toMatch(/Opus 5\.5 · Bash/)
    expect(lines).toMatch(/Opus 5\.5 · 3m/)
    expect(lines).toMatch(/TODAY 150 · \$\d+\.\d+/)
  })

  test('a stale quota says STALE with its reset and makes no forecast', async ($, on) => {
    const w = sampleWorld({ quota: limitsJson(92, T0 - 16 * MIN) })
    const clock = fleetEngine(on, w)
    const lines = linesOf(await openFleet($, clock)).join('\n')
    expect(lines).toMatch(/STALE · RESET \d\d:\d\d/)
    expect(lines).not.toContain('DEPLETED')
  })

  test('a window that runs out first burns its ring and foot red; the other stays cool', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    const tree = await openFleet($, clock)
    const texts = allTexts(tree)
    expect(texts.find(t => textOf(t).trim().startsWith('DEPLETED'))?.props?.['color']).toBe(THEME.error)
    expect(texts.find(t => textOf(t).trim().startsWith('RESET'))?.props?.['color']).toBe(THEME.frame)
    expect(texts.some(t => /[▀▄█]/.test(textOf(t)) && (t.props?.['color'] === THEME.error || t.props?.['backgroundColor'] === THEME.error))).toBe(true)
  })

  test('a window used up reads DEPLETED, not a countdown', async ($, on) => {
    const w = sampleWorld({ quota: limitsJson(100) })
    const clock = fleetEngine(on, w)
    const tree = await openFleet($, clock)
    expect(allTexts(tree).find(t => textOf(t).trim() === 'DEPLETED')?.props?.['color']).toBe(THEME.error)
    expect(linesOf(tree).join('\n')).not.toMatch(/DEPLETED ~/)
  })

  test('a full context is red; an idle suit past a day reads RETIRE', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    const tree = await openFleet($, clock)
    expect(allTexts(tree).find(t => textOf(t).trim() === '95%')?.props?.['color']).toBe(THEME.error)
    expect(linesOf(tree).find(l => l.includes('Charlie docs'))).toContain('RETIRE')
  })

  test('only the corner and icon of a card are its Button; 1-9 carry their hotkey', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    const suits = buttons(await openFleet($, clock)).filter(b => String(b.props?.['key'] ?? '').startsWith('suit-'))
    expect(suits.map(b => [b.props?.['key'], b.props?.['hotkey'], b.props?.['plain'], textOf(b)])).toEqual([
      ['suit-1', '1', true, '╭─ ▲'],
      ['suit-2', '2', true, '╭─ ◆'],
      ['suit-3', '3', true, '╭─ ◇'],
    ])
  })

  test('every text the fleet page draws wears a theme color, a ramp color or a model color', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    const bad = allTexts(await openFleet($, clock))
      .filter(t => textOf(t).trim() !== '')
      .filter(t => !ALLOWED.has(String(t.props?.['color'] ?? '')) || (t.props?.['backgroundColor'] !== undefined && !ALLOWED.has(String(t.props['backgroundColor']))))
      .map(textOf)
    expect(bad).toEqual([])
  })

  test('many idle suits fold into the standby summary; the rings and the waiting stay', async ($, on) => {
    const many = Array.from({ length: 30 }, (_, i) => pane({ pane_id: `w1:x${i}`, label: `Idle ${i}`, agent_session: { value: `idle-${i}` } }))
    const w = sampleWorld({ panes: [pane({ agent_status: 'blocked', label: 'Alpha review' }), ...many] })
    const clock = fleetEngine(on, w)
    const lines = linesOf(await openFleet($, clock, 24, 80)).join('\n')
    expect(lines).toContain('ARC REACTOR')
    expect(lines).toContain('Alpha review')
    expect(lines).toContain('STANDBY 30 艘')
  })

  test('too many busy suits for the rows are cut with a count', async ($, on) => {
    const busy = Array.from({ length: 8 }, (_, i) => pane({ pane_id: `w1:b${i}`, label: `Busy ${i}`, agent_status: 'working', agent_session: { value: `busy-${i}` } }))
    const w = sampleWorld({ panes: busy })
    const clock = fleetEngine(on, w)
    const tree = await openFleet($, clock, 12, 80)
    expect(linesOf(tree).join('\n')).toMatch(/… 還有 \d+ 艘/)
    expect(linesOf(tree).length).toBeLessThanOrEqual(12)
  })

  test('Σ reads SCANNING… until the first scan has caught up', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    await start($)
    await press($, 'tab-fleet')
    expect(linesOf(await draw($)).join('\n')).toContain('Σ SCANNING…')
    await clock.advance(10)
    const lines = linesOf(await draw($)).join('\n')
    expect(lines).not.toContain('SCANNING…')
    expect(lines).toContain('Σ 165 TOK')
  })

  test('this session is marked THIS, in the frame color', async ($, on) => {
    const w = sampleWorld({ selfId: 'sess-c' })
    const clock = fleetEngine(on, w)
    const tree = await openFleet($, clock)
    const lines = linesOf(tree)
    expect(lines.find(l => l.includes('Charlie docs'))).toMatch(/Charlie docs THIS/)
    expect(lines.filter(l => /\bTHIS\b/.test(l))).toHaveLength(1)
    expect(allTexts(tree).find(t => textOf(t).trim() === 'THIS')?.props?.['color']).toBe(THEME.frame)
  })

  test('mid: idle cards two abreast; narrow: every suit a line and the rings bars; wide: big rings side by side', async ($, on) => {
    const idle = ['Delta', 'Echo', 'Foxtrot'].map((label, i) => pane({ pane_id: `w1:i${i}`, label, agent_session: { value: `idle-${i}` } }))
    const w = sampleWorld({ panes: [...SAMPLE_PANES, ...idle] })
    const clock = fleetEngine(on, w)
    const mid = linesOf(await openFleet($, clock, 45, 65))
    expect(mid.some(l => (l.match(/╭─/g) ?? []).length === 2)).toBe(true)
    const narrow = linesOf(await draw($, 45, 44))
    expect(narrow.some(l => l.includes('╭─'))).toBe(false)
    expect(narrow.some(l => l.includes('▕'))).toBe(true)
    const wide = linesOf(await draw($, 60, 120))
    expect(wide.some(l => l.includes('5H') && l.includes('7D'))).toBe(true)
  })

  test('every width and height stays inside the pane', async ($, on) => {
    const idle = Array.from({ length: 7 }, (_, i) => pane({ pane_id: `w1:i${i}`, label: `閒置任務 ${i} 很長的標題`, agent_session: { value: `idle-${i}` } }))
    const w = sampleWorld({ panes: [...SAMPLE_PANES, ...idle] })
    const clock = fleetEngine(on, w)
    await openFleet($, clock)
    for (const cols of [40, 44, 65, 100]) {
      for (const rows of [8, 10, 14, 24, 45]) {
        const tree = await draw($, rows, cols)
        expect(Math.max(...rowWidths(tree))).toBeLessThanOrEqual(cols)
        expect(linesOf(tree).length).toBeLessThanOrEqual(rows)
      }
    }
  })

  test('suits past 9 carry their number inside the Button, no hotkey, no wider', async ($, on) => {
    const busy = Array.from({ length: 12 }, (_, i) => pane({ pane_id: `w1:b${i}`, label: `Busy ${i}`, agent_status: 'working', agent_session: { value: `busy-${i}` } }))
    const w = sampleWorld({ panes: busy })
    const clock = fleetEngine(on, w)
    const tree = await openFleet($, clock, 90, 80)
    const tenth = buttons(tree).find(b => b.props?.['key'] === 'suit-10')
    expect(tenth?.props?.['hotkey']).toBeUndefined()
    expect(textOf(tenth ?? {})).toMatch(/^10 /)
    expect(Math.max(...rowWidths(tree))).toBeLessThanOrEqual(80)
  })

  test('with rows to spare a blank line parts the sections; short of rows they close up', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    const roomy = linesOf(await openFleet($, clock))
    for (const head of ['── TODAY BURN', '── IRON LEGION']) {
      expect(roomy[roomy.findIndex(l => l.startsWith(head)) - 1]?.trim()).toBe('')
    }
    const tight = linesOf(await draw($, 12, 80))
    const legion = tight.findIndex(l => l.startsWith('── IRON LEGION'))
    expect(tight[legion - 1]?.trim()).not.toBe('')
  })

  test('idle cards side by side keep a cell between them', async ($, on) => {
    const idle = ['Delta', 'Echo'].map((label, i) => pane({ pane_id: `w1:i${i}`, label, agent_session: { value: `idle-${i}` } }))
    const w = sampleWorld({ panes: idle })
    const clock = fleetEngine(on, w)
    const lines = linesOf(await openFleet($, clock))
    expect(lines.some(l => l.includes('╮ ╭─'))).toBe(true)
    expect(lines.some(l => l.includes('╯    ╰'))).toBe(true)
  })

  test('with the burn chart gone, Σ moves to the IRON LEGION header', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    const lines = linesOf(await openFleet($, clock, 10, 80))
    expect(lines.join('\n')).not.toContain('TODAY BURN')
    expect(lines.find(l => l.includes('── IRON LEGION'))).toMatch(/Σ 165 TOK ──$/)
  })

  test('the idle cards draw today against one peak: a quiet suit stays low beside a busy one', async ($, on) => {
    const idle = [
      pane({ pane_id: 'w1:i0', label: 'Delta', cwd: '/srv/delta', agent_session: { value: 'sess-d' } }),
      pane({ pane_id: 'w1:i1', label: 'Echo', cwd: '/srv/echo', agent_session: { value: 'sess-e' } }),
    ]
    const w = sampleWorld({
      panes: idle,
      files: {
        [pathOf('/srv/delta', 'sess-d')]: jsonl(reply(T0 - 30 * MIN, 'd1', [text('x')], use(1000, 0))),
        [pathOf('/srv/echo', 'sess-e')]: jsonl(reply(T0 - 30 * MIN, 'e1', [text('x')], use(10, 0))),
      },
    })
    const clock = fleetEngine(on, w)
    const lines = linesOf(await openFleet($, clock))
    const row = lines[lines.findIndex(l => l.includes('Delta') && l.includes('Echo')) + 1] ?? ''
    const [delta, echo] = row.match(/[\u2800-\u28FF]+/g) ?? []
    expect(delta).toBeDefined()
    expect(echo).not.toBe(delta)
  })

  test('a quota file with no window in it draws no reactor', async ($, on) => {
    const w = sampleWorld({ quota: JSON.stringify({ fetchedAtMs: T0 }) })
    const clock = fleetEngine(on, w)
    const lines = linesOf(await openFleet($, clock)).join('\n')
    expect(lines).not.toContain('ARC REACTOR')
    expect(lines).toContain('── IRON LEGION')
  })

  test('one quota window draws one gauge; no quota file draws none, Σ stays', async ($, on) => {
    const only5h = JSON.stringify({ fiveHour: { usedPercentage: 5, resetsAt: Math.floor(T0 / 1000) + 120 * 60, windowMinutes: 300 }, fetchedAtMs: T0 })
    const w = sampleWorld({ quota: only5h })
    const clock = fleetEngine(on, w)
    const lines = linesOf(await openFleet($, clock)).join('\n')
    expect(lines).toContain('5H')
    expect(lines).not.toContain('7D')
    w.quota = undefined
    await clock.advance(FLEET_MS)
    const none = linesOf(await draw($)).join('\n')
    expect(none).not.toContain('ARC REACTOR')
    expect(none).toContain('Σ 165 TOK')
  })
})

describe('fleet detail page', () => {
  test('a number opens the suit: what was asked and answered, the model, today', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    await openFleet($, clock)
    await press($, 'suit-1')
    const lines = linesOf(await draw($)).join('\n')
    expect(lines).toContain('Alpha review')
    expect(lines).toContain('AWAITING ORDERS')
    expect(lines).toMatch(/最後提問\s*SECRET-PROMPT/)
    expect(lines).toMatch(/最後回覆\s*SECRET-REPLY/)
    expect(lines).toMatch(/模型\s*Opus 5\.5/)
    expect(lines).toMatch(/今日\s*150 tok · \$/)
  })

  test('a long reply wraps to five lines at most, the last cut with an ellipsis', async ($, on) => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const w = sampleWorld()
    w.files[pathOf('/srv/alpha', 'sess-a')] = jsonl(reply(T0 - MIN, 'a1', [text(long)]))
    const clock = fleetEngine(on, w)
    await openFleet($, clock, 40, 64)
    await press($, 'suit-1', 40, 64)
    const tree = await draw($, 40, 64)
    const rows = linesOf(tree).filter(l => /word\d/.test(l))
    expect(rows).toHaveLength(5)
    expect(rows[4]).toContain('…')
    expect(Math.max(...rowWidths(tree))).toBeLessThanOrEqual(64)
  })

  test('0 goes back to the fleet; g asks herdr to focus that pane', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    await openFleet($, clock)
    await press($, 'suit-2')
    await press($, 'jump')
    await clock.advance(10)
    expect(w.calls.some(c => c.join(' ') === 'herdr agent focus w2:p2')).toBe(true)
    await press($, 'back')
    expect(linesOf(await draw($)).join('\n')).toContain('── IRON LEGION')
  })

  test('a failed jump says so on that suit only', async ($, on) => {
    const w = sampleWorld({ focusFails: true })
    const clock = fleetEngine(on, w)
    await openFleet($, clock)
    await press($, 'suit-1')
    await press($, 'jump')
    await clock.advance(10)
    expect(linesOf(await draw($)).join('\n')).toContain('跳轉失敗：no such pane')
    await press($, 'back')
    await press($, 'suit-2')
    expect(linesOf(await draw($)).join('\n')).not.toContain('跳轉失敗')
  })

  test('a suit gone from the fleet sends its detail page back to the fleet', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    await openFleet($, clock)
    await press($, 'suit-1')
    w.panes = SAMPLE_PANES.slice(1)
    await draw($)
    await clock.advance(FLEET_MS)
    const lines = linesOf(await draw($)).join('\n')
    expect(lines).toContain('── IRON LEGION')
    expect(lines).not.toContain('最後提問')
  })

  test('every text the detail page draws wears a theme or model color', async ($, on) => {
    const w = sampleWorld()
    const clock = fleetEngine(on, w)
    await openFleet($, clock)
    await press($, 'suit-1')
    const bad = allTexts(await draw($))
      .filter(t => textOf(t).trim() !== '')
      .filter(t => !ALLOWED.has(String(t.props?.['color'] ?? '')))
      .map(textOf)
    expect(bad).toEqual([])
  })

  test('a suit with no cwd or workspace reads （無） there', async ($, on) => {
    const w = sampleWorld({ panes: [pane({ cwd: '', workspace_id: '' })] })
    const clock = fleetEngine(on, w)
    await openFleet($, clock)
    await press($, 'suit-1')
    const lines = linesOf(await draw($)).join('\n')
    expect(lines).toMatch(/目錄\s*（無）/)
    expect(lines).toMatch(/工作區\s*（無）/)
  })

  test('a jump error over many stderr lines shows its first line only', async ($, on) => {
    const w = sampleWorld({ focusFails: true, focusStderr: '\nno such pane\n  at herdr::agent::focus\n' })
    const clock = fleetEngine(on, w)
    await openFleet($, clock)
    await press($, 'suit-1')
    await press($, 'jump')
    await clock.advance(10)
    const lines = linesOf(await draw($))
    expect(lines.filter(l => l.includes('跳轉失敗'))).toHaveLength(1)
    expect(lines.join('\n')).toContain('跳轉失敗：no such pane')
    expect(lines.join('\n')).not.toContain('herdr::agent')
  })

  for (const cols of [40, 64, 80]) {
    test(`a detail page with a long cwd and reply stays within ${cols} columns`, async ($, on) => {
      const cwd = `/srv/${'deep/'.repeat(30)}alpha`
      const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
      const w = sampleWorld({ panes: [pane({ cwd })], focusFails: true, focusStderr: 'x'.repeat(200) })
      w.files[pathOf(cwd, 'sess-a')] = jsonl(human(T0 - 3 * MIN, long), reply(T0 - MIN, 'a1', [text(long)]))
      const clock = fleetEngine(on, w)
      await openFleet($, clock, 40, cols)
      await press($, 'suit-1', 40, cols)
      await press($, 'jump', 40, cols)
      await clock.advance(10)
      const tree = await draw($, 40, cols)
      expect(linesOf(tree).join('\n')).toContain('跳轉失敗')
      expect(Math.max(...rowWidths(tree))).toBeLessThanOrEqual(cols)
    })
  }
})

describe('fleet dashboard data', () => {
  test('the tail keeps the tool in flight until its result comes back', () => {
    const asked = rowsOf(human(T0 - 5 * MIN, 'go'), reply(T0 - 4 * MIN, 'd1', [toolUse('Bash')]))
    expect(tailOf(asked, T0).tool).toBe('Bash')
    const answered = rowsOf(human(T0 - 5 * MIN, 'go'), reply(T0 - 4 * MIN, 'd1', [toolUse('Bash')]), toolResult(T0 - 3 * MIN))
    expect(tailOf(answered, T0).tool).toBeUndefined()
    const next = rowsOf(
      reply(T0 - 4 * MIN, 'd1', [toolUse('Bash')]),
      toolResult(T0 - 3 * MIN),
      reply(T0 - 2 * MIN, 'd2', [toolUse('Read'), toolUse('Grep')]),
    )
    expect(tailOf(next, T0).tool).toBe('Grep')
  })

  test('the run starts at the last prompt the person typed; tool results and reminders do not count', () => {
    const rows = rowsOf(human(T0 - 9 * MIN, 'first'), human(T0 - 5 * MIN, 'second'), meta(T0 - 4 * MIN, 'reminder'), toolResult(T0 - 3 * MIN))
    expect(tailOf(rows, T0).runSince).toBe(T0 - 5 * MIN)
    expect(tailOf(rowsOf(reply(T0 - MIN, 'x', [text('hi')])), T0).runSince).toBeUndefined()
  })

  test('today by the hour: each message once in its local hour, yesterday left out', () => {
    const at9 = new Date(2026, 9, 11, 9, 30).getTime()
    const at14 = new Date(2026, 9, 11, 14, 10).getTime()
    const rows = rowsOf(
      reply(at9, 'h1', [thinking], use(10, 5)),
      reply(at9, 'h1', [text('a')], use(10, 5)),
      reply(at14, 'h2', [text('b')], use(100, 20)),
      reply(YESTERDAY, 'h0', [text('old')], use(999, 999)),
    )
    const f = addToday(freshFile(T0), rows, 0, T0)
    expect(f.hourly).toHaveLength(24)
    expect(f.hourly?.[9]).toBe(15)
    expect(f.hourly?.[14]).toBe(120)
    expect((f.hourly ?? []).reduce((a, b) => a + b, 0)).toBe(f.tokens)
  })

  test('a new day zeroes the hours with the count', () => {
    const f = addToday(freshFile(T0), rowsOf(reply(T0 - MIN, 'z', [text('a')], use(10, 5))), 10, T0)
    expect(f.hourly?.[14]).toBe(15)
    const next = resumeFrom(f, 20, T0 + 24 * 60 * MIN)
    expect(next?.hourly).toEqual(emptyHours())
    expect(next?.tokens).toBe(0)
  })

  test('a refresh adds every hour of the fleet: main transcripts and subagents, old files nothing', async () => {
    const a = pathOf('/srv/alpha', 'sess-a')
    const sub = subOf('/srv/alpha', 'sess-a', 'agent-x.jsonl')
    const b = pathOf('/srv/bravo', 'sess-b')
    const w: World = {
      panes: [pane(), pane({ pane_id: 'w2:p2', agent_session: { value: 'sess-b' }, cwd: '/srv/bravo' })],
      files: {
        [a]: jsonl(reply(T0 - 9 * MIN, 'm1', [toolUse('Bash')], use(100, 50))),
        [sub]: jsonl(reply(T0 - 3 * MIN, 's1', [text('y')], use(20, 7))),
        [b]: jsonl(reply(YESTERDAY, 'old', [text('z')], use(500, 500))),
      },
      mtime: { [b]: YESTERDAY },
      calls: [],
    }
    const { view } = await refreshFleet(fakeIo(w), EMPTY_FLEET, {}, T0)
    expect(view.hourly).toHaveLength(24)
    expect(view.hourly[14]).toBe(150 + 27)
    expect(view.hourly.reduce((x, y) => x + y, 0)).toBe(177)
    expect(view.sessions[0]?.tool).toBe('Bash')
    expect(EMPTY_FLEET.hourly).toEqual(emptyHours())
  })

  test('a session carries its own hours: its transcript and its subagents, an old one none', async () => {
    const a = pathOf('/srv/alpha', 'sess-a')
    const sub = subOf('/srv/alpha', 'sess-a', 'agent-x.jsonl')
    const b = pathOf('/srv/bravo', 'sess-b')
    const w: World = {
      panes: [pane(), pane({ pane_id: 'w2:p2', agent_session: { value: 'sess-b' }, cwd: '/srv/bravo' })],
      files: {
        [a]: jsonl(reply(T0 - 9 * MIN, 'm1', [text('x')], use(100, 50)), reply(T0 - 70 * MIN, 'm0', [text('w')], use(4, 1))),
        [sub]: jsonl(reply(T0 - 3 * MIN, 's1', [text('y')], use(20, 7))),
        [b]: jsonl(reply(YESTERDAY, 'old', [text('z')], use(500, 500))),
      },
      mtime: { [b]: YESTERDAY },
      calls: [],
    }
    const { view } = await refreshFleet(fakeIo(w), EMPTY_FLEET, {}, T0)
    const h = view.sessions[0]?.hourly ?? []
    expect(h).toHaveLength(24)
    expect(h[14]).toBe(150 + 27)
    expect(h[13]).toBe(5)
    expect(view.sessions[1]?.hourly).toEqual(emptyHours())
  })

  test('an unchanged file past midnight starts the new day with empty hours', async () => {
    const a = pathOf('/srv/alpha', 'sess-a')
    const w: World = { panes: [pane()], files: { [a]: jsonl(reply(T0 - MIN, 'u1', [text('x')], use(10, 5))) }, calls: [] }
    const io = fakeIo(w)
    const first = await refreshFleet(io, EMPTY_FLEET, {}, T0)
    expect(first.view.hourly[14]).toBe(15)
    const next = await refreshFleet(io, first.view, first.cursor, T0 + 24 * 60 * MIN)
    expect(next.cursor[a]?.hourly).toEqual(emptyHours())
    expect(next.view.hourly).toEqual(emptyHours())
  })

  test('a file last written yesterday counts no hours today, whatever its cursor held', async () => {
    const a = pathOf('/srv/alpha', 'sess-a')
    const w: World = { panes: [pane()], files: { [a]: jsonl(reply(YESTERDAY - 60 * MIN, 'y1', [text('x')], use(10, 5))) }, mtime: { [a]: YESTERDAY }, calls: [] }
    const io = fakeIo(w)
    const first = await refreshFleet(io, EMPTY_FLEET, {}, YESTERDAY)
    expect(first.view.hourly[21]).toBe(15)
    w.files[a] = jsonl(reply(YESTERDAY - 60 * MIN, 'y1', [text('x')], use(10, 5)), reply(YESTERDAY + 30 * MIN, 'y2', [text('y')], use(20, 7)))
    w.mtime = { [a]: YESTERDAY + 30 * MIN }
    const next = await refreshFleet(io, first.view, first.cursor, T0)
    expect(next.cursor[a]?.hourly).toEqual(emptyHours())
    expect(next.view.hourly).toEqual(emptyHours())
  })
})
