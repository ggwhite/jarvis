import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { ANIM_MS, IDLE_MS, MAX_AGENTS, MAX_EVENTS, SEEN_MS } from '../hooks/jarvis'
import { MAX_ITEMS, TASK_TOOL } from '../hooks/tasks'
import { complete, drawOn, pressOn, spawnInput } from './helpers'

const RUNNING = 5
const SUBTASKS = 10

// a session at its limits: MAX_AGENTS squad members (RUNNING still at work), MAX_EVENTS calls,
// a board of MAX_ITEMS items with SUBTASKS subtasks each
const maxed = (on: On) => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, {})
  let seq = 0
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', async () => ({}))
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: `agent-${++seq}` }))
  on('agent.list', async () => ({
    value: Array.from({ length: RUNNING }, (_, i) => ({ id: `agent-${MAX_AGENTS - i}`, status: 'running', type: 'worker', description: 'd' })) as never,
  }))
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__jarvis__${e.name}` } }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))
  return clock
}

const seed = async ($: Engine) => {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  for (let i = 1; i <= MAX_AGENTS; i++) {
    await $.agent.spawn(spawnInput(`job ${i} with a fairly long description`, i % 3 === 0 ? 'Explore' : 'worker', `tu-${i}`))
  }
  for (let i = 1; i <= MAX_AGENTS - RUNNING; i++) await $.turn.complete(complete(`agent-${i}`))
  for (let i = 0; i < MAX_EVENTS; i++) {
    await $.tool.call({ tool: 'Read', file_path: `/repo/src/file-${i}.ts`, agentId: `agent-${(i % MAX_AGENTS) + 1}` } as never)
  }
  for (let i = 1; i <= MAX_ITEMS; i++) {
    const subtasks = Array.from({ length: SUBTASKS }, (_, j) => `subtask ${i}.${j + 1} of the board`)
    await $.tool.call({ tool: TASK_TOOL, op: 'add', item: `item ${i} on a busy board`, subtasks } as never)
  }
  await $.tool.call({ tool: TASK_TOOL, op: 'update', id: `${MAX_ITEMS}.1`, status: 'in_progress' } as never)
}

// how many times the mod writes its tick: each write redraws a pane in view
const ticks = (on: On) => {
  const count = { n: 0 }
  on('state.set', { plugin: 'jarvis', key: 'tick' }, async (_$, e, next) => {
    count.n += 1
    return next(e)
  })
  return count
}

describe('a maxed-out session', () => {
  for (const page of ['now', 'tasks'] as const) {
    test(`the ${page} page: a tick every ANIM_MS in view, none out of view, animating again once drawn`, { timeoutMs: 30_000 }, async ($, on) => {
      const clock = maxed(on)
      const count = ticks(on)
      await seed($)
      if (page === 'tasks') await pressOn($, 'terminal', 'tab-tasks')
      await drawOn($, 'terminal')
      let base = count.n
      await clock.advance(1000)
      expect(count.n - base).toBe(1000 / ANIM_MS)

      await clock.advance(SEEN_MS)
      base = count.n
      await clock.advance(IDLE_MS * 3)
      expect(count.n).toBe(base)

      await drawOn($, 'terminal')
      base = count.n
      await clock.advance(1000)
      expect(count.n - base).toBe(1000 / ANIM_MS)
    })
  }
})
