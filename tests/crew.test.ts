import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { CrewAgent, CrewEvent, CrewInflight, CrewMain } from '../types'
import {
  MAX_EVENTS,
  STALE_MS,
  STUCK_MS,
  addAgent,
  addEvent,
  buildCockpit,
  barLen,
  cellWidth,
  describeCall,
  dispatchStats,
  healthOf,
  healthOfState,
  modelShares,
  paceBuckets,
  roleOf,
  costAt,
  elapsedMs,
  finishTurn,
  finishedOf,
  fitCells,
  fmtClock,
  fmtK,
  fmtMs,
  markStale,
  padCells,
  paceChart,
  noteTool,
  shortModel,
  staleOf,
  tokenTotal,
  summarize,
  summaryLine,
  familyOf,
} from '../hooks/crew'
import { MIN_EVENT_ROWS, TINY_COLS, WIDE_COLS } from '../hooks/cockpit'
import {
  MAX_FAILURES,
  REFRESH_MS,
  THROTTLE_MS,
  createReporter,
  crewText,
  inHerdr,
  reportArgv,
} from '../hooks/herdr'
import { register } from '../hooks/register'

const near = (got: number | undefined, want: number, digits: number) =>
  expect(got !== undefined && Math.abs(got - want) < 10 ** -digits).toBe(true)

const HAIKU = 'claude-haiku-5-5'
const SONNET = 'claude-sonnet-5-5'

const usage = (model: string, i: number, o: number, cr: number, cw: number) => ({
  model,
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cw,
})

const agent = (over: Partial<CrewAgent>): CrewAgent => ({
  id: 'x',
  type: 'worker',
  description: 'd',
  model: SONNET,
  status: 'done',
  tool: '',
  runStartedAt: 0,
  lastSeenAt: 0,
  doneMs: 0,
  endedAt: 1,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...over,
})

