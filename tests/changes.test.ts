import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { JarvisChange } from '../types'
import { CREATED, bashPaths, dirOf, editOf, noteChange, parseGitdir, relPath, repoName, repoOf, reposOf, tailCells, worktreeOf } from '../hooks/changes'
import type { ChangesIo } from '../hooks/changes'
import { sessionGroups } from '../hooks/changesView'
import type { FileStat } from '../hooks/gitDiff'
import { COMMIT_ICON } from '../hooks/icons'
import { BOOT_MS, THEME, cellWidth } from '../hooks/jarvis'
import { ioOf } from '../hooks/register'

// a stat over a set of directories and files
const statOf = (dirs: string[], files: string[] = []): Pick<ChangesIo, 'stat'> & { asked: string[] } => {
  const asked: string[] = []
  return {
    asked,
    stat: async (path: string) => {
      asked.push(path)
      if (dirs.includes(path)) return { kind: 'dir', size: 0, mtimeMs: 0 }
      if (files.includes(path)) return { kind: 'file', size: 1, mtimeMs: 1 }
      return undefined
    },
  }
}

describe('editOf', () => {
  test('an Edit gives its path and the content before it', () => {
    expect(editOf('Edit', { filePath: '/w/a.go', originalFile: 'a\n', structuredPatch: [] })).toEqual({
      path: '/w/a.go',
      original: 'a\n',
      created: false,
    })
  })
  test('a Write that created the file has no original', () => {
    expect(editOf('Write', { type: 'create', filePath: '/w/n.go', originalFile: null })).toEqual({
      path: '/w/n.go',
      original: null,
      created: true,
    })
  })
  test('an update whose original was too large to include has none', () => {
    expect(editOf('Write', { type: 'update', filePath: '/w/big.sql', originalFile: null })).toEqual({
      path: '/w/big.sql',
      original: null,
      created: false,
    })
  })
  test('a NotebookEdit gives its notebook and original', () => {
    expect(editOf('NotebookEdit', { notebook_path: '/w/n.ipynb', original_file: '{}' })).toEqual({
      path: '/w/n.ipynb',
      original: '{}',
      created: false,
    })
  })
  test('a successful NotebookEdit carrying an empty error is recorded', () => {
    expect(editOf('NotebookEdit', { notebook_path: '/w/n.ipynb', original_file: '{}', error: '' })).toEqual({
      path: '/w/n.ipynb',
      original: '{}',
      created: false,
    })
  })
  test('staged edits, errors, other tools and odd results are not changes', () => {
    expect(editOf('Edit', { filePath: '/w/a', originalFile: 'a', staged: true })).toBeUndefined()
    expect(editOf('NotebookEdit', { notebook_path: '/w/n.ipynb', error: 'no cell' })).toBeUndefined()
    expect(editOf('Read', { filePath: '/w/a' })).toBeUndefined()
    expect(editOf('Edit', undefined)).toBeUndefined()
    expect(editOf('Edit', { filePath: 3 })).toBeUndefined()
  })
})

describe('repoOf', () => {
  test('finds the nearest .git above the file and caches every directory walked', async () => {
    const io = statOf(['/w/.git', '/w/acme/payments/.git'])
    const cache = new Map<string, string | null>()
    expect(await repoOf(io, '/w/acme/payments/service/order.go', cache)).toBe('/w/acme/payments')
    expect(cache.get('/w/acme/payments/service')).toBe('/w/acme/payments')
    const before = io.asked.length
    expect(await repoOf(io, '/w/acme/payments/service/pay.go', cache)).toBe('/w/acme/payments')
    expect(io.asked.length).toBe(before)
  })
  test('a .git file (a worktree) counts', async () => {
    expect(await repoOf(statOf([], ['/w/wt/.git']), '/w/wt/a.go', new Map())).toBe('/w/wt')
  })
  test('no .git up to the root is null', async () => {
    expect(await repoOf(statOf([]), '/tmp/x/a.txt', new Map())).toBeNull()
  })
  test('dirOf stops at the root', () => {
    expect(dirOf('/a/b.go')).toBe('/a')
    expect(dirOf('/a')).toBe('/')
  })
})

describe('bashPaths', () => {
  const H = '/Users/u'
  test('cd, pushd and git -C name their directory', () => {
    expect(bashPaths('cd a/b && go test ./...', '/w', H)).toEqual(['/w/a/b', '/w/a/b/...'])
    expect(bashPaths('pushd sub', '/w', H)).toEqual(['/w/sub'])
    expect(bashPaths('git -C a/b status', '/w', H)).toEqual(['/w/a/b'])
    expect(bashPaths('/usr/bin/git -C sub log', '/w', H)).toEqual(['/w/sub'])
  })
  test('words that look like paths count; options, -- and URLs do not', () => {
    expect(bashPaths("sed -i 's/x/y/' a/b/c.go", '/w', H)).toEqual(['/w/a/b/c.go'])
    expect(bashPaths('curl -o ./out https://x.io/a/b -- --path=/w/z', '/w', H)).toEqual(['/w/out'])
    expect(bashPaths('ls -la', '/w', H)).toEqual([])
  })
  test('quotes come off', () => {
    expect(bashPaths(`cat "a b/c.go" 'd/e f.md'`, '/w', H)).toEqual(['/w/a b/c.go', '/w/d/e f.md'])
  })
  test('~ is home, an absolute path stays, and only paths under cwd are kept', () => {
    expect(bashPaths('cat ~/x', H, H)).toEqual([`${H}/x`])
    expect(bashPaths('cat ~/x', '/w', '')).toEqual([])
    expect(bashPaths('cat /w/a/b.go /tmp/x ../y', '/w', H)).toEqual(['/w/a/b.go'])
    expect(bashPaths('cd .', '/w', H)).toEqual(['/w'])
  })
  test('a relative path after cd X on the line is read from X', () => {
    expect(bashPaths('cd a && cat ../b/x', '/w', H)).toEqual(['/w/a', '/w/b/x'])
    expect(bashPaths('cd /tmp && cat a/b', '/w', H)).toEqual([])
  })
  test('redirections, scp remotes and sed expressions are not paths; a file written to is', () => {
    expect(bashPaths("go test ./x 2>/dev/null >out/log.txt > out/b.txt; sed -i 's/a/b/g' c/d.go", '/w', H)).toEqual([
      '/w/x',
      '/w/out/b.txt',
      '/w/c/d.go',
    ])
    expect(bashPaths('git clone git@gitlab.io:team/repo.git sub/repo', '/w', H)).toEqual(['/w/sub/repo'])
  })
  test('a newline ends a command as ; does', () => {
    expect(bashPaths('cat x/y\ncd sub\ncat ../z/a', '/w', H)).toEqual(['/w/x/y', '/w/sub', '/w/z/a'])
  })
  test('cd -P and -L take the directory after them; VAR= and env do not hide git -C', () => {
    expect(bashPaths('cd -P x', '/w', H)).toEqual(['/w/x'])
    expect(bashPaths('cd -L x && cat a/b', '/w', H)).toEqual(['/w/x', '/w/x/a/b'])
    expect(bashPaths('GIT_PAGER=cat git -C x log', '/w', H)).toEqual(['/w/x'])
    expect(bashPaths('env -i A=1 /usr/bin/git -C x status', '/w', H)).toEqual(['/w/x'])
  })
  test('a line run in a sub directory reads from there and keeps what is under the root', () => {
    expect(bashPaths('cd ../../legacy/billing', '/w/acme/payments', H, '/w')).toEqual(['/w/legacy/billing'])
    expect(bashPaths('git -C ../other status && cat ../../../tmp/x', '/w/acme/payments', H, '/w')).toEqual(['/w/acme/other'])
  })
  test('the same path once, at most 20', () => {
    expect(bashPaths('cat a/x a/x ./a/x', '/w', H)).toEqual(['/w/a/x'])
    const many = Array.from({ length: 30 }, (_, i) => `d/${i}`).join(' ')
    const out = bashPaths(`ls ${many}`, '/w', H)
    expect(out).toHaveLength(20)
    expect(out[19]).toBe('/w/d/19')
  })
})

describe('noteChange', () => {
  const seen = (path: string, actor: string, orig = '/tmp/c/1.orig') => ({ path, repo: '/w/r', actor, orig })
  test('a new path is appended in order', () => {
    const list = noteChange(noteChange([], seen('/w/r/a', 'main')), seen('/w/r/b', 'agent-1'))
    expect(list.map(c => [c.path, c.seq, c.touches])).toEqual([
      ['/w/r/a', 0, 1],
      ['/w/r/b', 1, 1],
    ])
  })
  test('the same path keeps its first orig, counts touches and adds actors once', () => {
    let list: JarvisChange[] = noteChange([], seen('/w/r/a', 'main'))
    list = noteChange(list, seen('/w/r/a', 'agent-1', '/tmp/c/2.orig'))
    list = noteChange(list, seen('/w/r/a', 'main', '/tmp/c/3.orig'))
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({ path: '/w/r/a', repo: '/w/r', actors: ['main', 'agent-1'], seq: 0, touches: 3, orig: '/tmp/c/1.orig' })
  })
  test('reposOf lists the repos in first-touch order, null left out', () => {
    let list: JarvisChange[] = []
    list = noteChange(list, { path: '/w/b/x', repo: '/w/b', actor: 'main', orig: CREATED })
    list = noteChange(list, { path: '/tmp/y', repo: null, actor: 'main', orig: '' })
    list = noteChange(list, { path: '/w/a/x', repo: '/w/a', actor: 'main', orig: '' })
    list = noteChange(list, { path: '/w/b/z', repo: '/w/b', actor: 'main', orig: '' })
    expect(reposOf(list)).toEqual(['/w/b', '/w/a'])
  })
  test("a change in a worktree keeps the repo it was added from and the worktree's name", () => {
    const wt = { mainRepo: '/w/d', name: 'x' }
    const list = noteChange([], { path: '/w/d/.claude/worktrees/x/a', repo: '/w/d/.claude/worktrees/x', actor: 'main', orig: '', worktree: wt })
    expect(list[0]?.mainRepo).toBe('/w/d')
    expect(list[0]?.worktree).toBe('x')
  })
})

describe('worktreeOf', () => {
  const ioOfTexts = (texts: Record<string, string>) => ({ read: async (path: string) => texts[path] })
  test("a .git file's gitdir names the main repo and the worktree", async () => {
    const io = ioOfTexts({ '/w/d/.claude/worktrees/x/.git': 'gitdir: /w/d/.git/worktrees/x\n' })
    expect(await worktreeOf(io, '/w/d/.claude/worktrees/x')).toEqual({ mainRepo: '/w/d', name: 'x' })
  })
  test('a relative gitdir is read from the worktree', async () => {
    expect(parseGitdir('gitdir: ../../../.git/worktrees/y', '/w/d/.claude/worktrees/y')).toEqual({ mainRepo: '/w/d', name: 'y' })
  })
  test("a .git directory, a submodule's .git file and odd text are no worktree", async () => {
    expect(await worktreeOf(ioOfTexts({}), '/w/d')).toBeUndefined()
    expect(parseGitdir('gitdir: ../.git/modules/sub', '/w/d/sub')).toBeUndefined()
    expect(parseGitdir('hello', '/w/d')).toBeUndefined()
  })
})

describe('sessionGroups', () => {
  const names = { cwd: '/w', home: '/Users/u' }
  const change = (path: string, repo: string | null, extra: Partial<JarvisChange> = {}): JarvisChange => ({
    path,
    repo,
    actors: ['main'],
    seq: 0,
    touches: 1,
    orig: '/tmp/c/1.orig',
    ...extra,
  })
  const stat = (add: number, del: number, more: Partial<FileStat> = {}): FileStat => ({ add, del, binary: false, deleted: false, vsHead: false, ...more })
  const T = '/w/d/.claude/worktrees/x'
  const wt = { mainRepo: '/w/d', worktree: 'x' }

  test("a worktree still on disk is titled by its main repo and its name", () => {
    const [g] = sessionGroups([change(`${T}/a.go`, T, wt)], new Map([[`${T}/a.go`, stat(2, 1)]]), names)
    expect(g?.name).toBe('d · worktree x')
    expect(g?.entries.map(e => e.label)).toEqual(['a.go'])
  })
  test('a removed worktree is one group counting its files, none listed and nothing added up', () => {
    const list = [change(`${T}/a.go`, T, wt), change(`${T}/b.go`, T, wt), change('/w/d/c.go', '/w/d')]
    const groups = sessionGroups(list, new Map([['/w/d/c.go', stat(1, 0)]]), names, new Set([T, `${T}/a.go`, `${T}/b.go`]))
    expect(groups.map(g => [g.name, g.removed, g.entries.length, g.add, g.del])).toEqual([
      ['worktree x', 2, 0, 0, 0],
      ['d', undefined, 1, 1, 0],
    ])
  })
  test('a file outside git that is gone is not listed nor counted', () => {
    const list = [change('/tmp/s/a.txt', null), change('/tmp/s/b.txt', null), change('/tmp/s/c.txt', null)]
    const stats = new Map([
      ['/tmp/s/a.txt', stat(0, 7, { deleted: true })],
      ['/tmp/s/c.txt', stat(3, 1)],
    ])
    const [g, ...rest] = sessionGroups(list, stats, names, new Set(['/tmp/s/b.txt']))
    expect(rest).toEqual([])
    expect(g?.entries.map(e => e.path)).toEqual(['/tmp/s/c.txt'])
    expect([g?.add, g?.del]).toEqual([3, 1])
  })
  test('no group outside git is drawn when all its files are gone', () => {
    const groups = sessionGroups([change('/tmp/s/a.txt', null), change('/w/r/a.go', '/w/r')], new Map([['/w/r/a.go', stat(1, 1)]]), names, new Set(['/tmp/s/a.txt']))
    expect(groups.map(g => g.name)).toEqual(['r'])
  })
  test("the rows' counts add up to the group's, a deleted file's and one against HEAD included", () => {
    const list = [change('/w/r/a.go', '/w/r'), change('/w/r/d.go', '/w/r'), change('/w/r/h.go', '/w/r'), change('/w/r/p.png', '/w/r')]
    const stats = new Map([
      ['/w/r/a.go', stat(30, 5)],
      ['/w/r/d.go', stat(0, 9, { deleted: true })],
      ['/w/r/h.go', stat(4, 2, { vsHead: true })],
      ['/w/r/p.png', stat(0, 0, { binary: true })],
    ])
    const [g] = sessionGroups(list, stats, names, new Set(['/w/r/d.go']))
    expect(g?.entries.map(e => [e.mark, e.deleted, e.note])).toEqual([
      [undefined, undefined, undefined],
      ['已刪除', true, undefined],
      ['對 HEAD', undefined, undefined],
      [undefined, undefined, '二進位'],
    ])
    const shownAdd = (g?.entries ?? []).reduce((n, e) => n + (e.note !== undefined || e.deleted ? 0 : e.add), 0)
    const shownDel = (g?.entries ?? []).reduce((n, e) => n + (e.note !== undefined ? 0 : e.del), 0)
    expect([g?.add, g?.del]).toEqual([shownAdd, shownDel])
    expect([g?.add, g?.del]).toEqual([34, 16])
  })
})

describe('names', () => {
  test('repoName is relative to the session directory, else under ~', () => {
    expect(repoName('/w/acme/payments', '/w', '/Users/u')).toBe('acme/payments')
    expect(repoName('/w', '/w', '/Users/u')).toBe('.')
    expect(repoName('/Users/u/dotfiles', '/w', '/Users/u')).toBe('~/dotfiles')
    expect(repoName(null, '/w', '/Users/u')).toBe('(非 git)')
  })
  test('relPath is relative to the repo, else under ~', () => {
    expect(relPath('/w/r/service/a.go', '/w/r', '/Users/u')).toBe('service/a.go')
    expect(relPath('/Users/u/notes/a.md', null, '/Users/u')).toBe('~/notes/a.md')
  })
  test('tailCells keeps the end of the path within the width, CJK counted double', () => {
    expect(tailCells('service/order.go', 20)).toBe('service/order.go')
    expect(tailCells('a/b/c/service/order.go', 12)).toBe('…ce/order.go')
    const cut = tailCells('文件 夾/很長的說明文件.md', 12)
    expect(cut.startsWith('…')).toBe(true)
    expect(cut.endsWith('.md')).toBe(true)
    expect(cellWidth(cut)).toBeLessThanOrEqual(12)
  })
})

// `throws`: the run outlasts its time (process.run rejects)
type Run = { exitCode: number; stdout?: string; stderr?: string; throws?: true }
type Git = Record<string, Run> | ((argv: string[]) => Run)

type Node = { type?: string; props?: Record<string, unknown>; children?: (Node | string)[] }

const textOf = (n: Node | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''))

// One string per drawn row, a row's pieces joined with nothing between them.
const linesOf = (n: Node | string): string[] => {
  if (typeof n === 'string') return [n]
  if (n.type === 'Text' || n.type === 'Button' || n.props?.['flexDirection'] === 'row') return [textOf(n)]
  return (n.children ?? []).flatMap(linesOf)
}

