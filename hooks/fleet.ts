import type { FleetFile, FleetSession, FleetStatus, FleetTail } from '../types'
import { costAt, familyOf } from './jarvis'

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
