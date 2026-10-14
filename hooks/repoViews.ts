// A repo's tree page shows one of these: its commits, its branches, its stashes or its worktrees.
export type RepoView = 'log' | 'branches' | 'stash' | 'worktrees'

export const MAX_BRANCHES = 100
export const MAX_REMOTES = 3

export type Remote = { name: string; url: string }

// `fetchedAt`: FETCH_HEAD's mtime, in ms; absent when the repo was never fetched
export type Remotes = { remotes: Remote[]; fetchedAt?: number }

// one `for-each-ref` record: the ref, its upstream (`%(upstream:short)`), how it tracks it,
// its last commit's time in ms, short sha and subject, and whether HEAD is on it
export type BranchRef = { ref: string; upstream: string; track: string; time: number; sha: string; head: boolean; subject: string }

export type Track = { ahead: number; behind: number; gone: boolean }

// `upstream`: a local branch with one set (gone or not); `merged`: in the main branch
export type BranchRow = {
  ref: string
  name: string
  kind: 'current' | 'local' | 'remote'
  upstream: boolean
  ahead: number
  behind: number
  gone: boolean
  merged: boolean
  time: number
  subject: string
}

// `mergeKnown`: the main branch was found, so `merged` says something
export type BranchList = { rows: BranchRow[]; more: number; total: number; mergeKnown: boolean }

// a stash by its commit, its `stash@{n}`, when it was made, the branch it was made on and its message
export type StashInfo = { sha: string; name: string; time: number; branch: string; message: string }

export type WorktreeInfo = { path: string; head: string; branch?: string; detached: boolean; locked: boolean; prunable: boolean; bare: boolean }

// `main`: the repo's own checkout, listed first; `agent`: a subagent's under .claude/worktrees;
// `dirty`: its uncommitted files, absent when git was not asked (pruned, bare) or failed
export type WorktreeRow = WorktreeInfo & { name: string; main: boolean; agent: boolean; dirty?: number }

export function shortRef(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length)
  if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length)
  return ref
}

// `remote -v`: each remote once, by its fetch line; anything after `(fetch)` (a partial
// clone's filter) is not the URL
export function parseRemotes(stdout: string): Remote[] {
  const out: Remote[] = []
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\t(\S+) \(fetch\)/.exec(line)
    const name = m?.[1]
    const url = m?.[2]
    if (name !== undefined && url !== undefined && !out.some(r => r.name === name)) out.push({ name, url })
  }
  return out
}

// `%(upstream:track,nobracket)`: empty, `ahead N`, `behind N`, `ahead N, behind M` or `gone`
export function parseTrack(s: string): Track {
  if (s.trim() === 'gone') return { ahead: 0, behind: 0, gone: true }
  const a = /ahead (\d+)/.exec(s)
  const b = /behind (\d+)/.exec(s)
  return { ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0, gone: false }
}

export function parseBranchRefs(stdout: string): BranchRef[] {
  return stdout.split('\x1e').flatMap(rec => {
    const f = rec.replace(/^\n+/, '').split('\x00')
    const [ref = '', upstream = '', track = '', ct = '', sha = '', head = '', ...subject] = f
    if (f.length < 7 || !ref.startsWith('refs/')) return []
    // a remote's HEAD only points at one of its branches
    if (/^refs\/remotes\/[^/]+\/HEAD$/.test(ref)) return []
    return [{ ref, upstream, track, time: Number(ct) * 1000 || 0, sha, head: head === '*', subject: subject.join(' ') }]
  })
}

// Local branches, and remote ones no local branch tracks; the current first, then by their
// last commit, newest first; at most MAX_BRANCHES, the rest counted.
export function branchRows(refs: readonly BranchRef[], merged: ReadonlySet<string> | undefined): BranchList {
  const tracked = new Set(refs.filter(r => r.ref.startsWith('refs/heads/') && r.upstream !== '').map(r => `refs/remotes/${r.upstream}`))
  const rows: BranchRow[] = []
  for (const r of refs) {
    const local = r.ref.startsWith('refs/heads/')
    if (!local && (!r.ref.startsWith('refs/remotes/') || tracked.has(r.ref))) continue
    rows.push({
      ref: r.ref,
      name: shortRef(r.ref),
      kind: r.head ? 'current' : local ? 'local' : 'remote',
      upstream: local && r.upstream !== '',
      ...parseTrack(r.track),
      merged: merged?.has(r.ref) ?? false,
      time: r.time,
      subject: r.subject,
    })
  }
  rows.sort(
    (a, b) =>
      Number(b.kind === 'current') - Number(a.kind === 'current') ||
      b.time - a.time ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
  return { rows: rows.slice(0, MAX_BRANCHES), more: Math.max(0, rows.length - MAX_BRANCHES), total: rows.length, mergeKnown: merged !== undefined }
}

// `stash list --format=%H%x00%gd%x00%ct%x00%gs%x1e`; `%gs` is `WIP on <branch>: <sha> <subject>`
// or `On <branch>: <message>` (a branch name holds no `:`)
export function parseStashes(stdout: string): StashInfo[] {
  return stdout.split('\x1e').flatMap(rec => {
    const f = rec.replace(/^\n+/, '').split('\x00')
    const [sha = '', name = '', ct = '', ...gs] = f
    if (f.length < 4 || !/^[0-9a-f]{7,}$/.test(sha)) return []
    const subject = gs.join(' ')
    const m = /^(?:WIP on|On) ([^:]*): ?(.*)$/s.exec(subject)
    return [{ sha, name, time: Number(ct) * 1000 || 0, branch: m?.[1] ?? '', message: m ? (m[2] ?? '') : subject }]
  })
}

// `worktree list --porcelain -z`: records ended by an empty field, `key value` fields
export function parseWorktrees(stdout: string): WorktreeInfo[] {
  return stdout.split('\x00\x00').flatMap(rec => {
    const fields = rec.split('\x00').filter(f => f !== '')
    const value = (k: string) => fields.find(f => f.startsWith(`${k} `))?.slice(k.length + 1)
    const has = (k: string) => fields.some(f => f === k || f.startsWith(`${k} `))
    const path = value('worktree')
    if (path === undefined) return []
    const branch = value('branch')
    return [
      {
        path,
        head: value('HEAD') ?? '',
        ...(branch !== undefined ? { branch: shortRef(branch) } : {}),
        detached: has('detached'),
        locked: has('locked'),
        prunable: has('prunable'),
        bare: has('bare'),
      },
    ]
  })
}

// `status --porcelain=v1 -z --no-renames`: one NUL-ended entry per file
export function countStatus(stdout: string): number {
  return stdout.split('\x00').filter(s => s !== '').length
}

// The repo's own checkout first by its directory's name, the others by their path under it
// (or whole when elsewhere), sorted by path.
export function worktreeRows(list: readonly WorktreeInfo[], dirty: ReadonlyMap<string, number>): WorktreeRow[] {
  const main = list[0]?.path ?? ''
  const rows = list.map((w, i): WorktreeRow => {
    const n = dirty.get(w.path)
    return {
      ...w,
      name: i === 0 ? w.path.slice(w.path.lastIndexOf('/') + 1) || w.path : w.path.startsWith(`${main}/`) ? w.path.slice(main.length + 1) : w.path,
      main: i === 0,
      agent: /\/\.claude\/worktrees\/agent-/.test(w.path),
      ...(n !== undefined ? { dirty: n } : {}),
    }
  })
  const [first, ...rest] = rows
  return first ? [first, ...rest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))] : []
}
