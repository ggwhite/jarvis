import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { DICTIONARIES, locale, localeOf, setLocale, t } from '../hooks/i18n'
import type { Locale, MsgKey } from '../hooks/i18n'
import { relTime } from '../hooks/commitsView'
import { cellWidth } from '../hooks/jarvis'
import { jarvisOpenText } from '../hooks/register'
import { CLASSIFY_SYSTEM, RESULT_MAX, SUMMARY_SYSTEM, SUMMARY_TITLE_MAX, TOPIC_TITLE_MAX, classifyAsk, cleanSummary, parseClassify, resultAsk } from '../hooks/summary'
import { TASK_PROMPT, TASK_TOOL, TASK_TOOL_SPEC, TASKS_TITLE, applyTask, boardText, requestContext } from '../hooks/tasks'
import { EMPTY_TEXT } from '../hooks/tasksView'
import { HAIKU, drawOn, pressOn, spawnInput, textOf } from './helpers'
import type { Node } from './helpers'

const CJK = /[　-鿿＀-￯]/

// runs `f` under `l`, then puts the default back
const inLocale = <T>(l: Locale, f: () => T): T => {
  setLocale(l)
  try {
    return f()
  } finally {
    setLocale('zh-TW')
  }
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1] ?? '').sort()

describe('i18n dictionaries', () => {
  test('en has exactly the keys zh-TW has', () => {
    expect(Object.keys(DICTIONARIES.en).sort()).toEqual(Object.keys(DICTIONARIES['zh-TW']).sort())
  })

  test('each en message takes the same placeholders as its zh-TW one', () => {
    for (const key of Object.keys(DICTIONARIES['zh-TW']) as MsgKey[]) {
      expect([key, placeholders(DICTIONARIES.en[key])]).toEqual([key, placeholders(DICTIONARIES['zh-TW'][key])])
    }
  })

  test('no en message carries a CJK character', () => {
    const hits = Object.entries(DICTIONARIES.en).filter(([, v]) => CJK.test(v))
    expect(hits).toEqual([])
  })
})

describe('locale and lookup', () => {
  test('JARVIS_LANG=en is English; anything else, or nothing, is zh-TW', () => {
    expect(localeOf('en')).toBe('en')
    for (const v of [undefined, '', 'zh-TW', 'EN', 'en-US', 'fr']) expect(localeOf(v)).toBe('zh-TW')
  })

  test('the default locale is zh-TW', () => {
    expect(locale()).toBe('zh-TW')
    expect(t('tab.now')).toBe('現況')
  })

  test('a message fills its placeholders in the current locale', () => {
    expect(t('common.more', { n: 3 })).toBe('… 還有 3 個')
    expect(inLocale('en', () => t('common.more', { n: 3 }))).toBe('… 3 more')
    expect(inLocale('en', () => t('log.total', { total: 12, max: 200 }))).toBe('12/200 events')
  })

  test('a placeholder with no value stays as written; a value is never read for placeholders of its own', () => {
    expect(inLocale('en', () => t('common.more'))).toBe('… {n} more')
    expect(inLocale('en', () => t('common.more', { m: 1 }))).toBe('… {n} more')
    expect(inLocale('en', () => t('cls.request', { last: '{prompt}', prompt: 'P' }))).toBe('{prompt}Request:\nP')
  })

  test("a module's localized constants follow the locale", () => {
    expect(EMPTY_TEXT).toBe(DICTIONARIES['zh-TW']['tasks.empty'])
    inLocale('en', () => {
      expect(EMPTY_TEXT).toBe('No tasks yet. Send a request and its work is listed here.')
      expect(TASKS_TITLE).toBe('Built-in tasks')
      expect(SUMMARY_SYSTEM).toContain('in English')
    })
    expect(TASKS_TITLE).toBe('內建任務')
  })
})

