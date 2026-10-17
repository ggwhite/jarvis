import { repoName } from './changes'
import { commitGraph } from './commitGraph'
import type { GraphRow } from './commitGraph'
import type { CommitFile, CommitInfo, CommitTree, RepoSummary } from './gitCommits'
import { isFailed } from './gitDiff'
import type { DiffRow, Failed } from './gitDiff'
import type { StashFile } from './gitRepo'
import { COMMIT_ICON } from './icons'
import { t } from './i18n'
import { JARVIS_PALETTE, THEME } from './jarvis'
import type { BranchList, Remotes, RepoView, StashInfo, WorktreeRow } from './repoViews'

export const MAX_REPOS = 100

// one color per lane by its number; neighbours never share one
export const LANE_COLORS: readonly string[] = [THEME.accent, THEME.success, THEME.primary, JARVIS_PALETTE[0], JARVIS_PALETTE[2], JARVIS_PALETTE[3]]

export const laneColor = (lane: number): string => (lane < 0 ? THEME.frame : (LANE_COLORS[lane % LANE_COLORS.length] ?? THEME.frame))

export function relTime(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return t('time.justNow')
  if (m < 60) return t('time.minutesAgo', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('time.hoursAgo', { n: h })
  const d = Math.floor(h / 24)
  if (d < 2) return t('time.yesterday')
  if (d < 30) return t('time.daysAgo', { n: d })
  if (d < 365) return t('time.monthsAgo', { n: Math.floor(d / 30) })
  return t('time.yearsAgo', { n: Math.floor(d / 365) })
}

// the session directory by its own name, not '.'
export function commitRepoName(repo: string, cwd: string, home: string): string {
  if (repo === cwd) return repo.slice(repo.lastIndexOf('/') + 1) || repo
  return repoName(repo, cwd, home)
}

// `touched`: the session changed a file in it or a Bash call went into it; `pending`: git
// has not answered yet
export type RepoRow = { repo: string; name: string; touched: boolean; pending: boolean; branch?: string; ahead?: number; time?: number; error?: string }

// `more`: the repos past MAX_REPOS; `scanning`: find or git is still being asked
export type RepoList = { rows: RepoRow[]; more: number; total: number; scanning: boolean; error?: string }

export function repoRows(
  repos: readonly string[] | Failed | undefined,
  summaries: ReadonlyMap<string, RepoSummary | Failed>,
  touched: ReadonlySet<string>,
  names: { cwd: string; home: string },
  scanning: boolean,
): RepoList {
  if (repos === undefined) return { rows: [], more: 0, total: 0, scanning: true }
  if (isFailed(repos)) return { rows: [], more: 0, total: 0, scanning: false, error: repos.error }
  const rows: RepoRow[] = repos.map(repo => {
    const base = { repo, name: commitRepoName(repo, names.cwd, names.home), touched: touched.has(repo) }
    const s = summaries.get(repo)
    if (s === undefined) return { ...base, pending: true }
    if (isFailed(s)) return { ...base, pending: false, error: s.error }
    return { ...base, pending: false, branch: s.branch, ...(s.ahead !== undefined ? { ahead: s.ahead } : {}), time: s.time }
  })
  rows.sort(
    (a, b) =>
      Number(b.touched) - Number(a.touched) ||
      (b.time ?? -1) - (a.time ?? -1) ||
      Number(a.pending) - Number(b.pending) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
  return { rows: rows.slice(0, MAX_REPOS), more: Math.max(0, rows.length - MAX_REPOS), total: rows.length, scanning }
}

export type RefLabel = { kind: 'head' | 'branch' | 'remote' | 'tag'; name: string }

// `%D` refs with --decorate=full as labels: the branch HEAD is on (HEAD itself when
// detached), local branches, remote ones but their HEAD, tags; other refs left out
export function refLabels(refs: readonly string[], max = 2): RefLabel[] {
  const out: RefLabel[] = []
  for (const r of refs) {
    if (r.startsWith('HEAD -> ')) out.push({ kind: 'head', name: r.slice('HEAD -> '.length).replace(/^refs\/heads\//, '') })
    else if (r === 'HEAD') out.push({ kind: 'head', name: 'HEAD' })
    else if (r.startsWith('tag: ')) out.push({ kind: 'tag', name: r.slice('tag: '.length).replace(/^refs\/tags\//, '') })
    else if (r.startsWith('refs/heads/')) out.push({ kind: 'branch', name: r.slice('refs/heads/'.length) })
    else if (r.startsWith('refs/remotes/') && !r.endsWith('/HEAD')) out.push({ kind: 'remote', name: r.slice('refs/remotes/'.length) })
  }
  return out.slice(0, max)
}

// `session`: committed since the session started
export type CommitRow = { commit: CommitInfo; graph: GraphRow; unpushed: boolean; session: boolean; refs: RefLabel[] }

export function commitRows(tree: CommitTree, startedAt: number | undefined): CommitRow[] {
  const graph = commitGraph(tree.commits)
  const unpushed = new Set(tree.unpushed)
  return tree.commits.map((commit, i) => {
    const g = graph[i] ?? { cells: [], lane: 0, node: 0, overflow: false }
    const head = commit.refs.some(r => r === 'HEAD' || r.startsWith('HEAD -> '))
    const glyph = head ? COMMIT_ICON.head : commit.parents.length >= 2 ? COMMIT_ICON.merge : COMMIT_ICON.node
    const cells = g.cells.map((c, j) => (j === g.node ? { ...c, ch: glyph } : c))
    return {
      commit,
      graph: { ...g, cells },
      unpushed: unpushed.has(commit.sha),
      session: startedAt !== undefined && commit.time >= startedAt,
      refs: refLabels(commit.refs),
    }
  })
}

// A repo's tree page: its commits (of `ref`, HEAD when absent), the sub-page shown, its
// remotes, whether a fetch is running or why the last one failed, the sub-pages as git gave
// them (undefined while asked or when not shown), each one's count once answered and whether
// the branches' gone and 只在遠端 groups are open.
export type RepoPage = {
  path: string
  name: string
  tree: CommitTree | Failed | undefined
  view: RepoView
  ref: string | undefined
  remotes: Remotes | Failed | undefined
  fetching: boolean
  fetchError: string | undefined
  branches: BranchList | Failed | undefined
  stashes: StashInfo[] | Failed | undefined
  worktrees: WorktreeRow[] | Failed | undefined
  counts: { branches: number | undefined; stash: number | undefined; worktrees: number | undefined }
  goneOpen: boolean
  remoteOpen: boolean
}

// the stash diff page: the stash, its files, the file shown and that file's diff
export type StashDiff = { stash: StashInfo; files: StashFile[] | Failed | undefined; file: StashFile | undefined; rows: DiffRow[] | Failed | undefined }

// The commits mode as the cockpit draws it: the session directory's name, the time now and
// when the session started, the repo list (on the changes page), and the presses that open a
// repo's tree and ask find and git again.
export type CommitsCtx = {
  cwdName: string
  now: number
  startedAt?: number
  list?: RepoList
  // the tree page, the stash diff page's repo too
  repo?: RepoPage
  // the commit's diff page: the commit, its files, the file shown and that file's diff
  diff?: { commit: CommitInfo; files: CommitFile[] | Failed | undefined; file?: CommitFile; rows: DiffRow[] | Failed | undefined }
  stashDiff?: StashDiff
  openRepo: (repo: string) => void
  openCommit: (sha: string) => void
  openFile: (path: string) => void
  refreshList: () => void
  // asks again the sub-page shown and the remotes
  refreshTree: () => void
  setView: (view: RepoView) => void
  openBranch: (ref: string) => void
  // opens the branches' gone group, or folds it; the same for 只在遠端
  toggleGone: () => void
  toggleRemote: () => void
  openStash: (sha: string) => void
  openStashFile: (path: string) => void
  openWorktree: (path: string) => void
  // the tree page's 返回: the branch or worktree list it was opened from, else the repo list
  back: () => void
  fetch: () => void
}
