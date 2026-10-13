import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { JarvisChange } from '../types'
import { CREATED, bashPaths, dirOf, editOf, noteChange, parseGitdir, relPath, repoName, repoOf, reposOf, tailCells, worktreeOf } from '../hooks/changes'
import type { ChangesIo } from '../hooks/changes'
import { sessionGroups } from '../hooks/changesView'
import type { FileStat } from '../hooks/gitDiff'
import { BOOT_MS, cellWidth } from '../hooks/jarvis'
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

type Run = { exitCode: number; stdout?: string }
type Git = Record<string, Run> | ((argv: string[]) => Run)

type Node = { type?: string; props?: Record<string, unknown>; children?: (Node | string)[] }

const textOf = (n: Node | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''))

// One string per drawn row, a row's pieces joined with nothing between them.
const linesOf = (n: Node | string): string[] => {
  if (typeof n === 'string') return [n]
  if (n.type === 'Text' || n.type === 'Button' || n.props?.['flexDirection'] === 'row') return [textOf(n)]
  return (n.children ?? []).flatMap(linesOf)
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
    await opts.holdRun?.([...e.argv])
    const a = answer([...e.argv])
    return { value: { exitCode: a.exitCode, stdout: a.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { log, writes, runs, opens, closes, files, changes: () => changes }
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
