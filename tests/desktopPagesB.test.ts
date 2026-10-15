import { describe, expect, test } from 'claude-code/testing'

import type { Ctx } from '../hooks/cockpit'
import type { CommitsCtx, RepoPage } from '../hooks/commitsView'
import type { ChangesView } from '../hooks/changesView'
import { DT } from '../hooks/desktopTheme'
import { fitColumns } from '../hooks/desktopPagesB'
import { drawDesktop } from '../hooks/desktopView'
import type { DesktopUi } from '../hooks/desktopView'
import type { Cockpit } from '../hooks/jarvis'
import type { DiffRow } from '../hooks/gitDiff'
import type { FleetSession, FleetView, JarvisPage } from '../types'
import { badProps } from './allowedProps'
import { all, drawOn, engine, pressOn, svgs, textOf, wellFormed } from './helpers'
import type { Node } from './helpers'

const T0 = new Date(2026, 9, 15, 15, 0, 0).getTime()
const MIN = 60_000
const WIDTHS = [50, 80, 100, 140] as const

// the elements as the engine hands them: a node of its type, props and children apart
const flat = (c: unknown): (Node | string)[] =>
  c === null || c === undefined || c === false || c === true ? [] : Array.isArray(c) ? c.flatMap(flat) : typeof c === 'number' ? [String(c)] : [c as Node | string]
const element =
  (type: string) =>
  (props: Record<string, unknown>): Node => {
    const { children, ...rest } = props ?? {}
    return { type, props: rest, children: flat(children) }
  }
const UI = { Box: element('Box'), Text: element('Text'), Button: element('Button'), Svg: element('Svg') } as unknown as DesktopUi

const VIEW = { now: T0, roster: new Map([['agent-1', { n: 1, color: '#FFAA00' }]]), running: [], health: 'ok' } as unknown as Cockpit

const EMPTY_FLEET: FleetView = { at: 0, sessions: [], linkLost: false, scanning: false, hourly: Array.from({ length: 24 }, () => 0) }

const suit = (over: Partial<FleetSession> = {}): FleetSession => ({
  paneId: 'w1:p1',
  tabId: 'w1:t1',
  sessionId: 'sess-a',
  title: 'Alpha review',
  status: 'idle',
  cwd: '/srv/alpha',
  workspace: 'Acme',
  stamps: [],
  tools: 0,
  todayTokens: 0,
  todayCost: 0,
  ...over,
})

type Calls = string[]

const baseCtx = (calls: Calls, over: Partial<Ctx> = {}): Ctx => ({
  cols: 80,
  rows: 45,
  frame: '⠋',
  scan: '',
  beat: 0,
  page: 'fleet',
  agentId: '',
  paused: false,
  fresh: 0,
  go: (page: JarvisPage) => calls.push(`go:${page}`),
  open: (id: string) => calls.push(`open:${id}`),
  pause: () => calls.push('pause'),
  fleet: EMPTY_FLEET,
  herdr: false,
  paneId: '',
  sessionId: 'sess-self',
  openFleet: (paneId: string) => calls.push(`openFleet:${paneId}`),
  jump: (paneId: string) => calls.push(`jump:${paneId}`),
  setChangesMode: m => calls.push(`mode:${m}`),
  refreshChanges: () => calls.push('refreshChanges'),
  openDiff: key => calls.push(`openDiff:${key}`),
  ...over,
})

const draw = (ctx: Ctx): Node => drawDesktop(UI, VIEW, ctx) as unknown as Node

const kids = (n: Node): Node[] => (n.children ?? []).filter((c): c is Node => typeof c !== 'string')
const buttons = (tree: Node) => all(tree, x => x.type === 'Button')
const keyOf = (n: Node) => String(n.props?.['key'] ?? '')
const button = (tree: Node, key: string) => buttons(tree).find(b => keyOf(b) === key)
const press = (tree: Node, key: string) => {
  const b = button(tree, key)
  expect(b).toBeDefined()
  ;(b?.props?.['onPress'] as () => void)()
}
const cardInner = (cols: number) => Math.max(16, cols - 4 - 6)

