import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { JarvisAgent, JarvisEvent, JarvisInflight, JarvisMain } from '../types'
import {
  MAX_EVENTS,
  MAX_NUMBERED,
  RECONCILE_RECENT_MS,
  STALE_MS,
  STUCK_MS,
  addAgent,
  addEvent,
  agentSections,
  buildCockpit,
  barLen,
  cellWidth,
  describeCall,
  dispatchStats,
  healthOf,
  healthOfState,
  modelShares,
  needsReconcile,
  reconcileAgents,
  roleOf,
  shareLabel,
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
  noteTool,
  shortModel,
  staleOf,
  tokenTotal,
  summarize,
  summaryLine,
  familyOf,
  ANIM_MS,
  BREAK_MS,
  JARVIS_PALETTE,
  IDLE_MS,
  INIT_MS,
  SCAN,
  SEEN_MS,
  SPINNER,
  THEME,
  jarvisColor,
  eventRows,
  fmtDate,
  outcomesOf,
  phaseOf,
  rosterOf,
  scanFrame,
  tickMs,
  BOOT_MS,
  FAMILY_COLOR,
  REACTOR,
  RELOCK_MS,
  bootStage,
  fmtReadout,
  lockOf,
  reactorOf,
  roleModels,
  topTools,
} from '../hooks/jarvis'
import { HEALTH_TEXT, MIN_EVENT_ROWS, RECOVERED, ROLE_COLOR, TITLE } from '../hooks/cockpit'
import {
  MAX_FAILURES,
  REFRESH_MS,
  THROTTLE_MS,
  createReporter,
  jarvisText,
  inHerdr,
  reportArgv,
} from '../hooks/herdr'
import { register } from '../hooks/register'
import { BIG_ROWS, BURN_RAMP, GAUGE_RAMP } from '../hooks/fleetChart'
import { SUIT_BLOCK_ROWS, SUIT_ROWS } from '../hooks/suit'

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

const agent = (over: Partial<JarvisAgent>): JarvisAgent => ({
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
    const m = (id: string, n: number, extra: Partial<JarvisAgent> = {}) =>
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
    let list: JarvisAgent[] = []
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
    expect(elapsedMs(list[0] as JarvisAgent, 99_999_999)).toBe(0)

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
    expect(jarvisText([])).toBeUndefined()
    expect(jarvisText([run('a'), run('b'), done('c')])).toBe('▶2 ✓1 · 省50%')
    expect(jarvisText([done('c'), done('d')])).toBe('✓2 · 省50%')
    expect(jarvisText([run('a'), done('c'), agent({ id: 's', status: 'stale', model: SONNET })])).toBe(
      '▶1 ✓1 ⚠1 · 省50%',
    )
    // an unpriced model has no savings figure
    expect(jarvisText([agent({ id: 'x', model: 'mystery-model' })])).toBe('✓1')
    // dearer than all-Opus
    expect(jarvisText([agent({ id: 'f', model: 'claude-fable-5-1', input: 1_000_000 })])).toBe(
      '✓1 · 多花150%',
    )
  })

  test('the command argv', () => {
    expect(reportArgv('p-1', '✓0 · test')).toEqual([
      'herdr', 'pane', 'report-metadata', 'p-1', '--source', 'jarvis',
      '--token', 'jarvis=✓0 · test', '--ttl-ms', '900000',
    ])
    expect(reportArgv('p-1', undefined)).toEqual([
      'herdr', 'pane', 'report-metadata', 'p-1', '--source', 'jarvis', '--clear-token', 'jarvis',
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
    expect(sent[1]).toContain('jarvis=a')

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
    expect(sent[1]).toContain('jarvis=b')

    await r.step('c', 10_000 + THROTTLE_MS + 1) // changed again 1 ms later: held
    expect(sent).toHaveLength(2)
    await r.step('c', 10_000 + THROTTLE_MS * 2) // the last change always goes out
    expect(sent).toHaveLength(3)
    expect(sent[2]).toContain('jarvis=c')

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
    requestId: 'jarvis',
    viewport: { columns: cols + 20, rows: rows + 10 },
    props: {
      title: 'Jarvis',
      isFocused: false,
      bodyColumns: cols,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: rows },
      view: {},
    },
  })) as RenderElement as Node

const PANE_PROPS = (rows = 30, cols = 80) => ({
  title: 'Jarvis',
  isFocused: true,
  bodyColumns: cols,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: rows },
  view: {},
})

const mountPane = ($: Engine, rows = 30, cols = 80) =>
  $.ui.mount({
    plugin: 'jarvis',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'jarvis',
    props: PANE_PROPS(rows, cols),
    viewport: { columns: cols + 20, rows: rows + 10 },
  })

// presses the pane's Button keyed `key`, as a click does
const press = async ($: Engine, key: string, rows = 30, cols = 80) => {
  const ui = await mountPane($, rows, cols)
  await ui.press({ key })
  await ui.unmount()
}

