import type { FleetFile, FleetQuota, FleetSession, FleetStatus, FleetTail, QuotaWindow } from '../types'
import { cellWidth, costAt, familyOf, fitCells, fmtK } from './jarvis'

// A Claude session as herdr lists it, before its transcript is read.
export type FleetPane = Pick<FleetSession, 'paneId' | 'tabId' | 'sessionId' | 'title' | 'status' | 'cwd' | 'workspace' | 'contextPct'>

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// Claude Code keeps a session's transcript in a folder named for its cwd, every character
// that is not a letter or digit a dash.
export function projectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return `${home}/.claude/projects/${projectDir(cwd)}/${sessionId}.jsonl`
}

export function fleetStatus(s: unknown): FleetStatus {
  return s === 'blocked' ? 'blocked' : s === 'working' ? 'working' : 'idle'
}

export function contextPctOf(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined
  const m = /(\d{1,3})%/.exec(text)
  return m ? Number(m[1]) : undefined
}

// The Claude panes of `herdr pane list`, named by `herdr workspace list`; undefined when
// the pane list is not what herdr answers.
export function parsePanes(paneJson: string, workspaceJson: string): FleetPane[] | undefined {
  let panes: unknown
  try {
    panes = obj(obj(JSON.parse(paneJson))?.['result'])?.['panes']
  } catch {
    return undefined
  }
  if (!Array.isArray(panes)) return undefined
  const names = new Map<string, string>()
  try {
    const spaces = obj(obj(JSON.parse(workspaceJson))?.['result'])?.['workspaces']
    if (Array.isArray(spaces)) {
      for (const w of spaces) {
        const o = obj(w)
        if (o) names.set(str(o['workspace_id']), str(o['label']))
      }
    }
  } catch {
    // no names: the workspace ids stand
  }
  const out: FleetPane[] = []
  for (const p of panes) {
    const o = obj(p)
    if (!o || o['agent'] !== 'claude') continue
    const ctx = contextPctOf(obj(o['tokens'])?.['context'])
    const workspaceId = str(o['workspace_id'])
    out.push({
      paneId: str(o['pane_id']),
      tabId: str(o['tab_id']),
      sessionId: str(obj(o['agent_session'])?.['value']),
      title: str(o['label']) || str(o['terminal_title_stripped']) || str(o['pane_id']),
      status: fleetStatus(o['agent_status']),
      cwd: str(o['cwd']),
      workspace: names.get(workspaceId) || workspaceId,
      ...(ctx === undefined ? {} : { contextPct: ctx }),
    })
  }
  return out
}