// every row of fixed-width columns: its columns and the gaps between them add up within the card
const fixedRowsFit = (tree: Node, cols: number): number => {
  const rows = all(tree, x => x.type === 'Box' && x.props?.['flexDirection'] === 'row' && kids(x).length > 0 && kids(x).every(k => k.type === 'Box' && Number.isFinite(Number(k.props?.['width']))))
  for (const r of rows) {
    const ks = kids(r)
    const sum = ks.reduce((n, k) => n + Number(k.props?.['width']), 0) + Number(r.props?.['gap'] ?? 0) * (ks.length - 1)
    expect(sum).toBeLessThanOrEqual(cardInner(cols))
  }
  return rows.length
}

const texts = (tree: Node, color: string) => all(tree, x => x.type === 'Text' && x.props?.['color'] === color).map(textOf)

describe('desktop native B: helpers', () => {
  test('fitColumns drops the asked columns in order until the flexible one keeps its least', () => {
    const wide = fitColumns({ a: 10, b: 10 }, ['a', 'b'], 60)
    expect(wide.on('a') && wide.on('b')).toBe(true)
    expect(wide.rest).toBe(60 - 20 - 2)
    const narrow = fitColumns({ a: 10, b: 10 }, ['a', 'b'], 25)
    expect(narrow.on('a')).toBe(false)
    expect(narrow.on('b')).toBe(true)
    expect(narrow.rest).toBe(25 - 10 - 1)
  })
})

describe('desktop native B: fleet page', () => {
  test('without herdr: a glass card says herdr is needed and how to get it', () => {
    const tree = draw(baseCtx([]))
    expect(tree.props?.['backgroundColor']).toBe(DT.bg)
    expect(textOf(tree)).toContain('需要 herdr')
    expect(textOf(tree)).toContain('HERDR_ENV=1')
    expect(svgs(tree).some(s => s.props?.['alt'] === 'herdr 未連線')).toBe(true)
    expect(badProps(tree)).toEqual([])
    wellFormed(tree, 80)
  })

  test('herdr with no session yet: scanning, then an empty fleet', () => {
    expect(textOf(draw(baseCtx([], { herdr: true })))).toContain('掃描艦隊中…')
    expect(textOf(draw(baseCtx([], { herdr: true, fleet: { ...EMPTY_FLEET, at: T0 } })))).toContain('艦隊目前沒有 Claude session')
  })

  const fleet: FleetView = {
    at: T0,
    sessions: [
      suit({ paneId: 'w1:p1', title: 'Idle one', status: 'idle', lastAt: T0 - 30 * MIN, hourly: Array.from({ length: 24 }, (_, i) => i * 10) }),
      suit({ paneId: 'w1:p2', sessionId: 'sess-self', title: 'Busy one that has a rather long title to cut', status: 'working', model: 'claude-opus-5-5', tool: 'Bash', runSince: T0 - 5 * MIN, contextPct: 75, stamps: [T0 - MIN, T0 - 2 * MIN], todayTokens: 120_000, todayCost: 1.5 }),
      suit({ paneId: 'w1:p3', title: 'Blocked one', status: 'blocked', contextPct: 95 }),
    ],
    quota: { fiveHour: { usedPct: 40, resetsAt: T0 + 60 * MIN, windowMin: 300 }, sevenDay: { usedPct: 10, resetsAt: T0 + 3 * 24 * 60 * MIN, windowMin: 10080 }, fetchedAt: T0 },
    linkLost: false,
    scanning: false,
    hourly: Array.from({ length: 24 }, (_, i) => (i < 15 ? i * 100 : 0)),
  }

  test('each session a glass card, busy first; its title opens it, THIS marks this session', () => {
    const calls: Calls = []
    const tree = draw(baseCtx(calls, { herdr: true, fleet }))
    expect(textOf(tree)).toContain('IRON LEGION')
    expect(textOf(tree)).toContain('3 SUITS')
    expect(textOf(tree)).toContain('THIS')
    // blocked, then working, then idle
    expect(textOf(button(tree, 'suit-1') as Node)).toContain('Blocked one')
    expect(textOf(button(tree, 'suit-2') as Node)).toContain('Busy one')
    expect(textOf(button(tree, 'suit-3') as Node)).toContain('Idle one')
    expect(texts(tree, DT.fail)).toContain('AWAITING ORDERS')
    press(tree, 'suit-2')
    expect(calls).toEqual(['openFleet:w1:p2'])
    // the rings and the burn are glass pictures
    const alts = svgs(tree).map(s => String(s.props?.['alt']))
    expect(alts).toEqual(expect.arrayContaining(['5H 40%', '7D 10%']))
    expect(alts.some(a => a.startsWith('TODAY BURN'))).toBe(true)
    expect(badProps(tree)).toEqual([])
  })

  test('a lost herdr link reads FLEET LINK LOST in red', () => {
    const tree = draw(baseCtx([], { herdr: true, fleet: { ...fleet, linkLost: true } }))
    expect(texts(tree, DT.fail)).toContain('FLEET LINK LOST')
  })

  test('fixed columns stay within their card, pictures sized in cells, at every width', () => {
    for (const cols of WIDTHS) {
      const tree = draw(baseCtx([], { herdr: true, fleet, cols }))
      expect(fixedRowsFit(tree, cols)).toBeGreaterThan(0)
      wellFormed(tree, cols)
      expect(badProps(tree)).toEqual([])
    }
  })

  test('the fleet tab stays lit on a session page', () => {
    const tree = draw(baseCtx([], { herdr: true, fleet, page: 'fleetDetail', paneId: 'w1:p2' }))
    const lit = all(tree, x => x.type === 'Box' && x.props?.['backgroundColor'] === DT.orangeFill)
    expect(lit.map(textOf).join()).toContain('艦隊')
  })
})