describe('pure logic', () => {
  test('model names are shortened', () => {
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(shortModel('claude-opus-4-20250514')).toBe('Opus 4')
    expect(shortModel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
    expect(shortModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
    expect(shortModel('mystery-model')).toBe('mystery-model')
  })

  test('token format uses k', () => {
    expect(fmtK(950)).toBe('950')
    expect(fmtK(1234)).toBe('1.2k')
    expect(fmtK(64_000)).toBe('64k')
  })

  test('cost estimate matches a hand calculation', () => {
    // haiku: 1M in, 0.5M out, 2M cache read, 0.4M cache write
    //   0.10*1 + 0.50*0.5 + 0.01*2 + 0.125*0.4 = 0.1 + 0.25 + 0.02 + 0.05 = 0.42
    // same tokens at opus: 4*1 + 20*0.5 + 0.4*2 + 5*0.4 = 4 + 10 + 0.8 + 2 = 16.8
    const haiku = { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 400_000 }
    near(costAt(haiku, 'haiku'), 0.42, 9)
    near(costAt(haiku, 'opus'), 16.8, 9)

    // sonnet: 1M in + 1M out = 2 + 10 = 12; at opus 4 + 20 = 24
    const list = [
      agent({
        id: 'h',
        model: HAIKU,
        input: 1_000_000,
        output: 500_000,
        cacheRead: 2_000_000,
        cacheWrite: 400_000,
      }),
      agent({ id: 's', model: SONNET, input: 1_000_000, output: 1_000_000 }),
      agent({ id: 'u', model: 'mystery-model', input: 9_000_000 }),
    ]
    const sum = summarize(list)
    near(sum.cost, 12.42, 9)
    near(sum.opusCost, 40.8, 9)
    // (40.8 - 12.42) / 40.8 = 69.558...%
    near(sum.savedPct, 69.5588, 3)
    // the unknown model is listed but never priced
    expect(sum.groups.map(g => g.label)).toContain('其他')
    expect(sum.groups.find(g => g.label === 'Haiku')?.count).toBe(1)
  })

  test('only generation 5 models are priced; Haiku 4.5 is other', () => {
    expect(familyOf('claude-haiku-5-5')).toBe('haiku')
    expect(familyOf('claude-sonnet-5-5[1m]')).toBe('sonnet')
    expect(familyOf('claude-opus-5-5')).toBe('opus')
    expect(familyOf('claude-fable-5-1')).toBe('fable')
    expect(familyOf('haiku')).toBe('haiku')
    expect(familyOf('fable')).toBe('fable')
    expect(familyOf('claude-haiku-4-5-20251001')).toBeUndefined()
    expect(familyOf('claude-opus-4-20250514')).toBeUndefined()
    expect(familyOf('claude-3-5-sonnet-20241022')).toBeUndefined()

    const sum = summarize([agent({ model: 'claude-haiku-4-5-20251001', input: 1_000_000 })])
    expect(sum.cost).toBe(0)
    expect(sum.savedPct).toBeUndefined()
    expect(sum.groups.map(g => g.label)).toEqual(['其他'])
    // the label still shows the real version
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  })

  test('token display counts input + output only', () => {
    expect(tokenTotal({ input: 100, output: 50, cacheRead: 9000, cacheWrite: 800 })).toBe(150)
  })

  test('fable cache read is priced at 0.025 x input', () => {
    // fable: 1M in, 1M out, 4M cache read, 1M cache write
    //   10*1 + 50*1 + 10*0.025*4 + 10*1.25*1 = 10 + 50 + 1 + 12.5 = 73.5
    const t = { input: 1_000_000, output: 1_000_000, cacheRead: 4_000_000, cacheWrite: 1_000_000 }
    near(costAt(t, 'fable'), 73.5, 9)
    // opus keeps 0.1: 4 + 20 + 4*0.4 + 5 = 30.6
    near(costAt(t, 'opus'), 30.6, 9)
  })

  test('one-line summary format', () => {
    const m = (id: string, n: number, extra: Partial<CrewAgent> = {}) =>
      Array.from({ length: n }, (_, i) => agent({ id: `${id}${i}`, model: id, ...extra }))
    // haiku 1M in = 0.1 each; x5 = 0.5; opus 4 each x5 = 20; sonnet 1M in = 2 vs opus 4
    const single = summarize(m(HAIKU, 1, { input: 1_000_000 }))
    expect(summaryLine(single)).toBe('Haiku×1 · ≈$0.10 vs Opus $4.00（省98%）')

    // sorted by count; unknown goes to 其他
    const multi = summarize([
      ...m(HAIKU, 2, { input: 1_000_000 }),
      ...m(SONNET, 1, { input: 1_000_000 }),
      ...m('claude-opus-5-5', 3, { input: 1_000_000 }),
      ...m('mystery', 1),
    ])
    // cost 0.2 + 2 + 12 = 14.2; opus 24; saved 40.83% -> 41
    expect(summaryLine(multi)).toBe('Opus×3 Haiku×2 Sonnet×1 其他×1 · ≈$14.20 vs Opus $24.00（省41%）')

    // dearer than all-Opus
    const dear = summarize(m('claude-fable-5-1', 1, { input: 1_000_000 }))
    expect(summaryLine(dear)).toBe('Fable×1 · ≈$10.00 vs Opus $4.00（多花150%）')

    // under a cent: 3 decimals
    const tiny = summarize(m(HAIKU, 1, { input: 10_000 }))
    expect(summaryLine(tiny)).toBe('Haiku×1 · ≈$0.001 vs Opus $0.04（省98%）')
  })

  test('a subagent tool call shows the tool, and resumes a finished one', () => {
    let list = addAgent([], { id: 'a', type: 'worker', description: 'd', model: SONNET, now: 100 })
    list = noteTool(list, 'a', 'Bash', 150)
    expect(list[0]?.tool).toBe('Bash')
    expect(list[0]?.status).toBe('running')

    list = finishTurn(list, 'a', { reason: 'answer', durationMs: 5000 }, 200)
    expect(list[0]).toMatchObject({ status: 'done', tool: '', endedAt: 200, doneMs: 5000 })

    // SendMessage continues the agent: its next tool call marks it running again
    list = noteTool(list, 'a', 'Read', 300)
    expect(list[0]).toMatchObject({ status: 'running', tool: 'Read', runStartedAt: 300 })
    list = finishTurn(list, 'a', { reason: 'error', durationMs: 2000 }, 400)
    expect(list[0]).toMatchObject({ status: 'failed', doneMs: 7000 })

    // an id nobody spawned changes nothing
    expect(noteTool(list, 'zzz', 'Bash', 500)).toEqual(list)
  })

  test('only the latest 50 agents are kept, finished ones dropped first', () => {
    let list: CrewAgent[] = []
    list = addAgent(list, { id: 'run', type: 'worker', description: 'd', model: SONNET, now: 0 })
    for (let i = 0; i < 60; i += 1) {
      list = addAgent(list, { id: `a${i}`, type: 'worker', description: 'd', model: SONNET, now: i })
      list = finishTurn(list, `a${i}`, { reason: 'answer', durationMs: 1 }, i)
    }
    expect(list).toHaveLength(50)
    expect(list.some(a => a.id === 'run')).toBe(true)
    expect(list.some(a => a.id === 'a59')).toBe(true)
    expect(list.some(a => a.id === 'a0')).toBe(false)
  })
})

describe('stale subagents', () => {
  test('running past STALE_MS without an event goes stale; fresh ones stay', () => {
    let list = addAgent([], { id: 'a', type: 'worker', description: 'd', model: SONNET, now: 0 })
    list = addAgent(list, { id: 'b', type: 'worker', description: 'd', model: SONNET, now: 0 })
    list = noteTool(list, 'b', 'Bash', STALE_MS)

    expect(markStale(list, STALE_MS)).toBe(list) // exactly at the limit: not yet
    const out = markStale(list, STALE_MS + 1)
    expect(out.find(a => a.id === 'a')?.status).toBe('stale')
    expect(out.find(a => a.id === 'b')?.status).toBe('running')
    expect(staleOf(out).map(a => a.id)).toEqual(['a'])
    expect(finishedOf(out)).toHaveLength(0)
    // done agents are never touched
    const done = finishTurn(list, 'a', { reason: 'answer', durationMs: 1 }, 5)
    expect(markStale(done, STALE_MS * 5).find(a => a.id === 'a')?.status).toBe('done')
  })

  test('a stale agent heard from again is running, its run still counting', () => {
    let list = addAgent([], { id: 'a', type: 'worker', description: 'd', model: SONNET, now: 100 })
    list = [...markStale(list, 100 + STALE_MS + 1)]
    expect(list[0]?.status).toBe('stale')
    // frozen at the last event while stale
    expect(elapsedMs(list[0] as CrewAgent, 99_999_999)).toBe(0)

    list = noteTool(list, 'a', 'Read', 100 + STALE_MS + 5000)
    expect(list[0]).toMatchObject({ status: 'running', tool: 'Read', runStartedAt: 100 })
    expect(list[0]?.lastSeenAt).toBe(100 + STALE_MS + 5000)
  })
})

describe('herdr row text', () => {
  test('running, finished, savings, lost', () => {
    const run = (id: string) => agent({ id, status: 'running', model: SONNET })
    const done = (id: string) => agent({ id, model: SONNET, input: 1_000_000, output: 1_000_000 })
    // sonnet 12 vs opus 24: saves 50%
    expect(crewText([])).toBeUndefined()
    expect(crewText([run('a'), run('b'), done('c')])).toBe('▶2 ✓1 · 省50%')
    expect(crewText([done('c'), done('d')])).toBe('✓2 · 省50%')
    expect(crewText([run('a'), done('c'), agent({ id: 's', status: 'stale', model: SONNET })])).toBe(
      '▶1 ✓1 ⚠1 · 省50%',
    )
    // an unpriced model has no savings figure
    expect(crewText([agent({ id: 'x', model: 'mystery-model' })])).toBe('✓1')
    // dearer than all-Opus
    expect(crewText([agent({ id: 'f', model: 'claude-fable-5-1', input: 1_000_000 })])).toBe(
      '✓1 · 多花150%',
    )
  })

  test('the command argv', () => {
    expect(reportArgv('p-1', '✓0 · test')).toEqual([
      'herdr', 'pane', 'report-metadata', 'p-1', '--source', 'crew',
      '--token', 'crew=✓0 · test', '--ttl-ms', '900000',
    ])
    expect(reportArgv('p-1', undefined)).toEqual([
      'herdr', 'pane', 'report-metadata', 'p-1', '--source', 'crew', '--clear-token', 'crew',
    ])
  })

  test('only HERDR_ENV=1 with a pane id counts as Herdr', () => {
    expect(inHerdr('1', 'p-1')).toBe(true)
    expect(inHerdr('1', undefined)).toBe(false)
    expect(inHerdr('1', '')).toBe(false)
    expect(inHerdr(undefined, 'p-1')).toBe(false)
    expect(inHerdr('0', 'p-1')).toBe(false)
  })

  test('reporter: unchanged text is resent after REFRESH_MS so the row does not expire', async () => {
    const sent: string[][] = []
    const r = createReporter('p-1', async argv => (sent.push(argv), true))

    await r.step('a', 0)
    await r.step('a', REFRESH_MS - 1)
    expect(sent).toHaveLength(1)
    await r.step('a', REFRESH_MS)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain('crew=a')

    await r.step(undefined, REFRESH_MS + THROTTLE_MS) // cleared once
    await r.step(undefined, REFRESH_MS * 3) // a cleared row is never resent
    expect(sent).toHaveLength(3)
  })

  test('reporter: unchanged text is not sent, changes wait out the throttle', async () => {
    const sent: string[][] = []
    const r = createReporter('p-1', async argv => (sent.push(argv), true))

    await r.step(undefined, 0) // nothing to show, nothing sent
    expect(sent).toHaveLength(0)

    await r.step('a', 10_000)
    expect(sent).toHaveLength(1)
    await r.step('a', 20_000) // same text
    expect(sent).toHaveLength(1)

    await r.step('b', 10_000 + THROTTLE_MS - 1) // changed, but too soon after the send
    expect(sent).toHaveLength(1)
    await r.step('b', 10_000 + THROTTLE_MS)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain('crew=b')

    await r.step('c', 10_000 + THROTTLE_MS + 1) // changed again 1 ms later: held
    expect(sent).toHaveLength(2)
    await r.step('c', 10_000 + THROTTLE_MS * 2) // the last change always goes out
    expect(sent).toHaveLength(3)
    expect(sent[2]).toContain('crew=c')

    await r.step(undefined, 20_000) // everything gone: clear
    expect(sent[3]).toEqual(reportArgv('p-1', undefined))
  })

  test('reporter: stops after 3 failures in a row, a success resets the count', async () => {
    let ok = false
    let calls = 0
    const r = createReporter('p-1', async () => (calls++, ok))
    await r.step('a', 0)
    await r.step('b', 10_000)
    ok = true
    await r.step('c', 20_000) // success: count back to zero
    ok = false
    await r.step('d', 30_000)
    await r.step('e', 40_000)
    expect(r.isStopped()).toBe(false)
    await r.step('f', 50_000)
    expect(r.isStopped()).toBe(true)
    expect(calls).toBe(3 + MAX_FAILURES)
    await r.step('g', 90_000)
    expect(calls).toBe(3 + MAX_FAILURES)
  })

  test('reporter: a run that throws counts as a failure and is not retried', async () => {
    let calls = 0
    const r = createReporter('p-1', async () => {
      calls++
      throw new Error('no socket')
    })
    await r.step('a', 0)
    await r.step('a', 10_000)
    expect(calls).toBe(1)
  })
})

type Node = { type?: string; props?: Record<string, unknown>; children?: (Node | string)[] }

const textOf = (n: Node | string): string =>
  typeof n === 'string' ? n : (n.children ?? []).map(textOf).join('')

// One string per drawn row: a row Box joins its children, a column Box stacks them.
const linesOf = (n: Node | string): string[] => {
  if (typeof n === 'string') return [n]
  if (n.type === 'Text') return [textOf(n)]
  const kids = n.children ?? []
  if (n.props?.flexDirection === 'row') return [kids.map(textOf).join(' ')]
  return kids.flatMap(linesOf)
}

const findText = (n: Node | string, re: RegExp): Node | undefined => {
  if (typeof n === 'string') return undefined
  if (n.type === 'Text' && re.test(textOf(n))) return n
  for (const k of n.children ?? []) {
    const hit = findText(k, re)
    if (hit) return hit
  }
  return undefined
}

const draw = async ($: Engine, rows = 30, cols = 80): Promise<Node> =>
  (await $.ui.render({
    surface: 'terminal',
    component: 'Pane',
    requestId: 'crew',
    viewport: { columns: cols + 20, rows: rows + 10 },
    props: {
      title: 'Crew',
      isFocused: false,
      bodyColumns: cols,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: rows },
      view: {},
    },
  })) as RenderElement as Node

const spawnInput = (over: { description: string; subagentType: string; id?: string }) => ({
  tool_use_id: over.id ?? 'tu-1',
  prompt: 'p',
  description: over.description,
  subagentType: over.subagentType,
  provider: { plugin: 'engine', tier: 'core' } as const,
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
})

const complete = (agentId: string | undefined, over: Record<string, unknown> = {}) => ({
  ...(agentId === undefined ? {} : { agentId }),
  answer: 'ok',
  durationMs: 1000,
  isAborted: false,
  turnId: 't',
  reason: 'answer' as const,
  ...over,
})

const submit = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } as const })

