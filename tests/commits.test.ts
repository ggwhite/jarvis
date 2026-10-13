import { describe, expect, test } from 'claude-code/testing'

import { commitGraph, graphWidth } from '../hooks/commitGraph'
import type { GraphCommit, GraphRow } from '../hooks/commitGraph'

const c = (sha: string, ...parents: string[]): GraphCommit => ({ sha, parents })
const txt = (r: GraphRow): string => r.cells.map(x => x.ch).join('')

describe('commitGraph', () => {
  test('a straight history is one lane', () => {
    const rows = commitGraph([c('a', 'b'), c('b', 'c'), c('c')])
    expect(rows.map(txt)).toEqual(['●', '●', '●'])
    expect(rows.map(r => r.lane)).toEqual([0, 0, 0])
    expect(rows.every(r => r.node === 0 && !r.overflow)).toBe(true)
  })

  test('a branch opens right of its merge and closes into the base', () => {
    const rows = commitGraph([c('m', 'p', 'f2'), c('f2', 'f1'), c('f1', 'b'), c('p', 'b'), c('b')])
    expect(rows.map(txt)).toEqual(['●─╮', '│ ●', '│ ●', '● │', '●─╯'])
    expect(rows[0]?.cells.map(x => x.lane)).toEqual([0, 1, 1])
    expect(rows[1]?.lane).toBe(1)
    expect(rows[1]?.node).toBe(2)
  })

  test('a link crossing a lane that passes through draws ┼', () => {
    const rows = commitGraph([c('a', 'b'), c('x', 'd'), c('e', 'b'), c('b')])
    expect(rows.map(txt)).toEqual(['●', '│ ●', '│ │ ●', '●─┼─╯'])
    expect(rows[3]?.cells[2]?.lane).toBe(1)
  })

  test('an octopus merge opens a lane per parent and they close together', () => {
    const rows = commitGraph([c('m', 'a', 'b', 'c'), c('a', 'r'), c('b', 'r'), c('c', 'r'), c('r')])
    expect(rows.map(txt)).toEqual(['●─┬─╮', '● │ │', '│ ● │', '│ │ ●', '●─┴─╯'])
  })

  test('a root commit ends its lane; the next unrelated commit takes it', () => {
    expect(commitGraph([c('a'), c('b')]).map(txt)).toEqual(['●', '●'])
  })

  test('parents not in the list keep their lane waiting to the last row', () => {
    const rows = commitGraph([c('a', 'x'), c('b', 'y'), c('d', 'z')])
    expect(rows.map(txt)).toEqual(['●', '│ ●', '│ │ ●'])
  })

  test('a parent listed twice opens no lane', () => {
    expect(commitGraph([c('m', 'a', 'a'), c('a')]).map(txt)).toEqual(['●', '●'])
  })

  test('lanes past the cap are cut, the row marked, a node beyond them drawn on the last lane', () => {
    const rows = commitGraph([c('m', 'a', 'b', 'c', 'd'), c('d')], 2)
    expect(txt(rows[0] as GraphRow)).toBe('●─┬─')
    expect(rows[0]?.overflow).toBe(true)
    expect(rows[1]?.lane).toBe(3)
    expect(rows[1]?.node).toBe(2)
    expect(rows[1]?.overflow).toBe(true)
    expect(txt(rows[1] as GraphRow).startsWith('│ ●')).toBe(true)
    expect(rows[1]?.cells[2]?.lane).toBe(3)
  })

  test('graphWidth is the widest row, an overflow mark counted', () => {
    expect(graphWidth(commitGraph([c('m', 'p', 'f'), c('f', 'b'), c('p', 'b'), c('b')]))).toBe(3)
    expect(graphWidth(commitGraph([c('m', 'a', 'b', 'c', 'd')], 2))).toBe(5)
    expect(graphWidth([])).toBe(0)
  })
})
