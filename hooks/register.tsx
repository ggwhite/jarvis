import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { FleetJumpError, FleetQuota, JarvisAgent, JarvisPage, JarvisUi } from '../types'

import {
  ANIM_MS,
  IDLE_MS,
  LIST_FAILS_MAX,
  SEEN_MS,
  SPINNER,
  addAgent,
  bootStage,
  addEvent,
  buildCockpit,
  describeCall,
  healthOfState,
  finishTurn,
  markStale,
  needsReconcile,
  noteTool,
  reconcileAgents,
  runningOf,
  scanFrame,
  tickMs,
  MAIN_ACTOR,
  MAIN_SOURCE,
} from './jarvis'
import type { Completion, EngineAgent } from './jarvis'
import { drawCockpit } from './cockpit'
import { RUN_TIMEOUT_MS, createReporter, jarvisText, inHerdr } from './herdr'
import type { Reporter } from './herdr'
import { parseQuota } from './fleet'
import { SUIT_REST_TICK_MS } from './suit'
import { EMPTY_FLEET, FLEET_MS, FLEET_RUN_TIMEOUT_MS, LIMITS_PATH, focusArgv, refreshFleet, withJump } from './fleetSource'
import type { FleetIo } from './fleetSource'

const PANE = 'jarvis'
const MAX_EARLY = 100
// the fleet page counts as in view a poll period past SEEN_MS: a drawing that lands after
// the next tick does not stop the poll
const FLEET_SEEN_MS = SEEN_MS + FLEET_MS
// the standby suit reads the usagebar cache at most this often
const QUOTA_EVERY_MS = 30_000

const agents = atom({ plugin: 'jarvis', key: 'agents' } as const, [])
const main = atom({ plugin: 'jarvis', key: 'main' } as const, {
  model: '',
  chain: 0,
  ok: 0,
  fail: 0,
  lastTool: '',
  lastDesc: '',
  isRunning: false,
  runSince: 0,
  toolCounts: {},
})
const events = atom({ plugin: 'jarvis', key: 'events' } as const, [])
const inflight = atom({ plugin: 'jarvis', key: 'inflight' } as const, [])
const tick = atom({ plugin: 'jarvis', key: 'tick' } as const, { n: 0, now: 0 })
const ui = atom({ plugin: 'jarvis', key: 'ui' } as const, {
  page: 'now',
  agentId: '',
  paused: false,
  pausedTotal: 0,
  paneId: '',
})
const eventTotal = atom({ plugin: 'jarvis', key: 'eventTotal' } as const, 0)
const fleet = atom({ plugin: 'jarvis', key: 'fleet' } as const, EMPTY_FLEET)
const fleetCursor = atom({ plugin: 'jarvis', key: 'fleetCursor' } as const, {})
const standbyQuota = atom({ plugin: 'jarvis', key: 'standbyQuota' } as const, null as FleetQuota | null)
const suit = atom({ plugin: 'jarvis', key: 'suit' } as const, { n: 0 })

// Tool calls that last as long as the agents they start, whose own calls are tracked:
// counting them in flight would hide a stuck subagent.
const UNTRACKED = new Set(['Agent', 'Workflow'])

// opens the pane, its boot screen from the time handed to boot (undefined: none); false when it could not open
async function openPane($: Pick<EngineInterface, 'clock' | 'ui'>, boot: (at: number | undefined) => void): Promise<boolean> {
  try {
    boot(await $.clock.now())
  } catch {
    // no clock: no boot screen
    boot(undefined)
  }
  try {
    await $.ui.open({ id: PANE, title: 'Jarvis' })
    return true
  } catch {
    boot(undefined)
    return false
  }
}

// What the engine says of its agents, as reconcileAgents reads it; undefined when it
// cannot say (the listing failed or came back empty).
async function engineAgents($: Pick<EngineInterface, 'agent'>): Promise<EngineAgent[] | undefined> {
  try {
    const list = (await $.agent.list()).map(a => ({ id: a.id, status: a.status, type: a.type, description: a.description }))
    return list.length === 0 ? undefined : list
  } catch {
    return undefined
  }
}

// `listing.fails` counts the listings in a row that said nothing. `waitingOnly` as
// reconcileAgents takes it.
async function reconcile(
  $: Pick<EngineInterface, 'agent' | 'state'>,
  now: number,
  listing: { fails: number },
  waitingOnly = false,
): Promise<void> {
  const info = await engineAgents($)
  if (info === undefined) {
    listing.fails += 1
    return
  }
  listing.fails = 0
  await update($, agents, list => {
    const out = reconcileAgents(list, info, now, waitingOnly)
    return out === list ? list : [...out]
  })
}

