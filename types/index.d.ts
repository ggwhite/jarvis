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
  // dispatch order, picks the crew member's color; missing on records from before it was kept
  seq?: number
  // set when a workflow script's agent() started it: the run and its place in the run
  runId?: string
  agentIndex?: number
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
// `desc` is optional: a call recorded by an earlier load of the module has none.
export type CrewInflight = {
  key: string
  actor: string
  source: string
  tool: string
  desc?: string
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

export type CrewPage = 'now' | 'log' | 'stats' | 'detail'

// What the pane shows: the page, the subagent the detail page is about, and whether the
// event stream is paused at `pausedTotal` events recorded.
export type CrewUi = {
  page: CrewPage
  agentId: string
  paused: boolean
  pausedTotal: number
}

declare module 'claude-code' {
  interface PluginState {
    crew: {
      agents: CrewAgent[]
      main: CrewMain
      tick: CrewTick
      events: CrewEvent[]
      inflight: CrewInflight[]
      ui: CrewUi
      // every event ever recorded this session, past the MAX_EVENTS kept
      eventTotal: number
    }
  }
}
