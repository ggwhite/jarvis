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
// `actor` tells who ran it: MAIN_ACTOR for the main loop, the agentId for a subagent
// (two workers have two actors); `source` is only the display label.
export type CrewEvent = {
  ts: number
  actor: string
  source: string
  isMain: boolean
  tool: string
  desc: string
  ms: number
  ok: boolean
}

// A tool call that has started and not yet returned. `key` is unique per call.
export type CrewInflight = {
  key: string
  actor: string
  source: string
  tool: string
  startedAt: number
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
    crew: {
      agents: CrewAgent[]
      main: CrewMain
      tick: CrewTick
      events: CrewEvent[]
      inflight: CrewInflight[]
    }
  }
}
