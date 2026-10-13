import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { JarvisChange } from '../types'
import { CREATED, dirOf, editOf, noteChange, relPath, repoName, repoOf, reposOf, tailCells } from '../hooks/changes'
import type { ChangesIo } from '../hooks/changes'
import { cellWidth } from '../hooks/jarvis'
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

// The engine beneath jarvis for the changes page: a fake disk (directories, files by
// mtime), git answering by argv (a map by argv joined with spaces, or a function), edit
// results by file path; what it was asked is logged in order.
export function world(
  on: On,
  opts: { dirs?: string[]; files?: Record<string, number>; git?: Git; results?: Record<string, unknown>; failWrites?: boolean; holdWrite?: (text: string) => Promise<void> | undefined } = {},
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
  mock.clock(on, { now: 0 })
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
    const input = e as { file_path?: string; notebook_path?: string }
    const r = opts.results?.[input.file_path ?? input.notebook_path ?? '']
    return { result: (typeof r === 'function' ? r(e) : (r ?? {})) as never }
  })
  on('fs.stat', async (_$, e) => {
    log.push(`stat:${e.path}`)
    if ((opts.dirs ?? []).includes(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    const m = files[e.path]
    if (m === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: 10, mtimeMs: m, isLink: false } }
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
    const a = answer([...e.argv])
    return { value: { exitCode: a.exitCode, stdout: a.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { log, writes, runs, opens, closes, files, changes: () => changes }
}

export const start = ($: Engine, cwd = '/w') => $.session.start({ cwd, surface: 'terminal', isInteractive: true })

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
