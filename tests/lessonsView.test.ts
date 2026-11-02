import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { TABS } from '../hooks/cockpit'
import type { Seg } from '../hooks/cockpit'
import { setLocale } from '../hooks/i18n'
import { BOOT_MS, THEME } from '../hooks/jarvis'
import { type DispatchRow, type HealthRow, dayKey, encodeRows, ledgerFile, lessonsFile } from '../hooks/ledger'
import type { Lesson } from '../hooks/lessons'
import { lessonsLines } from '../hooks/lessonsView'
import type { LessonsView } from '../hooks/lessonsView'
import { HAIKU, all, drawOn, textOf } from './helpers'
import type { Node } from './helpers'

// The Lessons tab: dispatch health and the lessons with their presses.

const HOME = '/h'
const DAY = 86_400_000
// local noon, so the day key never depends on the time zone
const NOW = new Date(2026, 9, 15, 12).getTime()
const SESSION = 'sess-1'
const KEY = 'tiny:Explore:haiku'

const text = (line: readonly Seg[]): string => line.map(s => s.t).join('')
const texts = (lines: readonly (readonly Seg[])[]): string[] => lines.map(text)

const health = (over: Partial<HealthRow> = {}): HealthRow => ({
  type: 'Explore',
  family: 'haiku',
  runs: 10,
  medianMs: 12_000,
  p90Ms: 40_000,
  meanTokens: 25_000,
  flagRate: 0.1,
  topFlag: 'tiny',
  ...over,
})

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  key: KEY,
  kind: 'tiny',
  type: 'Explore',
  family: 'haiku',
  state: 'candidate',
  strikes: 2,
  evidence: [{ at: NOW - DAY, project: 'proj', desc: 'find the config', detail: 'tools 1' }],
  muted: 0,
  ...over,
})

const view = (over: Partial<LessonsView> = {}): LessonsView => ({ health: [], lessons: [], ledgerPath: `${HOME}/.claude/jarvis/ledger`, session: SESSION, ...over })

const en = (f: () => void | Promise<void>) => async () => {
  setLocale('en')
  try {
    await f()
  } finally {
    setLocale('zh-TW')
  }
}

describe('lessons lines', () => {
  test(
    'nothing recorded: the empty text and the ledger path',
    en(() => {
      const out = texts(lessonsLines(view(), 80)).join('\n')
      expect(out).toContain('No dispatches recorded yet')
      expect(out).toContain(`${HOME}/.claude/jarvis/ledger`)
    }),
  )

  test(
    'a health row at a 20% flag rate is drawn in the error color; below it is not',
    en(() => {
      const lines = lessonsLines(view({ health: [health({ type: 'worker', flagRate: 0.2 }), health({ type: 'clerk', flagRate: 0.19 })] }), 80)
      const row = (type: string) => lines.find(l => text(l).trimStart().startsWith(type))!
      expect(row('worker').some(s => s.color === THEME.error && s.t.includes('20%'))).toBe(true)
      expect(row('clerk').some(s => s.color === THEME.error)).toBe(false)
    }),
  )

  test(
    'a candidate shows its strikes, evidence and the Approve and Reject presses',
    en(() => {
      const out = texts(lessonsLines(view({ lessons: [lesson()] }), 80)).join('\n')
      expect(out).toContain(KEY)
      expect(out).toContain('2×')
      expect(out).toContain('find the config')
      expect(out).toContain('[Approve]')
      expect(out).toContain('[Reject]')
    }),
  )

  test(
    'approved: waiting has Retry and Cancel, a memory error has Retry, another session reads only',
    en(() => {
      const of = (l: Partial<Lesson>) => texts(lessonsLines(view({ lessons: [lesson({ state: 'approved', ...l })] }), 80)).join('\n')
      const waiting = of({ approvedIn: SESSION, memoryId: 7, waiting: true })
      expect(waiting).toContain('[Retry]')
      expect(waiting).toContain('[Cancel]')
      const failed = of({ approvedIn: SESSION, memoryError: 'no id' })
      expect(failed).toContain('no id')
      expect(failed).toContain('[Retry]')
      expect(failed).not.toContain('[Cancel]')
      const other = of({ approvedIn: 'sess-2', memoryId: 7 })
      expect(other).toContain('approved in another session')
      expect(other).not.toContain('[')
    }),
  )

  test(
    'applied shows before → after and the verdict; Revert only when not helping',
    en(() => {
      const of = (verdict: 'helping' | 'not-helping') =>
        texts(
          lessonsLines(
            view({
              lessons: [lesson({ state: 'applied', measure: { verdict, beforeRate: 0.4, afterRate: verdict === 'helping' ? 0.1 : 0.5, beforeN: 20, afterN: 9 } })],
            }),
            80,
          ),
        ).join('\n')
      expect(of('helping')).toContain('40% → 10%')
      expect(of('helping')).not.toContain('[Revert]')
      expect(of('not-helping')).toContain('[Revert]')
    }),
  )

  test(
    'watching is one line each; rejected and reverted are a count',
    en(() => {
      const lines = texts(
        lessonsLines(
          view({
            lessons: [
              lesson({ key: 'loop:worker:opus', state: 'watching', strikes: 1 }),
              lesson({ key: 'stuck:worker:opus', state: 'rejected' }),
              lesson({ key: 'heavy:Explore:haiku', state: 'reverted' }),
            ],
          }),
          80,
        ),
      )
      expect(lines.filter(l => l.includes('loop:worker:opus')).length).toBe(1)
      expect(lines.join('\n')).not.toContain('stuck:worker:opus')
      expect(lines.join('\n')).toContain('+2 rejected / reverted')
    }),
  )

  test(
    'narrow widths drop the p90 and mean-token columns',
    en(() => {
      const v = view({ health: [health()] })
      const wide = texts(lessonsLines(v, 80)).join('\n')
      const narrow = texts(lessonsLines(v, 50)).join('\n')
      expect(wide).toContain('p90')
      expect(wide).toContain('40.0s')
      expect(narrow).not.toContain('p90')
      expect(narrow).not.toContain('40.0s')
      expect(narrow).toContain('12.0s')
    }),
  )
})