// presses the pane's Button whose hotkey is `hotkey`, as the key does while the pane has focus
const hotkey = async ($: Engine, key: string, rows = 30, cols = 80) => {
  const ui = await mountPane($, rows, cols)
  const button = (await ui.findAll({ type: 'Button' })).find(b => b.props['hotkey'] === key)
  expect(button?.key).toBeDefined()
  await ui.press({ key: button?.key ?? '' })
  await ui.unmount()
}

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
  on('state.set', { plugin: 'jarvis', key: 'tick' }, async (_$, e, next) => {
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
    let lines = linesOf(await draw($, 30, 100))
    expect(lines.some(l => /Explore .*Haiku 5\.5.* find files/.test(l))).toBe(true)
    expect(lines.some(l => l.includes('▶1 執行中'))).toBe(true) // one section: the title counts it

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
    expect(row).toContain('0:05')
    expect(row).toContain('165') // input + output only: 110 + 55
    // the count carries no ✓: the color tells it apart
    expect(lines.some(l => /子代理.* 1 完成/.test(l) && !l.includes('✓1'))).toBe(true)
    await press($, 'tab-stats')
    const card = modelCard(await draw($))
    expect(card.rows).toContainEqual(expect.stringMatching(/Haiku +100% +×1/))
    expect(card.rows).toContainEqual(expect.stringMatching(/SAVED \d+%/))
    expect(card.rows).toContainEqual(expect.stringMatching(/≈\$\S+ vs Opus \$\S+/))
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
    expect(lines.some(l => /子代理.* 1 失敗/.test(l) && !l.includes('✗1'))).toBe(true)
  })

  test('main model comes from the main loop turn.complete', async ($, on) => {
    engine(on)
    await $.turn.complete(complete(undefined, { usage: usage('claude-opus-5-5', 1, 1, 0, 0) }))
    await press($, 'tab-stats')

    const lines = linesOf(await draw($))
    expect(lines.some(l => l.includes('MAIN LINE · Opus 5.5'))).toBe(true)
  })

  test('main chain counts main tool calls, turns red at 4, resets', async ($, on) => {
    engine(on)
    await press($, 'tab-stats')
    const chain = async () => {
      const tree = await draw($)
      const node = findText(tree, /^ ?\d+\/4$/)
      return { text: node ? textOf(node).trim() : '', color: node?.props?.color }
    }

    for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Read', file_path: '/x' })
    expect(await chain()).toMatchObject({ text: '3/4' })
    expect((await chain()).color).toBe(THEME.primary)

    await $.tool.call({ tool: 'Read', file_path: '/x' })
    expect(await chain()).toMatchObject({ text: '4/4', color: THEME.error })

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

    expect(await rowOf()).toContain('0:00')
    await clock.advance(1000)
    await clock.advance(1000)
    await clock.advance(1000)
    expect(await rowOf()).toContain('0:03')

    await $.turn.complete(complete('agent-4', { durationMs: 3200 }))
    await clock.advance(5000)
    expect(await rowOf()).toContain('0:03') // finished: fixed at the turn's own duration
  })

  test('the model card: cost, all-Opus cost and savings', async ($, on) => {
    engine(on, 'agent-5')
    await $.agent.spawn(spawnInput({ description: 'index the repo', subagentType: 'Explore' }))
    await $.turn.complete(
      complete('agent-5', {
        durationMs: 65_000,
        usage: usage(HAIKU, 1_000_000, 500_000, 2_000_000, 400_000),
      }),
    )

    expect(linesOf(await draw($)).find(l => l.includes('index the repo'))).toContain('1:05')
    await press($, 'tab-stats')
    const tree = await draw($)
    // haiku 0.42 vs opus 16.8 by hand: 1 - 0.42 / 16.8 = 97.5% saved
    const card = modelCard(tree)
    expect(card.rows).toContainEqual(expect.stringMatching(/SAVED 98%/))
    expect(card.rows).toContainEqual(expect.stringMatching(/≈\$0\.42 vs Opus \$16\.80/))
    for (const r of card.rows) expect(cellWidth(r)).toBeLessThanOrEqual(card.inner)
    expect(linesOf(tree).some(l => l.includes('API 價格'))).toBe(false)
  })

  test('the tick: every 150ms while a subagent runs in a drawn pane, 1s unseen, none idle', async ($, on) => {
    const clock = engine(on, 'agent-41')
    const count = ticks(on)
    await start($)
    await clock.advance(3000)
    expect(count.n).toBe(0) // idle: no tick is written
    await draw($)
    await $.agent.spawn(spawnInput({ description: 'animated job', subagentType: 'worker' }))
    // the spawn writes one; then one every ANIM_MS
    let base = count.n
    await clock.advance(ANIM_MS * 10)
    expect(count.n - base).toBe(10)
    // the scan sweep turns with it while initializing
    const sweep = new RegExp(`^(${SCAN.join('|')})$`)
    const scanAt = async () => {
      const node = findText(await draw($), sweep)
      return node ? textOf(node) : undefined
    }
    const s1 = await scanAt()
    await clock.advance(ANIM_MS)
    const s2 = await scanAt()
    expect(s1).toBeDefined()
    expect(s2).toBeDefined()
    expect(s2).not.toBe(s1)
    // the pane is not drawn again: past SEEN_MS the tick drops to once a second
    await clock.advance(SEEN_MS + IDLE_MS)
    base = count.n
    await clock.advance(IDLE_MS * 3)
    expect(count.n - base).toBe(3)
    // drawn again: animating at once
    await draw($)
    base = count.n
    await clock.advance(ANIM_MS * 4)
    expect(count.n - base).toBe(4)

    await $.turn.complete(complete('agent-41'))
    const done = count.n
    await clock.advance(10_000)
    expect(count.n).toBe(done)
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
    expect(lines.some(l => l.includes('▶1 執行中'))).toBe(true)

    await clock.advance(2000)
    lines = linesOf(await draw($))
    expect(lines.some(l => l.includes('?1 失聯'))).toBe(true)
    expect(lines.some(l => l.includes('執行中 ('))).toBe(false)
    expect(lines.some(l => l.includes('▶1 執行中'))).toBe(false)
    const row = lines.find(l => l.includes('lost job')) ?? ''
    expect(row).toContain('SIGNAL LOST')
    expect(findText(await draw($), /^\?1 失聯$/)?.props?.color).toBe(THEME.frame)

    const stale = count.n
    await clock.advance(10_000)
    expect(count.n).toBe(stale)

    // heard from again: running, and the tick resumes
    // the engine stamps agentId on a subagent's call; the typed input has no field for it
    const fromSubagent = { tool: 'Read' as const, file_path: '/x', agentId: 'agent-7' }
    await $.tool.call(fromSubagent)
    lines = linesOf(await draw($))
    expect(lines.some(l => l.includes('▶1 執行中'))).toBe(true)
    expect(lines.some(l => l.includes('失聯') || l.includes('SIGNAL LOST'))).toBe(false)
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
    expect(calls[0]?.[7]).toMatch(/^jarvis=▶1/)

    await clock.advance(60_000) // nothing changed for a minute: still one
    expect(calls).toHaveLength(1)

    await $.turn.complete(complete('agent-9', { usage: usage(HAIKU, 1000, 1000, 0, 0) }))
    await clock.advance(5000)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.[7]).toMatch(/^jarvis=✓1 · 省\d+%$/)
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

const ev = (over: Partial<JarvisEvent> = {}): JarvisEvent => ({
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
    expect(describeCall('Read', { file_path: '/a/b/jarvis.ts' })).toBe('jarvis.ts')
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
    let list: JarvisEvent[] = []
    for (let i = 0; i < 205; i += 1) list = addEvent(list, ev({ ts: i }))
    expect(list).toHaveLength(MAX_EVENTS)
    expect(list[0]?.ts).toBe(5)
    expect(list[199]?.ts).toBe(204)
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
    const main: JarvisMain = {
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
  const flight = (over: Partial<JarvisInflight> = {}): JarvisInflight => ({
    key: 'c1',
    actor: 'main',
    source: '主線',
    tool: 'Bash',
    startedAt: 0,
    ...over,
  })
  const mainRunning: JarvisMain = {
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
    expect(jarvisText(list, 'ok')).toBe('▶1')
    expect(jarvisText(list, 'loop')).toBe('⚠繞圈 ▶1')
    expect(jarvisText(list, 'stuck')).toBe('⚠卡住 ▶1')
    expect(jarvisText(list)).toBe(jarvisText(list, 'ok'))
    // with no subagents the warning still shows; ok shows nothing
    expect(jarvisText([], 'loop')).toBe('⚠繞圈')
    expect(jarvisText([], 'stuck')).toBe('⚠卡住')
    expect(jarvisText([], 'ok')).toBeUndefined()
  })
})

// the latest value the mod wrote for its events and main records, seen beneath the mod
const watch = (on: On) => {
  const seen: { events: JarvisEvent[]; main: JarvisMain | undefined } = { events: [], main: undefined }
  on('state.set', { plugin: 'jarvis', key: 'events' }, async (_$, e, next) => {
    seen.events = [...e.value]
    return next(e)
  })
  on('state.set', { plugin: 'jarvis', key: 'main' }, async (_$, e, next) => {
    seen.main = e.value
    return next(e)
  })
  return seen
}

// every value the mod wrote for its in-flight list, seen beneath the mod
const watchFlight = (on: On) => {
  const seen: { history: JarvisInflight[][] } = { history: [] }
  on('state.set', { plugin: 'jarvis', key: 'inflight' }, async (_$, e, next) => {
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
    const bad = await $.tool.call({ tool: 'Read', file_path: '/a/b/jarvis.ts' })
    expect(bad).toMatchObject({ isError: true, text: 'boom' })

    const list = w.events
    expect(list).toEqual([
      { ts: 1000, actor: 'main', source: '主線', isMain: true, tool: 'Bash', desc: 'List files', ms: 250, ok: true },
      { ts: 1250, actor: 'main', source: '主線', isMain: true, tool: 'Read', desc: 'jarvis.ts', ms: 250, ok: false },
    ])
    expect(w.main).toMatchObject({
      ok: 1,
      fail: 1,
      chain: 2,
      lastTool: 'Read',
      lastDesc: 'jarvis.ts',
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

  test('the very error next throws is the one that escapes, never swallowed', async () => {
    // the engine skips a test hook that throws and answers with its own error, and it
    // masks what a plugin hook does past a throwing next, so the hook is taken as it
    // registers and run by hand under a next that throws a known error
    type Hook = (...args: unknown[]) => Promise<unknown>
    const store = new Map<string, { value: unknown; version: number }>()
    const fake = {
      clock: { now: async () => 0 },
      state: {
        get: async (ref: { key: string }) => store.get(ref.key) ?? { value: undefined, version: 0 },
        set: async (ref: { key: string }, value: unknown) => {
          const version = (store.get(ref.key)?.version ?? 0) + 1
          store.set(ref.key, { value, version })
          return { isSet: true, version }
        },
      },
    }
    let hook: Hook | undefined
    const take = (name: string, ...rest: unknown[]) => {
      if (name === 'tool.call') hook = rest[rest.length - 1] as Hook
    }
    register(take as unknown as On, {})

    const boom = new Error('jarvis-test: next crashed')
    let caught: unknown
    try {
      await (hook as Hook)(fake, { tool: 'Bash', command: 'x' }, async () => {
        throw boom
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(boom)
    expect(store.get('events')?.value).toEqual([expect.objectContaining({ tool: 'Bash', ok: false })])
    expect(store.get('inflight')?.value).toEqual([])
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
      '--token jarvis=▶1 --ttl-ms 900000',
      '--token jarvis=⚠卡住 ▶1 --ttl-ms 900000',
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
    const history: JarvisInflight[][] = []
    const flight = () => (store.get('inflight')?.value ?? []) as JarvisInflight[]
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
    expect(sent).toEqual(['--token jarvis=⚠卡住 --ttl-ms 900000'])
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
    expect(sent).toEqual(['--token jarvis=⚠卡住 --ttl-ms 900000'])

    await $.tool.call({ tool: 'Read', file_path: '/x' })
    await clock.advance(5000)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toBe('--clear-token jarvis') // activity resumed: the warning is cleared
  })
})

const findAllText = (n: Node | string, re: RegExp, out: Node[] = []): Node[] => {
  if (typeof n === 'string') return out
  if (n.type === 'Text' && re.test(textOf(n))) out.push(n)
  for (const k of n.children ?? []) findAllText(k, re, out)
  return out
}

type RowPart = { t: string; props: Record<string, unknown> }
type AgentRow = { key: string; hotkey: unknown; text: string; parts: RowPart[] }

// the subagent rows the now page draws: each row Box holding an `agent-N` Button, with every
// text in it in order (the Button's brackets, then the rest of the card beside it)
const agentRowsOf = (n: Node | string, out: AgentRow[] = []): AgentRow[] => {
  if (typeof n === 'string') return out
  const kids = n.children ?? []
  const button = kids.find(
    (k): k is Node => typeof k !== 'string' && k.type === 'Button' && String(k.props?.['key'] ?? '').startsWith('agent-'),
  )
  if (n.props?.flexDirection === 'row' && button) {
    const parts = findAllText(n, /^/).map(x => ({ t: textOf(x), props: x.props ?? {} }))
    out.push({ key: String(button.props?.['key']), hotkey: button.props?.['hotkey'], text: parts.map(x => x.t).join(''), parts })
    return out
  }
  for (const k of kids) agentRowsOf(k, out)
  return out
}

const agentRows = async ($: Engine, rows = 40, cols = 80): Promise<AgentRow[]> => agentRowsOf(await draw($, rows, cols))

// width in cells of each drawn row: a row Box's texts side by side, as the pane draws them
const rowWidths = (n: Node | string): number[] => {
  if (typeof n === 'string') return [cellWidth(n)]
  if (n.type === 'Text') return [cellWidth(textOf(n))]
  const kids = n.children ?? []
  // a plain Button draws its hotkey and a colon before its label: `1: `
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

// the bordered card whose first line reads `title`
const cardOf = (tree: Node, title: RegExp): Node => {
  const find = (n: Node | string): Node | undefined => {
    if (typeof n === 'string') return undefined
    const first = n.children?.[0]
    if (n.props?.borderStyle && first !== undefined && title.test(textOf(first))) return n
    for (const k of n.children ?? []) {
      const hit = find(k)
      if (hit) return hit
    }
    return undefined
  }
  return find(tree) ?? {}
}

const mainCard = (tree: Node): Node => cardOf(tree, /^MAIN LINE/)

const TITLES = /^(主線|派工流程|模型|省錢|子代理|進行中|最近事件|事件流|MAIN LINE|DISPATCH|MODELS)$/

// the card titles each top-level block of the pane holds, in order: what shares a row
const blockTitles = (tree: Node): string[][] =>
  (tree.children ?? []).map(k => (typeof k === 'string' ? [] : findAllText(k, TITLES).map(textOf)))

// the rows of the card titled MODELS, as drawn, and the cells inside its border
const modelCard = (tree: Node): { rows: string[]; inner: number } => {
  const find = (n: Node | string): Node | undefined => {
    if (typeof n === 'string') return undefined
    const first = n.children?.[0]
    if (n.props?.borderStyle && first !== undefined && textOf(first) === 'MODELS') return n
    for (const k of n.children ?? []) {
      const hit = find(k)
      if (hit) return hit
    }
    return undefined
  }
  const card = find(tree)
  return {
    rows: (card?.children ?? []).map(textOf),
    inner: Number(card?.props?.width ?? 0) - 4,
  }
}

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

  test('durations and clock', () => {
    expect(fmtMs(150)).toBe('150ms')
    expect(fmtMs(2900)).toBe('2.9s')
    expect(fmtMs(20_900)).toBe('20.9s')
    expect(fmtMs(65_000)).toBe('1m05s')
    expect(fmtClock(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('03:04:05')
  })
})

describe('cockpit layout', () => {
  // a pane comfortably wide (stats side by side) and one under the 64-column mid breakpoint
  const WIDE_COLS = 120
  const TINY_COLS = 64
  const callMain = async ($: Engine, n: number) => {
    for (let i = 0; i < n; i += 1) await $.tool.call({ tool: 'Read', file_path: `/a/f${i}.ts` })
  }

  test('wide stats: main and models side by side over the dispatch card, n/200 on the log', async ($, on) => {
    engine(on)
    await callMain($, 3)
    await press($, 'tab-stats')
    const tree = await draw($, 40, WIDE_COLS + 40)
    expect(blockTitles(tree).slice(2, 4)).toEqual([['MAIN LINE', 'MODELS'], ['DISPATCH']])
    expect(linesOf(tree).join('\n')).toContain('沒有可計價的模型')
    await press($, 'tab-log')
    expect(findText(await draw($, 40, WIDE_COLS + 40), /^3\/200 則$/)).toBeDefined()
  })

  test('mid and narrow stats: main, dispatch and models stack', async ($, on) => {
    engine(on)
    await press($, 'tab-stats')
    for (const cols of [TINY_COLS - 4, 80]) {
      const tree = await draw($, 60, cols)
      expect(blockTitles(tree).slice(2, 5)).toEqual([['MAIN LINE'], ['DISPATCH'], ['MODELS']])
      expect(modelCard(tree).rows).toContainEqual(expect.stringMatching(/UNPRICED/))
      expect(modelCard(tree).rows).toContainEqual(expect.stringMatching(/沒有可計價的模型/))
    }
  })

  test('health: ok, a failing loop, and a stuck run each read their own way', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    let answer: unknown = { result: {} }
    on('tool.call', async () => answer as never)
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))

    let tree = await draw($, 40, 140)
    expect(findText(tree, /^ALL SYSTEMS NOMINAL$/)?.props?.color).toBe(THEME.primary)

    answer = { isError: true, result: 'boom', text: 'boom' }
    for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Bash', command: 'go test' })
    tree = await draw($, 40, 140)
    expect(findText(tree, /^WARNING: LOOP DETECTED$/)?.props?.color).toBe(THEME.error)
    expect(findText(tree, /NOMINAL/)).toBeUndefined()

    answer = { result: {} }
    await $.tool.call({ tool: 'Bash', command: 'go test' })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(STUCK_MS + 1000)
    tree = await draw($, 40, 140)
    expect(findText(tree, /^WARNING: STALL DETECTED$/)?.props?.color).toBe(THEME.error)
  })

  test('events: a failure shows a red [✗], a call over 30 seconds a gold duration', async ($, on) => {
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
    expect(findAllText(tree, /^\[✗\]$/)[0]?.props?.color).toBe(THEME.error)
    expect(findAllText(tree, /^\[✓\]$/)[0]?.props?.color).toBe(THEME.primary)
    expect(lines.find(l => l.includes('ok.ts'))).toContain('[✓]')
    expect(findText(tree, /^\s*31\.0s$/)?.props?.color).toBe(THEME.accent)
    expect(findText(tree, /^\s*29\.0s$/)?.props?.color).toBe(THEME.frame)
    // HH:MM:SS, local time, who ran it and tool
    expect(lines.find(l => l.includes('slow build'))).toMatch(/\d\d:\d\d:\d\d\s+主線\s+Bash/)
  })

  test('events: only what fits the pane is shown, newest at the bottom, the count stays whole', async ($, on) => {
    engine(on)
    await callMain($, 30)
    await press($, 'tab-log')
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

  test('the role rows: running ones light up, other shows only when it has agents', async ($, on) => {
    engine(on, 'agent-20')
    await press($, 'tab-stats')
    let tree = await draw($, 40, 170)
    expect(findAllText(tree, /^其他\s*$/)).toHaveLength(0)
    expect(findAllText(tree, /^◇$/)).toHaveLength(5)

    await $.agent.spawn(spawnInput({ description: 'job', subagentType: 'worker' }))
    tree = await draw($, 40, 170)
    expect(findText(tree, /^◆$/)?.props?.color).toBe(THEME.accent)
    expect(findText(tree, /^▶1$/)?.props?.color).toBe(THEME.accent)
    expect(findAllText(tree, /^◇$/)).toHaveLength(4)

    // narrow: the running count stays on the role's row
    tree = await draw($, 40, 50)
    expect(linesOf(tree).find(l => /◆ worker/.test(l))).toMatch(/▶1/)

    await $.turn.complete(complete('agent-20'))
    await $.agent.spawn(spawnInput({ description: 'other job', subagentType: 'general-purpose', id: 'tu-2' }))
    tree = await draw($, 40, 170)
    expect(findAllText(tree, /其他/).length).toBeGreaterThan(0)
  })

  test('stats ends with the model card, no summary line under it; the subagent list is on now', async ($, on) => {
    engine(on, 'agent-21')
    await $.agent.spawn(spawnInput({ description: 'index the repo', subagentType: 'Explore' }))
    await $.turn.complete(
      complete('agent-21', { durationMs: 2000, usage: usage(HAIKU, 1_000_000, 500_000, 2_000_000, 400_000) }),
    )
    expect(linesOf(await draw($, 40, 140)).some(l => /子代理.* 1 完成/.test(l))).toBe(true)
    await press($, 'tab-stats')
    const tree = await draw($, 40, 140)
    expect(linesOf(tree).some(l => l.includes('Haiku×1'))).toBe(false)
    const blocks = (tree.children ?? []) as Node[]
    expect(blocks).toHaveLength(4) // the title, the tab bar, main beside models, the dispatch card
    expect(findText(blocks[2] as Node, /^MODELS$/)).toBeDefined()
    expect(modelCard(tree).rows).toContainEqual(expect.stringMatching(/SAVED 98%/))
    expect(modelCard(tree).rows).toContainEqual(expect.stringMatching(/≈\$0\.42 vs Opus \$16\.80/))
  })
})

// spawns with a fresh agentId each time: agent-1, agent-2, ...
const spawner = (on: On, model = HAIKU) => {
  let n = 0
  on('agent.spawn', async () => ({ model, agentId: `agent-${(n += 1)}` }))
}

const WF = 'wf_aa7b3c9d2e'

const spawnIn = (description: string, subagentType: string, workflow?: { runId: string; agentIndex: number }) => ({
  ...spawnInput({ description, subagentType, id: `tu-${description}` }),
  ...(workflow ? { workflow } : {}),
})

const engineAll = (on: On) => {
  const clock = mock.clock(on, { now: 0 })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  spawner(on)
  return clock
}

const firstRow = (tree: Node): string => linesOf((tree.children ?? [])[0] ?? '').join('')

describe('pages', () => {
  test('now is the default page; n, l and s switch by hotkey and by press', async ($, on) => {
    engineAll(on)
    await $.tool.call({ tool: 'Read', file_path: '/a/one.ts' })
    let tree = await draw($)
    expect(blockTitles(tree).slice(2, 5)).toEqual([['子代理'], ['進行中'], ['最近事件']])

    const ui = await mountPane($)
    const tabs = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('tab-'))
    expect(tabs.map(b => [b.key, b.props['hotkey'], b.props['plain'], b.text])).toEqual([
      ['tab-now', 'n', true, '現況'],
      ['tab-log', 'l', true, '事件流'],
      ['tab-stats', 's', true, '統計'],
      ['tab-fleet', 'f', true, '艦隊'],
    ])
    // the page shown is the marked tab: its label in the accent gold, the rest in the frame teal
    expect((await ui.find({ key: 'tab-now' }))?.children).toEqual([
      expect.objectContaining({ type: 'Text', props: { bold: true, inverse: true, color: THEME.accent } }),
    ])
    expect((await ui.find({ key: 'tab-log' }))?.children).toEqual([
      expect.objectContaining({ type: 'Text', props: { color: THEME.frame } }),
    ])
    await ui.unmount()

    await hotkey($, 'l')
    tree = await draw($)
    expect(blockTitles(tree).slice(2)).toEqual([['事件流']])
    expect(findText(tree, /^1\/200 則$/)).toBeDefined()

    await hotkey($, 's')
    expect(blockTitles(await draw($)).slice(2, 4)).toEqual([['MAIN LINE'], ['DISPATCH']])

    await press($, 'tab-log')
    expect(blockTitles(await draw($)).slice(2)).toEqual([['事件流']])
    await hotkey($, 'n')
    expect(blockTitles(await draw($)).slice(2, 5)).toEqual([['子代理'], ['進行中'], ['最近事件']])
  })

  test('at 40 columns the tabs not shown keep their first character: 現 beside the whole 事件流 on the log page', async ($, on) => {
    engineAll(on)
    await press($, 'tab-log', 30, 40)
    const ui = await mountPane($, 30, 40)
    const tabs = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('tab-'))
    expect(tabs.map(b => [b.key, b.text])).toEqual([
      ['tab-now', '現'],
      ['tab-log', '事件流'],
      ['tab-stats', '統'],
      ['tab-fleet', '艦'],
    ])
    await ui.unmount()
  })

  test('the title bar carries the health: nominal primary, loop and stall red', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    let answer: unknown = { result: {} }
    on('tool.call', async () => answer as never)
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
    const health = async () => {
      const bar = (((await draw($)).children ?? [])[0] ?? {}) as Node
      const node = findText(bar, /NOMINAL|WARNING/)
      return { text: node ? textOf(node) : '', color: node?.props?.color }
    }
    expect(await health()).toEqual({ text: HEALTH_TEXT.ok, color: THEME.primary })
    expect(HEALTH_TEXT.ok).toBe('ALL SYSTEMS NOMINAL')
    answer = { isError: true, result: 'boom', text: 'boom' }
    for (let i = 0; i < 3; i += 1) await $.tool.call({ tool: 'Bash', command: 'go test' })
    expect(await health()).toEqual({ text: 'WARNING: LOOP DETECTED', color: THEME.error })
    answer = { result: {} }
    await $.tool.call({ tool: 'Bash', command: 'go test' })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(STUCK_MS + 1000)
    expect(await health()).toEqual({ text: 'WARNING: STALL DETECTED', color: THEME.error })
    // on every page
    await press($, 'tab-stats')
    expect(await health()).toEqual({ text: 'WARNING: STALL DETECTED', color: THEME.error })
  })

  test('the title reads J.A.R.V.I.S.; the arc reactor stands beside it, not the spinner', async ($, on) => {
    engineAll(on)
    await start($)
    expect(TITLE).toBe('⌜ J.A.R.V.I.S. ⌝')
    await $.agent.spawn(spawnIn('job', 'worker'))
    const bar = (((await draw($)).children ?? [])[0] ?? {}) as Node
    expect(textOf(bar).startsWith(TITLE)).toBe(true)
    expect(findText(bar, new RegExp(`^[${SPINNER.join('')}]$`))).toBeUndefined()
    expect(findText(bar, new RegExp(`^[${REACTOR.join('')}]$`))).toBeDefined()
  })
})

describe('subagent list and detail page', () => {
  test('running first, then finished; MK-1 to MK-9 take their digit, later ones are a click away', async ($, on) => {
    engineAll(on)
    for (let i = 1; i <= 11; i += 1) await $.agent.spawn(spawnIn(`job ${i}`, 'worker'))
    // jobs 1-8 finish; 9-11 still run
    for (let i = 1; i <= 8; i += 1) await $.turn.complete(complete(`agent-${i}`))

    const ui = await mountPane($, 40, 100)
    const buttons = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('agent-'))
    expect(buttons).toHaveLength(11)
    expect(buttons.every(b => b.props['plain'] === true)).toBe(true)
    await ui.unmount()
    // the running jobs first, in spawn order, then the finished ones; each keeps its number
    const rows = await agentRows($, 40, 100)
    expect(rows.slice(0, 4).map(r => [r.key, r.hotkey, /job \d+/.exec(r.text)?.[0]])).toEqual([
      ['agent-9', '9', 'job 9'],
      ['agent-10', undefined, 'job 10'],
      ['agent-11', undefined, 'job 11'],
      ['agent-8', '8', 'job 8'],
    ])
    expect(rows.filter(r => r.hotkey !== undefined).map(r => r.hotkey)).toEqual(['9', '8', '7', '6', '5', '4', '3', '2', '1'])
    // past the digits the number stands in the Button, where the engine draws a hotkey
    expect(rows[1]?.parts.slice(0, 2).map(x => x.t)).toEqual(['10:', '⌜ MK ⌝'])
    await press($, 'agent-10', 40, 100)
    expect(linesOf(await draw($, 40, 100)).join('\n')).toContain('job 10')
    await press($, 'tab-now', 40, 100)

    // a pane tall enough lists them all
    const tree = await draw($, 40, 100)
    const order = findAllText(tree, /^job \d+\s*$/).map(n => textOf(n).trim())
    expect(order).toEqual(['job 9', 'job 10', 'job 11', 'job 8', 'job 7', 'job 6', 'job 5', 'job 4', 'job 3', 'job 2', 'job 1'])
    expect(findText(tree, /^… 還有/)).toBeUndefined()
  })

  test('a digit opens that subagent; 0 goes back; n l s leave the detail page too', async ($, on) => {
    const clock = engineAll(on)
    await $.agent.spawn(spawnIn('scan the repo', 'Explore'))
    await $.agent.spawn(spawnIn('build the pane', 'worker'))
    await $.turn.complete(complete('agent-1', { durationMs: 4000, usage: usage(HAIKU, 1200, 300, 0, 0) }))

    // by dispatch order: 1 is the finished Explore, 2 the worker (listed first, running)
    await hotkey($, '1')
    let tree = await draw($, 30, 80)
    let text = linesOf(tree).join('\n')
    expect(text).toContain('子代理 · Explore')
    expect(text).toContain('scan the repo')
    expect(text).toContain('Haiku 5.5')
    expect(text).toContain('✓ MISSION COMPLETE')
    expect(findText(tree, /^⌞ MK-1 ⌟ $/)).toBeDefined()
    expect(text).toContain('4s')
    expect(text).toContain('輸入 1.2k · 輸出 300')
    expect(text).not.toContain('build the pane')

    // the detail page draws 0 and no digit; tabs stay
    let ui = await mountPane($)
    const keys = (await ui.findAll({ type: 'Button' })).map(b => [b.key, b.props['hotkey']])
    expect(keys).toEqual([
      ['tab-now', 'n'],
      ['tab-log', 'l'],
      ['tab-stats', 's'],
      ['tab-fleet', 'f'],
      ['back', '0'],
    ])
    await ui.unmount()

    await hotkey($, '0')
    tree = await draw($)
    expect(blockTitles(tree).slice(2, 5)).toEqual([['子代理'], ['進行中'], ['最近事件']])

    await hotkey($, '2')
    text = linesOf(await draw($)).join('\n')
    expect(text).toContain('子代理 · worker')
    expect(text).toContain('INITIALIZING…')
    await clock.advance(INIT_MS)
    tree = await draw($)
    text = linesOf(tree).join('\n')
    expect(text).toContain('ACTIVE')
    expect(findText(tree, /^⌜ MK-2 ⌝ $/)).toBeDefined()
    await hotkey($, 's')
    expect(blockTitles(await draw($)).slice(2, 4)).toEqual([['MAIN LINE'], ['DISPATCH']])

    // a click on the row does what its digit does
    await press($, 'tab-now')
    await press($, 'agent-1')
    expect(linesOf(await draw($)).join('\n')).toContain('子代理 · Explore')
    ui = await mountPane($)
    expect(await ui.find({ key: 'agent-1' })).toBeUndefined()
    await ui.unmount()
  })

  test('the detail page lists only the events of that subagent', async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('first', 'worker'))
    await $.agent.spawn(spawnIn('second', 'worker'))
    await $.tool.call({ tool: 'Read', file_path: '/main/m.ts' })
    await $.tool.call({ tool: 'Read', file_path: '/w1/one.ts', agentId: 'agent-1' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/w2/two.ts', agentId: 'agent-2' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/w1/three.ts', agentId: 'agent-1' } as never)
    await $.tool.call({ tool: 'WebFetch', url: 'https://x', prompt: 'p', agentId: 'agent-1' } as never)

    await hotkey($, '1')
    const text = linesOf(await draw($)).join('\n')
    expect(text).toContain('子代理 · worker')
    // the tool column fits the widest tool listed, whole
    expect(text).toContain('WebFetch')
    expect(findText(await draw($), /^Read {4}$/)).toBeDefined()
    expect(text).toContain('one.ts')
    expect(text).toContain('three.ts')
    expect(text).not.toContain('two.ts')
    expect(text).not.toContain('m.ts')
    expect(findText(await draw($), /^3 則$/)).toBeDefined()
  })

  test('the detail event list fills the rest of the pane', async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('busy', 'worker'))
    for (let i = 0; i < 40; i += 1) {
      await $.tool.call({ tool: 'Read', file_path: `/w/f${i}.ts`, agentId: 'agent-1' } as never)
    }
    await hotkey($, '1')
    const tree = await draw($, 40, 80)
    const rows = linesOf(tree).filter(l => /f\d+\.ts/.test(l))
    expect(rows.length).toBeGreaterThanOrEqual(MIN_EVENT_ROWS)
    expect(rows.length).toBeLessThan(40)
    expect(rows[rows.length - 1]).toContain('f39.ts')
  })

  test('a selected subagent that leaves the list brings back the now page, no error', async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('short lived', 'Explore'))
    await $.turn.complete(complete('agent-1'))
    await hotkey($, '1')
    expect(linesOf(await draw($)).join('\n')).toContain('short lived')

    // 50 running agents push the finished one off the list
    for (let i = 0; i < 50; i += 1) await $.agent.spawn(spawnIn(`filler ${i}`, 'worker'))
    const tree = await draw($)
    expect(linesOf(tree).join('\n')).not.toContain('short lived')
    expect(blockTitles(tree).slice(2, 5)).toEqual([['子代理'], ['進行中'], ['最近事件']])
    const ui = await mountPane($)
    expect(findText(tree, /^現況$/)?.props?.color).toBe(THEME.accent)
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('event stream pause', () => {
  test('p freezes the list, counts what came in, and p again catches up', async ($, on) => {
    engineAll(on)
    for (const f of ['a', 'b', 'c']) await $.tool.call({ tool: 'Read', file_path: `/x/${f}.ts` })
    await press($, 'tab-log')
    await hotkey($, 'p')
    for (const f of ['d', 'e']) await $.tool.call({ tool: 'Read', file_path: `/x/${f}.ts` })

    let tree = await draw($)
    let text = linesOf(tree).join('\n')
    expect(text).toContain('c.ts')
    expect(text).not.toContain('d.ts')
    expect(text).not.toContain('e.ts')
    expect(findText(tree, /^⏸ 已暫停 · 新增 2 則$/)?.props?.color).toBe(THEME.accent)
    // recording goes on: the count is whole
    expect(findText(tree, /^5\/200 則$/)).toBeDefined()
    let ui = await mountPane($)
    expect((await ui.find({ key: 'pause' }))?.text).toBe('繼續')
    await ui.unmount()

    // the other pages are live while the stream is paused
    await press($, 'tab-now')
    expect(linesOf(await draw($)).join('\n')).toContain('e.ts')
    await press($, 'tab-log')

    await press($, 'pause')
    tree = await draw($)
    text = linesOf(tree).join('\n')
    expect(text).toContain('d.ts')
    expect(text).toContain('e.ts')
    expect(findText(tree, /已暫停/)).toBeUndefined()
    ui = await mountPane($)
    expect((await ui.find({ key: 'pause' }))?.text).toBe('暫停')
    await ui.unmount()
  })

  test('past the 200 cap the pause still counts every new call, and resume shows the latest', async ($, on) => {
    engineAll(on)
    for (let i = 0; i < 195; i += 1) await $.tool.call({ tool: 'Read', file_path: `/f/${i}.ts` })
    await press($, 'tab-log')
    await hotkey($, 'p')
    for (let i = 195; i < 450; i += 1) await $.tool.call({ tool: 'Read', file_path: `/f/${i}.ts` })

    let tree = await draw($)
    expect(findText(tree, /^⏸ 已暫停 · 新增 255 則$/)).toBeDefined()
    expect(findText(tree, /^200\/200 則$/)).toBeDefined()
    expect(linesOf(tree).join('\n')).not.toContain('449.ts')

    await hotkey($, 'p')
    tree = await draw($)
    expect(findText(tree, /已暫停/)).toBeUndefined()
    expect(linesOf(tree).join('\n')).toContain('449.ts')
  })

  test('only the log page draws the pause button', async ($, on) => {
    engineAll(on)
    for (const page of ['tab-now', 'tab-stats']) {
      await press($, page)
      const ui = await mountPane($)
      expect(await ui.find({ key: 'pause' })).toBeUndefined()
      await ui.unmount()
    }
  })
})

describe('workflow grouping', () => {
  test("a run's agents are one group, in agentIndex order, under a header", async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('lone job', 'worker'))
    await $.agent.spawn(spawnIn('review b', 'general-purpose', { runId: WF, agentIndex: 2 }))
    await $.agent.spawn(spawnIn('review a', 'general-purpose', { runId: WF, agentIndex: 1 }))
    await $.agent.spawn(spawnIn('merge', 'general-purpose', { runId: WF, agentIndex: 3 }))
    for (const id of ['agent-2', 'agent-3', 'agent-4']) await $.turn.complete(complete(id))

    const tree = await draw($, 40, 100)
    // the card's rows in order, each as its texts joined
    const card = (((tree.children ?? [])[2] as Node).children ?? [])[0] as Node
    const rows = (card.children ?? []).map(textOf)
    const head = rows.findIndex(l => l.includes('workflow') && l.includes('wf_aa7b…'))
    expect(head).toBeGreaterThan(-1)
    expect(rows[head]).toContain('3 個 · 完成 3')
    // members follow in agentIndex order, a tree mark in place of the repeated type
    expect(rows.slice(head + 1, head + 4).map(l => /review a|review b|merge/.exec(l)?.[0])).toEqual([
      'review a',
      'review b',
      'merge',
    ])
    expect(rows.slice(head + 1, head + 4).map(l => /[├└]─/.exec(l)?.[0])).toEqual(['├─', '├─', '└─'])
    expect(rows.slice(head + 1, head + 4).some(l => l.includes('general-purpose'))).toBe(false)
    // the running lone job comes first; the group counts as one finished unit
    expect(rows.findIndex(l => l.includes('lone job'))).toBeLessThan(head)
  })

  test('sections: a run with a running agent sits with the running ones', () => {
    const list = [
      agent({ id: 'd', status: 'done', endedAt: 5 }),
      agent({ id: 'w1', status: 'done', runId: WF, agentIndex: 1, endedAt: 3 }),
      agent({ id: 'w2', status: 'running', runId: WF, agentIndex: 2 }),
      agent({ id: 'r', status: 'running' }),
      agent({ id: 'v1', status: 'done', runId: 'wf_other', agentIndex: 1, endedAt: 9 }),
    ]
    const sections = agentSections(list)
    expect(sections.map(x => [x.status, x.count])).toEqual([
      ['running', 2],
      ['finished', 3],
    ])
    const ids = (i: number) =>
      sections[i]?.units.map(u => (u.kind === 'agent' ? u.agent.id : u.agents.map(a => a.id).join('+')))
    expect(ids(0)).toEqual(['w1+w2', 'r'])
    expect(ids(1)).toEqual(['v1', 'd'])
  })

  test('dispatch: workflow agents get their own box; other counts only unknown types', async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('review a', 'general-purpose', { runId: WF, agentIndex: 1 }))
    await $.agent.spawn(spawnIn('review b', 'general-purpose', { runId: WF, agentIndex: 2 }))
    await $.agent.spawn(spawnIn('merge', 'worker', { runId: WF, agentIndex: 3 }))
    await $.turn.complete(complete('agent-1'))

    const by = Object.fromEntries(
      dispatchStats([
        agent({ id: '1', type: 'general-purpose', runId: WF, status: 'done' }),
        agent({ id: '2', type: 'worker', runId: WF, status: 'running' }),
        agent({ id: '3', type: 'Plan', status: 'done' }),
      ]).map(r => [r.role, r]),
    )
    expect(by['workflow']).toMatchObject({ running: 1, done: 1 })
    expect(by['other']).toMatchObject({ running: 0, done: 1 })
    expect(by['worker']).toMatchObject({ running: 0, done: 0 })

    await press($, 'tab-stats')
    let tree = await draw($, 40, 170)
    const rowOf = (name: string) => linesOf(tree).find(l => new RegExp(`[◆◇] ${name}\\b`).test(l)) ?? ''
    expect(rowOf('workflow')).toMatch(/ 1 +▶2/)
    expect(findAllText(tree, /^其他\s*$/)).toHaveLength(0)
    expect(findText(tree, /^◆$/)?.props?.color).toBe(THEME.accent)
    await $.agent.spawn(spawnIn('plan it', 'Plan'))
    tree = await draw($, 40, 170)
    expect(findAllText(tree, /^其他\s*$/)).toHaveLength(1)
  })

  test('the detail page names the workflow run', async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('review a', 'general-purpose', { runId: WF, agentIndex: 2 }))
    await hotkey($, '1')
    const text = linesOf(await draw($)).join('\n')
    expect(text).toContain(WF)
    expect(text).toContain('第 2 個')
  })
})