// the test-side bottom of the chain, standing for the engine
const engine = (on: On, agentId?: string) => {
  const clock = mock.clock(on, { now: 0 })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  if (agentId !== undefined) on('agent.spawn', async () => ({ model: HAIKU, agentId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  return clock
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

// how many times the mod has written its tick: counted beneath the mod, at the state bottom
const ticks = (on: On) => {
  const count = { n: 0 }
  on('state.set', { plugin: 'crew', key: 'tick' }, async (_$, e, next) => {
    count.n += 1
    return next(e)
  })
  return count
}

describe('hooks', () => {
  test('spawn -> turn.complete draws the agent, usage adds up across turns', async ($, on) => {
    engine(on, 'agent-1')
    expect(linesOf(await draw($)).join('\n')).toContain('還沒有派工')

    await $.agent.spawn(spawnInput({ description: 'find files', subagentType: 'Explore' }))
    let lines = linesOf(await draw($))
    expect(lines.some(l => /Explore .*Haiku 5\.5.* find files/.test(l))).toBe(true)
    expect(lines.some(l => l.includes('執行中 (1)'))).toBe(true)

    await $.turn.complete(
      complete('agent-1', { durationMs: 4000, usage: usage(HAIKU, 100, 50, 1000, 200) }),
    )
    // SendMessage continues the same subagent: a second turn, usage adds up
    await $.turn.complete(
      complete('agent-1', { durationMs: 1000, usage: usage(HAIKU, 10, 5, 100, 20) }),
    )

    lines = linesOf(await draw($))
    const row = lines.find(l => l.includes('find files'))
    expect(row).toContain('✓')
    expect(row).toContain('5s')
    expect(row).toContain('165') // input + output only: 110 + 55
    expect(lines.some(l => l.includes('已完成 (1)'))).toBe(true)
    expect(lines.some(l => l.startsWith('Haiku×1 · ≈$'))).toBe(true)
  })

  test('a failed reason shows ✗; unknown agents are ignored', async ($, on) => {
    engine(on, 'agent-2')
    await $.agent.spawn(spawnInput({ description: 'x task', subagentType: 'worker' }))
    await $.turn.complete(complete('agent-2', { reason: 'aborted', isAborted: true }))
    await $.turn.complete(
      complete('engine-fork', { usage: usage(SONNET, 1, 1, 1, 1), reason: 'answer' }),
    )

    const lines = linesOf(await draw($))
    expect(lines.find(l => l.includes('x task'))).toContain('✗')
    expect(lines.filter(l => l.includes('x task'))).toHaveLength(1)
    expect(lines.some(l => l.includes('已完成 (1)'))).toBe(true)
  })

  test('main model comes from the main loop turn.complete', async ($, on) => {
    engine(on)
    await $.turn.complete(complete(undefined, { usage: usage('claude-opus-5-5', 1, 1, 0, 0) }))

    const lines = linesOf(await draw($))
    expect(lines.some(l => l.includes('主 session · Opus 5.5'))).toBe(true)
  })

  test('main chain counts main tool calls, turns yellow at 4, resets', async ($, on) => {
    engine(on)
    const chain = async () => {
      const tree = await draw($)
      const node = findText(tree, /^\d+\/4$/)
      return { text: node ? textOf(node) : '', color: node?.props?.color }
    }

    for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Read', file_path: '/x' })
    expect(await chain()).toMatchObject({ text: '3/4' })
    expect((await chain()).color).toBeUndefined()

    await $.tool.call({ tool: 'Read', file_path: '/x' })
    expect(await chain()).toMatchObject({ text: '4/4', color: 'yellow' })

    await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'd', subagent_type: 'worker' })
    expect((await chain()).text).toBe('0/4')

    await $.tool.call({ tool: 'Read', file_path: '/x' })
    await $.tool.call({ tool: 'Read', file_path: '/y' })
    expect((await chain()).text).toBe('2/4')

    await $.prompt.submit(submit('next'))
    expect((await chain()).text).toBe('0/4')
  })

  test('every hook passes its event to next untouched', async ($, on) => {
    mock.clock(on)
    const seen: Record<string, unknown[]> = {}
    const note = (name: string, e: unknown) => (seen[name] = [...(seen[name] ?? []), e])

    on('agent.spawn', async (_$, e) => {
      note('agent.spawn', e)
      return { model: SONNET, agentId: 'agent-3' }
    })
    on('tool.call', async (_$, e) => {
      note('tool.call', e)
      return { result: {} as never }
    })
    on('turn.complete', async (_$, e) => {
      note('turn.complete', e)
      return { text: e.answer }
    })
    on('prompt.submit', async (_$, e) => {
      note('prompt.submit', e)
      return { text: e.text }
    })
    on('session.start', async (_$, e) => {
      note('session.start', e)
      return { cwd: e.cwd }
    })

    const input = spawnInput({ description: 'd', subagentType: 'worker' })
    const spawned = await $.agent.spawn(input)
    expect(spawned).toMatchObject({ model: SONNET, agentId: 'agent-3' })
    await $.tool.call({ tool: 'Read', file_path: '/x' })
    const done = await $.turn.complete(complete('agent-3', { answer: 'fin' }))
    expect(done.text).toBe('fin')
    const submitted = await $.prompt.submit(submit('hello'))
    expect(submitted.text).toBe('hello')
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

    for (const name of ['agent.spawn', 'tool.call', 'turn.complete', 'prompt.submit', 'session.start']) {
      expect(seen[name]).toHaveLength(1)
    }
    expect(seen['agent.spawn']?.[0]).toMatchObject(input)
    expect(seen['tool.call']?.[0]).toMatchObject({ tool: 'Read', file_path: '/x' })
    expect(seen['prompt.submit']?.[0]).toMatchObject({ text: 'hello' })
    expect(seen['turn.complete']?.[0]).toMatchObject({ agentId: 'agent-3', answer: 'fin' })
  })

  test('a spawn that started no agent still passes through and records nothing', async ($, on) => {
    mock.clock(on)
    on('agent.spawn', async () => ({ model: SONNET }))
    const out = await $.agent.spawn(spawnInput({ description: 'd', subagentType: 'worker' }))
    expect(out.model).toBe(SONNET)
    expect(linesOf(await draw($)).join('\n')).toContain('還沒有派工')
  })

  test('the clock ticks while a subagent runs: seconds count up', async ($, on) => {
    const clock = engine(on, 'agent-4')
    await start($)
    await $.agent.spawn(spawnInput({ description: 'long job', subagentType: 'worker' }))
    const rowOf = async () => linesOf(await draw($)).find(l => l.includes('long job')) ?? ''

    expect(await rowOf()).toContain('0s')
    await clock.advance(1000)
    await clock.advance(1000)
    await clock.advance(1000)
    expect(await rowOf()).toContain('3s')

    await $.turn.complete(complete('agent-4', { durationMs: 3200 }))
    await clock.advance(5000)
    expect(await rowOf()).toContain('3s') // finished: fixed at the turn's own duration
  })

  test('summary line: cost, all-Opus cost and savings', async ($, on) => {
    engine(on, 'agent-5')
    await $.agent.spawn(spawnInput({ description: 'index the repo', subagentType: 'Explore' }))
    await $.turn.complete(
      complete('agent-5', {
        durationMs: 65_000,
        usage: usage(HAIKU, 1_000_000, 500_000, 2_000_000, 400_000),
      }),
    )

    const lines = linesOf(await draw($))
    expect(lines.find(l => l.includes('index the repo'))).toContain('1m05s')
    // haiku 0.42 vs opus 16.8 by hand: 1 - 0.42 / 16.8 = 97.5% saved
    expect(lines).toContain('Haiku×1 · ≈$0.42 vs Opus $16.80（省98%）')
    expect(lines.some(l => l.includes('API 價格'))).toBe(false)
  })

  test('a finished subagent stops the tick', async ($, on) => {
    const clock = engine(on, 'agent-6')
    const count = ticks(on)
    await start($)
    await $.agent.spawn(spawnInput({ description: 'quick job', subagentType: 'worker' }))
    await clock.advance(3000)
    const running = count.n
    await clock.advance(2000)
    expect(count.n).toBeGreaterThan(running)

    await $.turn.complete(complete('agent-6'))
    const done = count.n
    await clock.advance(10_000)
    expect(count.n).toBe(done)
  })

  test('a silent subagent goes stale after 10 minutes, stops the tick, and wakes on an event', async ($, on) => {
    const clock = engine(on, 'agent-7')
    const count = ticks(on)
    await start($)
    await $.agent.spawn(spawnInput({ description: 'lost job', subagentType: 'worker' }))
    await clock.advance(STALE_MS)
    let lines = linesOf(await draw($))
    expect(lines.some(l => l.includes('執行中 (1)'))).toBe(true)

    await clock.advance(2000)
    lines = linesOf(await draw($))
    expect(lines.some(l => l.includes('失聯 (1)'))).toBe(true)
    expect(lines.some(l => l.includes('執行中 ('))).toBe(false)
    const row = lines.find(l => l.includes('lost job')) ?? ''
    expect(row).toContain('失聯')
    expect(findText(await draw($), /失聯 \(1\)/)?.props?.color).toBe('gray')

    const stale = count.n
    await clock.advance(10_000)
    expect(count.n).toBe(stale)

    // heard from again: running, and the tick resumes
    // the engine stamps agentId on a subagent's call; the typed input has no field for it
    const fromSubagent = { tool: 'Read' as const, file_path: '/x', agentId: 'agent-7' }
    await $.tool.call(fromSubagent)
    lines = linesOf(await draw($))
    expect(lines.some(l => l.includes('執行中 (1)'))).toBe(true)
    expect(lines.some(l => l.includes('失聯'))).toBe(false)
    const woke = count.n
    await clock.advance(3000)
    expect(count.n).toBeGreaterThan(woke)
  })
})

const HERDR = { HERDR_ENV: '1', HERDR_PANE_ID: 'pane-7' }

describe('herdr reporting', () => {
  const commands = (on: On, exitCode = 0) => {
    const calls: string[][] = []
    on('process.run', async (_$, e) => {
      calls.push([...e.argv])
      return {
        value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      }
    })
    return calls
  }

  test('outside Herdr no command is ever run', async ($, on) => {
    const clock = engine(on, 'agent-8')
    mock.env(on, {})
    const calls = commands(on)
    await start($)
    await $.agent.spawn(spawnInput({ description: 'job', subagentType: 'worker' }))
    await clock.advance(10_000)
    await $.turn.complete(complete('agent-8'))
    await clock.advance(10_000)
    expect(calls).toHaveLength(0)
  })

  test('HERDR_ENV without a pane id is not Herdr either', async ($, on) => {
    const clock = engine(on, 'agent-8')
    mock.env(on, { HERDR_ENV: '1' })
    const calls = commands(on)
    await start($)
    await $.agent.spawn(spawnInput({ description: 'job', subagentType: 'worker' }))
    await clock.advance(10_000)
    expect(calls).toHaveLength(0)
  })

  test('in Herdr: reports on change only, throttled, never per tick', async ($, on) => {
    const clock = engine(on, 'agent-9')
    mock.env(on, HERDR)
    const calls = commands(on)
    await start($)
    await clock.advance(5000)
    expect(calls).toHaveLength(0) // no subagents: nothing to clear

    await $.agent.spawn(spawnInput({ description: 'job', subagentType: 'worker' }))
    await clock.advance(5000) // five ticks, one report
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(0, 4)).toEqual(['herdr', 'pane', 'report-metadata', 'pane-7'])
    expect(calls[0]?.[7]).toMatch(/^crew=▶1/)

    await clock.advance(60_000) // nothing changed for a minute: still one
    expect(calls).toHaveLength(1)

    await $.turn.complete(complete('agent-9', { usage: usage(HAIKU, 1000, 1000, 0, 0) }))
    await clock.advance(5000)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.[7]).toMatch(/^crew=✓1 · 省\d+%$/)
  })

  test('a failing herdr is swallowed and the reporter stops after 3 failures', async ($, on) => {
    const clock = engine(on, 'agent-10')
    mock.env(on, HERDR)
    const calls = commands(on, 1)
    await start($)
    await $.agent.spawn(spawnInput({ description: 'job', subagentType: 'worker' }))
    await clock.advance(5000)
    await $.turn.complete(complete('agent-10'))
    await clock.advance(5000)
    await $.agent.spawn(spawnInput({ description: 'job2', subagentType: 'worker', id: 'tu-2' }))
    await clock.advance(5000)
    expect(calls).toHaveLength(MAX_FAILURES)

    await $.turn.complete(complete('agent-10'))
    await clock.advance(20_000)
    expect(calls).toHaveLength(MAX_FAILURES) // stopped for this session
  })
})

