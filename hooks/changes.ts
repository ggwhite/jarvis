import type { JarvisChange } from '../types'
import { cellWidth, fitCells } from './jarvis'

export type ChangeMode = 'session' | 'unpushed'

// What the changes page asks of the machine: a hook in register.tsx builds it from its `$`.
export type ChangesIo = {
  stat: (path: string) => Promise<{ kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number } | undefined>
  read: (path: string) => Promise<string | undefined>
  write: (path: string, text: string) => Promise<boolean>
  run: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string } | undefined>
}

// What an edit tool's answer says it changed: the file, its content before the edit
// (null when the tool did not say), and whether the edit created it.
export type EditSeen = { path: string; original: string | null; created: boolean }

// A change's `orig` for a file the session created, and for one whose content before is unknown.
export const CREATED = '/dev/null'
export const UNKNOWN = ''

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

export function editOf(tool: string, result: unknown): EditSeen | undefined {
  if (!EDIT_TOOLS.has(tool) || typeof result !== 'object' || result === null) return undefined
  const r = result as Record<string, unknown>
  // a staged edit was held for review: the file is unchanged
  if (r['staged'] === true) return undefined
  if (tool === 'NotebookEdit') {
    const path = r['notebook_path']
    if (typeof path !== 'string' || typeof r['error'] === 'string' && r['error'] !== '') return undefined
    return { path, original: typeof r['original_file'] === 'string' ? r['original_file'] : null, created: false }
  }
  const path = r['filePath']
  if (typeof path !== 'string') return undefined
  if (tool === 'Write' && r['type'] === 'create') return { path, original: null, created: true }
  return { path, original: typeof r['originalFile'] === 'string' ? r['originalFile'] : null, created: false }
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

// The nearest directory above `file` holding a `.git` (a directory, or a worktree's file);
// null when there is none up to the root. Every directory walked is cached.
export async function repoOf(io: Pick<ChangesIo, 'stat'>, file: string, cache: Map<string, string | null>): Promise<string | null> {
  const walked: string[] = []
  let dir = dirOf(file)
  for (;;) {
    const hit = cache.get(dir)
    const found =
      hit !== undefined
        ? hit
        : await (async () => {
            const s = await io.stat(`${dir === '/' ? '' : dir}/.git`)
            return s !== undefined && (s.kind === 'dir' || s.kind === 'file') ? dir : undefined
          })()
    if (hit === undefined) walked.push(dir)
    if (found !== undefined || dir === '/') {
      const repo = found ?? null
      for (const d of walked) cache.set(d, repo)
      return repo
    }
    dir = dirOf(dir)
  }
}

// A linked worktree: the repo it was added from and its name under `.git/worktrees`.
export type Worktree = { mainRepo: string; name: string }

// The worktree a `.git` file's `gitdir: <main>/.git/worktrees/<name>` line names, a relative
// gitdir read from `repo`; undefined for anything else (a submodule's, say).
export function parseGitdir(text: string, repo: string): Worktree | undefined {
  const line = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1]
  if (line === undefined) return undefined
  const dir = absolutePath(line, repo, '')
  const m = dir === undefined ? null : /^(.*)\/\.git\/worktrees\/([^/]+)$/.exec(dir)
  if (!m) return undefined
  return { mainRepo: m[1] === '' ? '/' : (m[1] ?? '/'), name: m[2] ?? '' }
}

// The worktree `repo` is, by its `.git` file; undefined when `.git` is a directory or unread.
export async function worktreeOf(io: Pick<ChangesIo, 'read'>, repo: string): Promise<Worktree | undefined> {
  const text = await io.read(`${repo === '/' ? '' : repo}/.git`)
  return text === undefined ? undefined : parseGitdir(text, repo)
}

export function noteChange(
  list: readonly JarvisChange[],
  seen: { path: string; repo: string | null; actor: string; orig: string; worktree?: Worktree },
): JarvisChange[] {
  const i = list.findIndex(c => c.path === seen.path)
  if (i < 0) {
    const wt = seen.worktree ? { mainRepo: seen.worktree.mainRepo, worktree: seen.worktree.name } : {}
    return [...list, { path: seen.path, repo: seen.repo, actors: [seen.actor], seq: list.length, touches: 1, orig: seen.orig, ...wt }]
  }
  return list.map((c, j) =>
    j !== i ? c : { ...c, touches: c.touches + 1, actors: c.actors.includes(seen.actor) ? c.actors : [...c.actors, seen.actor] },
  )
}

export function reposOf(list: readonly JarvisChange[]): string[] {
  const out: string[] = []
  for (const c of list) if (c.repo !== null && !out.includes(c.repo)) out.push(c.repo)
  return out
}

