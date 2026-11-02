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
  load(now: number, force?: boolean): Promise<void>
  backfill(now: number): Promise<number>
  lessons(now: number): Lesson[]
  health14(now: number): HealthRow[]
  inject(now: number): string[]
  approve(key: string, now: number): Promise<void>
  reject(key: string, now: number): void
  cancel(key: string, now: number): void
  retry(key: string): void
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
  }
}

async function safe<T>(f: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await f()
  } catch {
    return fallback
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
  let adopted = false
  let retained = false
  let backfilled = false
  let loadedAt: number | undefined
  let dirty = false
  let flushedAt = 0
  let lastPrompt = -Infinity
  let shown = new Map<string, number>()
  // apply / revert requests waiting for this session's next prompt
  const queued = new Map<string, 'apply' | 'revert'>()
  // apply requests injected in the current turn
  const injected = new Set<string>()
  const waiting = new Set<string>()

  const list = (dir: string) => safe(() => io.list(dir), [])
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
    const out = foldLessons(allRows(), allEvents(), now)
    for (const l of out) if (l.state === 'approved' && waiting.has(l.key)) l.waiting = true
    return out
  }
  const lessonOf = (key: string, now: number): Lesson | undefined => lessons(now).find(l => l.key === key)

  const forget = (key: string): void => {
    queued.delete(key)
    injected.delete(key)
    waiting.delete(key)
  }

  const load = async (now: number, force = false): Promise<void> => {
    if (!on) return
    if (!force && loadedAt !== undefined && now - loadedAt < LOAD_MS) return
    loadedAt = now
    const root = ledgerDir(home)
    const names = (await list(root)).filter(e => e.kind === 'dir' && DAY_NAME.test(e.name)).map(e => e.name)
    const expired = expiredDays(names, now)
    if (!retained) {
      retained = true
      for (const d of expired) await run(['/bin/rm', '-rf', `${root}/${d}`])
    }
    const rows: DispatchRow[] = []
    const mine: DispatchRow[] = []
    let sawBackfill = false
    for (const day of names.filter(n => !expired.includes(n)).sort()) {
      for (const f of await list(`${root}/${day}`)) {
        if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
        if (f.name === BACKFILL_FILE) sawBackfill = true
        const text = await read(`${root}/${day}/${f.name}`)
        if (text === undefined) continue
        const decoded = decodeRows(text).map(normal)
        if (f.name === `${session}.jsonl`) mine.push(...decoded)
        else rows.push(...decoded)
      }
    }
    others = rows
    backfillSeen = backfillSeen || sawBackfill

    const lessonDir = `${home}/.claude/jarvis/lessons`
    const byFile = new Map<string, LessonEvent[]>()
    let mineEvents: LessonEvent[] = []
    for (const f of await list(lessonDir)) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
      const text = await read(`${lessonDir}/${f.name}`)
      if (text === undefined) continue
      if (f.name === `${session}.jsonl`) mineEvents = decodeEvents(text)
      else byFile.set(f.name, decodeEvents(text))
    }
    otherEvents = byFile

    // a resumed session: keep what its own files already hold, so the next flush does not drop it
    if (!adopted) {
      adopted = true
      for (const r of mine) if (!own.has(r.id)) own.set(r.id, r)
      const have = new Set(events.map(e => JSON.stringify(e)))
      events = [...mineEvents.filter(e => !have.has(JSON.stringify(e))), ...events]
    }
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
    dirty = false
    flushedAt = now
    let ok = true
    for (const [day, group] of rowsByDay([...own.values()])) {
      if (!(await write(ledgerFile(home, day, session), encodeRows(group)))) ok = false
    }
    if (events.length && !(await write(lessonsFile(home, session), encodeEvents(events)))) ok = false
    if (!ok) dirty = true
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

    load: (now, force) => safe(() => load(now, force), undefined),

    backfill: now => safe(() => backfill(now), 0),

    lessons,

    health14(now) {
      if (!on) return []
      const rows = allRows()
      const flags = sessionFlags(rows)
      return dispatchHealth(rows, r => flags.get(r.id) ?? [], now)
    },

    inject(now) {
      if (!on) return []
      const all = lessons(now)
      const picked = injectLines(all, shown)
      shown = picked.shown
      const out = [...picked.lines]
      for (const [key, kind] of queued) {
        const l = all.find(x => x.key === key)
        if (kind === 'apply' && l?.state === 'approved') {
          out.push(applyRequest(l, suggestedFile(l.kind, l.type, home, opts.agentFiles ?? [])))
          injected.add(key)
        } else if (kind === 'revert' && l?.state === 'applied' && l.revertRequested) {
          out.push(revertRequest(l))
        }
      }
      queued.clear()
      return out
    },

    async approve(key, now) {
      if (!on) return
      try {
        const l = lessonOf(key, now)
        if (!l) return
        event(key, 'approve', now)
        const r = await run(memoryArgv(home, l))
        const id = r && r.exitCode === 0 ? memoryIdOf(r.stdout) : undefined
        if (id !== undefined) event(key, 'memory', now, { memoryId: id })
        else event(key, 'memory-error', now, { error: r?.stderr.trim() || 'no id' })
        waiting.delete(key)
        queued.set(key, 'apply')
      } catch {
        // recording only
      }
    },

    reject(key, now) {
      if (!on) return
      event(key, 'reject', now)
      forget(key)
    },

    cancel(key, now) {
      if (!on) return
      event(key, 'apply-cancel', now)
      forget(key)
    },

    retry(key) {
      if (!on) return
      waiting.delete(key)
      queued.set(key, 'apply')
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
      for (const key of injected) waiting.add(key)
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
