// Real git, real processes: the unit tests answer by argv through a fake, so they cannot tell
// when git refuses an argv. `claude plugin test` has no process (and only loads *.test.ts), so this is a *.spec.ts run under bun:
//   bun test claude/mods/jarvis/integration
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ChangesIo } from '../hooks/changes'
import { commitTreeOf } from '../hooks/gitCommits'
import { GIT, isFailed } from '../hooks/gitDiff'
import { branchesOf, stashFileDiff, stashFiles, stashesOf, worktreesOf } from '../hooks/gitRepo'

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' }

const io: Pick<ChangesIo, 'run' | 'stat'> = {
  run: async argv => {
    const p = Bun.spawn(argv, { env: ENV, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { exitCode, stdout, stderr }
  },
  stat: async path => {
    try {
      const s = statSync(path)
      return { kind: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other', size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return undefined
    }
  },
}

const git = async (repo: string, ...args: string[]): Promise<string> => {
  const r = await io.run([GIT, '-C', repo, ...args])
  if (r === undefined || r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r?.stderr}`)
  return r.stdout
}

const file = (repo: string, name: string, text: string) => {
  mkdirSync(join(repo, name, '..'), { recursive: true })
  writeFileSync(join(repo, name), text)
}

const commit = async (repo: string, name: string, text: string, msg: string) => {
  file(repo, name, text)
  await git(repo, 'add', name)
  await git(repo, 'commit', '-q', '-m', msg)
}

let root = ''
let work = ''
let upstream = ''

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-git-')))
  upstream = join(root, 'upstream.git')
  work = join(root, 'work')
  mkdirSync(work)
  await git(root, 'init', '-q', '--bare', '-b', 'main', upstream)
  await git(work, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']] as const) await git(work, 'config', k, v)
  await git(work, 'remote', 'add', 'origin', upstream)
  await commit(work, 'a.txt', 'a\n', 'init')
  await git(work, 'push', '-q', '-u', 'origin', 'main')
  await git(work, 'remote', 'set-head', 'origin', 'main')
  // feat/x tracks origin/feat/x and is one commit ahead of it
  await git(work, 'switch', '-q', '-c', 'feat/x')
  await commit(work, 'x.txt', 'x\n', 'pushed')
  await git(work, 'push', '-q', '-u', 'origin', 'feat/x')
  await commit(work, 'x2.txt', 'x2\n', 'not pushed')
  // done/y is merged into main and pushed with it
  await git(work, 'switch', '-q', 'main')
  await git(work, 'switch', '-q', '-c', 'done/y')
  await commit(work, 'y.txt', 'y\n', 'y')
  await git(work, 'switch', '-q', 'main')
  await git(work, 'merge', '-q', '--ff-only', 'done/y')
  await git(work, 'push', '-q', 'origin', 'main')
})

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe('commitTreeOf with a full refname, on real git', () => {
  test('a local branch with a slash in its name finds its upstream and its one unpushed commit', async () => {
    const t = await commitTreeOf(io, work, 'refs/heads/feat/x')
    if (isFailed(t)) throw new Error(t.error)
    expect(t.branch).toBe('feat/x')
    expect(t.upstream).toBe('origin/feat/x')
    expect(t.ahead).toBe(1)
    expect(t.unpushed.length).toBe(1)
    expect(t.unpushedFailed).toBeUndefined()
    expect(t.commits[0]?.subject).toBe('not pushed')
    expect(t.commits.some(c => c.subject === 'pushed')).toBe(true)
  })

  test('a remote branch has no upstream and nothing unpushed', async () => {
    const t = await commitTreeOf(io, work, 'refs/remotes/origin/feat/x')
    if (isFailed(t)) throw new Error(t.error)
    expect(t.branch).toBe('origin/feat/x')
    expect(t.upstream).toBeUndefined()
    expect(t.unpushed).toEqual([])
  })

  test('a local branch without an upstream has none', async () => {
    await git(work, 'branch', 'loose')
    const t = await commitTreeOf(io, work, 'refs/heads/loose')
    if (isFailed(t)) throw new Error(t.error)
    expect(t.upstream).toBeUndefined()
    expect(t.ahead).toBe(0)
  })

  test('without a ref, HEAD and its upstream as before', async () => {
    const t = await commitTreeOf(io, work)
    if (isFailed(t)) throw new Error(t.error)
    expect(t.branch).toBe('main')
    expect(t.upstream).toBe('origin/main')
    expect(t.ahead).toBe(0)
  })
})

describe('branchesOf, on real git', () => {
  test('git accepts the for-each-ref and --merged argv; merged ones are marked', async () => {
    const b = await branchesOf(io, work)
    if (isFailed(b)) throw new Error(b.error)
    expect(b.mergeKnown).toBe(true)
    const rows = [...(b.current ? [b.current] : []), ...b.active.rows, ...b.remote.rows, ...b.gone.rows]
    const by = (n: string) => rows.find(r => r.name === n)
    expect(by('main')).toMatchObject({ kind: 'current', upstream: true, merged: true })
    expect(by('done/y')).toMatchObject({ kind: 'local', upstream: false, merged: true })
    expect(by('feat/x')).toMatchObject({ kind: 'local', upstream: true, ahead: 1, behind: 0, merged: false })
    // origin/main and origin/feat/x are tracked by local branches, so listed once
    expect(rows.some(r => r.name.startsWith('origin/'))).toBe(false)
    expect([b.active.more, b.remote.more, b.gone.more]).toEqual([0, 0, 0])
  })
})

describe('stashes, on real git', () => {
  test('a stash made with -u lists its tracked and untracked files, and their diffs', async () => {
    await git(work, 'switch', '-q', 'main')
    file(work, 'a.txt', 'a\nchanged\n')
    file(work, 'new dir/n.txt', 'n1\nn2\n')
    await git(work, 'stash', 'push', '-q', '-u', '-m', 'half done: wip')
    const list = await stashesOf(io, work)
    if (isFailed(list)) throw new Error(list.error)
    expect(list.length).toBe(1)
    const [s] = list
    if (!s) throw new Error('one stash')
    expect(s).toMatchObject({ name: 'stash@{0}', branch: 'main', message: 'half done: wip' })

    const files = await stashFiles(io, work, s.sha)
    if (isFailed(files)) throw new Error(files.error)
    expect(files.map(f => [f.path, f.untracked]).sort()).toEqual([
      ['a.txt', false],
      ['new dir/n.txt', true],
    ])
    const tracked = files.find(f => f.path === 'a.txt')
    const untracked = files.find(f => f.path === 'new dir/n.txt')
    if (!tracked || !untracked) throw new Error('both files')
    expect(untracked).toMatchObject({ add: 2, del: 0 })
    const t = await stashFileDiff(io, work, s.sha, tracked)
    if (isFailed(t)) throw new Error(t.error)
    expect(t.filter(r => r.kind === 'add').map(r => r.text)).toEqual(['changed'])
    const u = await stashFileDiff(io, work, s.sha, untracked)
    if (isFailed(u)) throw new Error(u.error)
    expect(u.filter(r => r.kind === 'add').map(r => r.text)).toEqual(['n1', 'n2'])
  })
})

describe('worktreesOf, on real git', () => {
  test('the main checkout first, a linked worktree after it, each with its dirty count', async () => {
    const wt = join(work, '.claude', 'worktrees', 'repo-views')
    writeFileSync(join(work, '.git', 'info', 'exclude'), '/.claude/\n')
    await git(work, 'worktree', 'add', '-q', '-b', 'wt-branch', wt)
    file(wt, 'dirty.txt', 'd\n')
    const rows = await worktreesOf(io, work)
    if (isFailed(rows)) throw new Error(rows.error)
    expect(rows.map(r => [r.name, r.main, r.agent, r.branch, r.dirty])).toEqual([
      ['work', true, false, 'main', 0],
      ['.claude/worktrees/repo-views', false, false, 'wt-branch', 1],
    ])
  })
})
