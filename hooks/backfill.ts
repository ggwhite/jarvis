import { DESC_LEN, type DispatchRow, rowFamily } from './ledger'

// Backfill: rebuild ledger rows from past subagent transcripts (`agent-<id>.meta.json` + `agent-<id>.jsonl`).

export const BACKFILL_DAYS = 14

const DAY_MS = 86_400_000

export function backfillPlan(home: string, now: number): { projectsDir: string; sinceMs: number } {
  return { projectsDir: `${home}/.claude/projects`, sinceMs: now - BACKFILL_DAYS * DAY_MS }
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function parseLines(jsonl: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = obj(JSON.parse(line))
      if (o) out.push(o)
    } catch {
      continue
    }
  }
  return out
}

function stamp(line: Record<string, unknown> | undefined): number {
  const ms = Date.parse(str(line?.['timestamp']))
  return Number.isNaN(ms) ? 0 : ms
}

export function backfillRow(meta: string, jsonl: string, ctx: { id: string; session: string; project: string }): DispatchRow | undefined {
  let m: Record<string, unknown> | undefined
  try {
    m = obj(JSON.parse(meta))
  } catch {
    return undefined
  }
  if (!m || m['finished'] !== true) return undefined

  const lines = parseLines(jsonl)
  const first = lines[0]
  const last = lines[lines.length - 1]
  const at = stamp(first)
  const doneAt = stamp(last)

  const tokens = { in: 0, out: 0, cr: 0, cw: 0 }
  const seen = new Set<string>()
  let tools = 0
  let toolErrors = 0
  for (const line of lines) {
    const message = obj(line['message'])
    const content = message?.['content']
    if (line['type'] === 'assistant' && message) {
      const mid = str(message['id'])
      const u = obj(message['usage'])
      if (u && !(mid && seen.has(mid))) {
        if (mid) seen.add(mid)
        tokens.in += num(u['input_tokens'])
        tokens.out += num(u['output_tokens'])
        tokens.cr += num(u['cache_read_input_tokens'])
        tokens.cw += num(u['cache_creation_input_tokens'])
      }
    }
    if (!Array.isArray(content)) continue
    for (const b of content) {
      const block = obj(b)
      if (block?.['type'] === 'tool_use') tools++
      else if (block?.['type'] === 'tool_result' && block['is_error'] === true) toolErrors++
    }
  }

  const firstContent = obj(first?.['message'])?.['content']
  const model = str(m['model'])
  return {
    v: 1,
    id: ctx.id,
    session: ctx.session,
    project: ctx.project,
    at,
    type: m['isFork'] === true ? 'fork' : str(m['agentType']),
    model,
    family: rowFamily(model),
    background: m['requestShape'] === 'background',
    desc: str(m['description']).slice(0, DESC_LEN),
    promptLen: typeof firstContent === 'string' ? firstContent.length : 0,
    doneAt,
    durationMs: doneAt - at,
    reason: 'answer',
    tokens,
    tools,
    toolErrors,
    backfill: true,
  }
}
