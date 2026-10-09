import type { CrewAgent, CrewEvent, CrewInflight, CrewMain } from '../types'

export const MAX_AGENTS = 50
export const CHAIN_WARN = 4
export const STALE_MS = 10 * 60 * 1000
export const MAX_EVENTS = 200
export const MAIN_SOURCE = '主線'
export const MAIN_ACTOR = 'main'
export const LOOP_FAILS = 3
export const STUCK_MS = 5 * 60 * 1000
export const PACE_BUCKETS = 10
export const BUCKET_MS = 60_000
export const DESC_MAX = 60
// Subagents on the list that take a digit hotkey to their detail page.
export const MAX_NUMBERED = 9
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
  workflow?: { runId: string; agentIndex: number }
}

// The family named in any model id, whatever generation: for display.
export function nameFamilyOf(id: string): Family | undefined {
  const lower = id.toLowerCase()
  return FAMILIES.find(f => lower.includes(f))
}

// The family of a generation 5 model (or a bare alias); undefined means unpriced.
export function familyOf(id: string): Family | undefined {
  const lower = id.toLowerCase().trim()
  for (const f of FAMILIES) {
    if (new RegExp(`^${f}(?:\\[[^\\]]*\\])?$`).test(lower)) return f
    if (new RegExp(`(?:^|[^a-z])${f}-5(?!\\d)`).test(lower)) return f
  }
  return undefined
}

export function shortModel(id: string): string {
  const family = nameFamilyOf(id)
  if (!family) return id === '' ? '?' : id
  const lower = id.toLowerCase()
  const before = new RegExp(`claude-(\\d{1,2})(?:-(\\d{1,2}))?-${family}`).exec(lower)
  const after = new RegExp(`${family}[-_ ]?(\\d{1,2})(?:[-.](\\d{1,2}))?(?!\\d)`).exec(lower)
  const hit = before ?? after
  const name = FAMILY_NAME[family]
  if (!hit || hit[1] === undefined) return name
  return hit[2] === undefined ? `${name} ${hit[1]}` : `${name} ${hit[1]}.${hit[2]}`
}

// Shown token count: input + output only; cache traffic is left out.
export function tokenTotal(t: Tokens): number {
  return t.input + t.output
}

export function tokensOf(a: CrewAgent): Tokens {
  return { input: a.input, output: a.output, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite }
}

// cache read = input price x 0.1 (Fable: x 0.025), cache write = input price x 1.25.
export function cacheReadMultiplier(family: Family): number {
  return family === 'fable' ? 0.025 : 0.1
}

export function costAt(t: Tokens, family: Family): number {
  const p = PRICES[family]
  return (
    (t.input * p.in +
      t.output * p.out +
      t.cacheRead * p.in * cacheReadMultiplier(family) +
      t.cacheWrite * p.in * 1.25) /
    1_000_000
  )
}

export type Group = { label: string; family?: Family; count: number }

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
    }
    group.count += 1
    byKey.set(key, group)
    if (family) {
      cost += costAt(tokensOf(a), family)
      opusCost += costAt(tokensOf(a), 'opus')
    }
  }
  const groups = [...byKey.values()].sort((x, y) => y.count - x.count)
  // rounded to 1e-6 so float noise (97.4999…) does not flip the displayed percent
  const savedPct = opusCost > 0 ? Math.round(((opusCost - cost) / opusCost) * 1e8) / 1e6 : undefined
  return { groups, cost, opusCost, savedPct }
}

export function fmtK(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export function fmtUsd(x: number): string {
  if (x >= 0.01) return `$${x.toFixed(2)}`
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
    ...(s.workflow ? { runId: s.workflow.runId, agentIndex: s.workflow.agentIndex } : {}),
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

// The one-line summary: models by use count, estimated cost against all-Opus.
export function summaryLine(sum: Summary): string {
  const models = sum.groups.map(g => `${g.label}×${g.count}`).join(' ')
  if (sum.savedPct === undefined) return `${models} · 未計價`
  const pct = Math.round(sum.savedPct)
  const tail = pct >= 0 ? `省${pct}%` : `多花${-pct}%`
  return `${models} · ≈${fmtUsd(sum.cost)} vs Opus ${fmtUsd(sum.opusCost)}（${tail}）`
}

export type Health = 'ok' | 'loop' | 'stuck'

export type Role = 'Explore' | 'clerk' | 'worker' | 'verifier' | 'fork' | 'workflow' | 'other'

export const ROLES: Role[] = ['Explore', 'clerk', 'worker', 'verifier', 'fork', 'workflow', 'other']

export const ROLE_LABEL: Record<Role, string> = {
  Explore: 'Explore',
  clerk: 'clerk',
  worker: 'worker',
  verifier: 'verifier',
  fork: 'fork',
  workflow: 'workflow',
  other: '其他',
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(x => x !== '')
  return parts[parts.length - 1] ?? ''
}

// The short line a tool call shows as in the event stream.
export function describeCall(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash': {
      const note = str(input['description']).trim()
      if (note !== '') return truncate(note, DESC_MAX)
      const first = str(input['command']).split('\n').find(l => l.trim() !== '') ?? ''
      return truncate(first, DESC_MAX)
    }
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return truncate(baseName(str(input['file_path'])), DESC_MAX)
    case 'NotebookEdit':
      return truncate(baseName(str(input['notebook_path'])), DESC_MAX)
    case 'Grep':
    case 'Glob':
      return truncate(str(input['pattern']), DESC_MAX)
    case 'Agent':
      return truncate(str(input['description']), DESC_MAX)
    default:
      return ''
  }
}

