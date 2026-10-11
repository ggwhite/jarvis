import type { FleetCursor, FleetFile, FleetJumpError, FleetSession, FleetView } from '../types'
import { EMPTY_TAIL, addToday, dayKey, dayStart, emptyHours, freshFile, parsePanes, parseQuota, projectDir, resumeFrom, splitLines, tailOf, transcriptPath } from './fleet'

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

export const EMPTY_FLEET: FleetView = { at: 0, sessions: [], linkLost: false, scanning: true, hourly: emptyHours() }

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
// since for today's use; one last written before today has no use of today to read),
// at most MAX_READS reads; herdr not answering keeps the last fleet, flagged lost.
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
  const midnight = dayStart(now)
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
    return file.day === today ? file : { ...file, day: today, tokens: 0, cost: 0, hourly: emptyHours() }
  }

  // every file of the fleet first, then the reads handed out the longest unread first
  type Job = { path: string; size: number; mtimeMs: number; main: boolean }
  const jobs: Job[] = []
  const plans: { base: FleetSession; path?: string; subs: string[] }[] = []
  for (const p of panes) {
    const base: FleetSession = { ...p, stamps: [], tools: 0, todayTokens: 0, todayCost: 0, hourly: emptyHours() }
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
    const entries = await io.list(dir)
    if (entries) {
      for (const e of entries) {
        if (e.kind !== 'file' || !e.name.endsWith('.jsonl')) continue
        const subPath = `${dir}/${e.name}`
        subs.push(subPath)
        jobs.push({ path: subPath, size: e.size, mtimeMs: e.mtimeMs, main: false })
      }
    } else {
      // a folder that could not be listed keeps its files as they were
      for (const [key, f] of Object.entries(cursor)) {
        if (!key.startsWith(`${dir}/`)) continue
        next[key] = f
        subs.push(key)
      }
    }
    plans.push({ base, path, subs })
  }

  const readAt = (j: Job) => cursor[j.path]?.readAt ?? 0
  for (const j of [...jobs].sort((x, y) => readAt(x) - readAt(y))) {
    const old = cursor[j.path]
    const same = unchanged(old, j)
    // last written before today and not yet seen today: read to its end, nothing counted
    const quiet: FleetFile | undefined =
      j.mtimeMs < midnight && old?.day !== today
        ? { ...(old ?? freshFile(now)), offset: j.size, size: j.size, mtimeMs: j.mtimeMs, day: today, tokens: 0, cost: 0, hourly: emptyHours() }
        : undefined
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
      const snapped = snap?.exitCode === 0 && !snap.truncated
      if (quiet) {
        next[j.path] = settle({ ...quiet, tail, readAt: now }, snapped)
        continue
      }
      const rest = await countRest(j.path, resumeFrom(old, j.size, now) ?? freshFile(now), j.size)
      const file = { ...rest.file, size: j.size, mtimeMs: j.mtimeMs, tail, readAt: now }
      next[j.path] = settle(file, snapped && rest.done)
    } else if (quiet) {
      next[j.path] = settle(quiet, true)
    } else {
      const before = reads
      const rest = await countRest(j.path, resumeFrom(old, j.size, now) ?? freshFile(now), j.size)
      const file = { ...rest.file, size: j.size, mtimeMs: j.mtimeMs, ...(reads > before ? { readAt: now } : {}) }
      next[j.path] = settle(file, rest.done)
    }
  }

  const hourly = emptyHours()
  const counted = new Set<string>()
  const addHours = (p: string | undefined) => {
    if (p === undefined || counted.has(p)) return
    counted.add(p)
    const f = next[p]
    if (!f || f.day !== today || !f.hourly) return
    f.hourly.forEach((v, i) => {
      hourly[i] = (hourly[i] ?? 0) + v
    })
  }
  for (const { base, path, subs } of plans) {
    addHours(path)
    const file = path === undefined ? undefined : next[path]
    let tokens = file && file.day === today ? file.tokens : 0
    let cost = file && file.day === today ? file.cost : 0
    const own = emptyHours()
    const addOwn = (f: FleetFile | undefined) => {
      if (!f || f.day !== today || !f.hourly) return
      f.hourly.forEach((v, i) => {
        own[i] = (own[i] ?? 0) + v
      })
    }
    addOwn(file)
    for (const subPath of subs) {
      addHours(subPath)
      const sub = next[subPath]
      addOwn(sub)
      if (sub && sub.day === today) {
        tokens += sub.tokens
        cost += sub.cost
      }
    }
    const used = { todayTokens: tokens, todayCost: cost, hourly: own }
    sessions.push(file ? { ...base, ...file.tail, ...used } : { ...base, ...used })
  }

  const quota = parseQuota(await io.read(`${io.home}/${LIMITS_PATH}`))
  return {
    view: {
      at: now,
      sessions,
      linkLost: false,
      scanning: behind,
      hourly,
      ...(quota ? { quota } : {}),
      ...(prev.jumpError ? { jumpError: prev.jumpError } : {}),
    },
    cursor: next,
  }
}
