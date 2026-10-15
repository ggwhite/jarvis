import { describe, expect, test } from 'claude-code/testing'

import type { Ctx } from '../hooks/cockpit'
import type { CommitsCtx, RepoPage } from '../hooks/commitsView'
import type { ChangesView } from '../hooks/changesView'
import { DT } from '../hooks/desktopTheme'
import { fitColumns } from '../hooks/desktopPagesB'
import { drawDesktop } from '../hooks/desktopView'
import type { DesktopUi } from '../hooks/desktopView'
import type { Cockpit } from '../hooks/jarvis'
import type { DiffRow } from '../hooks/gitDiff'
import type { FleetSession, FleetView, JarvisPage } from '../types'
import { badProps } from './allowedProps'
import { all, drawOn, engine, pressOn, svgs, textOf, wellFormed } from './helpers'
import type { Node } from './helpers'

const T0 = new Date(2026, 9, 15, 15, 0, 0).getTime()
const MIN = 60_000
const WIDTHS = [50, 80, 100, 140] as const

// the elements as the engine hands them: a node of its type, props and children apart
const flat = (c: unknown): (Node | string)[] =>
  c === null || c === undefined || c === false || c === true ? [] : Array.isArray(c) ? c.flatMap(flat) : typeof c === 'number' ? [String(c)] : [c as Node | string]
const element =
  (type: string) =>
  (props: Record<string, unknown>): Node => {
    const { children, ...rest } = props ?? {}
    return { type, props: rest, children: flat(children) }
  }
const UI = { Box: element('Box'), Text: element('Text'), Button: element('Button'), Svg: element('Svg') } as unknown as DesktopUi

const VIEW = { now: T0, roster: new Map([['agent-1', { n: 1, color: '#FFAA00' }]]), running: [], health: 'ok' } as unknown as Cockpit

const EMPTY_FLEET: FleetView = { at: 0, sessions: [], linkLost: false, scanning: false, hourly: Array.from({ length: 24 }, () => 0) }

const suit = (over: Partial<FleetSession> = {}): FleetSession => ({
  paneId: 'w1:p1',
  tabId: 'w1:t1',
  sessionId: 'sess-a',
  title: 'Alpha review',
  status: 'idle',
  cwd: '/srv/alpha',
  workspace: 'Acme',
  stamps: [],
  tools: 0,
  todayTokens: 0,
  todayCost: 0,
  ...over,
})

type Calls = string[]

const baseCtx = (calls: Calls, over: Partial<Ctx> = {}): Ctx => ({
  cols: 80,
  rows: 45,
  frame: '⠋',
  scan: '',
  beat: 0,
  page: 'fleet',
  agentId: '',
  paused: false,
  fresh: 0,
  go: (page: JarvisPage) => calls.push(`go:${page}`),
  open: (id: string) => calls.push(`open:${id}`),
  pause: () => calls.push('pause'),
  fleet: EMPTY_FLEET,
  herdr: false,
  paneId: '',
  sessionId: 'sess-self',
  openFleet: (paneId: string) => calls.push(`openFleet:${paneId}`),
  jump: (paneId: string) => calls.push(`jump:${paneId}`),
  setChangesMode: m => calls.push(`mode:${m}`),
  refreshChanges: () => calls.push('refreshChanges'),
  openDiff: key => calls.push(`openDiff:${key}`),
  ...over,
})

const draw = (ctx: Ctx): Node => drawDesktop(UI, VIEW, ctx) as unknown as Node

const kids = (n: Node): Node[] => (n.children ?? []).filter((c): c is Node => typeof c !== 'string')
const buttons = (tree: Node) => all(tree, x => x.type === 'Button')
const keyOf = (n: Node) => String(n.props?.['key'] ?? '')
const button = (tree: Node, key: string) => buttons(tree).find(b => keyOf(b) === key)
const press = (tree: Node, key: string) => {
  const b = button(tree, key)
  expect(b).toBeDefined()
  ;(b?.props?.['onPress'] as () => void)()
}
const cardInner = (cols: number) => Math.max(16, cols - 4 - 6)

// every row of fixed-width columns: its columns and the gaps between them add up within the card
const fixedRowsFit = (tree: Node, cols: number): number => {
  const rows = all(tree, x => x.type === 'Box' && x.props?.['flexDirection'] === 'row' && kids(x).length > 0 && kids(x).every(k => k.type === 'Box' && Number.isFinite(Number(k.props?.['width']))))
  for (const r of rows) {
    const ks = kids(r)
    const sum = ks.reduce((n, k) => n + Number(k.props?.['width']), 0) + Number(r.props?.['gap'] ?? 0) * (ks.length - 1)
    expect(sum).toBeLessThanOrEqual(cardInner(cols))
  }
  return rows.length
}

const texts = (tree: Node, color: string) => all(tree, x => x.type === 'Text' && x.props?.['color'] === color).map(textOf)