const ev = (over: Partial<CrewEvent> = {}): CrewEvent => ({
  ts: 0,
  actor: 'main',
  source: '主線',
  isMain: true,
  tool: 'Read',
  desc: '',
  ms: 0,
  ok: true,
  ...over,
})

const MIN = 60_000

describe('event stream logic', () => {
  test('descriptions: Bash description or command head, file base names, patterns', () => {
    expect(describeCall('Bash', { command: 'ls -la', description: 'List files' })).toBe('List files')
    expect(describeCall('Bash', { command: 'go test ./...\nnext line' })).toBe('go test ./...')
    expect(describeCall('Bash', { command: '\n  make build  ', description: '  ' })).toBe('make build')
    expect(describeCall('Read', { file_path: '/a/b/crew.ts' })).toBe('crew.ts')
    expect(describeCall('Edit', { file_path: '/a/b/register.tsx' })).toBe('register.tsx')
    expect(describeCall('Write', { file_path: 'plain.md' })).toBe('plain.md')
    expect(describeCall('Grep', { pattern: 'foo.*bar', path: '/x' })).toBe('foo.*bar')
    expect(describeCall('WebFetch', { url: 'https://x' })).toBe('')
    expect(describeCall('Read', {})).toBe('')
    // long text is cut with an ellipsis
    const long = describeCall('Bash', { command: 'x'.repeat(200) })
    expect(long).toHaveLength(60)
    expect(long.endsWith('…')).toBe(true)
  })

  test('only the latest 200 events are kept', () => {
    let list: CrewEvent[] = []
    for (let i = 0; i < 205; i += 1) list = addEvent(list, ev({ ts: i }))
    expect(list).toHaveLength(MAX_EVENTS)
    expect(list[0]?.ts).toBe(5)
    expect(list[199]?.ts).toBe(204)
  })

  test('pace: ten one-minute buckets, oldest first, edges', () => {
    const now = 100 * MIN
    expect(paceBuckets([], now)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const list = [
      ev({ ts: now }), // age 0: newest bucket
      ev({ ts: now - 1 }), // still the newest bucket
      ev({ ts: now - MIN }), // exactly one minute: the one before
      ev({ ts: now - 9 * MIN }), // oldest bucket
      ev({ ts: now - 10 * MIN + 1 }), // oldest bucket, last millisecond
      ev({ ts: now - 10 * MIN }), // exactly 10 minutes ago: out
      ev({ ts: now - 11 * MIN }), // out
      ev({ ts: now + 1 }), // future: out
    ]
    expect(paceBuckets(list, now)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 1, 2])
  })

  test('health: ok, loop (3 same tool failures), stuck (running, 5 minutes quiet)', () => {
    const fail = (tool: string, ts = 0) => ev({ tool, ok: false, ts })
    expect(healthOf([], 0, undefined)).toBe('ok')

    // loop: last 3 are the same tool and all failed
    expect(healthOf([fail('Bash'), fail('Bash'), fail('Bash')], 0, undefined)).toBe('loop')
    expect(healthOf([ev(), fail('Bash'), fail('Bash'), fail('Bash')], 0, undefined)).toBe('loop')
    expect(healthOf([fail('Bash'), fail('Bash')], 0, undefined)).toBe('ok')
    expect(healthOf([fail('Bash'), fail('Read'), fail('Bash')], 0, undefined)).toBe('ok')
    expect(healthOf([fail('Bash'), fail('Bash'), ev({ tool: 'Bash' })], 0, undefined)).toBe('ok')
    expect(healthOf([fail('Bash'), fail('Bash'), fail('Bash'), ev({ tool: 'Bash' })], 0, undefined)).toBe('ok')

    // stuck: something runs and the last activity is older than 5 minutes
    const last = ev({ ts: 1000, ms: 500 })
    expect(healthOf([last], 1500 + STUCK_MS, 0)).toBe('ok') // exactly 5 minutes: not yet
    expect(healthOf([last], 1500 + STUCK_MS + 1, 0)).toBe('stuck')
    // nothing running: quiet is fine
    expect(healthOf([last], 1500 + STUCK_MS * 4, undefined)).toBe('ok')
    // no calls at all: counted from when the run began
    expect(healthOf([], 1000 + STUCK_MS, 1000)).toBe('ok')
    expect(healthOf([], 1001 + STUCK_MS, 1000)).toBe('stuck')
    // a run that began after the last call restarts the quiet clock
    expect(healthOf([last], 1500 + STUCK_MS + 1, 100_000)).toBe('ok')

    // loop outranks stuck
    const loop = [fail('Bash', 0), fail('Bash', 0), fail('Bash', 0)]
    expect(healthOf(loop, STUCK_MS * 3, 0)).toBe('loop')
  })

  test('roles come from the subagent type; unknown types are other', () => {
    expect(['Explore', 'clerk', 'worker', 'verifier', 'fork'].map(roleOf)).toEqual([
      'Explore', 'clerk', 'worker', 'verifier', 'fork',
    ])
    expect(roleOf('explore')).toBe('Explore')
    expect(roleOf('general-purpose')).toBe('other')
    expect(roleOf('Plan')).toBe('other')
    expect(roleOf('')).toBe('other')
  })

  test('dispatch counts running and finished per role', () => {
    const list = [
      agent({ id: '1', type: 'Explore', status: 'running' }),
      agent({ id: '2', type: 'Explore', status: 'done' }),
      agent({ id: '3', type: 'worker', status: 'failed' }),
      agent({ id: '4', type: 'fork', status: 'running' }),
      agent({ id: '5', type: 'Plan', status: 'done' }),
      agent({ id: '6', type: 'clerk', status: 'stale' }),
    ]
    const by = Object.fromEntries(dispatchStats(list).map(r => [r.role, r]))
    expect(by['Explore']).toMatchObject({ running: 1, done: 1, failed: 0 })
    expect(by['worker']).toMatchObject({ running: 0, done: 0, failed: 1 })
    expect(by['fork']).toMatchObject({ running: 1, done: 0 })
    expect(by['other']).toMatchObject({ running: 0, done: 1 })
    expect(by['clerk']).toMatchObject({ running: 0, done: 0, failed: 0 }) // stale is neither
    expect(by['verifier']).toMatchObject({ running: 0, done: 0, failed: 0 })
  })

  test('model shares split the priced cost', () => {
    const rows = modelShares([
      agent({ id: 'h', model: HAIKU, input: 1_000_000 }), // 0.1
      agent({ id: 's', model: SONNET, input: 1_000_000 }), // 2
      agent({ id: 's2', model: SONNET, input: 1_000_000 }), // 2
      agent({ id: 'u', model: 'mystery-model', input: 5_000_000 }),
    ])
    expect(rows.map(r => r.label)).toEqual(['Sonnet', 'Haiku', '其他'])
    near(rows[0]?.cost, 4, 9)
    near(rows[0]?.share, 4 / 4.1, 9)
    near(rows[1]?.share, 0.1 / 4.1, 9)
    expect(rows[2]).toMatchObject({ count: 1, cost: 0, share: 0 })
    expect(modelShares([agent({ model: 'mystery-model' })])[0]?.share).toBe(0)
  })

  test('buildCockpit gathers the view model', () => {
    const main: CrewMain = {
      model: 'claude-opus-5-5',
      chain: 3,
      ok: 7,
      fail: 2,
      lastTool: 'Bash',
      lastDesc: 'go test',
      isRunning: true,
      runSince: 0,
    }
    const now = 10 * MIN
    const view = buildCockpit(
      {
        agents: [agent({ id: 'a', status: 'running', type: 'worker', runStartedAt: 0 })],
        main,
        events: [ev({ ts: now - 30_000, ms: 10, tool: 'Bash', desc: 'go test' })],
      },
      now,
    )
    expect(view.main).toMatchObject({ chain: 3, ok: 7, fail: 2, lastDesc: 'go test', isRunning: true })
    expect(view.pace[9]).toBe(1)
    expect(view.pace).toHaveLength(10)
    expect(view.events).toHaveLength(1)
    expect(view.running).toHaveLength(1)
    expect(view.dispatch.find(r => r.role === 'worker')?.running).toBe(1)
    expect(view.health).toBe('ok')
    expect(buildCockpit({ agents: [], main, events: [] }, now).health).toBe('stuck') // main runs, 10 minutes since it began
    expect(buildCockpit({ agents: [], main: { ...main, isRunning: false }, events: [] }, now).health).toBe('ok')
  })
})

