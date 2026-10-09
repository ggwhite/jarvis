import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { CrewPage, CrewUi } from '../types'

import {
  SPINNER,
  addAgent,
  addEvent,
  buildCockpit,
  describeCall,
  healthOfState,
  finishTurn,
  markStale,
  noteTool,
  runningOf,
  MAIN_ACTOR,
  MAIN_SOURCE,
} from './crew'
import type { Completion } from './crew'
import { drawCockpit } from './cockpit'
import { RUN_TIMEOUT_MS, createReporter, crewText, inHerdr } from './herdr'
import type { Reporter } from './herdr'

const PANE = 'crew'
const MAX_EARLY = 100

const agents = atom({ plugin: 'crew', key: 'agents' } as const, [])
const main = atom({ plugin: 'crew', key: 'main' } as const, {
  model: '',
  chain: 0,
  ok: 0,
  fail: 0,
  lastTool: '',
  lastDesc: '',
  isRunning: false,
  runSince: 0,
})
const events = atom({ plugin: 'crew', key: 'events' } as const, [])
const inflight = atom({ plugin: 'crew', key: 'inflight' } as const, [])
const tick = atom({ plugin: 'crew', key: 'tick' } as const, { n: 0, now: 0 })
const ui = atom({ plugin: 'crew', key: 'ui' } as const, {
  page: 'now',
  agentId: '',
  paused: false,
  pausedTotal: 0,
})
const eventTotal = atom({ plugin: 'crew', key: 'eventTotal' } as const, 0)

// Tool calls that last as long as the agents they start, whose own calls are tracked:
// counting them in flight would hide a stuck subagent.
const UNTRACKED = new Set(['Agent', 'Workflow'])

// One tick a second for the whole session, started at session.start: it counts
// the clock of running rows, marks lost subagents and feeds the Herdr row. With
// nothing running it only reads state, so nothing redraws.
async function tickOnce(
  $: Pick<EngineInterface, 'clock' | 'state'>,
  reporter: Reporter | undefined,
): Promise<void> {
  try {
    const now = await $.clock.now()
    let list = await read($, agents)
    if (runningOf(list).length > 0) {
      if (markStale(list, now) !== list) {
        await update($, agents, l => [...markStale(l, now)])
        list = await read($, agents)
      }
      if (runningOf(list).length > 0) await update($, tick, t => ({ n: t.n + 1, now }))
    }
    const health = healthOfState(
      {
        agents: list,
        main: await read($, main),
        events: await read($, events),
        inflight: await read($, inflight),
      },
      now,
    )
    await reporter?.step(crewText(list, health), now)
  } catch {
    // a broken tick must never reach Claude's work
  }
}