describe('desktop native B: fleet detail page', () => {
  const fleet: FleetView = {
    ...EMPTY_FLEET,
    at: T0,
    sessions: [suit({ paneId: 'w1:p2', title: 'Busy one', status: 'working', model: 'claude-opus-5-5', lastUser: 'please fix it', lastReply: 'done '.repeat(80), tools: 7 })],
    jumpError: { paneId: 'w1:p2', text: '\nno such pane\nmore' },
  }

  test('back and jump pills; its fields, the last ask and reply, and why a jump failed', () => {
    const calls: Calls = []
    const tree = draw(baseCtx(calls, { herdr: true, fleet, page: 'fleetDetail', paneId: 'w1:p2' }))
    const t = textOf(tree)
    for (const word of ['Busy one', 'IN FLIGHT', '工作區', 'Acme', '/srv/alpha', '7 次', 'please fix it', 'done']) expect(t).toContain(word)
    expect(texts(tree, DT.fail)).toContain('no such pane')
    press(tree, 'back')
    press(tree, 'jump')
    expect(calls).toEqual(['go:fleet', 'jump:w1:p2'])
    expect(badProps(tree)).toEqual([])
    for (const cols of WIDTHS) expect(fixedRowsFit(draw(baseCtx([], { herdr: true, fleet, page: 'fleetDetail', paneId: 'w1:p2', cols })), cols)).toBeGreaterThan(0)
  })

  test('a session that left the fleet draws the fleet page', () => {
    const tree = draw(baseCtx([], { herdr: true, fleet, page: 'fleetDetail', paneId: 'gone' }))
    expect(button(tree, 'suit-1')).toBeDefined()
    expect(button(tree, 'jump')).toBeUndefined()
  })
})

const CHANGES: ChangesView = {
  mode: 'session',
  pending: false,
  total: 3,
  groups: [
    {
      key: '/w/r',
      name: 'r',
      ahead: 2,
      add: 12,
      del: 3,
      pending: false,
      entries: [
        { key: 's:/w/r/a.go', path: '/w/r/a.go', label: 'a.go', actors: ['main'], add: 10, del: 2, binary: false, pending: false },
        { key: 's:/w/r/deep/nested/very/long/path/to/some/file/that/goes/on.go', path: '/w/r/x', label: 'deep/nested/very/long/path/to/some/file/that/goes/on.go', actors: ['agent-1', 'main'], add: 2, del: 1, binary: false, pending: false },
        { key: 's:/w/r/img.png', path: '/w/r/img.png', label: 'img.png', actors: [], add: 0, del: 0, binary: true, note: '二進位', pending: false },
      ],
    },
    { key: '/w/old', name: 'worktree old', removed: 4, entries: [], add: 0, del: 0, pending: false },
  ],
}

