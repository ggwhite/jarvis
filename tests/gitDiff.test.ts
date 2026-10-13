import { describe, expect, test } from 'claude-code/testing'

import type { ChangesIo } from '../hooks/changes'
import { GIT, isFailed, parseDiff, parseNumstat, pickTarget, sessionDiff, sessionStat, unpushedDiff, unpushedOf } from '../hooks/gitDiff'

type Out = { exitCode: number; stdout?: string }

// an io whose git answers by argv joined with spaces; anything else exits 128
const gitIo = (answers: Record<string, Out>, files: string[] = []): ChangesIo & { runs: string[][] } => {
  const runs: string[][] = []
  return {
    runs,
    stat: async path => (files.includes(path) ? { kind: 'file', size: 1, mtimeMs: 1 } : undefined),
    write: async () => true,
    run: async argv => {
      runs.push(argv)
      const a = answers[argv.join(' ')] ?? { exitCode: 128, stdout: '' }
      return { exitCode: a.exitCode, stdout: a.stdout ?? '', stderr: '' }
    },
  }
}

const DIFF = [
  'diff --git a/x b/x',
  'index 1..2 100644',
  '--- a/x',
  '+++ b/x',
  '@@ -3,3 +3,4 @@ func main() {',
  ' keep',
  '-old',
  '+new',
  '+more',
  ' tail',
  '\\ No newline at end of file',
  '',
].join('\n')

describe('parsing', () => {
  test('numstat rows, binary as 0 and flagged', () => {
    expect(parseNumstat('3\t1\ta.go\n-\t-\timg.png\n\n')).toEqual([
      { path: 'a.go', add: 3, del: 1, binary: false },
      { path: 'img.png', add: 0, del: 0, binary: true },
    ])
  })
  test('a unified diff becomes rows with line numbers', () => {
    expect(parseDiff(DIFF)).toEqual([
      { kind: 'hunk', text: '@@ -3,3 +3,4 @@ func main() {' },
      { kind: 'ctx', old: 3, new: 3, text: 'keep' },
      { kind: 'del', old: 4, text: 'old' },
      { kind: 'add', new: 4, text: 'new' },
      { kind: 'add', new: 5, text: 'more' },
      { kind: 'ctx', old: 5, new: 6, text: 'tail' },
      { kind: 'note', text: '\\ No newline at end of file' },
    ])
  })
  test('a deleted line starting with "--" stays a deletion', () => {
    expect(parseDiff('@@ -1 +0,0 @@\n--- not a header\n')).toEqual([
      { kind: 'hunk', text: '@@ -1 +0,0 @@' },
      { kind: 'del', old: 1, text: '-- not a header' },
    ])
  })
})

describe('session mode', () => {
  const change = { path: '/w/r/文件 夾/a.go', repo: '/w/r', orig: '/tmp/c/1.orig' }
  test('compares the cached original with the file, path passed as one argument', async () => {
    const io = gitIo({ [`${GIT} diff --no-index --numstat -- /tmp/c/1.orig /w/r/文件 夾/a.go`]: { exitCode: 1, stdout: '2\t1\t...\n' } }, [change.path])
    expect(await sessionStat(io, change)).toEqual({ add: 2, del: 1, binary: false, deleted: false, vsHead: false })
    expect(io.runs[0]).toEqual([GIT, 'diff', '--no-index', '--numstat', '--', '/tmp/c/1.orig', '/w/r/文件 夾/a.go'])
  })
  test('a file deleted since is compared with /dev/null', async () => {
    const io = gitIo({ [`${GIT} diff --no-index --numstat -- /tmp/c/1.orig /dev/null`]: { exitCode: 1, stdout: '0\t9\t...\n' } })
    expect(await sessionStat(io, change)).toEqual({ add: 0, del: 9, binary: false, deleted: true, vsHead: false })
  })
  test('an unknown original in a repo is compared with HEAD', async () => {
    const io = gitIo({ [`${GIT} -C /w/r diff --numstat --no-renames HEAD -- /w/r/文件 夾/a.go`]: { exitCode: 0, stdout: '4\t0\ta.go\n' } }, [change.path])
    expect(await sessionStat(io, { ...change, orig: '' })).toEqual({ add: 4, del: 0, binary: false, deleted: false, vsHead: true })
  })
  test('an unknown original outside git fails softly', async () => {
    expect(await sessionStat(gitIo({}), { path: '/tmp/a', repo: null, orig: '' })).toEqual({ error: '無原始內容' })
    expect(await sessionDiff(gitIo({}), { path: '/tmp/a', repo: null, orig: '' })).toEqual({ error: '無原始內容' })
  })
  test('git failing is an error, not a throw', async () => {
    const r = await sessionStat(gitIo({}, [change.path]), change)
    expect(isFailed(r)).toBe(true)
  })
  test('the diff of a created file is against /dev/null', async () => {
    const io = gitIo({ [`${GIT} diff --no-index --no-color -- /dev/null /w/r/n.go`]: { exitCode: 1, stdout: '@@ -0,0 +1 @@\n+x\n' } }, ['/w/r/n.go'])
    expect(await sessionDiff(io, { path: '/w/r/n.go', repo: '/w/r', orig: '/dev/null' })).toEqual([
      { kind: 'hunk', text: '@@ -0,0 +1 @@' },
      { kind: 'add', new: 1, text: 'x' },
    ])
  })
})

