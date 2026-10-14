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
