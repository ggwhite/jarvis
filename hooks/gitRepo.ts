import type { ChangesIo } from './changes'
import { GIT, answered, parseDiff, parseNumstatZ, pickTarget } from './gitDiff'
import type { DiffRow, Failed, NumstatRow } from './gitDiff'
import { branchRows, countStatus, parseBranchRefs, parseRemotes, parseStashes, parseWorktrees, worktreeRows } from './repoViews'
import type { BranchList, Remotes, StashInfo, WorktreeRow } from './repoViews'
import { t } from './i18n'

export const ENV = '/usr/bin/env'
// how long a fetch may take before it is given up
export const FETCH_TIMEOUT_MS = 60_000

export const BRANCH_FORMAT =
  '--format=%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(objectname:short)%00%(HEAD)%00%(subject)%1e'
export const STASH_FORMAT = '--format=%H%x00%gd%x00%ct%x00%gs%x1e'

// a stash's file; `untracked`: in the stash's third parent, not a change to a tracked file
export type StashFile = NumstatRow & { untracked: boolean }

// The remotes by their fetch URL, and when the repo was last fetched: FETCH_HEAD's mtime
// in the common git dir (a linked worktree's is its main repo's, given absolute).
export async function remotesOf(io: Pick<ChangesIo, 'run' | 'stat'>, repo: string): Promise<Remotes | Failed> {
  const r = await io.run([GIT, '-C', repo, 'remote', '-v'])
  if (!answered(r)) return { error: t('err.failed', { what: 'git remote' }) }
  const remotes = parseRemotes(r.stdout)
  const d = await io.run([GIT, '-C', repo, 'rev-parse', '--git-common-dir'])
  const dir = answered(d) ? d.stdout.trim() : ''
  if (dir === '') return { remotes }
  const s = await io.stat(`${dir.startsWith('/') ? dir : `${repo}/${dir}`}/FETCH_HEAD`)
  return { remotes, ...(s !== undefined ? { fetchedAt: s.mtimeMs } : {}) }
}

// The branches as rows; those merged into the main branch (origin/HEAD, origin/main or
// origin/master) marked when there is one.
export async function branchesOf(io: Pick<ChangesIo, 'run'>, repo: string): Promise<BranchList | Failed> {
  const r = await io.run([GIT, '-C', repo, 'for-each-ref', '--sort=-committerdate', BRANCH_FORMAT, 'refs/heads', 'refs/remotes'])
  if (!answered(r)) return { error: t('err.failed', { what: 'git for-each-ref' }) }
  const target = await pickTarget(io, repo)
  let merged: Set<string> | undefined
  if (target !== undefined) {
    const m = await io.run([GIT, '-C', repo, 'for-each-ref', `--merged=${target}`, '--format=%(refname)', 'refs/heads', 'refs/remotes'])
    if (answered(m)) merged = new Set(m.stdout.split('\n').map(s => s.trim()).filter(s => s !== ''))
  }
  return branchRows(parseBranchRefs(r.stdout), merged)
}

export async function stashesOf(io: Pick<ChangesIo, 'run'>, repo: string): Promise<StashInfo[] | Failed> {
  const r = await io.run([GIT, '-C', repo, 'stash', 'list', STASH_FORMAT])
  return answered(r) ? parseStashes(r.stdout) : { error: t('err.failed', { what: 'git stash' }) }
}

// A stash's files, untracked ones included; those its third parent holds are untracked (no
// third parent: none are).
export async function stashFiles(io: Pick<ChangesIo, 'run'>, repo: string, sha: string): Promise<StashFile[] | Failed> {
  const r = await io.run([GIT, '-C', repo, 'stash', 'show', '--include-untracked', '--numstat', '-z', '--no-renames', sha])
  if (!answered(r)) return { error: t('err.failed', { what: 'git stash' }) }
  const u = await io.run([GIT, '-C', repo, 'ls-tree', '-r', '--name-only', '-z', `${sha}^3`])
  const untracked = new Set(answered(u) ? u.stdout.split('\x00').filter(s => s !== '') : [])
  return parseNumstatZ(r.stdout.replace(/^\n+/, '')).map(f => ({ ...f, untracked: untracked.has(f.path) }))
}

// A tracked file's change against the stash's base; an untracked file whole, from its third parent.
export async function stashFileDiff(io: Pick<ChangesIo, 'run'>, repo: string, sha: string, f: StashFile): Promise<DiffRow[] | Failed> {
  const argv = f.untracked
    ? [GIT, '-C', repo, 'show', '--no-color', '--no-renames', '--format=', `${sha}^3`, '--', f.path]
    : [GIT, '-C', repo, 'diff', '--no-color', '--no-renames', `${sha}^1`, sha, '--', f.path]
  const r = await io.run(argv)
  return answered(r) ? parseDiff(r.stdout) : { error: t('err.failed', { what: 'git diff' }) }
}

// Every worktree with its uncommitted files; a pruned or bare one is not asked.
export async function worktreesOf(io: Pick<ChangesIo, 'run'>, repo: string): Promise<WorktreeRow[] | Failed> {
  const r = await io.run([GIT, '-C', repo, 'worktree', 'list', '--porcelain', '-z'])
  if (!answered(r)) return { error: t('err.failed', { what: 'git worktree' }) }
  const list = parseWorktrees(r.stdout)
  const dirty = new Map<string, number>()
  for (const w of list) {
    if (w.prunable || w.bare) continue
    const s = await io.run([GIT, '-C', w.path, 'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=normal'])
    if (answered(s)) dirty.set(w.path, countStatus(s.stdout))
  }
  return worktreeRows(list, dirty)
}

// `repo` and every worktree of its repository (they share its remote refs and FETCH_HEAD);
// `repo` alone when git cannot list them
export async function sameRepoPaths(io: Pick<ChangesIo, 'run'>, repo: string): Promise<string[]> {
  const r = await io.run([GIT, '-C', repo, 'worktree', 'list', '--porcelain', '-z'])
  const paths = answered(r) ? parseWorktrees(r.stdout).map(w => w.path) : []
  return [...new Set([repo, ...paths])]
}

// Fetches every remote and prunes the gone branches, never asking for a password or passphrase.
export function fetchArgv(repo: string): string[] {
  return [ENV, 'GIT_TERMINAL_PROMPT=0', GIT, '-C', repo, '-c', 'core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=10', 'fetch', '--all', '--prune']
}

// true when done; else why not: stderr's last line, or that it ran past its time
export async function fetchRepo(io: Pick<ChangesIo, 'run'>, repo: string): Promise<true | Failed> {
  const r = await io.run(fetchArgv(repo))
  if (r === undefined) return { error: t('err.fetchTimeout') }
  if (r.exitCode === 0) return true
  const last = r.stderr.split('\n').map(s => s.trim()).filter(s => s !== '').at(-1)
  return { error: last ?? t('err.failed', { what: 'fetch' }) }
}
