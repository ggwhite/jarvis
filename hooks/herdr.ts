import type { CrewAgent } from '../types'
import { runningOf, staleOf, summarize } from './crew'
import type { Health } from './crew'

export const THROTTLE_MS = 2000
export const TTL_MS = 900_000
// Resent unchanged before TTL_MS lapses, so a quiet row does not expire.
export const REFRESH_MS = 600_000
export const MAX_FAILURES = 3
export const RUN_TIMEOUT_MS = 5000

const WARN_PREFIX: Record<Health, string> = { ok: '', loop: '⚠繞圈 ', stuck: '⚠卡住 ' }

// The sidebar text for a session's crew; undefined when there is nothing to show.
// A health warning leads the text, and shows even with no subagents.
export function crewText(list: readonly CrewAgent[], health: Health = 'ok'): string | undefined {
  const body = countsText(list)
  const prefix = WARN_PREFIX[health]
  if (prefix === '') return body
  return body === undefined ? prefix.trimEnd() : `${prefix}${body}`
}

function countsText(list: readonly CrewAgent[]): string | undefined {
  if (list.length === 0) return undefined
  const running = runningOf(list).length
  const stale = staleOf(list).length
  const finished = list.length - running - stale
  const counts = [
    running > 0 ? `▶${running}` : '',
    finished > 0 ? `✓${finished}` : '',
    stale > 0 ? `⚠${stale}` : '',
  ].filter(x => x !== '')
  const saved = summarize(list).savedPct
  if (saved === undefined) return counts.join(' ')
  const pct = Math.round(saved)
  const tail = pct >= 0 ? `省${pct}%` : `多花${-pct}%`
  return `${counts.join(' ')} · ${tail}`
}

export function inHerdr(env: string | undefined, paneId: string | undefined): boolean {
  return env === '1' && paneId !== undefined && paneId !== ''
}

export function reportArgv(paneId: string, text: string | undefined): string[] {
  const head = ['herdr', 'pane', 'report-metadata', paneId, '--source', 'crew']
  return text === undefined
    ? [...head, '--clear-token', 'crew']
    : [...head, '--token', `crew=${text}`, '--ttl-ms', String(TTL_MS)]
}

export type Reporter = {
  step: (want: string | undefined, now: number) => Promise<void>
  isStopped: () => boolean
}

// Reports `want` through `run` only when it differs from what was last sent and
// at least THROTTLE_MS after the previous send. A failed send is not retried;
// MAX_FAILURES in a row stop the reporter for good. The caller keeps calling
// `step`, so the last change is sent as soon as the throttle allows.
export function createReporter(
  paneId: string,
  run: (argv: string[]) => Promise<boolean>,
): Reporter {
  let sent: string | undefined
  let sentAt = Number.NEGATIVE_INFINITY
  let failures = 0
  let stopped = false
  let busy = false

  return {
    isStopped: () => stopped,
    async step(want, now) {
      if (stopped || busy) return
      if (want === sent && (want === undefined || now - sentAt < REFRESH_MS)) return
      if (now - sentAt < THROTTLE_MS) return
      busy = true
      try {
        let ok = false
        try {
          ok = await run(reportArgv(paneId, want))
        } catch {
          ok = false
        }
        sent = want
        sentAt = now
        failures = ok ? 0 : failures + 1
        if (failures >= MAX_FAILURES) stopped = true
      } finally {
        busy = false
      }
    },
  }
}
