import type { JarvisAgent, JarvisEvent, JarvisInflight, JarvisMain } from '../types'

export const MAX_AGENTS = 50
export const CHAIN_WARN = 4
export const STALE_MS = 10 * 60 * 1000
export const MAX_EVENTS = 200
export const MAIN_SOURCE = '主線'
export const MAIN_ACTOR = 'main'
export const LOOP_FAILS = 3
export const STUCK_MS = 5 * 60 * 1000
export const DESC_MAX = 60
// The highest MK number whose digit is a hotkey to its detail page.
export const MAX_NUMBERED = 9
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// The sweep a freshly dispatched squad member shows while it starts up.
export const SCAN = ['░▒▓', '▒▓░', '▓░▒']
// How long after its dispatch a squad member reads INITIALIZING.
export const INIT_MS = 2000
// The tick period while a squad member runs and the pane is in view (the animation),
// and otherwise; the pane counts as in view for SEEN_MS after it was last drawn.
export const ANIM_MS = 150
export const IDLE_MS = 1000
export const SEEN_MS = 5000
// Two events further apart than this are drawn with a dated rule between them.
export const BREAK_MS = 60 * 60 * 1000

// The HUD palette, Mark 42: the deep teal of frames and rules, ice blue text, amber for
// what runs and what is locked on, near white for the figures that matter, the alarm red
// of errors and warnings, the dark blue of what is finished or old; the suit's red and
// gold for the title.
export const THEME = {
  frame: '#2B9FC0',
  primary: '#5CE1FF',
  accent: '#F2B84B',
  bright: '#E6FBFF',
  error: '#FF3B30',
  muted: '#1F4E5F',
  suitRed: '#C8102E',
  suitGold: '#E8B04B',
} as const

// One color per squad member, by dispatch order; none is a theme tone or near the alarm red.
export const JARVIS_PALETTE = ['#3EC6FF', '#5EE6A8', '#9B8CFF', '#FF8FB1', '#D4E157', '#E6A7FF']

// The arc reactor beside the title: braille cells brightening and dimming while a squad
// member runs, amber at the dim end and near white at the bright; one dark cell at rest.
export const REACTOR = ['⣀', '⣤', '⣶', '⣿', '⣶', '⣤']
const REACTOR_COLOR = [THEME.accent, THEME.accent, THEME.bright, THEME.bright, THEME.bright, THEME.accent]
const REACTOR_IDLE = '⣿'

// The boot sequence /jarvis plays as the pane opens: ONLINE, then the manifest loading,
// full at BOOT_LOADED_MS and held there until BOOT_MS.
export const BOOT_MS = 1000
const BOOT_ONLINE_MS = 300
const BOOT_LOADED_MS = 850

// How long a squad member's retried call reads RELOCKED before it goes back to ACTIVE.
export const RELOCK_MS = 3000

export type Family = 'fable' | 'opus' | 'sonnet' | 'haiku'

const FAMILIES: Family[] = ['fable', 'opus', 'sonnet', 'haiku']

export const FAMILY_NAME: Record<Family, string> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
}

