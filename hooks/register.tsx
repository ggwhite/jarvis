import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { FleetJumpError, FleetQuota, JarvisAgent, JarvisPage, JarvisUi } from '../types'

import {
  ANIM_MS,
  IDLE_MS,
  LIST_FAILS_MAX,
  SEEN_MS,
  SPINNER,
  addAgent,
  bootStage,
  addEvent,
  buildCockpit,
  describeCall,
  healthOfState,
  finishTurn,
  markStale,
  needsReconcile,
  noteTool,
  reconcileAgents,
  runningOf,
  scanFrame,
  tickMs,
  MAIN_ACTOR,
  MAIN_SOURCE,
} from './jarvis'
import type { Completion, EngineAgent } from './jarvis'
import { drawCockpit } from './cockpit'
import { RUN_TIMEOUT_MS, createReporter, jarvisText, inHerdr } from './herdr'
import type { Reporter } from './herdr'
import { parseQuota } from './fleet'
import { SUIT_REST_TICK_MS } from './suit'
import { EMPTY_FLEET, FLEET_MS, FLEET_RUN_TIMEOUT_MS, LIMITS_PATH, focusArgv, refreshFleet, withJump } from './fleetSource'
import type { FleetIo } from './fleetSource'
import type { JarvisChange } from '../types'
import { CREATED, UNKNOWN, bashPaths, editOf, noteChange, repoOf, reposOf, worktreeOf } from './changes'
import type { ChangeMode, ChangesIo, EditSeen, Worktree } from './changes'
import { isFailed, sessionDiff, sessionStat, unpushedDiff, unpushedOf } from './gitDiff'
import type { DiffRow, Failed, FileStat, Unpushed, UnpushedFile } from './gitDiff'
import { MAX_LISTED, sessionGroups, unpushedGroups } from './changesView'
import type { ChangesView } from './changesView'
import { commitFileDiff, commitFiles, commitTreeOf, findRepos, repoSummary } from './gitCommits'
import type { CommitFile, CommitTree, RepoSummary } from './gitCommits'
import { commitRepoName, repoRows } from './commitsView'
import type { CommitsCtx, RepoList } from './commitsView'
import { FETCH_TIMEOUT_MS, branchesOf, fetchRepo, remotesOf, stashFileDiff, stashFiles, stashesOf, worktreesOf } from './gitRepo'
import type { StashFile } from './gitRepo'
import type { BranchList, Remotes, RepoView, StashInfo, WorktreeRow } from './repoViews'

const PANE = 'jarvis'
const MAX_EARLY = 100
// the fleet page counts as in view a poll period past SEEN_MS: a drawing that lands after
// the next tick does not stop the poll
const FLEET_SEEN_MS = SEEN_MS + FLEET_MS
// the standby suit reads the usagebar cache at most this often
const QUOTA_EVERY_MS = 30_000
// git and the cache writes the changes page runs, each given this long
const CHANGES_RUN_TIMEOUT_MS = 5_000
// the changes page reads its files' mtimes at most this often while drawn
const CHANGES_SCAN_MS = 2_000
// the commits mode's repo list redraws after this many repos answer, and once all have
const COMMITS_REDRAW_EVERY = 8

const agents = atom({ plugin: 'jarvis', key: 'agents' } as const, [])
const main = atom({ plugin: 'jarvis', key: 'main' } as const, {
  model: '',
  chain: 0,
  ok: 0,
  fail: 0,
  lastTool: '',
  lastDesc: '',
  isRunning: false,
  runSince: 0,
  toolCounts: {},
})
const events = atom({ plugin: 'jarvis', key: 'events' } as const, [])
const inflight = atom({ plugin: 'jarvis', key: 'inflight' } as const, [])
const tick = atom({ plugin: 'jarvis', key: 'tick' } as const, { n: 0, now: 0 })
const ui = atom({ plugin: 'jarvis', key: 'ui' } as const, {
  page: 'now',
  agentId: '',
  paused: false,
  pausedTotal: 0,
  paneId: '',
})
const eventTotal = atom({ plugin: 'jarvis', key: 'eventTotal' } as const, 0)
const fleet = atom({ plugin: 'jarvis', key: 'fleet' } as const, EMPTY_FLEET)
const fleetCursor = atom({ plugin: 'jarvis', key: 'fleetCursor' } as const, {})
const standbyQuota = atom({ plugin: 'jarvis', key: 'standbyQuota' } as const, null as FleetQuota | null)
const suit = atom({ plugin: 'jarvis', key: 'suit' } as const, { n: 0 })
const changes = atom({ plugin: 'jarvis', key: 'changes' } as const, [] as JarvisChange[])

// Tool calls that last as long as the agents they start, whose own calls are tracked:
// counting them in flight would hide a stuck subagent.
const UNTRACKED = new Set(['Agent', 'Workflow'])

// The changes page's hands on the machine, from a hook's own `$`; a failure reads as nothing.
export function ioOf($: Pick<EngineInterface, 'fs' | 'process'>, timeoutMs = CHANGES_RUN_TIMEOUT_MS): ChangesIo {
  return {
    stat: async path => {
      try {
        const s = await $.fs.stat(path)
        return { kind: s.kind, size: s.size, mtimeMs: s.mtimeMs }
      } catch {
        return undefined
      }
    },
    read: async path => {
      try {
        const t = await $.fs.read(path)
        return typeof t === 'string' ? t : undefined
      } catch {
        return undefined
      }
    },
    write: async (path, text) => {
      try {
        await $.fs.write(path, text)
        return true
      } catch {
        return false
      }
    },
    run: async argv => {
      try {
        const r = await $.process.run(argv, { timeoutMs })
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
      } catch {
        return undefined
      }
    },
  }
}

// A file's `orig` the first time an edit to it is seen: the record's own when it already
// has one, else its content before cached under `cacheDir`.
async function firstOrig($: Pick<EngineInterface, 'fs' | 'process' | 'state'>, seen: EditSeen, cacheDir: string): Promise<string> {
  try {
    const had = (await read($, changes)).find(c => c.path === seen.path)?.orig
    if (had !== undefined) return had
    if (seen.created) return CREATED
    if (seen.original === null || cacheDir === '') return UNKNOWN
    const file = `${cacheDir}/${crypto.randomUUID()}.orig`
    return (await ioOf($).write(file, seen.original)) ? file : UNKNOWN
  } catch {
    return UNKNOWN
  }
}

// Records what an edit tool changed: its original cached under `cacheDir` the first time
// the file is seen, its repo (and the repo a worktree was added from, `worktrees` caching
// each repo's), and who changed it. The first edit to reach here owns the file's original:
// `origs` holds it from before any await, so a later edit only joins.
async function recordChange(
  $: Pick<EngineInterface, 'fs' | 'process' | 'state'>,
  tool: string,
  result: unknown,
  actor: string,
  cacheDir: string,
  repoCache: Map<string, string | null>,
  origs: Map<string, Promise<string>>,
  worktrees: Map<string, Worktree | null>,
): Promise<void> {
  try {
    const seen = editOf(tool, result)
    if (!seen) return
    let first = origs.get(seen.path)
    if (first === undefined) {
      first = firstOrig($, seen, cacheDir)
      origs.set(seen.path, first)
    }
    const orig = await first
    const io = ioOf($)
    const repo = await repoOf(io, seen.path, repoCache)
    let worktree: Worktree | null = null
    if (repo !== null) {
      const hit = worktrees.get(repo)
      worktree = hit !== undefined ? hit : ((await worktreeOf(io, repo)) ?? null)
      worktrees.set(repo, worktree)
    }
    await update($, changes, l => noteChange(l, { path: seen.path, repo, actor, orig, ...(worktree ? { worktree } : {}) }))
  } catch {
    // the edit itself already happened
  }
}