describe('health: in-flight calls and per-executor loops', () => {
  const fail = (actor: string, tool = 'Bash', ts = 0) =>
    ev({ actor, isMain: actor === 'main', source: actor === 'main' ? '主線' : 'worker', tool, ok: false, ts })
  const flight = (over: Partial<CrewInflight> = {}): CrewInflight => ({
    key: 'c1',
    actor: 'main',
    source: '主線',
    tool: 'Bash',
    startedAt: 0,
    ...over,
  })
  const mainRunning: CrewMain = {
    model: '',
    chain: 0,
    ok: 0,
    fail: 0,
    lastTool: '',
    lastDesc: '',
    isRunning: true,
    runSince: 0,
  }

  test('a call still in flight is never stuck, however quiet', () => {
    expect(healthOf([], 10 * MIN, 0, { inFlight: 1 })).toBe('ok')
    expect(healthOf([ev({ ts: 0, ms: 10 })], 10 * MIN, 0, { inFlight: 2 })).toBe('ok')
    const state = { agents: [], main: mainRunning, events: [], inflight: [flight()] }
    expect(healthOfState(state, 10 * MIN)).toBe('ok')
  })

  test('nothing in flight, running, quiet over 5 minutes: still stuck', () => {
    expect(healthOf([], 10 * MIN, 0, { inFlight: 0 })).toBe('stuck')
    expect(healthOf([], 10 * MIN, 0)).toBe('stuck')
    const state = { agents: [], main: mainRunning, events: [], inflight: [] }
    expect(healthOfState(state, 10 * MIN)).toBe('stuck')
    expect(healthOfState({ ...state, inflight: [flight()] }, 10 * MIN)).toBe('ok')
  })

  test('a call in flight in a subagent also keeps the run from being stuck', () => {
    const state = {
      agents: [agent({ id: 'w1', status: 'running', runStartedAt: 0 })],
      main: { ...mainRunning, isRunning: false },
      events: [],
      inflight: [flight({ actor: 'w1', source: 'worker' })],
    }
    expect(healthOfState(state, 10 * MIN)).toBe('ok')
    expect(healthOfState({ ...state, inflight: [] }, 10 * MIN)).toBe('stuck')
  })

  test('two agents failing the same tool, three failures in all, is not a loop', () => {
    const live = new Set(['a1', 'a2'])
    expect(healthOf([fail('a1'), fail('a2'), fail('a1')], 0, undefined, { liveAgents: live })).toBe('ok')
    expect(
      healthOf([fail('a1'), fail('a2'), fail('main')], 0, undefined, { liveAgents: live }),
    ).toBe('ok')
  })

  test("one agent's three failures with other agents' successes between is a loop", () => {
    const live = new Set(['a1', 'a2'])
    const list = [
      fail('a1'),
      ev({ actor: 'a2', isMain: false, source: 'worker' }),
      fail('a1'),
      ev({ actor: 'main' }),
      fail('a1'),
      ev({ actor: 'a2', isMain: false, source: 'worker' }),
    ]
    expect(healthOf(list, 0, undefined, { liveAgents: live })).toBe('loop')
    // the same agent no longer running: no loop is left behind
    expect(healthOf(list, 0, undefined, { liveAgents: new Set(['a2']) })).toBe('ok')
  })

  test('main loop interleaved with a subagent success still loops', () => {
    const list = [fail('main'), ev({ actor: 'a1', isMain: false }), fail('main'), fail('main')]
    expect(healthOf(list, 0, undefined, { liveAgents: new Set(['a1']) })).toBe('loop')
    expect(healthOf(list, 0, undefined)).toBe('loop')
  })

  test('two workers of the same type with different agentIds are not merged', () => {
    const live = new Set(['w1', 'w2'])
    const split = [fail('w1'), fail('w2'), fail('w1'), fail('w2')]
    expect(healthOf(split, 0, undefined, { liveAgents: live })).toBe('ok')
    expect(healthOf([...split, fail('w1')], 0, undefined, { liveAgents: live })).toBe('loop')
  })

  test('a finished subagent leaves no loop; a running one does', () => {
    const events = [fail('w1'), fail('w1'), fail('w1')]
    const base = { main: { ...mainRunning, isRunning: false }, events }
    const done = { ...base, agents: [agent({ id: 'w1', status: 'done' })] }
    const failed = { ...base, agents: [agent({ id: 'w1', status: 'failed' })] }
    const running = { ...base, agents: [agent({ id: 'w1', status: 'running' })] }
    expect(healthOfState(done, 0)).toBe('ok')
    expect(healthOfState(failed, 0)).toBe('ok')
    expect(healthOfState(running, 0)).toBe('loop')
    // a subagent the list no longer knows is not live either
    expect(healthOfState({ ...base, agents: [] }, 0)).toBe('ok')
  })

  test('a main loop stays until the next event arrives', () => {
    const list = [fail('main'), fail('main'), fail('main')]
    const state = { agents: [], main: { ...mainRunning, isRunning: false }, events: list }
    expect(healthOfState(state, 0)).toBe('loop')
    expect(healthOfState({ ...state, events: [...list, ev()] }, 0)).toBe('ok')
  })
})

