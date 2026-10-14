import { describe, expect, test } from 'claude-code/testing'

import {
  branchRows,
  countStatus,
  parseBranchRefs,
  parseRemotes,
  parseStashes,
  parseTrack,
  parseWorktrees,
  shortRef,
  worktreeRows,
} from '../hooks/repoViews'
import type { BranchRef } from '../hooks/repoViews'
import type { ChangesIo } from '../hooks/changes'
import { commitTreeOf } from '../hooks/gitCommits'
import { GIT, isFailed } from '../hooks/gitDiff'
import { BRANCH_FORMAT, ENV, STASH_FORMAT, branchesOf, fetchArgv, fetchRepo, remotesOf, stashFileDiff, stashFiles, stashesOf, worktreesOf } from '../hooks/gitRepo'

type Out = { exitCode: number; stdout?: string; stderr?: string }

// git answering by argv joined with spaces, anything else failing; a fake disk of files by mtime
const fakeIo = (answers: Record<string, Out | undefined>, files: Record<string, number> = {}): Pick<ChangesIo, 'run' | 'stat'> & { runs: string[][] } => {
  const runs: string[][] = []
  return {
    runs,
    run: async argv => {
      runs.push(argv)
      const key = argv.join(' ')
      if (key in answers && answers[key] === undefined) return undefined
      const a = answers[key] ?? { exitCode: 128, stdout: '', stderr: 'fatal: no' }
      return { exitCode: a.exitCode, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }
    },
    stat: async path => (files[path] === undefined ? undefined : { kind: 'file', size: 1, mtimeMs: files[path] ?? 0 }),
  }
}
const R = '/w/a'

const rec = (...f: string[]) => `${f.join('\x00')}\x1e\n`
const ref = (over: Partial<BranchRef> & Pick<BranchRef, 'ref'>): BranchRef => ({ upstream: '', track: '', time: 0, sha: 'abc1234', head: false, subject: 's', ...over })

describe('shortRef', () => {
  test('drops refs/heads/ and refs/remotes/, keeps anything else', () => {
    expect(shortRef('refs/heads/feat/x')).toBe('feat/x')
    expect(shortRef('refs/remotes/origin/main')).toBe('origin/main')
    expect(shortRef('refs/tags/v1')).toBe('refs/tags/v1')
  })
})

describe('parseRemotes', () => {
  test('one remote per name from its fetch line; a partial clone suffix is ignored', () => {
    const out = parseRemotes(
      'origin\tssh://git@git.example.com:2223/server/acme/game-server.git (fetch)\n' +
        'origin\tssh://git@git.example.com:2223/server/acme/game-server.git (push)\n' +
        'legacy\tssh://git@git.example.com:2223/Legacy/game_server/old_gameserver.git (fetch) [blob:none]\n' +
        'legacy\tssh://git@git.example.com:2223/Legacy/game_server/old_gameserver.git (push)\n',
    )
    expect(out).toEqual([
      { name: 'origin', url: 'ssh://git@git.example.com:2223/server/acme/game-server.git' },
      { name: 'legacy', url: 'ssh://git@git.example.com:2223/Legacy/game_server/old_gameserver.git' },
    ])
  })

  test('no remote is an empty list', () => {
    expect(parseRemotes('')).toEqual([])
  })
})

describe('parseTrack', () => {
  test('the five forms git prints', () => {
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0, gone: false })
    expect(parseTrack('ahead 3')).toEqual({ ahead: 3, behind: 0, gone: false })
    expect(parseTrack('behind 26')).toEqual({ ahead: 0, behind: 26, gone: false })
    expect(parseTrack('ahead 1, behind 2')).toEqual({ ahead: 1, behind: 2, gone: false })
    expect(parseTrack('gone')).toEqual({ ahead: 0, behind: 0, gone: true })
  })

  test('two-digit counts are read whole', () => {
    expect(parseTrack('ahead 12, behind 34')).toEqual({ ahead: 12, behind: 34, gone: false })
    expect(parseTrack('ahead 100')).toEqual({ ahead: 100, behind: 0, gone: false })
  })
})