// A drawn node's width in cells: a row's pieces side by side with its gap between each two,
// a column as wide as its widest piece.
const widthOf = (n: Node | string): number => {
  if (typeof n === 'string') return cellWidth(n)
  if (n.type === 'Text') return cellWidth(textOf(n))
  const kids = n.children ?? []
  if (n.type === 'Button' || n.props?.['flexDirection'] === 'row') {
    return kids.reduce((w, k) => w + widthOf(k), 0) + Number(n.props?.['gap'] ?? 0) * Math.max(0, kids.length - 1)
  }
  return Math.max(0, ...kids.map(widthOf))
}

// the drawn row holding the button `key`
const rowWith = (n: Node | string, key: string): Node | undefined => {
  if (typeof n === 'string') return undefined
  const kids = n.children ?? []
  if (n.props?.['flexDirection'] === 'row' && kids.some(k => typeof k === 'object' && k.props?.['key'] === key)) return n
  for (const k of kids) {
    const hit = rowWith(k, key)
    if (hit) return hit
  }
  return undefined
}

// the test runtime's timer, which the mod's es2023 lib does not declare
const later = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout
export const settle = () => new Promise<void>(r => later(() => r(), 5))

// the clock the last world() mocked: start() plays the pane's boot out on it
let worldClock: { advance: (ms: number) => Promise<unknown> } | undefined