describe('en: counts', () => {
  const COUNTED: [MsgKey, Record<string, string | number>, string, string][] = [
    ['changes.files', {}, '1 file', '2 files'],
    ['changes.moreFiles', {}, '… 1 more file', '… 2 more files'],
    ['changes.moreLines', {}, '… 1 more line', '… 2 more lines'],
    ['changes.removedNamed', { name: 'wt' }, 'wt removed (1 file)', 'wt removed (2 files)'],
    ['changes.removed', {}, 'Removed (1 file)', 'Removed (2 files)'],
    ['log.count', {}, '1 event', '2 events'],
    ['inflight.count', {}, '1 call', '2 calls'],
    ['wf.agents', {}, '1 agent', '2 agents'],
    ['fleet.tools', {}, '1 call', '2 calls'],
    ['fleet.toolCount', {}, '1 tool call', '2 tool calls'],
    ['fleet.suits', {}, ' suit', ' suits'],
    ['stats.dispatches', {}, '1 dispatch', '2 dispatches'],
    ['remote.more', {}, '1 more remote', '2 more remotes'],
    ['branch.more', {}, '1 more branch', '2 more branches'],
    ['repo.more', {}, '… 1 more repo', '… 2 more repos'],
    ['squad.moreRows', {}, '… 1 more row not shown', '… 2 more rows not shown'],
    ['tasks.moreRows', {}, '1 more row', '2 more rows'],
  ]

  test('a count of 1 takes the singular, 2 the plural', () => {
    inLocale('en', () => {
      for (const [key, vars, one, two] of COUNTED) {
        expect([key, t(key, { ...vars, n: 1 })]).toEqual([key, one])
        expect([key, t(key, { ...vars, n: 2 })]).toEqual([key, two])
      }
      expect(t('log.total', { total: 1, max: 200 })).toBe('1/200 events')
      expect(t('log.total', { total: 1, max: 1 })).toBe('1/1 event')
    })
  })

  test('zh-TW counts read as before for 1 and 2', () => {
    expect(t('changes.files', { n: 1 })).toBe('1 檔')
    expect(t('changes.files', { n: 2 })).toBe('2 檔')
    expect(t('fleet.suits', { n: 1 })).toBe(' 艘')
    expect(t('log.count', { n: 2 })).toBe('2 則')
  })

  test('a plural form whose count is missing stays as written', () => {
    expect(inLocale('en', () => t('changes.files', { m: 1 }))).toBe('{n} {n|file|files}')
  })
})

describe('en: the task board as the model reads it', () => {
  test('the tool description and every parameter description are English', () => {
    inLocale('en', () => {
      expect(TASK_TOOL_SPEC.description).toContain("Maintain this session's task board")
      expect(TASK_TOOL_SPEC.description).not.toMatch(CJK)
      for (const p of Object.values(TASK_TOOL_SPEC.inputSchema.properties)) {
        if ('description' in p) expect(p.description).not.toMatch(CJK)
      }
    })
    expect(TASK_TOOL_SPEC.description).toContain('本輪請求')
  })

  test('the system prompt section and the note beside a prompt are English', () => {
    inLocale('en', () => {
      expect(TASK_PROMPT.split('\n')[0]).toBe('# Task board')
      expect(TASK_PROMPT).toContain('mcp__jarvis__task')
      expect(TASK_PROMPT).not.toMatch(CJK)
      expect(requestContext('7')).toContain('recorded as item 7')
      expect(requestContext('7')).toContain('update id=7')
      expect(requestContext('7')).not.toMatch(CJK)
    })
  })

  test("the tool's board text and its refusals are English", () => {
    inLocale('en', () => {
      const r = applyTask({ items: [], nextItem: 1 }, { op: 'add', item: 'Ship it', subtasks: ['test', 'merge'] })
      if ('error' in r) throw new Error(r.error)
      expect(r.text).toBe(['Task board (0/1 items · subtasks 0/2)', '[ ] 1 Ship it', '  [ ] 1.1 test', '  [ ] 1.2 merge'].join('\n'))
      expect(boardText({ items: [], nextItem: 1 })).toBe('The task board is empty.')
      const bad = applyTask(r.board, { op: 'update', id: '9.9', status: 'completed' })
      expect('error' in bad && bad.error).toBe('Not found: 9.9. An id names an item (like "2") or a subtask (like "2.3")')
      const op = applyTask(r.board, { op: 'nope' })
      expect('error' in op && op.error).toBe('op must be one of add, update, remove, list')
    })
  })
})