describe('desktop native B: changes page', () => {
  test('mode pills, then a card per repo: who, the path (the press) and the counts', () => {
    const calls: Calls = []
    const tree = draw(baseCtx(calls, { page: 'changes', changes: CHANGES }))
    const t = textOf(tree)
    for (const word of ['異動', '3 檔', '主線', 'MK-1 +1', '其他', '二進位', '↑2', 'worktree old', '已移除（4 檔）']) expect(t).toContain(word)
    expect(texts(tree, DT.ok)).toContain('+10')
    expect(texts(tree, DT.fail)).toContain('−2')
    press(tree, 'chg-s:/w/r/a.go')
    press(tree, 'chg-mode-unpushed')
    expect(calls).toEqual(['openDiff:s:/w/r/a.go', 'mode:unpushed'])
    // the session's own changes need no refresh
    expect(button(tree, 'chg-refresh')).toBeUndefined()
    expect(badProps(tree)).toEqual([])
  })

  test('the long path is cut from its start; rows stay within their card at every width', () => {
    for (const cols of WIDTHS) {
      const tree = draw(baseCtx([], { page: 'changes', changes: CHANGES, cols }))
      expect(fixedRowsFit(tree, cols)).toBeGreaterThan(0)
      const path = all(tree, x => x.type === 'Text' && textOf(x).startsWith('deep/nested'))[0]
      expect(path?.props?.['wrap']).toBe('truncate-start')
    }
  })

  test('empty: no file changed this session, no repo touched', () => {
    const empty: ChangesView = { mode: 'session', groups: [], pending: false, total: 0 }
    expect(textOf(draw(baseCtx([], { page: 'changes', changes: empty })))).toContain('這個 session 還沒改過檔案')
    const calls: Calls = []
    const tree = draw(baseCtx(calls, { page: 'changes', changes: { ...empty, mode: 'unpushed' } }))
    expect(textOf(tree)).toContain('這個 session 還沒碰過任何 git repo')
    press(tree, 'chg-refresh')
    expect(calls).toEqual(['refreshChanges'])
    expect(textOf(draw(baseCtx([], { page: 'changes' })))).toContain('這個 session 還沒改過檔案')
  })

  test('past the listed files, a count of the rest', () => {
    const tree = draw(baseCtx([], { page: 'changes', changes: { ...CHANGES, total: 250 } }))
    expect(textOf(tree)).toContain('… 還有 50 檔')
  })
})

const repoPage = (over: Partial<RepoPage> = {}): RepoPage => ({
  path: '/w/r',
  name: 'r',
  tree: {
    branch: 'main',
    ahead: 1,
    unpushed: ['c2'],
    commits: [
      { sha: 'c2aaaaaaaaaa', parents: ['c1aaaaaaaaaa', 'b1aaaaaaaaaa'], author: 'a', time: T0 - MIN, refs: ['HEAD -> refs/heads/main', 'tag: refs/tags/v1'], subject: 'merge the feature branch with a long subject line that keeps going' },
      { sha: 'b1aaaaaaaaaa', parents: ['c1aaaaaaaaaa'], author: 'a', time: T0 - 2 * MIN, refs: ['refs/heads/feat'], subject: 'feature work' },
      { sha: 'c1aaaaaaaaaa', parents: [], author: 'a', time: T0 - 3 * MIN, refs: ['refs/remotes/origin/main'], subject: 'root' },
    ],
  },
  view: 'log',
  ref: undefined,
  remotes: { remotes: [{ name: 'origin', url: 'git@example.com:some/very/long/path/to/the/repo.git' }], fetchedAt: T0 - 10 * MIN },
  fetching: false,
  fetchError: 'fetch failed: denied',
  branches: {
    current: { ref: 'refs/heads/main', name: 'main', kind: 'current', upstream: true, ahead: 1, behind: 0, gone: false, merged: false, time: T0 - MIN, subject: 'merge' },
    active: { rows: [{ ref: 'refs/heads/feat', name: 'feat-with-a-quite-long-branch-name', kind: 'local', upstream: false, ahead: 0, behind: 2, gone: false, merged: true, time: T0 - 5 * MIN, subject: 'feature work' }], more: 0 },
    remote: { rows: [{ ref: 'refs/remotes/origin/x', name: 'origin/x', kind: 'remote', upstream: false, ahead: 0, behind: 0, gone: false, merged: false, time: T0 - 9 * MIN, subject: 'x' }], more: 0 },
    gone: { rows: [], more: 0 },
    total: 3,
    mergeKnown: true,
  },
  stashes: [{ sha: 's1', name: 'stash@{0}', time: T0 - MIN, branch: 'main', message: 'WIP on main: half done' }],
  worktrees: [
    { path: '/w/r', head: 'c2aaaaaaaaaa', branch: 'main', detached: false, locked: false, prunable: false, bare: false, name: '/w/r', main: true, agent: false, dirty: 0 },
    { path: '/w/r/.claude/worktrees/agent-x', head: 'b1aaaaaaaaaa', detached: true, locked: true, prunable: false, bare: false, name: '.claude/worktrees/agent-x', main: false, agent: true, dirty: 3 },
    { path: '/w/gone', head: 'b1aaaaaaaaaa', detached: true, locked: false, prunable: true, bare: false, name: 'gone', main: false, agent: false },
  ],
  counts: { branches: 3, stash: 1, worktrees: 3 },
  goneOpen: false,
  remoteOpen: false,
  ...over,
})