describe('desktop native B: helpers', () => {
  test('fitColumns drops the asked columns in order until the flexible one keeps its least', () => {
    const wide = fitColumns({ a: 10, b: 10 }, ['a', 'b'], 60)
    expect(wide.on('a') && wide.on('b')).toBe(true)
    expect(wide.rest).toBe(60 - 20 - 2)
    const narrow = fitColumns({ a: 10, b: 10 }, ['a', 'b'], 25)
    expect(narrow.on('a')).toBe(false)
    expect(narrow.on('b')).toBe(true)
    expect(narrow.rest).toBe(25 - 10 - 1)
  })
})

describe('desktop native B: fleet page', () => {
  test('without herdr: a glass card says herdr is needed and how to get it', () => {
    const tree = draw(baseCtx([]))
    expect(tree.props?.['backgroundColor']).toBe(DT.bg)
    expect(textOf(tree)).toContain('需要 herdr')
    expect(textOf(tree)).toContain('HERDR_ENV=1')
    expect(svgs(tree).some(s => s.props?.['alt'] === 'herdr 未連線')).toBe(true)
    expect(badProps(tree)).toEqual([])
    wellFormed(tree, 80)
  })

  test('herdr with no session yet: scanning, then an empty fleet', () => {
    expect(textOf(draw(baseCtx([], { herdr: true })))).toContain('掃描艦隊中…')
    expect(textOf(draw(baseCtx([], { herdr: true, fleet: { ...EMPTY_FLEET, at: T0 } })))).toContain('艦隊目前沒有 Claude session')
  })

  const fleet: FleetView = {
    at: T0,
    sessions: [
      suit({ paneId: 'w1:p1', title: 'Idle one', status: 'idle', lastAt: T0 - 30 * MIN, hourly: Array.from({ length: 24 }, (_, i) => i * 10) }),
      suit({ paneId: 'w1:p2', sessionId: 'sess-self', title: 'Busy one that has a rather long title to cut', status: 'working', model: 'claude-opus-5-5', tool: 'Bash', runSince: T0 - 5 * MIN, contextPct: 75, stamps: [T0 - MIN, T0 - 2 * MIN], todayTokens: 120_000, todayCost: 1.5 }),
      suit({ paneId: 'w1:p3', title: 'Blocked one', status: 'blocked', contextPct: 95 }),
    ],
    quota: { fiveHour: { usedPct: 40, resetsAt: T0 + 60 * MIN, windowMin: 300 }, sevenDay: { usedPct: 10, resetsAt: T0 + 3 * 24 * 60 * MIN, windowMin: 10080 }, fetchedAt: T0 },
    linkLost: false,
    scanning: false,
    hourly: Array.from({ length: 24 }, (_, i) => (i < 15 ? i * 100 : 0)),
  }

  test('each session a glass card, busy first; its title opens it, THIS marks this session', () => {
    const calls: Calls = []
    const tree = draw(baseCtx(calls, { herdr: true, fleet }))
    expect(textOf(tree)).toContain('IRON LEGION')
    expect(textOf(tree)).toContain('3 SUITS')
    expect(textOf(tree)).toContain('THIS')
    // blocked, then working, then idle
    expect(textOf(button(tree, 'suit-1') as Node)).toContain('Blocked one')
    expect(textOf(button(tree, 'suit-2') as Node)).toContain('Busy one')
    expect(textOf(button(tree, 'suit-3') as Node)).toContain('Idle one')
    expect(texts(tree, DT.fail)).toContain('AWAITING ORDERS')
    press(tree, 'suit-2')
    expect(calls).toEqual(['openFleet:w1:p2'])
    // the rings and the burn are glass pictures
    const alts = svgs(tree).map(s => String(s.props?.['alt']))
    expect(alts).toEqual(expect.arrayContaining(['5H 40%', '7D 10%']))
    expect(alts.some(a => a.startsWith('TODAY BURN'))).toBe(true)
    expect(badProps(tree)).toEqual([])
  })

  test('a lost herdr link reads FLEET LINK LOST in red', () => {
    const tree = draw(baseCtx([], { herdr: true, fleet: { ...fleet, linkLost: true } }))
    expect(texts(tree, DT.fail)).toContain('FLEET LINK LOST')
  })

  test('fixed columns stay within their card, pictures sized in cells, at every width', () => {
    for (const cols of WIDTHS) {
      const tree = draw(baseCtx([], { herdr: true, fleet, cols }))
      expect(fixedRowsFit(tree, cols)).toBeGreaterThan(0)
      wellFormed(tree, cols)
      expect(badProps(tree)).toEqual([])
    }
  })
})

describe('desktop native B: through the engine', () => {
  const native = (on: Parameters<typeof engine>[0]) => engine(on, 'agent-1', 'native')

  test('the fleet tab draws natively: no herdr, its empty card; only props Desktop 2.1.295 accepts', async ($, on) => {
    native(on)
    await pressOn($, 'desktop', 'tab-fleet')
    for (const cols of WIDTHS) {
      const tree = await drawOn($, 'desktop', 45, cols)
      expect(tree.props?.['backgroundColor']).toBe(DT.bg)
      expect(textOf(tree)).toContain('需要 herdr')
      expect(badProps(tree)).toEqual([])
      wellFormed(tree, cols)
    }
  })

})
