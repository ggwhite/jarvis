export type CrewStatus = 'running' | 'done' | 'failed' | 'stale'

export type CrewAgent = {
  id: string
  type: string
  description: string
  model: string
  status: CrewStatus
  tool: string
  runStartedAt: number
  lastSeenAt: number
  doneMs: number
  endedAt: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

// One finished tool call, main loop or subagent. `ts` is when it started.
export type CrewEvent = {
  ts: number
  source: string
  isMain: boolean
  tool: string
  desc: string
  ms: number
  ok: boolean
}

export type CrewMain = {
  model: string
  chain: number
  ok: number
  fail: number
  lastTool: string
  lastDesc: string
  isRunning: boolean
  runSince: number
}

export type CrewTick = { n: number; now: number }

declare module 'claude-code' {
  interface PluginState {
    crew: { agents: CrewAgent[]; main: CrewMain; tick: CrewTick; events: CrewEvent[] }
  }
}