describe('parseBranchRefs', () => {
  test('reads each record, the current branch by *, and skips a remote HEAD', () => {
    const out = parseBranchRefs(
      rec('refs/heads/main', 'origin/main', 'ahead 1', '100', 'aaaaaaa', '*', 'fix: 修正, 逗號') +
        rec('refs/remotes/origin/HEAD', '', '', '100', 'aaaaaaa', ' ', 'fix') +
        rec('refs/remotes/origin/main', '', '', '90', 'bbbbbbb', ' ', 'older'),
    )
    expect(out).toEqual([
      { ref: 'refs/heads/main', upstream: 'origin/main', track: 'ahead 1', time: 100_000, sha: 'aaaaaaa', head: true, subject: 'fix: 修正, 逗號' },
      { ref: 'refs/remotes/origin/main', upstream: '', track: '', time: 90_000, sha: 'bbbbbbb', head: false, subject: 'older' },
    ])
  })
})

describe('branchRows', () => {
  test('a remote branch a local one tracks is not listed again; the others are, as remote', () => {
    const list = branchRows(
      [
        ref({ ref: 'refs/heads/main', upstream: 'origin/main', head: true, time: 10 }),
        ref({ ref: 'refs/remotes/origin/main', time: 10 }),
        ref({ ref: 'refs/remotes/origin/only-remote', time: 30 }),
      ],
      undefined,
    )
    expect(list.rows.map(r => [r.name, r.kind])).toEqual([
      ['main', 'current'],
      ['origin/only-remote', 'remote'],
    ])
    expect(list.total).toBe(2)
    expect(list.mergeKnown).toBe(false)
  })

  test('current first, then newest first; ahead, behind, gone, no upstream and merged read from git', () => {
    const list = branchRows(
      [
        ref({ ref: 'refs/heads/old', upstream: 'origin/old', track: 'gone', time: 10 }),
        ref({ ref: 'refs/heads/new', upstream: 'origin/new', track: 'ahead 1, behind 2', time: 50 }),
        ref({ ref: 'refs/heads/main', upstream: 'origin/main', head: true, time: 20 }),
        ref({ ref: 'refs/heads/loose', time: 40 }),
      ],
      new Set(['refs/heads/old']),
    )
    expect(list.rows.map(r => r.name)).toEqual(['main', 'new', 'loose', 'old'])
    const by = (n: string) => list.rows.find(r => r.name === n)
    expect(by('new')).toMatchObject({ ahead: 1, behind: 2, gone: false, upstream: true, merged: false })
    expect(by('old')).toMatchObject({ gone: true, upstream: true, merged: true })
    expect(by('loose')).toMatchObject({ upstream: false, kind: 'local' })
    expect(list.mergeKnown).toBe(true)
  })

  test('a local upstream (another local branch) hides no remote branch and still counts as an upstream', () => {
    const list = branchRows(
      [ref({ ref: 'refs/heads/topic', upstream: 'main', time: 5 }), ref({ ref: 'refs/heads/main', time: 4 }), ref({ ref: 'refs/remotes/origin/main', time: 3 })],
      undefined,
    )
    expect(list.rows.map(r => r.name)).toEqual(['topic', 'main', 'origin/main'])
    expect(list.rows[0]).toMatchObject({ upstream: true })
  })

  test('at most 100 rows, the newest; the rest counted', () => {
    const refs = Array.from({ length: 107 }, (_, i) => ref({ ref: `refs/heads/b${i}`, time: i }))
    const list = branchRows(refs, undefined)
    expect(list.rows.length).toBe(100)
    expect(list.rows[0]?.name).toBe('b106')
    expect(list.rows[99]?.name).toBe('b7')
    expect(list.more).toBe(7)
    expect(list.total).toBe(107)
    const exact = branchRows(refs.slice(0, 100), undefined)
    expect(exact.rows.length).toBe(100)
    expect(exact.more).toBe(0)
  })

  test('branches last committed at the same time are ordered by name', () => {
    const list = branchRows([ref({ ref: 'refs/heads/b', time: 5 }), ref({ ref: 'refs/heads/c', time: 5 }), ref({ ref: 'refs/heads/a', time: 5 })], undefined)
    expect(list.rows.map(r => r.name)).toEqual(['a', 'b', 'c'])
  })
})

