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

export type CrewMain = { model: string; chain: number }

export type CrewTick = { n: number; now: number }

declare module 'claude-code' {
  interface PluginState {
    crew: { agents: CrewAgent[]; main: CrewMain; tick: CrewTick }
  }
}
