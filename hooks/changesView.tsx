import type { JarvisChange } from '../types'
import { relPath, repoName } from './changes'
import type { ChangeMode } from './changes'
import { isFailed } from './gitDiff'
import type { Failed, FileStat, Unpushed } from './gitDiff'

export const MAX_LISTED = 200

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