export function utf8Len(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

// The complete lines of `text`, each parsed as a JSON object; a line that is not is
// skipped. `dropFirst` throws away a first line that a byte-cut read began inside.
// `bytes` is what the complete lines take in UTF-8: where the next read resumes.
export function splitLines(text: string, dropFirst: boolean): { rows: Record<string, unknown>[]; bytes: number } {
  const end = text.lastIndexOf('\n')
  if (end < 0) return { rows: [], bytes: 0 }
  const whole = text.slice(0, end + 1)
  const rows: Record<string, unknown>[] = []
  whole
    .split('\n')
    .slice(0, -1)
    .forEach((line, i) => {
      if (dropFirst && i === 0) return
      try {
        const o = obj(JSON.parse(line))
        if (o) rows.push(o)
      } catch {
        // a broken line is skipped
      }
    })
  return { rows, bytes: utf8Len(whole) }
}

const two = (n: number): string => String(n).padStart(2, '0')

// The local calendar day, YYYY-MM-DD: today's use starts at local midnight.
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

// The heartbeat: the last hour in BEATS buckets of BEAT_MS.
export const BEATS = 12
export const BEAT_MS = 5 * 60 * 1000

export const EMPTY_TAIL: FleetTail = { stamps: [], tools: 0 }

const msgOf = (row: Record<string, unknown>) => obj(row['message'])

const tsOf = (row: Record<string, unknown>): number | undefined => {
  const t = Date.parse(str(row['timestamp']))
  return Number.isFinite(t) ? t : undefined
}

const replyText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map(b => {
          const o = obj(b)
          return o?.['type'] === 'text' ? str(o['text']) : ''
        })
        .filter(x => x.trim() !== '')
        .join('\n')
    : ''

// A prompt the person typed: not a tool result, not a reminder the harness added.
export function isHumanPrompt(row: Record<string, unknown>): boolean {
  if (row['type'] !== 'user' || row['isMeta'] === true) return false
  return obj(row['origin'])?.['kind'] === 'human' && typeof msgOf(row)?.['content'] === 'string'
}

export function tailOf(rows: Record<string, unknown>[], now: number): FleetTail {
  let lastUser: string | undefined
  let lastReply: string | undefined
  let model: string | undefined
  let lastAt: number | undefined
  let tools = 0
  const stamps: number[] = []
  const seen = new Set<string>()
  const spoke = (t: number | undefined) => {
    if (t !== undefined) lastAt = Math.max(lastAt ?? t, t)
  }
  for (const row of rows) {
    const t = tsOf(row)
    if (row['type'] === 'last-prompt' && str(row['lastPrompt']) !== '') {
      lastUser = str(row['lastPrompt'])
    } else if (isHumanPrompt(row)) {
      lastUser = str(msgOf(row)?.['content'])
      spoke(t)
    } else if (row['type'] === 'assistant') {
      const m = msgOf(row)
      if (!m) continue
      const name = str(m['model'])
      if (name !== '' && name !== '<synthetic>') model = name
      const said = replyText(m['content'])
      if (said !== '') lastReply = said
      const content = Array.isArray(m['content']) ? m['content'] : []
      tools += content.filter(b => obj(b)?.['type'] === 'tool_use').length
      spoke(t)
      // one API message is written over several lines: its time counts once
      const id = str(m['id'])
      if (t !== undefined && t <= now && now - t < BEATS * BEAT_MS && !seen.has(id)) {
        seen.add(id)
        stamps.push(t)
      }
    }
  }
  return {
    ...(lastUser === undefined ? {} : { lastUser }),
    ...(lastReply === undefined ? {} : { lastReply }),
    ...(model === undefined ? {} : { model }),
    ...(lastAt === undefined ? {} : { lastAt }),
    stamps,
    tools,
  }
}

// What one assistant message cost: input + output tokens shown, cache traffic priced.
export function usageOf(message: Record<string, unknown>): { tokens: number; cost: number } {
  const u = obj(message['usage'])
  if (!u) return { tokens: 0, cost: 0 }
  const n = (o: Record<string, unknown> | undefined, k: string): number => (typeof o?.[k] === 'number' ? (o[k] as number) : 0)
  const split = obj(u['cache_creation'])
  const t = {
    input: n(u, 'input_tokens'),
    output: n(u, 'output_tokens'),
    cacheRead: n(u, 'cache_read_input_tokens'),
    cacheWrite: n(u, 'cache_creation_input_tokens') || n(split, 'ephemeral_5m_input_tokens') + n(split, 'ephemeral_1h_input_tokens'),
  }
  const family = familyOf(str(message['model']))
  return { tokens: t.input + t.output, cost: family ? costAt(t, family) : 0 }
}

export function freshFile(now: number): FleetFile {
  return { size: 0, mtimeMs: 0, offset: 0, day: dayKey(now), tokens: 0, cost: 0, lastMsgId: '', tail: EMPTY_TAIL }
}

// Where today's count of a file goes on: as it was on the same day while the file only
// grew; undefined (count again from the start) on a new day or a file that shrank.
export function resumeFrom(file: FleetFile | undefined, size: number, now: number): FleetFile | undefined {
  if (!file || file.day !== dayKey(now) || size < file.offset) return undefined
  return file
}

// Adds the assistant messages of `rows` sent today, each message once though its lines
// repeat its usage; `bytes` is how far the rows took the read.
export function addToday(file: FleetFile, rows: Record<string, unknown>[], bytes: number, now: number): FleetFile {
  const today = dayKey(now)
  let { tokens, cost, lastMsgId } = file
  for (const row of rows) {
    if (row['type'] !== 'assistant') continue
    const m = msgOf(row)
    if (!m) continue
    const id = str(m['id'])
    if (id !== '' && id === lastMsgId) continue
    lastMsgId = id
    const t = tsOf(row)
    if (t === undefined || dayKey(t) !== today) continue
    const u = usageOf(m)
    tokens += u.tokens
    cost += u.cost
  }
  return { ...file, offset: file.offset + bytes, tokens, cost, lastMsgId }
}

export const STALE_QUOTA_MS = 15 * 60 * 1000
export const DECOMMISSION_MS = 24 * 60 * 60 * 1000
export const CONTEXT_WARN = 70
export const CONTEXT_ALERT = 90
// A heartbeat bucket by how busy it was against the fleet's busiest: silence, then rising.
export const BEAT_GLYPHS = ['⠀', '⣀', '⣤', '⣶', '⣿']

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

// The usagebar cache the statusLine keeps; undefined when missing or not its shape.
export function parseQuota(text: string | undefined): FleetQuota | undefined {
  if (text === undefined) return undefined
  let o: Record<string, unknown> | undefined
  try {
    o = obj(JSON.parse(text))
  } catch {
    return undefined
  }
  const fetchedAt = num(o?.['fetchedAtMs'])
  if (!o || fetchedAt === undefined) return undefined
  const win = (v: unknown): QuotaWindow | undefined => {
    const w = obj(v)
    const usedPct = num(w?.['usedPercentage'])
    const resetsAt = num(w?.['resetsAt'])
    const windowMin = num(w?.['windowMinutes'])
    if (usedPct === undefined || resetsAt === undefined || windowMin === undefined) return undefined
    return { usedPct, resetsAt: resetsAt * 1000, windowMin }
  }
  const fiveHour = win(o['fiveHour'])
  const sevenDay = win(o['sevenDay'])
  return { fetchedAt, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) }
}

