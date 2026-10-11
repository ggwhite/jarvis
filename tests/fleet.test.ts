import { describe, expect, test } from 'claude-code/testing'

import { contextPctOf, dayKey, fleetStatus, parsePanes, projectDir, splitLines, transcriptPath, utf8Len } from '../hooks/fleet'

// ---- fixtures：結構照 herdr 0.9.1 與 Claude Code 的真實輸出，內容全是假的 ----

const pane = (over: Record<string, unknown> = {}) => ({
  agent: 'claude',
  agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'sess-a' },
  agent_status: 'idle',
  cwd: '/srv/alpha',
  focused: false,
  label: 'Alpha review',
  pane_id: 'w1:p1',
  tab_id: 'w1:t1',
  terminal_title_stripped: 'Alpha review',
  tokens: { context: '⛁ 43% (430k)', limit: '5h 97%', provider: 'claude', title: 'Alpha review' },
  workspace_id: 'w1',
  ...over,
})

const paneJson = (panes: unknown[]) => JSON.stringify({ id: 'cli:pane:list', result: { panes, type: 'pane_list' } })

const workspaceJson = JSON.stringify({
  id: 'cli:workspace:list',
  result: {
    type: 'workspace_list',
    workspaces: [
      { workspace_id: 'w1', label: 'Acme', agent_status: 'idle', number: 1 },
      { workspace_id: 'w2', label: '~', agent_status: 'working', number: 2 },
    ],
  },
})

describe('fleet paths and panes', () => {
  test('a cwd maps to its projects folder, every non alphanumeric a dash', () => {
    expect(projectDir('/Users/u/Documents/my.site')).toBe('-Users-u-Documents-my-site')
    expect(projectDir('/private/tmp/claude-501/-Users-u/x')).toBe('-private-tmp-claude-501--Users-u-x')
    expect(transcriptPath('/home/u', '/srv/app', 's1')).toBe('/home/u/.claude/projects/-srv-app/s1.jsonl')
  })

  test('herdr status: blocked and working kept, the rest idle', () => {
    expect(fleetStatus('blocked')).toBe('blocked')
    expect(fleetStatus('working')).toBe('working')
    expect(['idle', 'done', 'unknown', undefined].map(fleetStatus)).toEqual(['idle', 'idle', 'idle', 'idle'])
  })

  test('context percent read from the herdr token text', () => {
    expect(contextPctOf('⛁ 43% (430k)')).toBe(43)
    expect(contextPctOf('')).toBeUndefined()
    expect(contextPctOf(undefined)).toBeUndefined()
  })

  test('herdr panes: only claude, workspace named, session id kept, no id is empty', () => {
    const panes = parsePanes(
      paneJson([
        pane({ agent_status: 'blocked' }),
        pane({ pane_id: 'w2:p2', tab_id: 'w2:t2', label: 'Bravo build', agent_status: 'working', workspace_id: 'w2', agent_session: undefined, tokens: {} }),
        pane({ pane_id: 'w2:p3', agent: 'codex', label: 'Codex job' }),
        pane({ pane_id: 'w9:p4', tab_id: undefined, label: '', terminal_title_stripped: 'From title', workspace_id: 'w9' }),
      ]),
      workspaceJson,
    )
    expect(panes?.map(p => [p.paneId, p.tabId, p.title, p.status, p.workspace, p.sessionId, p.contextPct])).toEqual([
      ['w1:p1', 'w1:t1', 'Alpha review', 'blocked', 'Acme', 'sess-a', 43],
      ['w2:p2', 'w2:t2', 'Bravo build', 'working', '~', '', undefined],
      ['w9:p4', '', 'From title', 'idle', 'w9', 'sess-a', 43],
    ])
  })

  test('a herdr answer that is not JSON or has no panes is undefined; a bad workspace list only loses names', () => {
    expect(parsePanes('nope', workspaceJson)).toBeUndefined()
    expect(parsePanes(JSON.stringify({ result: {} }), workspaceJson)).toBeUndefined()
    expect(parsePanes(paneJson([pane()]), 'nope')?.[0]?.workspace).toBe('w1')
  })
})

describe('fleet lines', () => {
  test('utf8Len counts bytes', () => {
    expect(utf8Len('a中😀')).toBe(1 + 3 + 4)
  })

  test('split lines: complete lines only, broken ones skipped, a cut first line dropped, bytes in UTF-8', () => {
    const a = JSON.stringify({ type: 'a', v: '中' })
    const text = `${a}\nnot json\n${a}\n{"type":"par`
    const r = splitLines(text, false)
    expect(r.rows).toHaveLength(2)
    expect(r.bytes).toBe(utf8Len(`${a}\nnot json\n${a}\n`))
    // a read that began inside a character: the first line is thrown away, not parsed
    expect(splitLines(`��pe":"x"}\n${a}\n`, true).rows).toHaveLength(1)
    // even a first line that parses is dropped: it may be the tail of a longer line
    expect(splitLines(`${a}\n${a}\n`, true).rows).toHaveLength(1)
    expect(splitLines('no newline', false)).toEqual({ rows: [], bytes: 0 })
  })

  test('dayKey is the local date', () => {
    expect(dayKey(new Date(2026, 9, 11, 23, 59).getTime())).toBe('2026-10-11')
    expect(dayKey(new Date(2026, 9, 12, 0, 0).getTime())).toBe('2026-10-12')
  })
})