// What the changes page keeps between drawings: what git last said of each changed file,
// by the file's mtime, size and edit count; whether git is being asked; the files'
// signatures as last read, at most once per CHANGES_SCAN_MS while drawn; `gen` counts the
// resets, so git still answering for the last session stores nothing. The unpushed mode
// keeps what git said of each touched repo, asked on entering the mode and on 重新整理;
// `unpushedGen` counts the drops, so an answer to an older ask stores nothing. The diff
// page: what each listed file's key stands for, each key's diff by the signature it was
// taken at, and the key git is diffing; `gen` drops those too. `bashRepos`: the repos
// the session's Bash calls touched, listed in the unpushed mode beside the recorded ones.
// `gone`: the changed files and repo roots the last read found missing. `unpushedLive`:
// whether each touched repo was still on disk when the unpushed mode first listed it.
type ChangesCache = {
  stats: Map<string, { sig: string; stat: FileStat | Failed }>
  busy: boolean
  gen: number
  sigs: Map<string, string>
  gone: Set<string>
  scannedAt: number
  unpushed: Map<string, Unpushed | Failed>
  unpushedLive: Map<string, boolean>
  unpushedBusy: boolean
  unpushedGen: number
  opened: Map<string, Opened>
  diffs: Map<string, { sig: string; rows: DiffRow[] | Failed }>
  diffBusy: string
  bashRepos: Set<string>
}

type Opened =
  | { mode: 'session'; change: JarvisChange }
  | { mode: 'unpushed'; repo: string; base: string; file: UnpushedFile }

// Notes the repos a Bash line run in `shell` touched: `shell` itself when it is below the
// session's `cwd` (a bare `touch a.txt` names no path), and each path under `cwd` the line
// names that exists, a file standing for its directory. A reset while it looks stores nothing.
async function recordBash(
  $: Pick<EngineInterface, 'fs' | 'process'>,
  command: unknown,
  shell: string,
  names: { cwd: string; home: string },
  cache: ChangesCache,
  repoCache: Map<string, string | null>,
): Promise<void> {
  try {
    if (typeof command !== 'string') return
    const gen = cache.gen
    const io = ioOf($)
    const paths = bashPaths(command, shell, names.home, names.cwd)
    if (names.cwd !== '' && shell.startsWith(`${names.cwd}/`) && !paths.includes(shell)) paths.unshift(shell)
    for (const path of paths) {
      const s = await io.stat(path)
      if (s === undefined) continue
      // repoOf walks up from the directory holding its argument
      const repo = await repoOf(io, s.kind === 'dir' ? `${path}/` : path, repoCache)
      if (repo !== null && cache.gen === gen) cache.bashRepos.add(repo)
    }
  } catch {
    // the call itself already ran
  }
}

// forgets the unpushed answers and the diffs of unpushed files, those still coming
// included: the next drawing asks git again
const dropUnpushed = (cache: ChangesCache) => {
  cache.unpushedGen += 1
  cache.unpushedBusy = false
  cache.unpushed.clear()
  cache.unpushedLive.clear()
  for (const key of [...cache.diffs.keys()]) if (key.startsWith('u:')) cache.diffs.delete(key)
  if (cache.diffBusy.startsWith('u:')) cache.diffBusy = ''
}

// What the commits mode keeps between drawings: the repos found under the session
// directory (or why none), each repo's summary as git gave it, and whether find or git is
// being asked; `gen` counts the drops, so an answer to an older ask stores nothing.
// `answers`: each tree (`t\x00repo`), commit's files (`f\x00repo\x00sha`) and file diff
// (`d\x00repo\x00sha\x00path`) as git gave it; `asking`: those keys git is being asked.
// A fetch runs at most once a repo at a time, a drop or not; its failure is kept until the next
// fetch or 重新整理.
type CommitsCache = {
  gen: number
  // each repo's own drops: an answer about a repo dropped since it was asked stores nothing
  repoGen: Map<string, number>
  repos: string[] | Failed | undefined
  scanning: boolean
  summaries: Map<string, RepoSummary | Failed>
  answers: Map<string, unknown>
  asking: Set<string>
  // each key's own drops (重新整理 on a sub-page): an answer to a key dropped since asked stores nothing
  keyGen: Map<string, number>
  // the repos a fetch is running for (kept by a drop: the fetch still runs), and why each one's
  // last fetch failed
  fetching: Set<string>
  fetchError: Map<string, string>
}

const dropCommits = (cc: CommitsCache) => {
  cc.gen += 1
  cc.repos = undefined
  cc.scanning = false
  cc.summaries.clear()
  cc.answers.clear()
  cc.asking.clear()
  cc.fetchError.clear()
}

// forgets one repo's summary, tree, files and diffs: the next drawing asks git again; an
// ask about it still running is dropped (and asked again if still wanted), other repos' kept
const dropCommitRepo = (cc: CommitsCache, repo: string) => {
  cc.repoGen.set(repo, (cc.repoGen.get(repo) ?? 0) + 1)
  cc.summaries.delete(repo)
  const ofRepo = (key: string) => key.split('\x00')[1] === repo
  for (const key of [...cc.answers.keys()]) if (ofRepo(key)) cc.answers.delete(key)
  for (const key of [...cc.asking]) if (ofRepo(key)) cc.asking.delete(key)
}

// what 重新整理 on each sub-page asks again: its own keys and the remotes (the commits page
// also its commits' files and diffs, the stash page its stashes' files and diffs)
const REFRESH_KINDS: Record<RepoView, readonly string[]> = {
  log: ['t', 'f', 'd', 'r'],
  branches: ['b', 'r'],
  stash: ['s', 'sf', 'sd', 'r'],
  worktrees: ['w', 'r'],
}

// forgets a repo's keys of these kinds, those git is still working out included
const dropCommitKeys = (cc: CommitsCache, repo: string, kinds: readonly string[]) => {
  const hit = (key: string) => {
    const [kind = '', r] = key.split('\x00')
    return r === repo && kinds.includes(kind)
  }
  for (const key of new Set([...cc.answers.keys(), ...cc.asking])) {
    if (!hit(key)) continue
    cc.answers.delete(key)
    cc.asking.delete(key)
    cc.keyGen.set(key, (cc.keyGen.get(key) ?? 0) + 1)
  }
}

// What a worktree's tree keeps for its 返回: `back` when it leads to another repo (the worktree
// was opened from there), else the one a branch opened in that worktree carries; none otherwise.
const worktreeBack = (back: JarvisUi['repoBack'], repo: string | undefined): JarvisUi['repoBack'] => {
  if (back === undefined) return undefined
  if (back.repo !== repo) return { repo: back.repo, view: back.view }
  return back.back
}

// what git last said of `key`, counted; undefined until it has answered, or when it failed
function countOf<T>(cc: CommitsCache, key: string, n: (x: T) => number): number | undefined {
  const hit = cc.answers.get(key) as T | Failed | undefined
  return hit === undefined || isFailed(hit) ? undefined : n(hit)
}