describe('parseStashes', () => {
  test('WIP and On forms, a detached one, the sha and its stash@{n}', () => {
    const S = (d: string) => d.repeat(40)
    const out = parseStashes(
      rec(S('a'), 'stash@{0}', '1786691519', 'On release/219-ss-盛世: dev8-dockerize') +
        rec(S('b'), 'stash@{1}', '1782895992', 'WIP on feat/215: abc1234 pre-existing: ignore entry') +
        rec(S('c'), 'stash@{2}', '1781751027', 'WIP on (no branch): def5678 detached work'),
    )
    expect(out).toEqual([
      { sha: S('a'), name: 'stash@{0}', time: 1786691519000, branch: 'release/219-ss-盛世', message: 'dev8-dockerize' },
      { sha: S('b'), name: 'stash@{1}', time: 1782895992000, branch: 'feat/215', message: 'abc1234 pre-existing: ignore entry' },
      { sha: S('c'), name: 'stash@{2}', time: 1781751027000, branch: '(no branch)', message: 'def5678 detached work' },
    ])
  })

  test('no stash is an empty list', () => {
    expect(parseStashes('')).toEqual([])
  })

  test('a message in neither form is kept whole, with no branch', () => {
    const S = 'd'.repeat(40)
    expect(parseStashes(rec(S, 'stash@{0}', '10', 'custom reflog message'))).toEqual([
      { sha: S, name: 'stash@{0}', time: 10_000, branch: '', message: 'custom reflog message' },
    ])
  })
})

describe('parseWorktrees', () => {
  test('main, a branch, a detached, a locked and a prunable one', () => {
    const out = parseWorktrees(
      'worktree /w/a\x00HEAD 1111111111111111111111111111111111111111\x00branch refs/heads/main\x00\x00' +
        'worktree /w/a/.claude/worktrees/agent-x1\x00HEAD 2222222222222222222222222222222222222222\x00branch refs/heads/wt\x00locked\x00\x00' +
        'worktree /w/b\x00HEAD 3333333333333333333333333333333333333333\x00detached\x00\x00' +
        'worktree /w/gone\x00HEAD 4444444444444444444444444444444444444444\x00branch refs/heads/old\x00prunable gitdir file points to non-existent location\x00\x00',
    )
    expect(out).toEqual([
      { path: '/w/a', head: '1'.repeat(40), branch: 'main', detached: false, locked: false, prunable: false, bare: false },
      { path: '/w/a/.claude/worktrees/agent-x1', head: '2'.repeat(40), branch: 'wt', detached: false, locked: true, prunable: false, bare: false },
      { path: '/w/b', head: '3'.repeat(40), detached: true, locked: false, prunable: false, bare: false },
      { path: '/w/gone', head: '4'.repeat(40), branch: 'old', detached: false, locked: false, prunable: true, bare: false },
    ])
  })
})

describe('parseWorktrees: bare', () => {
  test('a bare repository is flagged', () => {
    expect(parseWorktrees('worktree /w/b.git\x00bare\x00\x00')).toEqual([
      { path: '/w/b.git', head: '', detached: false, locked: false, prunable: false, bare: true },
    ])
  })
})

describe('countStatus', () => {
  test('one per entry; nothing is clean', () => {
    expect(countStatus(' M a.go\x00?? b.go\x00A  c.go\x00')).toBe(3)
    expect(countStatus('')).toBe(0)
  })
})