export function repoName(repo: string | null, cwd: string, home: string): string {
  if (repo === null) return '(非 git)'
  if (repo === cwd) return '.'
  if (cwd !== '' && repo.startsWith(`${cwd}/`)) return repo.slice(cwd.length + 1)
  if (home !== '' && (repo === home || repo.startsWith(`${home}/`))) return `~${repo.slice(home.length)}`
  return repo
}

export function relPath(path: string, repo: string | null, home: string): string {
  if (repo !== null && path.startsWith(`${repo}/`)) return path.slice(repo.length + 1)
  if (home !== '' && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
  return path
}

// The end of `path` kept in `width` cells behind an ellipsis: `…/service/order.go`.
export function tailCells(path: string, width: number): string {
  if (cellWidth(path) <= width) return path
  if (width <= 1) return fitCells(path, width)
  const chars = [...path]
  let out = ''
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const next = `${chars[i]}${out}`
    if (cellWidth(next) + 1 > width) break
    out = next
  }
  return `…${out}`
}

const MAX_BASH_PATHS = 20
const SHELL_SEPARATORS = new Set(['&&', '||', ';', '|', '&', '(', ')'])

// A shell line's words, quotes taken off; `&&`, `||`, `;`, `|`, `&`, `(` and `)` each a word
// of their own, a newline a `;`.
function shellWords(command: string): string[] {
  const out: string[] = []
  let word = ''
  let inWord = false
  const end = () => {
    if (inWord) out.push(word)
    word = ''
    inWord = false
  }
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? ''
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1)
      const stop = close < 0 ? command.length : close
      word += command.slice(i + 1, stop)
      inWord = true
      i = stop
    } else if (ch === '\\' && i + 1 < command.length) {
      word += command[i + 1]
      inWord = true
      i += 1
    } else if (ch === '\n') {
      end()
      out.push(';')
    } else if (/\s/.test(ch)) {
      end()
    } else if ('&|;()'.includes(ch)) {
      end()
      const two = command.slice(i, i + 2)
      if (two === '&&' || two === '||') {
        out.push(two)
        i += 1
      } else out.push(ch)
    } else {
      word += ch
      inWord = true
    }
  }
  end()
  return out
}

// `path` made absolute against `base`, `~` against `home`, `.` and `..` folded; undefined
// for a `~` with no home and for another user's `~name`.
function absolutePath(path: string, base: string, home: string): string | undefined {
  let full: string
  if (path === '~' || path.startsWith('~/')) {
    if (home === '') return undefined
    full = `${home}${path.slice(1)}`
  } else if (path.startsWith('~')) return undefined
  else full = path.startsWith('/') ? path : `${base}/${path}`
  const parts: string[] = []
  for (const p of full.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return `/${parts.join('/')}`
}

// Words that look like paths but are not: a redirection (`2>/dev/null`), an scp-style
// remote (`git@host:a/b`), a sed expression (`s/x/y/g`).
const NOT_PATH = [/[<>]/, /^[^/]*@[^/:]*:/, /^s\/[^/]*\/[^/]*\/[a-zA-Z0-9]*$/]
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

const looksLikePath = (word: string) =>
  !word.includes('://') && (word.includes('/') || word.startsWith('~') || word.startsWith('.')) && !NOT_PATH.some(r => r.test(word))

// The paths under `root` (itself included) a Bash line run in `cwd` may touch: the
// directories of `cd`, `pushd` and `git -C`, and every other word that looks like a path.
// A relative path after `cd X` on the line is read from X. Leading `VAR=…` and `env …`
// are passed over to find the command. At most MAX_BASH_PATHS, each once.
export function bashPaths(command: string, cwd: string, home = '', root = cwd): string[] {
  const out: string[] = []
  if (cwd === '' || root === '') return out
  let base = cwd
  let head = ''
  let prev = ''
  // the next word that is not an option is cd's directory
  let cdDir = false
  for (const word of shellWords(command)) {
    if (out.length >= MAX_BASH_PATHS) break
    if (SHELL_SEPARATORS.has(word)) {
      head = ''
      prev = word
      cdDir = false
      continue
    }
    if ((head === '' || head === 'env') && (ASSIGNMENT.test(word) || word === 'env' || (head === 'env' && word.startsWith('-')))) {
      if (word === 'env') head = 'env'
      prev = word
      continue
    }
    const atHead = head === '' || head === 'env'
    if (atHead) {
      head = word
      cdDir = word === 'cd' || word === 'pushd'
      prev = word
      if (cdDir) continue
    }
    const isCd = cdDir && !word.startsWith('-')
    const dirArg = isCd || (!atHead && /(^|\/)git$/.test(head) && prev === '-C')
    if (isCd) cdDir = false
    prev = word
    if (word.startsWith('-') || (!dirArg && !looksLikePath(word))) continue
    const path = absolutePath(word, base, home)
    if (path === undefined) continue
    if (isCd) base = path
    if ((path === root || path.startsWith(`${root}/`)) && !out.includes(path)) out.push(path)
  }
  return out
}
