import type { EngineInterface, RenderElement } from 'claude-code'

import type { JarvisChange } from '../types'
import { relPath, repoName } from './changes'
import type { ChangeMode } from './changes'
import { isFailed } from './gitDiff'
import type { DiffRow, Failed, FileStat, Unpushed } from './gitDiff'
import { THEME, fitCells, padCells } from './jarvis'

export const MAX_LISTED = 200
export const DIFF_PANE = 'jarvis-diff'
export const MAX_DIFF_ROWS = 2000

export type DiffSeg = { t: string; color?: string; bold?: boolean }

// One file row: its key (what a press opens), its path, the label drawn, who changed it,
// its counts, a word instead of them when they cannot say (已刪除, 對 HEAD, an error), and
// whether git has not answered yet.
export type ChangeEntry = {
  key: string
  path: string
  label: string
  actors: string[]
  add: number
  del: number
  binary: boolean
  note?: string
  pending: boolean
}

export type ChangeGroup = {
  key: string
  name: string
  ahead?: number
  error?: string
  note?: string
  entries: ChangeEntry[]
  add: number
  del: number
  pending: boolean
}

export type ChangesView = { mode: ChangeMode; groups: ChangeGroup[]; pending: boolean; total: number }

const noteOf = (s: FileStat): string | undefined => (s.deleted ? '已刪除' : s.binary ? '二進位' : s.vsHead ? '對 HEAD' : undefined)

export function sessionGroups(
  list: readonly JarvisChange[],
  stats: ReadonlyMap<string, FileStat | Failed>,
  names: { cwd: string; home: string },
): ChangeGroup[] {
  const groups: ChangeGroup[] = []
  for (const c of list.slice(0, MAX_LISTED)) {
    const key = c.repo ?? ''
    let g = groups.find(x => x.key === key)
    if (!g) {
      g = { key, name: repoName(c.repo, names.cwd, names.home), entries: [], add: 0, del: 0, pending: false }
      groups.push(g)
    }
    const s = stats.get(c.path)
    const base = { key: `s:${c.path}`, path: c.path, label: relPath(c.path, c.repo, names.home), actors: c.actors }
    if (s === undefined) g.entries.push({ ...base, add: 0, del: 0, binary: false, pending: true })
    else if (isFailed(s)) g.entries.push({ ...base, add: 0, del: 0, binary: false, note: s.error, pending: false })
    else {
      const note = noteOf(s)
      g.entries.push({ ...base, add: s.add, del: s.del, binary: s.binary, ...(note ? { note } : {}), pending: false })
      g.add += s.add
      g.del += s.del
    }
    g.pending = g.pending || s === undefined
  }
  return groups
}

export function unpushedGroups(
  repos: readonly string[],
  results: ReadonlyMap<string, Unpushed | Failed>,
  list: readonly JarvisChange[],
  names: { cwd: string; home: string },
): ChangeGroup[] {
  return repos.map(repo => {
    const name = repoName(repo, names.cwd, names.home)
    const r = results.get(repo)
    if (r === undefined) return { key: repo, name, entries: [], add: 0, del: 0, pending: true }
    if (isFailed(r)) return { key: repo, name, error: r.error, entries: [], add: 0, del: 0, pending: false }
    const entries: ChangeEntry[] = r.files.slice(0, MAX_LISTED).map(f => {
      const note = f.binary ? '二進位' : undefined
      return {
        key: `u:${f.path}`,
        path: f.path,
        label: `${relPath(f.path, repo, names.home)}${f.untracked ? ' (新)' : ''}`,
        actors: list.find(c => c.path === f.path)?.actors ?? [],
        add: f.add,
        del: f.del,
        binary: f.binary,
        ...(note ? { note } : {}),
        pending: false,
      }
    })
    return {
      key: repo,
      name,
      ...(r.ahead > 0 ? { ahead: r.ahead } : {}),
      ...(r.note !== undefined ? { note: r.note } : {}),
      entries,
      add: entries.reduce((n, e) => n + e.add, 0),
      del: entries.reduce((n, e) => n + e.del, 0),
      pending: false,
    }
  })
}

const digits = (n: number) => String(Math.max(1, n)).length

type NumberedRow = Extract<DiffRow, { kind: 'add' | 'del' | 'ctx' }>
const numbered = (r: DiffRow): r is NumberedRow => r.kind !== 'hunk' && r.kind !== 'note'

// a diff line as drawn: no CR a CRLF file leaves, tabs as spaces so its width is known
const shownText = (text: string) => text.replace(/\r$/, '').replace(/\t/g, '    ')

// A diff's rows as lines `width` wide: old and new line numbers, then the sign and text,
// added in green, removed in red, hunk headers and notes in the frame color.
export function diffLines(rows: readonly DiffRow[], width: number): DiffSeg[][] {
  const shown = rows.slice(0, MAX_DIFF_ROWS)
  const top = shown.reduce((n, r) => (numbered(r) ? Math.max(n, r.old ?? 0, r.new ?? 0) : n), 0)
  const numW = digits(top)
  const gutter = numW * 2 + 2
  const textW = Math.max(1, width - gutter - 1)
  const out = shown.map((r): DiffSeg[] => {
    if (!numbered(r)) return [{ t: fitCells(shownText(r.text), width), color: THEME.frame }]
    const num = (n: number | undefined) => padCells(n === undefined ? '' : String(n), numW, 'right')
    const gut: DiffSeg = { t: `${num(r.old)} ${num(r.new)} `, color: THEME.muted }
    const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '
    const color = r.kind === 'add' ? THEME.success : r.kind === 'del' ? THEME.error : undefined
    return [gut, { t: fitCells(`${sign}${shownText(r.text)}`, textW + 1), ...(color ? { color } : {}) }]
  })
  if (rows.length > MAX_DIFF_ROWS) out.push([{ t: fitCells(`… 還有 ${rows.length - MAX_DIFF_ROWS} 行`, width), color: THEME.frame }])
  return out
}

export function drawDiff(
  ui: Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Text' | 'Button'>,
  d: { head: DiffSeg[]; body: DiffSeg[][] | string; at: number; count: number; prev: () => void; next: () => void; close: () => void },
): RenderElement {
  const { Box, Text, Button } = ui
  const line = (segs: readonly DiffSeg[]) => (
    <Box flexDirection="row">
      {segs
        .filter(s => s.t !== '')
        .map(s => (
          <Text {...(s.color ? { color: s.color } : {})} {...(s.bold ? { bold: true } : {})}>
            {s.t}
          </Text>
        ))}
    </Box>
  )
  return (
    <Box flexDirection="column">
      {line(d.head)}
      <Box flexDirection="row" gap={2}>
        <Button key="diff-prev" plain onPress={d.prev}>
          <Text color={THEME.frame}>‹</Text>
        </Button>
        <Text color={THEME.frame}>{`${d.at} / ${d.count}`}</Text>
        <Button key="diff-next" plain onPress={d.next}>
          <Text color={THEME.frame}>›</Text>
        </Button>
        <Button key="diff-close" plain onPress={d.close}>
          <Text color={THEME.frame}>✕</Text>
        </Button>
      </Box>
      {typeof d.body === 'string' ? <Text color={THEME.muted}>{d.body}</Text> : d.body.map(line)}
    </Box>
  )
}
