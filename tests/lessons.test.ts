import { describe, expect, test } from 'claude-code/testing'

import { setLocale } from '../hooks/i18n'
import { type DispatchRow } from '../hooks/ledger'
import {
  INJECT_MAX,
  applyRequest,
  lessonLine,
  revertRequest,
  type Lesson,
  type LessonEvent,
  decodeEvents,
  encodeEvents,
  foldLessons,
  injectLines,
  lessonKey,
  measureOf,
  memoryArgv,
  memoryIdOf,
  suggestedFile,
} from '../hooks/lessons'

const DAY = 86_400_000
const NOW = 100 * DAY
const KEY = 'tiny:Explore:haiku'

let seq = 0
const row = (over: Partial<DispatchRow> = {}): DispatchRow => {
  seq++
  const at = over.at ?? NOW - DAY
  return {
    v: 1,
    id: `r${seq}`,
    session: 's1',
    project: 'p',
    at,
    type: 'Explore',
    model: 'claude-haiku-5-5',
    family: 'haiku',
    background: false,
    desc: `find ${seq}`,
    promptLen: 10,
    doneAt: at + 1_000,
    durationMs: 1_000,
    reason: 'answer',
    tokens: { in: 1, out: 2, cr: 3, cw: 4 },
    tools: 5,
    toolErrors: 0,
    ...over,
  }
}

// a finished Explore row that trips `tiny`
const tiny = (at: number): DispatchRow => row({ at, tools: 1 })
const clean = (at: number): DispatchRow => row({ at, tools: 5 })
const tinies = (n: number, from: number): DispatchRow[] => Array.from({ length: n }, (_, i) => tiny(from + i * 1_000))

const ev = (kind: LessonEvent['kind'], at: number, extra: Partial<LessonEvent> = {}): LessonEvent => ({
  key: KEY,
  kind,
  at,
  session: 's1',
  ...extra,
})

const only = (lessons: Lesson[], key = KEY): Lesson | undefined => lessons.find(l => l.key === key)

describe('lessonKey', () => {
  test('kind, type and family; corrected ignores the family', () => {
    const r = row({ type: 'worker', family: 'sonnet' })
    expect(lessonKey('verify-fail', r)).toBe('verify-fail:worker:sonnet')
    expect(lessonKey('corrected', r)).toBe('corrected:worker:*')
  })
})