describe('in-flight card', () => {
  test('none: a line in the frame teal says so', async ($, on) => {
    engineAll(on)
    const tree = await draw($)
    expect(findText(tree, /^目前沒有執行中的工具呼叫$/)?.props?.color).toBe(THEME.frame)
  })

  test('each call shows who runs it (主線, or the squad member MK-N), tool, description and how long it has run', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    spawner(on)
    const gates: Array<() => void> = []
    on('tool.call', async () => {
      await new Promise<void>(r => gates.push(r))
      return { result: {} } as never
    })
    await $.agent.spawn(spawnIn('scan', 'Explore'))
    const calls = [
      $.tool.call({ tool: 'Bash', command: 'make test', description: 'Run the tests' }),
      $.tool.call({ tool: 'Grep', pattern: 'needle', agentId: 'agent-1' } as never),
    ]
    while (gates.length < 2) await clock.advance(0)
    await clock.advance(42_000)

    const tree = await draw($, 30, 100)
    const lines = linesOf(tree)
    const head = lines.find(l => l.startsWith('進行中')) ?? ''
    expect(head).toContain('2 個')
    expect(head).toMatch(/主線\s+Bash\s+Run the tests\s+42\.0s/)
    expect(head).toMatch(/MK-1\s+Grep\s+needle\s+42\.0s/)
    expect(head).not.toContain('●')
    expect(findText(tree, /^目前沒有執行中的工具呼叫$/)).toBeUndefined()

    gates.splice(0).forEach(r => r())
    await Promise.all(calls)
    expect(findText(await draw($, 30, 100), /^目前沒有執行中的工具呼叫$/)).toBeDefined()
  })
})

describe('layout fixes', () => {
  // the dispatch card's role rows, as drawn, and the cells inside its border
  const roleRows = (tree: Node): { inner: number; rows: string[] } => {
    const find = (n: Node | string): Node | undefined => {
      if (typeof n === 'string') return undefined
      if (n.props?.borderStyle && findText(n, /^DISPATCH$/)) return n
      for (const k of n.children ?? []) {
        const hit = find(k)
        if (hit) return hit
      }
      return undefined
    }
    const card = find(tree)
    const rows = (card?.children ?? []).map(k => (typeof k === 'string' ? k : textOf(k)))
    return { inner: Number(card?.props?.['width']) - 4, rows: rows.filter(r => /^[◆◇] /.test(r)) }
  }

  test('role rows hold their text whole at 64, 80, 90, 120 and 160 columns', async ($, on) => {
    engineAll(on)
    const types = ['Explore', 'clerk', 'worker', 'verifier', 'fork', 'Plan']
    for (const t of types) await $.agent.spawn(spawnIn(`a ${t}`, t))
    await $.agent.spawn(spawnIn('wf', 'general-purpose', { runId: WF, agentIndex: 1 }))
    // failures widen the row: FAIL 12
    for (let i = 0; i < 12; i += 1) {
      await $.agent.spawn(spawnIn(`v ${i}`, 'verifier'))
      await $.turn.complete(complete(`agent-${8 + i}`, { reason: 'aborted', isAborted: true }))
    }
    await press($, 'tab-stats')
    for (const cols of [64, 80, 90, 120, 160]) {
      const { inner, rows } = roleRows(await draw($, 60, cols))
      expect(rows.map(r => r.slice(2).split(/\s+/)[0])).toEqual(['Explore', 'clerk', 'worker', 'verifier', 'fork', 'workflow', '其他'])
      for (const row of rows) {
        expect(cellWidth(row)).toBeLessThanOrEqual(inner)
        expect(row).not.toContain('…')
      }
      expect(rows.find(r => r.startsWith('◆ verifier'))).toMatch(/▶1 FAIL 12/)
    }
  })

  test('a used model under 1% of the cost reads <1% with at least one cell of bar', async ($, on) => {
    expect(shareLabel(0.004)).toBe('<1%')
    expect(shareLabel(0)).toBe('<1%')
    expect(shareLabel(0.01)).toBe('1%')
    expect(shareLabel(0.5)).toBe('50%')

    mock.clock(on, { now: 0 })
    let n = 0
    const models = [HAIKU, 'claude-opus-5-5']
    on('agent.spawn', async () => ({ model: models[n] ?? HAIKU, agentId: `agent-${(n += 1)}` }))
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    await $.agent.spawn(spawnIn('tiny', 'Explore'))
    await $.agent.spawn(spawnIn('big', 'fork'))
    await $.turn.complete(complete('agent-1', { usage: usage(HAIKU, 100, 10, 0, 0) }))
    await $.turn.complete(complete('agent-2', { usage: usage('claude-opus-5-5', 1_000_000, 100_000, 0, 0) }))
    await press($, 'tab-stats')
    const tree = await draw($, 40, 100)
    const row = linesOf(tree).find(l => /Haiku/.test(l)) ?? ''
    expect(row).toMatch(/Haiku\s+<1%\s+×1/)
    expect(row).not.toMatch(/Haiku[^%]*\s0%/)
  })

  test('agent rows line up: one description width, durations and tokens right-aligned, short badges when narrow', async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('盤點 dotfiles agents 目錄的所有檔案', 'Explore'))
    await $.agent.spawn(spawnIn('盤點 github 專案清單與狀態', 'clerk'))
    await $.agent.spawn(spawnIn('short', 'verifier'))
    await $.turn.complete(complete('agent-1', { durationMs: 631_000, usage: usage(HAIKU, 70_000, 10_000, 0, 0) }))
    await $.turn.complete(complete('agent-2', { durationMs: 17_000, usage: usage(HAIKU, 4000, 300, 0, 0) }))
    for (const cols of [64, 90]) {
      const rows = await agentRows($, 40, cols)
      expect(rows).toHaveLength(3)
      // each row's texts: the bracketed mark 1st, the badge the 7th, the description the
      // 9th, the status words the 11th, the elapsed readout the 13th, the tokens the 15th
      const parts = rows.map(r => r.parts.map(x => x.t))
      const widthAt = (i: number) => parts.map(p => cellWidth(p[i] ?? ''))
      const startOf = (i: number) => parts.map(p => p.slice(0, i).reduce((n, x) => n + cellWidth(x), 0))
      expect(parts.map(p => p[0])).toEqual(['⌜ MK ⌝', '⌞ MK ⌟', '⌞ MK ⌟'])
      expect(new Set(widthAt(8)).size).toBe(1)
      expect(new Set(startOf(10)).size).toBe(1)
      expect(new Set(widthAt(10)).size).toBe(1)
      expect(new Set(startOf(12)).size).toBe(1)
      expect(new Set(widthAt(12)).size).toBe(1)
      expect(new Set(startOf(14)).size).toBe(1)
      // running first, then the latest finished
      expect(parts.map(p => (p[12] ?? '').trim())).toEqual(['0:00', '0:17', '10:31'])
      expect(parts[2]?.[12]).toBe('10:31')
      expect(parts[1]?.[12]).toMatch(/^ +0:17$/)
      expect(parts[2]?.[14]).toBe(' 80k')
      expect(parts[1]?.[14]).toBe('4.3k')
      // short status words when the full ones would squeeze the description
      expect(parts.map(p => (p[10] ?? '').trim())).toEqual(
        cols < 90 ? ['INIT…', 'COMPLETE', 'COMPLETE'] : ['⎸INITIALIZING⎹', '⎸MISSION COMPLETE⎹', '⎸MISSION COMPLETE⎹'],
      )
      const badges = parts.map(p => (p[6] ?? '').trim())
      expect(badges).toEqual(cols < 90 ? ['Haiku', 'Haiku', 'Haiku'] : ['[Haiku 5.5]', '[Haiku 5.5]', '[Haiku 5.5]'])
    }
    // a record from before runs were kept still counts as workflow by its type
    expect(dispatchStats([agent({ type: 'workflow-subagent' })]).find(r => r.role === 'workflow')?.done).toBe(1)
  })

  test('a Workflow call is never in flight, and is still in the event stream', async ($, on) => {
    const w = watch(on)
    const flight = watchFlight(on)
    engineAll(on)
    await $.tool.call({ tool: 'Workflow', name: 'review' })
    await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' })
    expect(flight.history.flat().some(x => x.tool === 'Workflow')).toBe(false)
    expect(flight.history.flat().find(x => x.tool === 'Bash')).toMatchObject({ desc: 'List files' })
    expect(w.events.map(x => x.tool)).toEqual(['Workflow', 'Bash'])
  })
})

describe('beauty pass 2', () => {
  // the frame color of the top-level card whose title matches
  const frameOf = (tree: Node, re: RegExp): unknown => {
    for (const k of tree.children ?? []) {
      if (typeof k === 'string') continue
      const card = k.props?.['borderStyle'] ? k : ((k.children ?? [])[0] as Node | undefined)
      if (card && typeof card !== 'string' && findText(card, re)) return card.props?.['borderColor']
    }
    return undefined
  }

  test('the now page shares its height: finished first, then events; folds only what does not fit', async ($, on) => {
    engineAll(on)
    for (let i = 1; i <= 10; i += 1) await $.agent.spawn(spawnIn(`job ${i}`, 'worker'))
    for (let i = 1; i <= 10; i += 1) await $.turn.complete(complete(`agent-${i}`))
    for (let i = 0; i < 30; i += 1) await $.tool.call({ tool: 'Read', file_path: `/f/e${i}.ts` })
    const events = (tree: Node) => findAllText(tree, /^e\d+\.ts\s*$/).length

    // tall: every finished job, and the events take the rest of the rows
    let tree = await draw($, 50, 80)
    expect(findAllText(tree, /^job \d+\s*$/)).toHaveLength(10)
    expect(findText(tree, /^… 還有/)).toBeUndefined()
    // 50 rows: title 1, tab 1, the standby suit over the list, list 3 + 10 (one section: no
    // header), in flight 4, events 3 + n
    expect(events(tree)).toBe(50 - 2 - SUIT_BLOCK_ROWS - 13 - 4 - 3)

    // short: the list gives way first, the events keep their least
    tree = await draw($, 22, 80)
    const jobs = findAllText(tree, /^job \d+\s*$/).length
    expect(jobs).toBeLessThan(10)
    expect(findText(tree, new RegExp(`^… 還有 ${10 - jobs} 個$`))?.props?.color).toBe(THEME.frame)
    expect(events(tree)).toBe(3)
    expect(linesOf(tree).join('\n')).not.toContain('看統計')
  })

  test('the now page cards wear the HUD colors; a squad member keeps one color everywhere', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    spawner(on)
    const gates: Array<() => void> = []
    let hold = false
    on('tool.call', async () => {
      if (hold) await new Promise<void>(r => gates.push(r))
      return { result: {} } as never
    })
    await $.agent.spawn(spawnIn('check it', 'verifier'))
    await $.tool.call({ tool: 'Read', file_path: '/a.ts' })
    await $.tool.call({ tool: 'Read', file_path: '/b.ts', agentId: 'agent-1' } as never)
    const member = jarvisColor(0)
    let tree = await draw($)
    expect(frameOf(tree, /^子代理$/)).toBe(THEME.frame)
    expect(findText(tree, /^子代理$/)?.props?.color).toBe(THEME.primary)
    expect(frameOf(tree, /^進行中$/)).toBe(THEME.muted)
    expect(frameOf(tree, /^最近事件$/)).toBe(THEME.frame)
    // the card: its mark and type in the member's color; the main loop in gold
    expect(findText(tree, /^⌜ MK ⌝$/)?.props?.color).toBe(member)
    expect(findText(tree, /^verifier\s*$/)?.props?.color).toBe(member)
    expect(findText(tree, /^主線\s+$/)?.props?.color).toBe(THEME.accent)
    // its events carry its mark in its color
    expect(findText(tree, /^MK-1\s*$/)?.props?.color).toBe(member)

    // a call in flight turns the card gold, its actor the member's number and color
    hold = true
    const call = $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'agent-1' } as never)
    while (gates.length < 1) await clock.advance(0)
    tree = await draw($)
    expect(frameOf(tree, /^進行中$/)).toBe(THEME.accent)
    const named = findAllText(tree, /^MK-1\s*$/)
    expect(named).toHaveLength(2)
    expect(named.every(n => n.props?.color === member)).toBe(true)
    gates.splice(0).forEach(r => r())
    await call

    // the detail page frames in the member's color; the dispatch flow keeps the role's
    await hotkey($, '1')
    tree = await draw($)
    expect(frameOf(tree, /^子代理$/)).toBe(member)
    expect(frameOf(tree, /^事件流$/)).toBe(THEME.frame)
    await press($, 'tab-stats')
    expect(findText(await draw($, 40, 170), /^verifier$/)?.props?.color).toBe(ROLE_COLOR.verifier)
    await press($, 'tab-log')
    tree = await draw($)
    expect(frameOf(tree, /^事件流$/)).toBe(THEME.frame)
    expect(findText(tree, /^MK-1\s*$/)?.props?.color).toBe(member)
  })

  test('the list title counts running, done, failed and lost', async ($, on) => {
    const clock = engineAll(on)
    await $.agent.spawn(spawnIn('a', 'worker'))
    await $.agent.spawn(spawnIn('b', 'worker'))
    await $.agent.spawn(spawnIn('c', 'worker'))
    await $.turn.complete(complete('agent-1'))
    await $.turn.complete(complete('agent-2', { reason: 'aborted', isAborted: true }))
    let tree = await draw($)
    const head = () => {
      const card = (((tree.children ?? [])[2] as Node).children ?? [])[0] as Node
      return textOf((card.children ?? [])[0] ?? '')
    }
    // no ✓ or ✗ against the counts: a fallback font leaves a gap after them; colors tell them apart
    expect(head()).toMatch(/子代理.*▶1 執行中 · 1 完成 · 1 失敗$/)
    expect(findText(tree, /^1 完成$/)?.props?.color).toBe(THEME.frame)
    expect(findText(tree, /^1 失敗$/)?.props?.color).toBe(THEME.error)
    expect(findText(tree, /^執行中 \(1\)$/)?.props?.color).toBe(THEME.frame)
    expect(findText(tree, /^已完成 \(2\)$/)?.props?.color).toBe(THEME.frame)
    await start($)
    await clock.advance(STALE_MS + 2000)
    tree = await draw($)
    expect(head()).toMatch(/ 1 完成 · 1 失敗 · \?1 失聯$/)
  })

  test('a Bash call without a description shows the command past cd and variable settings', () => {
    const d = (command: string) => describeCall('Bash', { command })
    expect(d('cd ~/dotfiles/claude/mods/jarvis && claude plugin test')).toBe('claude plugin test')
    expect(d('cd /tmp; ls -la')).toBe('ls -la')
    expect(d('cd "/a b" && make')).toBe('make')
    expect(d('FOO=1 BAR="x y" go test ./...')).toBe('go test ./...')
    expect(d('S=/private/tmp/x; $S/run.sh')).toBe('$S/run.sh')
    expect(d('cd ~/x && NODE_ENV=test npm run build')).toBe('npm run build')
    // nothing to strip, or nothing left after it: as written
    expect(d('git status')).toBe('git status')
    expect(d('cd ~/x')).toBe('cd ~/x')
    expect(d('FOO=1')).toBe('FOO=1')
    // a description wins as before
    expect(describeCall('Bash', { command: 'cd x && ls', description: 'List' })).toBe('List')
  })

  test('the main card is six rows beside the readouts, nine with them under the digits when narrow', async ($, on) => {
    engineAll(on)
    await press($, 'tab-stats')
    const mainHeight = (tree: Node) => {
      const find = (n: Node | string): Node | undefined => {
        if (typeof n === 'string') return undefined
        if (n.props?.borderStyle && findText(n, /^MAIN LINE$/)) return n
        for (const k of n.children ?? []) {
          const hit = find(k)
          if (hit) return hit
        }
        return undefined
      }
      return Number(find(tree)?.props?.['height'])
    }
    expect(mainHeight(await draw($, 60, 120))).toBe(6)
    expect(mainHeight(await draw($, 60, 80))).toBe(6)
    expect(mainHeight(await draw($, 60, 50))).toBe(9)
  })
})