const commits = (calls: Calls, over: Partial<CommitsCtx> = {}): CommitsCtx => ({
  cwdName: 'w',
  now: T0,
  startedAt: T0 - 90 * MIN,
  list: {
    rows: [
      { repo: '/w/r', name: 'r', touched: true, pending: false, branch: 'main', ahead: 2, time: T0 - MIN },
      { repo: '/w/s', name: 's', touched: false, pending: true },
    ],
    more: 3,
    total: 5,
    scanning: false,
  },
  openRepo: r => calls.push(`openRepo:${r}`),
  openCommit: s => calls.push(`openCommit:${s}`),
  openFile: p => calls.push(`openFile:${p}`),
  refreshList: () => calls.push('refreshList'),
  refreshTree: () => calls.push('refreshTree'),
  setView: v => calls.push(`setView:${v}`),
  openBranch: r => calls.push(`openBranch:${r}`),
  toggleGone: () => calls.push('toggleGone'),
  toggleRemote: () => calls.push('toggleRemote'),
  openStash: s => calls.push(`openStash:${s}`),
  openStashFile: p => calls.push(`openStashFile:${p}`),
  openWorktree: p => calls.push(`openWorktree:${p}`),
  back: () => calls.push('back'),
  fetch: () => calls.push('fetch'),
  ...over,
})

describe('desktop native B: commits mode', () => {
  test('the repo list: ★ touched, its name the press, branch, ↑ and age; the rest counted', () => {
    const calls: Calls = []
    const tree = draw(baseCtx(calls, { page: 'changes', changes: { mode: 'commits', groups: [], pending: false, total: 0 }, commits: commits(calls) }))
    const t = textOf(tree)
    for (const word of ['★', '5 repos', '↑2', '1 分鐘前', '讀取中…', '… 還有 3 個 repo']) expect(t).toContain(word)
    press(tree, 'cm-repo-/w/r')
    press(tree, 'chg-refresh')
    expect(calls).toEqual(['openRepo:/w/r', 'refreshList'])
    for (const cols of WIDTHS) expect(fixedRowsFit(draw(baseCtx([], { page: 'changes', changes: { mode: 'commits', groups: [], pending: false, total: 0 }, commits: commits([]), cols })), cols)).toBeGreaterThan(0)
  })

  test('scanning, before the list', () => {
    const tree = draw(baseCtx([], { page: 'changes', changes: { mode: 'commits', groups: [], pending: false, total: 0 } }))
    expect(textOf(tree)).toContain('掃描 repo 中…')
  })
})