describe('foldLessons', () => {
  test('one strike watches, two make a candidate', () => {
    expect(only(foldLessons([tiny(NOW - DAY)], [], NOW))?.state).toBe('watching')
    const two = only(foldLessons(tinies(2, NOW - DAY), [], NOW))
    expect(two?.state).toBe('candidate')
    expect(two?.strikes).toBe(2)
    expect(two?.kind).toBe('tiny')
    expect(two?.type).toBe('Explore')
    expect(two?.family).toBe('haiku')
    expect(two?.evidence.length).toBe(2)
    expect(foldLessons([clean(NOW - DAY)], [], NOW)).toEqual([])
  })

  test('strikes older than 30 days do not count', () => {
    const rows = [tiny(NOW - 31 * DAY), tiny(NOW - DAY)]
    const l = only(foldLessons(rows, [], NOW))
    expect(l?.state).toBe('watching')
    expect(l?.strikes).toBe(1)
    expect(foldLessons([tiny(NOW - 31 * DAY)], [], NOW)).toEqual([])
  })

  test('evidence is the last 3 flagged rows, newest first', () => {
    const rows = tinies(4, NOW - DAY)
    const l = only(foldLessons(rows, [], NOW))!
    expect(l.evidence.map(e => e.desc)).toEqual([rows[3]!.desc, rows[2]!.desc, rows[1]!.desc])
    expect(l.evidence[0]?.project).toBe('p')
    expect(l.evidence[0]?.at).toBe(rows[3]!.at)
  })

  test('approve then applied gives applied with file and appliedAt', () => {
    const rows = tinies(2, NOW - 2 * DAY)
    const events = [
      ev('approve', NOW - DAY, { session: 'sA' }),
      ev('memory', NOW - DAY + 1, { memoryId: 42 }),
      ev('applied', NOW - DAY + 2, { file: '/x/SKILL.md' }),
    ]
    const l = only(foldLessons(rows, events, NOW))!
    expect(l.state).toBe('applied')
    expect(l.file).toBe('/x/SKILL.md')
    expect(l.appliedAt).toBe(NOW - DAY + 2)
    expect(l.approvedIn).toBe('sA')
    expect(l.memoryId).toBe(42)
    expect(l.measure?.verdict).toBe('too-early')
  })

  test('approve keeps approved; a memory error is recorded and a new approve clears it', () => {
    const rows = tinies(2, NOW - 2 * DAY)
    const failed = only(foldLessons(rows, [ev('approve', NOW - DAY), ev('memory-error', NOW - DAY + 1, { error: 'boom' })], NOW))!
    expect(failed.state).toBe('approved')
    expect(failed.memoryError).toBe('boom')
    const again = only(foldLessons(rows, [ev('approve', NOW - DAY), ev('memory-error', NOW - DAY + 1, { error: 'boom' }), ev('approve', NOW - DAY + 2)], NOW))!
    expect(again.memoryError).toBeUndefined()
  })

  test('a stored memory after a failed one clears the error', () => {
    const rows = tinies(2, NOW - 2 * DAY)
    const events = [ev('approve', NOW - DAY), ev('memory-error', NOW - DAY + 1, { error: 'boom' }), ev('memory', NOW - DAY + 2, { memoryId: 7 })]
    const l = only(foldLessons(rows, events, NOW))!
    expect(l.memoryId).toBe(7)
    expect(l.memoryError).toBeUndefined()
  })

  test('events with the same time keep file order', () => {
    const rows = tinies(2, NOW - 2 * DAY)
    const l = only(foldLessons(rows, [ev('approve', NOW - DAY), ev('apply-cancel', NOW - DAY)], NOW))!
    expect(l.state).toBe('candidate')
  })

  test('apply-cancel returns to candidate and keeps the memory id', () => {
    const rows = tinies(2, NOW - 2 * DAY)
    const events = [ev('approve', NOW - DAY), ev('memory', NOW - DAY + 1, { memoryId: 7 }), ev('apply-cancel', NOW - DAY + 2)]
    const l = only(foldLessons(rows, events, NOW))!
    expect(l.state).toBe('candidate')
    expect(l.memoryId).toBe(7)
  })

  test('a rejected key reopens only after 3 new strikes', () => {
    const before = tinies(2, NOW - 10 * DAY)
    const events = [ev('reject', NOW - 5 * DAY)]
    const two = only(foldLessons([...before, ...tinies(2, NOW - DAY)], events, NOW))!
    expect(two.state).toBe('rejected')
    expect(two.muted).toBe(2)
    const three = only(foldLessons([...before, ...tinies(3, NOW - DAY)], events, NOW))!
    expect(three.state).toBe('candidate')
    expect(three.strikes).toBe(5)
    expect(three.muted).toBe(0)
  })

  test('a reverted key reopens only after 3 new strikes', () => {
    const before = tinies(2, NOW - 20 * DAY)
    const events = [ev('approve', NOW - 19 * DAY), ev('applied', NOW - 18 * DAY, { file: '/f' }), ev('revert-request', NOW - 6 * DAY), ev('reverted', NOW - 5 * DAY)]
    const two = only(foldLessons([...before, ...tinies(2, NOW - DAY)], events, NOW))!
    expect(two.state).toBe('reverted')
    expect(two.revertRequested).toBe(false)
    const three = only(foldLessons([...before, ...tinies(3, NOW - DAY)], events, NOW))!
    expect(three.state).toBe('candidate')
  })

  test('a revert request is kept until reverted', () => {
    const rows = tinies(2, NOW - 20 * DAY)
    const events = [ev('approve', NOW - 19 * DAY), ev('applied', NOW - 18 * DAY, { file: '/f' }), ev('revert-request', NOW - DAY)]
    const l = only(foldLessons(rows, events, NOW))!
    expect(l.state).toBe('applied')
    expect(l.revertRequested).toBe(true)
  })

  test('an applied key stays applied while strikes grow', () => {
    const rows = [...tinies(2, NOW - 20 * DAY), ...tinies(6, NOW - DAY)]
    const events = [ev('approve', NOW - 19 * DAY), ev('applied', NOW - 18 * DAY, { file: '/f' })]
    const l = only(foldLessons(rows, events, NOW))!
    expect(l.state).toBe('applied')
    expect(l.strikes).toBe(8)
  })

  test('corrected keys gather rows of every family', () => {
    const rows = [
      row({ type: 'worker', family: 'sonnet', corrected: true }),
      row({ type: 'worker', family: 'opus', corrected: true }),
    ]
    const l = only(foldLessons(rows, [], NOW), 'corrected:worker:*')!
    expect(l.state).toBe('candidate')
    expect(l.strikes).toBe(2)
    expect(l.family).toBe('*')
  })

  test('an event whose key has an unknown kind yields no lesson', () => {
    const events = [ev('approve', NOW - DAY, { key: 'bogus:worker:sonnet' }), ev('applied', NOW - DAY + 1, { key: 'bogus:worker:sonnet', file: '/f' })]
    expect(foldLessons([], events, NOW)).toEqual([])
  })

  test('a type with a colon keeps its whole name', () => {
    const rows = [row({ type: 'plug:agent', tools: 1 }), row({ type: 'plug:agent', tools: 1 })]
    const l = only(foldLessons(rows, [], NOW), 'tiny:plug:agent:haiku')!
    expect(l.type).toBe('plug:agent')
    expect(l.family).toBe('haiku')
  })
})

