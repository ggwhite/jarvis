import { backfillPlan, backfillRow } from './backfill'
import type { ChangesIo } from './changes'
import { FLAG_RULES, isCorrection, parseVerdict, sessionFlags } from './flags'
import { t } from './i18n'
import {
  DESC_LEN,
  type DispatchRow,
  type HealthRow,
  decodeRows,
  dedupe,
  dispatchHealth,
  encodeRows,
  expiredDays,
  ledgerDir,
  ledgerFile,
  lessonsFile,
  rowFamily,
  rowsByDay,
} from './ledger'
import {
  type Lesson,
  type LessonEvent,
  type LessonEventKind,
  applyRequest,
  decodeEvents,
  encodeEvents,
  foldLessons,
  injectLines,
  memoryArgv,
  memoryIdOf,
  revertRequest,
  suggestedFile,
} from './lessons'

// The session recorder: this session's dispatch rows and lesson events in memory, written only to
// files named with this session's id; every other session's files are read, never written.

export type LearnIo = ChangesIo & { list: (dir: string) => Promise<{ name: string; kind: string }[]> }

export type LearnOptions = { home: string; session: string; project: string; agentFiles?: string[] }

export type Spawn = { id: string; type: string; model: string; background: boolean; desc: string; promptLen: number; at: number }

export type Finish = {
  reason: string
  durationMs: number
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; model?: string }
  answer: string
  cost?: number
}

export type Learn = {
  spawn(s: Spawn): void
  tool(id: string, ok: boolean): void
  finish(id: string, c: Finish, now: number): void
  health(loop: readonly string[], stuck: readonly string[]): void
  subtask(agentId: string, subtaskId: string, prevAgentId?: string): void
  prompt(text: string, now: number): void
  flush(now: number): Promise<void>
  due(now: number): boolean
  /** Reads the ledger and every session's lesson events again; true when it found something new. */
  load(now: number, force?: boolean): Promise<boolean>
  backfill(now: number): Promise<number>
  lessons(now: number): Lesson[]
  health14(now: number): HealthRow[]
  inject(now: number): string[]
  approve(key: string, now: number): Promise<void>
  reject(key: string, now: number): void
  cancel(key: string, now: number): void
  /** Waiting: queue the apply request again. After a failed memory store: run the store again first. */
  retry(key: string, now: number): Promise<void>
  requestRevert(key: string, now: number): void
  toolCall(input: Record<string, unknown>, now: number): string
  turnEnded(): void
}

export const FLUSH_MS = 2000
export const LOAD_MS = 60_000

const DAY_MS = 86_400_000
const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/
const BACKFILL_FILE = 'backfill.jsonl'
const META = /^agent-(.+)\.meta\.json$/
const REASONS: readonly string[] = ['answer', 'aborted', 'refusal', 'error']

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** A decoded row with every field the flag and lesson logic reads; a hand-edited row may lack them. */
function normal(r: DispatchRow): DispatchRow {
  const tk = (typeof r.tokens === 'object' && r.tokens !== null ? r.tokens : {}) as Partial<DispatchRow['tokens']>
  return {
    ...r,
    session: str(r.session),
    project: str(r.project),
    type: str(r.type),
    model: str(r.model),
    family: typeof r.family === 'string' ? r.family : 'other',
    desc: str(r.desc),
    promptLen: num(r.promptLen),
    tokens: { in: num(tk.in), out: num(tk.out), cr: num(tk.cr), cw: num(tk.cw) },
    tools: num(r.tools),
    toolErrors: num(r.toolErrors),
    doneAt: finite(r.doneAt),
    durationMs: finite(r.durationMs),
    reason: REASONS.includes(r.reason as string) ? r.reason : undefined,
    health: Array.isArray(r.health) ? r.health.filter(h => h === 'loop' || h === 'stuck') : undefined,
  }
}

async function safe<T>(f: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await f()
  } catch {
    return fallback
  }
}

