import { dirOf } from './changes'
import type { ChangesIo } from './changes'
import { GIT, answered, parseDiff, parseNumstatZ } from './gitDiff'
import type { DiffRow, Failed, NumstatRow } from './gitDiff'

export const FIND = '/usr/bin/find'
// how deep under the session directory a repo's .git is looked for
export const FIND_DEPTH = 4
// the commits a repo's tree page shows
export const MAX_COMMITS = 40
// the unpushed commits a repo's tree page marks
export const MAX_UNPUSHED = 1000

// `time`: when it was committed, in ms; `refs`: `%D` with --decorate=full, split
export type CommitInfo = { sha: string; parents: string[]; author: string; time: number; refs: string[]; subject: string }

// a repo as its list row shows it: the branch HEAD is on (its short sha when detached), the
// commits ahead of its upstream (absent without one), and when its last commit was made
export type RepoSummary = { branch: string; ahead?: number; time: number }

// a repo's newest commits, its upstream's among them, and those not pushed to it (at most
// MAX_UNPUSHED); `unpushedFailed`: it has an upstream but git could not say what is unpushed
export type CommitTree = { branch: string; upstream?: string; ahead: number; commits: CommitInfo[]; unpushed: string[]; unpushedFailed?: true }

export type CommitFile = NumstatRow

const LOG_FORMAT = '--format=%H%x00%P%x00%an%x00%ct%x00%D%x00%s%x1e'

export function findArgv(cwd: string): string[] {
  return [
    FIND, cwd, '-maxdepth', String(FIND_DEPTH),
    '(', '-name', 'node_modules', '-o', '-name', 'Library', '-o', '-name', '.Trash', '-o', '-name', '.cache', '-o', '-path', '*/.claude/worktrees', ')',
    '-prune', '-o', '-name', '.git', '-print', '-prune',
  ]
}

export function parseFound(stdout: string): string[] {
  const out = new Set<string>()
  for (const line of stdout.split('\n')) if (line.endsWith('/.git')) out.add(dirOf(line))
  return [...out].sort()
}

export async function findRepos(io: Pick<ChangesIo, 'run'>, cwd: string): Promise<string[] | Failed> {
  if (cwd === '') return { error: '找不到 repo' }
  const r = await io.run(findArgv(cwd))
  if (r === undefined) return { error: '找不到 repo' }
  const repos = parseFound(r.stdout)
  // find exits 1 on a directory it may not read, what it found still printed
  if (repos.length === 0 && r.exitCode !== 0) return { error: '找不到 repo' }
  return repos
}

export function parseRefs(d: string): string[] {
  return d.split(',').map(s => s.trim()).filter(s => s !== '')
}

export function parseLog(stdout: string): CommitInfo[] {
  return stdout.split('\x1e').flatMap(rec => {
    const f = rec.replace(/^\n+/, '').split('\x00')
    const [sha = '', parents = '', author = '', ct = '', refs = '', ...subject] = f
    if (f.length < 6 || !/^[0-9a-f]{7,}$/.test(sha)) return []
    return [{ sha, parents: parents.split(' ').filter(p => p !== ''), author, time: Number(ct) * 1000 || 0, refs: parseRefs(refs), subject: subject.join(' ') }]
  })
}

const headBranch = (refs: readonly string[]): string | undefined => {
  const head = refs.find(r => r.startsWith('HEAD -> '))
  return head === undefined ? undefined : head.slice('HEAD -> '.length).replace(/^refs\/heads\//, '')
}

// the branch HEAD is on, its short sha when detached; the logged commits may not reach HEAD
const headName = async (io: Pick<ChangesIo, 'run'>, repo: string): Promise<string | undefined> => {
  const b = await io.run([GIT, '-C', repo, 'symbolic-ref', '--short', '-q', 'HEAD'])
  if (b?.exitCode === 0 && b.stdout.trim() !== '') return b.stdout.trim()
  const s = await io.run([GIT, '-C', repo, 'rev-parse', '--short', 'HEAD'])
  return s?.exitCode === 0 && s.stdout.trim() !== '' ? s.stdout.trim() : undefined
}

export async function repoSummary(io: Pick<ChangesIo, 'run'>, repo: string): Promise<RepoSummary | Failed> {
  const r = await io.run([GIT, '-C', repo, 'log', '-1', '--decorate=full', '--format=%ct%x00%h%x00%D', 'HEAD'])
  if (!answered(r)) return { error: 'git log 失敗' }
  const [ct = '', short = '', refs = ''] = r.stdout.replace(/\n+$/, '').split('\x00')
  const a = await io.run([GIT, '-C', repo, 'rev-list', '--count', '@{u}..HEAD'])
  const ahead = a?.exitCode === 0 ? Number(a.stdout.trim()) || 0 : undefined
  return { branch: headBranch(parseRefs(refs)) ?? short, ...(ahead !== undefined ? { ahead } : {}), time: Number(ct) * 1000 || 0 }
}

export async function commitTreeOf(io: Pick<ChangesIo, 'run'>, repo: string): Promise<CommitTree | Failed> {
  const u = await io.run([GIT, '-C', repo, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const upstream = u?.exitCode === 0 && u.stdout.trim() !== '' ? u.stdout.trim() : undefined
  const r = await io.run([GIT, '-C', repo, 'log', '--topo-order', '--decorate=full', '-n', String(MAX_COMMITS), LOG_FORMAT, 'HEAD', ...(upstream ? [upstream] : [])])
  if (!answered(r)) return { error: 'git log 失敗' }
  const commits = parseLog(r.stdout)
  let unpushed: string[] = []
  let unpushedFailed = false
  if (upstream !== undefined) {
    const p = await io.run([GIT, '-C', repo, 'rev-list', `${upstream}..HEAD`])
    if (p?.exitCode === 0) unpushed = p.stdout.split('\n').map(s => s.trim()).filter(s => s !== '').slice(0, MAX_UNPUSHED)
    else unpushedFailed = true
  }
  const refs = commits.flatMap(c => c.refs)
  const branch = (await headName(io, repo)) ?? headBranch(refs) ?? (refs.includes('HEAD') ? '(detached)' : '?')
  return { branch, ...(upstream !== undefined ? { upstream } : {}), ahead: unpushed.length, commits, unpushed, ...(unpushedFailed ? { unpushedFailed: true as const } : {}) }
}

export async function commitFiles(io: Pick<ChangesIo, 'run'>, repo: string, c: Pick<CommitInfo, 'sha' | 'parents'>): Promise<CommitFile[] | Failed> {
  const [p] = c.parents
  const argv =
    p === undefined
      ? [GIT, '-C', repo, 'show', '--numstat', '-z', '--no-renames', '--format=', c.sha]
      : [GIT, '-C', repo, 'diff', '--numstat', '-z', '--no-renames', p, c.sha]
  const r = await io.run(argv)
  if (!answered(r)) return { error: 'git diff 失敗' }
  return parseNumstatZ(r.stdout.replace(/^\n+/, ''))
}

export async function commitFileDiff(
  io: Pick<ChangesIo, 'run'>,
  repo: string,
  c: Pick<CommitInfo, 'sha' | 'parents'>,
  path: string,
): Promise<DiffRow[] | Failed> {
  const [p] = c.parents
  const argv =
    p === undefined
      ? [GIT, '-C', repo, 'show', '--no-color', '--no-renames', '--format=', c.sha, '--', path]
      : [GIT, '-C', repo, 'diff', '--no-color', '--no-renames', p, c.sha, '--', path]
  const r = await io.run(argv)
  return answered(r) ? parseDiff(r.stdout) : { error: 'git diff 失敗' }
}