describe('measureOf', () => {
  const APPLIED = NOW - 10 * DAY
  // `flagged` of `n` rows in the window starting at `from`
  const window = (from: number, n: number, flagged: number): DispatchRow[] =>
    Array.from({ length: n }, (_, i) => (i < flagged ? tiny(from + i * 1_000) : clean(from + i * 1_000)))

  test('too-early under 8 rows', () => {
    const m = measureOf([...window(APPLIED - DAY, 10, 5), ...window(APPLIED + 1, 7, 0)], KEY, APPLIED)
    expect(m.verdict).toBe('too-early')
    expect(m.afterN).toBe(7)
    expect(m.beforeN).toBe(10)
    expect(m.beforeRate).toBe(0.5)
  })

  test('helping at half', () => {
    const m = measureOf([...window(APPLIED - DAY, 10, 4), ...window(APPLIED, 10, 2)], KEY, APPLIED)
    expect(m.verdict).toBe('helping')
    expect(m.afterRate).toBe(0.2)
  })

  test('not-helping at equal', () => {
    const m = measureOf([...window(APPLIED - DAY, 10, 4), ...window(APPLIED, 10, 4)], KEY, APPLIED)
    expect(m.verdict).toBe('not-helping')
  })

  test('unclear in between', () => {
    const m = measureOf([...window(APPLIED - DAY, 10, 4), ...window(APPLIED, 10, 3)], KEY, APPLIED)
    expect(m.verdict).toBe('unclear')
  })

  test('zero before and zero after is helping', () => {
    const m = measureOf([...window(APPLIED - DAY, 5, 0), ...window(APPLIED, 8, 0)], KEY, APPLIED)
    expect(m.verdict).toBe('helping')
  })

  test('rows older than 30 days before appliedAt and other types are left out', () => {
    const m = measureOf([...window(APPLIED - 31 * DAY, 10, 10), row({ at: APPLIED - DAY, type: 'worker', tools: 1 }), ...window(APPLIED, 8, 0)], KEY, APPLIED)
    expect(m.beforeN).toBe(0)
  })
})

describe('injectLines', () => {
  const lesson = (key: string, strikes: number, state: Lesson['state'] = 'candidate'): Lesson => ({
    key,
    kind: 'tiny',
    type: key.split(':')[1]!,
    family: 'haiku',
    state,
    strikes,
    evidence: [],
    muted: 0,
  })

  test('at most 3, strikes desc, skips keys shown at the same count, re-shows when the count grows', () => {
    const lessons = [
      lesson('tiny:A:haiku', 2),
      lesson('tiny:B:haiku', 5),
      lesson('tiny:C:haiku', 3),
      lesson('tiny:D:haiku', 4),
      lesson('tiny:E:haiku', 9, 'applied'),
      lesson('tiny:F:haiku', 1, 'watching'),
    ]
    const first = injectLines(lessons, new Map())
    expect(first.lines.length).toBe(INJECT_MAX)
    expect(first.lines[0]).toContain('tiny:B:haiku')
    expect(first.lines[1]).toContain('tiny:D:haiku')
    expect(first.lines[2]).toContain('tiny:C:haiku')
    expect([...first.shown.entries()].sort()).toEqual([
      ['tiny:B:haiku', 5],
      ['tiny:C:haiku', 3],
      ['tiny:D:haiku', 4],
    ])

    const second = injectLines(lessons, first.shown)
    expect(second.lines.length).toBe(1)
    expect(second.lines[0]).toContain('tiny:A:haiku')

    const grown = lessons.map(l => (l.key === 'tiny:C:haiku' ? { ...l, strikes: 6 } : l))
    const third = injectLines(grown, second.shown)
    expect(third.lines.length).toBe(1)
    expect(third.lines[0]).toContain('tiny:C:haiku')
    expect(third.shown.get('tiny:C:haiku')).toBe(6)
  })

  test('a count that drops as rows age out is not shown again', () => {
    const lessons = [lesson('tiny:A:haiku', 3)]
    const out = injectLines(lessons, new Map([['tiny:A:haiku', 4]]))
    expect(out.lines).toEqual([])
    expect(out.shown.get('tiny:A:haiku')).toBe(4)
  })
})

