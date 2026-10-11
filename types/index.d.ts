export type JarvisStatus = 'running' | 'done' | 'failed' | 'stale'

export type JarvisAgent = {
  id: string
  type: string
  description: string
  model: string
  status: JarvisStatus
  tool: string
  runStartedAt: number
  lastSeenAt: number
  doneMs: number
  endedAt: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  // dispatch order, picks the squad member's color; missing on records from before it was kept
  seq?: number
  // set when a workflow script's agent() started it: the run and its place in the run
  runId?: string
  agentIndex?: number
}

// One finished tool call, main loop or subagent. `ts` is when it started.
// `actor` tells who ran it: MAIN_ACTOR for the main loop, the agentId for a subagent
// (two workers have two actors); `source` is only the display label.
export type JarvisEvent = {
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
export type JarvisInflight = {
  key: string
  actor: string
  source: string
  tool: string
  desc?: string
  startedAt: number
}

export type JarvisMain = {
  model: string
  chain: number
  ok: number
  fail: number
  lastTool: string
  lastDesc: string
  isRunning: boolean
  runSince: number
}

export type JarvisTick = { n: number; now: number }

// ---- 艦隊 ----

// How herdr reports a Claude session: waiting on the person (blocked), working, or the rest.
export type FleetStatus = 'blocked' | 'working' | 'idle'

// What a transcript's tail says: the last human prompt and reply, the model, when it last
// spoke, the times of its recent replies (the heartbeat) and its recent tool calls.
export type FleetTail = {
  lastUser?: string
  lastReply?: string
  model?: string
  lastAt?: number
  stamps: number[]
  tools: number
}

// One Claude session of the fleet: its herdr pane, its tail and today's use.
export type FleetSession = FleetTail & {
  paneId: string
  // the herdr tab holding the pane
  tabId: string
  // '' when herdr knows no session id for the pane
  sessionId: string
  title: string
  status: FleetStatus
  cwd: string
  workspace: string
  contextPct?: number
  todayTokens: number
  todayCost: number
}

// A quota window: used percent, when it resets (ms) and how long it is (minutes).
export type QuotaWindow = { usedPct: number; resetsAt: number; windowMin: number }

export type FleetQuota = { fiveHour?: QuotaWindow; sevenDay?: QuotaWindow; fetchedAt: number }

export type FleetJumpError = { paneId: string; text: string }

export type FleetView = {
  // when it was last refreshed; 0 before the first
  at: number
  sessions: FleetSession[]
  quota?: FleetQuota
  // herdr did not answer on the last refresh: the sessions are the last known
  linkLost: boolean
  // today's first scan of the transcripts has not finished
  scanning: boolean
  jumpError?: FleetJumpError
}

// How far a transcript has been read for today's count, and its last tail.
export type FleetFile = {
  size: number
  mtimeMs: number
  offset: number
  day: string
  tokens: number
  cost: number
  // the last assistant message counted: its lines repeat its usage
  lastMsgId: string
  tail: FleetTail
  // the day the file was last read to its end: until then it is still being scanned
  caughtUpDay?: string
  // when it was last read: the longest unread is read first
  readAt?: number
}

export type FleetCursor = Record<string, FleetFile>

export type JarvisPage = 'now' | 'log' | 'stats' | 'detail' | 'fleet' | 'fleetDetail'

// What the pane shows: the page, the subagent the detail page is about, and whether the
// event stream is paused at `pausedTotal` events recorded.
export type JarvisUi = {
  page: JarvisPage
  agentId: string
  paused: boolean
  pausedTotal: number
  // the session the fleet detail page is about
  paneId: string
}

declare module 'claude-code' {
  interface PluginState {
    jarvis: {
      agents: JarvisAgent[]
      main: JarvisMain
      tick: JarvisTick
      events: JarvisEvent[]
      inflight: JarvisInflight[]
      ui: JarvisUi
      // every event ever recorded this session, past the MAX_EVENTS kept
      eventTotal: number
      fleet: FleetView
      fleetCursor: FleetCursor
    }
  }
}
