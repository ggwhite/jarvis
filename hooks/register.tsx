import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { CrewAgent } from '../types'
import {
  CHAIN_WARN,
  FAMILY_COLOR,
  SPINNER,
  addAgent,
  elapsedMs,
  familyOf,
  finishTurn,
  finishedOf,
  fmtDur,
  fmtK,
  fmtUsd,
  markStale,
  noteTool,
  runningOf,
  shortModel,
  staleOf,
  summarize,
  tokenTotal,
  tokensOf,
} from './crew'
import type { Completion } from './crew'
import { RUN_TIMEOUT_MS, createReporter, crewText, inHerdr } from './herdr'
import type { Reporter } from './herdr'

const PANE = 'crew'
const MAX_EARLY = 100

const agents = atom({ plugin: 'crew', key: 'agents' } as const, [])
const main = atom({ plugin: 'crew', key: 'main' } as const, { model: '', chain: 0 })
const tick = atom({ plugin: 'crew', key: 'tick' } as const, { n: 0, now: 0 })

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
    await reporter?.step(crewText(list), now)
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

  on('tool.call', async ($, e, next) => {
    try {
      const id = e.agentId
      if (id === undefined) {
        const isAgent = e.tool === 'Agent'
        await update($, main, m => ({ ...m, chain: isAgent ? 0 : m.chain + 1 }))
      } else {
        const now = await $.clock.now()
        const tool = e.tool
        await update($, agents, list => noteTool(list, id, tool, now))
        await update($, tick, t => ({ n: t.n + 1, now }))
      }
    } catch {
      // bookkeeping only
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    try {
      const id = e.agentId
      if (id === undefined) {
        const model = e.usage?.model
        if (model) await update($, main, m => ({ ...m, model }))
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
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const m = await read($, main)
    const t = await read($, tick)

    const rows = e.props.scroll.bodyRows
    const cols = e.props.bodyColumns
    const running = runningOf(list)
    const finished = finishedOf(list)
    const stale = staleOf(list)
    const sum = summarize(list)
    const frame = SPINNER[t.n % SPINNER.length] ?? SPINNER[0]
    const warn = m.chain >= CHAIN_WARN

    const badge = (model: string) => {
      const family = familyOf(model)
      return family ? (
        <Text color={FAMILY_COLOR[family]}>{`[${shortModel(model)}]`}</Text>
      ) : (
        <Text dimColor>{`[${shortModel(model)}]`}</Text>
      )
    }

    const runningRow = (a: CrewAgent) => (
      <Box flexDirection="row" gap={1}>
        <Text color="cyan">{frame ?? ''}</Text>
        <Text bold>{a.type}</Text>
        {badge(a.model)}
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{a.description}</Text>
        </Box>
        <Box flexShrink={0} flexDirection="row" gap={1}>
          {a.tool !== '' && <Text dimColor>{a.tool}</Text>}
          <Text>{fmtDur(elapsedMs(a, t.now))}</Text>
        </Box>
      </Box>
    )

    const finishedRow = (a: CrewAgent) => (
      <Box flexDirection="row" gap={1}>
        {a.status === 'done' ? <Text color="green">✓</Text> : <Text color="red">✗</Text>}
        <Text bold>{a.type}</Text>
        {badge(a.model)}
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end" dimColor>
            {a.description}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{`${fmtDur(elapsedMs(a, t.now))} · ${fmtK(tokenTotal(tokensOf(a)))}`}</Text>
        </Box>
      </Box>
    )

    const staleRow = (a: CrewAgent) => (
      <Box flexDirection="row" gap={1}>
        <Text color="gray">?</Text>
        <Text color="gray" bold>
          {a.type}
        </Text>
        <Text color="gray">{`[${shortModel(a.model)}]`}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end" color="gray">
            {a.description}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color="gray">{`失聯 · ${fmtDur(elapsedMs(a, t.now))}`}</Text>
        </Box>
      </Box>
    )

    const summaryRows = list.length === 0 ? 2 : 5
    const runningRows = running.length === 0 ? 0 : running.length + 1
    const staleRows = stale.length === 0 ? 0 : stale.length + 1
    const room = Math.max(0, rows - 1 - 1 - runningRows - staleRows - summaryRows - 2)
    const shown = finished.slice(0, room)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{m.model === '' ? '主 session' : `主 session · ${shortModel(m.model)}`}</Text>
          {warn ? (
            <Text color="yellow" bold>{`主線連續工具呼叫 ${m.chain}`}</Text>
          ) : (
            <Text dimColor>{`主線連續工具呼叫 ${m.chain}`}</Text>
          )}
        </Box>

        {running.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{`執行中 (${running.length})`}</Text>
            {running.map(runningRow)}
          </Box>
        )}

        {stale.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{`失聯 (${stale.length})`}</Text>
            {stale.map(staleRow)}
          </Box>
        )}

        {finished.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{`已完成 (${finished.length})`}</Text>
            {shown.map(finishedRow)}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{'─'.repeat(Math.max(1, Math.min(cols, 60)))}</Text>
          {list.length === 0 ? (
            <Text dimColor>還沒有派工。派出 subagent 後這裡會即時顯示。</Text>
          ) : (
            <Box flexDirection="column">
              <Box flexDirection="row" gap={2} flexWrap="wrap">
                {sum.groups.map(g => {
                  const body = `${g.label} ×${g.count} · ${fmtK(g.tokens)}`
                  return g.family ? (
                    <Text color={FAMILY_COLOR[g.family]}>{body}</Text>
                  ) : (
                    <Text dimColor>{body}</Text>
                  )
                })}
              </Box>
              <Text bold>
                {`派工花費約 ${fmtUsd(sum.cost)}｜全用 Opus 約 ${fmtUsd(sum.opusCost)}｜${
                  sum.savedPct === undefined
                    ? '省下 —'
                    : sum.savedPct >= 0
                      ? `省下 ${Math.round(sum.savedPct)}%`
                      : `多花 ${Math.round(-sum.savedPct)}%`
                }`}
              </Text>
              <Text dimColor>以 API 價格估算</Text>
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