describe('suggestedFile', () => {
  const H = '/h'
  const ROUTING = '/h/dotfiles/claude/skills/model-routing/SKILL.md'
  test('suggestedFile follows the spec table', () => {
    expect(suggestedFile('tiny', 'Explore', H, [])).toBe(ROUTING)
    expect(suggestedFile('heavy', 'clerk', H, [])).toBe(ROUTING)
    expect(suggestedFile('redispatch', 'worker', H, ['worker.md'])).toBe(ROUTING)
    expect(suggestedFile('verify-fail', 'worker', H, [])).toBe('/h/dotfiles/claude/agents/worker.md')
    expect(suggestedFile('loop', 'Explore', H, ['Explore.md', 'worker.md'])).toBe('/h/dotfiles/claude/agents/Explore.md')
    expect(suggestedFile('loop', 'fork', H, ['Explore.md'])).toBe(ROUTING)
    expect(suggestedFile('error-end', 'clerk', H, ['clerk.md'])).toBe('/h/dotfiles/claude/agents/clerk.md')
    expect(suggestedFile('corrected', 'worker', H, ['worker.md'])).toBe('/h/dotfiles/agents/core.md')
  })
})

describe('memory-mcp', () => {
  test('memoryArgv has no --project and uses the absolute binary', () => {
    const l = only(foldLessons(tinies(2, NOW - DAY), [], NOW))!
    const argv = memoryArgv('/h', l)
    expect(argv.slice(0, 7)).toEqual(['/h/.local/bin/memory-mcp', 'store', '--json', '-t', 'feedback', '--tags', 'jarvis-lesson,tiny'])
    expect(argv.length).toBe(8)
    expect(argv).not.toContain('--project')
    expect(argv[7]).toContain('Evidence: ')
    expect(argv[7]!.endsWith(l.evidence[0]!.desc)).toBe(true)
  })

  test('memoryIdOf reads JSON id and falls back to #123', () => {
    expect(memoryIdOf('{"id": 77, "type": "feedback"}')).toBe(77)
    expect(memoryIdOf('stored memory #123 (feedback)')).toBe(123)
    expect(memoryIdOf('stored 456')).toBe(456)
    expect(memoryIdOf('no luck here')).toBeUndefined()
    expect(memoryIdOf('')).toBeUndefined()
  })
})

describe('texts', () => {
  test('the en line, apply and revert requests read as the spec copy', () => {
    setLocale('en')
    try {
      const rows = tinies(2, NOW - DAY)
      const l: Lesson = { ...only(foldLessons(rows, [], NOW))!, memoryId: 9, file: '/f', measure: { verdict: 'not-helping', beforeRate: 0.25, afterRate: 0.5, beforeN: 8, afterN: 10 } }
      expect(lessonLine(l)).toBe('Jarvis lesson (2× in 30d): tiny:Explore:haiku — Explore (haiku) finished with ≤ 2 tool calls; do it yourself when it fits in 3 calls.')
      const apply = applyRequest(l, '/h/SKILL.md')
      expect(apply.startsWith('Jarvis: the user approved lesson tiny:Explore:haiku (2×): Explore (haiku) finished')).toBe(true)
      expect(apply).toContain(`Evidence: 1970-`)
      expect(apply).toContain('Memory #9. Add ONE imperative rule (一律 / NEVER) for it to /h/SKILL.md, ending with <!-- ev: #9 -->')
      expect(apply).toContain('key "tiny:Explore:haiku", file "<the file you edited>"')
      expect(revertRequest(l)).toBe(
        'Jarvis: lesson tiny:Explore:haiku is not helping (before 25% (n=8), after 50% (n=10)). Remove its rule line (the one with <!-- ev: #9 -->) from /f, show the diff, then call mcp__jarvis__lesson with op "reverted", key "tiny:Explore:haiku".',
      )
    } finally {
      setLocale('zh-TW')
    }
  })
})

describe('events codec', () => {
  test('decodeEvents skips bad lines', () => {
    const good = [ev('approve', 5), ev('memory', 6, { memoryId: 3 })]
    const text = `${encodeEvents([good[0]!])}{oops\n${JSON.stringify({ key: KEY, kind: 'nope', at: 1, session: 's' })}\n${JSON.stringify({ kind: 'reject', at: 1, session: 's' })}\n${JSON.stringify({ key: 'bogus:worker:sonnet', kind: 'approve', at: 1, session: 's' })}\n\n${encodeEvents([good[1]!])}`
    expect(decodeEvents(text)).toEqual(good)
  })
})
