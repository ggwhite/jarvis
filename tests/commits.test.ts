import { describe, expect, test } from 'claude-code/testing'

import { commitGraph, graphWidth } from '../hooks/commitGraph'
import type { GraphCommit, GraphRow } from '../hooks/commitGraph'
import type { ChangesIo } from '../hooks/changes'
import { FIND, commitFileDiff, commitFiles, commitTreeOf, findArgv, findRepos, parseFound, parseLog, parseRefs, repoSummary } from '../hooks/gitCommits'
import { GIT, isFailed } from '../hooks/gitDiff'

const c = (sha: string, ...parents: string[]): GraphCommit => ({ sha, parents })
const txt = (r: GraphRow): string => r.cells.map(x => x.ch).join('')

describe('commitGraph', () => {
  test('a straight history is one lane', () => {
    const rows = commitGraph([c('a', 'b'), c('b', 'c'), c('c')])
    expect(rows.map(txt)).toEqual(['●', '●', '●'])
    expect(rows.map(r => r.lane)).toEqual([0, 0, 0])
    expect(rows.every(r => r.node === 0 && !r.overflow)).toBe(true)
  })

  test('a branch opens right of its merge and closes into the base', () => {
    const rows = commitGraph([c('m', 'p', 'f2'), c('f2', 'f1'), c('f1', 'b'), c('p', 'b'), c('b')])
    expect(rows.map(txt)).toEqual(['●─╮', '│ ●', '│ ●', '● │', '●─╯'])
    expect(rows[0]?.cells.map(x => x.lane)).toEqual([0, 1, 1])
    expect(rows[1]?.lane).toBe(1)
    expect(rows[1]?.node).toBe(2)
  })

  test('a link crossing a lane that passes through draws ┼', () => {
    const rows = commitGraph([c('a', 'b'), c('x', 'd'), c('e', 'b'), c('b')])
    expect(rows.map(txt)).toEqual(['●', '│ ●', '│ │ ●', '●─┼─╯'])
    expect(rows[3]?.cells[2]?.lane).toBe(1)
  })

  test('an octopus merge opens a lane per parent and they close together', () => {
    const rows = commitGraph([c('m', 'a', 'b', 'c'), c('a', 'r'), c('b', 'r'), c('c', 'r'), c('r')])
    expect(rows.map(txt)).toEqual(['●─┬─╮', '● │ │', '│ ● │', '│ │ ●', '●─┴─╯'])
  })

  test('a root commit ends its lane; the next unrelated commit takes it', () => {
    expect(commitGraph([c('a'), c('b')]).map(txt)).toEqual(['●', '●'])
  })

  test('parents not in the list keep their lane waiting to the last row', () => {
    const rows = commitGraph([c('a', 'x'), c('b', 'y'), c('d', 'z')])
    expect(rows.map(txt)).toEqual(['●', '│ ●', '│ │ ●'])
  })

  test('a parent listed twice opens no lane', () => {
    expect(commitGraph([c('m', 'a', 'a'), c('a')]).map(txt)).toEqual(['●', '●'])
  })

  test('lanes past the cap are cut, the row marked, a node beyond them drawn on the last lane', () => {
    const rows = commitGraph([c('m', 'a', 'b', 'c', 'd'), c('d')], 2)
    expect(txt(rows[0] as GraphRow)).toBe('●─┬─')
    expect(rows[0]?.overflow).toBe(true)
    expect(rows[1]?.lane).toBe(3)
    expect(rows[1]?.node).toBe(2)
    expect(rows[1]?.overflow).toBe(true)
    expect(txt(rows[1] as GraphRow).startsWith('│ ●')).toBe(true)
    expect(rows[1]?.cells[2]?.lane).toBe(3)
  })

  test('graphWidth is the widest row, an overflow mark counted', () => {
    expect(graphWidth(commitGraph([c('m', 'p', 'f'), c('f', 'b'), c('p', 'b'), c('b')]))).toBe(3)
    expect(graphWidth(commitGraph([c('m', 'a', 'b', 'c', 'd')], 2))).toBe(5)
    expect(graphWidth([])).toBe(0)
  })
})

type Out = { exitCode: number; stdout?: string; stderr?: string }

// an io whose commands answer by argv joined with spaces; anything else exits 128
const runIo = (answers: Record<string, Out>): Pick<ChangesIo, 'run'> & { runs: string[][] } => {
  const runs: string[][] = []
  return {
    runs,
    run: async argv => {
      runs.push(argv)
      const a = answers[argv.join(' ')] ?? { exitCode: 128, stdout: '', stderr: 'fatal: no' }
      return { exitCode: a.exitCode, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }
    },
  }
}