export function quotaStale(q: FleetQuota, now: number): boolean {
  return now - q.fetchedAt > STALE_QUOTA_MS
}

export type Forecast = { depleteAt: number; beforeReset: boolean }

// When the window runs out at the pace used so far, measured `at` the cache's time;
// undefined with nothing used or the window not yet under way.
export function forecast(w: QuotaWindow, at: number): Forecast | undefined {
  const leftMin = (w.resetsAt - at) / 60_000
  const usedMin = w.windowMin - leftMin
  if (w.usedPct <= 0 || usedMin <= 0 || leftMin <= 0) return undefined
  if (w.usedPct >= 100) return { depleteAt: at, beforeReset: true }
  const depleteAt = at + ((100 - w.usedPct) / (w.usedPct / usedMin)) * 60_000
  return { depleteAt, beforeReset: depleteAt < w.resetsAt }
}

export type FleetSections = { blocked: FleetSession[]; working: FleetSession[]; idle: FleetSession[] }

// The fleet by what it needs of the person: waiting, working, the rest; each the most
// recently heard from first, a session never heard from last.
export function fleetSections(list: readonly FleetSession[]): FleetSections {
  const recent = (a: FleetSession, b: FleetSession) => (b.lastAt ?? -Infinity) - (a.lastAt ?? -Infinity)
  return {
    blocked: list.filter(s => s.status === 'blocked').sort(recent),
    working: list.filter(s => s.status === 'working').sort(recent),
    idle: list.filter(s => s.status === 'idle').sort(recent),
  }
}

export function decommissionCount(list: readonly FleetSession[], now: number): number {
  return list.filter(s => s.status === 'idle' && s.lastAt !== undefined && now - s.lastAt > DECOMMISSION_MS).length
}

// Replies per bucket over the last hour, oldest first.
export function beatsOf(stamps: readonly number[], now: number): number[] {
  const out = Array.from({ length: BEATS }, () => 0)
  for (const t of stamps) {
    const age = now - t
    if (age < 0 || age >= BEATS * BEAT_MS) continue
    const i = BEATS - 1 - Math.floor(age / BEAT_MS)
    out[i] = (out[i] ?? 0) + 1
  }
  return out
}

export function beatLine(beats: readonly number[], max: number): string {
  return beats
    .map(n => (n <= 0 || max <= 0 ? BEAT_GLYPHS[0] : BEAT_GLYPHS[Math.min(4, Math.max(1, Math.ceil((n / max) * 4)))]) ?? '⠀')
    .join('')
}

// How long ago, in one unit: 45s, 12m, 3h, 2d.
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function fmtBig(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : fmtK(n)
}

export function fleetTotals(list: readonly FleetSession[]): { tokens: number; cost: number; top?: string } {
  let tokens = 0
  let cost = 0
  let top: FleetSession | undefined
  for (const s of list) {
    tokens += s.todayTokens
    cost += s.todayCost
    if (s.todayCost > 0 && (!top || s.todayCost > top.todayCost)) top = s
  }
  return { tokens, cost, ...(top ? { top: top.title } : {}) }
}

// `text` on at most `maxLines` lines of `width` cells, its whitespace one space; a text
// cut short ends its last line in an ellipsis.
export function wrapCells(text: string, width: number, maxLines: number): string[] {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '' || width <= 0 || maxLines <= 0) return []
  const lines: string[] = []
  let cur = ''
  let cut = false
  for (const ch of flat) {
    if (cellWidth(cur + ch) <= width) {
      cur += ch
      continue
    }
    lines.push(cur.trimEnd())
    if (lines.length === maxLines) {
      cut = true
      break
    }
    cur = ch === ' ' ? '' : ch
  }
  if (cut) lines[maxLines - 1] = fitCells(`${lines[maxLines - 1] ?? ''}…`, width)
  else if (cur !== '') lines.push(cur.trimEnd())
  return lines
}