describe('beauty pass 3', () => {
  test('one section draws no section header; two or more do', async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('a', 'worker'))
    await $.agent.spawn(spawnIn('b', 'worker'))
    await $.turn.complete(complete('agent-1'))
    await $.turn.complete(complete('agent-2'))
    let tree = await draw($)
    expect(findText(tree, /^已完成 \(\d+\)$/)).toBeUndefined()
    expect(findText(tree, /^2 完成$/)).toBeDefined()

    await $.agent.spawn(spawnIn('c', 'worker'))
    tree = await draw($)
    expect(findText(tree, /^執行中 \(1\)$/)).toBeDefined()
    expect(findText(tree, /^已完成 \(2\)$/)).toBeDefined()
  })

  test('wide stats: the dispatch card spans the pane under main and models', async ($, on) => {
    engineAll(on)
    for (const t of ['Explore', 'clerk', 'worker', 'verifier', 'fork', 'Plan']) await $.agent.spawn(spawnIn(t, t))
    await press($, 'tab-stats')
    for (const cols of [100, 140, 160]) {
      const tree = await draw($, 60, cols)
      const dispatch = (tree.children ?? [])[3] as Node
      const box = (dispatch.children ?? [])[0] as Node
      expect(Number(box.props?.['width'])).toBe(cols)
      expect(findText(box, /^DISPATCH$/)).toBeDefined()
    }
  })
})

describe('beauty pass 4', () => {
  test('the detail page shows cache tokens beside input and output', async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('read a lot', 'Explore'))
    await $.agent.spawn(spawnIn('no cache', 'worker'))
    await $.turn.complete(complete('agent-1', { usage: usage(HAIKU, 4, 501, 12_000, 2_400_000) }))
    await $.turn.complete(complete('agent-2', { usage: usage(HAIKU, 100, 20, 0, 0) }))
    // by dispatch order: 1 is the Explore, 2 the worker
    await hotkey($, '1')
    let text = linesOf(await draw($)).join('\n')
    expect(text).toContain('輸入 4 · 輸出 501')
    expect(text).toContain('讀取 12k · 寫入 2.4M')
    await hotkey($, '0')
    await hotkey($, '2')
    text = linesOf(await draw($)).join('\n')
    expect(text).toContain('輸入 100 · 輸出 20')
    expect(text).not.toContain('快取')
  })

  test('detail events leave out the actor column; the log keeps it', async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('look', 'Explore'))
    await $.tool.call({ tool: 'Grep', pattern: 'needle', agentId: 'agent-1' } as never)
    await hotkey($, '1')
    let tree = await draw($)
    const row = findAllText(tree, /^needle\s*$/)
    expect(row).toHaveLength(1)
    // the type is named once, in the info card; no actor cell in the event row
    expect(findAllText(tree, /^MK-1 +$/)).toHaveLength(0)
    expect(findText(tree, /^Explore$/)).toBeDefined()
    await press($, 'tab-log')
    tree = await draw($)
    expect(findAllText(tree, /^MK-1 +$/)).toHaveLength(1)
  })

  test('one model card at every width: counts beside the names, a rule, then the savings', async ($, on) => {
    mock.clock(on, { now: 0 })
    const plan = [
      ...Array.from({ length: 4 }, () => 'claude-opus-5-5'),
      ...Array.from({ length: 8 }, () => 'claude-sonnet-5-5'),
      ...Array.from({ length: 8 }, () => HAIKU),
    ]
    let n = 0
    on('agent.spawn', async () => ({ model: plan[n] ?? HAIKU, agentId: `agent-${(n += 1)}` }))
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    await press($, 'tab-stats')
    // nothing dispatched: the hint under the cards is cut to the pane
    const empty = await draw($, 60, 30)
    const hint = findText(empty, /^還沒有派工/)
    expect(cellWidth(textOf(hint as Node))).toBeLessThanOrEqual(30)
    expect(textOf(hint as Node)).toMatch(/…$/)

    for (const [i, model] of plan.entries()) {
      await $.agent.spawn(spawnIn(`job ${i}`, 'worker'))
      await $.turn.complete(complete(`agent-${i + 1}`, { usage: usage(model, 10_000, 1000, 0, 0) }))
    }
    for (const cols of [30, 64, 90, 120]) {
      const tree = await draw($, 60, cols)
      expect(findText(tree, /^還沒有派工/)).toBeUndefined()
      expect(linesOf(tree).some(l => /(Opus|Sonnet|Haiku)×\d/.test(l))).toBe(false)
      expect(Math.max(...rowWidths(tree))).toBeLessThanOrEqual(cols)
      const { rows, inner } = modelCard(tree)
      expect(rows[0]?.trim()).toBe('MODELS')
      const models = rows
        .map(r => r.match(/(Sonnet|Opus|Haiku)\s+\S*?\s*(\d+%|<1%)\s+(×\d+)/)?.slice(1))
        .filter((x): x is string[] => x !== undefined)
      // highest cost first: eight Sonnet calls outspend four Opus ones
      expect(models.map(m => [m[0], m[2]])).toEqual([
        ['Sonnet', '×8'],
        ['Opus', '×4'],
        ['Haiku', '×8'],
      ])
      expect(rows.some(r => /SAVED \d+%/.test(r))).toBe(true)
      expect(rows.some(r => /≈\$\S+ vs Opus \$\S+/.test(r))).toBe(true)
      for (const r of rows) expect(cellWidth(r)).toBeLessThanOrEqual(inner)
    }
  })
})

describe('HUD logic', () => {
  test('each dispatch role wears a squad color: one palette for both, its values unchanged', () => {
    expect(JARVIS_PALETTE).toEqual(['#E879F9', '#88F8A8', '#9B8CFF', '#FF8FB1', '#A8F868', '#D0C8F8'])
    expect(ROLE_COLOR).toEqual({
      Explore: JARVIS_PALETTE[0],
      clerk: JARVIS_PALETTE[1],
      worker: JARVIS_PALETTE[2],
      verifier: JARVIS_PALETTE[3],
      fork: JARVIS_PALETTE[5],
      workflow: JARVIS_PALETTE[4],
      other: THEME.frame,
    })
  })

  test('jarvis colors cycle through the palette by dispatch order, none the accent, error or muted tone', () => {
    expect(JARVIS_PALETTE.length).toBeGreaterThanOrEqual(6)
    expect(JARVIS_PALETTE.map((_, i) => jarvisColor(i))).toEqual(JARVIS_PALETTE)
    expect(jarvisColor(JARVIS_PALETTE.length)).toBe(JARVIS_PALETTE[0])
    expect(jarvisColor(JARVIS_PALETTE.length + 2)).toBe(JARVIS_PALETTE[2])
    expect(jarvisColor(-1)).toBe(JARVIS_PALETTE[JARVIS_PALETTE.length - 1])
    expect(jarvisColor(Number.NaN)).toBe(JARVIS_PALETTE[0])
    expect(new Set(JARVIS_PALETTE).size).toBe(JARVIS_PALETTE.length)
    for (const c of [THEME.accent, THEME.error, THEME.muted]) expect(JARVIS_PALETTE).not.toContain(c)
  })

  test('addAgent stamps the dispatch order; the roster numbers and colors by it, whatever the list order', () => {
    let list = addAgent([], { id: 'a', type: 'worker', description: 'd', model: SONNET, now: 0 })
    list = addAgent(list, { id: 'b', type: 'worker', description: 'd', model: SONNET, now: 0 })
    list = addAgent(list, { id: 'c', type: 'worker', description: 'd', model: SONNET, now: 0 })
    expect(list.map(a => a.seq)).toEqual([0, 1, 2])
    // a finishes: the running ones come first in the list, a keeps its number and color
    list = finishTurn(list, 'a', { reason: 'answer', durationMs: 1 }, 5)
    const roster = rosterOf(list, agentSections(list))
    expect([...roster.entries()]).toEqual([
      ['b', { n: 2, color: jarvisColor(1) }],
      ['c', { n: 3, color: jarvisColor(2) }],
      ['a', { n: 1, color: jarvisColor(0) }],
    ])
    // past the 50 kept, the order still climbs: colors never shift when old ones drop
    for (let i = 0; i < 60; i += 1) {
      list = addAgent(list, { id: `x${i}`, type: 'worker', description: 'd', model: SONNET, now: i })
      list = finishTurn(list, `x${i}`, { reason: 'answer', durationMs: 1 }, i)
    }
    expect(list.find(a => a.id === 'x59')?.seq).toBe(62)
    // a record from before the order was kept falls back to its place
    const legacy = [agent({ id: 'p' }), agent({ id: 'q' })]
    expect(rosterOf(legacy, agentSections(legacy)).get('q')?.color).toBe(jarvisColor(1))
    expect(buildCockpit({ agents: list, main: { model: '', chain: 0, ok: 0, fail: 0, lastTool: '', lastDesc: '', isRunning: false, runSince: 0 }, events: [] }, 0).roster.size).toBe(list.length)
  })

  test('a failure is recovered only when the same actor next runs the same tool and it works', () => {
    const f = (actor: string, tool: string, ok: boolean) => ev({ actor, isMain: actor === 'main', tool, ok })
    expect(outcomesOf([])).toEqual([])
    expect(outcomesOf([f('main', 'Bash', false), f('main', 'Bash', true)])).toEqual(['recovered', 'ok'])
    // the next call is another tool: still failed
    expect(outcomesOf([f('main', 'Bash', false), f('main', 'Read', true)])).toEqual(['failed', 'ok'])
    // the same tool fails again: the first stays failed, the second is recovered by the third
    expect(outcomesOf([f('main', 'Bash', false), f('main', 'Bash', false), f('main', 'Bash', true)])).toEqual([
      'failed',
      'recovered',
      'ok',
    ])
    // nothing after it yet: failed
    expect(outcomesOf([f('main', 'Bash', false)])).toEqual(['failed'])
    // another actor's success between does not count; that actor's own next call does
    expect(outcomesOf([f('w1', 'Bash', false), f('w2', 'Bash', true), f('w1', 'Bash', true)])).toEqual([
      'recovered',
      'ok',
      'ok',
    ])
    expect(outcomesOf([f('w1', 'Bash', false), f('w2', 'Bash', true)])).toEqual(['failed', 'ok'])
  })

  test('a dated rule goes between events more than an hour apart; the events stay', () => {
    const at = (ts: number) => ev({ ts })
    const day1 = new Date(2026, 9, 10, 23, 0, 0).getTime()
    const day2 = new Date(2026, 9, 11, 9, 30, 0).getTime()
    expect(fmtDate(day1)).toBe('10/10')
    expect(fmtDate(day2)).toBe('10/11')
    const rows = eventRows([at(day1), at(day1 + 1000), at(day2), at(day2 + BREAK_MS)])
    expect(rows.map(r => (r.kind === 'break' ? `break ${fmtDate(r.ts)}` : r.ev.ts))).toEqual([
      day1,
      day1 + 1000,
      'break 10/11',
      day2,
      day2 + BREAK_MS, // exactly an hour: no rule
    ])
    expect(eventRows([at(0), at(BREAK_MS + 1)]).map(r => r.kind)).toEqual(['event', 'break', 'event'])
    expect(eventRows([])).toEqual([])
    // each event carries its outcome
    const out = eventRows([ev({ tool: 'Bash', ok: false }), ev({ tool: 'Bash', ok: true })])
    expect(out.map(r => (r.kind === 'event' ? r.outcome : r.kind))).toEqual(['recovered', 'ok'])
  })

  test('phases: initializing for the first two seconds, then active, complete, failed, lost', () => {
    const run = agent({ status: 'running', runStartedAt: 1000 })
    expect(phaseOf(run, 1000)).toBe('init')
    expect(phaseOf(run, 1000 + INIT_MS - 1)).toBe('init')
    expect(phaseOf(run, 1000 + INIT_MS)).toBe('active')
    expect(phaseOf(agent({ status: 'done' }), 0)).toBe('complete')
    expect(phaseOf(agent({ status: 'failed' }), 0)).toBe('failed')
    expect(phaseOf(agent({ status: 'stale' }), 0)).toBe('lost')
    expect([0, 1, 2, 3].map(scanFrame)).toEqual([SCAN[0], SCAN[1], SCAN[2], SCAN[0]])
  })

  test('the tick runs at 150ms while a squad member runs in a pane in view, and at the idle pace otherwise', () => {
    expect(ANIM_MS).toBe(150)
    const run = [agent({ status: 'running' })]
    expect(tickMs([], 1000, 1000)).toBe(IDLE_MS)
    expect(tickMs([agent({ status: 'done' }), agent({ status: 'stale' })], 1000, 1000)).toBe(IDLE_MS)
    expect(tickMs(run, 1000, 1000)).toBe(ANIM_MS)
    expect(tickMs(run, 1000 + SEEN_MS, 1000)).toBe(ANIM_MS)
    // nobody has drawn the pane for a while: no animation to keep up
    expect(tickMs(run, 1001 + SEEN_MS, 1000)).toBe(IDLE_MS)
    expect(tickMs(run, 0, -Infinity)).toBe(IDLE_MS)
  })
})

