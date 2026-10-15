import type { Role } from './jarvis'

// Nerd Font glyphs (Private Use Area). cellWidth counts one cell each, but a terminal may
// draw one across two, so every icon is followed by a space: `withIcon` keeps that rule.

export const TAB_ICON = {
  now: '\uf0e4',
  log: '\uf03a',
  stats: '\uf080',
  fleet: '\uf135',
  changes: '\uf47f',
  tasks: '\uf0ae',
} as const

export const TITLE_ICON = {
  main: '\uf120',
  dispatch: '\uf1d8',
  models: '\uf4bc',
  agents: '\uf0c0',
  inflight: '\uf013',
  recent: '\uf1da',
  log: '\uf03a',
  fleet: '\uf135',
} as const

export const SECTION_ICON = {
  reactor: '\uf0e7',
  burn: '\uf06d',
  legion: '\uf132',
} as const

export const PHASE_ICON = {
  waiting: '\uf252',
  complete: '\uf058',
  failed: '\uf057',
} as const

export const ROLE_ICON: Record<Role, string> = {
  Explore: '\uf002',
  clerk: '\uf0ea',
  worker: '\uf0ad',
  verifier: '\uf132',
  fork: '\uf402',
  workflow: '\uf0e8',
  other: '\uf007',
}

export const CHANGE_ICON = {
  repo: '\uf401',
} as const

// a task's status: waiting, running, done
export const TASK_ICON = {
  pending: '\uf10c',
  in_progress: '\uf192',
  completed: PHASE_ICON.complete,
} as const

// what a request came to, after its title
export const RESULT_ICON = '\uf061'

// a commit tree's nodes (the plain and HEAD ones are not PUA glyphs: no space after them),
// and the branch and tag marks before a ref's name
export const COMMIT_ICON = {
  node: '●',
  head: '◉',
  merge: '\uf419',
  branch: '\ue725',
  tag: '\uf02b',
  remote: '\uf0c2',
} as const

export const withIcon = (icon: string, text: string): string => `${icon} ${text}`

// Claude Desktop's font has no Nerd Font glyphs: its pane draws these in their place
export const EMOJI_OF: Record<string, string> = {
  [TAB_ICON.now]: '📊',
  [TAB_ICON.log]: '📜',
  [TAB_ICON.stats]: '📈',
  [TAB_ICON.fleet]: '🚀',
  [TAB_ICON.changes]: '✏️',
  [TAB_ICON.tasks]: '✅',
  [TITLE_ICON.main]: '💻',
  [TITLE_ICON.dispatch]: '📨',
  [TITLE_ICON.models]: '🧠',
  [TITLE_ICON.agents]: '👥',
  [TITLE_ICON.inflight]: '⚙️',
  [TITLE_ICON.recent]: '🕘',
  [SECTION_ICON.reactor]: '⚡',
  [SECTION_ICON.burn]: '🔥',
  [SECTION_ICON.legion]: '🚩',
  [PHASE_ICON.waiting]: '⏳',
  [PHASE_ICON.complete]: '✅',
  [PHASE_ICON.failed]: '❌',
  [ROLE_ICON.Explore]: '🔍',
  [ROLE_ICON.clerk]: '🧰',
  [ROLE_ICON.worker]: '🔧',
  [ROLE_ICON.fork]: '🔱',
  [ROLE_ICON.workflow]: '🔄',
  [ROLE_ICON.other]: '👤',
  [CHANGE_ICON.repo]: '📁',
  [TASK_ICON.pending]: '○',
  [TASK_ICON.in_progress]: '◉',
  [RESULT_ICON]: '→',
  [COMMIT_ICON.merge]: '⑂',
  [COMMIT_ICON.branch]: '⎇',
  [COMMIT_ICON.tag]: '🏷️',
  [COMMIT_ICON.remote]: '☁️',
}

const PUA = /[-]/g

export const forDesktop = (s: string): string => s.replace(PUA, ch => EMOJI_OF[ch] ?? '•')

// A drawn tree for a surface without Nerd Font: every string converted but the keys and the
// press handles; an Svg is left whole, its source and words already plain. Every Text is set in
// the monospaced face (a mono already set is kept): the pane's columns are its cells, so the
// padding lines up as on the terminal.
export function desktopTree<T>(n: T): T {
  if (typeof n === 'string') return forDesktop(n) as T
  if (Array.isArray(n)) return n.map(x => desktopTree(x)) as T
  if (n !== null && typeof n === 'object') {
    const type = (n as { type?: unknown }).type
    if (type === 'Svg') return n
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(n)) out[k] = k === 'key' || k === 'press' ? v : desktopTree(v)
    if (type === 'Text') {
      const props = (out['props'] ?? {}) as Record<string, unknown>
      out['props'] = 'mono' in props ? props : { ...props, mono: true }
    }
    return out as T
  }
  return n
}
