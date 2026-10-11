import type { FleetCursor, FleetFile, FleetJumpError, FleetSession, FleetView } from '../types'
import { EMPTY_TAIL, addToday, dayKey, freshFile, parsePanes, parseQuota, projectDir, resumeFrom, splitLines, tailOf, transcriptPath } from './fleet'

// How often the fleet page asks herdr and the transcripts, while it is in view.
export const FLEET_MS = 5000
export const FLEET_RUN_TIMEOUT_MS = 5000
// The tail read for a session's last words, heartbeat and tools.
export const TAIL_BYTES = 262_144
// The most transcript reads one refresh makes; the rest wait for the next.
export const MAX_READS = 8
export const LIMITS_PATH = '.claude/herdr-usagebar/claude-limits-latest.json'
export const PANE_LIST: readonly string[] = ['herdr', 'pane', 'list']
export const WORKSPACE_LIST: readonly string[] = ['herdr', 'workspace', 'list']

export type RunOut = { exitCode: number; stdout: string; stderr: string; truncated: boolean }

// A directory entry, as `$.fs.list` gives it.
export type FleetEntry = { name: string; kind: string; size: number; mtimeMs: number }

// The host, as the fleet reads it: a command run (undefined when it could not), a file's
// size and time (undefined when missing), a small file's text, a directory's entries
// (undefined when missing).
export type FleetIo = {
  home: string
  run: (argv: readonly string[]) => Promise<RunOut | undefined>
  stat: (path: string) => Promise<{ size: number; mtimeMs: number } | undefined>
  read: (path: string) => Promise<string | undefined>
  list: (dir: string) => Promise<FleetEntry[] | undefined>
}

export const EMPTY_FLEET: FleetView = { at: 0, sessions: [], linkLost: false, scanning: true }

export function focusArgv(paneId: string): string[] {
  return ['herdr', 'agent', 'focus', paneId]
}

export function withJump(view: FleetView, err: FleetJumpError | undefined): FleetView {
  const next: FleetView = { ...view }
  if (err) next.jumpError = err
  else delete next.jumpError
  return next
}

const subagentDir = (home: string, cwd: string, sessionId: string): string =>
  `${home}/.claude/projects/${projectDir(cwd)}/${sessionId}/subagents`