describe('desktop native B: commit tree page', () => {
  test('back and refresh; the repo, its remote and fetch; the sub-tab pills; commits whose subject opens them', () => {
    const calls: Calls = []
    const tree = draw(baseCtx(calls, { page: 'commitTree', commits: commits(calls, { repo: repoPage() }) }))
    const t = textOf(tree)
    for (const word of ['main', '↑1', '3 commits', 'origin', 'fetch 10 分鐘前', '分支 3', 'Stash 1', 'Worktree 3', 'c2aaaaa', 'feature work']) expect(t).toContain(word)
    expect(texts(tree, DT.fail)).toContain('fetch failed: denied')
    for (const key of ['back', 'cm-refresh', 'cm-fetch', 'cm-view-branches', 'cm-commit-c2aaaaaaaaaa']) press(tree, key)
    expect(calls).toEqual(['back', 'refreshTree', 'fetch', 'setView:branches', 'openCommit:c2aaaaaaaaaa'])
    // the changes tab stays lit
    const lit = all(tree, x => x.type === 'Box' && x.props?.['backgroundColor'] === DT.orangeFill)
    expect(lit.map(textOf).join()).toContain('異動')
    expect(badProps(tree)).toEqual([])
  })

  test('branches, stash and worktrees: each row its press', () => {
    const calls: Calls = []
    const at = (view: RepoPage['view']) => draw(baseCtx(calls, { page: 'commitTree', commits: commits(calls, { repo: repoPage({ view }) }) }))
    const branches = at('branches')
    expect(textOf(branches)).toContain('只在遠端 1 個')
    press(branches, 'cm-branch-refs/heads/feat')
    press(branches, 'cm-branches-remote')
    const stash = at('stash')
    expect(textOf(stash)).toContain('stash 由這個 repo 的所有 worktree 共用')
    press(stash, 'cm-stash-s1')
    const wt = at('worktrees')
    expect(textOf(wt)).toContain('已不存在')
    press(wt, 'cm-wt-/w/r/.claude/worktrees/agent-x')
    expect(button(wt, 'cm-wt-/w/gone')).toBeUndefined()
    expect(calls).toEqual(['openBranch:refs/heads/feat', 'toggleRemote', 'openStash:s1', 'openWorktree:/w/r/.claude/worktrees/agent-x'])
    for (const tree of [branches, stash, wt]) expect(badProps(tree)).toEqual([])
  })

  test('every sub-page keeps its rows within the card at every width', () => {
    for (const view of ['log', 'branches', 'stash', 'worktrees'] as const) {
      for (const cols of WIDTHS) {
        const tree = draw(baseCtx([], { page: 'commitTree', cols, commits: commits([], { repo: repoPage({ view, remoteOpen: true }) }) }))
        expect(fixedRowsFit(tree, cols)).toBeGreaterThan(0)
      }
    }
  })

  test('no repo: the changes page', () => {
    const tree = draw(baseCtx([], { page: 'commitTree', changes: CHANGES, commits: commits([]) }))
    expect(button(tree, 'chg-s:/w/r/a.go')).toBeDefined()
  })
})

const DIFF: DiffRow[] = [
  { kind: 'hunk', text: '@@ -1,3 +1,3 @@ func main' },
  { kind: 'ctx', old: 1, new: 1, text: 'package main' },
  { kind: 'del', old: 2, text: 'old line' },
  { kind: 'add', new: 2, text: `new line ${'that is very long '.repeat(20)}` },
  { kind: 'note', text: '\\ No newline at end of file' },
]