export const register: Register = on => {
  // A subagent can finish before its spawn has been recorded; park its turns here.
  const early = new Map<string, Completion[]>()
  let timer: Timer | undefined

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'crew',
        description: 'Show a live pane of subagent dispatch',
      })
    } catch {
      // the command is optional
    }

    let reporter: Reporter | undefined
    try {
      const herdrEnv = await $.env.get('HERDR_ENV')
      const paneId = await $.env.get('HERDR_PANE_ID')
      if (paneId !== undefined && inHerdr(herdrEnv, paneId)) {
        reporter = createReporter(paneId, async argv => {
          try {
            const out = await $.process.run(argv, { timeoutMs: RUN_TIMEOUT_MS })
            return out.exitCode === 0
          } catch {
            return false
          }
        })
      }
    } catch {
      // no Herdr row without a readable environment
    }

    try {
      timer?.cancel()
      timer = $.clock.every(1000, () => tickOnce($, reporter))
    } catch {
      // no live clock; the pane still shows what happened
    }

    try {
      await update($, inflight, () => [])
    } catch {
      // bookkeeping only
    }

    return next(e)
  })

  on('command.run', { command: 'crew' }, async $ => {
    try {
      await $.ui.open({ id: PANE, title: 'Crew' })
    } catch {
      return { text: 'Crew 面板開啟失敗' }
    }

    return { text: 'Crew 面板已開啟' }
  })

  on('agent.spawn', async ($, e, next) => {
    const out = await next(e)
    try {
      const id = out.agentId
      if (id !== undefined) {
        const now = await $.clock.now()
        const model = out.model || e.model || ''
        const parked = early.get(id) ?? []
        early.delete(id)
        await update($, agents, list => {
          let rows = addAgent(list, {
            id,
            type: e.subagentType,
            description: e.description,
            model,
            now,
            ...(e.workflow ? { workflow: { runId: e.workflow.runId, agentIndex: e.workflow.agentIndex } } : {}),
          })
          for (const c of parked) rows = finishTurn(rows, id, c, now)
          return rows
        })
        await update($, tick, t => ({ n: t.n + 1, now }))
      }
    } catch {
      // recording failed; the spawn itself already happened
    }

    return out
  })

  on('turn.start', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      await update($, main, m => ({ ...m, isRunning: true, runSince: now }))
    } catch {
      // bookkeeping only
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    const tool = e.tool
    let startedAt: number | undefined
    let source = MAIN_SOURCE
    let desc = ''
    try {
      desc = describeCall(tool, e as unknown as Record<string, unknown>)
      const now = await $.clock.now()
      startedAt = now
      if (id === undefined) {
        const isAgent = tool === 'Agent'
        await update($, main, m => ({
          ...m,
          chain: isAgent ? 0 : m.chain + 1,
          lastTool: tool,
          lastDesc: desc,
        }))
      } else {
        await update($, agents, list => noteTool(list, id, tool, now))
        await update($, tick, t => ({ n: t.n + 1, now }))
        const list = await read($, agents)
        source = list.find(a => a.id === id)?.type ?? 'subagent'
      }
    } catch {
      // bookkeeping only
    }

    // An Agent or Workflow call is not in flight (UNTRACKED). Keys are random so a
    // reload's calls never share one.
    let flightKey: string | undefined
    if (startedAt !== undefined && !UNTRACKED.has(tool)) {
      try {
        const key = crypto.randomUUID()
        const began = startedAt
        flightKey = key
        await update($, inflight, list => [
          ...list,
          { key, actor: id ?? MAIN_ACTOR, source, tool, desc, startedAt: began },
        ])
      } catch {
        // bookkeeping only
      }
    }

    let ok = true
    try {
      const out = await next(e)
      ok = out.isError !== true
      return out
    } catch (err) {
      ok = false
      throw err
    } finally {
      try {
        if (flightKey !== undefined) {
          const key = flightKey
          await update($, inflight, list => list.filter(f => f.key !== key))
        }
      } catch {
        // bookkeeping only
      }
      try {
        if (startedAt !== undefined) {
          const began = startedAt
          const ms = Math.max(0, (await $.clock.now()) - began)
          const ev = { ts: began, actor: id ?? MAIN_ACTOR, source, isMain: id === undefined, tool, desc, ms, ok }
          await update($, events, list => addEvent(list, ev))
          await update($, eventTotal, n => n + 1)
          if (id === undefined) {
            await update($, main, m => ({
              ...m,
              ok: m.ok + (ok ? 1 : 0),
              fail: m.fail + (ok ? 0 : 1),
            }))
          }
        }
      } catch {
        // the call itself already ran
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    try {
      const id = e.agentId
      if (id === undefined) {
        const model = e.usage?.model
        await update($, main, m => ({ ...m, isRunning: false, ...(model ? { model } : {}) }))
      } else {
        const now = await $.clock.now()
        const c: Completion = {
          reason: e.reason,
          durationMs: e.durationMs,
          ...(e.usage ? { usage: e.usage } : {}),
        }
        let known = false
        await update($, agents, list => {
          known = list.some(a => a.id === id)
          return known ? finishTurn(list, id, c, now) : list
        })
        if (!known) {
          early.set(id, [...(early.get(id) ?? []), c])
          if (early.size > MAX_EARLY) {
            const oldest = early.keys().next().value
            if (oldest !== undefined) early.delete(oldest)
          }
        }
      }
    } catch {
      // bookkeeping only
    }

    // A turn that has ended has no call of its own left running; any still listed lost its
    // finally (a hot reload) and would hold off the stuck warning for good.
    try {
      const actor = e.agentId ?? MAIN_ACTOR
      await update($, inflight, list => list.filter(f => f.actor !== actor))
    } catch {
      // bookkeeping only
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      await update($, main, m => ({ ...m, chain: 0 }))
    } catch {
      // bookkeeping only
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const t = await read($, tick)
    let now = t.now
    try {
      now = await $.clock.now()
    } catch {
      // no clock: the last tick's time stands
    }
    const view = buildCockpit(
      {
        agents: await read($, agents),
        main: await read($, main),
        events: await read($, events),
        inflight: await read($, inflight),
      },
      now,
    )
    const shown = await read($, ui)
    const total = await read($, eventTotal)
    // what a press changes, written from its onPress (state is not written while drawing)
    const setUi = (fn: (u: CrewUi, recorded: number) => CrewUi) => {
      void (async () => {
        try {
          const recorded = await read($, eventTotal)
          await update($, ui, u => fn(u, recorded))
        } catch {
          // the pane stays as it was
        }
      })()
    }
    return drawCockpit(elements, view, {
      cols: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
      frame: SPINNER[t.n % SPINNER.length] ?? '⠋',
      page: shown.page,
      agentId: shown.agentId,
      paused: shown.paused,
      fresh: shown.paused ? Math.max(0, total - shown.pausedTotal) : 0,
      go: (page: CrewPage) => setUi(u => ({ ...u, page })),
      open: (agentId: string) => setUi(u => ({ ...u, page: 'detail', agentId })),
      pause: () =>
        setUi((u, recorded) => (u.paused ? { ...u, paused: false } : { ...u, paused: true, pausedTotal: recorded })),
    })
  })
}