// Keeps the latest MAX_EVENTS events, oldest first.
export function addEvent(list: readonly CrewEvent[], ev: CrewEvent): CrewEvent[] {
  return [...list, ev].slice(-MAX_EVENTS)
}

// Tool calls per minute over the last PACE_BUCKETS minutes, oldest bucket first.
// A call counts by its start; one older than the window, or later than `now`, is left out.
export function paceBuckets(events: readonly CrewEvent[], now: number): number[] {
  const out = Array.from({ length: PACE_BUCKETS }, () => 0)
  for (const ev of events) {
    const age = now - ev.ts
    if (age < 0 || age >= PACE_BUCKETS * BUCKET_MS) continue
    const idx = PACE_BUCKETS - 1 - Math.floor(age / BUCKET_MS)
    out[idx] = (out[idx] ?? 0) + 1
  }
  return out
}

export type HealthScope = {
  // tool calls that started and have not returned
  inFlight?: number
  // ids of the subagents that are still running
  liveAgents?: ReadonlySet<string>
}

// One executor's own events, oldest first. The main loop is one executor; each subagent
// is another, by agentId, so two workers never merge.
function looping(events: readonly CrewEvent[], live: ReadonlySet<string>): boolean {
  const byActor = new Map<string, CrewEvent[]>()
  for (const ev of events) {
    if (!ev.isMain && !live.has(ev.actor)) continue
    const key = `${ev.isMain ? 'm' : 's'}:${ev.actor}`
    const list = byActor.get(key)
    if (list) list.push(ev)
    else byActor.set(key, [ev])
  }
  for (const list of byActor.values()) {
    const tail = list.slice(-LOOP_FAILS)
    const first = tail[0]
    if (
      first !== undefined &&
      tail.length === LOOP_FAILS &&
      tail.every(ev => !ev.ok && ev.tool === first.tool)
    ) {
      return true
    }
  }
  return false
}

// loop: one executor's own latest LOOP_FAILS events are the same tool failing; only the
// main loop and running subagents count, so a finished subagent leaves no loop behind.
// stuck: something is running (`activeSince` is when the latest run began, undefined
// when nothing runs), no tool call is in flight, and nothing has finished or begun for
// STUCK_MS. loop wins over stuck.
export function healthOf(
  events: readonly CrewEvent[],
  now: number,
  activeSince: number | undefined,
  scope: HealthScope = {},
): Health {
  if (looping(events, scope.liveAgents ?? new Set())) return 'loop'
  if (activeSince === undefined) return 'ok'
  if ((scope.inFlight ?? 0) > 0) return 'ok'
  const last = events.reduce((m, ev) => Math.max(m, ev.ts + ev.ms), activeSince)
  return now - last > STUCK_MS ? 'stuck' : 'ok'
}

// The Explore / clerk / worker / verifier / fork roles by subagent type; a fork is
// spawned with the type `fork`. Any other type (general-purpose, Plan, a plugin's) is other.
export function roleOf(type: string): Role {
  const lower = type.trim().toLowerCase()
  return ROLES.find(r => r !== 'other' && r !== 'workflow' && r.toLowerCase() === lower) ?? 'other'
}

// A workflow script's agents count as the workflow role, whatever their type.
export function dispatchRoleOf(a: CrewAgent): Role {
  return a.runId !== undefined ? 'workflow' : roleOf(a.type)
}

export type RoleStat = { role: Role; label: string; running: number; done: number; failed: number }