describe('lessons tab', () => {
  test('the tab follows Tasks, labelled in both locales', () => {
    const at = () => TABS.findIndex(x => x.page === 'lessons')
    try {
      setLocale('en')
      expect(at()).toBe(TABS.findIndex(x => x.page === 'tasks') + 1)
      expect(TABS[at()]?.label).toBe('Lessons')
      setLocale('zh-TW')
      expect(TABS[at()]?.label).toBe('教訓')
    } finally {
      setLocale('zh-TW')
    }
  })
})

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
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME, JARVIS_LANG: 'en' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: SESSION }))
  on('classic.SessionStart', async () => ({}))
  on('agent.list', async () => ({ value: [] as never }))
  on('tool.call', async () => ({ result: {} as never }))
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__jarvis__${e.name}` } }))
  on('prompt.compose', async () => ({ sections: [] }))
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
  return { files, clock }
}

// two tiny strikes of another session, yesterday
const twoStrikes = (): Map<string, string> =>
  new Map([[ledgerFile(HOME, dayKey(NOW - DAY), 'old'), encodeRows([tinyRow(NOW - DAY), tinyRow(NOW - DAY + 60_000)])]])

const PANE = { title: 'Jarvis', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 45 }, view: {} }

const mount = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'jarvis', surface, component: 'Pane', requestId: 'jarvis', props: PANE, viewport: { columns: 100, rows: 55 } })

// the test runtime's timer, which the mod's es2023 lib does not declare
const later = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout
const settle = () => new Promise<void>(r => later(() => r(), 5))

// a started session showing the Lessons tab
const onLessons = async ($: Engine, w: { clock: { advance: (ms: number) => Promise<unknown> } }) => {
  await $.session.start({ cwd: '/w/proj', surface: 'terminal', isInteractive: true })
  await w.clock.advance(BOOT_MS)
  const ui = await mount($)
  await ui.press({ key: 'tab-lessons' })
  await ui.unmount()
  await settle()
}

const buttonKeys = (tree: Node): string[] => all(tree, x => x.type === 'Button').map(b => String(b.props?.['key'] ?? ''))

describe('lessons tab wired', () => {
  test('the terminal draws the page with a candidate’s Approve and Reject Buttons', async ($, on) => {
    const w = world(on, twoStrikes())
    try {
      await onLessons($, w)
      const tree = await drawOn($, 'terminal')
      const words = textOf(tree)
      expect(words).toContain('Dispatch health')
      expect(words).toContain(KEY)
      expect(buttonKeys(tree)).toContain(`lesson-approve-${KEY}`)
      expect(buttonKeys(tree)).toContain(`lesson-reject-${KEY}`)
    } finally {
      setLocale('zh-TW')
    }
  })

  test('pressing Approve approves the lesson and writes it down', async ($, on) => {
    const w = world(on, twoStrikes())
    try {
      await onLessons($, w)
      const ui = await mount($)
      await ui.press({ key: `lesson-approve-${KEY}` })
      await ui.unmount()
      await settle()
      const events = w.files.get(lessonsFile(HOME, SESSION)) ?? ''
      expect(events).toContain('"kind":"approve"')
      expect(events).toContain('"kind":"memory"')
    } finally {
      setLocale('zh-TW')
    }
  })

  test('with no HOME the page draws the empty state', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { JARVIS_LANG: 'en' })
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('session.id', async () => ({ value: SESSION }))
    on('classic.SessionStart', async () => ({}))
    on('agent.list', async () => ({ value: [] as never }))
    try {
      await onLessons($, { clock })
      const tree = await drawOn($, 'terminal')
      expect(textOf(tree)).toContain('No dispatches recorded yet')
    } finally {
      setLocale('zh-TW')
    }
  })
})
