import type { CrewAgent } from '../types'

export const MAX_AGENTS = 50
export const CHAIN_WARN = 4
export const STALE_MS = 10 * 60 * 1000
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export type Family = 'fable' | 'opus' | 'sonnet' | 'haiku'

const FAMILIES: Family[] = ['fable', 'opus', 'sonnet', 'haiku']

export const FAMILY_NAME: Record<Family, string> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
}

export const FAMILY_COLOR: Record<Family, string> = {
  fable: 'magenta',
  opus: 'yellow',
  sonnet: 'blue',
  haiku: 'cyan',
}

// USD per million tokens, input / output.
export const PRICES: Record<Family, { in: number; out: number }> = {
  fable: { in: 10, out: 50 },
  opus: { in: 4, out: 20 },
  sonnet: { in: 2, out: 10 },
  haiku: { in: 0.1, out: 0.5 },
}

export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Completion = {
  reason: string
  durationMs: number
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
    model: string
  }
}

export type Spawned = {
  id: string
  type: string
  description: string
  model: string
  now: number
}

export function familyOf(id: string): Family | undefined {
  const lower = id.toLowerCase()
  return FAMILIES.find(f => lower.includes(f))
}

export function shortModel(id: string): string {
  const family = familyOf(id)
  if (!family) return id === '' ? '?' : id
  const lower = id.toLowerCase()
  const before = new RegExp(`claude-(\\d{1,2})(?:-(\\d{1,2}))?-${family}`).exec(lower)
  const after = new RegExp(`${family}[-_ ]?(\\d{1,2})(?:[-.](\\d{1,2}))?(?!\\d)`).exec(lower)
  const hit = before ?? after
  const name = FAMILY_NAME[family]
  if (!hit || hit[1] === undefined) return name
  return hit[2] === undefined ? `${name} ${hit[1]}` : `${name} ${hit[1]}.${hit[2]}`
}

export function tokenTotal(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

export function tokensOf(a: CrewAgent): Tokens {
  return { input: a.input, output: a.output, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite }
}

// cache read = input price x 0.1, cache write = input price x 1.25.
export function costAt(t: Tokens, family: Family): number {
  const p = PRICES[family]
  return (
    (t.input * p.in + t.output * p.out + t.cacheRead * p.in * 0.1 + t.cacheWrite * p.in * 1.25) /
    1_000_000
  )
}

export type Group = { label: string; family?: Family; count: number; tokens: number }

export type Summary = {
  groups: Group[]
  cost: number
  opusCost: number
  savedPct: number | undefined
}

export function summarize(agents: readonly CrewAgent[]): Summary {
  const byKey = new Map<string, Group>()
  let cost = 0
  let opusCost = 0
  for (const a of agents) {
    const family = familyOf(a.model)
    const key = family ?? 'other'
    const group = byKey.get(key) ?? {
      label: family ? FAMILY_NAME[family] : '其他',
      ...(family ? { family } : {}),
      count: 0,
      tokens: 0,
    }
    group.count += 1
    group.tokens += tokenTotal(tokensOf(a))
    byKey.set(key, group)
    if (family) {
      cost += costAt(tokensOf(a), family)
      opusCost += costAt(tokensOf(a), 'opus')
    }
  }
  const groups = [...byKey.values()].sort((x, y) => y.tokens - x.tokens)
  const savedPct = opusCost > 0 ? ((opusCost - cost) / opusCost) * 100 : undefined
  return { groups, cost, opusCost, savedPct }
}

export function fmtK(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export function fmtUsd(x: number): string {
  if (x >= 1) return `$${x.toFixed(2)}`
  if (x === 0) return '$0'
  return `$${x.toFixed(3)}`
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

export function elapsedMs(a: CrewAgent, now: number): number {
  if (a.status === 'running') return a.doneMs + Math.max(0, now - a.runStartedAt)
  if (a.status === 'stale') return a.doneMs + Math.max(0, a.lastSeenAt - a.runStartedAt)
  return a.doneMs
}

function trim(list: CrewAgent[]): CrewAgent[] {
  const out = list.slice()
  while (out.length > MAX_AGENTS) {
    const idx = out.findIndex(a => a.status !== 'running')
    out.splice(idx === -1 ? 0 : idx, 1)
  }
  return out
}

export function addAgent(list: readonly CrewAgent[], s: Spawned): CrewAgent[] {
  const fresh: CrewAgent = {
    id: s.id,
    type: s.type,
    description: s.description,
    model: s.model,
    status: 'running',
    tool: '',
    runStartedAt: s.now,
    lastSeenAt: s.now,
    doneMs: 0,
    endedAt: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
  return trim([...list.filter(a => a.id !== s.id), fresh])
}

// A tool call inside a subagent: shows the tool, and marks a subagent that was
// finished and called a tool again (SendMessage resumed it) as running. A stale
// one that is heard from again was running all along: its run keeps counting.
export function noteTool(
  list: readonly CrewAgent[],
  id: string,
  tool: string,
  now: number,
): CrewAgent[] {
  return list.map(a => {
    if (a.id !== id) return a
    if (a.status === 'running') return { ...a, tool, lastSeenAt: now }
    if (a.status === 'stale') return { ...a, tool, status: 'running', lastSeenAt: now }
    return { ...a, tool, status: 'running', runStartedAt: now, lastSeenAt: now, endedAt: 0 }
  })
}

// A turn of a subagent ended: usage accumulates across the turns of one agent.
export function finishTurn(
  list: readonly CrewAgent[],
  id: string,
  c: Completion,
  now: number,
): CrewAgent[] {
  return list.map(a => {
    if (a.id !== id) return a
    const u = c.usage
    return {
      ...a,
      status: c.reason === 'answer' ? 'done' : 'failed',
      tool: '',
      lastSeenAt: now,
      endedAt: now,
      doneMs: a.doneMs + Math.max(0, c.durationMs),
      model: a.model === '' && u ? u.model : a.model,
      input: a.input + (u?.input_tokens ?? 0),
      output: a.output + (u?.output_tokens ?? 0),
      cacheRead: a.cacheRead + (u?.cache_read_input_tokens ?? 0),
      cacheWrite: a.cacheWrite + (u?.cache_creation_input_tokens ?? 0),
    }
  })
}

// A running subagent with no tool call or finished turn for STALE_MS is lost.
// Returns the same array when nothing changed.
export function markStale(list: readonly CrewAgent[], now: number): readonly CrewAgent[] {
  if (!list.some(a => a.status === 'running' && now - a.lastSeenAt > STALE_MS)) return list
  return list.map(a =>
    a.status === 'running' && now - a.lastSeenAt > STALE_MS
      ? { ...a, status: 'stale' as const, tool: '' }
      : a,
  )
}

export function staleOf(list: readonly CrewAgent[]): CrewAgent[] {
  return list.filter(a => a.status === 'stale')
}

export function runningOf(list: readonly CrewAgent[]): CrewAgent[] {
  return list.filter(a => a.status === 'running')
}

export function finishedOf(list: readonly CrewAgent[]): CrewAgent[] {
  return list
    .map((a, i) => ({ a, i }))
    .filter(x => x.a.status === 'done' || x.a.status === 'failed')
    .sort((x, y) => y.a.endedAt - x.a.endedAt || y.i - x.i)
    .map(x => x.a)
}