describe('HUD pages', () => {
  test('a squad card: initializing, then active with its tool, then complete in the frame teal, brackets too', async ($, on) => {
    const clock = engineAll(on)
    await $.agent.spawn(spawnIn('wire the hud', 'worker'))
    const cardRow = async () => linesOf(await draw($, 30, 120)).find(l => l.includes('wire the hud')) ?? ''

    let tree = await draw($, 30, 120)
    expect(await cardRow()).toContain('⎸INITIALIZING⎹')
    expect(findText(tree, new RegExp(`^(${SCAN.join('|')})$`))).toBeDefined()
    expect(findText(tree, /^⌜ MK ⌝$/)?.props?.color).toBe(jarvisColor(0))
    expect(findText(tree, /^\s*⎸INITIALIZING⎹$/)?.props?.color).toBe(THEME.primary)

    await clock.advance(INIT_MS)
    await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'agent-1' } as never)
    tree = await draw($, 30, 120)
    expect(await cardRow()).toMatch(/⎸ACTIVE⎹ Bash\s+0:02/)
    expect(findText(tree, /^\s*⎸ACTIVE⎹ Bash$/)?.props?.color).toBe(THEME.accent)
    expect(findText(tree, new RegExp(`^[${SPINNER.join('')}]$`))).toBeDefined()

    await $.turn.complete(complete('agent-1', { durationMs: 7000 }))
    tree = await draw($, 30, 120)
    expect(await cardRow()).toMatch(/⎸MISSION COMPLETE⎹\s+0:07/)
    // the brackets are a plain Button: hover inverts them, and the dark blue inverted all but vanishes
    expect(findText(tree, /^⌞ MK ⌟$/)?.props?.color).toBe(THEME.frame)
    expect(findText(tree, /^⌞ MK ⌟$/)?.props?.color).not.toBe(THEME.muted)
    expect(findText(tree, /^⌜ MK ⌝$/)).toBeUndefined()
    expect(findText(tree, /^wire the hud\s*$/)?.props?.color).toBe(THEME.frame)
    expect(findText(tree, /^\s*⎸MISSION COMPLETE⎹$/)?.props?.color).toBe(THEME.frame)

    // a failed turn reads MISSION FAILED in red
    await $.agent.spawn(spawnIn('break it', 'worker'))
    await $.turn.complete(complete('agent-2', { reason: 'aborted', isAborted: true }))
    tree = await draw($, 30, 120)
    expect(linesOf(tree).find(l => l.includes('break it'))).toContain('MISSION FAILED')
    expect(findText(tree, /^\s*⎸MISSION FAILED⎹$/)?.props?.color).toBe(THEME.error)
  })

  test('a failure the same actor retries with success reads ↻ alone in near white at every width; others stay a red [✗]', async ($, on) => {
    mock.clock(on, { now: 0 })
    spawner(on)
    let fail = false
    on('tool.call', async () => (fail ? { isError: true, result: 'x', text: 'x' } : { result: {} }) as never)
    fail = true
    await $.tool.call({ tool: 'Bash', command: 'go test', description: 'p1' })
    fail = false
    await $.tool.call({ tool: 'Bash', command: 'go test', description: 'p2' })
    fail = true
    await $.tool.call({ tool: 'Read', file_path: '/a/m.ts' })
    fail = false
    await $.tool.call({ tool: 'Grep', pattern: 'other' } as never)

    expect(RECOVERED).toBe('↻')
    for (const cols of [40, 64, 80, 120]) {
      for (const tab of ['tab-now', 'tab-log']) {
        await press($, tab, 40, cols)
        const tree = await draw($, 40, cols)
        const lines = linesOf(tree)
        expect(lines.find(l => l.includes('p1'))).toContain('↻')
        expect(lines.find(l => l.includes('m.ts'))).toContain('[✗]')
        expect(lines.find(l => l.includes('m.ts'))).not.toContain('↻')
        expect(findText(tree, /^↻\s*$/)?.props?.color).toBe(THEME.bright)
        expect(findText(tree, /^\[✗\]\s*$/)?.props?.color).toBe(THEME.error)
        expect(findAllText(tree, /↻/)).toHaveLength(1)
        expect(findAllText(tree, /RECOVERED/)).toHaveLength(0)
      }
    }
  })

  test('events more than an hour apart get a dated rule, dark blue with the date in the frame teal; it takes a row of the room', async ($, on) => {
    const day1 = new Date(2026, 9, 10, 22, 0, 0).getTime()
    const clock = mock.clock(on, { now: day1 })
    on('tool.call', async () => ({ result: {} }) as never)
    for (let i = 0; i < 20; i += 1) await $.tool.call({ tool: 'Read', file_path: `/old/o${i}.ts` })
    await clock.advance(11 * 60 * MIN)
    for (let i = 0; i < 20; i += 1) await $.tool.call({ tool: 'Read', file_path: `/new/n${i}.ts` })
    const rule = /^──\s+10\/11\s+─+$/
    const date = /^10\/11$/
    // the row Box that holds `hit`
    const rowOf = (n: Node | string, hit: Node): Node | undefined => {
      if (typeof n === 'string') return undefined
      if ((n.children ?? []).includes(hit)) return n
      for (const k of n.children ?? []) {
        const found = rowOf(k, hit)
        if (found) return found
      }
      return undefined
    }

    await press($, 'tab-log')
    let tree = await draw($, 80, 100)
    const lines = linesOf(tree)
    const at = lines.findIndex(l => rule.test(l.trim()))
    expect(at).toBeGreaterThan(-1)
    expect(lines[at - 1]).toContain('o19.ts')
    expect(lines[at + 1]).toContain('n0.ts')
    expect(findAllText(tree, date)).toHaveLength(1)
    const dated = findText(tree, date) as Node
    expect(dated.props?.color).toBe(THEME.frame)
    const ruleRow = rowOf(tree, dated) as Node
    expect((ruleRow.children ?? []).map(k => (k as Node).props?.color)).toEqual([THEME.muted, THEME.frame, THEME.muted])
    expect(cellWidth(textOf(ruleRow))).toBe(100 - 4)
    // nothing was dropped: the count is whole
    expect(findText(tree, /^40\/200 則$/)).toBeDefined()

    // the now page: 50 rows and the standby suit's less title, tab, the empty list (4), in
    // flight (4), the card's frame and title (3) and the rule itself
    await press($, 'tab-now')
    tree = await draw($, 50 + SUIT_BLOCK_ROWS, 100)
    expect(findAllText(tree, date)).toHaveLength(1)
    expect(findAllText(tree, /^[on]\d+\.ts\s*$/)).toHaveLength(50 - 2 - 4 - 4 - 3 - 1)
    // room for all: every event and the rule, the oldest not pushed out by the rule
    tree = await draw($, 80, 100)
    expect(findAllText(tree, date)).toHaveLength(1)
    expect(findAllText(tree, /^[on]\d+\.ts\s*$/)).toHaveLength(40)
  })

  test('at 40 and 50 columns no page runs past the width', async ($, on) => {
    const day1 = new Date(2026, 9, 10, 22, 0, 0).getTime()
    const clock = mock.clock(on, { now: day1 })
    spawner(on)
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    let fail = false
    on('tool.call', async () => (fail ? { isError: true, result: 'x', text: 'x' } : { result: {} }) as never)
    await $.agent.spawn(spawnIn('盤點 dotfiles agents 目錄的所有檔案與狀態', 'Explore'))
    await $.agent.spawn(spawnIn('review a', 'general-purpose', { runId: WF, agentIndex: 1 }))
    await $.agent.spawn(spawnIn('一個很長很長的中文任務描述', 'verifier'))
    await $.turn.complete(complete('agent-1', { usage: usage(HAIKU, 70_000, 10_000, 0, 0) }))
    await $.turn.complete(complete('agent-3', { reason: 'aborted', isAborted: true }))
    fail = true
    await $.tool.call({ tool: 'Bash', command: 'x', description: '中文的工具描述也很長很長很長', agentId: 'agent-2' } as never)
    fail = false
    await clock.advance(2 * 60 * MIN)
    await $.tool.call({ tool: 'Bash', command: 'x', description: 'again', agentId: 'agent-2' } as never)

    for (const cols of [40, 50]) {
      for (const page of ['tab-now', 'tab-log', 'tab-stats']) {
        await press($, page, 40, cols)
        const tree = await draw($, 40, cols)
        expect(Math.max(...rowWidths(tree))).toBeLessThanOrEqual(cols)
      }
      await press($, 'tab-now', 40, cols)
      const rows = await agentRows($, 40, cols)
      expect(rows.length).toBeGreaterThan(0)
      const descs = ['盤點 dotfiles agents 目錄的所有檔案與狀態', 'review a', '一個很長很長的中文任務描述']
      for (const r of rows) {
        const parts = r.parts.map(x => x.t)
        expect(parts.reduce((n, t) => n + cellWidth(t), 0)).toBeLessThanOrEqual(cols - 4 - 3)
        // the description stays readable; the type and the model badge give way to it
        const desc = parts.map(t => t.trim()).find(t => t !== '' && descs.some(d => d.startsWith(t.replace(/…$/, ''))))
        expect(cellWidth(desc ?? '')).toBeGreaterThanOrEqual(8)
        for (const gone of ['Explore', 'verifier', 'general-purpose', 'Haiku', '├─', '└─']) {
          expect(parts.some(t => t.trim() === gone)).toBe(false)
        }
      }
      await hotkey($, '1', 40, cols)
      expect(Math.max(...rowWidths(await draw($, 40, cols)))).toBeLessThanOrEqual(cols)
    }
  })
})

describe('Mark 42', () => {
  const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]

  const rowText = (parts: { t: string }[]) => parts.map(p => p.t).join('')

  test('the palette lives in THEME; no squad color is a theme tone or reads as the alarm red', () => {
    expect(THEME).toMatchObject({
      frame: '#B07A2A',
      primary: '#F2B84B',
      accent: '#5CE1FF',
      bright: '#FFF1D6',
      error: '#FF3B30',
      muted: '#4A3418',
      suitRed: '#C8102E',
      suitGold: '#E8B04B',
    })
    expect(JARVIS_PALETTE).toHaveLength(6)
    for (const c of Object.values(THEME)) expect(JARVIS_PALETTE).not.toContain(c)
    for (const c of JARVIS_PALETTE) {
      const [r, g, b] = rgb(c)
      expect(r > 200 && g < 140 && b < 140).toBe(false)
    }
    const dist = (x: string, y: string) => Math.hypot(...rgb(x).map((v, i) => v - (rgb(y)[i] ?? v)))
    for (const c of JARVIS_PALETTE) {
      for (const t of [THEME.accent, THEME.primary, THEME.error]) expect(dist(c, t)).toBeGreaterThan(100)
    }
    JARVIS_PALETTE.forEach((c, i) => {
      for (const d of JARVIS_PALETTE.slice(i + 1)) expect(dist(c, d)).toBeGreaterThan(70)
    })
    const family = Object.values(FAMILY_COLOR)
    family.forEach((c, i) => {
      for (const d of family.slice(i + 1)) expect(dist(c, d)).toBeGreaterThan(100)
    })
  })

  test('the title is suit red with gold corners; health warnings are red; the recovered ↻ is bright', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    let answer: unknown = { result: {} }
    on('tool.call', async () => answer as never)
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
    let tree = await draw($, 40, 120)
    const bar = ((tree.children ?? [])[0] ?? {}) as Node
    expect(findText(bar, /^J\.A\.R\.V\.I\.S\.$/)?.props?.color).toBe(THEME.suitRed)
    expect(findText(bar, /^⌜ $/)?.props?.color).toBe(THEME.suitGold)
    expect(findText(bar, /^ ⌝$/)?.props?.color).toBe(THEME.suitGold)

    answer = { isError: true, result: 'x', text: 'x' }
    await $.tool.call({ tool: 'Bash', command: 'go test', description: 'first' })
    answer = { result: {} }
    await $.tool.call({ tool: 'Bash', command: 'go test', description: 'second' })
    tree = await draw($, 40, 120)
    expect(findText(tree, /^↻\s*$/)?.props?.color).toBe(THEME.bright)

    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(STUCK_MS + 1000)
    tree = await draw($, 40, 120)
    expect(findText(tree, /^WARNING: STALL DETECTED$/)?.props?.color).toBe(THEME.error)
  })

  test('MK numbers: rows leave the digit to the hotkey, events and the detail title read MK-N', async ($, on) => {
    engineAll(on)
    for (let i = 1; i <= 10; i += 1) await $.agent.spawn(spawnIn(`job ${i}`, 'worker'))
    await $.tool.call({ tool: 'Read', file_path: '/w/one.ts', agentId: 'agent-1' } as never)

    const rows = await agentRows($, 40, 100)
    expect(rows).toHaveLength(10)
    const digits = rows.filter(r => r.hotkey !== undefined)
    expect(digits).toHaveLength(MAX_NUMBERED)
    // the engine draws `N:` before a plain Button's label: the row draws no digit of its own
    for (const r of digits) expect(r.parts[0]?.t).toBe('⌜ MK ⌝')
    // the tenth has no hotkey: its number stands where the engine's would
    expect(rows.find(r => r.key === 'agent-10')?.parts.map(x => x.t).slice(0, 2)).toEqual(['10:', '⌜ MK ⌝'])
    const tree = await draw($, 40, 100)
    expect(findText(tree, /^10:$/)?.props?.color).toBe(THEME.frame)

    // events: MK-1 with room, 1 when narrow; no ● before it (a fallback font gaps after it)
    expect(findText(tree, /^MK-1\s*$/)?.props?.color).toBe(jarvisColor(0))
    expect(findText(await draw($, 40, 40), /^1\s*$/)?.props?.color).toBe(jarvisColor(0))
    expect(findText(await draw($, 40, 40), /MK-/)).toBeUndefined()
    expect(findText(tree, /●/)).toBeUndefined()

    await hotkey($, '1')
    expect(findText(await draw($), /^⌜ MK-1 ⌝ $/)).toBeDefined()
  })

  test('the arc reactor beside the title pulses while a squad member runs, and rests dark when idle', async ($, on) => {
    // pure: a pulse of width-1 braille, amber to bright; idle one dark glyph
    const live = REACTOR.map((_, i) => reactorOf(i, true))
    expect(new Set(live.map(f => f.glyph)).size).toBeGreaterThan(1)
    expect(new Set(live.map(f => f.color))).toEqual(new Set([THEME.accent, THEME.bright]))
    for (const f of [...live, reactorOf(0, false)]) {
      expect(cellWidth(f.glyph)).toBe(1)
      const c = f.glyph.codePointAt(0) ?? 0
      expect(c >= 0x2800 && c <= 0x28ff).toBe(true)
    }
    expect(reactorOf(3, false)).toEqual(reactorOf(0, false))
    expect(reactorOf(0, false).color).toBe(THEME.muted)

    const clock = engineAll(on)
    await start($)
    const glyphs = REACTOR.join('') + reactorOf(0, false).glyph
    const reactor = async () => {
      const bar = (((await draw($)).children ?? [])[0] ?? {}) as Node
      const node = findText(bar, new RegExp(`^[${glyphs}]$`))
      return { glyph: node ? textOf(node) : undefined, color: node?.props?.color }
    }
    const idle = await reactor()
    expect(idle).toEqual({ glyph: reactorOf(0, false).glyph, color: THEME.muted })
    await clock.advance(ANIM_MS * 3)
    expect(await reactor()).toEqual(idle)

    await $.agent.spawn(spawnIn('job', 'worker'))
    const a = await reactor()
    await clock.advance(ANIM_MS)
    const b = await reactor()
    expect(a.glyph).toBeDefined()
    expect(b.glyph).not.toBe(a.glyph)
    expect([THEME.accent, THEME.bright]).toContain(a.color)

    await $.turn.complete(complete('agent-1'))
    expect(await reactor()).toEqual(idle)
  })

  test('boot: /jarvis plays ONLINE, then the manifest loading to 100%, once, ticking as it goes', async ($, on) => {
    // pure: stages by the time since the pane opened
    expect(bootStage(0)).toEqual({ phase: 'online' })
    expect(bootStage(BOOT_MS * 0.5)).toMatchObject({ phase: 'loading' })
    const pcts = [0.35, 0.5, 0.7, 0.95].map(f => bootStage(BOOT_MS * f)).map(s => (s?.phase === 'loading' ? s.pct : -1))
    expect(pcts).toEqual([...pcts].sort((x, y) => x - y))
    expect(pcts.at(-1)).toBe(100)
    expect(bootStage(BOOT_MS)).toBeUndefined()

    const clock = engineAll(on)
    const count = ticks(on)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('command.run', async () => ({}))
    await start($)
    // a pane drawn before the command shows no boot
    expect(linesOf(await draw($)).join('\n')).not.toContain('ONLINE')

    await $.command.run({
      command: 'jarvis',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 100 },
    })
    let text = linesOf(await draw($)).join('\n')
    expect(text).toContain('J.A.R.V.I.S. ONLINE')
    expect(text).not.toContain('LOADING')
    expect(text).not.toContain('子代理')

    const before = count.n
    await clock.advance(BOOT_MS * 0.6)
    expect(count.n - before).toBeGreaterThanOrEqual(3) // the boot animates with nothing running
    text = linesOf(await draw($)).join('\n')
    expect(text).toMatch(/LOADING CREW MANIFEST… +\d+%/)
    expect(text).toContain('█')
    for (const cols of [40, 50]) expect(Math.max(...rowWidths(await draw($, 30, cols)))).toBeLessThanOrEqual(cols)

    await clock.advance(BOOT_MS * 0.5)
    text = linesOf(await draw($)).join('\n')
    expect(text).not.toContain('ONLINE')
    expect(text).toContain('子代理')
    // played once: later draws stay on the page, and the idle tick stops
    const done = count.n
    await clock.advance(5000)
    expect(count.n).toBe(done)
    expect(linesOf(await draw($)).join('\n')).not.toContain('ONLINE')
  })

  test('target lost: a squad member whose latest call failed reads ⌖ TARGET LOST, then ↻ RELOCKED, then ACTIVE', async ($, on) => {
    // pure
    const e = (tool: string, ok: boolean, ts: number) => ev({ actor: 'w', isMain: false, tool, ok, ts, ms: 100 })
    expect(lockOf([], 'w', 0)).toBeUndefined()
    expect(lockOf([e('Bash', false, 0)], 'w', 0)).toBe('lost')
    expect(lockOf([e('Bash', false, 0)], 'other', 0)).toBeUndefined()
    expect(lockOf([e('Bash', false, 0), e('Bash', true, 1000)], 'w', 1100)).toBe('relocked')
    expect(lockOf([e('Bash', false, 0), e('Bash', true, 1000)], 'w', 1100 + RELOCK_MS)).toBeUndefined()
    // another tool working is no relock; the lost target is simply gone
    expect(lockOf([e('Bash', false, 0), e('Read', true, 1000)], 'w', 1100)).toBeUndefined()

    const clock = mock.clock(on, { now: 0 })
    spawner(on)
    let fail = false
    on('tool.call', async () => (fail ? { isError: true, result: 'x', text: 'x' } : { result: {} }) as never)
    await $.agent.spawn(spawnIn('hunt the bug', 'worker'))
    await clock.advance(INIT_MS)
    const row = async () => (await agentRows($, 40, 120))[0]?.parts ?? []

    fail = true
    await $.tool.call({ tool: 'Bash', command: 'go test', agentId: 'agent-1' } as never)
    let parts = await row()
    expect(rowText(parts)).toContain('⌖ TARGET LOST')
    expect(cellWidth('⌖')).toBe(1)
    expect(parts.find(p => /TARGET LOST/.test(p.t))?.props['color']).toBe(THEME.error)
    expect(parts[0]?.props['color']).toBe(THEME.error)

    fail = false
    await $.tool.call({ tool: 'Bash', command: 'go test', agentId: 'agent-1' } as never)
    parts = await row()
    expect(rowText(parts)).toContain('↻ RELOCKED')
    expect(rowText(parts)).not.toContain('TARGET LOST')
    expect(parts.find(p => /RELOCKED/.test(p.t))?.props['color']).toBe(THEME.bright)
    expect(parts[0]?.props['color']).toBe(jarvisColor(0))

    await clock.advance(RELOCK_MS)
    parts = await row()
    expect(rowText(parts)).toContain('⎸ACTIVE⎹')
    expect(rowText(parts)).not.toContain('RELOCKED')
  })

  test('elapsed reads like an altimeter: a bright readout with an ELAPSED label in the frame teal, the label dropped when narrow', async ($, on) => {
    expect(fmtReadout(0)).toBe('0:00')
    expect(fmtReadout(587_000)).toBe('9:47')
    expect(fmtReadout(3_725_000)).toBe('1:02:05')

    engineAll(on)
    await $.agent.spawn(spawnIn('long haul', 'worker'))
    await $.turn.complete(complete('agent-1', { durationMs: 587_000, usage: usage(HAIKU, 4000, 300, 0, 0) }))
    await $.agent.spawn(spawnIn('now', 'worker'))

    let rows = await agentRows($, 40, 120)
    const done = rows.find(r => rowText(r.parts).includes('long haul'))?.parts ?? []
    const at = done.findIndex(p => p.t.trim() === '9:47')
    expect(at).toBeGreaterThan(-1)
    expect(done[at + 1]?.t).toBe(' ELAPSED')
    const live = rows.find(r => rowText(r.parts).includes('now'))?.parts ?? []
    expect(live.find(p => p.t.trim() === '0:00')?.props['color']).toBe(THEME.bright)
    expect(live.find(p => p.t === ' ELAPSED')?.props['color']).toBe(THEME.frame)

    rows = await agentRows($, 40, 50)
    for (const r of rows) expect(rowText(r.parts)).not.toContain('ELAPSED')
    expect(rows.some(r => r.parts.some(p => p.t.trim() === '9:47'))).toBe(true)
  })

  test('the status, elapsed and tokens sit in one column flush right; the description stays left', async ($, on) => {
    const clock = engineAll(on)
    await $.agent.spawn(spawnIn('盤點 dotfiles agents 目錄的所有檔案', 'Explore'))
    await $.agent.spawn(spawnIn('short', 'clerk'))
    await $.agent.spawn(spawnIn('third', 'verifier'))
    await $.turn.complete(complete('agent-1', { durationMs: 631_000, usage: usage(HAIKU, 70_000, 10_000, 0, 0) }))
    await clock.advance(INIT_MS)
    for (const cols of [50, 64, 90, 120]) {
      const width = cols - 4 - 3
      const rows = (await agentRows($, 40, cols)).map(r => r.parts)
      expect(rows).toHaveLength(3)
      for (const parts of rows) expect(cellWidth(rowText(parts))).toBe(width)
      // the tokens close the row
      expect(rowText(rows[2] ?? []).endsWith(' 80k')).toBe(true)
      // the status words end at one column, whatever their length
      const statusEnd = rows.map(parts => {
        const i = parts.findIndex(p => /ACTIVE|COMPLETE|INIT/.test(p.t))
        return parts.slice(0, i).reduce((n, p) => n + cellWidth(p.t), 0) + cellWidth((parts[i]?.t ?? '').trimEnd())
      })
      expect(new Set(statusEnd).size).toBe(1)
      // the full labels wear a thin frame when there is room; short words when not
      const status = rows.map(parts => parts.find(p => /ACTIVE|COMPLETE|INIT/.test(p.t))?.t.trim())
      if (cols >= 120) expect(status).toEqual(['⎸ACTIVE⎹', '⎸ACTIVE⎹', '⎸MISSION COMPLETE⎹'])
      if (cols <= 50) expect(status).toEqual(['ACTIVE', 'ACTIVE', 'COMPLETE'])
    }
    for (const ch of ['⎸', '⎹']) expect(cellWidth(ch)).toBe(1)
  })

  test('narrow cards drop the badge, then the type, then tighten, then the tokens: the description keeps 8 cells', async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('summarize the release notes', 'Explore'))
    await $.turn.complete(complete('agent-1', { durationMs: 631_000, usage: usage(HAIKU, 4000, 300, 0, 0) }))
    await $.agent.spawn(spawnIn('index the whole repo', 'worker'))
    const shown = (parts: { t: string }[]) =>
      parts.map(p => p.t.trim()).find(t => /^(summarize|index)/.test(t)) ?? ''
    // wide: type and badge stay
    let rows = await agentRows($, 40, 120)
    expect(rows.every(r => r.parts.some(p => p.t.trim() === '[Haiku 5.5]'))).toBe(true)
    // 40 columns, a card still initializing: one cell of its sweep, tight brackets
    rows = await agentRows($, 40, 40)
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(cellWidth(rowText(r.parts))).toBe(40 - 4 - 3)
      expect(cellWidth(shown(r.parts))).toBeGreaterThanOrEqual(8)
      expect(r.parts.some(p => /^(worker|Explore|Haiku)\s*$/.test(p.t))).toBe(false)
    }
    expect(rows.map(r => r.parts[0]?.t)).toEqual(['⌜MK⌝', '⌞MK⌟'])
    const sweep = rows[0]?.parts[2]?.t ?? ''
    expect(cellWidth(sweep)).toBe(1)
    expect(SCAN.some(f => f.startsWith(sweep))).toBe(true)
  })

  test('at 40 columns a recovered mark stays whole as ↻ and no other row gains an ellipsis', async ($, on) => {
    mock.clock(on, { now: 0 })
    let fail = false
    on('tool.call', async () => (fail ? { isError: true, result: 'x', text: 'x' } : { result: {} }) as never)
    fail = true
    await $.tool.call({ tool: 'Bash', command: 'go test', description: 'try' })
    fail = false
    await $.tool.call({ tool: 'Bash', command: 'go test', description: 'again' })
    await $.tool.call({ tool: 'Read', file_path: '/a/ok.ts' })
    for (const tab of ['tab-now', 'tab-log']) {
      await press($, tab, 40, 40)
      const tree = await draw($, 40, 40)
      const marks = findAllText(tree, /^(↻|\[✓\]|\[✗\])\s*$/).map(n => textOf(n))
      expect(marks).toEqual(['↻  ', '[✓]', '[✓]'])
      expect(findAllText(tree, /RECOVERED/)).toHaveLength(0)
      const rows = linesOf(tree).filter(l => /ok\.ts|try|again/.test(l))
      expect(rows).toHaveLength(3)
      for (const r of rows) expect(r).not.toContain('…')
      expect(Math.max(...rowWidths(tree))).toBeLessThanOrEqual(40)
    }
  })

  test('a pane idle past SEEN_MS animates at once when it is drawn with a squad member running', async ($, on) => {
    const clock = engineAll(on)
    const count = ticks(on)
    await start($)
    await draw($)
    await clock.advance(SEEN_MS + 1000)
    await $.agent.spawn(spawnIn('late job', 'worker'))
    await draw($)
    const base = count.n
    await clock.advance(ANIM_MS * 3)
    expect(count.n - base).toBe(3)
  })

  test('a card is a Button only over its brackets: a pointer or the focus inverts them alone, never the row', async ($, on) => {
    engineAll(on)
    on('ui.focus', async () => ({}))
    await $.agent.spawn(spawnIn('first', 'worker'))
    await $.agent.spawn(spawnIn('second', 'worker'))
    await $.turn.complete(complete('agent-1'))

    await $.ui.focus({ component: 'Pane', requestId: 'jarvis', plugin: 'jarvis', element: 'agent-2', origin: { kind: 'person' } })
    const ui = await mountPane($, 40, 80)
    const buttons = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('agent-'))
    // the Button holds the brackets and nothing else: what the engine inverts under the
    // pointer or the focus ring is that one chip, so the row never stripes
    expect(buttons.map(b => [b.key, b.props['hotkey'], b.props['plain'], b.text])).toEqual([
      ['agent-2', '2', true, '⌜ MK ⌝'],
      ['agent-1', '1', true, '⌞ MK ⌟'],
    ])
    // nothing is recolored for the focus any more: no backgrounds, no lock-on arrows
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.some(t => 'backgroundColor' in (t.props ?? {}))).toBe(false)
    expect(texts.some(t => /[►◄]/.test(t.text ?? ''))).toBe(false)
    await ui.unmount()
    // the rest of each card sits beside its Button in the row
    const rows = await agentRows($, 40, 80)
    expect(rows.find(r => r.key === 'agent-1')?.text).toContain('first')
    expect(rows.find(r => r.key === 'agent-2')?.text).toContain('second')
    expect(rows.map(r => cellWidth(rowText(r.parts)))).toEqual([80 - 4 - 3, 80 - 4 - 3])
  })
})

