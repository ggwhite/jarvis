import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { setLocale } from '../hooks/i18n'
import { type DispatchRow, dayKey, decodeRows, encodeRows, ledgerFile } from '../hooks/ledger'
import { TASK_TOOL } from '../hooks/tasks'
import { HAIKU, complete, spawnInput } from './helpers'

// The learning loop as the hooks feed it: one session's rows land in its own ledger file,
// candidate lessons ride along a prompt, and the lesson tool answers.

const HOME = '/h'
const DAY = 86_400_000
// local noon, so the day key never depends on the time zone
const NOW = new Date(2026, 9, 15, 12).getTime()
const SESSION = 'sess-1'
const KEY = 'tiny:Explore:haiku'

let seq = 0
// a finished Explore row of another session that trips `tiny`
const tinyRow = (at: number): DispatchRow => {
  seq++
  return {
    v: 1,
    id: `old-${seq}`,
    session: 'old',
    project: 'p',
    at,
    type: 'Explore',
    model: HAIKU,
    family: 'haiku',
    background: false,
    desc: `find ${seq}`,
    promptLen: 10,
    doneAt: at + 1_000,
    durationMs: 1_000,
    reason: 'answer',
    tokens: { in: 1, out: 2, cr: 3, cw: 4 },
    tools: 1,
    toolErrors: 0,
  }
}

// the engine beneath the mod, with a file system kept in `files`
const world = (on: On, files = new Map<string, string>()) => {
  const registered: string[] = []
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME, JARVIS_LANG: 'en' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('session.id', async () => ({ value: SESSION }))
  on('classic.SessionStart', async () => ({}))
  on('agent.spawn', async () => ({ model: HAIKU, agentId: 'agent-1' }))
  on('agent.list', async () => ({ value: [{ id: 'agent-1', status: 'running', type: 'Explore', description: 'd' }] as never }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))
  on('tool.register', async (_$, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__jarvis__${e.name}` } }
  })
  on('prompt.compose', async () => ({ sections: [] }))
  on('prompt.submit', async (_$, e) => ({ text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }))
  on('model.complete', async () => ({
    value: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  on('fs.read', async (_$, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined as void }
  })
  on('fs.stat', async (_$, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: t.length, mtimeMs: NOW, isLink: false } }
  })
  on('fs.list', async (_$, e) => {
    const out = new Map<string, 'file' | 'dir'>()
    for (const k of files.keys()) {
      if (!k.startsWith(`${e.path}/`)) continue
      const rest = k.slice(e.path.length + 1)
      const i = rest.indexOf('/')
      out.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'dir')
    }
    if (out.size === 0) throw new Error('ENOENT')
    return { value: [...out].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: NOW, isLink: false })) }
  })
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: '{"id":1901}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  return { files, registered }
}

// the locale is the module's: put it back for the files that run after this one
const en = (f: ($: Engine, on: On) => Promise<void>) => async ($: Engine, on: On) => {
  try {
    await f($, on)
  } finally {
    setLocale('zh-TW')
  }
}

const start = ($: Engine) => $.session.start({ cwd: '/w/proj', surface: 'terminal', isInteractive: true })
const end = ($: Engine) => $.session.end({ reason: 'other', sessionId: SESSION, resume: { id: SESSION } } as never)
const send = ($: Engine, text: string, over: Record<string, unknown> = {}) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...over } as never)
const lesson = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__jarvis__lesson', ...input } as never)

const ownRows = (files: Map<string, string>): DispatchRow[] => decodeRows(files.get(ledgerFile(HOME, dayKey(NOW), SESSION)) ?? '')

// two tiny strikes of another session, yesterday
const twoStrikes = (): Map<string, string> =>
  new Map([[ledgerFile(HOME, dayKey(NOW - DAY), 'old'), encodeRows([tinyRow(NOW - DAY), tinyRow(NOW - DAY + 60_000)])]])

const lessonLines = (context: readonly string[] | undefined): string[] => (context ?? []).filter(c => c.includes('Jarvis lesson'))

describe('learning loop wired', () => {
  test(
    'a spawn, its tool calls and its turn end land as one row in this session’s ledger file',
    en(async ($, on) => {
      const w = world(on)
      await start($)
      await $.agent.spawn(spawnInput('find x', 'Explore'))
      await $.tool.call({ tool: 'Read', file_path: '/a', agentId: 'agent-1' } as never)
      await $.tool.call({ tool: 'Read', file_path: '/b', agentId: 'agent-1' } as never)
      await $.turn.complete(
        complete('agent-1', { usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as never,
      )
      await end($)
      const rows = ownRows(w.files)
      expect(rows.length).toBe(1)
      const r = rows[0]!
      expect(r.id).toBe('agent-1')
      expect(r.session).toBe(SESSION)
      expect(r.project).toBe('proj')
      expect(r.type).toBe('Explore')
      expect(r.family).toBe('haiku')
      expect(r.tools).toBe(2)
      expect(r.tokens.in).toBe(10)
      expect(r.reason).toBe('answer')
      expect(r.doneAt).toBe(NOW)
      expect(r.cost).toBeGreaterThan(0)
    }),
  )

  test(
    'a board update handing a subtask to an agent records the subtask on its row',
    en(async ($, on) => {
      const w = world(on)
      await start($)
      await $.agent.spawn(spawnInput('find x', 'Explore'))
      await $.tool.call({ tool: TASK_TOOL, op: 'add', item: 'A', subtasks: ['a1'] } as never)
      await $.tool.call({ tool: TASK_TOOL, op: 'update', id: '1.1', status: 'in_progress', agent: 'agent-1' } as never)
      await end($)
      expect(ownRows(w.files)[0]?.subtask).toBe('1.1')
    }),
  )

  test(
    'a prompt carries a candidate lesson once; the next prompt does not',
    en(async ($, on) => {
      world(on, twoStrikes())
      await start($)
      const first = await send($, 'fix the bug')
      expect(lessonLines(first.context)).toEqual([expect.stringContaining(`Jarvis lesson (2× in 30d): ${KEY} — `)])
      const second = await send($, 'and another')
      expect(lessonLines(second.context)).toEqual([])
    }),
  )

  test(
    'a prompt that opens no request carries the lesson too',
    en(async ($, on) => {
      world(on, twoStrikes())
      await start($)
      const out = await send($, 'background done', { origin: { kind: 'task-notification' } })
      expect(lessonLines(out.context)).toEqual([expect.stringContaining(`Jarvis lesson (2× in 30d): ${KEY} — `)])
    }),
  )

  test(
    'the lesson tool is registered; list answers with text and applied on a lesson not approved is denied',
    en(async ($, on) => {
      const w = world(on, twoStrikes())
      await start($)
      expect(w.registered).toContain('lesson')
      const listed = await lesson($, { op: 'list' })
      expect(listed.deny).toBeUndefined()
      expect(String(listed.result)).toContain(`${KEY} — candidate`)
      const applied = await lesson($, { op: 'applied', key: KEY, file: '/h/.claude/CLAUDE.md' })
      expect(applied.deny).toContain('not approved')
    }),
  )
})