// Fetches `repo` in the background, once at a time: when done the repo is asked again,
// when not the reason is kept until the next fetch or 重新整理. A /clear drops the answer,
// not the fetch: until it ends no other one starts.
function fetchCommits($: Pick<EngineInterface, 'fs' | 'process' | 'ui'>, cc: CommitsCache, repo: string): void {
  if (repo === '' || cc.fetching.has(repo)) return
  cc.fetching.add(repo)
  cc.fetchError.delete(repo)
  const gen = cc.gen
  void (async () => {
    let out: true | Failed
    try {
      out = await fetchRepo(ioOf($, FETCH_TIMEOUT_MS), repo)
    } catch {
      out = { error: 'fetch 失敗' }
    }
    cc.fetching.delete(repo)
    if (cc.gen !== gen) {
      redraw($)
      return
    }
    if (out === true) dropCommitRepo(cc, repo)
    else cc.fetchError.set(repo, out.error)
    redraw($)
  })()
  redraw($)
}

const redraw = ($: Pick<EngineInterface, 'ui'>) => {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // the next drawing shows it
  }
}

// What `key` stands for as git gave it; while `ask` works it out in the background,
// undefined, the page redrawn when it answers. A failure is kept until 重新整理 drops it.
function askCommits<T>(
  $: Pick<EngineInterface, 'ui'>,
  cc: CommitsCache,
  repo: string,
  key: string,
  ask: () => Promise<T | Failed>,
  fail: string,
): T | Failed | undefined {
  const hit = cc.answers.get(key) as T | Failed | undefined
  if (hit !== undefined || cc.asking.has(key)) return hit
  cc.asking.add(key)
  const gen = cc.gen
  const repoGen = cc.repoGen.get(repo) ?? 0
  const keyGen = cc.keyGen.get(key) ?? 0
  void (async () => {
    let out: T | Failed
    try {
      out = await ask()
    } catch {
      out = { error: fail }
    }
    if (cc.gen !== gen || (cc.repoGen.get(repo) ?? 0) !== repoGen || (cc.keyGen.get(key) ?? 0) !== keyGen) return
    cc.answers.set(key, out)
    cc.asking.delete(key)
    redraw($)
  })()
  return undefined
}

// The commits mode's repo list: the repos find gave with the touched ones still on disk,
// each as git last said; find and git asked in the background when the list or a repo is
// missing, the page redrawn when find answers, every COMMITS_REDRAW_EVERY repos and at the end.
async function commitListNow(
  $: Pick<EngineInterface, 'fs' | 'process' | 'ui'>,
  cc: CommitsCache,
  touched: readonly string[],
  names: { cwd: string; home: string },
): Promise<RepoList> {
  const io = ioOf($)
  const missing = cc.repos === undefined || (!isFailed(cc.repos) && cc.repos.some(r => !cc.summaries.has(r)))
  if (missing && !cc.scanning) {
    cc.scanning = true
    const gen = cc.gen
    void (async () => {
      try {
        if (cc.repos === undefined) {
          const found = await findRepos(io, names.cwd)
          // a find that failed still lists the touched repos on disk
          const listed = isFailed(found) ? [] : found
          const extra: string[] = []
          for (const r of touched) {
            if (!listed.includes(r) && (await io.stat(`${r === '/' ? '' : r}/.git`)) !== undefined) extra.push(r)
          }
          if (cc.gen !== gen) return
          cc.repos = isFailed(found) && extra.length === 0 ? found : [...listed, ...extra]
          redraw($)
        }
        const repos = cc.repos
        if (isFailed(repos)) return
        let n = 0
        for (const repo of repos) {
          if (cc.summaries.has(repo)) continue
          const repoGen = cc.repoGen.get(repo) ?? 0
          let s: RepoSummary | Failed
          try {
            s = await repoSummary(io, repo)
          } catch {
            s = { error: 'git log 失敗' }
          }
          if (cc.gen !== gen) return
          if ((cc.repoGen.get(repo) ?? 0) === repoGen) cc.summaries.set(repo, s)
          n += 1
          if (n % COMMITS_REDRAW_EVERY === 0) redraw($)
        }
      } catch {
        // the page shows what it has
      } finally {
        if (cc.gen === gen) {
          cc.scanning = false
          redraw($)
        }
      }
    })()
  }
  return repoRows(cc.repos, cc.summaries, new Set(touched), names, cc.scanning)
}

// What the changes page lists now: in the unpushed mode, each touched repo as git last
// said, a repo not yet asked asked in the background; in the session mode, cached
// counts, a file whose signature moved asked again in the background. The page is
// redrawn when git has answered.
async function changesNow(
  $: Pick<EngineInterface, 'fs' | 'process' | 'state' | 'ui'>,
  cache: ChangesCache,
  mode: ChangeMode,
  now: number,
  names: { cwd: string; home: string },
): Promise<ChangesView> {
  const io = ioOf($)
  const all = await read($, changes)
  if (mode === 'unpushed') {
    const touched = reposOf(all)
    for (const repo of cache.bashRepos) if (!touched.includes(repo)) touched.push(repo)
    // a repo whose `.git` is gone with its root (a removed worktree) is not listed: git has
    // nothing to say of it
    for (const repo of touched) {
      if (!cache.unpushedLive.has(repo)) cache.unpushedLive.set(repo, (await io.stat(`${repo === '/' ? '' : repo}/.git`)) !== undefined)
    }
    const repos = touched.filter(r => cache.unpushedLive.get(r) === true)
    const missing = repos.filter(r => !cache.unpushed.has(r))
    if (missing.length > 0 && !cache.unpushedBusy) {
      cache.unpushedBusy = true
      const gen = cache.unpushedGen
      void (async () => {
        try {
          for (const repo of missing) {
            let r: Unpushed | Failed
            try {
              r = await unpushedOf(io, repo)
            } catch {
              r = { error: 'git diff 失敗' }
            }
            if (cache.unpushedGen !== gen) return
            cache.unpushed.set(repo, r)
          }
        } finally {
          if (cache.unpushedGen === gen) cache.unpushedBusy = false
          try {
            $.ui.invalidate('ui.render')
          } catch {
            // the next drawing shows it
          }
        }
      })()
    }
    const groups = unpushedGroups(repos, cache.unpushed, all, names)
    cache.opened = new Map()
    for (const repo of repos) {
      const r = cache.unpushed.get(repo)
      if (r === undefined || isFailed(r)) continue
      for (const f of r.files) cache.opened.set(`u:${f.path}`, { mode: 'unpushed', repo, base: r.base, file: f })
    }
    return { mode, groups, pending: missing.length > 0, total: repos.length }
  }
  const list = all.slice(0, MAX_LISTED)
  if (now - cache.scannedAt >= CHANGES_SCAN_MS) {
    cache.scannedAt = now
    const next = new Map<string, string>()
    const gone = new Set<string>()
    for (const c of list) {
      const s = await io.stat(c.path)
      next.set(c.path, `${s?.mtimeMs ?? 'gone'}:${s?.size ?? 0}:${c.touches}`)
      if (s === undefined) gone.add(c.path)
    }
    const roots = new Set(list.flatMap(c => (c.repo !== null ? [c.repo] : [])))
    for (const root of roots) if ((await io.stat(`${root === '/' ? '' : root}/.git`)) === undefined) gone.add(root)
    cache.sigs = next
    cache.gone = gone
  }
  const stats = new Map<string, FileStat | Failed>()
  // a removed repo's files are only counted: git is not asked of them
  const stale = list.filter(c => {
    if (c.repo !== null && cache.gone.has(c.repo)) return false
    const hit = cache.stats.get(c.path)
    if (hit) stats.set(c.path, hit.stat)
    return hit?.sig !== (cache.sigs.get(c.path) ?? `new:${c.touches}`)
  })
  if (stale.length > 0 && !cache.busy) {
    cache.busy = true
    const gen = cache.gen
    void (async () => {
      try {
        for (const c of stale) {
          const sig = cache.sigs.get(c.path) ?? `new:${c.touches}`
          const stat = await sessionStat(io, c)
          if (cache.gen !== gen) return
          cache.stats.set(c.path, { sig, stat })
        }
      } catch {
        // the page shows what it has
      } finally {
        if (cache.gen === gen) cache.busy = false
        try {
          $.ui.invalidate('ui.render')
        } catch {
          // the next drawing shows it
        }
      }
    })()
  }
  const groups = sessionGroups(list, stats, names, cache.gone)
  cache.opened = new Map(list.map(c => [`s:${c.path}`, { mode: 'session' as const, change: c }]))
  return { mode, groups, pending: stale.length > 0, total: all.length }
}