describe('live check 3', () => {
  // the actor an event row about `file` names
  const actorOf = (tree: Node, file: string): string =>
    /MK-\d+|主線/.exec(linesOf(tree).find(l => l.includes(file) && !l.startsWith('進行中')) ?? '')?.[0] ?? ''

  test('MK numbers follow dispatch order and never change: rows, events and the detail page agree', async ($, on) => {
    const clock = engineAll(on)
    await $.agent.spawn(spawnIn('alpha', 'worker'))
    await clock.advance(INIT_MS)
    await $.tool.call({ tool: 'Read', file_path: '/a/one.ts', agentId: 'agent-1' } as never)
    expect(actorOf(await draw($, 40, 100), 'one.ts')).toBe('MK-1')

    // a second one: the first keeps MK-1, its past events too
    await $.agent.spawn(spawnIn('beta', 'worker'))
    await $.tool.call({ tool: 'Read', file_path: '/b/two.ts', agentId: 'agent-2' } as never)
    const check = async () => {
      const tree = await draw($, 40, 100)
      expect(actorOf(tree, 'one.ts')).toBe('MK-1')
      expect(actorOf(tree, 'two.ts')).toBe('MK-2')
      expect(findAllText(tree, /^MK-1\s*$/).every(n => n.props?.color === jarvisColor(0))).toBe(true)
      const rows = await agentRows($, 40, 100)
      const alpha = rows.find(r => r.text.includes('alpha'))
      const beta = rows.find(r => r.text.includes('beta'))
      expect([alpha?.key, alpha?.hotkey]).toEqual(['agent-1', '1'])
      expect([beta?.key, beta?.hotkey]).toEqual(['agent-2', '2'])
    }
    await check()

    // the first finishes and drops below the running one: nothing renumbers
    await $.turn.complete(complete('agent-1'))
    await check()
    await hotkey($, '1', 40, 100)
    let tree = await draw($, 40, 100)
    expect(findText(tree, /^⌞ MK-1 ⌟ $/)).toBeDefined()
    expect(linesOf(tree).join('\n')).toContain('alpha')
    await press($, 'tab-now', 40, 100)

    // a third finishes before the second; then the first is resumed and runs again
    await $.agent.spawn(spawnIn('gamma', 'worker'))
    await $.tool.call({ tool: 'Read', file_path: '/c/three.ts', agentId: 'agent-3' } as never)
    await $.turn.complete(complete('agent-3'))
    await check()
    await $.tool.call({ tool: 'Read', file_path: '/a/again.ts', agentId: 'agent-1' } as never)
    await $.turn.complete(complete('agent-2'))
    await check()
    tree = await draw($, 40, 100)
    expect(actorOf(tree, 'three.ts')).toBe('MK-3')
    expect(actorOf(tree, 'again.ts')).toBe('MK-1')
    await hotkey($, '2', 40, 100)
    expect(findText(await draw($, 40, 100), /^⌞ MK-2 ⌟ $/)).toBeDefined()
  })

  test('roster: the number is the dispatch order, whatever the list order; the hotkey is that number', () => {
    let list = addAgent([], { id: 'a', type: 'worker', description: 'd', model: SONNET, now: 0 })
    list = addAgent(list, { id: 'b', type: 'worker', description: 'd', model: SONNET, now: 0 })
    const before = rosterOf(list, agentSections(list)).get('a')
    list = finishTurn(list, 'a', { reason: 'answer', durationMs: 1 }, 5)
    const roster = rosterOf(list, agentSections(list))
    expect(roster.get('a')).toEqual(before)
    expect(roster.get('a')?.n).toBe(1)
    expect(roster.get('b')?.n).toBe(2)
  })

  const ALLOWED = new Set<string>([
    ...Object.values(THEME),
    ...JARVIS_PALETTE,
    ...Object.values(FAMILY_COLOR),
    ...Object.values(ROLE_COLOR),
    ...GAUGE_RAMP,
    ...BURN_RAMP,
  ])
  // what may wear the dark blue: marks, tree lines, separators, rules, empty bar cells, the
  // unlit ring and chain cells
  const DECOR = /^\s*(?:[✓?]|[├└]─|·|[░─]+|── |⣿|[▀▄█]+|▱+)\s*$/

  // every drawn Text that shows something, as `text color`, where it is off the theme, dim,
  // dark blue without being a decoration, or sets a mark against a character; and any
  // Button that draws a label of its own
  // (one string child becomes its label: the engine's colors) or dims it
  const offTheme = (n: Node | string, out: string[] = [], inButton = false): string[] => {
    if (typeof n === 'string') {
      if (inButton && n.trim() !== '') out.push(`bare ${JSON.stringify(n)}`)
      return out
    }
    if (n.type === 'Button' && ((n.children ?? []).length === 0 || n.props?.['dimColor'] !== undefined)) {
      out.push(`button ${JSON.stringify(n.props?.['label'])}${n.props?.['dimColor'] ? ' dim' : ''}`)
    }
    if (n.type === 'Text') {
      const text = textOf(n)
      const color = n.props?.color
      if (text.trim() === '') return out
      // a ●, ✓ or ✗ is never set against what follows: a fallback font leaves a gap after it
      if (/[●✓✗][^\s\]]/.test(text)) out.push(`${JSON.stringify(text)} glued mark`)
      if (typeof color !== 'string' || !ALLOWED.has(color) || n.props?.dimColor !== undefined) {
        out.push(`${JSON.stringify(text)} ${String(color)}${n.props?.dimColor ? ' dim' : ''}`)
      } else if (color === THEME.muted && !DECOR.test(text)) {
        out.push(`${JSON.stringify(text)} muted text`)
      }
      return out
    }
    for (const k of n.children ?? []) offTheme(k, out, inButton || n.type === 'Button')
    return out
  }

  test('empty pages: every text the mod draws wears a theme color, none dim', async ($, on) => {
    engineAll(on)
    for (const cols of [40, 64, 80, 120]) {
      for (const tab of ['tab-now', 'tab-log', 'tab-stats']) {
        await press($, tab, 40, cols)
        const tree = await draw($, 40, cols)
        expect([cols, tab, offTheme(tree)]).toEqual([cols, tab, []])
      }
    }
  })

  test('busy pages: every text the mod draws wears a theme, squad or model color; dark blue only on decorations', async ($, on) => {
    const day1 = new Date(2026, 9, 10, 22, 0, 0).getTime()
    const clock = mock.clock(on, { now: day1 })
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
    const models = [HAIKU, 'mystery-model', HAIKU, SONNET]
    let spawned = 0
    on('agent.spawn', async () => {
      spawned += 1
      return { model: models[spawned - 1] ?? HAIKU, agentId: `agent-${spawned}` }
    })
    const gates: Array<() => void> = []
    let hold = false
    let fail = false
    on('tool.call', async () => {
      if (hold) await new Promise<void>(r => gates.push(r))
      return (fail ? { isError: true, result: 'x', text: 'x' } : { result: {} }) as never
    })
    await start($)
    await $.agent.spawn(spawnIn('scan the repo', 'Explore'))
    await $.tool.call({ tool: 'Read', file_path: '/a/one.ts', agentId: 'agent-1' } as never)
    await $.agent.spawn(spawnIn('odd job', 'general-purpose'))
    await $.agent.spawn(spawnIn('review a', 'general-purpose', { runId: WF, agentIndex: 1 }))
    await $.agent.spawn(spawnIn('break it', 'worker'))
    await $.turn.complete(complete('agent-4', { reason: 'aborted', isAborted: true }))
    await $.turn.complete(complete('agent-1', { durationMs: 631_000, usage: usage(HAIKU, 70_000, 10_000, 3000, 0) }))
    fail = true
    await $.tool.call({ tool: 'Bash', command: 'go test', description: 'first try' })
    fail = false
    await $.tool.call({ tool: 'Bash', command: 'go test', description: 'second try' })
    await clock.advance(2 * 60 * MIN)
    await $.tool.call({ tool: 'Grep', pattern: 'needle', agentId: 'agent-2' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/c/main.ts' })
    hold = true
    const calls = [
      $.tool.call({ tool: 'Bash', command: 'make', description: 'build it' }),
      $.tool.call({ tool: 'Grep', pattern: 'hay', agentId: 'agent-2' } as never),
    ]
    while (gates.length < 2) await clock.advance(0)
    await clock.advance(42_000)

    const scan = async () => {
      for (const cols of [40, 64, 80, 120]) {
        for (const tab of ['tab-now', 'tab-log', 'tab-stats']) {
          await press($, tab, 40, cols)
          const tree = await draw($, 40, cols)
          expect([cols, tab, offTheme(tree)]).toEqual([cols, tab, []])
          expect(Math.max(...rowWidths(tree))).toBeLessThanOrEqual(cols)
        }
        for (const digit of ['1', '2', '3']) {
          await press($, 'tab-now', 40, cols)
          await hotkey($, digit, 40, cols)
          const tree = await draw($, 40, cols)
          expect([cols, digit, offTheme(tree)]).toEqual([cols, digit, []])
          expect(Math.max(...rowWidths(tree))).toBeLessThanOrEqual(cols)
          await press($, 'tab-now', 40, cols)
        }
      }
    }
    await scan()

    // the calls return; the running ones go quiet and are lost
    gates.splice(0).forEach(r => r())
    hold = false
    await Promise.all(calls)
    await clock.advance(STALE_MS + 2000)
    expect(linesOf(await draw($, 40, 80)).join('\n')).toContain('失聯')
    await scan()
  })

  test('a finished card reads in the frame teal, brackets too, only its ✓ dark blue; failed stays red', async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('wire the hud', 'worker'))
    await $.turn.complete(complete('agent-1', { durationMs: 7000, usage: usage(HAIKU, 4000, 300, 0, 0) }))
    await $.agent.spawn(spawnIn('break it', 'worker'))
    await $.turn.complete(complete('agent-2', { reason: 'aborted', isAborted: true }))
    await $.agent.spawn(spawnIn('still going', 'worker'))

    const shown = (parts: { t: string; props: Record<string, unknown> }[]) => parts.filter(p => p.t.trim() !== '')
    for (const cols of [64, 80, 120]) {
      const rows = await agentRows($, 40, cols)
      const done = shown(rows.find(r => r.key === 'agent-1')?.parts ?? [])
      const failed = shown(rows.find(r => r.key === 'agent-2')?.parts ?? [])
      const live = shown(rows.find(r => r.key === 'agent-3')?.parts ?? [])
      expect(done.length).toBeGreaterThan(4)
      for (const p of done) {
        const want = p.t.trim() === '✓' ? THEME.muted : THEME.frame
        expect([p.t, p.props['color']]).toEqual([p.t, want])
      }
      for (const p of failed) {
        const want = /✗|FAILED/.test(p.t) ? THEME.error : THEME.frame
        expect([p.t, p.props['color']]).toEqual([p.t, want])
      }
      if (cols >= 120) {
        expect(done.find(p => p.t === ' ELAPSED')?.props['color']).toBe(THEME.frame)
        expect(live.find(p => p.t === ' ELAPSED')?.props['color']).toBe(THEME.frame)
      }
    }

  })
})

