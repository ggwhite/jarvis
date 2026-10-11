import type { FleetSession, FleetStatus } from '../types'

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
