import type { JarvisChange } from '../types'
import { CREATED, UNKNOWN } from './changes'
import type { ChangesIo } from './changes'

export const GIT = '/usr/bin/git'
export const MAX_UNTRACKED = 50

export type NumstatRow = { path: string; add: number; del: number; binary: boolean }

export type DiffRow =
  | { kind: 'hunk' | 'note'; text: string }
  | { kind: 'add' | 'del' | 'ctx'; old?: number; new?: number; text: string }

export type FileStat = { add: number; del: number; binary: boolean; deleted: boolean; vsHead: boolean }

export type Failed = { error: string }

export type UnpushedFile = { path: string; add: number; del: number; binary: boolean; untracked: boolean }

export type Unpushed = { target?: string; base: string; ahead: number; files: UnpushedFile[] }

export const isFailed = (x: unknown): x is Failed =>
  typeof x === 'object' && x !== null && typeof (x as { error?: unknown }).error === 'string'

export function parseNumstat(stdout: string): NumstatRow[] {
  return stdout.split('\n').flatMap(line => {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!m) return []
    const binary = m[1] === '-'
    return [{ path: m[3] ?? '', add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary }]
  })
}

// `diff --numstat -z --no-renames`: `add\tdel\tpath` records ended by NUL, paths unquoted
export function parseNumstatZ(stdout: string): NumstatRow[] {
  return stdout.split('\0').flatMap(rec => {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec)
    if (!m) return []
    const binary = m[1] === '-'
    return [{ path: m[3] ?? '', add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary }]
  })
}

export function parseDiff(stdout: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldN = 0
  let newN = 0
  let inHunk = false
  for (const line of stdout.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) {
      oldN = Number(h[1])
      newN = Number(h[2])
      inHunk = true
      rows.push({ kind: 'hunk', text: line })
    } else if (line.startsWith('diff --git ')) {
      inHunk = false
    } else if (inHunk && line.startsWith('+')) {
      rows.push({ kind: 'add', new: newN, text: line.slice(1) })
      newN += 1
    } else if (inHunk && line.startsWith('-')) {
      rows.push({ kind: 'del', old: oldN, text: line.slice(1) })
      oldN += 1
    } else if (inHunk && line.startsWith(' ')) {
      rows.push({ kind: 'ctx', old: oldN, new: newN, text: line.slice(1) })
      oldN += 1
      newN += 1
    } else if (inHunk && line.startsWith('\\')) {
      rows.push({ kind: 'note', text: line })
    }
  }
  return rows
}

// `git diff --no-index` exits 1 when the two differ
const answered = (r: { exitCode: number } | undefined, differs = false): r is { exitCode: number; stdout: string; stderr: string } =>
  r !== undefined && (r.exitCode === 0 || (differs && r.exitCode === 1))

type Source = Pick<JarvisChange, 'path' | 'repo' | 'orig'>

// what a session change is compared by: its original against the file now, or HEAD when
// the original is unknown; undefined when there is nothing to compare with
async function sessionArgv(io: ChangesIo, c: Source, kind: '--numstat' | '--no-color'): Promise<{ argv: string[]; deleted: boolean; vsHead: boolean } | undefined> {
  const deleted = (await io.stat(c.path)) === undefined
  if (c.orig === UNKNOWN) {
    if (c.repo === null) return undefined
    const flags = kind === '--numstat' ? ['--numstat', '--no-renames'] : ['--no-color', '--no-renames']
    return { argv: [GIT, '-C', c.repo, 'diff', ...flags, 'HEAD', '--', c.path], deleted, vsHead: true }
  }
  return { argv: [GIT, 'diff', '--no-index', kind, '--', c.orig, deleted ? CREATED : c.path], deleted, vsHead: false }
}

export async function sessionStat(io: ChangesIo, c: Source): Promise<FileStat | Failed> {
  const how = await sessionArgv(io, c, '--numstat')
  if (!how) return { error: '無原始內容' }
  const r = await io.run(how.argv)
  if (!answered(r, true)) return { error: 'git diff 失敗' }
  const row = parseNumstat(r.stdout)[0]
  return { add: row?.add ?? 0, del: row?.del ?? 0, binary: row?.binary ?? false, deleted: how.deleted, vsHead: how.vsHead }
}

export async function sessionDiff(io: ChangesIo, c: Source): Promise<DiffRow[] | Failed> {
  const how = await sessionArgv(io, c, '--no-color')
  if (!how) return { error: '無原始內容' }
  const r = await io.run(how.argv)
  return answered(r, true) ? parseDiff(r.stdout) : { error: 'git diff 失敗' }
}

export async function pickTarget(io: ChangesIo, repo: string): Promise<string | undefined> {
  const head = await io.run([GIT, '-C', repo, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
  const named = head?.exitCode === 0 ? head.stdout.trim() : ''
  if (named !== '') return named
  for (const ref of ['origin/main', 'origin/master']) {
    const r = await io.run([GIT, '-C', repo, 'rev-parse', '-q', '--verify', ref])
    if (r?.exitCode === 0) return ref
  }
  return undefined
}

export async function unpushedOf(io: ChangesIo, repo: string): Promise<Unpushed | Failed> {
  const target = await pickTarget(io, repo)
  let base = 'HEAD'
  if (target !== undefined) {
    const mb = await io.run([GIT, '-C', repo, 'merge-base', 'HEAD', target])
    if (mb?.exitCode === 0 && mb.stdout.trim() !== '') base = mb.stdout.trim()
  }
  let ahead = 0
  if (base !== 'HEAD') {
    const c = await io.run([GIT, '-C', repo, 'rev-list', '--count', `${base}..HEAD`])
    ahead = c?.exitCode === 0 ? Number(c.stdout.trim()) || 0 : 0
  }
  const d = await io.run([GIT, '-C', repo, 'diff', '--numstat', '-z', '--no-renames', base])
  if (!answered(d)) return { error: 'git diff 失敗' }
  const files: UnpushedFile[] = parseNumstatZ(d.stdout).map(f => ({ ...f, path: `${repo}/${f.path}`, untracked: false }))
  const u = await io.run([GIT, '-C', repo, 'ls-files', '--others', '--exclude-standard', '-z'])
  const untracked = answered(u) ? u.stdout.split('\0').filter(s => s !== '').slice(0, MAX_UNTRACKED) : []
  for (const rel of untracked) {
    const path = `${repo}/${rel}`
    const n = await io.run([GIT, 'diff', '--no-index', '--numstat', '--', CREATED, path])
    const row = answered(n, true) ? parseNumstat(n.stdout)[0] : undefined
    files.push({ path, add: row?.add ?? 0, del: 0, binary: row?.binary ?? false, untracked: true })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { ...(target !== undefined ? { target } : {}), base, ahead, files }
}

export async function unpushedDiff(io: ChangesIo, repo: string, base: string, f: UnpushedFile): Promise<DiffRow[] | Failed> {
  const argv = f.untracked
    ? [GIT, 'diff', '--no-index', '--no-color', '--', CREATED, f.path]
    : [GIT, '-C', repo, 'diff', '--no-color', '--no-renames', base, '--', f.path]
  const r = await io.run(argv)
  return answered(r, true) ? parseDiff(r.stdout) : { error: 'git diff 失敗' }
}
