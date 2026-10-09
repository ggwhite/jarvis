import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { CrewAgent } from '../types'
import {
  STALE_MS,
  addAgent,
  costAt,
  elapsedMs,
  finishTurn,
  finishedOf,
  fmtK,
  markStale,
  noteTool,
  shortModel,
  staleOf,
  summarize,
} from '../hooks/crew'
import {
  MAX_FAILURES,
  REFRESH_MS,
  THROTTLE_MS,
  createReporter,
  crewText,
  inHerdr,
  reportArgv,
} from '../hooks/herdr'

const near = (got: number | undefined, want: number, digits: number) =>
  expect(got !== undefined && Math.abs(got - want) < 10 ** -digits).toBe(true)

const HAIKU = 'claude-haiku-4-5-20251001'
const SONNET = 'claude-sonnet-4-5'

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
    expect(sum.groups.find(g => g.label === 'Haiku')?.tokens).toBe(3_900_000)
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
    expect(crewText([agent({ id: 'f', model: 'claude-fable-5', input: 1_000_000 })])).toBe(
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

const draw = async ($: Engine, rows = 30): Promise<Node> =>
  (await $.ui.render({
    surface: 'terminal',
    component: 'Pane',
    requestId: 'crew',
    viewport: { columns: 100, rows: rows + 10 },
    props: {
      title: 'Crew',
      isFocused: false,
      bodyColumns: 80,
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
    expect(lines.some(l => /Explore .*Haiku 4\.5.* find files/.test(l))).toBe(true)
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
    expect(row).toContain('1.5k') // 110 + 55 + 1100 + 220 = 1485 tokens
    expect(lines.some(l => l.includes('已完成 (1)'))).toBe(true)
    expect(lines.some(l => l.includes('Haiku ×1 · 1.5k'))).toBe(true)
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
      const node = findText(tree, /主線連續工具呼叫/)
      return { text: node ? textOf(node) : '', color: node?.props?.color }
    }

    for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Read', file_path: '/x' })
    expect(await chain()).toMatchObject({ text: '主線連續工具呼叫 3' })
    expect((await chain()).color).toBeUndefined()

    await $.tool.call({ tool: 'Read', file_path: '/x' })
    expect(await chain()).toMatchObject({ text: '主線連續工具呼叫 4', color: 'yellow' })

    await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'd', subagent_type: 'worker' })
    expect((await chain()).text).toBe('主線連續工具呼叫 0')

    await $.tool.call({ tool: 'Read', file_path: '/x' })
    await $.tool.call({ tool: 'Read', file_path: '/y' })
    expect((await chain()).text).toBe('主線連續工具呼叫 2')

    await $.prompt.submit(submit('next'))
    expect((await chain()).text).toBe('主線連續工具呼叫 0')
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
    const cost = lines.find(l => l.includes('派工花費約')) ?? ''
    expect(cost).toContain('派工花費約 $0.420')
    expect(cost).toContain('全用 Opus 約 $16.80')
    expect(cost).toMatch(/省下 9[78]%/)
    expect(lines).toContain('以 API 價格估算')
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
    expect(lines.some(l => l.includes('執行中'))).toBe(false)
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