describe('worktreeRows', () => {
  test('main first by its own name, the rest by path relative to it; agent ones marked; dirty counts kept', () => {
    const rows = worktreeRows(
      [
        { path: '/w/a', head: 'h', branch: 'main', detached: false, locked: false, prunable: false, bare: false },
        { path: '/w/z-other', head: 'h', branch: 'z', detached: false, locked: false, prunable: false, bare: false },
        { path: '/w/a/.claude/worktrees/agent-x1', head: 'h', branch: 'wt', detached: false, locked: false, prunable: false, bare: false },
      ],
      new Map([
        ['/w/a', 2],
        ['/w/a/.claude/worktrees/agent-x1', 0],
      ]),
    )
    expect(rows.map(r => [r.name, r.main, r.agent, r.dirty])).toEqual([
      ['a', true, false, 2],
      ['.claude/worktrees/agent-x1', false, true, 0],
      ['/w/z-other', false, false, undefined],
    ])
  })

  test('only a directory named agent-* under .claude/worktrees is an agent one', () => {
    const w = (path: string) => ({ path, head: 'h', branch: 'b', detached: false, locked: false, prunable: false, bare: false })
    const rows = worktreeRows(
      [w('/w/a'), w('/w/a/.claude/worktrees/repo-views'), w('/w/a/.claude/worktrees/agent-ab12'), w('/w/a/worktrees/agent-x'), w('/w/agent-y')],
      new Map(),
    )
    expect(rows.map(r => [r.name, r.agent])).toEqual([
      ['a', false],
      ['.claude/worktrees/agent-ab12', true],
      ['.claude/worktrees/repo-views', false],
      ['worktrees/agent-x', false],
      ['/w/agent-y', false],
    ])
  })
})

describe('remotesOf', () => {
  test('the remotes and FETCH_HEAD under a relative common dir', async () => {
    const io = fakeIo(
      {
        [`${GIT} -C ${R} remote -v`]: { exitCode: 0, stdout: 'origin\tssh://h/a.git (fetch)\norigin\tssh://h/a.git (push)\n' },
        [`${GIT} -C ${R} rev-parse --git-common-dir`]: { exitCode: 0, stdout: '.git\n' },
      },
      { [`${R}/.git/FETCH_HEAD`]: 1234 },
    )
    expect(await remotesOf(io, R)).toEqual({ remotes: [{ name: 'origin', url: 'ssh://h/a.git' }], fetchedAt: 1234 })
  })

  test('a linked worktree answers an absolute common dir', async () => {
    const W = '/w/a/.claude/worktrees/agent-x1'
    const io = fakeIo(
      {
        [`${GIT} -C ${W} remote -v`]: { exitCode: 0, stdout: '' },
        [`${GIT} -C ${W} rev-parse --git-common-dir`]: { exitCode: 0, stdout: '/w/a/.git\n' },
      },
      { '/w/a/.git/FETCH_HEAD': 99 },
    )
    expect(await remotesOf(io, W)).toEqual({ remotes: [], fetchedAt: 99 })
  })

  test('never fetched: no fetchedAt; remote -v failing is an error', async () => {
    const ok = fakeIo({ [`${GIT} -C ${R} remote -v`]: { exitCode: 0, stdout: '' }, [`${GIT} -C ${R} rev-parse --git-common-dir`]: { exitCode: 0, stdout: '.git\n' } })
    expect(await remotesOf(ok, R)).toEqual({ remotes: [] })
    expect(await remotesOf(fakeIo({}), R)).toEqual({ error: 'git remote 失敗' })
  })
})