// A read the pane draws from: a bad row it did not foresee reads as nothing, never a throw.
function guard<T>(f: () => T[]): T[] {
  try {
    return f()
  } catch {
    return []
  }
}

const percent = (rate: number, n: number): string => `${Math.round(rate * 100)}% (n=${n})`

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? ''

export function createLearn(io: LearnIo, opts: LearnOptions): Learn {
  const { home, session, project } = opts
  const on = home !== ''
  const own = new Map<string, DispatchRow>()
  let events: LessonEvent[] = []
  let others: DispatchRow[] = []
  // lesson event files of other sessions, by file name
  let otherEvents = new Map<string, LessonEvent[]>()
  let backfillSeen = false
  // this session's own files have been read whole: only then may a flush write over them
  let adopted = false
  // what the last load read of other sessions' files, to tell whether the next one found anything new
  let lastRead = ''
  let retained = false
  let backfilled = false
  let loadedAt: number | undefined
  let dirty = false
  let flushedAt = 0
  let lastPrompt = -Infinity
  let shown = new Map<string, number>()
  // apply / revert requests waiting for this session's next prompt
  const queued = new Map<string, 'apply' | 'revert'>()
  // apply / revert requests injected in the current turn
  const injected = new Map<string, 'apply' | 'revert'>()
  const waiting = new Set<string>()

  const list = (dir: string) => safe(() => io.list(dir), [])
  // a directory's entries: none when it is not there, undefined when it is there and could not be read
  const listing = async (dir: string): Promise<{ name: string; kind: string }[] | undefined> => {
    try {
      return await io.list(dir)
    } catch {
      return (await safe(() => io.stat(dir), undefined)) === undefined ? [] : undefined
    }
  }
  const read = (path: string) => safe(() => io.read(path), undefined)
  const write = (path: string, text: string) => safe(() => io.write(path, text), false)
  const run = (argv: string[]) => safe(() => io.run(argv), undefined)

  const touch = (): void => {
    dirty = true
  }
  const event = (key: string, kind: LessonEventKind, at: number, extra: Partial<LessonEvent> = {}): void => {
    events.push({ key, kind, at, session, ...extra })
    touch()
  }

  const allRows = (): DispatchRow[] => dedupe([...own.values(), ...others])

  const allEvents = (): LessonEvent[] => {
    const files = new Map(otherEvents)
    files.set(`${session}.jsonl`, events)
    return [...files.keys()].sort().flatMap(name => files.get(name)!)
  }

  const lessons = (now: number): Lesson[] => {
    if (!on) return []
    return guard(() => {
      const out = foldLessons(allRows(), allEvents(), now)
      for (const l of out) {
        if (l.state === 'approved' && waiting.has(l.key)) l.waiting = true
        const kind = l.state === 'approved' ? 'apply' : l.state === 'applied' ? 'revert' : undefined
        if (kind !== undefined && (queued.get(l.key) === kind || injected.get(l.key) === kind)) l.requestedHere = true
      }
      return out
    })
  }
  const lessonOf = (key: string, now: number): Lesson | undefined => lessons(now).find(l => l.key === key)

  const forget = (key: string): void => {
    queued.delete(key)
    injected.delete(key)
    waiting.delete(key)
  }

  // Stores the lesson's memory; only a stored id queues the apply request (spec §4).
  const store = async (key: string, l: Lesson, now: number): Promise<void> => {
    const r = await run(memoryArgv(home, l))
    const id = r && r.exitCode === 0 ? memoryIdOf(r.stdout) : undefined
    waiting.delete(key)
    if (id === undefined) {
      event(key, 'memory-error', now, { error: r?.stderr.trim() || 'no id' })
      queued.delete(key)
      return
    }
    event(key, 'memory', now, { memoryId: id })
    queued.set(key, 'apply')
  }

  const load = async (now: number, force = false): Promise<boolean> => {
    if (!on) return false
    if (!force && loadedAt !== undefined && now - loadedAt < LOAD_MS) return false
    loadedAt = now
    // this session's own files were all read
    let whole = true
    // other sessions' files as read, to compare with the last load
    const seen: string[] = []
    const root = ledgerDir(home)
    const days = await listing(root)
    if (days === undefined) whole = false
    const names = (days ?? []).filter(e => e.kind === 'dir' && DAY_NAME.test(e.name)).map(e => e.name)
    const expired = expiredDays(names, now)
    if (!retained) {
      retained = true
      for (const d of expired) await run(['/bin/rm', '-rf', `${root}/${d}`])
    }
    const rows: DispatchRow[] = []
    const mine: DispatchRow[] = []
    let sawBackfill = false
    for (const day of names.filter(n => !expired.includes(n)).sort()) {
      const files = await listing(`${root}/${day}`)
      if (files === undefined) whole = false
      for (const f of files ?? []) {
        if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
        if (f.name === BACKFILL_FILE) sawBackfill = true
        const own = f.name === `${session}.jsonl`
        const text = await read(`${root}/${day}/${f.name}`)
        if (text === undefined) {
          if (own) whole = false
          continue
        }
        const decoded = decodeRows(text).map(normal)
        if (own) mine.push(...decoded)
        else {
          rows.push(...decoded)
          seen.push(`${day}/${f.name}\n${text}`)
        }
      }
    }
    others = rows
    backfillSeen = backfillSeen || sawBackfill

    const lessonDir = `${home}/.claude/jarvis/lessons`
    const byFile = new Map<string, LessonEvent[]>()
    let mineEvents: LessonEvent[] = []
    const lessonFiles = await listing(lessonDir)
    if (lessonFiles === undefined) whole = false
    for (const f of lessonFiles ?? []) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
      const own = f.name === `${session}.jsonl`
      const text = await read(`${lessonDir}/${f.name}`)
      if (text === undefined) {
        if (own) whole = false
        continue
      }
      if (own) mineEvents = decodeEvents(text)
      else {
        byFile.set(f.name, decodeEvents(text))
        seen.push(`lessons/${f.name}\n${text}`)
      }
    }
    otherEvents = byFile

    let changed = false
    // a resumed session: keep what its own files already hold, so the next flush does not drop it;
    // a read that failed adopts nothing, and the next load tries again
    if (!adopted && whole) {
      adopted = true
      changed = mine.length > 0 || mineEvents.length > 0
      for (const r of mine) if (!own.has(r.id)) own.set(r.id, r)
      const have = new Set(events.map(e => JSON.stringify(e)))
      events = [...mineEvents.filter(e => !have.has(JSON.stringify(e))), ...events]
    }
    const print = seen.join('\0')
    if (print !== lastRead) changed = true
    lastRead = print
    return changed
  }

  const backfill = async (now: number): Promise<number> => {
    if (!on || backfilled) return 0
    if (loadedAt === undefined) await load(now)
    backfilled = true
    const today = new Date(now)
    const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    if (backfillSeen || allRows().some(r => r.at < dayStart)) return 0
    const { projectsDir, sinceMs } = backfillPlan(home, now)
    const rows: DispatchRow[] = []
    for (const p of await list(projectsDir)) {
      if (p.kind !== 'dir') continue
      for (const s of await list(`${projectsDir}/${p.name}`)) {
        if (s.kind !== 'dir') continue
        const dir = `${projectsDir}/${p.name}/${s.name}/subagents`
        for (const f of await list(dir)) {
          const id = META.exec(f.name)?.[1]
          if (f.kind !== 'file' || id === undefined) continue
          const st = await safe(() => io.stat(`${dir}/${f.name}`), undefined)
          if (!st || st.mtimeMs < sinceMs) continue
          const meta = await read(`${dir}/${f.name}`)
          const jsonl = await read(`${dir}/agent-${id}.jsonl`)
          if (meta === undefined || jsonl === undefined) continue
          const r = backfillRow(meta, jsonl, { id, session: s.name, project: projectOf(jsonl) || p.name })
          if (r && r.at > 0) rows.push(r)
        }
      }
    }
    if (!rows.length) return 0
    for (const [day, group] of rowsByDay(rows)) await write(`${ledgerDir(home)}/${day}/${BACKFILL_FILE}`, encodeRows(group))
    others = [...others, ...rows]
    backfillSeen = true
    return rows.length
  }

  const flush = async (now: number): Promise<void> => {
    if (!on || !dirty) return
    flushedAt = now
    // this session's own files are read before anything is written over them
    if (!adopted) await load(now, true)
    if (!adopted) return
    dirty = false
    let ok = true
    for (const [day, group] of rowsByDay([...own.values()])) {
      if (!(await write(ledgerFile(home, day, session), encodeRows(group)))) ok = false
    }
    if (events.length && !(await write(lessonsFile(home, session), encodeEvents(events)))) ok = false
    if (!ok) dirty = true
  }

  const inject = (now: number): string[] => {
    const all = lessons(now)
    const picked = injectLines(all, shown)
    shown = picked.shown
    const out = [...picked.lines]
    for (const [key, kind] of queued) {
      const l = all.find(x => x.key === key)
      if (kind === 'apply' && l?.state === 'approved' && l.memoryId !== undefined) {
        out.push(applyRequest(l, suggestedFile(l.kind, l.type, home, opts.agentFiles ?? [])))
        injected.set(key, 'apply')
      } else if (kind === 'revert' && l?.state === 'applied' && l.revertRequested) {
        out.push(revertRequest(l))
        injected.set(key, 'revert')
      }
    }
    queued.clear()
    return out
  }

  const toolCall = (input: Record<string, unknown>, now: number): string => {
    if (!on) return t('lesson.tool.none')
    const op = str(input['op'])
    const key = str(input['key'])
    if (op === 'list') {
      const lines = lessons(now)
        .filter(l => l.state === 'candidate' || l.state === 'applied')
        .map(l => {
          const m = l.measure
          const measure = m ? t('lesson.tool.measure', { verdict: m.verdict, before: percent(m.beforeRate, m.beforeN), after: percent(m.afterRate, m.afterN) }) : ''
          return t('lesson.tool.row', { key: l.key, state: l.state, n: l.strikes, measure })
        })
      return lines.length ? lines.join('\n') : t('lesson.tool.none')
    }
    if (op === 'applied') {
      const file = str(input['file'])
      if (!key || !file) return t('lesson.tool.needFile')
      const l = lessonOf(key, now)
      if (!l) return t('lesson.tool.unknown', { key })
      if (l.state !== 'approved') return t('lesson.tool.notApproved', { key, state: l.state })
      event(key, 'applied', now, { file })
      forget(key)
      return t('lesson.tool.applied', { key, file })
    }
    if (op === 'reverted') {
      if (!key) return t('lesson.tool.needKey')
      const l = lessonOf(key, now)
      if (!l) return t('lesson.tool.unknown', { key })
      if (l.state !== 'applied' || !l.revertRequested) return t('lesson.tool.notRevert', { key })
      event(key, 'reverted', now)
      forget(key)
      return t('lesson.tool.reverted', { key })
    }
    return t('lesson.tool.badOp', { op })
  }

  return {
    spawn(s) {
      if (!on || own.has(s.id)) return
      own.set(s.id, {
        v: 1,
        id: s.id,
        session,
        project,
        at: s.at,
        type: s.type,
        model: s.model,
        family: rowFamily(s.model),
        background: s.background,
        desc: s.desc.slice(0, DESC_LEN),
        promptLen: s.promptLen,
        tokens: { in: 0, out: 0, cr: 0, cw: 0 },
        tools: 0,
        toolErrors: 0,
      })
      touch()
    },

    tool(id, ok) {
      const r = own.get(id)
      if (!r) return
      r.tools++
      if (!ok) r.toolErrors++
      touch()
    },

    finish(id, c, now) {
      const r = own.get(id)
      if (!r) return
      const u = c.usage ?? {}
      r.tokens.in += num(u.input_tokens)
      r.tokens.out += num(u.output_tokens)
      r.tokens.cr += num(u.cache_read_input_tokens)
      r.tokens.cw += num(u.cache_creation_input_tokens)
      r.durationMs = (r.durationMs ?? 0) + num(c.durationMs)
      r.doneAt = now
      if (REASONS.includes(c.reason)) r.reason = c.reason as DispatchRow['reason']
      if (c.cost !== undefined) r.cost = (r.cost ?? 0) + num(c.cost)
      if (!r.model && u.model) {
        r.model = u.model
        r.family = rowFamily(u.model)
      }
      if (r.type === 'verifier') {
        const v = parseVerdict(c.answer)
        if (v) r.verdict = v
      }
      touch()
    },

    health(loop, stuck) {
      const add = (id: string, kind: 'loop' | 'stuck'): void => {
        const r = own.get(id)
        if (!r || r.health?.includes(kind)) return
        r.health = [...(r.health ?? []), kind]
        touch()
      }
      for (const id of loop) add(id, 'loop')
      for (const id of stuck) add(id, 'stuck')
    },

    subtask(agentId, subtaskId, prevAgentId) {
      const r = own.get(agentId)
      if (!r) return
      r.subtask = subtaskId
      if (prevAgentId && prevAgentId !== agentId && own.get(prevAgentId)?.doneAt !== undefined) r.redispatchOf = prevAgentId
      touch()
    },

    prompt(text, now) {
      const since = lastPrompt
      lastPrompt = now
      if (!on || !isCorrection(text)) return
      for (const r of own.values()) {
        if (r.doneAt === undefined || r.doneAt < since || now - r.doneAt > FLAG_RULES.correctionMs) continue
        r.corrected = true
        touch()
      }
    },

    flush,

    due(now) {
      return on && dirty && now - flushedAt >= FLUSH_MS
    },

    load: (now, force) => safe(() => load(now, force), false),

    backfill: now => safe(() => backfill(now), 0),

    lessons,

    health14(now) {
      if (!on) return []
      return guard(() => {
        const rows = allRows()
        const flags = sessionFlags(rows)
        return dispatchHealth(rows, r => flags.get(r.id) ?? [], now)
      })
    },

    inject(now) {
      if (!on) return []
      return guard(() => inject(now))
    },

    async approve(key, now) {
      if (!on) return
      try {
        const l = lessonOf(key, now)
        // a second press, while the first stores its memory or after it, is not a second approval
        if (l?.state !== 'candidate') return
        event(key, 'approve', now)
        await store(key, l, now)
      } catch {
        // recording only
      }
    },

    reject(key, now) {
      if (!on || lessonOf(key, now)?.state !== 'candidate') return
      event(key, 'reject', now)
      forget(key)
    },

    cancel(key, now) {
      if (!on) return
      event(key, 'apply-cancel', now)
      forget(key)
    },

    async retry(key, now) {
      if (!on) return
      try {
        const l = lessonOf(key, now)
        if (l?.state !== 'approved') return
        if (l.memoryId === undefined) return await store(key, l, now)
        waiting.delete(key)
        queued.set(key, 'apply')
      } catch {
        // recording only
      }
    },

    requestRevert(key, now) {
      if (!on) return
      event(key, 'revert-request', now)
      queued.set(key, 'revert')
    },

    toolCall(input, now) {
      try {
        return toolCall(input, now)
      } catch {
        return t('lesson.tool.unknown', { key: str(input['key']) })
      }
    },

    turnEnded() {
      for (const [key, kind] of injected) if (kind === 'apply') waiting.add(key)
      injected.clear()
    },
  }
}

/** The project of a subagent transcript: the basename of the first `cwd` it records. */
function projectOf(jsonl: string): string {
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    try {
      const o: unknown = JSON.parse(line)
      const cwd = typeof o === 'object' && o !== null ? (o as { cwd?: unknown }).cwd : undefined
      if (typeof cwd === 'string' && cwd) return basename(cwd)
    } catch {
      continue
    }
  }
  return ''
}