describe('stats dashboard', () => {
  // the rows the pane takes: a box of a set height takes it, a row the tallest of its
  // children, a column their sum, a line one
  const paneRows = (n: Node | string): number => {
    if (typeof n === 'string' || n.type === 'Text') return 1
    const h = Number(n.props?.['height'])
    if (Number.isFinite(h) && h > 0) return h
    const kids = (n.children ?? []).map(paneRows)
    if (kids.length === 0) return 0
    return n.props?.flexDirection === 'row' ? Math.max(...kids) : kids.reduce((a, b) => a + b, 0)
  }

  const callMain = async ($: Engine, n: number) => {
    for (let i = 0; i < n; i += 1) await $.tool.call({ tool: 'Read', file_path: `/a/f${i}.ts` })
  }

  test('the main card: the rate in big digits beside OK and FAIL, the chain in segments, the last call', async ($, on) => {
    engine(on)
    await callMain($, 3)
    await press($, 'tab-stats')
    const tree = await draw($, 40, 120)
    const text = linesOf(tree).join('\n')
    expect(text).toMatch(/OK 3/)
    expect(text).toMatch(/FAIL 0/)
    expect(text).toMatch(/SUCCESS RATE/)
    expect(text).toMatch(/CHAIN [▰▱]{4} \d\/4/)
    expect(text).toMatch(/LAST \S+/)
    // the rate drawn in half blocks: three rows, one color
    const digits = findAllText(mainCard(tree), /[▀▄█]/)
    expect(digits.length).toBeGreaterThan(0)
    for (const t of digits) expect(t.props?.color).toBe(THEME.primary)
  })
  test('the main card: a failure rate of 10% or more turns the digits red, at every width', async ($, on) => {
    mock.clock(on, { now: 0 })
    let fail = false
    on('tool.call', async () => (fail ? { isError: true, result: 'x', text: 'x' } : { result: {} }) as never)
    for (let i = 0; i < 2; i += 1) await $.tool.call({ tool: 'Read', file_path: `/a/f${i}.ts` })
    fail = true
    await $.tool.call({ tool: 'Bash', command: 'go test' })
    await press($, 'tab-stats')
    for (const cols of [120, 80, 50]) {
      const tree = await draw($, 40, cols)
      const digits = findAllText(mainCard(tree), /[▀▄█]/)
      expect([cols, digits.length > 0]).toEqual([cols, true])
      for (const t of digits) expect([cols, t.props?.color]).toEqual([cols, THEME.error])
    }
  })
  test('dispatch: a row a role, an amber ◆ while it runs, a gradient bar, the done count, ▶ running', async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('a', 'worker'))
    await $.agent.spawn(spawnIn('b', 'verifier'))
    await $.turn.complete(complete('agent-2'))
    await press($, 'tab-stats')
    const tree = await draw($, 40, 120)
    const lines = linesOf(tree)
    expect(lines.find(l => /◆ worker/.test(l))).toMatch(/ 0 +▶1/)
    expect(lines.find(l => /◇ verifier/.test(l))).toMatch(/█+.* 1/)
    const dispatch = (tree.children ?? []).find(k => typeof k !== 'string' && findText(k, /^DISPATCH$/)) as Node
    for (const t of findAllText(dispatch, /^[█▏▎▍▌▋▊▉]+$/)) {
      expect([...BURN_RAMP, ...Object.values(FAMILY_COLOR), ...GAUGE_RAMP, THEME.error]).toContain(t.props?.color)
    }
  })

  test('dispatch: bars scale to the busiest role and burn along BURN_RAMP to its end', async ($, on) => {
    engineAll(on)
    for (const [i, t] of ['worker', 'worker', 'verifier'].entries()) {
      await $.agent.spawn(spawnIn(`job ${i}`, t))
      await $.turn.complete(complete(`agent-${i + 1}`))
    }
    await press($, 'tab-stats')
    const tree = await draw($, 40, 120)
    const dispatch = (tree.children ?? []).find(k => typeof k !== 'string' && findText(k, /^DISPATCH$/)) as Node
    const card = (dispatch.children ?? [])[0] as Node
    const lines = (card.children ?? []).map(k => (typeof k === 'string' ? k : textOf(k)))
    const fill = (l: string | undefined) => (l?.match(/[█▏▎▍▌▋▊▉]/g) ?? []).length
    const worker = lines.find(l => /^◇ worker/.test(l))
    const verifier = lines.find(l => /^◇ verifier/.test(l))
    expect(fill(verifier)).toBeGreaterThan(0)
    expect(Math.abs(fill(worker) - 2 * fill(verifier))).toBeLessThanOrEqual(1)
    const colors = findAllText(dispatch, /^[█▏▎▍▌▋▊▉]+$/).map(t => t.props?.color)
    expect(colors).toContain(BURN_RAMP.at(-1))
  })

  test('dispatch: a role\'s last hour as a braille line when the card is wide enough, none when narrow', async ($, on) => {
    engineAll(on)
    await $.agent.spawn(spawnIn('a', 'worker'))
    await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'agent-1' } as never)
    await press($, 'tab-stats')
    const row = async (cols: number) => linesOf(await draw($, 40, cols)).find(l => /◆ worker/.test(l)) ?? ''
    expect(await row(120)).toMatch(/[⠁-⣿]/)
    expect(await row(50)).not.toMatch(/[⠀-⣿]/)
  })

  test('models: one stacked bar in each family\'s color over its share and count', async ($, on) => {
    mock.clock(on, { now: 0 })
    let n = 0
    const models = ['claude-opus-5-5', 'claude-sonnet-5-5']
    on('agent.spawn', async () => ({ model: models[n] ?? HAIKU, agentId: `agent-${(n += 1)}` }))
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    await $.agent.spawn(spawnIn('big', 'fork'))
    await $.agent.spawn(spawnIn('small', 'worker'))
    await $.turn.complete(complete('agent-1', { usage: usage('claude-opus-5-5', 100_000, 10_000, 0, 0) }))
    await $.turn.complete(complete('agent-2', { usage: usage('claude-sonnet-5-5', 100_000, 10_000, 0, 0) }))
    await press($, 'tab-stats')
    const tree = await draw($, 40, 120)
    const bar = findAllText(cardOf(tree, /^MODELS$/), /[█]/).map(t => t.props?.color)
    expect(bar).toContain(FAMILY_COLOR.opus)
    expect(bar).toContain(FAMILY_COLOR.sonnet)
    expect(modelCard(tree).rows.some(r => /Opus\s+\d+%\s+×1/.test(r))).toBe(true)
  })
  test('the model bar fills the card\'s inside exactly, an unpriced model\'s 未計價 and its ×N kept whole', async ($, on) => {
    mock.clock(on, { now: 0 })
    const plan = ['claude-opus-5-5', 'claude-sonnet-5-5', HAIKU, 'mystery-model']
    let n = 0
    on('agent.spawn', async () => ({ model: plan[n] ?? HAIKU, agentId: `agent-${(n += 1)}` }))
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    for (const [i, model] of plan.entries()) {
      await $.agent.spawn(spawnIn(`job ${i}`, 'worker'))
      await $.turn.complete(complete(`agent-${i + 1}`, { usage: usage(model, 10_000, 1000, 0, 0) }))
    }
    await press($, 'tab-stats')
    for (const [cols, rows] of [[40, 60], [44, 60], [64, 20]] as const) {
      const { rows: lines, inner } = modelCard(await draw($, rows, cols))
      expect([cols, lines[1] ?? '']).toEqual([cols, '█'.repeat(inner)])
      const named = lines.filter(l => /^(Opus|Sonnet|Haiku|其他)/.test(l))
      expect([cols, named.length]).toEqual([cols, 4])
      for (const l of named) expect([cols, l, cellWidth(l) <= inner]).toEqual([cols, l, true])
      for (const l of named) expect(l).toMatch(/ ×1$/)
      expect(named.find(l => l.startsWith('其他'))).toMatch(/ 未計價 ×1$/)
    }
  })
  test('short of rows: the roles are cut with … 還有 N 種; never past the pane', async ($, on) => {
    engineAll(on)
    await press($, 'tab-stats')
    for (const [rows, cols] of [[20, 80], [16, 120], [14, 50], [30, 64]] as const) {
      const tree = await draw($, rows, cols)
      expect(linesOf(tree).length).toBeLessThanOrEqual(rows)
      expect(Math.max(...rowWidths(tree))).toBeLessThanOrEqual(cols)
    }
    // two rows for the roles: one role, then the count of the rest (one row is the summary line)
    expect(linesOf(await draw($, 21, 80)).some(l => /… 還有 \d+ 種/.test(l))).toBe(true)
  })

  test('room for one dispatch row only: a summary of every role, ▶ for those running, not … 還有 N 種', async ($, on) => {
    mock.clock(on, { now: 0 })
    // four models: the model card leaves the dispatch card one row at 65×20 and 44×18
    const plan = ['claude-opus-5-5', 'claude-sonnet-5-5', HAIKU, 'mystery-model']
    let n = 0
    on('agent.spawn', async () => ({ model: plan[n % plan.length] ?? HAIKU, agentId: `agent-${(n += 1)}` }))
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    const types = ['Explore', 'clerk', 'worker', 'verifier', 'fork', 'Plan']
    for (const [i, t] of types.entries()) await $.agent.spawn(spawnIn(`job ${i + 1}`, t))
    for (const [i, model] of plan.entries()) {
      await $.turn.complete(complete(`agent-${i + 1}`, { usage: usage(model, 10_000, 1000, 0, 0) }))
    }
    await press($, 'tab-stats')
    for (const [rows, cols] of [[20, 65], [18, 44]] as const) {
      const tree = await draw($, rows, cols)
      const dispatch = (tree.children ?? []).find(k => typeof k !== 'string' && findText(k, /^DISPATCH$/)) as Node
      const card = (dispatch.children ?? [])[0] as Node
      const lines = (card.children ?? []).map(k => (typeof k === 'string' ? k : textOf(k)))
      expect([cols, lines.length]).toEqual([cols, 2])
      expect(lines.join('\n')).not.toMatch(/還有/)
      expect(lines[1]).toMatch(/^Explore 1 · clerk 1 · worker 1 · /)
      expect(cellWidth(lines[1] ?? '')).toBeLessThanOrEqual(cols - 4)
      for (const t of findAllText(card, /\S/).slice(1)) expect([THEME.frame, THEME.accent]).toContain(t.props?.color)
      if (cols === 65) {
        expect(lines[1]).toMatch(/verifier 1 · fork ▶1 · /)
        expect(findText(card, /^▶1$/)?.props?.color).toBe(THEME.accent)
      }
    }
  })

  test('busy stats at 40, 65 and 100 columns, short to tall: never past the width; from 24 rows (25 when narrow, the readouts under the digits), never past the rows', async ($, on) => {
    mock.clock(on, { now: 0 })
    const plan = ['claude-opus-5-5', 'claude-sonnet-5-5', HAIKU, 'mystery-model']
    let n = 0
    on('agent.spawn', async () => ({ model: plan[n % plan.length] ?? HAIKU, agentId: `agent-${(n += 1)}` }))
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    on('tool.call', async () => ({ result: {} }) as never)
    const types = ['Explore', 'clerk', 'worker', 'verifier', 'fork', 'Plan']
    for (const [i, t] of types.entries()) await $.agent.spawn(spawnIn(`job ${i}`, t))
    for (const [i, model] of plan.entries()) {
      await $.turn.complete(complete(`agent-${i + 1}`, { usage: usage(model, 10_000, 1000, 0, 0) }))
    }
    await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'agent-5' } as never)
    await press($, 'tab-stats')
    for (const cols of [40, 65, 100]) {
      for (const rows of [12, 16, 20, 24, 25, 30, 40]) {
        const tree = await draw($, rows, cols)
        expect([cols, rows, Math.max(...rowWidths(tree))]).toEqual([cols, rows, Math.min(cols, Math.max(...rowWidths(tree)))])
        if (rows >= (cols < 64 ? 25 : 24)) expect([cols, rows, paneRows(tree) <= rows]).toEqual([cols, rows, true])
      }
    }
  })
})

describe('stats HUD', () => {
  // spawns one agent per `[type, model]`, each completed with that model's usage
  const fleetOf = async ($: Engine, on: On, crew: readonly (readonly [string, string])[]) => {
    mock.clock(on, { now: 0 })
    let n = 0
    on('agent.spawn', async () => ({ model: crew[n]?.[1] ?? HAIKU, agentId: `agent-${(n += 1)}` }))
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    on('tool.call', async () => ({ result: {} }) as never)
    for (const [i, [type, model]] of crew.entries()) {
      await $.agent.spawn(spawnIn(`job ${i}`, type))
      await $.turn.complete(complete(`agent-${i + 1}`, { usage: usage(model, 10_000, 1000, 0, 0) }))
    }
  }

  test('main line: the rate in big digits, OK/FAIL, CHAIN, TOP and LAST beside', async ($, on) => {
    engine(on)
    await start($)
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
    await press($, 'tab-stats', 40, 80)
    const tree = await draw($, 40, 80)
    const text = linesOf(tree).join('\n')
    expect(text).toContain('OK 4')
    expect(text).toContain('SUCCESS RATE')
    expect(text).toMatch(/TOP Bash 3 · Read 1/)
    expect(text).toMatch(/LAST Read/)
    expect(text).not.toMatch(/SUCCESS 100%/)
    // the digits sit left of the readouts, one row each
    const rows = (mainCard(tree).children ?? []).map(textOf)
    expect(rows.find(r => r.includes('OK 4'))).toMatch(/^[▀▄█ ]+ {2}OK 4/)
    expect(rows.find(r => r.includes('FAIL 0'))).toMatch(/^[▀▄█ ]+ {2}FAIL 0/)
    expect(rows.find(r => r.includes('SUCCESS RATE'))).toMatch(/^[▀▄█ ]+ {2}SUCCESS RATE/)
  })

  test('main line, narrow: the readouts under the digits', async ($, on) => {
    engine(on)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await press($, 'tab-stats', 40, 50)
    const rows = (mainCard(await draw($, 40, 50)).children ?? []).map(textOf)
    const digitRows = rows.map((r, i) => (/[▀▄█]/.test(r) ? i : -1)).filter(i => i >= 0)
    expect(digitRows).toEqual([1, 2, 3])
    expect(rows[4]).toMatch(/^OK 1 +CHAIN/)
    expect(rows[5]).toMatch(/^FAIL 0 +TOP Bash 1/)
    expect(rows[6]).toMatch(/^SUCCESS RATE {2}LAST Bash/)
  })

  test('no ring is drawn on the stats page; the model mix is one stacked bar', async ($, on) => {
    await fleetOf($, on, [
      ['fork', 'claude-opus-5-5'],
      ['fork', 'claude-opus-5-5'],
      ['worker', SONNET],
    ])
    await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
    await press($, 'tab-stats')
    for (const cols of [120, 80, 50]) {
      const tree = await draw($, 40, cols)
      const { rows, inner } = modelCard(tree)
      expect([cols, rows[1]]).toEqual([cols, '█'.repeat(inner)])
      const models = cardOf(tree, /^MODELS$/)
      const barColors = findAllText(models, /█/).map(t => t.props?.color)
      expect([cols, [...new Set(barColors)].sort()]).toEqual([cols, [FAMILY_COLOR.opus, FAMILY_COLOR.sonnet].sort()])
      // the bar is the model card's only blocks: no ring beside the model lines
      expect([cols, rows.slice(2).filter(r => /[▀▄█]/.test(r))]).toEqual([cols, []])
      // the main card's blocks are the digits alone: three rows of one color, no ring track
      const main = (mainCard(tree).children ?? []).map(textOf)
      expect([cols, main.filter(r => /[▀▄█]/.test(r)).length]).toEqual([cols, BIG_ROWS])
      for (const t of findAllText(mainCard(tree), /[▀▄█]/)) expect([cols, t.props?.color]).toEqual([cols, THEME.primary])
    }
  })

  test('dispatch rows name each role\'s model, + when mixed', async ($, on) => {
    await fleetOf($, on, [
      ['verifier', SONNET],
      ['verifier', SONNET],
      ['verifier', 'claude-opus-5-5'],
      ['worker', 'claude-opus-5-5'],
    ])
    await press($, 'tab-stats')
    for (const cols of [120, 80, 50]) {
      const tree = await draw($, 40, cols)
      const dispatch = cardOf(tree, /^DISPATCH$/)
      const rows = (dispatch.children ?? []).map(textOf)
      expect([cols, rows.find(r => /^◇ verifier/.test(r))]).toEqual([cols, expect.stringMatching(/^◇ verifier\s+Sonnet\+ /)])
      const worker = rows.find(r => /^◇ worker/.test(r)) ?? ''
      expect([cols, worker]).toEqual([cols, expect.stringMatching(/^◇ worker\s+Opus /)])
      expect(worker).not.toContain('+')
      expect(findText(dispatch, /^Sonnet\+\s*$/)?.props?.color).toBe(FAMILY_COLOR.sonnet)
      expect(findText(dispatch, /^Opus\s*$/)?.props?.color).toBe(FAMILY_COLOR.opus)
      // a role nobody ran keeps the column blank, the bars still aligned
      const explore = rows.find(r => /^◇ Explore/.test(r)) ?? ''
      expect([cols, explore.indexOf('█') === -1 || explore.search(/[█▏▎▍▌▋▊▉░]/) === worker.search(/[█▏▎▍▌▋▊▉░]/)]).toEqual([cols, true])
      for (const r of rows) expect([cols, r, cellWidth(r) <= cols - 4]).toEqual([cols, r, true])
    }
  })

  test('dispatch without any subagent leaves the model column out', async ($, on) => {
    engineAll(on)
    await press($, 'tab-stats')
    const rows = (cardOf(await draw($, 40, 120), /^DISPATCH$/).children ?? []).map(textOf)
    const worker = rows.find(r => /^◇ worker/.test(r)) ?? ''
    expect(worker).not.toMatch(/Opus|Sonnet|Haiku|Fable/)
    // the bar right after the name column and one blank: no empty model column between
    const nameW = Math.max(4, ...rows.slice(1).map(r => cellWidth(r.split(' ')[1] ?? '')))
    expect(worker.search(/[█▏▎▍▌▋▊▉░]/)).toBe(2 + nameW + 1)
  })

  test('long and missing main tools stay inside the card', async ($, on) => {
    engine(on)
    await start($)
    await press($, 'tab-stats', 40, 64)
    const text = linesOf(await draw($, 40, 64)).join('\n')
    expect(text).toMatch(/TOP --/)
    expect(text).toMatch(/LAST --/)
    await $.tool.call({ tool: 'mcp__memory__memory_store', input: {} } as never)
    for (const cols of [40, 64, 100]) {
      await press($, 'tab-stats', 40, cols)
      const tree = await draw($, 40, cols)
      expect([cols, Math.max(...rowWidths(tree))]).toEqual([cols, Math.min(cols, Math.max(...rowWidths(tree)))])
      const main = mainCard(tree)
      const inner = Number(main.props?.width ?? 0) - 4
      for (const r of (main.children ?? []).map(textOf)) expect([cols, r, cellWidth(r) <= inner]).toEqual([cols, r, true])
      expect([cols, (main.children ?? []).map(textOf).some(r => /TOP mcp__/.test(r))]).toEqual([cols, true])
    }
  })

  test('a high failure rate turns the digits red', async ($, on) => {
    mock.clock(on, { now: 0 })
    let fail = false
    on('tool.call', async () => (fail ? { isError: true, result: 'x', text: 'x' } : { result: {} }) as never)
    for (let i = 0; i < 9; i += 1) await $.tool.call({ tool: 'Read', file_path: `/a/f${i}.ts` })
    await press($, 'tab-stats')
    const colors = async () => [...new Set(findAllText(mainCard(await draw($, 40, 80)), /[▀▄█]/).map(t => t.props?.color))]
    expect(await colors()).toEqual([THEME.primary])
    // one failure in ten: FAIL_WARN reached
    fail = true
    await $.tool.call({ tool: 'Bash', command: 'go test' })
    expect(await colors()).toEqual([THEME.error])
    expect(linesOf(await draw($, 40, 80)).join('\n')).toMatch(/FAIL 1/)
  })
})