describe('en: the small model asks', () => {
  test('the summary and classify asks are English, the request kept as sent', () => {
    inLocale('en', () => {
      const result = resultAsk('compute 7*6', '42', ['multiply'])
      expect(result).toContain('In at most 80 characters')
      expect(result).toContain('Request:\ncompute 7*6')
      expect(result).toContain('Subtasks:\n- multiply')
      expect(result).toContain('Answer:\n42')
      const ask = classifyAsk('push', [{ id: '2', title: 'jarvis i18n', latest: 'Add English' }], { title: 'Add English', topic: '2' })
      expect(ask).toContain('2 jarvis i18n (latest request: Add English)')
      expect(ask).toContain('Previous request: Add English (topic 2)')
      for (const text of [result, ask, SUMMARY_SYSTEM, CLASSIFY_SYSTEM]) expect(text).not.toMatch(CJK)
    })
  })

  test('an English reply is read: a topic number joins, New opens a topic, a repeated instruction is dropped', () => {
    const offered = [{ id: '2', title: 'jarvis i18n', latest: 'Add English' }]
    inLocale('en', () => {
      expect(parseClassify('Fix the tab bar\nTopic 2', offered)).toEqual({ title: 'Fix the tab bar', choice: { kind: 'join', id: '2', title: 'jarvis i18n' } })
      expect(parseClassify('Fix the tab bar\nNew billing cleanup', offered)).toEqual({ title: 'Fix the tab bar', choice: { kind: 'new', title: 'billing cleanup' } })
      expect(parseClassify('Fix the tab bar\n新 帳單', offered).choice).toEqual({ kind: 'new', title: '帳單' })
      expect(parseClassify('Fix it\nnewsletter', offered).choice).toEqual({ kind: 'new', title: 'Fix it' })
      expect(cleanSummary('Reply with only two lines:', 20)).toBe('')
    })
    // zh-TW reads only what it read before
    expect(parseClassify('修 bug\nNew billing', offered).choice).toEqual({ kind: 'new', title: '修 bug' })
    expect(cleanSummary('Reply with only two lines', 40)).toBe('Reply with only two lines')
  })
})

describe('en: summary lengths', () => {
  test('English keeps about twice the characters, and the asks say so; zh-TW keeps its limits', () => {
    expect([SUMMARY_TITLE_MAX, RESULT_MAX, TOPIC_TITLE_MAX]).toEqual([20, 40, 16])
    inLocale('en', () => {
      expect([SUMMARY_TITLE_MAX, RESULT_MAX, TOPIC_TITLE_MAX]).toEqual([40, 80, 32])
      expect(resultAsk('p', 'a')).toContain('In at most 80 characters')
      const ask = classifyAsk('p', [])
      expect(ask).toContain('In at most 40 characters')
      expect(ask).toContain('a topic name of at most 32 characters')
    })
  })

  test("each English example fits the limit its ask states", () => {
    inLocale('en', () => {
      const quoted = (key: MsgKey) => [...DICTIONARIES.en[key].matchAll(/"([^"]+)"/g)].map(m => m[1] ?? '')
      for (const x of quoted('sum.result').filter(x => x !== 'Title:')) expect([x, x.length <= RESULT_MAX]).toEqual([x, true])
      for (const x of quoted('cls.title')) expect([x, x.length <= SUMMARY_TITLE_MAX]).toEqual([x, true])
      const topic = quoted('cls.line2').find(x => x.startsWith('New ') && x.length > 4) ?? ''
      expect(topic).toBe('New Check-in top-ups')
      expect(topic.slice(4).length).toBeLessThanOrEqual(TOPIC_TITLE_MAX)
    })
  })

  test('English is cut at a word boundary; a single long word, and zh-TW, are cut mid-word', () => {
    inLocale('en', () => {
      expect(cleanSummary('Add English to jarvis', SUMMARY_TITLE_MAX)).toBe('Add English to jarvis')
      expect(cleanSummary('Add English locale support to the jarvis mod panel', 40)).toBe('Add English locale support to the…')
      expect(cleanSummary('x'.repeat(50), 40)).toBe(`${'x'.repeat(39)}…`)
    })
    expect(cleanSummary('Add English locale support to the jarvis mod panel', 40)).toBe('Add English locale support to the jarvi…')
  })
})