// The engine beneath jarvis for the changes page: a fake disk (directories, files by
// mtime), git answering by argv (a map by argv joined with spaces, or a function), edit
// results by file path; what it was asked is logged in order.
export function world(
  on: On,
  opts: { dirs?: string[]; files?: Record<string, number>; texts?: Record<string, string>; git?: Git; results?: Record<string, unknown>; failWrites?: boolean; holdWrite?: (text: string) => Promise<void> | undefined; holdRun?: (argv: string[]) => Promise<void>; denied?: string[]; holdStat?: (path: string) => Promise<void> | undefined; shellCwd?: () => string } = {},
) {
  const log: string[] = []
  const writes = new Map<string, string>()
  const runs: string[][] = []
  // each run's time limit, in the order of `runs`
  const timeouts: (number | undefined)[] = []
  const opens: Record<string, unknown>[] = []
  const closes: string[] = []
  const files = { ...(opts.files ?? {}) }
  // the changes record as the mod last wrote it
  let changes: JarvisChange[] = []
  const answer = (argv: string[]): Run => {
    const git = opts.git
    if (typeof git === 'function') return git(argv)
    return git?.[argv.join(' ')] ?? { exitCode: 128, stdout: '' }
  }
  worldClock = mock.clock(on, { now: 0 })
  mock.env(on, { HOME: '/Users/u', TMPDIR: '/tmp/t/' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('state.set', { plugin: 'jarvis', key: 'changes' }, async (_$, e, next) => {
    const out = await next(e)
    if (out.value?.isSet === true) changes = [...e.value]
    return out
  })
  on('classic.SessionStart', async () => ({}))
  on('agent.list', async () => ({ value: [{ id: 'agent-1', status: 'running', type: 'worker', description: 'd' }] as never }))
  on('ui.open', async (_$, e) => {
    log.push(`open:${e.id}`)
    opens.push(e as unknown as Record<string, unknown>)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', async (_$, e) => {
    closes.push(e.id)
    return { value: undefined as void }
  })
  on('tool.call', async (_$, e) => {
    const input = e as { file_path?: string; notebook_path?: string; command?: string }
    if (input.command !== undefined && (opts.denied ?? []).includes(input.command)) return { deny: 'blocked' }
    const r = opts.results?.[input.file_path ?? input.notebook_path ?? '']
    return { result: (typeof r === 'function' ? r(e) : (r ?? {})) as never }
  })
  if (opts.shellCwd) {
    const shellCwd = opts.shellCwd
    on('session.cwd', async () => ({ value: shellCwd() }))
  }
  on('fs.stat', async (_$, e) => {
    log.push(`stat:${e.path}`)
    await opts.holdStat?.(e.path)
    if ((opts.dirs ?? []).includes(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    const m = files[e.path]
    if (m === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: 10, mtimeMs: m, isLink: false } }
  })
  on('fs.read', async (_$, e) => {
    const t = opts.texts?.[e.path]
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', async (_$, e) => {
    log.push(`write:${e.path}`)
    if (opts.failWrites) throw new Error('EACCES')
    await opts.holdWrite?.(e.text)
    writes.set(e.path, e.text)
    return { value: undefined as void }
  })
  on('process.run', async (_$, e) => {
    log.push('run')
    runs.push([...e.argv])
    timeouts.push(e.init?.timeoutMs)
    await opts.holdRun?.([...e.argv])
    const a = answer([...e.argv])
    if (a.throws) throw new Error('timed out')
    return { value: { exitCode: a.exitCode, stdout: a.stdout ?? '', stderr: a.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { log, writes, runs, timeouts, opens, closes, files, changes: () => changes }
}

export const start = async ($: Engine, cwd = '/w') => {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
  await worldClock?.advance(BOOT_MS)
}

export const edit = ($: Engine, path: string, agentId?: string) =>
  $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', ...(agentId ? { agentId } : {}) } as never)

export const recorded = async (w: { changes: () => JarvisChange[] }): Promise<JarvisChange[]> => w.changes()

const editResult = (path: string, original: string | null) => ({
  filePath: path,
  oldString: 'a',
  newString: 'b',
  originalFile: original,
  structuredPatch: [],
  userModified: false,
  replaceAll: false,
})

describe('recording', () => {
  const A = '/w/acme/payments/service/order.go'
  test('an Edit saves its original once and records the repo and actor', async ($, on) => {
    const w = world(on, { dirs: ['/w/acme/payments/.git'], results: { [A]: editResult(A, 'a\n') } })
    await start($)
    await edit($, A)
    await edit($, A)
    const origs = [...w.writes.keys()].filter(p => p.startsWith('/tmp/t/claude-jarvis-changes/'))
    expect(origs).toHaveLength(1)
    expect(w.writes.get(origs[0] ?? '')).toBe('a\n')
    expect(await recorded(w)).toEqual([{ path: A, repo: '/w/acme/payments', actors: ['main'], seq: 0, touches: 2, orig: origs[0] }])
  })
  test('the main loop and a subagent on the same file make one record with both actors', async ($, on) => {
    const w = world(on, { dirs: ['/w/r/.git'], results: { '/w/r/a.go': editResult('/w/r/a.go', 'a') } })
    await start($)
    await Promise.all([edit($, '/w/r/a.go'), edit($, '/w/r/a.go', 'agent-1')])
    const list = await recorded(w)
    expect(list).toHaveLength(1)
    expect([...(list[0]?.actors ?? [])].sort()).toEqual(['agent-1', 'main'])
    expect(list[0]?.orig.startsWith('/tmp/t/claude-jarvis-changes/')).toBe(true)
  })
  test('the edit that reaches the record first owns the original, however long its cache write takes', async ($, on) => {
    const w = world(on, {
      dirs: ['/w/r/.git'],
      results: {
        '/w/r/a.go': (e: { agentId?: string }) => editResult('/w/r/a.go', e.agentId === undefined ? 'ORIGINAL' : 'AFTER-MAIN'),
      },
      holdWrite: text => (text === 'ORIGINAL' ? settle() : undefined),
    })
    await start($)
    await Promise.all([edit($, '/w/r/a.go'), edit($, '/w/r/a.go', 'agent-1')])
    const list = await recorded(w)
    expect(list).toHaveLength(1)
    expect(w.writes.get(list[0]?.orig ?? '')).toBe('ORIGINAL')
    expect([...w.writes.keys()].filter(p => p.includes('claude-jarvis-changes'))).toHaveLength(1)
  })
  test('a created file needs no cache; an unknown original is recorded as unknown', async ($, on) => {
    const w = world(on, {
      results: {
        '/w/n.go': { type: 'create', filePath: '/w/n.go', content: 'x', structuredPatch: [], originalFile: null },
        '/w/big.sql': { type: 'update', filePath: '/w/big.sql', content: 'x', structuredPatch: [], originalFile: null },
      },
    })
    await start($)
    await $.tool.call({ tool: 'Write', file_path: '/w/n.go', content: 'x' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/w/big.sql', content: 'x' } as never)
    expect((await recorded(w)).map(c => [c.path, c.orig, c.repo])).toEqual([
      ['/w/n.go', '/dev/null', null],
      ['/w/big.sql', '', null],
    ])
    expect([...w.writes.keys()].some(p => p.includes('claude-jarvis-changes'))).toBe(false)
  })
  test('staged and non-edit calls are not recorded, and the tool result is untouched', async ($, on) => {
    const w = world(on, { results: { '/w/a': { ...editResult('/w/a', 'a'), staged: true } } })
    await start($)
    const out = await edit($, '/w/a')
    await $.tool.call({ tool: 'Read', file_path: '/w/a' } as never)
    expect((out as { result?: { staged?: boolean } }).result?.staged).toBe(true)
    expect(await recorded(w)).toEqual([])
  })
  test('a cache write that fails records the change as unknown', async ($, on) => {
    const w = world(on, { results: { '/w/a': editResult('/w/a', 'a') }, failWrites: true })
    await start($)
    await edit($, '/w/a')
    expect((await recorded(w))[0]?.orig).toBe('')
  })
  test('/clear empties the record; a compaction keeps it', async ($, on) => {
    const w = world(on, { results: { '/w/a': editResult('/w/a', 'a') } })
    await start($)
    await edit($, '/w/a')
    await $.classic.SessionStart({ source: 'compact' } as never)
    expect(await recorded(w)).toHaveLength(1)
    await $.classic.SessionStart({ source: 'clear' } as never)
    expect(await recorded(w)).toEqual([])
  })
  test("git's NUL-delimited output reaches the changes page intact, under the run timeout", async () => {
    const stdout = '1\t0\ta b.go\u00002\t1\t說明.md\u0000'
    const asked: { argv: string[]; timeoutMs?: number }[] = []
    const engine = {
      process: {
        run: async (argv: readonly string[], init?: { timeoutMs?: number }) => {
          asked.push({ argv: [...argv], timeoutMs: init?.timeoutMs })
          return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        },
      },
    }
    const out = await ioOf(engine as unknown as Parameters<typeof ioOf>[0]).run(['/usr/bin/git', '-C', '/w/r', 'diff', '-z'])
    expect(out).toEqual({ exitCode: 0, stdout, stderr: '' })
    expect(asked).toEqual([{ argv: ['/usr/bin/git', '-C', '/w/r', 'diff', '-z'], timeoutMs: 5_000 }])
  })
})

const pane = async ($: Engine, cols = 80, rows = 30) => {
  const ui = await $.ui.mount({
    plugin: 'jarvis',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'jarvis',
    props: { title: 'Jarvis', isFocused: true, bodyColumns: cols, placement: 'dock' as const, scroll: { offset: 0, bodyRows: rows }, view: {} },
    viewport: { columns: cols + 20, rows: rows + 10 },
  })
  return ui
}

export const showChanges = async ($: Engine, cols = 80, rows = 30) => {
  const ui = await pane($, cols, rows)
  await ui.press({ key: 'tab-changes' })
  await ui.unmount()
  // a press writes the page from a detached task
  await settle()
}

export const drawn = async ($: Engine, cols = 80, rows = 30): Promise<string[]> => {
  const ui = await pane($, cols, rows)
  const tree = (await ui.drawn()) as unknown as Node
  await ui.unmount()
  return linesOf(tree)
}

// Desktop: the pane's tree, and a press on it
const deskProps = (cols: number, rows: number) => ({
  title: 'Jarvis',
  isFocused: true,
  bodyColumns: cols,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: rows },
  view: {},
})
const deskTree = async ($: Engine, cols = 80, rows = 30): Promise<Node> =>
  (await $.ui.render({
    surface: 'desktop',
    component: 'Pane',
    requestId: 'jarvis',
    viewport: { columns: cols + 20, rows: rows + 10 },
    props: deskProps(cols, rows),
  })) as unknown as Node
const deskPress = async ($: Engine, key: string, cols = 80, rows = 30) => {
  const ui = await $.ui.mount({ plugin: 'jarvis', surface: 'desktop', component: 'Pane', requestId: 'jarvis', props: deskProps(cols, rows), viewport: { columns: cols + 20, rows: rows + 10 } })
  await ui.press({ key })
  await ui.unmount()
  await settle()
}
const kidsOf = (n: Node): Node[] => (n.children ?? []).filter((k): k is Node => typeof k !== 'string')
const allOf = (n: Node, pred: (x: Node) => boolean, out: Node[] = []): Node[] => {
  if (pred(n)) out.push(n)
  for (const k of kidsOf(n)) allOf(k, pred, out)
  return out
}
const keyOf = (n: Node): string => String(n.props?.['key'] ?? '')
// a Desktop cell box's cells: an Svg by its pixels, a Box by its width or least width
const boxCells = (k: Node): number => (k.type === 'Svg' ? Number(k.props?.['width']) / 8 : Number(k.props?.['width'] ?? k.props?.['minWidth']))
// a Desktop spacer: it takes the cells its row (as wide as its cells) leaves over
const isSpacer = (k: Node): boolean => k.type === 'Box' && k.props?.['flexGrow'] === 1
// Desktop rows pressed by a Button keyed `prefix…`: each row's Button and where each of its boxes starts
const pressedRows = (tree: Node, prefix: string) =>
  allOf(tree, x => x.type === 'Box' && kidsOf(x).some(k => kidsOf(k).some(b => b.type === 'Button' && keyOf(b).startsWith(prefix)))).map(row => {
    const ks = kidsOf(row)
    const at = ks.indexOf(ks.find(k => kidsOf(k).some(b => b.type === 'Button')) as Node)
    const fixed = ks.filter(k => !isSpacer(k)).reduce((n, k) => n + boxCells(k), 0)
    const spare = Number(row.props?.['width'] ?? fixed) - fixed
    const starts: number[] = []
    let n = 0
    for (const k of ks) {
      starts.push(n)
      n += isSpacer(k) ? spare : boxCells(k)
    }
    const button = kidsOf(ks[at] as Node).find(b => b.type === 'Button') as Node
    return { row, kids: ks, at, starts, total: n, button, label: textOf(button) }
  })

describe('changes page', () => {
  const A = '/w/acme/payments/service/order.go'
  const B = '/w/legacy/billing/api/pay.go'
  // git answers the session numstat: 30/5 for A against its cached original, 10/0 for B against /dev/null
  const setup = (on: On, holdRun?: () => Promise<void>) =>
    world(on, {
      dirs: ['/w/acme/payments/.git', '/w/legacy/billing/.git'],
      files: { [A]: 5, [B]: 5 },
      results: { [A]: editResult(A, 'a'), [B]: { type: 'create', filePath: B, content: 'x', structuredPatch: [], originalFile: null } },
      git: argv => ({ exitCode: 1, stdout: argv.at(-1) === A ? '30\t5\t...\n' : '10\t0\t...\n' }),
      ...(holdRun ? { holdRun } : {}),
    })

  test('the tab bar has 異動 with its icon', async ($, on) => {
    setup(on)
    await start($)
    expect((await drawn($)).join('\n')).toContain('\uf47f 異動')
  })

  test('an empty session says so', async ($, on) => {
    setup(on)
    await start($)
    await showChanges($)
    expect((await drawn($)).join('\n')).toContain('這個 session 還沒改過檔案')
  })

  test('files are grouped by repo with who changed them and +/- once git answers', async ($, on) => {
    // git answers only once let go, as a real one answers after the drawing that asked
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    setup(on, () => gate)
    await start($)
    await edit($, A)
    await $.tool.call({ tool: 'Write', file_path: B, content: 'x' } as never)
    await showChanges($)
    const first = (await drawn($)).join('\n')
    expect(first).toContain('\uf401 acme/payments')
    expect(first).toContain('…')
    release()
    await settle()
    const lines = await drawn($)
    const text = lines.join('\n')
    expect(text).toContain('\uf401 acme/payments')
    expect(text).toContain('\uf401 legacy/billing')
    expect(text).toMatch(/主線\s+service\/order\.go\s+\+30 −5/)
    expect(text).toMatch(/api\/pay\.go\s+\+10 −0/)
    expect(text.indexOf('acme/payments')).toBeLessThan(text.indexOf('legacy/billing'))
  })

  test('an unknown original outside git reads 無原始內容', async ($, on) => {
    world(on, { files: { '/tmp/x.txt': 1 }, results: { '/tmp/x.txt': editResult('/tmp/x.txt', null) } })
    await start($)
    await edit($, '/tmp/x.txt')
    await showChanges($)
    await drawn($)
    await settle()
    const text = (await drawn($)).join('\n')
    expect(text).toContain('(非 git)')
    expect(text).toContain('無原始內容')
  })

  test('no line is wider than the pane at 40, 60, 80 and 120 columns', async ($, on) => {
    setup(on)
    await start($)
    await edit($, A)
    await $.tool.call({ tool: 'Write', file_path: B, content: 'x' } as never)
    await showChanges($)
    for (const cols of [40, 60, 80, 120]) {
      await drawn($, cols)
      await settle()
      for (const line of await drawn($, cols)) expect(cellWidth(line)).toBeLessThanOrEqual(cols)
    }
  })

  test('a /clear drops the counts git was still working out for the last session', async ($, on) => {
    let original = 'first'
    let oldOrig = ''
    // the first git call waits until let go; the rest answer at once
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    let held = 0
    const w = world(on, {
      dirs: ['/w/acme/payments/.git'],
      files: { [A]: 5 },
      results: { [A]: () => editResult(A, original) },
      git: argv => ({ exitCode: 1, stdout: argv.includes(oldOrig) ? '99\t99\t...\n' : '30\t5\t...\n' }),
      holdRun: () => (held++ === 0 ? gate : Promise.resolve()),
    })
    await start($)
    await edit($, A)
    oldOrig = (await recorded(w))[0]?.orig ?? ''
    await showChanges($)
    await $.classic.SessionStart({ source: 'clear' } as never)
    original = 'second'
    await edit($, A)
    expect((await recorded(w))[0]?.orig).not.toBe(oldOrig)
    await drawn($)
    await settle()
    release()
    await settle()
    const text = (await drawn($)).join('\n')
    expect(text).toMatch(/service\/order\.go\s+\+30 −5/)
    expect(text).not.toContain('+99')
  })

  test('no jarvis Button has a hotkey, the changes buttons included', async ($, on) => {
    setup(on)
    await start($)
    await edit($, A)
    await showChanges($)
    const ui = await pane($)
    const buttons = await ui.findAll({ type: 'Button' })
    await ui.unmount()
    expect(buttons.some(b => b.key === 'tab-changes')).toBe(true)
    expect(buttons.some(b => b.key === 'chg-mode-unpushed')).toBe(true)
    expect(buttons.every(b => b.props['hotkey'] === undefined)).toBe(true)
  })
})

describe('unpushed mode', () => {
  const R = '/w/acme/payments'
  const A = `${R}/service/order.go`
  const G = '/usr/bin/git'
  const answers: Record<string, Run> = {
    [`${G} -C ${R} symbolic-ref -q --short refs/remotes/origin/HEAD`]: { exitCode: 0, stdout: 'origin/main\n' },
    [`${G} -C ${R} merge-base HEAD origin/main`]: { exitCode: 0, stdout: 'b4se\n' },
    [`${G} -C ${R} rev-list --count b4se..HEAD`]: { exitCode: 0, stdout: '2\n' },
    [`${G} -C ${R} diff --numstat -z --no-renames b4se`]: { exitCode: 0, stdout: '30\t5\tservice/order.go\x003\t0\tREADME.md\x00' },
    [`${G} -C ${R} ls-files --others --exclude-standard -z`]: { exitCode: 0, stdout: '' },
  }
  const press = async ($: Engine, key: string) => {
    const ui = await pane($)
    await ui.press({ key })
    await ui.unmount()
    await settle()
  }
  const toUnpushed = ($: Engine) => press($, 'chg-mode-unpushed')

  test('lists every unpushed file of the repos touched, ↑ commits, 其他 for files the session did not touch', async ($, on) => {
    world(on, { dirs: [`${R}/.git`], files: { [A]: 1 }, results: { [A]: editResult(A, 'a') }, git: answers })
    await start($)
    await edit($, A)
    await showChanges($)
    await toUnpushed($)
    await drawn($)
    await settle()
    const text = (await drawn($)).join('\n')
    expect(text).toMatch(/ acme\/payments\s*↑2/)
    expect(text).toMatch(/其他\s+README\.md\s+\+3 −0/)
    expect(text).toMatch(/主線\s+service\/order\.go\s+\+30 −5/)
  })

  test('git runs on entering the mode and on 重新整理, not on every drawing', async ($, on) => {
    const w = world(on, { dirs: [`${R}/.git`], files: { [A]: 1 }, results: { [A]: editResult(A, 'a') }, git: answers })
    await start($)
    await edit($, A)
    await showChanges($)
    await toUnpushed($)
    await drawn($)
    await settle()
    const asked = () => w.runs.filter(r => r.includes('merge-base')).length
    const after = asked()
    expect(after).toBe(1)
    await drawn($)
    await drawn($)
    await settle()
    expect(asked()).toBe(after)
    await press($, 'chg-refresh')
    await drawn($)
    await settle()
    expect(asked()).toBe(after + 1)
    await press($, 'chg-mode-session')
    await drawn($)
    await settle()
    await toUnpushed($)
    await drawn($)
    await settle()
    expect(asked()).toBe(after + 2)
  })

  test('the session counts are not worked out in the unpushed mode', async ($, on) => {
    const w = world(on, { dirs: [`${R}/.git`], files: { [A]: 1 }, results: { [A]: editResult(A, 'a') }, git: answers })
    await start($)
    await edit($, A)
    await showChanges($)
    await toUnpushed($)
    await drawn($)
    await settle()
    const before = w.runs.filter(r => r.includes('--no-index')).length
    w.files[A] = 2
    await edit($, A)
    await worldClock?.advance(5_000)
    await drawn($)
    await settle()
    await drawn($)
    await settle()
    expect(w.runs.filter(r => r.includes('--no-index')).length).toBe(before)
    expect(w.runs.filter(r => r.includes('merge-base')).length).toBe(1)
  })

  test('a repo without origin, or whose merge-base fails, says it compares with HEAD', async ($, on) => {
    const noOrigin: Record<string, Run> = {
      [`${G} -C ${R} diff --numstat -z --no-renames HEAD`]: { exitCode: 0, stdout: '1\t0\tservice/order.go\x00' },
      [`${G} -C ${R} ls-files --others --exclude-standard -z`]: { exitCode: 0, stdout: '' },
    }
    let git = noOrigin
    world(on, { dirs: [`${R}/.git`], files: { [A]: 1 }, results: { [A]: editResult(A, 'a') }, git: argv => git[argv.join(' ')] ?? { exitCode: 128 } })
    await start($)
    await edit($, A)
    await showChanges($)
    await toUnpushed($)
    await drawn($)
    await settle()
    const first = (await drawn($)).join('\n')
    expect(first).toMatch(/acme\/payments[^\n]*\n\s*找不到 origin，只比 HEAD/)
    expect(first).not.toContain('↑')
    git = { ...noOrigin, [`${G} -C ${R} symbolic-ref -q --short refs/remotes/origin/HEAD`]: { exitCode: 0, stdout: 'origin/main\n' } }
    await press($, 'chg-refresh')
    await drawn($)
    await settle()
    expect((await drawn($)).join('\n')).toMatch(/acme\/payments[^\n]*\n\s*merge-base 失敗，只比 HEAD/)
  })

  test('a repo whose git fails shows the error under its name', async ($, on) => {
    world(on, { dirs: [`${R}/.git`], files: { [A]: 1 }, results: { [A]: editResult(A, 'a') } })
    await start($)
    await edit($, A)
    await showChanges($)
    await toUnpushed($)
    await drawn($)
    await settle()
    expect((await drawn($)).join('\n')).toContain('git diff 失敗')
  })

  test('a /clear drops the unpushed files git was still working out for the last session', async ($, on) => {
    // the last session's first ask of origin/HEAD waits until let go; whatever is asked
    // after that answers 99/99
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    let held = 0
    let late = false
    const lateDiff = `${G} -C ${R} diff --numstat -z --no-renames b4se`
    world(on, {
      dirs: [`${R}/.git`],
      files: { [A]: 1 },
      results: { [A]: editResult(A, 'a') },
      git: argv => (late && argv.join(' ') === lateDiff ? { exitCode: 0, stdout: '99\t99\tservice/order.go\x00' } : (answers[argv.join(' ')] ?? { exitCode: 128 })),
      holdRun: argv => (argv.includes('symbolic-ref') && held++ === 0 ? gate : Promise.resolve()),
    })
    await start($)
    await edit($, A)
    await showChanges($)
    await toUnpushed($)
    await drawn($)
    await settle()
    await $.classic.SessionStart({ source: 'clear' } as never)
    await edit($, A)
    await drawn($)
    await settle()
    late = true
    release()
    await settle()
    const text = (await drawn($)).join('\n')
    expect(text).toMatch(/主線\s+service\/order\.go\s+\+30 −5/)
    expect(text).not.toContain('+99')
  })
})

describe('repos touched by Bash', () => {
  const G = '/usr/bin/git'
  const R = '/w/acme/payments'
  const S = '/w/legacy/billing'
  const A = `${R}/service/order.go`
  const answersOf = (repo: string, numstat: string): Record<string, Run> => ({
    [`${G} -C ${repo} symbolic-ref -q --short refs/remotes/origin/HEAD`]: { exitCode: 0, stdout: 'origin/main\n' },
    [`${G} -C ${repo} merge-base HEAD origin/main`]: { exitCode: 0, stdout: 'b4se\n' },
    [`${G} -C ${repo} rev-list --count b4se..HEAD`]: { exitCode: 0, stdout: '0\n' },
    [`${G} -C ${repo} diff --numstat -z --no-renames b4se`]: { exitCode: 0, stdout: numstat },
    [`${G} -C ${repo} ls-files --others --exclude-standard -z`]: { exitCode: 0, stdout: '' },
  })
  const answers = { ...answersOf(R, '30\t5\tservice/order.go\x00'), ...answersOf(S, '4\t1\tapi/pay.go\x00') }
  const setup = (on: On, extra: { denied?: string[]; holdStat?: (path: string) => Promise<void> | undefined; shellCwd?: () => string } = {}) =>
    world(on, {
      dirs: [R, `${R}/.git`, S, `${S}/.git`, `${S}/api`],
      files: { [A]: 1, [`${S}/api/pay.go`]: 1 },
      results: { [A]: editResult(A, 'a') },
      git: answers,
      ...extra,
    })
  const bash = ($: Engine, command: string, agentId?: string) =>
    $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
  const unpushedText = async ($: Engine) => {
    await showChanges($)
    const ui = await pane($)
    await ui.press({ key: 'chg-mode-unpushed' })
    await ui.unmount()
    await settle()
    await drawn($)
    await settle()
    return (await drawn($)).join('\n')
  }
  const mergeBases = (w: { runs: string[][] }, repo: string) =>
    w.runs.filter(r => r.includes('merge-base') && r.includes(repo)).length

  test('a repo a Bash call went into is listed in the unpushed mode, its files 其他', async ($, on) => {
    setup(on)
    await start($)
    await bash($, 'cd legacy/billing && go test ./...')
    const text = await unpushedText($)
    expect(text).toContain(' legacy/billing')
    expect(text).toMatch(/其他\s+api\/pay\.go\s+\+4 −1/)
  })

  test('a recorded repo comes first, then the Bash ones; a subagent Bash counts', async ($, on) => {
    setup(on)
    await start($)
    await edit($, A)
    await bash($, `sed -i 's/x/y/' legacy/billing/api/pay.go`, 'agent-1')
    const text = await unpushedText($)
    expect(text).toMatch(/主線\s+service\/order\.go\s+\+30 −5/)
    expect(text).toMatch(/其他\s+api\/pay\.go\s+\+4 −1/)
    expect(text.indexOf('acme/payments')).toBeLessThan(text.indexOf('legacy/billing'))
  })

  test('a denied Bash call is not recorded', async ($, on) => {
    const w = setup(on, { denied: ['cd legacy/billing'] })
    await start($)
    const out = await bash($, 'cd legacy/billing')
    expect((out as { deny?: string }).deny).toBe('blocked')
    const text = await unpushedText($)
    expect(text).not.toContain('legacy/billing')
    expect(mergeBases(w, S)).toBe(0)
  })

  test('paths that are not there are passed over and the call is left as it was', async ($, on) => {
    world(on, { results: { '': { stdout: 'ok' } } })
    await start($)
    const out = await bash($, 'cat nothing/here ./gone && cd missing')
    expect((out as { result?: unknown }).result).toEqual({ stdout: 'ok' })
  })

  test('a stat that throws on a repo leaves the call as it was and lists nothing', async ($, on) => {
    world(on, {
      dirs: [S, `${S}/.git`],
      results: { '': { stdout: 'ok' } },
      git: answers,
      holdStat: path => (path === S ? Promise.reject(new Error('EIO')) : undefined),
    })
    await start($)
    const out = await bash($, 'cd legacy/billing')
    expect((out as { result?: unknown }).result).toEqual({ stdout: 'ok' })
    expect(await unpushedText($)).not.toContain('legacy/billing')
  })

  test('a /clear while a Bash call is still being looked at stores nothing of it', async ($, on) => {
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    const w = setup(on, { holdStat: path => (path === `${S}/.git` ? gate : undefined) })
    await start($)
    const call = bash($, 'cd legacy/billing')
    await settle()
    expect(w.log).toContain(`stat:${S}/.git`)
    await $.classic.SessionStart({ source: 'clear' } as never)
    release()
    await call
    const text = await unpushedText($)
    expect(text).toContain('這個 session 還沒碰過任何 git repo')
    expect(mergeBases(w, S)).toBe(0)
  })

  test('a line naming no path records the repo the shell sits in', async ($, on) => {
    const w = setup(on, { shellCwd: () => S })
    await start($)
    await bash($, "sed -i '' s/a/b/ main.go")
    const text = await unpushedText($)
    expect(text).toContain('\uf401 legacy/billing')
    expect(mergeBases(w, S)).toBe(1)
  })

  test('the shell at the session directory adds no repo of its own', async ($, on) => {
    const w = world(on, { dirs: ['/w', '/w/.git'], git: answers, shellCwd: () => '/w' })
    await start($)
    await bash($, 'git commit -m x')
    expect(await unpushedText($)).toContain('這個 session 還沒碰過任何 git repo')
    expect(w.runs.filter(r => r.includes('merge-base'))).toHaveLength(0)
  })

  test('a shell in a worktree under the session directory records the worktree', async ($, on) => {
    const T = '/w/.claude/worktrees/x'
    world(on, { dirs: ['/w/.git', T], files: { [`${T}/.git`]: 1 }, git: answersOf(T, '2\t0\ta.go\x00'), shellCwd: () => T })
    await start($)
    await bash($, 'touch a.txt')
    const text = await unpushedText($)
    expect(text).toContain('\uf401 .claude/worktrees/x')
    expect(text).toMatch(/其他\s+a\.go\s+\+2 −0/)
  })

  test('a relative path is read from where the shell is, after an earlier cd', async ($, on) => {
    // the shell sits in acme/payments, as $.session.cwd() says after a `cd` there
    let shell = '/w'
    const w = setup(on, { shellCwd: () => shell })
    await start($)
    await bash($, 'cd acme/payments')
    shell = R
    await bash($, 'cd ../../legacy/billing && git status')
    const text = await unpushedText($)
    expect(text).toContain('\uf401 acme/payments')
    expect(text).toContain('\uf401 legacy/billing')
    expect(mergeBases(w, S)).toBe(1)
  })

  test('/clear forgets the repos Bash touched', async ($, on) => {
    const w = setup(on)
    await start($)
    await bash($, 'git -C legacy/billing status')
    await $.classic.SessionStart({ source: 'clear' } as never)
    const text = await unpushedText($)
    expect(text).toContain('這個 session 還沒碰過任何 git repo')
    expect(mergeBases(w, S)).toBe(0)
  })

  test('a repo touched again is asked of git once; a new one alone is asked', async ($, on) => {
    const w = setup(on)
    await start($)
    await edit($, A)
    await bash($, 'cd acme/payments && go test ./...')
    await bash($, 'git -C acme/payments status')
    await unpushedText($)
    expect(mergeBases(w, R)).toBe(1)
    await bash($, 'cd legacy/billing')
    await bash($, 'git -C legacy/billing log')
    await drawn($)
    await settle()
    const text = (await drawn($)).join('\n')
    expect(text).toContain(' legacy/billing')
    expect(mergeBases(w, R)).toBe(1)
    expect(mergeBases(w, S)).toBe(1)
  })
})

describe('diff page', () => {
  const R = '/w/r'
  const A = `${R}/a.go`
  const B = `${R}/b.go`
  const DIFF_A = '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n'
  // numstat says 1/1; a diff of A is DIFF_A, of B a one-line change; `long` makes every diff one 500-cell line;
  // `holdRun` as world() takes it
  const setup = (on: On, long = false, holdRun?: (argv: string[]) => Promise<void>) =>
    world(on, {
      ...(holdRun ? { holdRun } : {}),
      dirs: [`${R}/.git`],
      files: { [A]: 1, [B]: 1 },
      results: { [A]: editResult(A, 'a'), [B]: editResult(B, 'b') },
      git: argv => ({
        exitCode: 1,
        stdout: argv.includes('--numstat')
          ? '1\t1\t...\n'
          : long
            ? `@@ -0,0 +1 @@\n+${'x'.repeat(500)}\n`
            : argv.at(-1) === A
              ? DIFF_A
              : '@@ -1 +1 @@\n-b\n+c\n',
      }),
    })
  const press = async ($: Engine, key: string) => {
    const ui = await pane($)
    await ui.press({ key })
    await ui.unmount()
    await settle()
  }
  // the changes page listing, its numstat answered
  const listed = async ($: Engine, ...files: string[]) => {
    await start($)
    for (const f of files) await edit($, f)
    await showChanges($)
    await drawn($)
    await settle()
  }
  const text = async ($: Engine) => (await drawn($)).join('\n')

  test('clicking a file shows its diff page in the jarvis pane, no other pane opened', async ($, on) => {
    const w = setup(on)
    await listed($, A)
    await press($, `chg-s:${A}`)
    await drawn($)
    await settle()
    const t = await text($)
    expect(t).toContain('r/a.go')
    expect(t).toContain('返回')
    expect(t).not.toContain('本次 session未推送')
    expect(w.opens.filter(o => o['id'] !== 'jarvis')).toEqual([])
  })

  test("Desktop: a file row's Button is its actor alone, the path and counts outside, starting at the same cell; a press opens the diff", async ($, on) => {
    const w = setup(on)
    await listed($, A, B)
    const rows = pressedRows(await deskTree($), 'chg-s:')
    expect(rows).toHaveLength(2)
    const pathAt = (r: (typeof rows)[number]) => r.starts[r.kids.findIndex(k => textOf(k).includes('.go'))]
    for (const r of rows) {
      expect(r.label).toBe('主線')
      expect(r.at).toBe(1)
      expect(r.kids.findIndex(k => textOf(k).includes('.go'))).toBeGreaterThan(r.at)
      expect(allOf(r.button, x => x.type === 'Svg')).toEqual([])
      expect(r.total).toBe(76)
    }
    expect(new Set(rows.map(pathAt)).size).toBe(1)
    // the terminal's row is still one Button holding the whole line
    const ui = await pane($)
    expect((await ui.find({ key: `chg-s:${A}` }))?.text).toContain('a.go')
    await ui.unmount()
    await deskPress($, `chg-s:${A}`)
    await deskTree($)
    await settle()
    expect(linesOf(await deskTree($)).join('\n')).toContain('r/a.go')
    expect(w.opens.filter(o => o['id'] !== 'jarvis')).toEqual([])
  })

  test('the page shows the file, who changed it, its counts, the mode and the diff with line numbers', async ($, on) => {
    // the diff answers only once let go, as a real git answers after the drawing that asked
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    setup(on, false, argv => (argv.includes('--no-color') ? gate : Promise.resolve()))
    await listed($, A)
    await press($, `chg-s:${A}`)
    expect(await text($)).toContain('計算中…')
    release()
    await settle()
    const t = await text($)
    expect(t).toMatch(/r\/a\.go\s+主線\s+\+1 −1\s+本次 session/)
    expect(t).toMatch(/1\s+1\s+ keep/)
    expect(t).toMatch(/2\s+-old/)
    expect(t).toMatch(/2\s+\+new/)
  })

  test('‹ › walk the listed files and stop at the ends; 返回 goes back to the list', async ($, on) => {
    setup(on)
    await listed($, A, B)
    await press($, `chg-s:${A}`)
    await press($, 'diff-prev')
    expect(await text($)).toContain('1 / 2')
    await press($, 'diff-next')
    await drawn($)
    await settle()
    expect(await text($)).toContain('2 / 2')
    expect(await text($)).toMatch(/1\s+\+c/)
    await press($, 'diff-next')
    expect(await text($)).toContain('2 / 2')
    await press($, 'back')
    expect(await text($)).toContain('本次 session未推送')
  })

  test('a /clear drops the diff git was still working out for the last session', async ($, on) => {
    // the last session's first diff waits until let go; whatever is answered after that is `-stale`
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    let held = 0
    let late = false
    world(on, {
      dirs: [`${R}/.git`],
      files: { [A]: 1 },
      results: { [A]: editResult(A, 'a') },
      git: argv => ({
        exitCode: 1,
        stdout: argv.includes('--numstat') ? '1\t1\t...\n' : late ? '@@ -1 +1 @@\n-stale\n' : DIFF_A,
      }),
      holdRun: argv => (argv.includes('--no-color') && held++ === 0 ? gate : Promise.resolve()),
    })
    await listed($, A)
    await press($, `chg-s:${A}`)
    await drawn($)
    await $.classic.SessionStart({ source: 'clear' } as never)
    // the page is still on A's diff, now the new session's
    await edit($, A)
    await drawn($)
    await settle()
    await drawn($)
    await settle()
    late = true
    release()
    await settle()
    const t = await text($)
    expect(t).toMatch(/2\s+-old/)
    expect(t).not.toContain('stale')
  })

  // git for one repo in the unpushed mode: A changed since b4se, its diff `diffA()`; a diff
  // that is undefined fails
  const G = '/usr/bin/git'
  const unpushedGit = (diffA: () => string | undefined) => (argv: string[]): Run => {
    const asked = argv.join(' ')
    if (asked === `${G} -C ${R} symbolic-ref -q --short refs/remotes/origin/HEAD`) return { exitCode: 0, stdout: 'origin/main\n' }
    if (asked === `${G} -C ${R} merge-base HEAD origin/main`) return { exitCode: 0, stdout: 'b4se\n' }
    if (asked === `${G} -C ${R} rev-list --count b4se..HEAD`) return { exitCode: 0, stdout: '1\n' }
    if (asked === `${G} -C ${R} diff --numstat -z --no-renames b4se`) return { exitCode: 0, stdout: '1\t1\ta.go\x00' }
    if (asked === `${G} -C ${R} ls-files --others --exclude-standard -z`) return { exitCode: 0, stdout: '' }
    if (asked === `${G} -C ${R} diff --no-color --no-renames b4se -- ${A}`) {
      const d = diffA()
      return d === undefined ? { exitCode: 128 } : { exitCode: 0, stdout: d }
    }
    return { exitCode: 128 }
  }
  const toUnpushedDiff = async ($: Engine) => {
    await start($)
    await edit($, A)
    await showChanges($)
    await press($, 'chg-mode-unpushed')
    await drawn($)
    await settle()
    await press($, `chg-u:${A}`)
    await drawn($)
    await settle()
  }

  test('in the unpushed mode the page diffs the file against the merge-base', async ($, on) => {
    const w = world(on, { dirs: [`${R}/.git`], files: { [A]: 1 }, results: { [A]: editResult(A, 'a') }, git: unpushedGit(() => DIFF_A) })
    await toUnpushedDiff($)
    const t = await text($)
    expect(t).toMatch(/r\/a\.go\s+主線\s+\+1 −1\s+未推送/)
    expect(t).toMatch(/2\s+\+new/)
    expect(w.runs).toContainEqual([G, '-C', R, 'diff', '--no-color', '--no-renames', 'b4se', '--', A])
  })

  test('a file that changes again is diffed again, in either mode', async ($, on) => {
    let version = 'old'
    const diff = () => `@@ -1 +1 @@\n-x\n+${version}\n`
    const unpushed = unpushedGit(diff)
    const w = world(on, {
      dirs: [`${R}/.git`],
      files: { [A]: 1 },
      results: { [A]: editResult(A, 'a') },
      git: argv => (argv.includes('--no-index') ? { exitCode: 1, stdout: argv.includes('--numstat') ? '1\t1\t...\n' : diff() } : unpushed(argv)),
    })
    await listed($, A)
    await press($, `chg-s:${A}`)
    await drawn($)
    await settle()
    expect(await text($)).toContain('+old')
    version = 'session-new'
    w.files[A] = 2
    await drawn($)
    await settle()
    expect(await text($)).toContain('+session-new')
    await press($, 'back')
    await press($, 'chg-mode-unpushed')
    await drawn($)
    await settle()
    await press($, `chg-u:${A}`)
    await drawn($)
    await settle()
    expect(await text($)).toContain('+session-new')
    version = 'unpushed-new'
    w.files[A] = 3
    await drawn($)
    await settle()
    expect(await text($)).toContain('+unpushed-new')
  })

  test('a failed diff shows its error, is not asked again every drawing, and 重新整理 retries it', async ($, on) => {
    let ok = false
    const w = world(on, { dirs: [`${R}/.git`], files: { [A]: 1 }, results: { [A]: editResult(A, 'a') }, git: unpushedGit(() => (ok ? DIFF_A : undefined)) })
    await toUnpushedDiff($)
    expect(await text($)).toContain('git diff 失敗')
    const asked = () => w.runs.filter(r => r.includes('--no-color')).length
    await drawn($)
    await settle()
    await drawn($)
    await settle()
    expect(asked()).toBe(1)
    ok = true
    await press($, 'back')
    await press($, 'chg-refresh')
    await drawn($)
    await settle()
    await press($, `chg-u:${A}`)
    await drawn($)
    await settle()
    expect(await text($)).toMatch(/2\s+\+new/)
  })

  test('long lines are cut to the pane width at 40, 60, 80 and 120 columns', async ($, on) => {
    setup(on, true)
    await listed($, A)
    await press($, `chg-s:${A}`)
    await drawn($)
    await settle()
    for (const cols of [40, 60, 80, 120]) {
      const lines = await drawn($, cols)
      expect(lines.join('\n')).toContain('…')
      for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(cols)
    }
  })
})

describe('session mode: worktrees, scratch files and counts', () => {
  const M = '/w/dotfiles'
  const T = `${M}/.claude/worktrees/x`
  const A = `${T}/a.go`
  const worktreeWorld = (on: On, dirs: string[]) =>
    world(on, {
      dirs,
      files: { [A]: 1, [`${T}/.git`]: 1 },
      texts: { [`${T}/.git`]: `gitdir: ${M}/.git/worktrees/x\n` },
      results: { [A]: editResult(A, 'a') },
      git: () => ({ exitCode: 1, stdout: '3\t1\t...\n' }),
    })
  const pageText = async ($: Engine) => {
    await showChanges($)
    await drawn($)
    await settle()
    return (await drawn($)).join('\n')
  }

  test('an edit in a worktree records the repo it was added from', async ($, on) => {
    const w = worktreeWorld(on, [`${M}/.git`, T])
    await start($)
    await edit($, A)
    expect((await recorded(w))[0]).toMatchObject({ repo: T, mainRepo: M, worktree: 'x' })
  })

  test("a worktree still on disk is titled by its main repo and the worktree's name", async ($, on) => {
    worktreeWorld(on, [`${M}/.git`, T])
    await start($)
    await edit($, A)
    const text = await pageText($)
    expect(text).toContain(' dotfiles · worktree x')
    expect(text).toMatch(/主線\s+a\.go\s+\+3 −1/)
  })

  test('a removed worktree is one dim line, its files neither listed nor diffed', async ($, on) => {
    const dirs = [`${M}/.git`, T]
    const w = worktreeWorld(on, dirs)
    await start($)
    await edit($, A)
    dirs.splice(dirs.indexOf(T), 1)
    delete w.files[A]
    delete w.files[`${T}/.git`]
    const text = await pageText($)
    expect(text).toContain('worktree x 已移除（1 檔）')
    expect(text).not.toContain('a.go')
    expect(text).not.toContain('已刪除')
    expect(w.runs.filter(r => r.includes(A))).toEqual([])
  })

  describe('removed is judged when drawn, not by what was recorded', () => {
    const legacyWorld = (on: On, dirs: string[]) =>
      world(on, {
        dirs,
        files: { [A]: 1, [`${T}/.git`]: 1 },
        results: { [A]: editResult(A, 'a') },
        git: () => ({ exitCode: 1, stdout: '3\t1\t...\n' }),
      })

    test('a record without worktree fields whose worktree root is gone is one line, git not asked', async ($, on) => {
      const dirs = [`${M}/.git`, T]
      const w = legacyWorld(on, dirs)
      await start($)
      await edit($, A)
      expect((await recorded(w))[0]?.worktree).toBeUndefined()
      dirs.splice(dirs.indexOf(T), 1)
      delete w.files[A]
      delete w.files[`${T}/.git`]
      const text = await pageText($)
      expect(text).toContain('worktree x 已移除（1 檔）')
      expect(text).not.toContain('a.go')
      expect(text).not.toContain('已刪除')
      expect(w.runs.filter(r => r.includes(A))).toEqual([])
    })

    test('a record without worktree fields whose worktree is still there is titled by the path', async ($, on) => {
      legacyWorld(on, [`${M}/.git`, T])
      await start($)
      await edit($, A)
      expect(await pageText($)).toContain(' dotfiles · worktree x')
    })

    test('a whole repo deleted is one removed line named after it', async ($, on) => {
      const R = '/w/r'
      const F = `${R}/a.go`
      const dirs = [`${R}/.git`]
      const w = world(on, {
        dirs,
        files: { [F]: 1 },
        results: { [F]: editResult(F, 'a') },
        git: () => ({ exitCode: 1, stdout: '3\t1\t...\n' }),
      })
      await start($)
      await edit($, F)
      dirs.splice(0, 1)
      delete w.files[F]
      const text = await pageText($)
      expect(text).toContain('r 已移除（1 檔）')
      expect(text).not.toContain('已刪除')
      expect(w.runs.filter(r => r.includes(F))).toEqual([])
    })

    test('a repo still there with only a file deleted keeps the 已刪除 row', async ($, on) => {
      const R = '/w/r'
      const [F, D] = [`${R}/a.go`, `${R}/d.go`]
      const w = world(on, {
        dirs: [`${R}/.git`],
        files: { [F]: 1, [D]: 1 },
        results: { [F]: editResult(F, 'a'), [D]: editResult(D, 'd') },
        git: argv => ({ exitCode: 1, stdout: argv.at(-1) === CREATED ? '0\t9\t...\n' : '3\t1\t...\n' }),
      })
      await start($)
      await edit($, F)
      await edit($, D)
      delete w.files[D]
      const text = await pageText($)
      expect(text).not.toContain('已移除')
      expect(text).toMatch(/d\.go\s+已刪除 −9/)
    })
  })

  test('a removed worktree is not listed in the unpushed mode and git is not asked of it', async ($, on) => {
    const B = `${M}/b.go`
    const dirs = [`${M}/.git`, T]
    const w = world(on, {
      dirs,
      files: { [A]: 1, [B]: 1, [`${T}/.git`]: 1 },
      texts: { [`${T}/.git`]: `gitdir: ${M}/.git/worktrees/x\n` },
      results: { [A]: editResult(A, 'a'), [B]: editResult(B, 'b') },
      git: () => ({ exitCode: 1, stdout: '' }),
    })
    await start($)
    await edit($, A)
    await edit($, B)
    dirs.splice(dirs.indexOf(T), 1)
    delete w.files[A]
    delete w.files[`${T}/.git`]
    await showChanges($)
    const ui = await pane($)
    await ui.press({ key: 'chg-mode-unpushed' })
    await ui.unmount()
    await settle()
    await drawn($)
    await settle()
    const text = (await drawn($)).join('\n')
    expect(text).toContain(' dotfiles')
    expect(text).not.toContain('worktrees/x')
    expect(w.runs.filter(r => r.includes(T))).toEqual([])
    expect(w.runs.some(r => r.includes(M))).toBe(true)
  })

  test('a scratch file outside git that is gone is hidden, its group with it when none is left', async ($, on) => {
    const S = '/tmp/s/scratch.json'
    const K = '/tmp/s/keep.txt'
    const w = world(on, {
      files: { [S]: 1, [K]: 1 },
      results: { [S]: editResult(S, 's'), [K]: editResult(K, 'k') },
      git: () => ({ exitCode: 1, stdout: '2\t0\t...\n' }),
    })
    await start($)
    await edit($, S)
    await edit($, K)
    delete w.files[S]
    let text = await pageText($)
    expect(text).toContain('(非 git)')
    expect(text).not.toContain('scratch.json')
    expect(text).toMatch(/\(非 git\)\s+1 檔\s+\+2 −0/)
    delete w.files[K]
    await worldClock?.advance(2_000)
    text = await pageText($)
    expect(text).not.toContain('(非 git)')
    expect(text).not.toContain('已刪除')
  })

  test("each row shows its counts and they add up to the group's, deleted and HEAD rows included", async ($, on) => {
    const R = '/w/r'
    const [F, D, H] = [`${R}/a.go`, `${R}/d.go`, `${R}/h.go`]
    const w = world(on, {
      dirs: [`${R}/.git`],
      files: { [F]: 1, [D]: 1, [H]: 1 },
      results: { [F]: editResult(F, 'a'), [D]: editResult(D, 'd'), [H]: editResult(H, null) },
      git: argv => ({ exitCode: 1, stdout: argv.includes('HEAD') ? '4\t2\t...\n' : argv.at(-1) === CREATED ? '0\t9\t...\n' : '30\t5\t...\n' }),
    })
    await start($)
    await edit($, F)
    await edit($, D)
    await edit($, H)
    delete w.files[D]
    const text = await pageText($)
    expect(text).toMatch(/r\s+3 檔\s+\+34 −16/)
    expect(text).toMatch(/a\.go\s+\+30 −5/)
    expect(text).toMatch(/d\.go\s+已刪除 −9/)
    expect(text).toMatch(/h\.go\s+對 HEAD \+4 −2/)
  })
})

describe('commits mode: repo list', () => {
  const G = '/usr/bin/git'
  const FIND_LINE = '/usr/bin/find /w -maxdepth 4 ( -name node_modules -o -name Library -o -name .Trash -o -name .cache -o -path */.claude/worktrees ) -prune -o -name .git -print -prune'
  const A = '/w/acme/payments'
  const B = '/w/legacy/billing'
  const C = '/w/old'
  const AF = `${A}/x.go`
  const sumLine = (repo: string) => `${G} -C ${repo} log -1 --decorate=full --format=%ct%x00%h%x00%D HEAD`
  const summary = (ct: number, branch: string): Run => ({ exitCode: 0, stdout: `${ct}\x00abc1234\x00HEAD -> refs/heads/${branch}, refs/remotes/origin/${branch}\n` })
  const answers = (over: Record<string, Run> = {}): Record<string, Run> => ({
    [FIND_LINE]: { exitCode: 0, stdout: `${A}/.git\n${B}/.git\n${C}/.git\n` },
    [sumLine(A)]: summary(100, 'main'),
    [sumLine(B)]: summary(300, 'master'),
    [sumLine(C)]: summary(200, 'dev'),
    [`${G} -C ${A} rev-list --count @{u}..HEAD`]: { exitCode: 0, stdout: '2\n' },
    [`${G} -C ${B} rev-list --count @{u}..HEAD`]: { exitCode: 0, stdout: '0\n' },
    ...over,
  })
  const setup = (on: On, git: Git = answers(), holdRun?: (argv: string[]) => Promise<void>) =>
    world(on, { dirs: [`${A}/.git`], files: { [AF]: 1 }, results: { [AF]: editResult(AF, 'a') }, git, ...(holdRun ? { holdRun } : {}) })
  const press = async ($: Engine, key: string, cols = 80) => {
    const ui = await pane($, cols)
    await ui.press({ key })
    await ui.unmount()
    await settle()
  }
  // the changes page in the commits mode, git answered
  const listed = async ($: Engine) => {
    await start($)
    await edit($, AF)
    await showChanges($)
    await press($, 'chg-mode-commits')
    await drawn($)
    await settle()
  }
  const finds = (w: { runs: string[][] }) => w.runs.filter(r => r[0] === '/usr/bin/find').length

  test('lists the repos under the session directory, touched ones first with ★, then newest commit first', async ($, on) => {
    setup(on)
    await listed($)
    const lines = await drawn($)
    const text = lines.join('\n')
    expect(text).toContain('提交')
    expect(text).toContain(' w · 3 repos')
    const at = (s: string) => lines.findIndex(l => l.includes(s))
    expect(lines[at('acme/payments')]).toMatch(/★ acme\/payments\s+main ↑2/)
    expect(at('acme/payments')).toBeLessThan(at('legacy/billing'))
    expect(at('legacy/billing')).toBeLessThan(at('old'))
    expect(lines[at('legacy/billing')]).toMatch(/legacy\/billing\s+master\s+剛剛/)
    expect(lines[at('legacy/billing')]).not.toContain('↑')
  })

  test("Desktop: a repo row's Button is its name (with ★), the branch and time outside; every row its full width; a press opens the tree", async ($, on) => {
    setup(on)
    await listed($)
    const rows = pressedRows(await deskTree($), 'cm-repo-')
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r.label)).toEqual(['★ acme/payments', 'legacy/billing', 'old'])
    for (const r of rows) {
      expect(r.total).toBe(76)
      expect(r.kids.slice(r.at + 1).some(k => /main|master|dev/.test(textOf(k)))).toBe(true)
    }
    await deskPress($, `cm-repo-${A}`)
    for (let i = 0; i < 3; i += 1) {
      await deskTree($)
      await settle()
    }
    expect(allOf(await deskTree($), x => x.type === 'Button' && keyOf(x) === 'back')).toHaveLength(1)
  })

  test('find runs on entering the mode and on 重新整理, not on every drawing; the session counts are not asked', async ($, on) => {
    const w = setup(on)
    await listed($)
    expect(finds(w)).toBe(1)
    await drawn($)
    await drawn($)
    await settle()
    await press($, 'chg-mode-session')
    await press($, 'chg-mode-commits')
    await drawn($)
    await settle()
    expect(finds(w)).toBe(1)
    await press($, 'chg-refresh')
    await drawn($)
    await settle()
    expect(finds(w)).toBe(2)
    expect(w.runs.some(r => r.includes('--no-index'))).toBe(true)
    const before = w.runs.filter(r => r.includes('--no-index')).length
    await drawn($)
    await settle()
    expect(w.runs.filter(r => r.includes('--no-index')).length).toBe(before)
  })

  test('a repo whose git fails shows the error on its row, the others listed', async ($, on) => {
    setup(on, answers({ [sumLine(C)]: { exitCode: 128, stdout: '' } }))
    await listed($)
    const text = (await drawn($)).join('\n')
    expect(text).toMatch(/old\s+git log 失敗/)
    expect(text).toContain('legacy/billing')
  })

  test('nothing found says 找不到 repo', async ($, on) => {
    setup(on, answers({ [FIND_LINE]: { exitCode: 0, stdout: '' } }))
    // no edit: a touched repo with its .git on disk would be listed (the test below)
    await start($)
    await showChanges($)
    await press($, 'chg-mode-commits')
    await drawn($)
    await settle()
    expect((await drawn($)).join('\n')).toContain('找不到 repo')
  })

  test('a touched repo find did not list is added while its .git is there', async ($, on) => {
    setup(on, answers({ [FIND_LINE]: { exitCode: 0, stdout: `${B}/.git\n` } }))
    await listed($)
    const text = (await drawn($)).join('\n')
    expect(text).toContain('★ acme/payments')
    expect(text).toContain('2 repos')
  })

  test('a find that fails still lists the touched repos whose .git is there', async ($, on) => {
    setup(on, answers({ [FIND_LINE]: { exitCode: 1, stdout: '' } }))
    await listed($)
    const text = (await drawn($)).join('\n')
    expect(text).toContain('★ acme/payments')
    expect(text).toContain('1 repos')
    expect(text).not.toContain('找不到 repo')
  })

  test('a find that fails with no touched repo says 找不到 repo', async ($, on) => {
    setup(on, answers({ [FIND_LINE]: { exitCode: 1, stdout: '' } }))
    await start($)
    await showChanges($)
    await press($, 'chg-mode-commits')
    await drawn($)
    await settle()
    expect((await drawn($)).join('\n')).toContain('找不到 repo')
  })

  test('a /clear drops the scan still running; the next drawing scans again', async ($, on) => {
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    // the held find answers last: world() asks holdRun before it answers, so the first find
    // marks the answer it is about to get as the stale one once let go
    let staleNext = false
    const git = (argv: string[]): Run => {
      if (argv[0] !== '/usr/bin/find') return answers()[argv.join(' ')] ?? { exitCode: 128, stdout: '' }
      if (!staleNext) return { exitCode: 0, stdout: `${B}/.git\n` }
      staleNext = false
      return { exitCode: 0, stdout: '/w/stale/.git\n' }
    }
    let held = 0
    const w = setup(on, git, argv =>
      argv[0] === '/usr/bin/find' && held++ === 0 ? gate.then(() => void (staleNext = true)) : Promise.resolve(),
    )
    await start($)
    await showChanges($)
    await press($, 'chg-mode-commits')
    await drawn($)
    await $.classic.SessionStart({ source: 'clear' } as never)
    await drawn($)
    await settle()
    release()
    await settle()
    await drawn($)
    await settle()
    const text = (await drawn($)).join('\n')
    expect(finds(w)).toBe(2)
    expect(text).toContain('legacy/billing')
    expect(text).not.toContain('stale')
  })

  test('no line is wider than the pane at 40, 60, 80 and 120 columns; no repo button has a hotkey', async ($, on) => {
    setup(on)
    await listed($)
    for (const cols of [40, 60, 80, 120]) {
      for (const line of await drawn($, cols)) expect(cellWidth(line)).toBeLessThanOrEqual(cols)
    }
    const ui = await pane($)
    const buttons = await ui.findAll({ type: 'Button' })
    await ui.unmount()
    expect(buttons.filter(b => b.key?.startsWith('cm-repo-')).length).toBe(3)
    expect(buttons.every(b => b.props['hotkey'] === undefined)).toBe(true)
  })
})

describe('commits mode: tree and diff pages', () => {
  const G = '/usr/bin/git'
  const FIND_LINE = '/usr/bin/find /w -maxdepth 4 ( -name node_modules -o -name Library -o -name .Trash -o -name .cache -o -path */.claude/worktrees ) -prune -o -name .git -print -prune'
  const R = '/w/a'
  const M = '1'.repeat(40)
  const F = '2'.repeat(40)
  const P = '3'.repeat(40)
  const B0 = '4'.repeat(40)
  const LOG = `${G} -C ${R} log --topo-order --decorate=full -n 40 --format=%H%x00%P%x00%an%x00%ct%x00%D%x00%s%x1e HEAD origin/main`
  const log = (first = "Merge branch 'feat-x'") =>
    `${M}\x00${P} ${F}\x00w\x00100\x00HEAD -> refs/heads/main\x00${first}\x1e\n` +
    `${F}\x00${B0}\x00w\x0090\x00\x00feat-x: 初版 很長很長很長很長很長很長很長很長很長很長很長很長的說明\x1e\n` +
    `${P}\x00${B0}\x00w\x0080\x00refs/remotes/origin/main\x00fix: 修正\x1e\n` +
    `${B0}\x00\x00w\x0070\x00tag: refs/tags/v1\x00init\x1e\n`
  const answers = (over: Record<string, Run> = {}): Record<string, Run> => ({
    [FIND_LINE]: { exitCode: 0, stdout: `${R}/.git\n` },
    [`${G} -C ${R} log -1 --decorate=full --format=%ct%x00%h%x00%D HEAD`]: { exitCode: 0, stdout: '100\x001111111\x00HEAD -> refs/heads/main\n' },
    [`${G} -C ${R} rev-parse --abbrev-ref --symbolic-full-name @{u}`]: { exitCode: 0, stdout: 'origin/main\n' },
    [LOG]: { exitCode: 0, stdout: log() },
    [`${G} -C ${R} rev-list origin/main..HEAD`]: { exitCode: 0, stdout: `${M}\n${F}\n` },
    [`${G} -C ${R} diff --numstat -z --no-renames ${P} ${M}`]: { exitCode: 0, stdout: '3\t1\tsvc/a.go\x001\t0\tREADME.md\x00' },
    [`${G} -C ${R} diff --no-color --no-renames ${P} ${M} -- svc/a.go`]: { exitCode: 0, stdout: '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n' },
    [`${G} -C ${R} diff --no-color --no-renames ${P} ${M} -- README.md`]: { exitCode: 0, stdout: '@@ -0,0 +1 @@\n+hi\n' },
    [`${G} -C ${R} diff --numstat -z --no-renames ${B0} ${F}`]: { exitCode: 0, stdout: '' },
    [`${G} -C ${R} show --numstat -z --no-renames --format= ${B0}`]: { exitCode: 0, stdout: '\n5\t0\tinit.txt\x00' },
    [`${G} -C ${R} show --no-color --no-renames --format= ${B0} -- init.txt`]: { exitCode: 0, stdout: '@@ -0,0 +1 @@\n+x\n' },
    ...over,
  })
  const setup = (on: On, git: Git = answers(), holdRun?: (argv: string[]) => Promise<void>) =>
    world(on, { git, ...(holdRun ? { holdRun } : {}) })
  const press = async ($: Engine, key: string, cols = 80) => {
    const ui = await pane($, cols)
    await ui.press({ key })
    await ui.unmount()
    await settle()
  }
  // draws until git has answered what the page asked
  const shown = async ($: Engine, cols = 80) => {
    for (let i = 0; i < 3; i += 1) {
      await drawn($, cols)
      await settle()
    }
    return (await drawn($, cols)).join('\n')
  }
  const toTree = async ($: Engine) => {
    await start($)
    await showChanges($)
    await press($, 'chg-mode-commits')
    await shown($)
    await press($, `cm-repo-${R}`)
    return shown($)
  }
  const logs = (w: { runs: string[][] }) => w.runs.filter(r => r.includes('--topo-order')).length

  test('a repo row opens its commit tree: lanes, HEAD node, ↑ for unpushed, refs and the 異動 tab still current', async ($, on) => {
    setup(on)
    const t = await toTree($)
    expect(t).toContain(`${COMMIT_ICON.head}─╮ 1111111↑ Merge branch 'feat-x'`)
    expect(t).toMatch(/│ ● 2222222↑ feat-x: 初版/)
    expect(t).toMatch(/● │ 3333333\s+fix: 修正/)
    expect(t).toMatch(/●─╯ 4444444\s+init/)
    expect(t).toContain(`${COMMIT_ICON.branch} main`)
    expect(t).toContain('origin/main')
    expect(t).toContain(`${COMMIT_ICON.tag} v1`)
    expect(t).toContain('4 commits')
    expect(t).toContain('↑2')
    const ui = await pane($)
    expect((await ui.find({ key: 'tab-changes' }))?.children).toEqual([
      expect.objectContaining({ type: 'Text', props: { bold: true, inverse: true, color: THEME.accent } }),
    ])
    expect((await ui.find({ key: 'back' }))?.text).toBe('返回')
    expect((await ui.find({ key: 'cm-refresh' }))?.text).toBe('重新整理')
    const buttons = await ui.findAll({ type: 'Button' })
    await ui.unmount()
    const keys = buttons.map(b => b.key)
    expect(keys.indexOf('cm-refresh')).toBeGreaterThanOrEqual(0)
    expect(keys.indexOf('cm-refresh')).toBeLessThan(keys.indexOf('back'))
    expect(buttons.filter(b => b.key?.startsWith('cm-commit-')).length).toBe(4)
    expect(buttons.every(b => b.props['hotkey'] === undefined)).toBe(true)
  })

  test("Desktop: a commit row's Button is its node through its sha; lanes before it, subject and age outside, the age at the row's end; a press opens it", async ($, on) => {
    setup(on)
    await toTree($)
    const rows = pressedRows(await deskTree($), 'cm-commit-')
    expect(rows).toHaveLength(4)
    for (const r of rows) {
      const node = [COMMIT_ICON.head, '●'].find(g => r.label.startsWith(g))
      expect(node).toBeDefined()
      expect(r.label).toMatch(/ \d{7}$/)
      expect(r.button.children?.every(k => typeof k === 'string' || k.type === 'Text')).toBe(true)
      expect(r.total).toBe(76)
      expect(r.kids.slice(r.at + 1).some(k => /^\d{7}$/.test(textOf(k)))).toBe(false)
      // the age is the row's last box, a spacer before it
      expect(r.kids.slice(r.at + 1).some(isSpacer)).toBe(true)
      expect(textOf(r.kids.at(-1) as Node)).toMatch(/^\d+[smhd]$/)
    }
    expect(rows.map(r => r.at)).toEqual([0, 1, 0, 0])
    // what follows the sha starts at the same cell in every row
    expect(new Set(rows.map(r => r.starts[r.at + 1])).size).toBe(1)
    await deskPress($, `cm-commit-${M}`)
    for (let i = 0; i < 3; i += 1) {
      await deskTree($)
      await settle()
    }
    expect(linesOf(await deskTree($)).join('\n')).toContain('1 / 2')
  })

  test("a commit opens its first file's diff against its first parent; ‹ › walk its files; 返回 goes to the tree, then the list", async ($, on) => {
    const w = setup(on)
    await toTree($)
    await press($, `cm-commit-${M}`)
    let t = await shown($)
    expect(t).toMatch(/1111111 Merge branch 'feat-x'\s+a/)
    expect(t).toMatch(/svc\/a\.go\s+\+3 −1/)
    expect(t).toContain('1 / 2')
    expect(t).toMatch(/2\s+\+new/)
    expect(w.runs.some(r => r.join(' ') === `${G} -C ${R} diff --no-color --no-renames ${P} ${M} -- svc/a.go`)).toBe(true)
    await press($, 'cdiff-prev')
    expect(await shown($)).toContain('1 / 2')
    await press($, 'cdiff-next')
    t = await shown($)
    expect(t).toContain('2 / 2')
    expect(t).toMatch(/1\s+\+hi/)
    await press($, 'cdiff-next')
    expect(await shown($)).toContain('2 / 2')
    const ui = await pane($)
    expect((await ui.find({ key: 'tab-changes' }))?.children).toEqual([
      expect.objectContaining({ type: 'Text', props: { bold: true, inverse: true, color: THEME.accent } }),
    ])
    await ui.unmount()
    await press($, 'back')
    expect(await shown($)).toContain('4 commits')
    await press($, 'back')
    expect(await shown($)).toContain('1 repos')
  })

  test('a root commit is shown whole; a commit changing no file says so', async ($, on) => {
    setup(on)
    await toTree($)
    await press($, `cm-commit-${B0}`)
    const t = await shown($)
    expect(t).toMatch(/init\.txt\s+\+5 −0/)
    expect(t).toMatch(/1\s+\+x/)
    await press($, 'back')
    await press($, `cm-commit-${F}`)
    expect(await shown($)).toContain('這個 commit 沒有改檔案')
  })

  test('the tree is asked once, again on 重新整理; opening the repo again while it loads asks no more', async ($, on) => {
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    let held = 0
    const w = setup(on, answers(), argv => (argv.includes('--topo-order') && held++ === 0 ? gate : Promise.resolve()))
    await start($)
    await showChanges($)
    await press($, 'chg-mode-commits')
    await shown($)
    await press($, `cm-repo-${R}`)
    await drawn($)
    expect((await drawn($)).join('\n')).toContain('讀取中…')
    await press($, 'back')
    await press($, `cm-repo-${R}`)
    await drawn($)
    expect(logs(w)).toBe(1)
    release()
    expect(await shown($)).toContain('4 commits')
    await shown($)
    expect(logs(w)).toBe(1)
    await press($, 'cm-refresh')
    await shown($)
    expect(logs(w)).toBe(2)
  })

  test("a repo whose log fails shows the error on its tree page; 返回 still works", async ($, on) => {
    setup(on, answers({ [LOG]: { exitCode: 128, stdout: '' } }))
    const t = await toTree($)
    expect(t).toContain('git log 失敗')
    await press($, 'back')
    expect(await shown($)).toContain('1 repos')
  })

  test('a /clear drops the tree git was still working out', async ($, on) => {
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    // the held log answers last: it marks the answer it is about to get as the stale one
    let staleNext = false
    const git = (argv: string[]): Run => {
      if (argv.join(' ') !== LOG) return answers()[argv.join(' ')] ?? { exitCode: 128, stdout: '' }
      const stale = staleNext
      staleNext = false
      return { exitCode: 0, stdout: log(stale ? 'stale' : "Merge branch 'feat-x'") }
    }
    let held = 0
    setup(on, git, argv =>
      argv.includes('--topo-order') && held++ === 0 ? gate.then(() => void (staleNext = true)) : Promise.resolve(),
    )
    await start($)
    await showChanges($)
    await press($, 'chg-mode-commits')
    await shown($)
    await press($, `cm-repo-${R}`)
    await drawn($)
    await $.classic.SessionStart({ source: 'clear' } as never)
    await drawn($)
    await settle()
    release()
    expect(await shown($)).toContain('1 repos')
    await press($, `cm-repo-${R}`)
    const t = await shown($)
    expect(t).toContain("Merge branch 'feat-x'")
    expect(t).not.toContain('stale')
  })

  test('a /clear on the tree or a commit diff goes back to the repo list', async ($, on) => {
    setup(on)
    await toTree($)
    await $.classic.SessionStart({ source: 'clear' } as never)
    let t = await shown($)
    expect(t).toContain('1 repos')
    expect(t).not.toContain('4 commits')
    await press($, `cm-repo-${R}`)
    await shown($)
    await press($, `cm-commit-${M}`)
    expect(await shown($)).toContain('1 / 2')
    await $.classic.SessionStart({ source: 'clear' } as never)
    t = await shown($)
    expect(t).toContain('1 repos')
    expect(t).not.toContain('1 / 2')
    expect(t).not.toContain('4 commits')
  })

  test("重新整理 on one repo's tree keeps another repo's tree git is still working out", async ($, on) => {
    const R2 = '/w/b'
    const LOG2 = `${G} -C ${R2} log --topo-order --decorate=full -n 40 --format=%H%x00%P%x00%an%x00%ct%x00%D%x00%s%x1e HEAD`
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    let held = 0
    const w = setup(
      on,
      answers({
        [FIND_LINE]: { exitCode: 0, stdout: `${R}/.git\n${R2}/.git\n` },
        [`${G} -C ${R2} log -1 --decorate=full --format=%ct%x00%h%x00%D HEAD`]: { exitCode: 0, stdout: '90\x004444444\x00HEAD -> refs/heads/main\n' },
        [LOG2]: { exitCode: 0, stdout: `${B0}\x00\x00w\x0070\x00HEAD -> refs/heads/main\x00b-init\x1e\n` },
      }),
      argv => (argv.join(' ') === LOG2 && held++ === 0 ? gate : Promise.resolve()),
    )
    const logs2 = () => w.runs.filter(r => r.join(' ') === LOG2).length
    await start($)
    await showChanges($)
    await press($, 'chg-mode-commits')
    await shown($)
    await press($, `cm-repo-${R2}`)
    await drawn($)
    expect(logs2()).toBe(1)
    await press($, 'back')
    await press($, `cm-repo-${R}`)
    expect(await shown($)).toContain('4 commits')
    await press($, 'cm-refresh')
    expect(await shown($)).toContain('4 commits')
    release()
    await settle()
    await press($, 'back')
    await press($, `cm-repo-${R2}`)
    expect(await shown($)).toContain('b-init')
    expect(logs2()).toBe(1)
  })

  test('long branch names never cut the graph or the sha, at 64 and 80 columns', async ($, on) => {
    const L1 = `feature/${'x'.repeat(32)}`
    const L2 = `release/${'y'.repeat(32)}`
    const long =
      `${M}\x00${P} ${F}\x00w\x00100\x00HEAD -> refs/heads/${L1}, refs/remotes/origin/${L1}\x00Merge branch 'feat-x'\x1e\n` +
      `${F}\x00${B0}\x00w\x0090\x00refs/heads/${L2}, refs/remotes/origin/${L2}\x00feat-x: 初版\x1e\n` +
      `${P}\x00${B0}\x00w\x0080\x00refs/remotes/origin/main\x00fix: 修正\x1e\n` +
      `${B0}\x00\x00w\x0070\x00tag: refs/tags/v1\x00init\x1e\n`
    setup(on, answers({ [LOG]: { exitCode: 0, stdout: long } }))
    await toTree($)
    for (const cols of [64, 80]) {
      await shown($, cols)
      const lines = await drawn($, cols)
      for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(cols)
      const t = lines.join('\n')
      expect(t).toContain(`${COMMIT_ICON.head}─╮ 1111111↑`)
      expect(t).toMatch(/│ ● 2222222↑/)
      expect(t).toMatch(/● │ 3333333/)
      expect(t).toMatch(/●─╯ 4444444/)
      expect(t).toContain(`${COMMIT_ICON.branch} feature/`)
      expect(t).toContain('…')
    }
  })

  test('the tree and diff pages fit 40, 60, 80 and 120 columns, long CJK subjects included', async ($, on) => {
    setup(on)
    await toTree($)
    for (const cols of [40, 60, 80, 120]) {
      await shown($, cols)
      for (const line of await drawn($, cols)) expect(cellWidth(line)).toBeLessThanOrEqual(cols)
    }
    await press($, `cm-commit-${M}`)
    for (const cols of [40, 60, 80, 120]) {
      await shown($, cols)
      for (const line of await drawn($, cols)) expect(cellWidth(line)).toBeLessThanOrEqual(cols)
    }
  })
})

describe('commits mode: remotes, sub-pages and fetch', () => {
  const G = '/usr/bin/git'
  const FIND_LINE = '/usr/bin/find /w -maxdepth 4 ( -name node_modules -o -name Library -o -name .Trash -o -name .cache -o -path */.claude/worktrees ) -prune -o -name .git -print -prune'
  const R = '/w/a'
  const H = '1'.repeat(40)
  const S = '5'.repeat(40)
  const LOG = `${G} -C ${R} log --topo-order --decorate=full -n 40 --format=%H%x00%P%x00%an%x00%ct%x00%D%x00%s%x1e HEAD`
  const REMOTES = `${G} -C ${R} remote -v`
  const BRANCHES = `${G} -C ${R} for-each-ref --sort=-committerdate --format=%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(objectname:short)%00%(HEAD)%00%(subject)%1e refs/heads refs/remotes`
  const STASHES = `${G} -C ${R} stash list --format=%H%x00%gd%x00%ct%x00%gs%x1e`
  const WORKTREES = `${G} -C ${R} worktree list --porcelain -z`
  const FETCH = `/usr/bin/env GIT_TERMINAL_PROMPT=0 ${G} -C ${R} -c core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=10 fetch --all --prune`
  const rec = (...f: string[]) => `${f.join('\x00')}\x1e\n`
  const answers = (over: Record<string, Run> = {}): Record<string, Run> => ({
    [FIND_LINE]: { exitCode: 0, stdout: `${R}/.git\n` },
    [`${G} -C ${R} log -1 --decorate=full --format=%ct%x00%h%x00%D HEAD`]: { exitCode: 0, stdout: '100\x001111111\x00HEAD -> refs/heads/main\n' },
    [`${G} -C ${R} symbolic-ref --short -q HEAD`]: { exitCode: 0, stdout: 'main\n' },
    [LOG]: { exitCode: 0, stdout: `${H}\x00\x00w\x00100\x00HEAD -> refs/heads/main\x00init\x1e\n` },
    [REMOTES]: { exitCode: 0, stdout: 'origin\tssh://git@git.example.io:2223/server/acme/a.git (fetch)\norigin\tssh://git@git.example.io:2223/server/acme/a.git (push)\n' },
    [`${G} -C ${R} rev-parse --git-common-dir`]: { exitCode: 0, stdout: '.git\n' },
    [BRANCHES]: {
      exitCode: 0,
      stdout:
        rec('refs/heads/main', 'origin/main', '', '100', '1111111', '*', 'init') +
        rec('refs/heads/feat', '', '', '90', '2222222', ' ', 'wip') +
        rec('refs/remotes/origin/main', '', '', '100', '1111111', ' ', 'init'),
    },
    [STASHES]: { exitCode: 0, stdout: rec(S, 'stash@{0}', '50', 'On main: 半成品') },
    [WORKTREES]: { exitCode: 0, stdout: `worktree ${R}\x00HEAD ${H}\x00branch refs/heads/main\x00\x00` },
    [`${G} -C ${R} status --porcelain=v1 -z --no-renames --untracked-files=normal`]: { exitCode: 0, stdout: ' M a.go\x00?? b.go\x00' },
    [FETCH]: { exitCode: 0, stdout: '' },
    ...over,
  })
  // FETCH_HEAD two hours before the clock's start
  const files = { [`${R}/.git/FETCH_HEAD`]: -7_200_000 }
  const setup = (on: On, git: Git = answers(), holdRun?: (argv: string[]) => Promise<void>, f: Record<string, number> = files) =>
    world(on, { git, files: f, ...(holdRun ? { holdRun } : {}) })
  const press = async ($: Engine, key: string, cols = 80) => {
    const ui = await pane($, cols)
    await ui.press({ key })
    await ui.unmount()
    await settle()
  }
  const shown = async ($: Engine, cols = 80) => {
    for (let i = 0; i < 3; i += 1) {
      await drawn($, cols)
      await settle()
    }
    return (await drawn($, cols)).join('\n')
  }
  const toTree = async ($: Engine) => {
    await start($)
    await showChanges($)
    await press($, 'chg-mode-commits')
    await shown($)
    await press($, `cm-repo-${R}`)
    return shown($)
  }
  const count = (w: { runs: string[][] }, line: string) => w.runs.filter(r => r.join(' ') === line).length
  const current = async ($: Engine, key: string) => {
    const ui = await pane($)
    const b = await ui.find({ key })
    await ui.unmount()
    return (b?.children ?? []).some(c => typeof c === 'object' && c !== null && (c as { props?: { inverse?: boolean } }).props?.inverse === true)
  }

  test('the tree page shows each remote and when it last fetched, the fetch press, and four sub-tabs with 提交 current', async ($, on) => {
    setup(on)
    const t = await toTree($)
    expect(t).toContain('origin')
    expect(t).toContain('server/acme/a.git')
    expect(t).toContain('fetch 2 小時前')
    for (const label of ['提交', '分支', 'Stash', 'Worktree']) expect(t).toContain(label)
    expect(t).toContain('init')
    expect(await current($, 'cm-view-log')).toBe(true)
    expect(await current($, 'cm-view-branches')).toBe(false)
    const ui = await pane($)
    expect((await ui.find({ key: 'cm-fetch' }))?.text).toBe('fetch')
    const buttons = await ui.findAll({ type: 'Button' })
    await ui.unmount()
    expect(buttons.every(b => b.props['hotkey'] === undefined)).toBe(true)
  })

  test('never fetched reads 從未 fetch; no remote reads 沒有 remote and offers no fetch', async ($, on) => {
    setup(on, answers({ [REMOTES]: { exitCode: 0, stdout: '' } }), undefined, {})
    const t = await toTree($)
    expect(t).toContain('沒有 remote')
    const ui = await pane($)
    expect(await ui.find({ key: 'cm-fetch' })).toBeUndefined()
    await ui.unmount()
  })

  test('a repo never fetched but with a remote reads 從未 fetch', async ($, on) => {
    setup(on, answers(), undefined, {})
    expect(await toTree($)).toContain('從未 fetch')
  })

  test('a sub-tab is asked of git the first time it is shown; its count shows once answered', async ($, on) => {
    const w = setup(on)
    let t = await toTree($)
    expect(t).not.toContain('分支 2')
    expect(count(w, BRANCHES)).toBe(0)
    await press($, 'cm-view-branches')
    t = await shown($)
    expect(await current($, 'cm-view-branches')).toBe(true)
    expect(t).toContain('分支 2')
    expect(t).toMatch(/◉ main/)
    expect(t).toMatch(/● feat\s+無 upstream/)
    expect(t).not.toContain('origin/main')
    await press($, 'cm-view-stash')
    t = await shown($)
    expect(t).toContain('Stash 1')
    expect(t).toContain('stash@{0}')
    expect(t).toContain('半成品')
    expect(t).toContain('stash 由這個 repo 的所有 worktree 共用')
    await press($, 'cm-view-worktrees')
    t = await shown($)
    expect(t).toContain('Worktree 1')
    expect(t).toMatch(/◉ a\s+\S+ main\s+±2/)
    await press($, 'cm-view-branches')
    await shown($)
    expect(count(w, BRANCHES)).toBe(1)
    expect(count(w, STASHES)).toBe(1)
    expect(count(w, WORKTREES)).toBe(1)
  })

  test('重新整理 asks again only the sub-page shown and the remotes', async ($, on) => {
    const w = setup(on)
    await toTree($)
    await press($, 'cm-view-branches')
    await shown($)
    await press($, 'cm-refresh')
    await shown($)
    expect(count(w, BRANCHES)).toBe(2)
    expect(count(w, REMOTES)).toBe(2)
    expect(count(w, LOG)).toBe(1)
  })

  test('fetch runs once with prompts off; while it runs it reads fetch 中…; after it the repo is asked again', async ($, on) => {
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    const w = setup(on, answers(), argv => (argv.join(' ') === FETCH ? gate : Promise.resolve()))
    await toTree($)
    await press($, 'cm-fetch')
    let t = await shown($)
    expect(t).toContain('fetch 中…')
    const ui = await pane($)
    expect(await ui.find({ key: 'cm-fetch' })).toBeUndefined()
    await ui.unmount()
    await press($, 'cm-refresh')
    expect(count(w, FETCH)).toBe(1)
    release()
    await settle()
    t = await shown($)
    expect(t).not.toContain('fetch 中…')
    expect(count(w, FETCH)).toBe(1)
    // once on opening, once on 重新整理 while it ran, once after it
    expect(count(w, LOG)).toBe(3)
    expect(w.runs.find(r => r.includes('fetch'))).toEqual([
      '/usr/bin/env', 'GIT_TERMINAL_PROMPT=0', G, '-C', R, '-c', 'core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=10', 'fetch', '--all', '--prune',
    ])
  })

  test('a failed fetch shows its last stderr line until 重新整理; one past its time reads fetch 逾時', async ($, on) => {
    let fetchAnswer: Run = { exitCode: 128, stderr: 'Fetching origin\nfatal: Could not read from remote repository.\n' }
    const git = (argv: string[]): Run => (argv.join(' ') === FETCH ? fetchAnswer : (answers()[argv.join(' ')] ?? { exitCode: 128, stdout: '' }))
    setup(on, git)
    await toTree($)
    await press($, 'cm-fetch')
    let t = await shown($)
    expect(t).toContain('fatal: Could not read from remote repository.')
    await press($, 'cm-refresh')
    t = await shown($)
    expect(t).not.toContain('fatal: Could not read from remote repository.')
    fetchAnswer = { exitCode: 0, throws: true }
    await press($, 'cm-fetch')
    expect(await shown($)).toContain('fetch 逾時')
  })

  test('重新整理 while git still works out the branches keeps only the answer asked after it', async ($, on) => {
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    // the held ask answers last: it marks the answer it is about to get as the stale one
    let staleNext = false
    const git = (argv: string[]): Run => {
      if (argv.join(' ') !== BRANCHES) return answers()[argv.join(' ')] ?? { exitCode: 128, stdout: '' }
      const stale = staleNext
      staleNext = false
      return { exitCode: 0, stdout: rec('refs/heads/main', '', '', '100', '1111111', '*', 'init') + rec(`refs/heads/${stale ? 'stale' : 'fresh'}`, '', '', '90', '2222222', ' ', 'x') }
    }
    let held = 0
    const w = setup(on, git, argv => (argv.join(' ') === BRANCHES && held++ === 0 ? gate.then(() => void (staleNext = true)) : Promise.resolve()))
    await toTree($)
    await press($, 'cm-view-branches')
    await drawn($)
    expect(count(w, BRANCHES)).toBe(1)
    await press($, 'cm-refresh')
    let t = await shown($)
    expect(count(w, BRANCHES)).toBe(2)
    expect(t).toContain('fresh')
    release()
    await settle()
    t = await shown($)
    expect(t).toContain('fresh')
    expect(t).not.toContain('stale')
    expect(count(w, BRANCHES)).toBe(2)
  })

  test('a fetch is given 60 seconds; once done the branches and stashes are asked again', async ($, on) => {
    const w = setup(on)
    await toTree($)
    await press($, 'cm-view-stash')
    await shown($)
    await press($, 'cm-view-branches')
    await shown($)
    expect(count(w, BRANCHES)).toBe(1)
    expect(count(w, STASHES)).toBe(1)
    await press($, 'cm-fetch')
    await shown($)
    expect(w.timeouts[w.runs.findIndex(r => r.join(' ') === FETCH)]).toBe(60_000)
    expect(w.timeouts[w.runs.findIndex(r => r.join(' ') === BRANCHES)]).toBe(5_000)
    expect(count(w, BRANCHES)).toBe(2)
    await press($, 'cm-view-stash')
    await shown($)
    expect(count(w, STASHES)).toBe(2)
  })

  const groupsSetup = (on: On) => {
    const longGone = `feature/gone-${'x'.repeat(60)}`
    const longAhead = `feature/ahead-${'y'.repeat(60)}`
    const longMerged = `feature/merged-${'z'.repeat(60)}`
    const fillers = Array.from({ length: 100 }, (_, i) => rec(`refs/heads/f${i}`, '', '', String(10 + i), '3333333', ' ', 'filler')).join('')
    return setup(
      on,
      answers({
        [BRANCHES]: {
          exitCode: 0,
          stdout:
            rec('refs/heads/main', 'origin/main', 'ahead 2, behind 3', '200', '1111111', '*', 'init') +
            rec(`refs/heads/${longGone}`, 'origin/gone', 'gone', '190', '2222222', ' ', 'wip') +
            rec(`refs/heads/${longAhead}`, `origin/${longAhead}`, 'ahead 4, behind 5', '180', '2222222', ' ', 'wip') +
            rec(`refs/heads/${longMerged}`, '', '', '170', '2222222', ' ', 'wip') +
            rec('refs/remotes/origin/main', '', '', '200', '1111111', ' ', 'init') +
            rec(`refs/remotes/origin/${longAhead}`, '', '', '180', '2222222', ' ', 'wip') +
            rec('refs/remotes/origin/only', '', '', '160', '4444444', ' ', 'theirs') +
            fillers,
        },
        [`${G} -C ${R} symbolic-ref -q --short refs/remotes/origin/HEAD`]: { exitCode: 0, stdout: 'origin/main\n' },
        [`${G} -C ${R} for-each-ref --merged=origin/main --format=%(refname) refs/heads refs/remotes`]: { exitCode: 0, stdout: `refs/heads/${longMerged}\n` },
      }),
    )
  }
  // the cell where `mark` starts on the first drawn line holding it
  const colOf = (lines: string[], mark: string) => {
    const line = lines.find(l => l.includes(mark)) ?? ''
    return cellWidth(line.slice(0, line.indexOf(mark)))
  }
  const GONE_SHUT = '▸ gone 1 個（遠端已刪，多半已 merge）'
  const GONE_OPEN = '▾ gone 1 個（遠端已刪，多半已 merge）'
  const REMOTE_SHUT = '▸ 只在遠端 1 個'
  const REMOTE_OPEN = '▾ 只在遠端 1 個'

  test('branch rows in groups: the current, 進行中, 只在遠端 and gone folded; ↑ ↓, 無 upstream, 已 merge; past a group\'s cap 還有 N 個分支; a long name is cut, its marks kept', async ($, on) => {
    groupsSetup(on)
    await toTree($)
    await press($, 'cm-view-branches')
    for (const cols of [30, 40, 60, 80, 120]) {
      await shown($, cols)
      const lines = await drawn($, cols, 200)
      for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(cols)
      const t = lines.join('\n')
      if (cols < 40) continue
      expect(t).toContain('分支 105')
      expect(t).toMatch(/◉ main\s+↑2 ↓3/)
      expect(t).toMatch(/● feature\/(ahead-y*)?…\s+↑4 ↓5/)
      expect(t).toMatch(/● feature\/(merged-z*)?…\s+無 upstream 已 merge/)
      expect(t).not.toMatch(/origin\/only/)
      expect(t).not.toMatch(/origin\/main/)
      expect(t).toContain('進行中 102')
      expect(t).toContain(REMOTE_SHUT)
      expect(t).toContain(cols < 60 ? '▸ gone 1 個' : GONE_SHUT)
      expect(t).not.toContain('feature/gone')
      expect(t).toContain('還有 2 個分支')
      expect(lines.findIndex(l => l.includes('◉ main'))).toBeLessThan(lines.findIndex(l => l.includes('進行中')))
      expect(lines.findIndex(l => l.includes('還有 2 個分支'))).toBeLessThan(lines.findIndex(l => l.includes(REMOTE_SHUT)))
      expect(lines.findIndex(l => l.includes(REMOTE_SHUT))).toBeLessThan(lines.findIndex(l => l.includes('▸ gone')))
    }
  })

  test('a short list keeps its names 12 wide, the status after them', async ($, on) => {
    setup(on)
    await toTree($)
    await press($, 'cm-view-branches')
    const lines = (await shown($, 80)).split('\n')
    expect(colOf(lines, '無 upstream') - colOf(lines, '● ')).toBe(2 + 12 + 1)
    expect(lines.find(l => l.includes('◉ main'))).toMatch(/◉ main {8} {12} init/)
  })

  test('the name and status columns line up: every status starts in the same cell', async ($, on) => {
    groupsSetup(on)
    await toTree($)
    await press($, 'cm-view-branches')
    await shown($)
    await press($, 'cm-branches-remote')
    for (const cols of [80, 120]) {
      await shown($, cols)
      const lines = await drawn($, cols, 200)
      const at = colOf(lines, '↑2 ↓3')
      expect(colOf(lines, '↑4 ↓5')).toBe(at)
      expect(colOf(lines, '無 upstream 已 merge')).toBe(at)
      expect(colOf(lines, 'origin/only')).toBe(colOf(lines, '◉ ') + 2)
      // 40% of the width at most: the long names are cut, their statuses whole
      expect(colOf(lines, '↑2 ↓3') - colOf(lines, '◉ ') - 2).toBeLessThanOrEqual(Math.floor(cols * 0.4) + 1)
    }
  })

  test('gone folded to one line: a press opens it, its rows listed with gone muted; another folds it; a sub-tab keeps it open', async ($, on) => {
    groupsSetup(on)
    await toTree($)
    await press($, 'cm-view-branches')
    let t = await shown($)
    expect(t).toContain(GONE_SHUT)
    await press($, 'cm-branches-gone')
    t = (await drawn($, 80, 200)).join('\n')
    expect(t).toContain(GONE_OPEN)
    expect(t).toMatch(/● feature\/gone-x*…\s+gone/)
    const ui = await pane($, 80, 200)
    const tree = (await ui.drawn()) as unknown as Node
    await ui.unmount()
    const goneTexts: Node[] = []
    const walk = (n: Node | string) => {
      if (typeof n === 'string') return
      if (n.type === 'Text' && textOf(n).trim() === 'gone') goneTexts.push(n)
      for (const k of n.children ?? []) walk(k)
    }
    walk(tree)
    expect(goneTexts.length).toBeGreaterThan(0)
    for (const n of goneTexts) expect(n.props?.['color']).toBe(THEME.muted)
    await press($, 'cm-view-log')
    await shown($)
    await press($, 'cm-view-branches')
    t = (await drawn($, 80, 200)).join('\n')
    expect(t).toContain(GONE_OPEN)
    await press($, 'cm-branches-gone')
    t = (await drawn($, 80, 200)).join('\n')
    expect(t).toContain(GONE_SHUT)
    expect(t).not.toContain('feature/gone')
  })

  test('只在遠端 folded to one line: a press opens it, its rows listed; another folds it; gone opens and folds apart from it', async ($, on) => {
    groupsSetup(on)
    await toTree($)
    await press($, 'cm-view-branches')
    let t = await shown($)
    expect(t).toContain(REMOTE_SHUT)
    expect(t).not.toContain('origin/only')
    await press($, 'cm-branches-remote')
    t = (await drawn($, 80, 200)).join('\n')
    expect(t).toContain(REMOTE_OPEN)
    expect(t).toMatch(/origin\/only\s+theirs/)
    expect(t).toContain(GONE_SHUT)
    await press($, 'cm-branches-gone')
    t = (await drawn($, 80, 200)).join('\n')
    expect(t).toContain(REMOTE_OPEN)
    expect(t).toContain(GONE_OPEN)
    await press($, 'cm-branches-remote')
    t = (await drawn($, 80, 200)).join('\n')
    expect(t).toContain(REMOTE_SHUT)
    expect(t).not.toContain('origin/only')
    expect(t).toContain(GONE_OPEN)
    await press($, 'cm-branches-remote')
    await press($, 'cm-view-log')
    await shown($)
    await press($, 'cm-view-branches')
    t = (await drawn($, 80, 200)).join('\n')
    expect(t).toContain(REMOTE_OPEN)
  })

  test('gone and 只在遠端 opened fold again when a repo is opened and on /clear', async ($, on) => {
    groupsSetup(on)
    await toTree($)
    await press($, 'cm-view-branches')
    await shown($)
    await press($, 'cm-branches-gone')
    await press($, 'cm-branches-remote')
    let t = (await drawn($, 80, 200)).join('\n')
    expect(t).toContain(GONE_OPEN)
    expect(t).toContain(REMOTE_OPEN)
    await press($, 'back')
    await shown($)
    await press($, `cm-repo-${R}`)
    await shown($)
    await press($, 'cm-view-branches')
    t = await shown($)
    expect(t).toContain(GONE_SHUT)
    expect(t).toContain(REMOTE_SHUT)
    await press($, 'cm-branches-gone')
    await press($, 'cm-branches-remote')
    t = (await drawn($, 80, 200)).join('\n')
    expect(t).toContain(GONE_OPEN)
    expect(t).toContain(REMOTE_OPEN)
    await $.classic.SessionStart({ source: 'clear' } as never)
    await shown($)
    await press($, `cm-repo-${R}`)
    await shown($)
    await press($, 'cm-view-branches')
    t = await shown($)
    expect(t).toContain(GONE_SHUT)
    expect(t).toContain(REMOTE_SHUT)
  })

  test('worktree rows: a long path is cut from its start, its marks kept; a pruned one cannot be pressed', async ($, on) => {
    const P = `/w/${'p'.repeat(70)}`
    const Q = `/w/${'q'.repeat(70)}`
    setup(
      on,
      answers({
        [WORKTREES]: {
          exitCode: 0,
          stdout:
            `worktree ${R}\x00HEAD ${H}\x00branch refs/heads/main\x00\x00` +
            `worktree ${P}\x00HEAD ${H}\x00branch refs/heads/b1\x00locked\x00\x00` +
            `worktree ${Q}\x00HEAD ${H}\x00branch refs/heads/b2\x00prunable gitdir file points to non-existent location\x00\x00`,
        },
        [`${G} -C ${P} status --porcelain=v1 -z --no-renames --untracked-files=normal`]: { exitCode: 0, stdout: ' M a\x00 M b\x00' },
      }),
    )
    await toTree($)
    await press($, 'cm-view-worktrees')
    for (const cols of [40, 80]) {
      await shown($, cols)
      const lines = await drawn($, cols)
      for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(cols)
      const t = lines.join('\n')
      expect(t).toMatch(/● …p+\s+\S+ b1 ±2 locked/)
      expect(t).toMatch(/● …q+\s+\S+ b2 已不存在/)
    }
    const ui = await pane($)
    expect(await ui.find({ key: `cm-wt-${P}` })).toBeDefined()
    expect(await ui.find({ key: `cm-wt-${Q}` })).toBeUndefined()
    await ui.unmount()
  })

  test('a stash gone from the list under its diff page shows the Stash tab with its remotes and fetch', async ($, on) => {
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    let stashes = rec(S, 'stash@{0}', '50', 'On main: 半成品')
    const git = (argv: string[]): Run =>
      argv.join(' ') === STASHES ? { exitCode: 0, stdout: stashes } : (answers()[argv.join(' ')] ?? { exitCode: 128, stdout: '' })
    setup(on, git, argv => (argv.join(' ') === FETCH ? gate : Promise.resolve()))
    await toTree($)
    await press($, 'cm-fetch')
    await press($, 'cm-view-stash')
    await shown($)
    await press($, `cm-stash-${S}`)
    expect(await shown($)).toMatch(/stash@\{0\} 半成品/)
    stashes = ''
    release()
    await settle()
    const t = await shown($)
    expect(await current($, 'cm-view-stash')).toBe(true)
    expect(t).toContain('沒有 stash')
    expect(t).toContain('server/acme/a.git')
    expect(t).not.toContain('讀取 remote 中…')
    const ui = await pane($)
    expect((await ui.find({ key: 'cm-fetch' }))?.text).toBe('fetch')
    await ui.unmount()
  })

  test('a commit gone from the tree under its diff page shows the tree with its remotes and fetch', async ($, on) => {
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    const H2 = '7'.repeat(40)
    let log = `${H}\x00\x00w\x00100\x00HEAD -> refs/heads/main\x00init\x1e\n`
    const git = (argv: string[]): Run =>
      argv.join(' ') === LOG ? { exitCode: 0, stdout: log } : (answers()[argv.join(' ')] ?? { exitCode: 128, stdout: '' })
    setup(on, git, argv => (argv.join(' ') === FETCH ? gate : Promise.resolve()))
    await toTree($)
    await press($, 'cm-fetch')
    await press($, `cm-commit-${H}`)
    expect(await shown($)).toMatch(/1111111 init/)
    log = `${H2}\x00\x00w\x00100\x00HEAD -> refs/heads/main\x00rewritten\x1e\n`
    release()
    await settle()
    const t = await shown($)
    expect(t).toContain('rewritten')
    expect(t).toContain('server/acme/a.git')
    expect(t).not.toContain('讀取 remote 中…')
    const ui = await pane($)
    expect((await ui.find({ key: 'cm-fetch' }))?.text).toBe('fetch')
    await ui.unmount()
  })

  test('a /clear while a fetch runs leaves it the only one for the repo; its answer is not kept after the /clear', async ($, on) => {
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    const w = setup(on, answers({ [FETCH]: { exitCode: 1, stderr: 'fatal: old fetch\n' } }), argv => (argv.join(' ') === FETCH ? gate : Promise.resolve()))
    await toTree($)
    await press($, 'cm-fetch')
    await shown($)
    await $.classic.SessionStart({ source: 'clear' } as never)
    await shown($)
    await press($, `cm-repo-${R}`)
    let t = await shown($)
    expect(t).toContain('fetch 中…')
    const ui = await pane($)
    const again = await ui.find({ key: 'cm-fetch' })
    if (again) await ui.press({ key: 'cm-fetch' })
    await ui.unmount()
    await settle()
    expect(again).toBeUndefined()
    expect(count(w, FETCH)).toBe(1)
    release()
    await settle()
    t = await shown($)
    expect(t).not.toContain('fetch 中…')
    expect(t).not.toContain('fatal: old fetch')
    const after = await pane($)
    expect((await after.find({ key: 'cm-fetch' }))?.text).toBe('fetch')
    await after.unmount()
  })

  test('a fetch done after a /clear still drops what the reopened repo read before it ended', async ($, on) => {
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    const w = setup(on, answers(), argv => (argv.join(' ') === FETCH ? gate : Promise.resolve()))
    await toTree($)
    await press($, 'cm-fetch')
    await shown($)
    await $.classic.SessionStart({ source: 'clear' } as never)
    await shown($)
    await press($, `cm-repo-${R}`)
    await shown($)
    await press($, 'cm-view-branches')
    await shown($)
    expect(count(w, BRANCHES)).toBe(1)
    expect(count(w, REMOTES)).toBe(2)
    release()
    await settle()
    const t = await shown($)
    expect(t).not.toContain('fetch 中…')
    expect(count(w, BRANCHES)).toBe(2)
    expect(count(w, REMOTES)).toBe(3)
  })

  describe('a repo with a linked worktree', () => {
    const WT = `${R}/.claude/worktrees/agent-x1`
    const WT_LIST = `worktree ${R}\x00HEAD ${H}\x00branch refs/heads/main\x00\x00worktree ${WT}\x00HEAD ${H}\x00branch refs/heads/wt\x00\x00`
    const WT_REMOTES = `${G} -C ${WT} remote -v`
    const WT_BRANCHES = `${G} -C ${WT} for-each-ref --sort=-committerdate --format=%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(objectname:short)%00%(HEAD)%00%(subject)%1e refs/heads refs/remotes`
    const WT_FETCH = FETCH.replace(`-C ${R}`, `-C ${WT}`)
    const SUMMARY = `${G} -C ${R} log -1 --decorate=full --format=%ct%x00%h%x00%D HEAD`
    const linked = () =>
      answers({
        [WORKTREES]: { exitCode: 0, stdout: WT_LIST },
        [`${G} -C ${WT} worktree list --porcelain -z`]: { exitCode: 0, stdout: WT_LIST },
        [`${G} -C ${WT} status --porcelain=v1 -z --no-renames --untracked-files=normal`]: { exitCode: 0, stdout: '' },
        [`${G} -C ${WT} log --topo-order --decorate=full -n 40 --format=%H%x00%P%x00%an%x00%ct%x00%D%x00%s%x1e HEAD`]: {
          exitCode: 0,
          stdout: `${H}\x00\x00w\x00100\x00HEAD -> refs/heads/wt\x00wt-commit\x1e\n`,
        },
        [WT_REMOTES]: answers()[REMOTES] as Run,
        [`${G} -C ${WT} rev-parse --git-common-dir`]: { exitCode: 0, stdout: `${R}/.git\n` },
        [WT_BRANCHES]: answers()[BRANCHES] as Run,
        [WT_FETCH]: { exitCode: 0, stdout: '' },
      })

    test("a fetch in a worktree drops its main repo's remotes, branches and list summary too", async ($, on) => {
      const w = setup(on, linked())
      await toTree($)
      await press($, 'cm-view-branches')
      await shown($)
      await press($, 'cm-view-worktrees')
      await shown($)
      expect(count(w, REMOTES)).toBe(1)
      expect(count(w, BRANCHES)).toBe(1)
      expect(count(w, SUMMARY)).toBe(1)
      await press($, `cm-wt-${WT}`)
      expect(await shown($)).toContain('wt-commit')
      await press($, 'cm-fetch')
      await shown($)
      expect(count(w, WT_FETCH)).toBe(1)
      await press($, 'back')
      await shown($)
      expect(await current($, 'cm-view-worktrees')).toBe(true)
      expect(count(w, REMOTES)).toBe(2)
      await press($, 'cm-view-branches')
      await shown($)
      expect(count(w, BRANCHES)).toBe(2)
      await press($, 'back')
      expect(await shown($)).toContain('1 repos')
      expect(count(w, SUMMARY)).toBe(2)
    })

    test("a fetch in the main repo drops a worktree's remotes and branches read before it", async ($, on) => {
      const w = setup(on, linked())
      await toTree($)
      await press($, 'cm-view-worktrees')
      await shown($)
      await press($, `cm-wt-${WT}`)
      await shown($)
      await press($, 'cm-view-branches')
      await shown($)
      expect(count(w, WT_REMOTES)).toBe(1)
      expect(count(w, WT_BRANCHES)).toBe(1)
      await press($, 'back')
      await shown($)
      await press($, 'cm-fetch')
      await shown($)
      expect(count(w, FETCH)).toBe(1)
      await press($, `cm-wt-${WT}`)
      await shown($)
      await press($, 'cm-view-branches')
      await shown($)
      expect(count(w, WT_REMOTES)).toBe(2)
      expect(count(w, WT_BRANCHES)).toBe(2)
    })
  })

  test('the sub-tab row fits 30, 40 and 60 columns gaps included, with and without counts', async ($, on) => {
    const branches = Array.from({ length: 154 }, (_, i) => rec(`refs/heads/b${i}`, '', '', String(1000 - i), '1111111', i === 0 ? '*' : ' ', 's')).join('')
    const stashes = Array.from({ length: 10 }, (_, i) => rec(i.toString(16).repeat(40), `stash@{${i}}`, '50', 'On main: x')).join('')
    const worktrees =
      `worktree ${R}\x00HEAD ${H}\x00branch refs/heads/main\x00\x00` +
      Array.from({ length: 11 }, (_, i) => `worktree /w/wt${i}\x00HEAD ${H}\x00branch refs/heads/b${i + 1}\x00\x00`).join('')
    setup(on, answers({ [BRANCHES]: { exitCode: 0, stdout: branches }, [STASHES]: { exitCode: 0, stdout: stashes }, [WORKTREES]: { exitCode: 0, stdout: worktrees } }))
    const tabs = async (cols: number) => {
      await shown($, cols)
      const ui = await pane($, cols)
      const row = rowWith((await ui.drawn()) as unknown as Node, 'cm-view-log')
      await ui.unmount()
      return { w: row ? widthOf(row) : Infinity, t: row ? textOf(row) : '' }
    }
    await toTree($)
    for (const cols of [30, 40, 60]) expect((await tabs(cols)).w).toBeLessThanOrEqual(cols - 4)
    for (const view of ['branches', 'stash', 'worktrees']) {
      await press($, `cm-view-${view}`)
      await shown($)
    }
    for (const cols of [30, 40, 60]) expect((await tabs(cols)).w).toBeLessThanOrEqual(cols - 4)
    const wide = await tabs(60)
    expect(wide.t).toContain('分支 154')
    expect(wide.t).toContain('Stash 10')
    expect(wide.t).toContain('Worktree 12')
  })
})

describe('commits mode: into a branch, a stash, a worktree', () => {
  const G = '/usr/bin/git'
  const FIND_LINE = '/usr/bin/find /w -maxdepth 4 ( -name node_modules -o -name Library -o -name .Trash -o -name .cache -o -path */.claude/worktrees ) -prune -o -name .git -print -prune'
  const R = '/w/a'
  const WT = `${R}/.claude/worktrees/agent-x1`
  const H = '1'.repeat(40)
  const F = '2'.repeat(40)
  const WH = '6'.repeat(40)
  const S = '5'.repeat(40)
  const FMT = '--format=%H%x00%P%x00%an%x00%ct%x00%D%x00%s%x1e'
  const LOG = `${G} -C ${R} log --topo-order --decorate=full -n 40 ${FMT} HEAD`
  const LOG_FEAT = `${G} -C ${R} log --topo-order --decorate=full -n 40 ${FMT} refs/heads/feat`
  const LOG_WT = `${G} -C ${WT} log --topo-order --decorate=full -n 40 ${FMT} HEAD`
  const rec = (...f: string[]) => `${f.join('\x00')}\x1e\n`
  const answers: Record<string, Run> = {
    [FIND_LINE]: { exitCode: 0, stdout: `${R}/.git\n` },
    [`${G} -C ${R} log -1 --decorate=full --format=%ct%x00%h%x00%D HEAD`]: { exitCode: 0, stdout: '100\x001111111\x00HEAD -> refs/heads/main\n' },
    [`${G} -C ${R} symbolic-ref --short -q HEAD`]: { exitCode: 0, stdout: 'main\n' },
    [`${G} -C ${WT} symbolic-ref --short -q HEAD`]: { exitCode: 0, stdout: 'wt\n' },
    [LOG]: { exitCode: 0, stdout: `${H}\x00\x00w\x00100\x00HEAD -> refs/heads/main\x00main-init\x1e\n` },
    [LOG_FEAT]: { exitCode: 0, stdout: `${F}\x00\x00w\x0090\x00refs/heads/feat\x00wip\x1e\n` },
    [LOG_WT]: { exitCode: 0, stdout: `${WH}\x00\x00w\x0080\x00HEAD -> refs/heads/wt\x00wt-commit\x1e\n` },
    [`${G} -C ${R} show --numstat -z --no-renames --format= ${F}`]: { exitCode: 0, stdout: '' },
    [`${G} -C ${R} remote -v`]: { exitCode: 0, stdout: '' },
    [`${G} -C ${R} for-each-ref --sort=-committerdate --format=%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(objectname:short)%00%(HEAD)%00%(subject)%1e refs/heads refs/remotes`]: {
      exitCode: 0,
      stdout: rec('refs/heads/main', '', '', '100', '1111111', '*', 'main-init') + rec('refs/heads/feat', '', '', '90', '2222222', ' ', 'wip'),
    },
    [`${G} -C ${R} stash list --format=%H%x00%gd%x00%ct%x00%gs%x1e`]: { exitCode: 0, stdout: rec(S, 'stash@{0}', '50', 'On main: 半成品') },
    [`${G} -C ${R} stash show --include-untracked --numstat -z --no-renames ${S}`]: { exitCode: 0, stdout: '1\t1\ta.go\x002\t0\tnew.txt\x00' },
    [`${G} -C ${R} ls-tree -r --name-only -z ${S}^3`]: { exitCode: 0, stdout: 'new.txt\x00' },
    [`${G} -C ${R} diff --no-color --no-renames ${S}^1 ${S} -- a.go`]: { exitCode: 0, stdout: '@@ -1 +1 @@\n-old\n+new\n' },
    [`${G} -C ${R} show --no-color --no-renames --format= ${S}^3 -- new.txt`]: { exitCode: 0, stdout: '@@ -0,0 +1,2 @@\n+x\n+y\n' },
    [`${G} -C ${R} worktree list --porcelain -z`]: {
      exitCode: 0,
      stdout:
        `worktree ${R}\x00HEAD ${H}\x00branch refs/heads/main\x00\x00` +
        `worktree ${WT}\x00HEAD ${WH}\x00branch refs/heads/wt\x00\x00` +
        `worktree /w/gone\x00HEAD ${'3'.repeat(40)}\x00detached\x00prunable gitdir file points to non-existent location\x00\x00`,
    },
    [`${G} -C ${R} status --porcelain=v1 -z --no-renames --untracked-files=normal`]: { exitCode: 0, stdout: '' },
    [`${G} -C ${WT} status --porcelain=v1 -z --no-renames --untracked-files=normal`]: { exitCode: 0, stdout: ' M x.go\x00' },
  }
  const setup = (on: On) => world(on, { git: answers })
  const press = async ($: Engine, key: string, cols = 80) => {
    const ui = await pane($, cols)
    await ui.press({ key })
    await ui.unmount()
    await settle()
  }
  const shown = async ($: Engine, cols = 80) => {
    for (let i = 0; i < 3; i += 1) {
      await drawn($, cols)
      await settle()
    }
    return (await drawn($, cols)).join('\n')
  }
  const toTree = async ($: Engine) => {
    await start($)
    await showChanges($)
    await press($, 'chg-mode-commits')
    await shown($)
    await press($, `cm-repo-${R}`)
    return shown($)
  }
  const current = async ($: Engine, key: string) => {
    const ui = await pane($)
    const b = await ui.find({ key })
    await ui.unmount()
    return (b?.children ?? []).some(c => typeof c === 'object' && c !== null && (c as { props?: { inverse?: boolean } }).props?.inverse === true)
  }

  test('a branch row opens its tree, logged by its ref and titled by its name, 提交 current; 返回 goes to 分支, then the list', async ($, on) => {
    const w = setup(on)
    await toTree($)
    await press($, 'cm-view-branches')
    await shown($)
    await press($, 'cm-branch-refs/heads/feat')
    let t = await shown($)
    expect(t).toContain('wip')
    expect(t).not.toContain('main-init')
    expect(t).toMatch(/\S+ feat/)
    expect(w.runs.some(r => r.join(' ') === LOG_FEAT)).toBe(true)
    expect(await current($, 'cm-view-log')).toBe(true)
    await press($, `cm-commit-${F}`)
    expect(await shown($)).toContain('這個 commit 沒有改檔案')
    await press($, 'back')
    expect(await shown($)).toContain('wip')
    await press($, 'back')
    t = await shown($)
    expect(await current($, 'cm-view-branches')).toBe(true)
    expect(t).toContain('feat')
    await press($, 'back')
    expect(await shown($)).toContain('1 repos')
  })

  test('a sub-tab pressed on a branch tree drops the branch', async ($, on) => {
    setup(on)
    await toTree($)
    await press($, 'cm-view-branches')
    await shown($)
    await press($, 'cm-branch-refs/heads/feat')
    await shown($)
    await press($, 'cm-view-log')
    const t = await shown($)
    expect(t).toContain('main-init')
    expect(t).not.toContain('wip')
  })

  test('a stash opens its diff: tracked files against its base, untracked ones whole; ‹ › walk; 返回 goes to Stash', async ($, on) => {
    const w = setup(on)
    await toTree($)
    await press($, 'cm-view-stash')
    await shown($)
    await press($, `cm-stash-${S}`)
    let t = await shown($)
    expect(t).toMatch(/stash@\{0\} 半成品/)
    expect(t).toMatch(/a\.go\s+\+1 −1/)
    expect(t).toContain('1 / 2')
    expect(t).toMatch(/1\s+\+new/)
    expect(await current($, 'tab-changes')).toBe(true)
    await press($, 'sdiff-next')
    t = await shown($)
    expect(t).toContain('2 / 2')
    expect(t).toMatch(/new\.txt\s+\+2 −0/)
    expect(w.runs.some(r => r.join(' ') === `${G} -C ${R} show --no-color --no-renames --format= ${S}^3 -- new.txt`)).toBe(true)
    await press($, 'sdiff-next')
    expect(await shown($)).toContain('2 / 2')
    await press($, 'sdiff-prev')
    t = await shown($)
    expect(t).toContain('1 / 2')
    expect(t).toMatch(/a\.go\s+\+1 −1/)
    await press($, 'sdiff-prev')
    expect(await shown($)).toContain('1 / 2')
    await press($, 'back')
    t = await shown($)
    expect(await current($, 'cm-view-stash')).toBe(true)
    expect(t).toContain('stash@{0}')
  })

  test("a worktree row opens that worktree's tree; 返回 goes to the first repo's Worktree tab; a pruned one cannot be pressed", async ($, on) => {
    const w = setup(on)
    await toTree($)
    await press($, 'cm-view-worktrees')
    let t = await shown($)
    expect(t).toMatch(/◉ a\s+\S+ main\s+乾淨/)
    expect(t).toMatch(/\.claude\/worktrees\/agent-x1\s+\S+ wt\s+±1\s+agent/)
    expect(t).toMatch(/\/w\/gone\s+detached 3333333\s+已不存在/)
    const ui = await pane($)
    expect(await ui.find({ key: 'cm-wt-/w/gone' })).toBeUndefined()
    await ui.unmount()
    await press($, `cm-wt-${WT}`)
    t = await shown($)
    expect(t).toContain('wt-commit')
    expect(w.runs.some(r => r.join(' ') === LOG_WT)).toBe(true)
    await press($, 'cm-view-branches')
    await shown($)
    await press($, 'back')
    t = await shown($)
    expect(await current($, 'cm-view-worktrees')).toBe(true)
    expect(t).toContain('agent-x1')
  })

  test("a branch opened in a worktree's tree: 返回 goes to the worktree's 分支, then the first repo's Worktree tab", async ($, on) => {
    const LOG_WT_FEAT = `${G} -C ${WT} log --topo-order --decorate=full -n 40 ${FMT} refs/heads/wt-feat`
    world(on, {
      git: {
        ...answers,
        [`${G} -C ${WT} for-each-ref --sort=-committerdate --format=%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(objectname:short)%00%(HEAD)%00%(subject)%1e refs/heads refs/remotes`]: {
          exitCode: 0,
          stdout: rec('refs/heads/wt', '', '', '80', '6666666', '*', 'wt-commit') + rec('refs/heads/wt-feat', '', '', '70', '7777777', ' ', 'wt-wip'),
        },
        [LOG_WT_FEAT]: { exitCode: 0, stdout: `${'7'.repeat(40)}\x00\x00w\x0070\x00refs/heads/wt-feat\x00wt-wip\x1e\n` },
      },
    })
    await toTree($)
    await press($, 'cm-view-worktrees')
    await shown($)
    await press($, `cm-wt-${WT}`)
    await shown($)
    await press($, 'cm-view-branches')
    await shown($)
    await press($, 'cm-branch-refs/heads/wt-feat')
    let t = await shown($)
    expect(t).toContain('wt-wip')
    await press($, 'back')
    t = await shown($)
    expect(await current($, 'cm-view-branches')).toBe(true)
    expect(t).toContain('wt-feat')
    await press($, 'back')
    t = await shown($)
    expect(await current($, 'cm-view-worktrees')).toBe(true)
    expect(t).toContain('.claude/worktrees/agent-x1')
    await press($, `cm-wt-${WT}`)
    await shown($)
    await press($, 'cm-view-branches')
    await shown($)
    await press($, 'cm-branch-refs/heads/wt-feat')
    await shown($)
    // a sub-tab pressed on that branch's tree drops the branch, not where the worktree goes back to
    await press($, 'cm-view-log')
    expect(await shown($)).toContain('wt-commit')
    await press($, 'back')
    await shown($)
    expect(await current($, 'cm-view-worktrees')).toBe(true)
  })

  test('a /clear on a stash diff goes back to the repo list', async ($, on) => {
    setup(on)
    await toTree($)
    await press($, 'cm-view-stash')
    await shown($)
    await press($, `cm-stash-${S}`)
    expect(await shown($)).toContain('1 / 2')
    await $.classic.SessionStart({ source: 'clear' } as never)
    const t = await shown($)
    expect(t).toContain('1 repos')
    expect(t).not.toContain('1 / 2')
  })
})
