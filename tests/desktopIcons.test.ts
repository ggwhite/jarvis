import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import * as icons from '../hooks/icons'
import { EMOJI_OF, TAB_ICON, forDesktop } from '../hooks/icons'

type Node = { type?: string; props?: Record<string, unknown>; children?: (Node | string)[] }

const PUA = /[-]/

const textOf = (n: Node | string): string =>
  typeof n === 'string' ? n : [...(typeof n.props?.['label'] === 'string' ? [n.props['label']] : []), ...(n.children ?? []).map(textOf)].join('')

const draw = async ($: Engine, surface: 'terminal' | 'desktop'): Promise<Node> =>
  (await $.ui.render({
    surface,
    component: 'Pane',
    requestId: 'jarvis',
    viewport: { columns: 100, rows: 40 },
    props: { title: 'Jarvis', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })) as RenderElement as Node

const world = (on: On) => {
  mock.clock(on, { now: 0 })
  mock.env(on, {})
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', async () => ({}))
}

describe('desktop icons', () => {
  test('desktop pane draws no private-use glyphs and shows the emoji', async ($, on) => {
    world(on)
    const text = textOf(await draw($, 'desktop'))
    expect(PUA.test(text)).toBe(false)
    expect(text).toContain(EMOJI_OF[TAB_ICON.now])
  })

  test('terminal pane keeps the Nerd Font glyphs', async ($, on) => {
    world(on)
    const text = textOf(await draw($, 'terminal'))
    expect(text).toContain(TAB_ICON.now)
    expect(text).not.toContain(EMOJI_OF[TAB_ICON.now])
  })

  test('every private-use glyph of icons.ts has an emoji, none falls to the bullet', () => {
    const glyphs = new Set<string>()
    const walk = (v: unknown) => {
      if (typeof v === 'string') for (const ch of v.match(/[-]/g) ?? []) glyphs.add(ch)
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(icons)
    expect(glyphs.size).toBeGreaterThan(20)
    for (const g of glyphs) {
      expect(EMOJI_OF[g]).toBeDefined()
      expect(forDesktop(g)).not.toBe('•')
    }
    expect(forDesktop('ab')).toBe('a•b')
  })
})