describe('desktop native B: diff pages', () => {
  test('a file diff: back, ‹ i / n ›, its path and counts, + green, - red, @@ ice blue, long lines cut', () => {
    const calls: Calls = []
    const tree = draw(baseCtx(calls, { page: 'changeDiff', changes: CHANGES, diff: { key: 's:/w/r/a.go', rows: DIFF } }))
    const t = textOf(tree)
    for (const word of ['r/a.go', '主線', '1 / 3', '本 session']) expect(t).toContain(word)
    expect(texts(tree, DT.data)).toContain('@@ -1,3 +1,3 @@ func main')
    expect(texts(tree, DT.fail)).toContain('-old line')
    const added = all(tree, x => x.type === 'Text' && x.props?.['color'] === DT.ok && textOf(x).startsWith('+new line'))[0]
    expect(added?.props?.['wrap']).toBe('truncate')
    press(tree, 'diff-next')
    press(tree, 'diff-prev')
    press(tree, 'back')
    // the first file has none before it
    expect(calls).toEqual(['openDiff:s:/w/r/deep/nested/very/long/path/to/some/file/that/goes/on.go', 'go:changes'])
    expect(badProps(tree)).toEqual([])
    for (const cols of WIDTHS) expect(fixedRowsFit(draw(baseCtx([], { page: 'changeDiff', cols, changes: CHANGES, diff: { key: 's:/w/r/a.go', rows: DIFF } })), cols)).toBeGreaterThan(0)
  })

  test('while git works, when it fails, and a file that left the list', () => {
    expect(textOf(draw(baseCtx([], { page: 'changeDiff', changes: CHANGES, diff: { key: 's:/w/r/a.go', rows: undefined } })))).toContain('計算中…')
    expect(textOf(draw(baseCtx([], { page: 'changeDiff', changes: CHANGES, diff: { key: 's:/w/r/a.go', rows: { error: 'git broke' } } })))).toContain('git broke')
    const gone = draw(baseCtx([], { page: 'changeDiff', changes: CHANGES, diff: { key: 'nope', rows: DIFF } }))
    expect(button(gone, 'diff-prev')).toBeUndefined()
    expect(button(gone, 'chg-s:/w/r/a.go')).toBeDefined()
  })

  test("a commit's diff: back to the tree, its sha and subject, ‹ › over its files", () => {
    const calls: Calls = []
    const cm = commits(calls, {
      repo: repoPage(),
      diff: {
        commit: { sha: 'c2aaaaaaaaaa', parents: [], author: 'a', time: T0, refs: [], subject: 'merge the feature' },
        files: [
          { path: 'a.go', add: 3, del: 1, binary: false },
          { path: 'b.go', add: 0, del: 4, binary: false },
        ],
        file: { path: 'a.go', add: 3, del: 1, binary: false },
        rows: DIFF,
      },
    })
    const tree = draw(baseCtx(calls, { page: 'commitDiff', commits: cm }))
    const t = textOf(tree)
    for (const word of ['c2aaaaa', 'merge the feature', 'a.go', '1 / 2', '+3']) expect(t).toContain(word)
    press(tree, 'cdiff-next')
    press(tree, 'back')
    expect(calls).toEqual(['openFile:b.go', 'go:commitTree'])
    expect(badProps(tree)).toEqual([])
    const empty = draw(baseCtx([], { page: 'commitDiff', commits: commits([], { repo: repoPage(), diff: { ...cm.diff!, files: [], file: undefined } }) }))
    expect(textOf(empty)).toContain('這個 commit 沒有改檔案')
    for (const cols of WIDTHS) expect(fixedRowsFit(draw(baseCtx([], { page: 'commitDiff', cols, commits: cm })), cols)).toBeGreaterThan(0)
  })

})

describe('desktop native B: through the engine', () => {
  const native = (on: Parameters<typeof engine>[0]) => engine(on, 'agent-1', 'native')

  test('the fleet tab draws natively: no herdr, its empty card; only props Desktop 2.1.295 accepts', async ($, on) => {
    native(on)
    await pressOn($, 'desktop', 'tab-fleet')
    for (const cols of WIDTHS) {
      const tree = await drawOn($, 'desktop', 45, cols)
      expect(tree.props?.['backgroundColor']).toBe(DT.bg)
      expect(textOf(tree)).toContain('需要 herdr')
      expect(badProps(tree)).toEqual([])
      wellFormed(tree, cols)
    }
  })

  test('the changes tab draws natively: nothing changed yet; a mode pill switches the mode', async ($, on) => {
    native(on)
    await pressOn($, 'desktop', 'tab-changes')
    const tree = await drawOn($, 'desktop')
    expect(tree.props?.['backgroundColor']).toBe(DT.bg)
    expect(textOf(tree)).toContain('這個 session 還沒改過檔案')
    expect(badProps(tree)).toEqual([])
    await pressOn($, 'desktop', 'chg-mode-unpushed')
    const unpushed = await drawOn($, 'desktop')
    expect(all(unpushed, x => x.type === 'Button' && x.props?.['key'] === 'chg-refresh')).toHaveLength(1)
    expect(badProps(unpushed)).toEqual([])
  })
})