describe('herdr warning prefix', () => {
  test('loop and stuck lead the text, ok leaves it alone', () => {
    const list = [agent({ id: 'r', status: 'running' })]
    expect(crewText(list, 'ok')).toBe('▶1')
    expect(crewText(list, 'loop')).toBe('⚠繞圈 ▶1')
    expect(crewText(list, 'stuck')).toBe('⚠卡住 ▶1')
    expect(crewText(list)).toBe(crewText(list, 'ok'))
    // with no subagents the warning still shows; ok shows nothing
    expect(crewText([], 'loop')).toBe('⚠繞圈')
    expect(crewText([], 'stuck')).toBe('⚠卡住')
    expect(crewText([], 'ok')).toBeUndefined()
  })
})

// the latest value the mod wrote for its events and main records, seen beneath the mod
const watch = (on: On) => {
  const seen: { events: CrewEvent[]; main: CrewMain | undefined } = { events: [], main: undefined }
  on('state.set', { plugin: 'crew', key: 'events' }, async (_$, e, next) => {
    seen.events = [...e.value]
    return next(e)
  })
  on('state.set', { plugin: 'crew', key: 'main' }, async (_$, e, next) => {
    seen.main = e.value
    return next(e)
  })
  return seen
}

// every value the mod wrote for its in-flight list, seen beneath the mod
const watchFlight = (on: On) => {
  const seen: { history: CrewInflight[][] } = { history: [] }
  on('state.set', { plugin: 'crew', key: 'inflight' }, async (_$, e, next) => {
    seen.history.push([...e.value])
    return next(e)
  })
  return seen
}

