import { describe, expect, test } from 'claude-code/testing'

import {
  MAX_BRANCHES,
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

  test(`at most ${MAX_BRANCHES} rows; the rest counted`, () => {
    const refs = Array.from({ length: MAX_BRANCHES + 7 }, (_, i) => ref({ ref: `refs/heads/b${i}`, time: i }))
    const list = branchRows(refs, undefined)
    expect(list.rows.length).toBe(MAX_BRANCHES)
    expect(list.more).toBe(7)
    expect(list.total).toBe(MAX_BRANCHES + 7)
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
})