describe('en: time and the /jarvis answer', () => {
  test('relative times read in English', () => {
    inLocale('en', () => {
      expect(relTime(10_000)).toBe('just now')
      expect(relTime(5 * 60_000)).toBe('5m ago')
      expect(relTime(3 * 3600_000)).toBe('3h ago')
      expect(relTime(30 * 3600_000)).toBe('yesterday')
      expect(relTime(5 * 86400_000)).toBe('5d ago')
      expect(relTime(90 * 86400_000)).toBe('3mo ago')
      expect(relTime(800 * 86400_000)).toBe('2y ago')
    })
    expect(relTime(5 * 60_000)).toBe('5 分鐘前')
  })

  test('/jarvis answers in English', () => {
    inLocale('en', () => {
      expect(jarvisOpenText(false, undefined, [])).toBe('Failed to open the Jarvis pane')
      expect(jarvisOpenText({ isPlaced: true }, undefined, [])).toBe('Jarvis pane opened')
      const off = jarvisOpenText({ isPlaced: false, reason: 'too narrow' }, 'bridge', ['terminal'])
      expect(off).toContain('engine reason: too narrow')
      expect(off).not.toMatch(CJK)
    })
  })
})

// ---- wired: the locale comes from JARVIS_LANG at session start ----

type Registered = { name: string; description?: string }

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const wired = (on: On, env: Record<string, string>, reply?: (prompt: string) => string) => {
  const registered: Registered[] = []
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, env)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', async () => ({}))
  on('agent.spawn', async () => ({ model: HAIKU, agentId: 'agent-1' }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))
  on('prompt.submit', async (_$, e) => ({ text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }))
  on('tool.register', async (_$, e) => {
    registered.push({ name: e.name, ...(typeof e.description === 'string' ? { description: e.description } : {}) })
    return { value: { tool: `mcp__jarvis__${e.name}` } }
  })
  on('prompt.compose', async () => ({ sections: [] }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('model.complete', async (_$, e) => ({
    value: (reply === undefined
      ? { isAnswered: false, reason: 'empty-reply', usage: USAGE }
      : { isAnswered: true, text: reply(e.prompt), usage: USAGE }) as never,
  }))
  return { registered, clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

const composeFor = (tools: string[]) => ({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools, outputStyle: null, traits: [] })

const plainText = (n: Node | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(plainText).join(''))

// width in cells of each drawn row: a row Box's texts side by side, as the pane draws them
const rowWidths = (n: Node | string): number[] => {
  if (typeof n === 'string') return [cellWidth(n)]
  if (n.type === 'Text') return [cellWidth(plainText(n))]
  const kids = n.children ?? []
  if (
    n.props?.['flexDirection'] === 'row' &&
    kids.every(k => typeof k !== 'string' && (k.type === 'Text' || (k.type === 'Button' && k.props?.['plain'])))
  ) {
    return [kids.reduce((sum, k) => sum + cellWidth(plainText(k)), 0)]
  }
  return kids.flatMap(rowWidths)
}

describe('en wired', () => {
  test('JARVIS_LANG=en: the board tool registers with its English description; the prompt section is English', async ($, on) => {
    const w = wired(on, { JARVIS_LANG: 'en' })
    await start($)
    const reg = w.registered.find(r => r.name === 'task')
    expect(reg?.description).toContain("Maintain this session's task board")
    expect(reg?.description).not.toMatch(CJK)
    const out = await $.prompt.compose(composeFor([TASK_TOOL]))
    const section = out.sections.find(s => s.id === 'jarvis:tasks')
    expect(section?.text.startsWith('# Task board')).toBe(true)
    expect(section?.text).not.toMatch(CJK)
  })

  test('JARVIS_LANG unset: the description stays the zh-TW one', async ($, on) => {
    const w = wired(on, {})
    await start($)
    expect(w.registered.find(r => r.name === 'task')?.description).toBe(DICTIONARIES['zh-TW']['tool.intro'] + '\n' + DICTIONARIES['zh-TW']['tool.add'] + '\n' + DICTIONARIES['zh-TW']['tool.update'] + '\n' + DICTIONARIES['zh-TW']['tool.remove'] + '\n' + DICTIONARIES['zh-TW']['tool.list'] + '\n' + DICTIONARIES['zh-TW']['tool.reply'])
  })

  test('JARVIS_LANG=en: a sent prompt carries the English note; the tool answers in English', async ($, on) => {
    wired(on, { JARVIS_LANG: 'en' })
    await start($)
    const sent = await $.prompt.submit({ text: 'Add English to jarvis', wait: false, origin: { kind: 'composer' } } as never)
    expect(sent.context).toContain(inLocale('en', () => requestContext('1')))
    const listed = await $.tool.call({ tool: TASK_TOOL, op: 'list' } as never)
    expect(String(listed.result)).toBe('Task board (0/1 items · subtasks 0/0)\n[>] 1 Add English to jarvis (current request)')
  })

  test('JARVIS_LANG=en: every terminal page, wide and narrow, is English and within the pane', async ($, on) => {
    wired(on, { JARVIS_LANG: 'en', JARVIS_DESKTOP_LAYOUT: 'cells' })
    await start($)
    await $.agent.spawn(spawnInput('review the i18n change', 'verifier'))
    await $.tool.call({ tool: 'Read', file_path: '/tmp/a.md' } as never)
    for (const page of ['now', 'log', 'stats', 'fleet', 'changes', 'tasks']) {
      await pressOn($, 'terminal', `tab-${page}`)
      for (const cols of [40, 80]) {
        const tree = await drawOn($, 'terminal', 40, cols)
        const text = textOf(tree)
        expect([page, cols, CJK.test(text)]).toEqual([page, cols, false])
        expect([page, cols, Math.max(...rowWidths(tree)) <= cols]).toEqual([page, cols, true])
      }
    }
    const now = textOf(await drawOn($, 'terminal', 40, 120))
    for (const word of ['Now', 'Events', 'Stats', 'Fleet', 'Changes', 'Tasks']) expect(now).toContain(word)
  })

  test('JARVIS_LANG=en: long English titles and results stay within the task page, wide and narrow', async ($, on) => {
    const { clock } = wired(on, { JARVIS_LANG: 'en', JARVIS_DESKTOP_LAYOUT: 'cells' }, prompt =>
      prompt.includes('Answer:')
        ? 'Shipped the English locale with plurals, word-boundary cuts and wider summary limits everywhere'
        : 'Add English locale support to the jarvis mod panel and every desktop page\nNew Jarvis internationalization and localization work',
    )
    await start($)
    const text = 'Add English to jarvis'
    await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
    await clock.settle()
    await $.turn.start({ text, turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/tmp/a.md' } as never)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.settle()
    const board = String((await $.tool.call({ tool: TASK_TOOL, op: 'list' } as never)).result)
    expect(board).toContain('[x] 1 Add English locale support to the… →')
    expect(board).toContain('→ Shipped the English locale with plurals, word-boundary cuts and wider summary…')
    await pressOn($, 'terminal', 'tab-tasks')
    for (const cols of [40, 80]) {
      const tree = await drawOn($, 'terminal', 40, cols)
      expect([cols, CJK.test(textOf(tree))]).toEqual([cols, false])
      expect([cols, Math.max(...rowWidths(tree)) <= cols]).toEqual([cols, true])
    }
  })

  test('JARVIS_LANG=en: the native Desktop pages are English', async ($, on) => {
    wired(on, { JARVIS_LANG: 'en' })
    await start($)
    await $.agent.spawn(spawnInput('review the i18n change', 'verifier'))
    await $.tool.call({ tool: 'Read', file_path: '/tmp/a.md' } as never)
    for (const page of ['now', 'log', 'stats', 'fleet', 'changes', 'tasks']) {
      await pressOn($, 'desktop', `tab-${page}`, 50, 100)
      const text = textOf(await drawOn($, 'desktop', 50, 100))
      expect([page, CJK.test(text)]).toEqual([page, false])
    }
    await pressOn($, 'desktop', 'tab-now', 50, 100)
    const now = textOf(await drawOn($, 'desktop', 50, 100))
    expect(now).toContain('Subagents')
    expect(now).toContain('Recent events')
  })
})