const R = '/w/a'
const SHA = (d: string) => d.repeat(40)
const LOG_FMT = '--format=%H%x00%P%x00%an%x00%ct%x00%D%x00%s%x1e'
const SUM = `${GIT} -C ${R} log -1 --decorate=full --format=%ct%x00%h%x00%D HEAD`

describe('finding repos', () => {
  test('find looks 4 deep, skips heavy and worktree directories, and stops at each .git', () => {
    expect(findArgv('/w')).toEqual([
      FIND, '/w', '-maxdepth', '4',
      '(', '-name', 'node_modules', '-o', '-name', 'Library', '-o', '-name', '.Trash', '-o', '-name', '.cache', '-o', '-path', '*/.claude/worktrees', ')',
      '-prune', '-o', '-name', '.git', '-print', '-prune',
    ])
  })

  test('each .git found names its repo once, sorted; the session directory itself counts', () => {
    expect(parseFound('/w/b/.git\n/w/.git\n/w/a/x/.git\n/w/b/.git\nnoise\n')).toEqual(['/w', '/w/a/x', '/w/b'])
  })

  test('find exiting 1 on an unreadable directory still lists what it printed', async () => {
    const io = runIo({ [findArgv('/w').join(' ')]: { exitCode: 1, stdout: '/w/a/.git\n', stderr: 'find: /w/x: Permission denied' } })
    expect(await findRepos(io, '/w')).toEqual(['/w/a'])
  })

  test('nothing found, a failed find or no session directory is 找不到 repo', async () => {
    expect(await findRepos(runIo({ [findArgv('/w').join(' ')]: { exitCode: 0, stdout: '' } }), '/w')).toEqual([])
    expect(await findRepos(runIo({}), '/w')).toEqual({ error: '找不到 repo' })
    expect(await findRepos(runIo({}), '')).toEqual({ error: '找不到 repo' })
  })
})

describe('parsing git log', () => {
  test('refs split on commas', () => {
    expect(parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1')).toEqual([
      'HEAD -> refs/heads/main',
      'refs/remotes/origin/main',
      'tag: refs/tags/v1',
    ])
    expect(parseRefs('')).toEqual([])
  })

  test('records split on RS, fields on NUL; the leading newline git puts between records is dropped', () => {
    const out = `${SHA('1')}\x00${SHA('2')} ${SHA('3')}\x00白\x00100\x00HEAD -> refs/heads/main\x00Merge 中文\x1e\n${SHA('2')}\x00\x00w\x00090\x00\x00init\x1e\n`
    expect(parseLog(out)).toEqual([
      { sha: SHA('1'), parents: [SHA('2'), SHA('3')], author: '白', time: 100_000, refs: ['HEAD -> refs/heads/main'], subject: 'Merge 中文' },
      { sha: SHA('2'), parents: [], author: 'w', time: 90_000, refs: [], subject: 'init' },
    ])
  })
})

describe('repoSummary', () => {
  test('the branch HEAD points at, commits ahead of upstream and the last commit time', async () => {
    const io = runIo({
      [SUM]: { exitCode: 0, stdout: '100\x00abc1234\x00HEAD -> refs/heads/feat/x, refs/remotes/origin/feat/x\n' },
      [`${GIT} -C ${R} rev-list --count @{u}..HEAD`]: { exitCode: 0, stdout: '2\n' },
    })
    expect(await repoSummary(io, R)).toEqual({ branch: 'feat/x', ahead: 2, time: 100_000 })
  })

  test('a detached HEAD shows its short sha; no upstream leaves ahead out', async () => {
    const io = runIo({ [SUM]: { exitCode: 0, stdout: '100\x00abc1234\x00HEAD\n' } })
    expect(await repoSummary(io, R)).toEqual({ branch: 'abc1234', time: 100_000 })
  })

  test('a failed log is git log 失敗', async () => {
    expect(await repoSummary(runIo({}), R)).toEqual({ error: 'git log 失敗' })
  })
})

