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
  // the engine says it is waiting on background work it owns: running, shown as WAITING
  waiting?: boolean
  // brought back to running by the engine's view after its turn ended: the engine's view
  // also ends it
  revived?: boolean
  // the engine has said it ended: its view is not asked for again
  confirmed?: boolean
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
  toolCounts?: Record<string, number>
}

export type JarvisTick = { n: number; now: number }

// The standby suit's frame count, when a crew member was last deployed, and whether a press
// holds it still.
export type JarvisSuit = { n: number; deployedAt?: number; paused?: boolean }

// ---- 任務 ----

export type JarvisTaskStatus = 'pending' | 'in_progress' | 'completed'

// One step of a work item. `agentId` names the subagent doing it (drawn as its MK-N);
// `extId` is the built-in task tool's id of a step mirrored from TaskCreate.
export type JarvisSubtask = {
  id: string
  title: string
  status: JarvisTaskStatus
  agentId?: string
  extId?: string
  // when it last started running, and when it completed (ms); absent without a clock
  startedAt?: number
  endedAt?: number
}

// One work item. Its own `status` counts only while it has no subtasks; `nextSub` numbers
// the next subtask. `origin` says where it came from: `request` for a request the person
// sent (jarvis made it), `todo:<actor>` for TodoWrite, `tasks` for TaskCreate; none for the
// model's own. A request item keeps `key`, its prompt's title as made; `turnId`, the
// main-loop turn it is tied to; `queued` when it was typed while a turn ran.
export type JarvisTaskItem = {
  id: string
  title: string
  status: JarvisTaskStatus
  subtasks: JarvisSubtask[]
  nextSub: number
  origin?: string
  key?: string
  turnId?: string
  queued?: true
  // when its own status last started running, and when it completed (ms)
  startedAt?: number
  endedAt?: number
}

// The session's task board; `nextItem` numbers the next item, ids are never reused.
export type JarvisTaskBoard = { items: JarvisTaskItem[]; nextItem: number }

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
  // the tool called last and not yet answered by its result
  tool?: string
  // when the person last typed a prompt: the run so far
  runSince?: number
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
  // today's input + output tokens by local hour, its transcript and its subagents';
  // missing on a view kept from before it was counted
  hourly?: number[]
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
  // today's input + output tokens of the whole fleet by local hour, 0 to 23
  hourly: number[]
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
  // today's input + output tokens of this file by local hour
  hourly?: number[]
}

export type FleetCursor = Record<string, FleetFile>

// A file this session's edit tools changed: the repo it stands in (null outside git), who
// changed it in order, when it was first seen, how many edits, and its content before
// the first: a cache file, '/dev/null' for a file the session created, '' when unknown.
// A repo that is a linked worktree also names the repo it was added from and its name.
export type JarvisChange = {
  path: string
  repo: string | null
  actors: string[]
  seq: number
  touches: number
  orig: string
  mainRepo?: string
  worktree?: string
}

export type JarvisPage =
  | 'now'
  | 'log'
  | 'stats'
  | 'roleDetail'
  | 'detail'
  | 'fleet'
  | 'fleetDetail'
  | 'changes'
  | 'changeDiff'
  | 'commitTree'
  | 'commitDiff'
  | 'stashDiff'
  | 'tasks'

// What the pane shows: the page, the subagent the detail page is about, and whether the
// event stream is paused at `pausedTotal` events recorded.
export type JarvisUi = {
  page: JarvisPage
  agentId: string
  paused: boolean
  pausedTotal: number
  // the session the fleet detail page is about
  paneId: string
  // the changes page's mode; absent is the session's own changes
  changesMode?: 'session' | 'unpushed' | 'commits'
  // the changes page's file the diff page is about, by its row's key
  diffKey?: string
  // the dispatch role the role page is about
  role?: string
  // the page the detail page was opened from, when its 返回 goes back there
  detailFrom?: JarvisPage
  // the commits mode: the repo its tree page is about, the commit its diff page is about,
  // and the file that page shows (absent: the commit's first)
  commitRepo?: string
  commitSha?: string
  commitFile?: string
  // the tree page's sub-page (absent: its commits), the branch it logs (a full refname;
  // absent: HEAD), where its 返回 goes when opened from a branch or a worktree row (`back`:
  // where the worktree a branch was opened in goes back to after), and the stash the stash
  // diff page is about, by its commit
  repoView?: 'log' | 'branches' | 'stash' | 'worktrees'
  commitRef?: string
  repoBack?: { repo: string; view: 'branches' | 'worktrees'; back?: { repo: string; view: 'branches' | 'worktrees' } }
  stashSha?: string
  // the 分支 sub-page's gone and 只在遠端 groups are open (absent: folded); a repo opened or a
  // /clear folds them
  goneOpen?: boolean
  remoteOpen?: boolean
  // the 任務 page's fold choices by item id (true: its subtasks hidden); absent is each item's
  // default; a /clear forgets them
  taskFolds?: Record<string, boolean>
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
      // the usagebar cache as the standby suit last read it; null when it was not there
      standbyQuota: FleetQuota | null
      suit: JarvisSuit
      // the files this session's edit tools changed, in the order first seen
      changes: JarvisChange[]
      // the session's task board, kept by the model through mcp__jarvis__task
      tasks: JarvisTaskBoard
    }
  }

  // the board's own tool, registered at session.start
  interface McpToolInputs {
    mcp__jarvis__task: Record<string, unknown>
  }
}