describe('branchesOf', () => {
  const LIST = `${GIT} -C ${R} for-each-ref --sort=-committerdate ${BRANCH_FORMAT} refs/heads refs/remotes`
  const recs =
    rec('refs/heads/main', 'origin/main', '', '100', 'aaaaaaa', '*', 'init') +
    rec('refs/heads/old', 'origin/old', 'gone', '50', 'bbbbbbb', ' ', 'old') +
    rec('refs/remotes/origin/main', '', '', '100', 'aaaaaaa', ' ', 'init')

  test('the merged ones are asked against origin/HEAD', async () => {
    const io = fakeIo({
      [LIST]: { exitCode: 0, stdout: recs },
      [`${GIT} -C ${R} symbolic-ref -q --short refs/remotes/origin/HEAD`]: { exitCode: 0, stdout: 'origin/main\n' },
      [`${GIT} -C ${R} for-each-ref --merged=origin/main --format=%(refname) refs/heads refs/remotes`]: { exitCode: 0, stdout: 'refs/heads/main\nrefs/heads/old\nrefs/remotes/origin/main\n' },
    })
    const b = await branchesOf(io, R)
    if (isFailed(b)) throw new Error(b.error)
    expect(b.rows.map(r => [r.name, r.merged, r.gone])).toEqual([
      ['main', true, false],
      ['old', true, true],
    ])
    expect(b.mergeKnown).toBe(true)
  })

  test('no origin: nothing marked merged; for-each-ref failing is an error', async () => {
    const b = await branchesOf(fakeIo({ [LIST]: { exitCode: 0, stdout: recs } }), R)
    if (isFailed(b)) throw new Error(b.error)
    expect(b.mergeKnown).toBe(false)
    expect(b.rows.every(r => !r.merged)).toBe(true)
    expect(await branchesOf(fakeIo({}), R)).toEqual({ error: 'git for-each-ref 失敗' })
  })

  test('the --merged query failing marks nothing merged and does not fail the page', async () => {
    const io = fakeIo({
      [LIST]: { exitCode: 0, stdout: recs },
      [`${GIT} -C ${R} symbolic-ref -q --short refs/remotes/origin/HEAD`]: { exitCode: 0, stdout: 'origin/main\n' },
    })
    const b = await branchesOf(io, R)
    if (isFailed(b)) throw new Error(b.error)
    expect(b.mergeKnown).toBe(false)
    expect(b.rows.map(r => [r.name, r.merged])).toEqual([
      ['main', false],
      ['old', false],
    ])
  })
})

describe('stashes', () => {
  const S = '5'.repeat(40)
  test('the list', async () => {
    const io = fakeIo({ [`${GIT} -C ${R} stash list ${STASH_FORMAT}`]: { exitCode: 0, stdout: rec(S, 'stash@{0}', '10', 'On main: 半成品') } })
    expect(await stashesOf(io, R)).toEqual([{ sha: S, name: 'stash@{0}', time: 10_000, branch: 'main', message: '半成品' }])
  })

  test('the list failing is an error', async () => {
    expect(await stashesOf(fakeIo({}), R)).toEqual({ error: 'git stash 失敗' })
  })

  test('its files, the untracked ones by its third parent; their diffs from the right commits', async () => {
    const io = fakeIo({
      [`${GIT} -C ${R} stash show --include-untracked --numstat -z --no-renames ${S}`]: { exitCode: 0, stdout: '1\t1\ta.go\x002\t0\tnew.txt\x00' },
      [`${GIT} -C ${R} ls-tree -r --name-only -z ${S}^3`]: { exitCode: 0, stdout: 'new.txt\x00' },
      [`${GIT} -C ${R} diff --no-color --no-renames ${S}^1 ${S} -- a.go`]: { exitCode: 0, stdout: '@@ -1 +1 @@\n-old\n+new\n' },
      [`${GIT} -C ${R} show --no-color --no-renames --format= ${S}^3 -- new.txt`]: { exitCode: 0, stdout: '@@ -0,0 +1,2 @@\n+x\n+y\n' },
    })
    const files = await stashFiles(io, R, S)
    if (isFailed(files)) throw new Error(files.error)
    expect(files).toEqual([
      { path: 'a.go', add: 1, del: 1, binary: false, untracked: false },
      { path: 'new.txt', add: 2, del: 0, binary: false, untracked: true },
    ])
    const [tracked, untracked] = files
    if (!tracked || !untracked) throw new Error('two files')
    expect(await stashFileDiff(io, R, S, tracked)).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'del', old: 1, text: 'old' },
      { kind: 'add', new: 1, text: 'new' },
    ])
    const rows = await stashFileDiff(io, R, S, untracked)
    if (isFailed(rows)) throw new Error(rows.error)
    expect(rows.filter(r => r.kind === 'add').length).toBe(2)
  })

  test('a stash without untracked files: ls-tree failing marks none untracked', async () => {
    const io = fakeIo({ [`${GIT} -C ${R} stash show --include-untracked --numstat -z --no-renames ${S}`]: { exitCode: 0, stdout: '1\t0\ta.go\x00' } })
    expect(await stashFiles(io, R, S)).toEqual([{ path: 'a.go', add: 1, del: 0, binary: false, untracked: false }])
  })
})