// The session's one tick, started at session.start: it counts the clock of running
// rows and turns the spinners; at most once per IDLE_MS it also marks lost subagents
// and feeds the Herdr row (`slow.at` is when it last did). It runs every ANIM_MS while
// a subagent runs (not waiting) or the boot plays and the pane is in view, every IDLE_MS otherwise
// (`pace` picks); with nothing running and no boot it only reads state, so nothing redraws.
async function tickOnce(
  $: Pick<EngineInterface, 'clock' | 'state' | 'agent'>,
  reporter: Reporter | undefined,
  pace: (list: readonly JarvisAgent[], now: number) => void,
  slow: { at: number },
  booting: (now: number) => boolean,
  listing: { fails: number },
): Promise<void> {
  try {
    const now = await $.clock.now()
    const due = now - slow.at >= IDLE_MS
    let list = await read($, agents)
    if (due && needsReconcile(list, now)) {
      await reconcile($, now, listing)
      list = await read($, agents)
    }
    const exempt = listing.fails < LIST_FAILS_MAX
    if (runningOf(list).length > 0 && due && markStale(list, now, exempt) !== list) {
      await update($, agents, l => [...markStale(l, now, exempt)])
      list = await read($, agents)
    }
    if (runningOf(list).length > 0 || booting(now)) await update($, tick, t => ({ n: t.n + 1, now }))
    pace(list, now)
    if (!due) return
    slow.at = now
    const health = healthOfState(
      {
        agents: list,
        main: await read($, main),
        events: await read($, events),
        inflight: await read($, inflight),
      },
      now,
    )
    await reporter?.step(jarvisText(list, health), now)
  } catch {
    // a broken tick must never reach Claude's work
  }
}