// The diff of the file the changes page's row `key` stands for, as git gave it at the
// file's signature now (an unpushed file's also by the commit it is compared with); while
// git works a new one out in the background, the last one it gave, else undefined. A
// failure is kept until the signature moves or 重新整理 drops it. The page is redrawn when
// git has answered.
async function diffNow(
  $: Pick<EngineInterface, 'fs' | 'process' | 'ui'>,
  cache: ChangesCache,
  key: string,
): Promise<DiffRow[] | Failed | undefined> {
  const item = cache.opened.get(key)
  if (!item) return undefined
  const gen = cache.gen
  const unpushedGen = cache.unpushedGen
  const io = ioOf($)
  const s = await io.stat(item.mode === 'session' ? item.change.path : item.file.path)
  const file = `${s?.mtimeMs ?? 'gone'}:${s?.size ?? 0}`
  const sig = item.mode === 'session' ? `${file}:${item.change.touches}` : `${item.base}:${file}`
  const current = () => cache.gen === gen && (item.mode === 'session' || cache.unpushedGen === unpushedGen)
  const hit = cache.diffs.get(key)
  if (hit && hit.sig === sig) return hit.rows
  if (cache.diffBusy !== key && current()) {
    cache.diffBusy = key
    void (async () => {
      let rows: DiffRow[] | Failed
      try {
        rows = item.mode === 'session' ? await sessionDiff(io, item.change) : await unpushedDiff(io, item.repo, item.base, item.file)
      } catch {
        rows = { error: 'git diff 失敗' }
      }
      if (current()) {
        cache.diffs.set(key, { sig, rows })
        if (cache.diffBusy === key) cache.diffBusy = ''
      }
      try {
        $.ui.invalidate('ui.render')
      } catch {
        // the next drawing shows it
      }
    })()
  }
  return hit && !isFailed(hit.rows) ? hit.rows : undefined
}

// opens the pane, its boot screen from the time handed to boot (undefined: none); false when it could not open
async function openPane($: Pick<EngineInterface, 'clock' | 'ui'>, boot: (at: number | undefined) => void): Promise<boolean> {
  try {
    boot(await $.clock.now())
  } catch {
    // no clock: no boot screen
    boot(undefined)
  }
  try {
    await $.ui.open({ id: PANE, title: 'Jarvis' })
    return true
  } catch {
    boot(undefined)
    return false
  }
}

// What the engine says of its agents, as reconcileAgents reads it; undefined when it
// cannot say (the listing failed or came back empty).
async function engineAgents($: Pick<EngineInterface, 'agent'>): Promise<EngineAgent[] | undefined> {
  try {
    const list = (await $.agent.list()).map(a => ({ id: a.id, status: a.status, type: a.type, description: a.description }))
    return list.length === 0 ? undefined : list
  } catch {
    return undefined
  }
}

// `listing.fails` counts the listings in a row that said nothing. `waitingOnly` as
// reconcileAgents takes it.
async function reconcile(
  $: Pick<EngineInterface, 'agent' | 'state'>,
  now: number,
  listing: { fails: number },
  waitingOnly = false,
): Promise<void> {
  const info = await engineAgents($)
  if (info === undefined) {
    listing.fails += 1
    return
  }
  listing.fails = 0
  await update($, agents, list => {
    const out = reconcileAgents(list, info, now, waitingOnly)
    return out === list ? list : [...out]
  })
}

// The session's one tick, started at session.start: it counts the clock of running
// rows and turns the spinners; at most once per IDLE_MS it also marks lost subagents
// and feeds the Herdr row (`slow.at` is when it last did). It runs every ANIM_MS while
// a subagent runs (not waiting) or the boot plays and the pane is in view, every IDLE_MS otherwise
// (`pace` picks); with nothing running and no boot it only reads state, so nothing redraws.
async function tickOnce(
  $: Pick<EngineInterface, 'clock' | 'state' | 'agent'>,
  reporter: Reporter | undefined,
  pace: (list: readonly JarvisAgent[], now: number) => void,
  slow: { at: number },
  booting: (now: number) => boolean,
  listing: { fails: number },
): Promise<void> {
  try {
    const now = await $.clock.now()
    const due = now - slow.at >= IDLE_MS
    let list = await read($, agents)
    if (due && needsReconcile(list, now)) {
      await reconcile($, now, listing)
      list = await read($, agents)
    }
    const exempt = listing.fails < LIST_FAILS_MAX
    if (runningOf(list).length > 0 && due && markStale(list, now, exempt) !== list) {
      await update($, agents, l => [...markStale(l, now, exempt)])
      list = await read($, agents)
    }
    if (runningOf(list).length > 0 || booting(now)) await update($, tick, t => ({ n: t.n + 1, now }))
    pace(list, now)
    if (!due) return
    slow.at = now
    const health = healthOfState(
      {
        agents: list,
        main: await read($, main),
        events: await read($, events),
        inflight: await read($, inflight),
      },
      now,
    )
    await reporter?.step(jarvisText(list, health), now)
  } catch {
    // a broken tick must never reach Claude's work
  }
}