describe('stash failures', () => {
  const S = '6'.repeat(40)

  test('stash show failing is an error; a leading blank line before the numstat is skipped', async () => {
    expect(await stashFiles(fakeIo({}), R, S)).toEqual({ error: 'git stash 失敗' })
    const io = fakeIo({ [`${GIT} -C ${R} stash show --include-untracked --numstat -z --no-renames ${S}`]: { exitCode: 0, stdout: '\n3\t1\ta.go\x00' } })
    expect(await stashFiles(io, R, S)).toEqual([{ path: 'a.go', add: 3, del: 1, binary: false, untracked: false }])
  })

  test('a file diff failing is an error, tracked or untracked', async () => {
    const f = { path: 'a.go', add: 1, del: 0, binary: false }
    expect(await stashFileDiff(fakeIo({}), R, S, { ...f, untracked: false })).toEqual({ error: 'git diff 失敗' })
    expect(await stashFileDiff(fakeIo({}), R, S, { ...f, untracked: true })).toEqual({ error: 'git diff 失敗' })
  })
})

describe('worktreesOf', () => {
  test('each worktree with its uncommitted files; a pruned one is not asked', async () => {
    const W = `${R}/.claude/worktrees/agent-x1`
    const io = fakeIo({
      [`${GIT} -C ${R} worktree list --porcelain -z`]: {
        exitCode: 0,
        stdout:
          `worktree ${R}\x00HEAD ${'1'.repeat(40)}\x00branch refs/heads/main\x00\x00` +
          `worktree ${W}\x00HEAD ${'2'.repeat(40)}\x00branch refs/heads/wt\x00\x00` +
          `worktree /w/gone\x00HEAD ${'3'.repeat(40)}\x00detached\x00prunable gitdir file points to non-existent location\x00\x00`,
      },
      [`${GIT} -C ${R} status --porcelain=v1 -z --no-renames --untracked-files=normal`]: { exitCode: 0, stdout: ' M a.go\x00?? b.go\x00' },
      [`${GIT} -C ${W} status --porcelain=v1 -z --no-renames --untracked-files=normal`]: { exitCode: 0, stdout: '' },
    })
    const rows = await worktreesOf(io, R)
    if (isFailed(rows)) throw new Error(rows.error)
    expect(rows.map(r => [r.name, r.dirty, r.prunable, r.agent])).toEqual([
      ['a', 2, false, false],
      ['.claude/worktrees/agent-x1', 0, false, true],
      ['/w/gone', undefined, true, false],
    ])
    expect(io.runs.some(a => a.includes('/w/gone'))).toBe(false)
  })

  test('a bare repository is listed but not asked for its status', async () => {
    const io = fakeIo({
      [`${GIT} -C ${R} worktree list --porcelain -z`]: {
        exitCode: 0,
        stdout: `worktree ${R}\x00bare\x00\x00worktree /w/linked\x00HEAD ${'2'.repeat(40)}\x00branch refs/heads/wt\x00\x00`,
      },
      [`${GIT} -C /w/linked status --porcelain=v1 -z --no-renames --untracked-files=normal`]: { exitCode: 0, stdout: ' M a.go\x00' },
    })
    const rows = await worktreesOf(io, R)
    if (isFailed(rows)) throw new Error(rows.error)
    expect(rows.map(r => [r.path, r.bare, r.dirty])).toEqual([
      [R, true, undefined],
      ['/w/linked', false, 1],
    ])
    expect(io.runs.filter(a => a.includes('status')).map(a => a[2])).toEqual(['/w/linked'])
  })

  test('worktree list failing is an error', async () => {
    expect(await worktreesOf(fakeIo({}), R)).toEqual({ error: 'git worktree 失敗' })
  })
})