export const register: Register = on => {
  // A subagent can finish before its spawn has been recorded; park its turns here.
  const early = new Map<string, Completion[]>()
  // ids the engine was asked about on a tool call and did not list: not asked again
  const unknown = new Set<string>()
  const listing = { fails: 0 }
  let timer: Timer | undefined
  let period = 0
  // when the pane was last drawn: the tick animates only a pane in view
  let drawnAt = -Infinity
  // restarts the tick at `ms` when it runs at another period; set at session.start
  let pace: ((ms: number) => void) | undefined
  // when /jarvis opened the pane: its boot plays until a drawing finds it over
  let bootAt: number | undefined
  // the boot animates only while the pane is in view
  const booting = (now: number) => bootAt !== undefined && now - drawnAt <= SEEN_MS
  // the fleet page: its poll runs while it is the page and was drawn within FLEET_SEEN_MS
  let fleetEnabled = false
  let fleetSeenAt = -Infinity
  let fleetOn: ((now: number) => void) | undefined
  let fleetJump: ((paneId: string) => void) | undefined
  // the fleet poll, one per register: a session started again cancels the last one's
  let fleetTimer: Timer | undefined
  let fleetBusy = false
  // when the session started: the standby suit's uptime
  let sessionStartedAt: number | undefined
  // the standby suit's quota read, when it last asked for one; set at session.start
  let quotaReadAt = -Infinity
  let quotaOn: ((now: number) => void) | undefined
  // the standby suit's frames: one every SUIT_TICK_MS while the now page shows it, drawn
  // within SEEN_MS, every SUIT_REST_TICK_MS at rest; set at session.start
  let suitTimer: Timer | undefined
  let suitPeriod = 0
  let suitSeenAt = -Infinity
  let suitOn: ((now: number, ms: number) => void) | undefined
  const suitOff = () => {
    suitTimer?.cancel()
    suitTimer = undefined
  }

  const setBoot = (at: number | undefined) => {
    bootAt = at
  }

  on('session.start', async ($, e, next) => {
    unknown.clear()
    listing.fails = 0
    try {
      await $.command.register({
        name: 'jarvis',
        description: 'Show a live pane of subagent dispatch',
      })
    } catch {
      // the command is optional
    }

    try {
      sessionStartedAt = await $.clock.now()
    } catch {
      // no clock: no uptime
      sessionStartedAt = undefined
    }

    let reporter: Reporter | undefined
    let herdrOn = false
    let home = ''
    try {
      const herdrEnv = await $.env.get('HERDR_ENV')
      const paneId = await $.env.get('HERDR_PANE_ID')
      home = (await $.env.get('HOME')) ?? ''
      herdrOn = paneId !== undefined && inHerdr(herdrEnv, paneId)
      if (paneId !== undefined && herdrOn) {
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

    const slow = { at: -Infinity }
    const setPace = (ms: number) => {
      if (timer !== undefined && ms === period) return
      try {
        timer?.cancel()
        period = ms
        timer = $.clock.every(ms, () =>
          tickOnce($, reporter, (list, now) => setPace(tickMs(list, now, drawnAt, booting(now))), slow, booting, listing),
        )
      } catch {
        // no live clock; the pane still shows what happened
        timer = undefined
      }
    }
    pace = setPace
    timer?.cancel()
    timer = undefined
    setPace(IDLE_MS)

    const io: FleetIo = {
      home,
      run: async argv => {
        try {
          const r = await $.process.run(argv, { timeoutMs: FLEET_RUN_TIMEOUT_MS })
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, truncated: r.isStdoutTruncated === true }
        } catch {
          return undefined
        }
      },
      stat: async path => {
        try {
          const s = await $.fs.stat(path)
          return s.kind === 'file' ? { size: s.size, mtimeMs: s.mtimeMs } : undefined
        } catch {
          return undefined
        }
      },
      read: async path => {
        try {
          const t = await $.fs.read(path)
          return typeof t === 'string' ? t : undefined
        } catch {
          return undefined
        }
      },
      list: async dir => {
        try {
          return await $.fs.list(dir)
        } catch {
          return undefined
        }
      },
    }
    fleetEnabled = herdrOn && home !== ''
    fleetTimer?.cancel()
    fleetTimer = undefined
    fleetBusy = false
    const refresh = async () => {
      if (fleetBusy) return
      fleetBusy = true
      try {
        const now = await $.clock.now()
        const out = await refreshFleet(io, await read($, fleet), await read($, fleetCursor), now)
        await update($, fleetCursor, () => out.cursor)
        await update($, fleet, () => out.view)
      } catch {
        // the fleet page keeps what it showed
      } finally {
        fleetBusy = false
      }
    }
    fleetOn = (now: number) => {
      fleetSeenAt = now
      if (!fleetEnabled || fleetTimer !== undefined) return
      try {
        fleetTimer = $.clock.every(FLEET_MS, async () => {
          const t = await $.clock.now()
          const { page } = await read($, ui)
          if ((page !== 'fleet' && page !== 'fleetDetail') || t - fleetSeenAt > FLEET_SEEN_MS) {
            fleetTimer?.cancel()
            fleetTimer = undefined
            return
          }
          await refresh()
        })
        $.clock.after(1, () => void refresh())
      } catch {
        fleetTimer = undefined
      }
    }
    fleetJump = (paneId: string) => {
      void (async () => {
        try {
          const r = await io.run(focusArgv(paneId))
          const err: FleetJumpError | undefined =
            r?.exitCode === 0 ? undefined : { paneId, text: `跳轉失敗：${(r?.stderr ?? '').trim() || 'herdr 沒有回應'}` }
          await update($, fleet, v => withJump(v, err))
        } catch {
          // the page stays as it was
        }
      })()
    }

    quotaReadAt = -Infinity
    quotaOn = (now: number) => {
      if (home === '' || now - quotaReadAt < QUOTA_EVERY_MS) return
      quotaReadAt = now
      try {
        $.clock.after(1, async () => {
          try {
            const q = parseQuota(await io.read(`${home}/${LIMITS_PATH}`))
            await update($, standbyQuota, () => q ?? null)
          } catch {
            // the suit keeps what it showed
          }
        })
      } catch {
        // no clock: no power lines
      }
    }

    // the last session's quota read left behind; written only when there is one
    try {
      if ((await read($, standbyQuota)) !== null) await update($, standbyQuota, () => null)
    } catch {
      // the suit keeps what it showed
    }

    suitOff()
    // the last session's frame, deployment and hold left behind; written only when there are any
    try {
      const last = await read($, suit)
      if (last.n !== 0 || last.deployedAt !== undefined || last.paused === true) await update($, suit, () => ({ n: 0 }))
    } catch {
      // the suit keeps its frame
    }
    // a drawing that asks for another frame time restarts the timer at it
    suitOn = (now: number, ms: number) => {
      suitSeenAt = now
      if (suitTimer !== undefined && ms === suitPeriod) return
      suitOff()
      try {
        suitPeriod = ms
        suitTimer = $.clock.every(ms, async () => {
          try {
            // a drawing without the suit stops it at once; one not drawn again, here
            if ((await $.clock.now()) - suitSeenAt > SEEN_MS) {
              suitOff()
              return
            }
            // at rest the turn waits at its start: woken, it plays from STANDBY
            await update($, suit, s => ({ ...s, n: ms === SUIT_REST_TICK_MS ? 0 : s.n + 1 }))
          } catch {
            // the suit holds its frame
          }
        })
      } catch {
        // no live clock: the suit stands still
        suitTimer = undefined
      }
    }

    try {
      await update($, inflight, () => [])
    } catch {
      // bookkeeping only
    }

    // the pane is optional: one that cannot open waits for /jarvis
    await openPane($, setBoot)

    return next(e)
  })

  on('command.run', { command: 'jarvis' }, async $ =>
    (await openPane($, setBoot)) ? { text: 'Jarvis 面板已開啟' } : { text: 'Jarvis 面板開啟失敗' },
  )

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
        // a suit held still plays no deployment
        if ((await read($, suit)).paused !== true) await update($, suit, s => ({ ...s, deployedAt: now }))
        pace?.(tickMs(await read($, agents), now, drawnAt))
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
          toolCounts: { ...(m.toolCounts ?? {}), [tool]: ((m.toolCounts ?? {})[tool] ?? 0) + 1 },
        }))
      } else {
        const known = (await read($, agents)).some(a => a.id === id)
        if (!known && !unknown.has(id)) {
          const engineList = await engineAgents($)
          const info = engineList?.find(a => a.id === id)
          if (engineList !== undefined && info === undefined) {
            unknown.add(id)
            if (unknown.size > MAX_EARLY) {
              const oldest = unknown.values().next().value
              if (oldest !== undefined) unknown.delete(oldest)
            }
          }
          if (info) {
            await update($, agents, list =>
              list.some(a => a.id === id)
                ? list
                : addAgent(list, { id, type: info.type ?? 'subagent', description: info.description ?? '', model: '', now }),
            )
          }
        }
        await update($, agents, list => noteTool(list, id, tool, now))
        await update($, tick, t => ({ n: t.n + 1, now }))
        const list = await read($, agents)
        pace?.(tickMs(list, now, drawnAt))
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
        // the engine has most likely not ended it yet: running is left to the tick
        if (known) await reconcile($, now, listing, true)
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
    // played once: the first drawing that finds the boot over ends it
    const boot = bootAt === undefined ? undefined : bootStage(now - bootAt)
    if (boot === undefined) bootAt = undefined
    // a pane in view with a squad member running (not waiting), or booting, animates at
    // once, not at the next idle tick
    drawnAt = now
    if (view.running.some(a => a.waiting !== true) || boot !== undefined) pace?.(ANIM_MS)
    const shown = await read($, ui)
    if (shown.page === 'fleet' || shown.page === 'fleetDetail') fleetOn?.(now)
    const quota = await read($, standbyQuota)
    const frame = await read($, suit)
    // the suit animates only while it is drawn and not held still, and reads the quota while drawn
    const onStandby = (drawn: boolean, ms?: number) => {
      if (!drawn || ms === undefined) suitOff()
      else suitOn?.(now, ms)
      if (drawn) quotaOn?.(now)
    }
    // a press holds the suit still or plays it; the drawing it brings stops or starts the timer
    const toggleSuit = () => {
      void (async () => {
        try {
          await update($, suit, x => ({ ...x, paused: x.paused !== true }))
        } catch {
          // the suit stays as it was
        }
      })()
    }
    let sessionId = ''
    try {
      sessionId = await $.session.id()
    } catch {
      // no session id: no row is marked as this one
    }
    const total = await read($, eventTotal)
    // what a press changes, written from its onPress (state is not written while drawing)
    const setUi = (fn: (u: JarvisUi, recorded: number) => JarvisUi) => {
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
      scan: scanFrame(t.n),
      beat: t.n,
      ...(boot ? { boot } : {}),
      page: shown.page,
      agentId: shown.agentId,
      paused: shown.paused,
      fresh: shown.paused ? Math.max(0, total - shown.pausedTotal) : 0,
      go: (page: JarvisPage) => setUi(u => ({ ...u, page })),
      open: (agentId: string) => setUi(u => ({ ...u, page: 'detail', agentId })),
      pause: () =>
        setUi((u, recorded) => (u.paused ? { ...u, paused: false } : { ...u, paused: true, pausedTotal: recorded })),
      fleet: await read($, fleet),
      herdr: fleetEnabled,
      paneId: shown.paneId ?? '',
      sessionId,
      openFleet: (paneId: string) => setUi(u => ({ ...u, page: 'fleetDetail', paneId })),
      jump: (paneId: string) => fleetJump?.(paneId),
      ...(quota ? { quota } : {}),
      ...(sessionStartedAt === undefined ? {} : { startedAt: sessionStartedAt }),
      suitTick: frame.n,
      ...(frame.deployedAt === undefined ? {} : { deployedAt: frame.deployedAt }),
      suitPaused: frame.paused === true,
      toggleSuit,
      onStandby,
    })
  })
}