export const register: Register = on => {
  // A subagent can finish before its spawn has been recorded; park its turns here.
  const early = new Map<string, Completion[]>()
  // ids the engine was asked about on a tool call and did not list: not asked again
  const unknown = new Set<string>()
  const listing = { fails: 0 }
  // the changes page: where the session started, $HOME, where originals are cached, and
  // which directory stands in which repo
  let cwd = ''
  let changesHome = ''
  let cacheDir = ''
  const repoCache = new Map<string, string | null>()
  // each file's original as its first edit settles it
  const origs = new Map<string, Promise<string>>()
  // each repo's worktree, as its .git file names it
  const worktrees = new Map<string, Worktree | null>()
  const changesCache: ChangesCache = {
    stats: new Map(),
    busy: false,
    gen: 0,
    sigs: new Map(),
    gone: new Set(),
    scannedAt: -Infinity,
    unpushed: new Map(),
    unpushedLive: new Map(),
    unpushedBusy: false,
    unpushedGen: 0,
    opened: new Map(),
    diffs: new Map(),
    diffBusy: '',
    bashRepos: new Set(),
  }
  const commitsCache: CommitsCache = {
    gen: 0,
    repoGen: new Map(),
    keyGen: new Map(),
    repos: undefined,
    scanning: false,
    summaries: new Map(),
    answers: new Map(),
    asking: new Set(),
    fetching: new Set(),
    fetchError: new Map(),
  }
  const resetChanges = () => {
    repoCache.clear()
    origs.clear()
    worktrees.clear()
    changesCache.gen += 1
    changesCache.busy = false
    changesCache.stats.clear()
    changesCache.sigs = new Map()
    changesCache.gone = new Set()
    changesCache.scannedAt = -Infinity
    dropUnpushed(changesCache)
    changesCache.opened = new Map()
    changesCache.diffs.clear()
    changesCache.diffBusy = ''
    changesCache.bashRepos.clear()
    dropCommits(commitsCache)
  }
  let timer: Timer | undefined
  let period = 0
  // when the pane was last drawn: the tick animates only a pane in view
  let drawnAt = -Infinity
  // restarts the tick at `ms` when it runs at another period; set at session.start
  let pace: ((ms: number) => void) | undefined
  // when the pane was opened, at session start or by /jarvis: its boot plays until a drawing finds it over
  let bootAt: number | undefined
  // the boot animates only while the pane is in view
  const booting = (now: number) => bootAt !== undefined && now - drawnAt <= SEEN_MS
  // the fleet page: its poll runs while it is the page and was drawn within FLEET_SEEN_MS
  let fleetEnabled = false
  let fleetSeenAt = -Infinity
  let fleetOn: ((now: number) => void) | undefined
  let fleetJump: ((paneId: string) => void) | undefined
  // the fleet poll, one per register: a session started again cancels the last one's
  let fleetTimer: Timer | undefined
  let fleetBusy = false
  // when the session started: the standby suit's uptime
  let sessionStartedAt: number | undefined
  // the standby suit's quota read, when it last asked for one; set at session.start
  let quotaReadAt = -Infinity
  let quotaOn: ((now: number) => void) | undefined
  // the standby suit's frames: one every SUIT_TICK_MS while the now page shows it, drawn
  // within SEEN_MS, every SUIT_REST_TICK_MS at rest; set at session.start
  let suitTimer: Timer | undefined
  let suitPeriod = 0
  let suitSeenAt = -Infinity
  let suitOn: ((now: number, ms: number) => void) | undefined
  const suitOff = () => {
    suitTimer?.cancel()
    suitTimer = undefined
  }

  const setBoot = (at: number | undefined) => {
    bootAt = at
  }

  on('session.start', async ($, e, next) => {
    unknown.clear()
    listing.fails = 0
    try {
      await $.command.register({
        name: 'jarvis',
        description: 'Show a live pane of subagent dispatch',
      })
    } catch {
      // the command is optional
    }

    try {
      sessionStartedAt = await $.clock.now()
    } catch {
      // no clock: no uptime
      sessionStartedAt = undefined
    }

    let reporter: Reporter | undefined
    let herdrOn = false
    let home = ''
    try {
      const herdrEnv = await $.env.get('HERDR_ENV')
      const paneId = await $.env.get('HERDR_PANE_ID')
      home = (await $.env.get('HOME')) ?? ''
      herdrOn = paneId !== undefined && inHerdr(herdrEnv, paneId)
      if (paneId !== undefined && herdrOn) {
        reporter = createReporter(paneId, async argv => {
          try {
            const out = await $.process.run(argv, { timeoutMs: RUN_TIMEOUT_MS })
            return out.exitCode === 0
          } catch {
            return false
          }
        })
      }
    } catch {
      // no Herdr row without a readable environment
    }
    cwd = e.cwd
    changesHome = home
    try {
      const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '') || '/tmp'
      cacheDir = `${tmp}/claude-jarvis-changes/${crypto.randomUUID()}`
    } catch {
      cacheDir = ''
    }

    const slow = { at: -Infinity }
    const setPace = (ms: number) => {
      if (timer !== undefined && ms === period) return
      try {
        timer?.cancel()
        period = ms
        timer = $.clock.every(ms, () =>
          tickOnce($, reporter, (list, now) => setPace(tickMs(list, now, drawnAt, booting(now))), slow, booting, listing),
        )
      } catch {
        // no live clock; the pane still shows what happened
        timer = undefined
      }
    }
    pace = setPace
    timer?.cancel()
    timer = undefined
    setPace(IDLE_MS)

    const io: FleetIo = {
      home,
      run: async argv => {
        try {
          const r = await $.process.run(argv, { timeoutMs: FLEET_RUN_TIMEOUT_MS })
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, truncated: r.isStdoutTruncated === true }
        } catch {
          return undefined
        }
      },
      stat: async path => {
        try {
          const s = await $.fs.stat(path)
          return s.kind === 'file' ? { size: s.size, mtimeMs: s.mtimeMs } : undefined
        } catch {
          return undefined
        }
      },
      read: async path => {
        try {
          const t = await $.fs.read(path)
          return typeof t === 'string' ? t : undefined
        } catch {
          return undefined
        }
      },
      list: async dir => {
        try {
          return await $.fs.list(dir)
        } catch {
          return undefined
        }
      },
    }
    fleetEnabled = herdrOn && home !== ''
    fleetTimer?.cancel()
    fleetTimer = undefined
    fleetBusy = false
    const refresh = async () => {
      if (fleetBusy) return
      fleetBusy = true
      try {
        const now = await $.clock.now()
        const out = await refreshFleet(io, await read($, fleet), await read($, fleetCursor), now)
        await update($, fleetCursor, () => out.cursor)
        await update($, fleet, () => out.view)
      } catch {
        // the fleet page keeps what it showed
      } finally {
        fleetBusy = false
      }
    }
    fleetOn = (now: number) => {
      fleetSeenAt = now
      if (!fleetEnabled || fleetTimer !== undefined) return
      try {
        fleetTimer = $.clock.every(FLEET_MS, async () => {
          const t = await $.clock.now()
          const { page } = await read($, ui)
          if ((page !== 'fleet' && page !== 'fleetDetail') || t - fleetSeenAt > FLEET_SEEN_MS) {
            fleetTimer?.cancel()
            fleetTimer = undefined
            return
          }
          await refresh()
        })
        $.clock.after(1, () => void refresh())
      } catch {
        fleetTimer = undefined
      }
    }
    fleetJump = (paneId: string) => {
      void (async () => {
        try {
          const r = await io.run(focusArgv(paneId))
          const err: FleetJumpError | undefined =
            r?.exitCode === 0 ? undefined : { paneId, text: `跳轉失敗：${(r?.stderr ?? '').trim() || 'herdr 沒有回應'}` }
          await update($, fleet, v => withJump(v, err))
        } catch {
          // the page stays as it was
        }
      })()
    }

    quotaReadAt = -Infinity
    quotaOn = (now: number) => {
      if (home === '' || now - quotaReadAt < QUOTA_EVERY_MS) return
      quotaReadAt = now
      try {
        $.clock.after(1, async () => {
          try {
            const q = parseQuota(await io.read(`${home}/${LIMITS_PATH}`))
            await update($, standbyQuota, () => q ?? null)
          } catch {
            // the suit keeps what it showed
          }
        })
      } catch {
        // no clock: no power lines
      }
    }

    // the last session's quota read left behind; written only when there is one
    try {
      if ((await read($, standbyQuota)) !== null) await update($, standbyQuota, () => null)
    } catch {
      // the suit keeps what it showed
    }

    suitOff()
    // the last session's frame, deployment and hold left behind; written only when there are any
    try {
      const last = await read($, suit)
      if (last.n !== 0 || last.deployedAt !== undefined || last.paused === true) await update($, suit, () => ({ n: 0 }))
    } catch {
      // the suit keeps its frame
    }
    // a drawing that asks for another frame time restarts the timer at it
    suitOn = (now: number, ms: number) => {
      suitSeenAt = now
      if (suitTimer !== undefined && ms === suitPeriod) return
      suitOff()
      try {
        suitPeriod = ms
        suitTimer = $.clock.every(ms, async () => {
          try {
            // a drawing without the suit stops it at once; one not drawn again, here
            if ((await $.clock.now()) - suitSeenAt > SEEN_MS) {
              suitOff()
              return
            }
            // at rest the turn waits at its start: woken, it plays from STANDBY
            await update($, suit, s => ({ ...s, n: ms === SUIT_REST_TICK_MS ? 0 : s.n + 1 }))
          } catch {
            // the suit holds its frame
          }
        })
      } catch {
        // no live clock: the suit stands still
        suitTimer = undefined
      }
    }

    try {
      await update($, inflight, () => [])
    } catch {
      // bookkeeping only
    }

    // the pane is optional: one that cannot open waits for /jarvis
    await openPane($, setBoot)

    return next(e)
  })

  on('command.run', { command: 'jarvis' }, async $ =>
    (await openPane($, setBoot)) ? { text: 'Jarvis 面板已開啟' } : { text: 'Jarvis 面板開啟失敗' },
  )

  on('agent.spawn', async ($, e, next) => {
    const out = await next(e)
    try {
      const id = out.agentId
      if (id !== undefined) {
        const now = await $.clock.now()
        const model = out.model || e.model || ''
        const parked = early.get(id) ?? []
        early.delete(id)
        await update($, agents, list => {
          let rows = addAgent(list, {
            id,
            type: e.subagentType,
            description: e.description,
            model,
            now,
            ...(e.workflow ? { workflow: { runId: e.workflow.runId, agentIndex: e.workflow.agentIndex } } : {}),
          })
          for (const c of parked) rows = finishTurn(rows, id, c, now)
          return rows
        })
        await update($, tick, t => ({ n: t.n + 1, now }))
        // a suit held still plays no deployment
        if ((await read($, suit)).paused !== true) await update($, suit, s => ({ ...s, deployedAt: now }))
        pace?.(tickMs(await read($, agents), now, drawnAt))
      }
    } catch {
      // recording failed; the spawn itself already happened
    }

    return out
  })

  on('turn.start', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      await update($, main, m => ({ ...m, isRunning: true, runSince: now }))
    } catch {
      // bookkeeping only
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    const tool = e.tool
    let startedAt: number | undefined
    let source = MAIN_SOURCE
    let desc = ''
    try {
      desc = describeCall(tool, e as unknown as Record<string, unknown>)
      const now = await $.clock.now()
      startedAt = now
      if (id === undefined) {
        const isAgent = tool === 'Agent'
        await update($, main, m => ({
          ...m,
          chain: isAgent ? 0 : m.chain + 1,
          lastTool: tool,
          lastDesc: desc,
          toolCounts: { ...(m.toolCounts ?? {}), [tool]: ((m.toolCounts ?? {})[tool] ?? 0) + 1 },
        }))
      } else {
        const known = (await read($, agents)).some(a => a.id === id)
        if (!known && !unknown.has(id)) {
          const engineList = await engineAgents($)
          const info = engineList?.find(a => a.id === id)
          if (engineList !== undefined && info === undefined) {
            unknown.add(id)
            if (unknown.size > MAX_EARLY) {
              const oldest = unknown.values().next().value
              if (oldest !== undefined) unknown.delete(oldest)
            }
          }
          if (info) {
            await update($, agents, list =>
              list.some(a => a.id === id)
                ? list
                : addAgent(list, { id, type: info.type ?? 'subagent', description: info.description ?? '', model: '', now }),
            )
          }
        }
        await update($, agents, list => noteTool(list, id, tool, now))
        await update($, tick, t => ({ n: t.n + 1, now }))
        const list = await read($, agents)
        pace?.(tickMs(list, now, drawnAt))
        source = list.find(a => a.id === id)?.type ?? 'subagent'
      }
    } catch {
      // bookkeeping only
    }

    // An Agent or Workflow call is not in flight (UNTRACKED). Keys are random so a
    // reload's calls never share one.
    let flightKey: string | undefined
    if (startedAt !== undefined && !UNTRACKED.has(tool)) {
      try {
        const key = crypto.randomUUID()
        const began = startedAt
        flightKey = key
        await update($, inflight, list => [
          ...list,
          { key, actor: id ?? MAIN_ACTOR, source, tool, desc, startedAt: began },
        ])
      } catch {
        // bookkeeping only
      }
    }

    // the shell's directory as the Bash call starts: $.session.cwd() follows a Bash `cd`
    // from the call after it
    let shell = cwd
    if (tool === 'Bash') {
      try {
        shell = await $.session.cwd()
      } catch {
        // the session's start stands in
      }
    }

    let ok = true
    try {
      const out = await next(e)
      ok = out.isError !== true
      if (ok && out.deny === undefined) await recordChange($, tool, out.result, id ?? MAIN_ACTOR, cacheDir, repoCache, origs, worktrees)
      if (tool === 'Bash' && out.deny === undefined)
        await recordBash($, (e as unknown as Record<string, unknown>)['command'], shell, { cwd, home: changesHome }, changesCache, repoCache)
      return out
    } catch (err) {
      ok = false
      throw err
    } finally {
      try {
        if (flightKey !== undefined) {
          const key = flightKey
          await update($, inflight, list => list.filter(f => f.key !== key))
        }
      } catch {
        // bookkeeping only
      }
      try {
        if (startedAt !== undefined) {
          const began = startedAt
          const ms = Math.max(0, (await $.clock.now()) - began)
          const ev = { ts: began, actor: id ?? MAIN_ACTOR, source, isMain: id === undefined, tool, desc, ms, ok }
          await update($, events, list => addEvent(list, ev))
          await update($, eventTotal, n => n + 1)
          if (id === undefined) {
            await update($, main, m => ({
              ...m,
              ok: m.ok + (ok ? 1 : 0),
              fail: m.fail + (ok ? 0 : 1),
            }))
          }
        }
      } catch {
        // the call itself already ran
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    try {
      const id = e.agentId
      if (id === undefined) {
        const model = e.usage?.model
        await update($, main, m => ({ ...m, isRunning: false, ...(model ? { model } : {}) }))
      } else {
        const now = await $.clock.now()
        const c: Completion = {
          reason: e.reason,
          durationMs: e.durationMs,
          ...(e.usage ? { usage: e.usage } : {}),
        }
        let known = false
        await update($, agents, list => {
          known = list.some(a => a.id === id)
          return known ? finishTurn(list, id, c, now) : list
        })
        // the engine has most likely not ended it yet: running is left to the tick
        if (known) await reconcile($, now, listing, true)
        if (!known) {
          early.set(id, [...(early.get(id) ?? []), c])
          if (early.size > MAX_EARLY) {
            const oldest = early.keys().next().value
            if (oldest !== undefined) early.delete(oldest)
          }
        }
      }
    } catch {
      // bookkeeping only
    }

    // A turn that has ended has no call of its own left running; any still listed lost its
    // finally (a hot reload) and would hold off the stuck warning for good.
    try {
      const actor = e.agentId ?? MAIN_ACTOR
      await update($, inflight, list => list.filter(f => f.actor !== actor))
    } catch {
      // bookkeeping only
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      await update($, main, m => ({ ...m, chain: 0 }))
    } catch {
      // bookkeeping only
    }

    return next(e)
  })

  // a new, cleared or resumed session starts the changes page empty; a compaction keeps it
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'startup' || e.source === 'clear' || e.source === 'resume') {
      resetChanges()
      try {
        await update($, changes, () => [])
        // the commit tree, commit diff and stash diff pages go back to the repo list, as a diff page does
        await update($, ui, (u): JarvisUi => {
          if (u.page !== 'commitTree' && u.page !== 'commitDiff' && u.page !== 'stashDiff') return u
          const { commitRef: _r, repoBack: _b, repoView: _v, stashSha: _s, ...rest } = u
          return { ...rest, page: 'changes' }
        })
      } catch {
        // the page keeps what it showed
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const t = await read($, tick)
    let now = t.now
    try {
      now = await $.clock.now()
    } catch {
      // no clock: the last tick's time stands
    }
    const view = buildCockpit(
      {
        agents: await read($, agents),
        main: await read($, main),
        events: await read($, events),
        inflight: await read($, inflight),
      },
      now,
    )
    // played once: the first drawing that finds the boot over ends it
    const boot = bootAt === undefined ? undefined : bootStage(now - bootAt)
    if (boot === undefined) bootAt = undefined
    // a pane in view with a squad member running (not waiting), or booting, animates at
    // once, not at the next idle tick
    drawnAt = now
    if (view.running.some(a => a.waiting !== true) || boot !== undefined) pace?.(ANIM_MS)
    const shown = await read($, ui)
    const changesMode: ChangeMode = shown.changesMode ?? 'session'
    const onChanges = shown.page === 'changes' || shown.page === 'changeDiff'
    // the commits mode lists repos, not files: git is not asked of the session's files
    const changesView: ChangesView | undefined = !onChanges
      ? undefined
      : changesMode === 'commits'
        ? { mode: 'commits', groups: [], pending: false, total: 0 }
        : await changesNow($, changesCache, changesMode, now, { cwd, home: changesHome })
    const commitsShown = shown.page === 'changes' && changesMode === 'commits'
    let touched: string[] = []
    if (commitsShown) {
      touched = reposOf(await read($, changes))
      for (const r of changesCache.bashRepos) if (!touched.includes(r)) touched.push(r)
    }
    const commitList = commitsShown ? await commitListNow($, commitsCache, touched, { cwd, home: changesHome }) : undefined
    const commitRepo = shown.commitRepo ?? ''
    const repoView: RepoView = shown.repoView ?? 'log'
    const commitRef = shown.commitRef
    const onTree = (shown.page === 'commitTree' || shown.page === 'commitDiff' || shown.page === 'stashDiff') && commitRepo !== ''
    const onStash = shown.page === 'stashDiff' && commitRepo !== ''
    const gitIo = ioOf($)
    const tree = onTree
      ? askCommits<CommitTree>($, commitsCache, commitRepo, `t\x00${commitRepo}\x00${commitRef ?? ''}`, () => commitTreeOf(gitIo, commitRepo, commitRef), 'git log 失敗')
      : undefined
    const askStashes = () =>
      askCommits<StashInfo[]>($, commitsCache, commitRepo, `s\x00${commitRepo}`, () => stashesOf(gitIo, commitRepo), 'git stash 失敗')
    const commit =
      shown.page === 'commitDiff' && tree !== undefined && !isFailed(tree) ? tree.commits.find(c => c.sha === shown.commitSha) : undefined
    const pageStashes = onStash ? askStashes() : undefined
    const stash = pageStashes !== undefined && !isFailed(pageStashes) ? pageStashes.find(s => s.sha === shown.stashSha) : undefined
    // the tree page, or a diff page whose commit or stash is not there, which draws the tree page
    const onRepoPage =
      onTree && (shown.page === 'commitTree' || (shown.page === 'commitDiff' && !commit) || (shown.page === 'stashDiff' && !stash))
    const remotes = onRepoPage
      ? askCommits<Remotes>($, commitsCache, commitRepo, `r\x00${commitRepo}`, () => remotesOf(gitIo, commitRepo), 'git remote 失敗')
      : undefined
    const branches =
      onRepoPage && repoView === 'branches'
        ? askCommits<BranchList>($, commitsCache, commitRepo, `b\x00${commitRepo}`, () => branchesOf(gitIo, commitRepo), 'git for-each-ref 失敗')
        : undefined
    const stashes = (onRepoPage && repoView === 'stash') || onStash ? askStashes() : undefined
    const worktrees =
      onRepoPage && repoView === 'worktrees'
        ? askCommits<WorktreeRow[]>($, commitsCache, commitRepo, `w\x00${commitRepo}`, () => worktreesOf(gitIo, commitRepo), 'git worktree 失敗')
        : undefined
    const commitFileList = commit
      ? askCommits<CommitFile[]>($, commitsCache, commitRepo, `f\x00${commitRepo}\x00${commit.sha}`, () => commitFiles(gitIo, commitRepo, commit), 'git diff 失敗')
      : undefined
    const commitFile =
      commitFileList !== undefined && !isFailed(commitFileList)
        ? (commitFileList.find(f => f.path === shown.commitFile) ?? commitFileList[0])
        : undefined
    const commitDiffRows =
      commit && commitFile
        ? askCommits<DiffRow[]>(
            $,
            commitsCache,
            commitRepo,
            `d\x00${commitRepo}\x00${commit.sha}\x00${commitFile.path}`,
            () => commitFileDiff(gitIo, commitRepo, commit, commitFile.path),
            'git diff 失敗',
          )
        : undefined
    const stashFileList = stash
      ? askCommits<StashFile[]>($, commitsCache, commitRepo, `sf\x00${commitRepo}\x00${stash.sha}`, () => stashFiles(gitIo, commitRepo, stash.sha), 'git stash 失敗')
      : undefined
    const stashFile =
      stashFileList !== undefined && !isFailed(stashFileList) ? (stashFileList.find(f => f.path === shown.commitFile) ?? stashFileList[0]) : undefined
    const stashRows =
      stash && stashFile
        ? askCommits<DiffRow[]>(
            $,
            commitsCache,
            commitRepo,
            `sd\x00${commitRepo}\x00${stash.sha}\x00${stashFile.path}`,
            () => stashFileDiff(gitIo, commitRepo, stash.sha, stashFile),
            'git diff 失敗',
          )
        : undefined
    const diffKey = shown.diffKey ?? ''
    const diff = shown.page === 'changeDiff' ? { key: diffKey, rows: await diffNow($, changesCache, diffKey) } : undefined
    if (shown.page === 'fleet' || shown.page === 'fleetDetail') fleetOn?.(now)
    const quota = await read($, standbyQuota)
    const frame = await read($, suit)
    // the suit animates only while it is drawn and not held still, and reads the quota while drawn
    const onStandby = (drawn: boolean, ms?: number) => {
      if (!drawn || ms === undefined) suitOff()
      else suitOn?.(now, ms)
      if (drawn) quotaOn?.(now)
    }
    // a press holds the suit still or plays it; the drawing it brings stops or starts the timer
    const toggleSuit = () => {
      void (async () => {
        try {
          await update($, suit, x => ({ ...x, paused: x.paused !== true }))
        } catch {
          // the suit stays as it was
        }
      })()
    }
    let sessionId = ''
    try {
      sessionId = await $.session.id()
    } catch {
      // no session id: no row is marked as this one
    }
    const total = await read($, eventTotal)
    // what a press changes, written from its onPress (state is not written while drawing)
    const setUi = (fn: (u: JarvisUi, recorded: number) => JarvisUi) => {
      void (async () => {
        try {
          const recorded = await read($, eventTotal)
          await update($, ui, u => fn(u, recorded))
        } catch {
          // the pane stays as it was
        }
      })()
    }
    const commits: CommitsCtx = {
      cwdName: commitRepoName(cwd, cwd, changesHome),
      now,
      ...(sessionStartedAt === undefined ? {} : { startedAt: sessionStartedAt }),
      ...(commitList ? { list: commitList } : {}),
      ...(onTree
        ? {
            repo: {
              path: commitRepo,
              name: commitRepoName(commitRepo, cwd, changesHome),
              tree,
              view: repoView,
              ref: commitRef,
              remotes,
              fetching: commitsCache.fetching.has(commitRepo),
              fetchError: commitsCache.fetchError.get(commitRepo),
              branches,
              stashes,
              worktrees,
              counts: {
                branches: countOf<BranchList>(commitsCache, `b\x00${commitRepo}`, b => b.total),
                stash: countOf<StashInfo[]>(commitsCache, `s\x00${commitRepo}`, s => s.length),
                worktrees: countOf<WorktreeRow[]>(commitsCache, `w\x00${commitRepo}`, w => w.length),
              },
            },
          }
        : {}),
      ...(commit ? { diff: { commit, files: commitFileList, ...(commitFile ? { file: commitFile } : {}), rows: commitDiffRows } } : {}),
      ...(stash ? { stashDiff: { stash, files: stashFileList, file: stashFile, rows: stashRows } } : {}),
      openRepo: (repo: string) =>
        setUi(u => {
          const { commitRef: _r, repoBack: _b, ...rest } = u
          return { ...rest, page: 'commitTree', commitRepo: repo, repoView: 'log' }
        }),
      openCommit: (sha: string) =>
        setUi(u => {
          const { commitFile: _f, ...rest } = u
          return { ...rest, page: 'commitDiff', commitSha: sha }
        }),
      openFile: (path: string) => setUi(u => ({ ...u, page: 'commitDiff', commitFile: path })),
      refreshList: () => {
        dropCommits(commitsCache)
        redraw($)
      },
      refreshTree: () => {
        dropCommitKeys(commitsCache, commitRepo, REFRESH_KINDS[repoView])
        if (repoView === 'log') commitsCache.summaries.delete(commitRepo)
        commitsCache.fetchError.delete(commitRepo)
        redraw($)
      },
      // a branch's tree drops its branch; a worktree's keeps where its 返回 goes
      setView: (view: RepoView) =>
        setUi(u => {
          const { commitRef: _r, repoBack, ...rest } = u
          const outer = worktreeBack(repoBack, u.commitRepo)
          return { ...rest, ...(outer ? { repoBack: outer } : {}), page: 'commitTree', repoView: view }
        }),
      // a branch opened in a worktree's tree goes back to its 分支, then where the worktree goes back to
      openBranch: (ref: string) =>
        setUi(u => {
          const outer = worktreeBack(u.repoBack, u.commitRepo)
          return { ...u, page: 'commitTree', repoView: 'log', commitRef: ref, repoBack: { repo: u.commitRepo ?? '', view: 'branches', ...(outer ? { back: outer } : {}) } }
        }),
      openStash: (sha: string) =>
        setUi(u => {
          const { commitFile: _f, ...rest } = u
          return { ...rest, page: 'stashDiff', stashSha: sha }
        }),
      openStashFile: (path: string) => setUi(u => ({ ...u, page: 'stashDiff', commitFile: path })),
      openWorktree: (path: string) =>
        setUi(u => {
          const { commitRef: _r, ...rest } = u
          return { ...rest, page: 'commitTree', commitRepo: path, repoView: 'log', repoBack: { repo: u.commitRepo ?? '', view: 'worktrees' } }
        }),
      back: () =>
        setUi(u => {
          const { commitRef: _r, repoBack, ...rest } = u
          return repoBack
            ? { ...rest, page: 'commitTree', commitRepo: repoBack.repo, repoView: repoBack.view, ...(repoBack.back ? { repoBack: repoBack.back } : {}) }
            : { ...rest, page: 'changes' }
        }),
      fetch: () => fetchCommits($, commitsCache, commitRepo),
    }
    return drawCockpit(elements, view, {
      cols: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
      frame: SPINNER[t.n % SPINNER.length] ?? '⠋',
      scan: scanFrame(t.n),
      beat: t.n,
      ...(boot ? { boot } : {}),
      page: shown.page,
      agentId: shown.agentId,
      paused: shown.paused,
      fresh: shown.paused ? Math.max(0, total - shown.pausedTotal) : 0,
      go: (page: JarvisPage) => setUi(u => ({ ...u, page })),
      open: (agentId: string, from?: JarvisPage) =>
        setUi(u => {
          const { detailFrom: _f, ...rest } = u
          return { ...rest, page: 'detail', agentId, ...(from ? { detailFrom: from } : {}) }
        }),
      ...(shown.role === undefined ? {} : { role: shown.role }),
      ...(shown.detailFrom === undefined ? {} : { detailFrom: shown.detailFrom }),
      openRole: (role: string) => setUi(u => ({ ...u, page: 'roleDetail', role })),
      pause: () =>
        setUi((u, recorded) => (u.paused ? { ...u, paused: false } : { ...u, paused: true, pausedTotal: recorded })),
      fleet: await read($, fleet),
      herdr: fleetEnabled,
      paneId: shown.paneId ?? '',
      sessionId,
      openFleet: (paneId: string) => setUi(u => ({ ...u, page: 'fleetDetail', paneId })),
      jump: (paneId: string) => fleetJump?.(paneId),
      ...(quota ? { quota } : {}),
      ...(sessionStartedAt === undefined ? {} : { startedAt: sessionStartedAt }),
      suitTick: frame.n,
      ...(frame.deployedAt === undefined ? {} : { deployedAt: frame.deployedAt }),
      suitPaused: frame.paused === true,
      toggleSuit,
      onStandby,
      ...(changesView ? { changes: changesView } : {}),
      ...(diff ? { diff } : {}),
      setChangesMode: (mode: ChangeMode) => {
        if (mode === 'unpushed') dropUnpushed(changesCache)
        setUi(u => ({ ...u, changesMode: mode }))
      },
      refreshChanges: () => {
        dropUnpushed(changesCache)
        try {
          $.ui.invalidate('ui.render')
        } catch {
          // the next drawing asks again
        }
      },
      openDiff: (key: string) => setUi(u => ({ ...u, page: 'changeDiff', diffKey: key })),
      commits,
    })
  })
}