// One look at the fleet: herdr's Claude panes, each transcript and subagent transcript
// read only when it changed (the main one's tail for the last words, the bytes added
// since for today's use), at most MAX_READS reads; herdr not answering keeps the last
// fleet, flagged lost.
export async function refreshFleet(
  io: FleetIo,
  prev: FleetView,
  cursor: FleetCursor,
  now: number,
): Promise<{ view: FleetView; cursor: FleetCursor }> {
  const paneOut = await io.run(PANE_LIST)
  const spaceOut = paneOut?.exitCode === 0 ? await io.run(WORKSPACE_LIST) : undefined
  const panes = paneOut?.exitCode === 0 ? parsePanes(paneOut.stdout, spaceOut?.exitCode === 0 ? spaceOut.stdout : '{}') : undefined
  if (!panes) return { view: { ...prev, at: now, linkLost: true }, cursor }

  const today = dayKey(now)
  const next: FleetCursor = {}
  const sessions: FleetSession[] = []
  let reads = 0
  let behind = false

  // the bytes of `path` after `file`'s offset counted into today; done when they reach `size`
  const countRest = async (path: string, file: FleetFile, size: number): Promise<{ file: FleetFile; done: boolean }> => {
    if (file.offset >= size) return { file, done: true }
    if (reads >= MAX_READS) return { file, done: false }
    const chunk = await io.run(['tail', '-c', `+${file.offset + 1}`, path])
    reads += 1
    if (chunk?.exitCode !== 0) return { file, done: false }
    const { rows, bytes } = splitLines(chunk.stdout, false)
    const counted = addToday(file, rows, bytes, now)
    return { file: counted, done: !chunk.truncated && counted.offset >= size }
  }

  // a file read to its end is caught up for today; one not yet caught up today keeps the
  // scan going, while one that was only lags
  const settle = (file: FleetFile, done: boolean): FleetFile => {
    if (done) return { ...file, caughtUpDay: today }
    if (file.caughtUpDay !== today) behind = true
    return file
  }

  // a file whose size and time have not changed since `file`; a new day zeroes its count
  const unchanged = (file: FleetFile | undefined, st: { size: number; mtimeMs: number }): FleetFile | undefined => {
    if (!file || file.offset !== st.size || file.mtimeMs !== st.mtimeMs) return undefined
    return file.day === today ? file : { ...file, day: today, tokens: 0, cost: 0 }
  }

  // every file of the fleet first, then the reads handed out the longest unread first
  type Job = { path: string; size: number; mtimeMs: number; main: boolean }
  const jobs: Job[] = []
  const plans: { base: FleetSession; path?: string; subs: string[] }[] = []
  for (const p of panes) {
    const base: FleetSession = { ...p, stamps: [], tools: 0, todayTokens: 0, todayCost: 0 }
    if (p.sessionId === '' || p.cwd === '') {
      plans.push({ base, subs: [] })
      continue
    }
    const path = transcriptPath(io.home, p.cwd, p.sessionId)
    const st = await io.stat(path)
    if (st) jobs.push({ path, size: st.size, mtimeMs: st.mtimeMs, main: true })
    else if (cursor[path]) next[path] = cursor[path]
    const dir = subagentDir(io.home, p.cwd, p.sessionId)
    const subs: string[] = []
    for (const e of (await io.list(dir)) ?? []) {
      if (e.kind !== 'file' || !e.name.endsWith('.jsonl')) continue
      const subPath = `${dir}/${e.name}`
      subs.push(subPath)
      jobs.push({ path: subPath, size: e.size, mtimeMs: e.mtimeMs, main: false })
    }
    plans.push({ base, path, subs })
  }

  const readAt = (j: Job) => cursor[j.path]?.readAt ?? 0
  for (const j of [...jobs].sort((x, y) => readAt(x) - readAt(y))) {
    const old = cursor[j.path]
    const same = unchanged(old, j)
    if (same) {
      next[j.path] = settle(same, true)
    } else if (j.main) {
      if (reads >= MAX_READS) {
        if (old) next[j.path] = old
        if (old?.caughtUpDay !== today) behind = true
        continue
      }
      const snap = await io.run(['tail', '-c', String(TAIL_BYTES), j.path])
      reads += 1
      const tail = snap?.exitCode === 0 ? tailOf(splitLines(snap.stdout, j.size > TAIL_BYTES).rows, now) : (old?.tail ?? EMPTY_TAIL)
      const rest = await countRest(j.path, resumeFrom(old, j.size, now) ?? freshFile(now), j.size)
      const file = { ...rest.file, size: j.size, mtimeMs: j.mtimeMs, tail, readAt: now }
      next[j.path] = settle(file, snap?.exitCode === 0 && !snap.truncated && rest.done)
    } else {
      const before = reads
      const rest = await countRest(j.path, resumeFrom(old, j.size, now) ?? freshFile(now), j.size)
      const file = { ...rest.file, size: j.size, mtimeMs: j.mtimeMs, ...(reads > before ? { readAt: now } : {}) }
      next[j.path] = settle(file, rest.done)
    }
  }

  for (const { base, path, subs } of plans) {
    const file = path === undefined ? undefined : next[path]
    let tokens = file && file.day === today ? file.tokens : 0
    let cost = file && file.day === today ? file.cost : 0
    for (const subPath of subs) {
      const sub = next[subPath]
      if (sub && sub.day === today) {
        tokens += sub.tokens
        cost += sub.cost
      }
    }
    sessions.push(file ? { ...base, ...file.tail, todayTokens: tokens, todayCost: cost } : { ...base, todayTokens: tokens, todayCost: cost })
  }

  const quota = parseQuota(await io.read(`${io.home}/${LIMITS_PATH}`))
  return {
    view: {
      at: now,
      sessions,
      linkLost: false,
      scanning: behind,
      ...(quota ? { quota } : {}),
      ...(prev.jumpError ? { jumpError: prev.jumpError } : {}),
    },
    cursor: next,
  }
}