describe('commitTreeOf', () => {
  const log = `${SHA('1')}\x00${SHA('2')}\x00w\x00100\x00HEAD -> refs/heads/main\x00two\x1e\n${SHA('2')}\x00\x00w\x0090\x00refs/remotes/origin/main\x00one\x1e\n`

  test('logs HEAD with its upstream, marks the commits not pushed, names the branch', async () => {
    const io = runIo({
      [`${GIT} -C ${R} rev-parse --abbrev-ref --symbolic-full-name @{u}`]: { exitCode: 0, stdout: 'origin/main\n' },
      [`${GIT} -C ${R} log --topo-order --decorate=full -n 40 ${LOG_FMT} HEAD origin/main`]: { exitCode: 0, stdout: log },
      [`${GIT} -C ${R} rev-list origin/main..HEAD`]: { exitCode: 0, stdout: `${SHA('1')}\n` },
    })
    const t = await commitTreeOf(io, R)
    expect(isFailed(t)).toBe(false)
    if (isFailed(t)) return
    expect(t.branch).toBe('main')
    expect(t.upstream).toBe('origin/main')
    expect(t.ahead).toBe(1)
    expect(t.unpushed).toEqual([SHA('1')])
    expect(t.commits.map(c => c.subject)).toEqual(['two', 'one'])
  })

  test('without an upstream only HEAD is logged and nothing is marked', async () => {
    const io = runIo({ [`${GIT} -C ${R} log --topo-order --decorate=full -n 40 ${LOG_FMT} HEAD`]: { exitCode: 0, stdout: log } })
    const t = await commitTreeOf(io, R)
    if (isFailed(t)) throw new Error(t.error)
    expect(t.upstream).toBeUndefined()
    expect(t.unpushed).toEqual([])
    expect(t.ahead).toBe(0)
    expect(io.runs.some(a => a.includes('rev-list'))).toBe(false)
  })

  test('a detached HEAD is (detached); a failed log is git log 失敗', async () => {
    const detached = `${SHA('1')}\x00\x00w\x00100\x00HEAD\x00x\x1e\n`
    const io = runIo({ [`${GIT} -C ${R} log --topo-order --decorate=full -n 40 ${LOG_FMT} HEAD`]: { exitCode: 0, stdout: detached } })
    const t = await commitTreeOf(io, R)
    if (isFailed(t)) throw new Error(t.error)
    expect(t.branch).toBe('(detached)')
    expect(await commitTreeOf(runIo({}), R)).toEqual({ error: 'git log 失敗' })
  })
})

describe("a commit's files and diffs", () => {
  const C1 = { sha: SHA('1'), parents: [SHA('2'), SHA('3')] }
  const ROOT = { sha: SHA('4'), parents: [] }

  test('a commit is compared with its first parent', async () => {
    const io = runIo({
      [`${GIT} -C ${R} diff --numstat -z --no-renames ${SHA('2')} ${SHA('1')}`]: { exitCode: 0, stdout: '3\t1\tsvc/a b.go\x00-\t-\tlogo.png\x00' },
      [`${GIT} -C ${R} diff --no-color --no-renames ${SHA('2')} ${SHA('1')} -- svc/a b.go`]: { exitCode: 0, stdout: '@@ -1 +1 @@\n-a\n+b\n' },
    })
    expect(await commitFiles(io, R, C1)).toEqual([
      { path: 'svc/a b.go', add: 3, del: 1, binary: false },
      { path: 'logo.png', add: 0, del: 0, binary: true },
    ])
    const rows = await commitFileDiff(io, R, C1, 'svc/a b.go')
    expect(isFailed(rows) ? rows : rows.map(r => r.kind)).toEqual(['hunk', 'del', 'add'])
  })

  test('a root commit is shown whole with git show', async () => {
    const io = runIo({
      [`${GIT} -C ${R} show --numstat -z --no-renames --format= ${SHA('4')}`]: { exitCode: 0, stdout: '\n5\t0\tinit.txt\x00' },
      [`${GIT} -C ${R} show --no-color --no-renames --format= ${SHA('4')} -- init.txt`]: { exitCode: 0, stdout: '@@ -0,0 +1 @@\n+x\n' },
    })
    expect(await commitFiles(io, R, ROOT)).toEqual([{ path: 'init.txt', add: 5, del: 0, binary: false }])
    const rows = await commitFileDiff(io, R, ROOT, 'init.txt')
    expect(isFailed(rows) ? rows : rows.map(r => r.text)).toEqual(['@@ -0,0 +1 @@', 'x'])
  })

  test('failures say git diff 失敗', async () => {
    expect(await commitFiles(runIo({}), R, C1)).toEqual({ error: 'git diff 失敗' })
    expect(await commitFileDiff(runIo({}), R, C1, 'a')).toEqual({ error: 'git diff 失敗' })
  })
})