describe('fetch', () => {
  test('prompts off, ssh in batch mode, every remote, pruned', () => {
    expect(fetchArgv(R)).toEqual([ENV, 'GIT_TERMINAL_PROMPT=0', GIT, '-C', R, '-c', 'core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=10', 'fetch', '--all', '--prune'])
  })

  test('done, failed with the last stderr line, or past its time', async () => {
    const key = fetchArgv(R).join(' ')
    expect(await fetchRepo(fakeIo({ [key]: { exitCode: 0, stderr: 'From ssh://h/a\n' } }), R)).toBe(true)
    expect(await fetchRepo(fakeIo({ [key]: { exitCode: 128, stderr: 'Fetching origin\nfatal: Could not read from remote repository.\n\n' } }), R)).toEqual({
      error: 'fatal: Could not read from remote repository.',
    })
    expect(await fetchRepo(fakeIo({ [key]: { exitCode: 1, stderr: '' } }), R)).toEqual({ error: 'fetch 失敗' })
    expect(await fetchRepo(fakeIo({ [key]: undefined }), R)).toEqual({ error: 'fetch 逾時' })
  })
})

describe('commitTreeOf with a ref', () => {
  const FMT = '--format=%H%x00%P%x00%an%x00%ct%x00%D%x00%s%x1e'
  const log = `${'2'.repeat(40)}\x00\x00w\x0090\x00refs/heads/feat\x00wip\x1e\n`

  test('a local branch is logged with its upstream, named by its short name', async () => {
    const io = fakeIo({
      [`${GIT} -C ${R} rev-parse --abbrev-ref --symbolic-full-name feat@{u}`]: { exitCode: 0, stdout: 'origin/feat\n' },
      [`${GIT} -C ${R} log --topo-order --decorate=full -n 40 ${FMT} refs/heads/feat origin/feat`]: { exitCode: 0, stdout: log },
      [`${GIT} -C ${R} rev-list origin/feat..refs/heads/feat`]: { exitCode: 0, stdout: `${'2'.repeat(40)}\n` },
    })
    const t = await commitTreeOf(io, R, 'refs/heads/feat')
    if (isFailed(t)) throw new Error(t.error)
    expect(t.branch).toBe('feat')
    expect(t.upstream).toBe('origin/feat')
    expect(t.ahead).toBe(1)
    expect(io.runs.some(a => a.includes('symbolic-ref'))).toBe(false)
  })

  test('a branch name with a slash keeps it in the upstream query', async () => {
    const io = fakeIo({
      [`${GIT} -C ${R} rev-parse --abbrev-ref --symbolic-full-name feat/x@{u}`]: { exitCode: 0, stdout: 'origin/feat/x\n' },
      [`${GIT} -C ${R} log --topo-order --decorate=full -n 40 ${FMT} refs/heads/feat/x origin/feat/x`]: { exitCode: 0, stdout: log },
      [`${GIT} -C ${R} rev-list origin/feat/x..refs/heads/feat/x`]: { exitCode: 0, stdout: '' },
    })
    const t = await commitTreeOf(io, R, 'refs/heads/feat/x')
    if (isFailed(t)) throw new Error(t.error)
    expect(t.upstream).toBe('origin/feat/x')
    expect(t.branch).toBe('feat/x')
  })

  test('a remote branch has no upstream and nothing unpushed', async () => {
    const io = fakeIo({
      [`${GIT} -C ${R} log --topo-order --decorate=full -n 40 ${FMT} refs/remotes/origin/x`]: { exitCode: 0, stdout: log },
    })
    const t = await commitTreeOf(io, R, 'refs/remotes/origin/x')
    if (isFailed(t)) throw new Error(t.error)
    expect(t.branch).toBe('origin/x')
    expect(t.upstream).toBeUndefined()
    expect(t.unpushed).toEqual([])
    expect(io.runs.some(a => a.includes('rev-parse'))).toBe(false)
  })
})