describe('standby suit', () => {
  const STANDBY = 'MARK XLII · STANDBY'
  const lineOf = (lines: string[], text: string) => lines.findIndex(l => l.includes(text))

  test('nothing ever dispatched: the suit over the subagent card, awaiting orders', async ($, on) => {
    engine(on, 'agent-1')
    const tree = await draw($, 50)
    const lines = linesOf(tree)
    expect(lineOf(lines, STANDBY)).toBeGreaterThan(0)
    expect(lineOf(lines, 'AWAITING ORDERS, SIR.')).toBe(lineOf(lines, STANDBY) + 1)
    expect(lines.join('\n')).not.toContain('ALL CREW DOCKED')
    // 14 rows of art, a blank row, then the text; the subagent card below
    const art = lines.slice(lineOf(lines, STANDBY) - SUIT_ROWS - 1, lineOf(lines, STANDBY) - 1)
    expect(art.every(l => /[▀▄]/.test(l))).toBe(true)
    expect(lines[lineOf(lines, STANDBY) - 1]?.trim()).toBe('')
    expect(lineOf(lines, '子代理')).toBeGreaterThan(lineOf(lines, 'AWAITING ORDERS'))
    expect(lines.join('\n')).toContain('還沒有派工')
    // centered in the 80 cells: the helmet's top 12 pixels wide, its sides 16 wide
    const flat = (n: Node | string): string[] =>
      typeof n === 'string' || n.type === 'Text' || n.props?.flexDirection === 'row'
        ? [textOf(n)]
        : (n.children ?? []).flatMap(flat)
    const rowsDrawn = flat(tree)
    const top = rowsDrawn[rowsDrawn.findIndex(l => l.includes(STANDBY)) - SUIT_ROWS - 1] ?? ''
    expect(top.length - top.trimStart().length).toBe(Math.floor((80 - 24) / 2) + 4)
    expect(cellWidth(top)).toBe(80)
    expect(findText(tree, /^MARK XLII · STANDBY$/)?.props?.['color']).toBe(THEME.frame)
    expect(findText(tree, /^AWAITING ORDERS, SIR\.$/)?.props?.['color']).toBe(THEME.primary)
  })

  test('crew docked after a dispatch; none while a subagent runs', async ($, on) => {
    engine(on, 'agent-1')
    await $.agent.spawn(spawnInput({ description: 'find files', subagentType: 'Explore' }))
    let text = linesOf(await draw($, 50)).join('\n')
    expect(text).not.toContain(STANDBY)
    expect(text).toContain('find files')

    await $.turn.complete(complete('agent-1'))
    const tree = await draw($, 50)
    const lines = linesOf(tree)
    expect(lineOf(lines, 'ALL CREW DOCKED, SIR.')).toBe(lineOf(lines, STANDBY) + 1)
    expect(lines.join('\n')).not.toContain('AWAITING ORDERS')
    expect(lineOf(lines, 'find files')).toBeGreaterThan(lineOf(lines, STANDBY))
    expect(findText(tree, /^ALL CREW DOCKED, SIR\.$/)?.props?.['color']).toBe(THEME.primary)
    // the number key still opens it
    await hotkey($, '1', 50)
    text = linesOf(await draw($, 50)).join('\n')
    expect(text).toContain('類型')
    expect(text).not.toContain(STANDBY)
  })

  test('short of rows for three rows of the subagent card the suit is left out', async ($, on) => {
    engine(on, 'agent-1')
    // title, tabs, in-flight card 4, recent events 4, the subagent card's border and title 3
    expect(linesOf(await draw($, 2 + 4 + 4 + 3 + 3 + SUIT_BLOCK_ROWS)).join('\n')).toContain(STANDBY)
    const text = linesOf(await draw($, 2 + 4 + 4 + 3 + 3 + SUIT_BLOCK_ROWS - 1)).join('\n')
    expect(text).not.toContain(STANDBY)
    expect(text).toContain('還沒有派工')
    expect(text).toContain('最近事件')
  })

  // rows the pane draws: a card its own height, a row its tallest, a column the sum
  const paneRows = (n: Node | string): number => {
    if (typeof n === 'string' || n.type === 'Text') return 1
    const h = Number(n.props?.['height'])
    if (Number.isFinite(h) && h > 0) return h
    const kids = (n.children ?? []).map(paneRows)
    if (kids.length === 0) return 0
    return n.props?.flexDirection === 'row' ? Math.max(...kids) : kids.reduce((a, b) => a + b, 0)
  }

  for (const events of [0, 5]) {
    test(`more finished than the list keeps (${events} events): the suit only when the whole page fits`, async ($, on) => {
      engineAll(on)
      for (let i = 1; i <= 4; i += 1) await $.agent.spawn(spawnIn(`job ${i}`, 'worker'))
      for (let i = 1; i <= 4; i += 1) await $.turn.complete(complete(`agent-${i}`))
      for (let i = 0; i < events; i += 1) await $.tool.call({ tool: 'Read', file_path: `/f/e${i}.ts` })
      // title, tabs, in-flight 4, recent events 3 + max(1, events up to 3), the least list:
      // 3 + 3 finished + `… 還有 1 個` (as tall as all 4 finished, which it then shows)
      const least = 2 + 4 + 3 + Math.max(1, Math.min(events, 3)) + 3 + 3 + 1 + SUIT_BLOCK_ROWS
      for (const cols of [40, 65, 100]) {
        let tree = await draw($, least, cols)
        expect(linesOf(tree).join('\n')).toContain(STANDBY)
        expect(findAllText(tree, /^job \d+\s*$/)).toHaveLength(4)
        expect(paneRows(tree)).toBeLessThanOrEqual(least)
        tree = await draw($, least - 1, cols)
        expect(linesOf(tree).join('\n')).not.toContain(STANDBY)
        expect(paneRows(tree)).toBeLessThanOrEqual(least - 1)
      }
    })
  }

  test('narrower than the art and its margin the suit is left out; no row overflows', async ($, on) => {
    engine(on, 'agent-1')
    expect(linesOf(await draw($, 50, 28)).join('\n')).toContain(STANDBY)
    expect(linesOf(await draw($, 50, 27)).join('\n')).not.toContain(STANDBY)
    for (const cols of [40, 65, 100]) {
      const tree = await draw($, 50, cols)
      expect(linesOf(tree).join('\n')).toContain(STANDBY)
      expect(Math.max(...rowWidths(tree))).toBeLessThanOrEqual(cols)
    }
  })

  test('boot: the suit over ONLINE when there is room', async ($, on) => {
    engineAll(on)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('command.run', async () => ({}))
    await start($)
    await $.command.run({
      command: 'jarvis',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 100 },
    })
    const lines = linesOf(await draw($, 20))
    const online = lineOf(lines, 'J.A.R.V.I.S. ONLINE')
    const art = lines.slice(0, online).filter(l => /[▀▄]/.test(l))
    expect(art).toHaveLength(SUIT_ROWS)
    expect(lines.join('\n')).not.toContain(STANDBY)
    expect(Math.max(...rowWidths(await draw($, 20, 40)))).toBeLessThanOrEqual(40)
    const short = linesOf(await draw($, 19)).join('\n')
    expect(short).toContain('J.A.R.V.I.S. ONLINE')
    expect(short).not.toMatch(/[▀▄]/)
    expect(linesOf(await draw($, 20, 27)).join('\n')).not.toMatch(/[▀▄]/)
  })
})

describe('background wait', () => {
  const base = (over: Partial<JarvisAgent> = {}): JarvisAgent => ({
    id: 'w1', type: 'verifier', description: 'check', model: 'claude-sonnet-5-5', status: 'done', tool: '',
    runStartedAt: 0, lastSeenAt: 1000, doneMs: 1000, endedAt: 1000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, seq: 0,
    ...over,
  })

  test('an engine waiting on background work shows the agent running and waiting', () => {
    const out = reconcileAgents([base()], [{ id: 'w1', status: 'waiting' }], 5000)
    expect(out[0]?.status).toBe('running')
    expect(out[0]?.waiting).toBe(true)
    expect(out[0]?.runStartedAt).toBe(5000)
    expect(phaseOf(out[0] as JarvisAgent, 9000)).toBe('waiting')
  })

  test('an engine still running a finished agent shows it running, not waiting', () => {
    const out = reconcileAgents([base()], [{ id: 'w1', status: 'running' }], 5000)
    expect(out[0]?.status).toBe('running')
    expect(out[0]?.waiting).toBeUndefined()
  })

  test('waiting, then completed: back to done once', () => {
    const waiting = reconcileAgents([base()], [{ id: 'w1', status: 'waiting' }], 5000)
    const done = reconcileAgents(waiting, [{ id: 'w1', status: 'completed' }], 8000)
    expect(done[0]?.status).toBe('done')
    expect(done[0]?.waiting).toBeUndefined()
    expect(done[0]?.endedAt).toBe(8000)
    expect(done[0]?.doneMs).toBe(1000 + 3000)
    expect(reconcileAgents(done, [{ id: 'w1', status: 'completed' }], 9000)).toBe(done)
  })

  test('failed or killed ends a waiting agent as failed', () => {
    const waiting = reconcileAgents([base()], [{ id: 'w1', status: 'waiting' }], 5000)
    expect(reconcileAgents(waiting, [{ id: 'w1', status: 'killed' }], 6000)[0]?.status).toBe('failed')
    expect(reconcileAgents(waiting, [{ id: 'w1', status: 'failed' }], 6000)[0]?.status).toBe('failed')
  })

  test('an agent the engine no longer lists is left as it is', () => {
    const list = [base()]
    expect(reconcileAgents(list, [], 5000)).toBe(list)
  })

  test('a tool call clears waiting', () => {
    const waiting = reconcileAgents([base()], [{ id: 'w1', status: 'waiting' }], 5000)
    const out = noteTool(waiting, 'w1', 'Bash', 6000)
    expect(out[0]?.waiting).toBeUndefined()
    expect(out[0]?.status).toBe('running')
  })

  test('a waiting subagent is never marked stale', () => {
    const waiting = reconcileAgents([base()], [{ id: 'w1', status: 'waiting' }], 5000)
    expect(markStale(waiting, 5000 + STALE_MS + 1)).toBe(waiting)
  })

  test('a finished agent the engine still ran ends once the engine completes it', () => {
    const revived = reconcileAgents([base()], [{ id: 'w1', status: 'running' }], 5000)
    const done = reconcileAgents(revived, [{ id: 'w1', status: 'completed' }], 7000)
    expect(done[0]?.status).toBe('done')
    expect(done[0]?.endedAt).toBe(7000)
    expect(reconcileAgents(revived, [{ id: 'w1', status: 'idle' }], 7000)[0]?.status).toBe('done')
    expect(reconcileAgents(revived, [{ id: 'w1', status: 'killed' }], 7000)[0]?.status).toBe('failed')
    expect(needsReconcile(revived, 5000 + 10 * RECONCILE_RECENT_MS)).toBe(true)
    expect(needsReconcile(done, 7000 + RECONCILE_RECENT_MS + 1)).toBe(false)
  })

  test('a subagent running in its first turn is left to its turn.complete', () => {
    const list = [base({ status: 'running', endedAt: 0, doneMs: 0 })]
    expect(reconcileAgents(list, [{ id: 'w1', status: 'completed' }], 5000)).toBe(list)
  })

  test('a waiting or revived agent the engine no longer lists ends as done', () => {
    const others = [{ id: 'other', status: 'running' }]
    const waiting = reconcileAgents([base()], [{ id: 'w1', status: 'waiting' }], 5000)
    const ended = reconcileAgents(waiting, others, 6000)
    expect(ended[0]?.status).toBe('done')
    expect(ended[0]?.waiting).toBeUndefined()
    const revived = reconcileAgents([base()], [{ id: 'w1', status: 'running' }], 5000)
    expect(reconcileAgents(revived, others, 6000)[0]?.status).toBe('done')
  })

  test('with no word from the engine, a waiting agent goes lost like any other', () => {
    const waiting = reconcileAgents([base()], [{ id: 'w1', status: 'waiting' }], 5000)
    const lost = markStale(waiting, 5000 + STALE_MS + 1, false)
    expect(lost[0]?.status).toBe('stale')
    expect(lost[0]?.waiting).toBeUndefined()
    expect(needsReconcile(lost, 5000 + STALE_MS + 1)).toBe(false)
  })

  test('an ended agent the engine confirms is not asked of again', () => {
    const confirmed = reconcileAgents([base()], [{ id: 'w1', status: 'completed' }], 2000)
    expect(confirmed[0]?.status).toBe('done')
    expect(needsReconcile(confirmed, 2000)).toBe(false)
    expect(reconcileAgents(confirmed, [{ id: 'w1', status: 'idle' }], 3000)).toBe(confirmed)
    expect(noteTool(confirmed, 'w1', 'Bash', 4000)[0]?.confirmed).toBeUndefined()
  })

  test('reconcile is due while one waits or one finished in the last minute', () => {
    expect(needsReconcile([base({ endedAt: 1000 })], 1000 + RECONCILE_RECENT_MS)).toBe(true)
    expect(needsReconcile([base({ endedAt: 1000 })], 1000 + RECONCILE_RECENT_MS + 1)).toBe(false)
    expect(needsReconcile([base({ status: 'running', waiting: true, endedAt: 0 })], 10 * RECONCILE_RECENT_MS)).toBe(true)
  })
})

describe('background wait, wired', () => {
  const listed = (on: On, rows: { id: string; status: string; type?: string; description?: string }[]) =>
    on('agent.list', async () => ({ value: rows.map(r => ({ id: r.id, status: r.status, type: r.type ?? 'verifier', description: r.description ?? 'check' })) as never }))

  test('a turn that ends while the engine waits leaves the agent WAITING', async ($, on) => {
    engine(on, 'agent-1')
    const engineRows = [{ id: 'agent-1', status: 'waiting' }]
    listed(on, engineRows)
    await start($)
    await $.agent.spawn(spawnInput({ description: 'check', subagentType: 'verifier' }))
    await $.turn.complete(complete('agent-1'))
    const lines = linesOf(await draw($, 40, 80)).join('\n')
    expect(lines).toContain('WAITING')
    expect(lines).not.toContain('MISSION COMPLETE')
    expect(findText(await draw($, 40, 80), /WAITING/)?.props?.color).toBe(THEME.accent)
  })

  test('a turn that ends while the engine still runs it shows it running, then complete on the next tick', async ($, on) => {
    const clock = engine(on, 'agent-1')
    const engineRows = [{ id: 'agent-1', status: 'running' }]
    listed(on, engineRows)
    await start($)
    await $.agent.spawn(spawnInput({ description: 'check', subagentType: 'verifier' }))
    await $.turn.complete(complete('agent-1'))
    expect(linesOf(await draw($, 40, 80)).join('\n')).not.toContain('MISSION COMPLETE')
    engineRows[0] = { id: 'agent-1', status: 'completed' }
    await clock.advance(1500)
    expect(linesOf(await draw($, 40, 80)).join('\n')).toContain('MISSION COMPLETE')
  })

  test('the tick brings a waiting agent back to complete once the engine ends it', async ($, on) => {
    const clock = engine(on, 'agent-1')
    const engineRows = [{ id: 'agent-1', status: 'waiting' }]
    listed(on, engineRows)
    await start($)
    await $.agent.spawn(spawnInput({ description: 'check', subagentType: 'verifier' }))
    await $.turn.complete(complete('agent-1'))
    engineRows[0] = { id: 'agent-1', status: 'completed' }
    await clock.advance(1500)
    expect(linesOf(await draw($, 40, 80)).join('\n')).not.toContain('WAITING')
  })

  test('a tool call from an agent no longer listed brings it back once', async ($, on) => {
    engine(on)
    listed(on, [{ id: 'ghost', status: 'running', type: 'worker', description: 'woken' }])
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'ghost' } as never)
    await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'ghost' } as never)
    const lines = linesOf(await draw($, 40, 80)).join('\n')
    expect(lines.match(/woken/g)?.length ?? 0).toBe(1)
  })

  test('an engine list without a waiting agent ends its WAITING on the next tick', async ($, on) => {
    const clock = engine(on, 'agent-1')
    const engineRows = [{ id: 'agent-1', status: 'waiting' }]
    listed(on, engineRows)
    await start($)
    await $.agent.spawn(spawnInput({ description: 'check', subagentType: 'verifier' }))
    await $.turn.complete(complete('agent-1'))
    engineRows[0] = { id: 'other', status: 'running' }
    await clock.advance(1500)
    const lines = linesOf(await draw($, 40, 80)).join('\n')
    expect(lines).not.toContain('WAITING')
    expect(lines).toContain('MISSION COMPLETE')
  })

  test('a listing that keeps failing lets a waiting agent go lost in time', async ($, on) => {
    const clock = engine(on, 'agent-1')
    const mode = { fail: false }
    on('agent.list', async () => {
      if (mode.fail) throw new Error('down')
      return { value: [{ id: 'agent-1', status: 'waiting', type: 'verifier', description: 'check' }] as never }
    })
    await start($)
    await $.agent.spawn(spawnInput({ description: 'check', subagentType: 'verifier' }))
    await $.turn.complete(complete('agent-1'))
    mode.fail = true
    await clock.advance(STALE_MS + 60_000)
    const lines = linesOf(await draw($, 40, 80)).join('\n')
    expect(lines).not.toContain('WAITING')
    expect(lines).toContain('SIGNAL LOST')
  })

  test('a listing that fails or comes back empty changes no agent', async ($, on) => {
    const clock = engine(on)
    let n = 0
    on('agent.spawn', async () => ({ model: HAIKU, agentId: `w-${(n += 1)}` }))
    const mode = { fail: true }
    on('agent.list', async () => {
      if (mode.fail) throw new Error('down')
      return { value: [] as never }
    })
    await start($)
    await $.agent.spawn(spawnInput({ description: 'first', subagentType: 'verifier', id: 'tu-1' }))
    await $.agent.spawn(spawnInput({ description: 'second', subagentType: 'worker', id: 'tu-2' }))
    await $.turn.complete(complete('w-1'))
    await clock.advance(INIT_MS + 1500)
    const failed = linesOf(await draw($, 40, 80)).join('\n')
    expect(failed).toContain('MISSION COMPLETE')
    expect(failed).toContain('ACTIVE')
    mode.fail = false
    await clock.advance(1500)
    const empty = linesOf(await draw($, 40, 80)).join('\n')
    expect(empty).toContain('MISSION COMPLETE')
    expect(empty).toContain('ACTIVE')
    expect(empty).not.toContain('WAITING')
  })

  test('a tool call from an id the engine does not have adds nothing and asks once', async ($, on) => {
    engine(on)
    let calls = 0
    on('agent.list', async () => {
      calls += 1
      return { value: [{ id: 'other', status: 'running', type: 'worker', description: 'x' }] as never }
    })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'nobody' } as never)
    await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'nobody' } as never)
    expect(calls).toBe(1)
    expect(linesOf(await draw($, 40, 80)).join('\n')).toContain('還沒有派工')
  })

  const waitThenEmpty = (on: On) => {
    const mode = { empty: false }
    on('agent.list', async () => ({
      value: (mode.empty ? [] : [{ id: 'agent-1', status: 'waiting', type: 'verifier', description: 'check' }]) as never,
    }))
    return mode
  }

  test('an empty listing leaves a waiting agent WAITING', async ($, on) => {
    const clock = engine(on, 'agent-1')
    const mode = waitThenEmpty(on)
    await start($)
    await $.agent.spawn(spawnInput({ description: 'check', subagentType: 'verifier' }))
    await $.turn.complete(complete('agent-1'))
    mode.empty = true
    await clock.advance(1500)
    expect(linesOf(await draw($, 40, 80)).join('\n')).toContain('WAITING')
  })

  test('empty listings count as saying nothing: in time a waiting agent goes lost', async ($, on) => {
    const clock = engine(on, 'agent-1')
    const mode = waitThenEmpty(on)
    await start($)
    await $.agent.spawn(spawnInput({ description: 'check', subagentType: 'verifier' }))
    await $.turn.complete(complete('agent-1'))
    mode.empty = true
    await clock.advance(STALE_MS + 60_000)
    const lines = linesOf(await draw($, 40, 80)).join('\n')
    expect(lines).not.toContain('WAITING')
    expect(lines).toContain('SIGNAL LOST')
  })

  test('a new session asks the engine again about an id it did not have', async ($, on) => {
    engine(on)
    let calls = 0
    on('agent.list', async () => {
      calls += 1
      return { value: [{ id: 'other', status: 'running', type: 'worker', description: 'x' }] as never }
    })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'nobody' } as never)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'nobody' } as never)
    expect(calls).toBe(2)
  })
})

describe('main tools and role models', () => {
  test('top tools by count, ties by name', () => {
    expect(topTools({ Read: 42, Bash: 120, Edit: 42 }, 2)).toEqual([{ tool: 'Bash', count: 120 }, { tool: 'Edit', count: 42 }])
    expect(topTools(undefined, 2)).toEqual([])
  })
  test('each role its most used model, marked mixed past one', () => {
    const a = (id: string, type: string, model: string): JarvisAgent => ({
      id, type, description: '', model, status: 'done', tool: '', runStartedAt: 0, lastSeenAt: 0, doneMs: 0, endedAt: 1,
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    })
    const m = roleModels([a('1', 'verifier', 'claude-sonnet-5-5'), a('2', 'verifier', 'claude-sonnet-5-5'), a('3', 'verifier', 'claude-opus-5-5'), a('4', 'worker', 'claude-opus-5-5')])
    expect(m.get('verifier')).toEqual({ label: 'Sonnet', family: 'sonnet', mixed: true })
    expect(m.get('worker')).toEqual({ label: 'Opus', family: 'opus', mixed: false })
    expect(m.has('fork')).toBe(false)
  })
  test('a main tool call counts toward the main loop only', async ($, on) => {
    const w = watch(on)
    engine(on, 'agent-1')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await $.tool.call({ tool: 'Bash', command: 'pwd' } as never)
    await $.agent.spawn(spawnInput({ description: 'x', subagentType: 'worker' }))
    await $.tool.call({ tool: 'Read', file_path: '/a', agentId: 'agent-1' } as never)
    expect(w.main?.toolCounts).toEqual({ Bash: 2 })
    const view = buildCockpit({ agents: [], main: w.main as JarvisMain, events: [] }, 0)
    expect(view.main.toolCounts).toEqual({ Bash: 2 })
  })
})
