import type { JarvisChange } from '../types'
import { relPath, repoName } from './changes'
import type { ChangeMode } from './changes'
import { isFailed } from './gitDiff'
import type { DiffRow, Failed, FileStat, Unpushed } from './gitDiff'
import { t } from './i18n'
import { THEME, fitCells, padCells } from './jarvis'

export const MAX_LISTED = 200
export const MAX_DIFF_ROWS = 2000

export type DiffSeg = { t: string; color?: string; bold?: boolean }

// One file row: its key (what a press opens), its path, the label drawn, who changed it,
// its counts, a word instead of them when they cannot say (二進位, an error), a word before
// them (已刪除, 對 HEAD), whether it is deleted (its removed lines alone shown), and whether
// git has not answered yet.
export type ChangeEntry = {
  key: string
  path: string
  label: string
  actors: string[]
  add: number
  del: number
  binary: boolean
  note?: string
  mark?: string
  deleted?: boolean
  pending: boolean
}

// `removed`: a repo no longer on disk (a removed worktree, a deleted checkout), drawn as one line saying how many of its files
// the session changed, none listed.
export type ChangeGroup = {
  key: string
  name: string
  removed?: number
  ahead?: number
  error?: string
  note?: string
  entries: ChangeEntry[]
  add: number
  del: number
  pending: boolean
}

export type ChangesView = { mode: ChangeMode; groups: ChangeGroup[]; pending: boolean; total: number }

// `gone`: the changed files and repo roots no longer on disk. A file outside git that
// is gone was scratch and is not listed; a removed repo's files are only counted.
// The counts a group's rows show add up to the group's.
export function sessionGroups(
  list: readonly JarvisChange[],
  stats: ReadonlyMap<string, FileStat | Failed>,
  names: { cwd: string; home: string },
  gone: ReadonlySet<string> = new Set(),
): ChangeGroup[] {
  const groups: ChangeGroup[] = []
  for (const c of list.slice(0, MAX_LISTED)) {
    const s = stats.get(c.path)
    if (c.repo === null && (gone.has(c.path) || (s !== undefined && !isFailed(s) && s.deleted))) continue
    const key = c.repo ?? ''
    let g = groups.find(x => x.key === key)
    if (!g) {
      const where = c.repo !== null && c.worktree === undefined ? /^(.*?)\/(?:\.claude\/worktrees|\.worktrees)\/([^/]+)/.exec(c.repo) : null
      const wtName = c.worktree ?? where?.[2]
      if (c.repo !== null && gone.has(key)) g = { key, name: wtName !== undefined ? `worktree ${wtName}` : repoName(c.repo, names.cwd, names.home), removed: 0, entries: [], add: 0, del: 0, pending: false }
      else {
        const main = c.repo !== null && c.worktree !== undefined ? c.mainRepo : where?.[1] ? where[1] : undefined
        const name = main !== undefined && wtName !== undefined ? `${repoName(main, names.cwd, names.home)} · worktree ${wtName}` : wtName !== undefined ? `worktree ${wtName}` : repoName(c.repo, names.cwd, names.home)
        g = { key, name, entries: [], add: 0, del: 0, pending: false }
      }
      groups.push(g)
    }
    if (g.removed !== undefined) {
      g.removed += 1
      continue
    }
    const base = { key: `s:${c.path}`, path: c.path, label: relPath(c.path, c.repo, names.home), actors: c.actors }
    if (s === undefined) g.entries.push({ ...base, add: 0, del: 0, binary: false, pending: true })
    else if (isFailed(s)) g.entries.push({ ...base, add: 0, del: 0, binary: false, note: s.error, pending: false })
    else if (s.binary) g.entries.push({ ...base, add: 0, del: 0, binary: true, note: t('common.binary'), pending: false })
    else {
      const add = s.deleted ? 0 : s.add
      const mark = s.deleted ? t('changes.deleted') : s.vsHead ? t('changes.vsHead') : undefined
      g.entries.push({ ...base, add, del: s.del, binary: false, ...(mark ? { mark } : {}), ...(s.deleted ? { deleted: true } : {}), pending: false })
      g.add += add
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
      const note = f.binary ? t('common.binary') : undefined
      return {
        key: `u:${f.path}`,
        path: f.path,
        label: `${relPath(f.path, repo, names.home)}${f.untracked ? t('changes.untracked') : ''}`,
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
  if (rows.length > MAX_DIFF_ROWS) out.push([{ t: fitCells(t('changes.moreLines', { n: rows.length - MAX_DIFF_ROWS }), width), color: THEME.frame }])
  return out
}