export function dispatchStats(agents: readonly CrewAgent[]): RoleStat[] {
  const stats = ROLES.map(role => ({ role, label: ROLE_LABEL[role], running: 0, done: 0, failed: 0 }))
  for (const a of agents) {
    const stat = stats.find(x => x.role === dispatchRoleOf(a))
    if (!stat) continue
    if (a.status === 'running') stat.running += 1
    else if (a.status === 'done') stat.done += 1
    else if (a.status === 'failed') stat.failed += 1
  }
  return stats
}

// share is the fraction (0..1) of the priced total; unpriced models cost 0.
export type ModelShare = { label: string; family?: Family; count: number; cost: number; share: number }

export function modelShares(agents: readonly CrewAgent[]): ModelShare[] {
  const byKey = new Map<string, ModelShare>()
  let total = 0
  for (const a of agents) {
    const family = familyOf(a.model)
    const key = family ?? 'other'
    const row = byKey.get(key) ?? {
      label: family ? FAMILY_NAME[family] : '其他',
      ...(family ? { family } : {}),
      count: 0,
      cost: 0,
      share: 0,
    }
    row.count += 1
    if (family) {
      const c = costAt(tokensOf(a), family)
      row.cost += c
      total += c
    }
    byKey.set(key, row)
  }
  const rows = [...byKey.values()].sort((x, y) => y.cost - x.cost || y.count - x.count)
  for (const row of rows) row.share = total > 0 ? row.cost / total : 0
  return rows
}

