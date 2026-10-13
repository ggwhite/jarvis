import { describe, expect, test } from 'claude-code/testing'

import type { JarvisChange } from '../types'
import { CREATED, dirOf, editOf, noteChange, relPath, repoName, repoOf, reposOf, tailCells } from '../hooks/changes'
import type { ChangesIo } from '../hooks/changes'
import { cellWidth } from '../hooks/jarvis'

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
