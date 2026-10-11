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

  // the bytes of `path` after `file`'s offset counted into today; behind when the read
  // stopped short of `size`
  const countRest = async (path: string, file: FleetFile, size: number): Promise<FleetFile> => {
    if (file.offset >= size) return file
    if (reads >= MAX_READS) {
      behind = true
      return file
    }
    const chunk = await io.run(['tail', '-c', `+${file.offset + 1}`, path])
    reads += 1
    let counted = file
    if (chunk?.exitCode === 0) {
      const { rows, bytes } = splitLines(chunk.stdout, false)
      counted = addToday(file, rows, bytes, now)
    }
    if (chunk?.exitCode !== 0 || chunk.truncated || counted.offset < size) behind = true
    return counted
  }

  // a file whose size and time have not changed since `file`; a new day zeroes its count
  const unchanged = (file: FleetFile | undefined, st: { size: number; mtimeMs: number }): FleetFile | undefined => {
    if (!file || file.offset !== st.size || file.mtimeMs !== st.mtimeMs) return undefined
    return file.day === today ? file : { ...file, day: today, tokens: 0, cost: 0 }
  }

  for (const p of panes) {
    const base: FleetSession = { ...p, stamps: [], tools: 0, todayTokens: 0, todayCost: 0 }
    if (p.sessionId === '' || p.cwd === '') {
      sessions.push(base)
      continue
    }
    const path = transcriptPath(io.home, p.cwd, p.sessionId)
    const st = await io.stat(path)
    let file: FleetFile | undefined = cursor[path]
    if (st) {
      const same = unchanged(file, st)
      if (same) {
        file = same
      } else if (reads < MAX_READS) {
        const snap = await io.run(['tail', '-c', String(TAIL_BYTES), path])
        reads += 1
        if (snap?.exitCode !== 0 || snap.truncated) behind = true
        const tail = snap?.exitCode === 0 ? tailOf(splitLines(snap.stdout, st.size > TAIL_BYTES).rows, now) : (file?.tail ?? EMPTY_TAIL)
        const counted = await countRest(path, resumeFrom(file, st.size, now) ?? freshFile(now), st.size)
        file = { ...counted, size: st.size, mtimeMs: st.mtimeMs, tail }
      } else {
        behind = true
      }
    }
    if (file) next[path] = file

    let tokens = file && file.day === today ? file.tokens : 0
    let cost = file && file.day === today ? file.cost : 0
    const dir = subagentDir(io.home, p.cwd, p.sessionId)
    for (const e of (await io.list(dir)) ?? []) {
      if (e.kind !== 'file' || !e.name.endsWith('.jsonl')) continue
      const subPath = `${dir}/${e.name}`
      let sub: FleetFile | undefined = unchanged(cursor[subPath], e)
      if (!sub) {
        const counted = await countRest(subPath, resumeFrom(cursor[subPath], e.size, now) ?? freshFile(now), e.size)
        sub = { ...counted, size: e.size, mtimeMs: e.mtimeMs }
      }
      next[subPath] = sub
      if (sub.day === today) {
        tokens += sub.tokens
        cost += sub.cost
      }
    }
    sessions.push(file ? { ...base, ...file.tail, todayTokens: tokens, todayCost: cost } : { ...base, todayTokens: tokens, todayCost: cost })
  }
  if (reads >= MAX_READS) behind = true

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