// A model's share as a label: under 1% of the cost, a model that was used reads <1%.
export function shareLabel(share: number): string {
  return share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`
}

// One row group of the subagent list: a lone subagent, or a workflow run's agents.
export type ListUnit =
  | { kind: 'agent'; agent: CrewAgent }
  | { kind: 'workflow'; runId: string; agents: CrewAgent[] }

export type ListSection = {
  status: 'running' | 'stale' | 'finished'
  // the subagents in that status, all of them
  count: number
  units: ListUnit[]
}

const RANK: Record<CrewAgent['status'], number> = { running: 0, stale: 1, done: 2, failed: 2 }
const SECTION: ListSection['status'][] = ['running', 'stale', 'finished']

// The subagent list as drawn: running first, then lost, then finished (latest first). A
// workflow run's agents are one unit, in the section of its liveliest agent, by agentIndex.
export function agentSections(agents: readonly CrewAgent[]): ListSection[] {
  type Slot = { unit: ListUnit; rank: number; first: number; ended: number }
  const slots: Slot[] = []
  const runs = new Map<string, Slot>()
  agents.forEach((a, i) => {
    if (a.runId === undefined) {
      slots.push({ unit: { kind: 'agent', agent: a }, rank: RANK[a.status], first: i, ended: a.endedAt })
      return
    }
    const slot = runs.get(a.runId)
    if (slot && slot.unit.kind === 'workflow') {
      slot.unit.agents.push(a)
      slot.rank = Math.min(slot.rank, RANK[a.status])
      slot.ended = Math.max(slot.ended, a.endedAt)
      return
    }
    const fresh: Slot = {
      unit: { kind: 'workflow', runId: a.runId, agents: [a] },
      rank: RANK[a.status],
      first: i,
      ended: a.endedAt,
    }
    runs.set(a.runId, fresh)
    slots.push(fresh)
  })
  for (const slot of runs.values()) {
    if (slot.unit.kind !== 'workflow') continue
    slot.unit.agents = slot.unit.agents
      .map((a, i) => ({ a, i }))
      .sort((x, y) => (x.a.agentIndex ?? Infinity) - (y.a.agentIndex ?? Infinity) || x.i - y.i)
      .map(x => x.a)
  }
  return SECTION.map((status, rank) => {
    const units = slots
      .filter(s => s.rank === rank)
      .sort((x, y) => (rank === 2 ? y.ended - x.ended || y.first - x.first : x.first - y.first))
      .map(s => s.unit)
    const count = agents.filter(a => RANK[a.status] === rank).length
    return { status, count, units }
  }).filter(s => s.units.length > 0)
}

// Every subagent in the order the list draws it.
export function listOrder(sections: readonly ListSection[]): CrewAgent[] {
  return sections.flatMap(s => s.units.flatMap(u => (u.kind === 'agent' ? [u.agent] : u.agents)))
}

export type CrewState = {
  agents: readonly CrewAgent[]
  main: CrewMain
  events: readonly CrewEvent[]
  inflight?: readonly CrewInflight[]
}

// When the latest running thing began: the main turn, or a running subagent.
export function activeSinceOf(state: CrewState): number | undefined {
  const starts = runningOf(state.agents).map(a => a.runStartedAt)
  if (state.main.isRunning) starts.push(state.main.runSince)
  return starts.length === 0 ? undefined : Math.max(...starts)
}

export function healthOfState(state: CrewState, now: number): Health {
  return healthOf(state.events, now, activeSinceOf(state), {
    inFlight: state.inflight?.length ?? 0,
    liveAgents: new Set(runningOf(state.agents).map(a => a.id)),
  })
}

// Everything the layout draws, computed from the stored state at `now`.
export type Cockpit = {
  now: number
  health: Health
  main: {
    model: string
    chain: number
    ok: number
    fail: number
    lastTool: string
    lastDesc: string
    isRunning: boolean
  }
  // the latest MAX_EVENTS tool calls, oldest first
  events: CrewEvent[]
  // calls per minute for the last 10 minutes, oldest first, length PACE_BUCKETS
  pace: number[]
  // every role, in ROLES order
  dispatch: RoleStat[]
  // per priced model family, highest cost first; share sums to 1 (all 0 when nothing is priced)
  models: ModelShare[]
  running: CrewAgent[]
  stale: CrewAgent[]
  finished: CrewAgent[]
  // the subagent list as drawn, and the first MAX_NUMBERED of it, digit 1 first
  sections: ListSection[]
  numbered: CrewAgent[]
  // tool calls not yet returned, oldest first
  inflight: CrewInflight[]
  summary: Summary
}

export function buildCockpit(state: CrewState, now: number): Cockpit {
  const m = state.main
  const sections = agentSections(state.agents)
  return {
    now,
    health: healthOfState(state, now),
    main: {
      model: m.model,
      chain: m.chain,
      ok: m.ok,
      fail: m.fail,
      lastTool: m.lastTool,
      lastDesc: m.lastDesc,
      isRunning: m.isRunning,
    },
    events: [...state.events],
    pace: paceBuckets(state.events, now),
    dispatch: dispatchStats(state.agents),
    models: modelShares(state.agents),
    running: runningOf(state.agents),
    stale: staleOf(state.agents),
    finished: finishedOf(state.agents),
    sections,
    numbered: listOrder(sections).slice(0, MAX_NUMBERED),
    inflight: [...(state.inflight ?? [])].sort((x, y) => x.startedAt - y.startedAt),
    summary: summarize(state.agents),
  }
}

// Terminal cells a string takes: CJK and full-width forms take two, marks none.
export function cellWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0x300 && c <= 0x36f) || c === 0x200b || c === 0xfe0f) continue
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd)
    w += wide ? 2 : 1
  }
  return w
}

// Cuts text to at most `width` cells, with an ellipsis when something was cut.
export function fitCells(text: string, width: number): string {
  if (width <= 0) return ''
  if (cellWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = cellWidth(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

// Pads with spaces to exactly `width` cells (after cutting what is too long).
export function padCells(text: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const fit = fitCells(text, width)
  const gap = Math.max(0, width - cellWidth(fit))
  if (align === 'right') return ' '.repeat(gap) + fit
  if (align === 'center') {
    const left = Math.floor(gap / 2)
    return ' '.repeat(left) + fit + ' '.repeat(gap - left)
  }
  return fit + ' '.repeat(gap)
}

// Bar length in cells: `value` against `scale`, at most `width`, at least 1 when value > 0.
export function barLen(value: number, scale: number, width: number): number {
  if (value <= 0 || scale <= 0 || width <= 0) return 0
  return Math.min(width, Math.max(1, Math.round((value / scale) * width)))
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

// A vertical bar chart `height` rows tall: one string per row, top first, each value a
// column `barWidth` cells wide and `gap` apart. A zero is a thin ▁ on the bottom row.
export function paceChart(values: readonly number[], height: number, barWidth = 2, gap = 1): string[] {
  const peak = Math.max(1, ...values)
  const steps = height * 8
  const levels = values.map(v => (v <= 0 ? 0 : Math.max(1, Math.round((v / peak) * steps))))
  const rows: string[] = []
  for (let r = height - 1; r >= 0; r -= 1) {
    const cols = values.map((v, i) => {
      const level = Math.max(0, Math.min(8, (levels[i] ?? 0) - r * 8))
      const ch = level > 0 ? (BLOCKS[level - 1] ?? '█') : r === 0 && v <= 0 ? '▁' : ' '
      return ch.repeat(barWidth)
    })
    rows.push(cols.join(' '.repeat(gap)))
  }
  return rows
}

const two = (n: number): string => String(n).padStart(2, '0')

// Local wall-clock time, HH:MM:SS.
export function fmtClock(ts: number): string {
  const d = new Date(ts)
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

// A tool call's duration: 150ms, 2.9s, 20.9s, 1m05s.
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return fmtDur(ms)
}

export const SLOW_MS = 30_000