export const FAMILY_COLOR: Record<Family, string> = {
  fable: '#B388FF',
  opus: THEME.accent,
  sonnet: '#4D9FFF',
  haiku: THEME.primary,
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

export function tokensOf(a: JarvisAgent): Tokens {
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

export function summarize(agents: readonly JarvisAgent[]): Summary {
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

// An elapsed time as a readout: 0:05, 9:47, 1:02:05.
export function fmtReadout(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function elapsedMs(a: JarvisAgent, now: number): number {
  if (a.status === 'running') return a.doneMs + Math.max(0, now - a.runStartedAt)
  if (a.status === 'stale') return a.doneMs + Math.max(0, a.lastSeenAt - a.runStartedAt)
  return a.doneMs
}

function trim(list: JarvisAgent[]): JarvisAgent[] {
  const out = list.slice()
  while (out.length > MAX_AGENTS) {
    const idx = out.findIndex(a => a.status !== 'running')
    out.splice(idx === -1 ? 0 : idx, 1)
  }
  return out
}

export function addAgent(list: readonly JarvisAgent[], s: Spawned): JarvisAgent[] {
  const fresh: JarvisAgent = {
    id: s.id,
    seq: list.reduce((m, a, i) => Math.max(m, a.seq ?? i), -1) + 1,
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
  list: readonly JarvisAgent[],
  id: string,
  tool: string,
  now: number,
): JarvisAgent[] {
  return list.map(a => {
    if (a.id !== id) return a
    if (a.status === 'running') return { ...a, tool, lastSeenAt: now }
    if (a.status === 'stale') return { ...a, tool, status: 'running', lastSeenAt: now }
    return { ...a, tool, status: 'running', runStartedAt: now, lastSeenAt: now, endedAt: 0 }
  })
}

// A turn of a subagent ended: usage accumulates across the turns of one agent.
export function finishTurn(
  list: readonly JarvisAgent[],
  id: string,
  c: Completion,
  now: number,
): JarvisAgent[] {
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
export function markStale(list: readonly JarvisAgent[], now: number): readonly JarvisAgent[] {
  if (!list.some(a => a.status === 'running' && now - a.lastSeenAt > STALE_MS)) return list
  return list.map(a =>
    a.status === 'running' && now - a.lastSeenAt > STALE_MS
      ? { ...a, status: 'stale' as const, tool: '' }
      : a,
  )
}

export function staleOf(list: readonly JarvisAgent[]): JarvisAgent[] {
  return list.filter(a => a.status === 'stale')
}

export function runningOf(list: readonly JarvisAgent[]): JarvisAgent[] {
  return list.filter(a => a.status === 'running')
}

export function finishedOf(list: readonly JarvisAgent[]): JarvisAgent[] {
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

// The type the engine gives a workflow script's agents.
export const WORKFLOW_TYPE = 'workflow-subagent'

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

// A leading `cd <dir> &&` / `cd <dir>;` or `VAR=value ` (or `VAR=value;`), as a shell
// line begins before its real command.
const SHELL_PREFIX =
  /^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|[^\s;&]+)\s*(?:&&|;)|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&]*)(?:\s*(?:&&|;)|\s))\s*/

// The command a shell line runs, its directory changes and variable settings dropped;
// the line itself when nothing would be left.
export function commandOf(line: string): string {
  let rest = line
  for (let m = SHELL_PREFIX.exec(rest); m && m[0] !== ''; m = SHELL_PREFIX.exec(rest)) {
    const next = rest.slice(m[0].length)
    if (next.trim() === '') break
    rest = next
  }
  return rest.trim()
}

// The short line a tool call shows as in the event stream.
export function describeCall(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash': {
      const note = str(input['description']).trim()
      if (note !== '') return truncate(note, DESC_MAX)
      const first = str(input['command']).split('\n').find(l => l.trim() !== '') ?? ''
      return truncate(commandOf(first), DESC_MAX)
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
export function addEvent(list: readonly JarvisEvent[], ev: JarvisEvent): JarvisEvent[] {
  return [...list, ev].slice(-MAX_EVENTS)
}

// recovered: a failed call whose actor's very next call is the same tool, and it worked.
export type Outcome = 'ok' | 'recovered' | 'failed'

export function outcomesOf(events: readonly JarvisEvent[]): Outcome[] {
  const out: Outcome[] = events.map(ev => (ev.ok ? 'ok' : 'failed'))
  const last = new Map<string, number>()
  events.forEach((ev, i) => {
    const prev = last.get(ev.actor)
    const before = prev === undefined ? undefined : events[prev]
    if (prev !== undefined && before && !before.ok && ev.ok && before.tool === ev.tool) out[prev] = 'recovered'
    last.set(ev.actor, i)
  })
  return out
}

// An event list as drawn: each event with its outcome, a dated rule wherever two
// neighbours are more than BREAK_MS apart (`ts` is when the later run begins).
export type EventRow = { kind: 'event'; ev: JarvisEvent; outcome: Outcome } | { kind: 'break'; ts: number }

export function eventRows(events: readonly JarvisEvent[]): EventRow[] {
  const outcomes = outcomesOf(events)
  const rows: EventRow[] = []
  events.forEach((ev, i) => {
    const prev = events[i - 1]
    if (prev && ev.ts - prev.ts > BREAK_MS) rows.push({ kind: 'break', ts: ev.ts })
    rows.push({ kind: 'event', ev, outcome: outcomes[i] ?? 'ok' })
  })
  return rows
}

export type HealthScope = {
  // tool calls that started and have not returned
  inFlight?: number
  // ids of the subagents that are still running
  liveAgents?: ReadonlySet<string>
}

// One executor's own events, oldest first. The main loop is one executor; each subagent
// is another, by agentId, so two workers never merge.
function looping(events: readonly JarvisEvent[], live: ReadonlySet<string>): boolean {
  const byActor = new Map<string, JarvisEvent[]>()
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
  events: readonly JarvisEvent[],
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
// spawned with the type `fork`, a workflow script's agent with WORKFLOW_TYPE. Any other
// type (general-purpose, Plan, a plugin's) is other.
export function roleOf(type: string): Role {
  const lower = type.trim().toLowerCase()
  if (lower === WORKFLOW_TYPE) return 'workflow'
  return ROLES.find(r => r !== 'other' && r !== 'workflow' && r.toLowerCase() === lower) ?? 'other'
}

// A workflow script's agents count as the workflow role: by their run, or by the type
// the engine gives them when the record predates the run being kept.
export function dispatchRoleOf(a: JarvisAgent): Role {
  return a.runId !== undefined ? 'workflow' : roleOf(a.type)
}

export type RoleStat = { role: Role; label: string; running: number; done: number; failed: number }

export function dispatchStats(agents: readonly JarvisAgent[]): RoleStat[] {
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

export function modelShares(agents: readonly JarvisAgent[]): ModelShare[] {
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
  | { kind: 'agent'; agent: JarvisAgent }
  | { kind: 'workflow'; runId: string; agents: JarvisAgent[] }

export type ListSection = {
  status: 'running' | 'stale' | 'finished'
  // the subagents in that status, all of them
  count: number
  units: ListUnit[]
}

const RANK: Record<JarvisAgent['status'], number> = { running: 0, stale: 1, done: 2, failed: 2 }
const SECTION: ListSection['status'][] = ['running', 'stale', 'finished']

// The subagent list as drawn: running first, then lost, then finished (latest first). A
// workflow run's agents are one unit, in the section of its liveliest agent, by agentIndex.
export function agentSections(agents: readonly JarvisAgent[]): ListSection[] {
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

// A squad member's color, by its place in dispatch order.
export function jarvisColor(seq: number): string {
  const n = JARVIS_PALETTE.length
  const i = Number.isFinite(seq) ? ((Math.floor(seq) % n) + n) % n : 0
  return JARVIS_PALETTE[i] ?? THEME.primary
}

// Every listed subagent's number (1 up, by dispatch order: its MK-N, and its digit while
// that is one) and color (by dispatch order too): both stay however the list moves.
export type Member = { n: number; color: string }

export function rosterOf(agents: readonly JarvisAgent[], sections: readonly ListSection[]): Map<string, Member> {
  const seq = new Map(agents.map((a, i) => [a.id, a.seq ?? i]))
  const out = new Map<string, Member>()
  for (const section of sections) {
    for (const u of section.units) {
      for (const a of u.kind === 'agent' ? [u.agent] : u.agents) {
        const s = seq.get(a.id) ?? 0
        out.set(a.id, { n: s + 1, color: jarvisColor(s) })
      }
    }
  }
  return out
}

export type Phase = 'init' | 'active' | 'complete' | 'failed' | 'lost'

// init: running and dispatched (or resumed) under INIT_MS ago.
export function phaseOf(a: JarvisAgent, now: number): Phase {
  if (a.status === 'running') return now - a.runStartedAt < INIT_MS ? 'init' : 'active'
  if (a.status === 'done') return 'complete'
  if (a.status === 'failed') return 'failed'
  return 'lost'
}

export function scanFrame(n: number): string {
  return SCAN[((Math.floor(n) % SCAN.length) + SCAN.length) % SCAN.length] ?? SCAN[0] ?? ''
}

export function reactorOf(n: number, live: boolean): { glyph: string; color: string } {
  if (!live) return { glyph: REACTOR_IDLE, color: THEME.muted }
  const i = ((Math.floor(n) % REACTOR.length) + REACTOR.length) % REACTOR.length
  return { glyph: REACTOR[i] ?? REACTOR_IDLE, color: REACTOR_COLOR[i] ?? THEME.accent }
}

export type BootStage = { phase: 'online' } | { phase: 'loading'; pct: number }

// The boot screen `ms` after the pane opened; undefined once it is over.
export function bootStage(ms: number): BootStage | undefined {
  if (ms >= BOOT_MS) return undefined
  if (ms < BOOT_ONLINE_MS) return { phase: 'online' }
  const pct = Math.round(((ms - BOOT_ONLINE_MS) / (BOOT_LOADED_MS - BOOT_ONLINE_MS)) * 100)
  return { phase: 'loading', pct: Math.max(0, Math.min(100, pct)) }
}

// lost: the actor's latest call failed. relocked: it worked on the very tool that failed
// just before it, under RELOCK_MS ago.
export type Lock = 'lost' | 'relocked'

export function lockOf(events: readonly JarvisEvent[], actor: string, now: number): Lock | undefined {
  const own = events.filter(ev => ev.actor === actor)
  const last = own[own.length - 1]
  if (!last) return undefined
  if (!last.ok) return 'lost'
  const prev = own[own.length - 2]
  if (prev && !prev.ok && prev.tool === last.tool && now - (last.ts + last.ms) < RELOCK_MS) return 'relocked'
  return undefined
}

// The tick period: ANIM_MS while any squad member runs (initializing ones included) or
// the boot plays, and the pane was drawn within SEEN_MS of `now`, else IDLE_MS.
export function tickMs(agents: readonly JarvisAgent[], now: number, drawnAt: number, booting = false): number {
  return (runningOf(agents).length > 0 || booting) && now - drawnAt <= SEEN_MS ? ANIM_MS : IDLE_MS
}

export type JarvisState = {
  agents: readonly JarvisAgent[]
  main: JarvisMain
  events: readonly JarvisEvent[]
  inflight?: readonly JarvisInflight[]
}

// When the latest running thing began: the main turn, or a running subagent.
export function activeSinceOf(state: JarvisState): number | undefined {
  const starts = runningOf(state.agents).map(a => a.runStartedAt)
  if (state.main.isRunning) starts.push(state.main.runSince)
  return starts.length === 0 ? undefined : Math.max(...starts)
}

export function healthOfState(state: JarvisState, now: number): Health {
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
  events: JarvisEvent[]
  // every role, in ROLES order
  dispatch: RoleStat[]
  // per priced model family, highest cost first; share sums to 1 (all 0 when nothing is priced)
  models: ModelShare[]
  running: JarvisAgent[]
  stale: JarvisAgent[]
  finished: JarvisAgent[]
  // the subagent list as drawn
  sections: ListSection[]
  // each listed subagent's number and color
  roster: Map<string, Member>
  // tool calls not yet returned, oldest first
  inflight: JarvisInflight[]
  // the running subagents whose target is lost or just relocked
  locks: Map<string, Lock>
  summary: Summary
}

export function buildCockpit(state: JarvisState, now: number): Cockpit {
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
    dispatch: dispatchStats(state.agents),
    models: modelShares(state.agents),
    running: runningOf(state.agents),
    stale: staleOf(state.agents),
    finished: finishedOf(state.agents),
    sections,
    roster: rosterOf(state.agents, sections),
    inflight: [...(state.inflight ?? [])].sort((x, y) => x.startedAt - y.startedAt),
    locks: new Map(
      runningOf(state.agents).flatMap(a => {
        const lock = lockOf(state.events, a.id, now)
        return lock ? [[a.id, lock] as const] : []
      }),
    ),
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

const two = (n: number): string => String(n).padStart(2, '0')

// Local date, MM/DD.
export function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${two(d.getMonth() + 1)}/${two(d.getDate())}`
}

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