describe('unpushed mode', () => {
  const R = '/w/r'
  test('the target is origin/HEAD, else origin/main, else origin/master', async () => {
    expect(await pickTarget(gitIo({ [`${GIT} -C ${R} symbolic-ref -q --short refs/remotes/origin/HEAD`]: { exitCode: 0, stdout: 'origin/develop\n' } }), R)).toBe('origin/develop')
    expect(await pickTarget(gitIo({ [`${GIT} -C ${R} rev-parse -q --verify origin/master`]: { exitCode: 0, stdout: 'abc\n' } }), R)).toBe('origin/master')
    expect(await pickTarget(gitIo({}), R)).toBeUndefined()
  })
  test('lists commits ahead, the diff from the merge base and untracked files', async () => {
    const io = gitIo({
      [`${GIT} -C ${R} symbolic-ref -q --short refs/remotes/origin/HEAD`]: { exitCode: 0, stdout: 'origin/main\n' },
      [`${GIT} -C ${R} merge-base HEAD origin/main`]: { exitCode: 0, stdout: 'b4se\n' },
      [`${GIT} -C ${R} rev-list --count b4se..HEAD`]: { exitCode: 0, stdout: '2\n' },
      [`${GIT} -C ${R} diff --numstat -z --no-renames b4se`]: { exitCode: 0, stdout: '5\t1\tz.go\x001\t0\ta.go\x00' },
      [`${GIT} -C ${R} ls-files --others --exclude-standard -z`]: { exitCode: 0, stdout: 'new.go\x00' },
      [`${GIT} diff --no-index --numstat -- /dev/null ${R}/new.go`]: { exitCode: 1, stdout: '7\t0\t...\n' },
    })
    expect(await unpushedOf(io, R)).toEqual({
      target: 'origin/main',
      base: 'b4se',
      ahead: 2,
      files: [
        { path: `${R}/a.go`, add: 1, del: 0, binary: false, untracked: false },
        { path: `${R}/new.go`, add: 7, del: 0, binary: false, untracked: true },
        { path: `${R}/z.go`, add: 5, del: 1, binary: false, untracked: false },
      ],
    })
  })
  test('a repo without origin compares with HEAD and shows no commits ahead', async () => {
    const io = gitIo({
      [`${GIT} -C ${R} diff --numstat -z --no-renames HEAD`]: { exitCode: 0, stdout: '1\t1\ta.go\x00' },
      [`${GIT} -C ${R} ls-files --others --exclude-standard -z`]: { exitCode: 0, stdout: '' },
    })
    expect(await unpushedOf(io, R)).toEqual({ base: 'HEAD', ahead: 0, files: [{ path: `${R}/a.go`, add: 1, del: 1, binary: false, untracked: false }] })
  })
  test('a failing diff is an error', async () => {
    expect(await unpushedOf(gitIo({}), R)).toEqual({ error: 'git diff 失敗' })
  })
  test('a tracked file diffs from the base, an untracked one from /dev/null', async () => {
    const io = gitIo({
      [`${GIT} -C ${R} diff --no-color --no-renames b4se -- ${R}/a.go`]: { exitCode: 0, stdout: '@@ -1 +1 @@\n-a\n+b\n' },
      [`${GIT} diff --no-index --no-color -- /dev/null ${R}/new.go`]: { exitCode: 1, stdout: '@@ -0,0 +1 @@\n+n\n' },
    })
    expect(await unpushedDiff(io, R, 'b4se', { path: `${R}/a.go`, add: 1, del: 1, binary: false, untracked: false })).toHaveLength(3)
    expect(await unpushedDiff(io, R, 'b4se', { path: `${R}/new.go`, add: 1, del: 0, binary: false, untracked: true })).toHaveLength(2)
  })
  test('unquoted paths: Chinese, a space and a double quote reach git as the real pathspec', async () => {
    const mod = ['文件夾/說明.md', 'a b.txt', 'q"uote.go']
    const fresh = ['新檔.txt']
    const answers: Record<string, Out> = {
      [`${GIT} -C ${R} diff --numstat -z --no-renames HEAD`]: { exitCode: 0, stdout: mod.map(p => `1\t0\t${p}\0`).join('') },
      [`${GIT} -C ${R} ls-files --others --exclude-standard -z`]: { exitCode: 0, stdout: fresh.map(p => `${p}\0`).join('') },
      [`${GIT} diff --no-index --numstat -- /dev/null ${R}/新檔.txt`]: { exitCode: 1, stdout: '3\t0\t...\n' },
      [`${GIT} -C ${R} diff --no-color --no-renames HEAD -- ${R}/q"uote.go`]: { exitCode: 0, stdout: '@@ -1 +1 @@\n-a\n+b\n' },
    }
    const io = gitIo(answers)
    const r = await unpushedOf(io, R)
    if (isFailed(r)) throw new Error(r.error)
    expect(r.files.map(f => f.path).sort()).toEqual([...mod, ...fresh].map(p => `${R}/${p}`).sort())
    expect(r.files.find(f => f.path === `${R}/新檔.txt`)).toEqual({ path: `${R}/新檔.txt`, add: 3, del: 0, binary: false, untracked: true })
    const q = r.files.find(f => f.path === `${R}/q"uote.go`)!
    expect(await unpushedDiff(io, R, 'HEAD', q)).toHaveLength(3)
    expect(io.runs.at(-1)).toEqual([GIT, '-C', R, 'diff', '--no-color', '--no-renames', 'HEAD', '--', `${R}/q"uote.go`])
  })
})