describe('event stream hooks', () => {
  test('a main call is recorded with its duration, description and outcome', async ($, on) => {
    const w = watch(on)
    const clock = mock.clock(on, { now: 1000 })
    let answer: unknown = { result: {} }
    on('tool.call', async () => {
      await clock.advance(250)
      return answer as never
    })

    const out = await $.tool.call({ tool: 'Bash', command: 'ls -la', description: 'List files' })
    expect(out).toMatchObject({ result: {} })
    answer = { isError: true, result: 'boom', text: 'boom' }
    const bad = await $.tool.call({ tool: 'Read', file_path: '/a/b/crew.ts' })
    expect(bad).toMatchObject({ isError: true, text: 'boom' })

    const list = w.events
    expect(list).toEqual([
      { ts: 1000, actor: 'main', source: '主線', isMain: true, tool: 'Bash', desc: 'List files', ms: 250, ok: true },
      { ts: 1250, actor: 'main', source: '主線', isMain: true, tool: 'Read', desc: 'crew.ts', ms: 250, ok: false },
    ])
    expect(w.main).toMatchObject({
      ok: 1,
      fail: 1,
      chain: 2,
      lastTool: 'Read',
      lastDesc: 'crew.ts',
    })
  })

  test('a next that throws is recorded as a failure and the error still escapes', async ($, on) => {
    const w = watch(on)
    mock.clock(on, { now: 0 })
    on('tool.call', async () => {
      throw new Error('tool crashed')
    })

    let caught: unknown
    try {
      await $.tool.call({ tool: 'Bash', command: 'needle' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(String((caught as Error).message ?? caught)).toContain('no implementation')

    const list = w.events
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ tool: 'Bash', desc: 'needle', ok: false, isMain: true })
    expect(w.main).toMatchObject({ ok: 0, fail: 1 })
  })

  test('a subagent call is recorded under the subagent type, not the main counters', async ($, on) => {
    const w = watch(on)
    engine(on, 'agent-11')
    await $.agent.spawn(spawnInput({ description: 'look around', subagentType: 'Explore' }))
    await $.tool.call({ tool: 'Read', file_path: '/x/y.go', agentId: 'agent-11' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/x/z.go', agentId: 'ghost' } as never)

    const list = w.events
    expect(list.map(x => [x.source, x.isMain, x.desc])).toEqual([
      ['Explore', false, 'y.go'],
      ['subagent', false, 'z.go'],
    ])
    expect(w.main).toBeUndefined() // the main counters were never touched
  })

  test('205 calls leave the latest 200', async ($, on) => {
    const w = watch(on)
    engine(on)
    for (let i = 0; i < 205; i += 1) await $.tool.call({ tool: 'Read', file_path: `/f/${i}.ts` })
    const list = w.events
    expect(list).toHaveLength(200)
    expect(list[0]?.desc).toBe('5.ts')
    expect(list[199]?.desc).toBe('204.ts')
    expect(w.main?.ok).toBe(205)
  })

  test('the actor is main for the main loop and the agentId for a subagent', async ($, on) => {
    const w = watch(on)
    let n = 0
    on('agent.spawn', async () => ({ model: HAIKU, agentId: `w-${(n += 1)}` }))
    mock.clock(on, { now: 0 })
    on('tool.call', async () => ({ result: {} as never }))
    await $.agent.spawn(spawnInput({ description: 'one', subagentType: 'worker', id: 'tu-1' }))
    await $.agent.spawn(spawnInput({ description: 'two', subagentType: 'worker', id: 'tu-2' }))
    await $.tool.call({ tool: 'Read', file_path: '/a' })
    await $.tool.call({ tool: 'Read', file_path: '/b', agentId: 'w-1' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/c', agentId: 'w-2' } as never)
    expect(w.events.map(x => [x.actor, x.source, x.isMain])).toEqual([
      ['main', '主線', true],
      ['w-1', 'worker', false],
      ['w-2', 'worker', false],
    ])
  })

  test('a call is in flight while next runs, and gone after a normal return', async ($, on) => {
    const flight = watchFlight(on)
    const clock = mock.clock(on, { now: 100 })
    on('tool.call', async () => {
      await clock.advance(50)
      return { result: {} } as never
    })
    await $.tool.call({ tool: 'Bash', command: 'make test' })
    expect(flight.history).toHaveLength(2)
    expect(flight.history[0]).toEqual([
      expect.objectContaining({ actor: 'main', source: '主線', tool: 'Bash', startedAt: 100 }),
    ])
    expect(flight.history[1]).toEqual([])
  })

  test('an isError result also removes the in-flight call', async ($, on) => {
    const flight = watchFlight(on)
    mock.clock(on, { now: 0 })
    on('tool.call', async () => ({ isError: true, result: 'boom', text: 'boom' }) as never)
    const out = await $.tool.call({ tool: 'Bash', command: 'false' })
    expect(out).toMatchObject({ isError: true, text: 'boom' })
    expect(flight.history).toHaveLength(2)
    expect(flight.history[0]).toHaveLength(1)
    expect(flight.history[1]).toEqual([])
  })

  test('a next that throws removes the in-flight call and the error still escapes', async ($, on) => {
    const flight = watchFlight(on)
    mock.clock(on, { now: 0 })
    on('tool.call', async () => {
      throw new Error('tool crashed')
    })
    let caught: unknown
    try {
      await $.tool.call({ tool: 'Bash', command: 'boom' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(flight.history).toHaveLength(2)
    expect(flight.history[0]).toHaveLength(1)
    expect(flight.history[1]).toEqual([])
  })

  test('concurrent calls are tracked one by one, each removed on its own', async ($, on) => {
    const flight = watchFlight(on)
    const clock = mock.clock(on, { now: 0 })
    on('tool.call', async (_$, e) => {
      await clock.advance(e.tool === 'Bash' ? 100 : 10)
      return { result: {} } as never
    })
    await Promise.all([
      $.tool.call({ tool: 'Bash', command: 'slow' }),
      $.tool.call({ tool: 'Read', file_path: '/fast' }),
    ])
    const last = flight.history[flight.history.length - 1]
    expect(last).toEqual([])
    expect(Math.max(...flight.history.map(h => h.length))).toBe(2)
    const both = flight.history.find(h => h.length === 2) ?? []
    expect(both.map(x => x.tool).sort()).toEqual(['Bash', 'Read'])
    const keys = flight.history.flat().map(x => x.key)
    expect(new Set(keys).size).toBe(2)
  })

  test('a long Agent call is not in flight, so a quiet subagent under it is stuck', async ($, on) => {
    const w = watch(on)
    const flight = watchFlight(on)
    const clock = mock.clock(on, { now: 0 })
    mock.env(on, HERDR)
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
    on('agent.spawn', async () => ({ model: HAIKU, agentId: 'agent-30' }))
    const sent: string[] = []
    on('process.run', async (_$, e) => {
      sent.push(e.argv.slice(6).join(' '))
      return {
        value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      }
    })
    let seenWhileRunning: string[] = []
    on('tool.call', async () => {
      // the foreground Agent call waits on its subagent, which says nothing for over 5 minutes
      await clock.advance(STUCK_MS + 5000)
      seenWhileRunning = [...sent]
      return { result: {} } as never
    })
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.agent.spawn(spawnInput({ description: 'build it', subagentType: 'worker' }))
    await $.tool.call({ tool: 'Agent', description: 'build it', prompt: 'p', subagent_type: 'worker' })
    expect(seenWhileRunning).toEqual([
      '--token crew=▶1 --ttl-ms 900000',
      '--token crew=⚠卡住 ▶1 --ttl-ms 900000',
    ])
    expect(flight.history.flat().some(x => x.tool === 'Agent')).toBe(false)
    expect(w.events).toEqual([expect.objectContaining({ tool: 'Agent', desc: 'build it', isMain: true, ok: true })])
  })

  test('calls from two loads of the hooks module never share a key; each removes only itself', async () => {
    // a hot reload keeps the state and starts the module afresh, its call count at zero:
    // two loads over one state, each module's tool.call hook taken as it registers
    type Hook = (...args: unknown[]) => Promise<unknown>
    const store = new Map<string, { value: unknown; version: number }>()
    const fake = {
      clock: { now: async () => 0 },
      state: {
        get: async (ref: { key: string }) => store.get(ref.key) ?? { value: undefined, version: 0 },
        set: async (ref: { key: string }, value: unknown, opts?: { ifVersion?: number }) => {
          const held = store.get(ref.key)?.version ?? 0
          if (opts?.ifVersion !== undefined && opts.ifVersion !== held) return { isSet: false, version: held }
          store.set(ref.key, { value, version: held + 1 })
          return { isSet: true, version: held + 1 }
        },
      },
    }
    const load = () => {
      let hook: Hook | undefined
      const take = (name: string, ...rest: unknown[]) => {
        if (name === 'tool.call') hook = rest[rest.length - 1] as Hook
      }
      register(take as unknown as On, {})
      return hook as Hook
    }
    const before = load()
    const after = load()
    const history: CrewInflight[][] = []
    const flight = () => (store.get('inflight')?.value ?? []) as CrewInflight[]
    const e = { tool: 'Bash', command: 'x' }
    const out = await before(fake, e, async () => {
      history.push(flight())
      const inner = await after(fake, e, async () => {
        history.push(flight())
        return { result: {} }
      })
      history.push(flight())
      return inner
    })
    history.push(flight())
    expect(out).toEqual({ result: {} })
    expect(history.map(h => h.length)).toEqual([1, 2, 1, 0])
    const [old, fresh] = history[1] ?? []
    expect(old?.key).not.toBe(fresh?.key)
    expect(history[2]).toEqual([old])
  })

  // calls whose next has not returned yet, released by hand
  const hold = (on: On) => {
    const gates: Array<() => void> = []
    let wake: (() => void) | undefined
    on('tool.call', async () => {
      await new Promise<void>(r => {
        gates.push(r)
        wake?.()
      })
      return { result: {} } as never
    })
    const until = async (n: number) => {
      while (gates.length < n) await new Promise<void>(r => (wake = r))
    }
    return { until, release: () => gates.splice(0).forEach(r => r()) }
  }

  test('turn.complete clears orphaned in-flight calls: main its own, a subagent only its own', async ($, on) => {
    const flight = watchFlight(on)
    mock.clock(on, { now: 0 })
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    const h = hold(on)
    const calls = [undefined, 'w1', 'w2'].map(agentId =>
      $.tool.call({ tool: 'Bash', command: 'wait', ...(agentId ? { agentId } : {}) } as never),
    )
    await h.until(3)
    const actors = () => (flight.history[flight.history.length - 1] ?? []).map(x => x.actor).sort()
    expect(actors()).toEqual(['main', 'w1', 'w2'])

    await $.turn.complete(complete('w1'))
    expect(actors()).toEqual(['main', 'w2'])
    await $.turn.complete(complete(undefined))
    expect(actors()).toEqual(['w2'])
    await $.turn.complete(complete('w2'))
    expect(actors()).toEqual([])

    h.release()
    await Promise.all(calls)
    expect(actors()).toEqual([])
  })

  test('session.start clears every in-flight call', async ($, on) => {
    const flight = watchFlight(on)
    mock.clock(on, { now: 0 })
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    const h = hold(on)
    const calls = [undefined, 'w1'].map(agentId =>
      $.tool.call({ tool: 'Bash', command: 'wait', ...(agentId ? { agentId } : {}) } as never),
    )
    await h.until(2)
    expect(flight.history[flight.history.length - 1]).toHaveLength(2)

    await start($)
    expect(flight.history[flight.history.length - 1]).toEqual([])

    h.release()
    await Promise.all(calls)
  })

  test('a 10 minute call on the main loop raises no stuck warning; quiet afterwards does', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    mock.env(on, HERDR)
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
    on('tool.call', async () => {
      await clock.advance(10 * MIN)
      return { result: {} } as never
    })
    const sent: string[] = []
    on('process.run', async (_$, e) => {
      sent.push(e.argv.slice(6).join(' '))
      return {
        value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      }
    })
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'make test' })
    expect(sent).toEqual([])
    // the call returned; five more quiet minutes and the run is stuck as before
    await clock.advance(STUCK_MS + 5000)
    expect(sent).toEqual(['--token crew=⚠卡住 --ttl-ms 900000'])
  })

  test('turn.start / main turn.complete flag the main loop as running', async ($, on) => {
    const w = watch(on)
    const clock = engine(on)
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
    await clock.advance(500)
    await $.turn.start({ text: 'go', turnId: 't1' })
    expect(w.main).toMatchObject({ isRunning: true, runSince: 500 })
    await $.turn.complete(complete(undefined))
    expect(w.main?.isRunning).toBe(false)
  })

  test('Herdr text carries the stuck warning, then drops it when work resumes', async ($, on) => {
    const clock = engine(on)
    mock.env(on, HERDR)
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
    const sent: string[] = []
    on('process.run', async (_$, e) => {
      sent.push(e.argv.slice(6).join(' '))
      return {
        value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      }
    })
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(STUCK_MS - 1000)
    expect(sent).toEqual([])
    await clock.advance(5000)
    expect(sent).toEqual(['--token crew=⚠卡住 --ttl-ms 900000'])

    await $.tool.call({ tool: 'Read', file_path: '/x' })
    await clock.advance(5000)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toBe('--clear-token crew') // activity resumed: the warning is cleared
  })
})

const findAllText = (n: Node | string, re: RegExp, out: Node[] = []): Node[] => {
  if (typeof n === 'string') return out
  if (n.type === 'Text' && re.test(textOf(n))) out.push(n)
  for (const k of n.children ?? []) findAllText(k, re, out)
  return out
}

// width in cells of each drawn row: a row Box's texts side by side, as the pane draws them
const rowWidths = (n: Node | string): number[] => {
  if (typeof n === 'string') return [cellWidth(n)]
  if (n.type === 'Text') return [cellWidth(textOf(n))]
  const kids = n.children ?? []
  if (n.props?.flexDirection === 'row' && kids.every(k => typeof k !== 'string' && k.type === 'Text')) {
    return [kids.reduce((sum, k) => sum + cellWidth(textOf(k)), 0)]
  }
  return kids.flatMap(rowWidths)
}

const TITLES = /^(主線|派工流程|模型|節奏|省錢|健康|子代理|事件流)$/

// the card titles each top-level block of the pane holds, in order: what shares a row
const blockTitles = (tree: Node): string[][] =>
  (tree.children ?? []).map(k => (typeof k === 'string' ? [] : findAllText(k, TITLES).map(textOf)))

describe('cockpit layout helpers', () => {
  test('cell width counts CJK as two, fitCells and padCells honour it', () => {
    expect(cellWidth('abc')).toBe(3)
    expect(cellWidth('主線')).toBe(4)
    expect(cellWidth('▼█✓')).toBe(3)
    expect(fitCells('主線連續呼叫', 7)).toBe('主線連…')
    expect(cellWidth(fitCells('主線連續呼叫', 7))).toBeLessThanOrEqual(7)
    expect(fitCells('short', 10)).toBe('short')
    expect(padCells('主線', 8)).toBe('主線    ')
    expect(padCells('ab', 6, 'right')).toBe('    ab')
    expect(padCells('ab', 6, 'center')).toBe('  ab  ')
    expect(cellWidth(padCells('描述很長很長很長', 9))).toBe(9)
  })

  test('bar length scales, never 0 for a nonzero value, never over the width', () => {
    expect(barLen(19, 19, 24)).toBe(24)
    expect(barLen(1, 19, 24)).toBe(1)
    expect(barLen(0, 19, 24)).toBe(0)
    expect(barLen(50, 19, 24)).toBe(24)
  })

  test('pace chart: rows tall, peak fills the column, a zero is a thin base', () => {
    const rows = paceChart([0, 2, 4], 4, 2, 1)
    expect(rows).toHaveLength(4)
    expect(rows.every(r => cellWidth(r) === 3 * 2 + 2)).toBe(true)
    expect(rows[0]).toBe('      ██')
    expect(rows[3]).toBe('▁▁ ██ ██')
    expect(paceChart([0, 0, 0], 3, 1, 0)).toEqual(['   ', '   ', '▁▁▁'])
  })

  test('durations and clock', () => {
    expect(fmtMs(150)).toBe('150ms')
    expect(fmtMs(2900)).toBe('2.9s')
    expect(fmtMs(20_900)).toBe('20.9s')
    expect(fmtMs(65_000)).toBe('1m05s')
    expect(fmtClock(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('03:04:05')
  })
})

describe('cockpit layout', () => {
  const callMain = async ($: Engine, n: number) => {
    for (let i = 0; i < n; i += 1) await $.tool.call({ tool: 'Read', file_path: `/a/f${i}.ts` })
  }

  test('wide: top row side by side, four middle cards on one row, n/200 shown', async ($, on) => {
    engine(on)
    await callMain($, 3)
    const tree = await draw($, 40, WIDE_COLS + 40)
    expect(blockTitles(tree).slice(0, 3)).toEqual([
      ['主線', '派工流程'],
      ['模型', '節奏', '省錢', '健康'],
      ['事件流'],
    ])
    expect(findText(tree, /^3\/200 則$/)).toBeDefined()
  })

  test('narrow: the top row stacks and the middle cards go two to a row', async ($, on) => {
    engine(on)
    const tree = await draw($, 60, WIDE_COLS - 30)
    expect(blockTitles(tree).slice(0, 5)).toEqual([
      ['主線'],
      ['派工流程'],
      ['模型', '節奏'],
      ['省錢', '健康'],
      ['事件流'],
    ])
  })

  test('a very narrow pane keeps only savings and health', async ($, on) => {
    engine(on)
    const tree = await draw($, 60, TINY_COLS - 4)
    expect(blockTitles(tree).slice(0, 4)).toEqual([['主線'], ['派工流程'], ['省錢', '健康'], ['事件流']])
  })

  test('health: ok, a failing loop, and a stuck run each read their own way', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    let answer: unknown = { result: {} }
    on('tool.call', async () => answer as never)
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))

    let tree = await draw($, 40, 140)
    expect(findText(tree, /✓ 正常/)?.props?.color).toBe('green')

    answer = { isError: true, result: 'boom', text: 'boom' }
    for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Bash', command: 'go test' })
    tree = await draw($, 40, 140)
    expect(findText(tree, /⚠ 可能在繞圈/)?.props?.color).toBe('red')
    expect(findText(tree, /✓ 正常/)).toBeUndefined()

    answer = { result: {} }
    await $.tool.call({ tool: 'Bash', command: 'go test' })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(STUCK_MS + 1000)
    tree = await draw($, 40, 140)
    expect(findText(tree, /⚠ 可能卡住/)?.props?.color).toBe('yellow')
  })

  test('events: a failure shows a red [✗], a call over 30 seconds a yellow duration', async ($, on) => {
    const clock = mock.clock(on, { now: 5_000_000 })
    let step: { ms: number; fail: boolean } = { ms: 100, fail: false }
    on('tool.call', async () => {
      await clock.advance(step.ms)
      return (step.fail ? { isError: true, result: 'x', text: 'x' } : { result: {} }) as never
    })

    await $.tool.call({ tool: 'Read', file_path: '/a/ok.ts' })
    step = { ms: 31_000, fail: false }
    await $.tool.call({ tool: 'Bash', command: 'make slow', description: 'slow build' })
    step = { ms: 29_000, fail: false }
    await $.tool.call({ tool: 'Bash', command: 'make mid', description: 'mid build' })
    step = { ms: 50, fail: true }
    await $.tool.call({ tool: 'Bash', command: 'rg needle', description: 'needle' })

    const tree = await draw($, 40, 140)
    const lines = linesOf(tree)
    const grep = lines.find(l => l.includes('[✗]')) ?? ''
    expect(grep).toContain('Bash')
    expect(grep).toContain('needle')
    expect(grep).not.toContain('[✓]')
    expect(findAllText(tree, /^\[✗\]$/)[0]?.props?.color).toBe('red')
    expect(findAllText(tree, /^\[✓\]$/)[0]?.props?.color).toBe('green')
    expect(lines.find(l => l.includes('ok.ts'))).toContain('[✓]')
    expect(findText(tree, /^\s*31\.0s$/)?.props?.color).toBe('yellow')
    expect(findText(tree, /^\s*29\.0s$/)?.props?.color).toBeUndefined()
    // HH:MM:SS, local time, source and tool
    expect(lines.find(l => l.includes('slow build'))).toMatch(/\d\d:\d\d:\d\d\s+主線\s+Bash/)
  })

  test('events: only what fits the pane is shown, newest at the bottom, the count stays whole', async ($, on) => {
    engine(on)
    await callMain($, 30)
    const few = linesOf(await draw($, 24, 140)).filter(l => /f\d+\.ts/.test(l) && l.includes('[✓]'))
    expect(few.length).toBeGreaterThanOrEqual(MIN_EVENT_ROWS)
    expect(few.length).toBeLessThan(30)
    expect(few[few.length - 1]).toContain('f29.ts')
    const tree = await draw($, 24, 140)
    expect(findText(tree, /^30\/200 則$/)).toBeDefined()
    const roomy = linesOf(await draw($, 80, 140)).filter(l => /f\d+\.ts/.test(l) && l.includes('[✓]'))
    expect(roomy).toHaveLength(30)
  })

  test('narrow events: a long description is cut, never wrapped past the width', async ($, on) => {
    engine(on)
    const long = 'x'.repeat(59)
    await $.tool.call({ tool: 'Bash', command: 'run', description: long })
    await $.tool.call({ tool: 'Read', file_path: '/a/b/中文檔名很長很長很長很長很長.md' })
    for (const cols of [70, 90]) {
      const tree = await draw($, 60, cols)
      const desc = findAllText(tree, /^x+…?\s*$/)[0]
      expect(desc).toBeDefined()
      expect(textOf(desc as Node)).toContain('…')
      expect(rowWidths(tree).every(w => w <= cols - 4 || w === cols)).toBe(true)
    }
  })

  test('the role boxes: running ones light up, other shows only when it has agents', async ($, on) => {
    engine(on, 'agent-20')
    let tree = await draw($, 40, 170)
    expect(findAllText(tree, /^其他$/)).toHaveLength(0)
    expect(findAllText(tree, /^執行中 0 · 完成 0$/)).toHaveLength(5)

    await $.agent.spawn(spawnInput({ description: 'job', subagentType: 'worker' }))
    tree = await draw($, 40, 170)
    expect(findText(tree, /^\s*執行中 1 · 完成 0\s*$/)?.props?.color).toBe('yellow')
    expect(findAllText(tree, /^\s*執行中 0 · 完成 0\s*$/)).toHaveLength(4)

    // too narrow for one line: running and done count on two
    tree = await draw($, 40, 100)
    expect(findText(tree, /^\s*執行中 1\s*$/)?.props?.color).toBe('yellow')

    await $.turn.complete(complete('agent-20'))
    await $.agent.spawn(spawnInput({ description: 'other job', subagentType: 'general-purpose', id: 'tu-2' }))
    tree = await draw($, 40, 170)
    expect(findAllText(tree, /其他/).length).toBeGreaterThan(0)
  })

  test('the one-line summary stays at the bottom, and the v1 subagent list is kept', async ($, on) => {
    engine(on, 'agent-21')
    await $.agent.spawn(spawnInput({ description: 'index the repo', subagentType: 'Explore' }))
    await $.turn.complete(
      complete('agent-21', { durationMs: 2000, usage: usage(HAIKU, 1_000_000, 500_000, 2_000_000, 400_000) }),
    )
    const lines = linesOf(await draw($, 40, 140))
    expect(lines[lines.length - 1]).toBe('Haiku×1 · ≈$0.42 vs Opus $16.80（省98%）')
    expect(lines.some(l => l.includes('已完成 (1)'))).toBe(true)
    expect(lines.some(l => l.includes('省98%') && !l.includes('Haiku×1'))).toBe(true)
  })
})
