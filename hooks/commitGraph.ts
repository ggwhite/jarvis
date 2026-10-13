// A commit graph as `git log --graph` draws it, but one row per commit: a merge or a
// branch is drawn on the commit's own row. Each lane takes two cells, its glyph then the
// link toward the next lane.

export type GraphCommit = { sha: string; parents: readonly string[] }

// `lane`: the lane whose color the cell takes, -1 for a blank
export type GraphCell = { ch: string; lane: number }

// `lane`: the commit's own lane; `node`: the index in `cells` of its glyph; `overflow`:
// lanes past the cap were left out of this row
export type GraphRow = { cells: GraphCell[]; lane: number; node: number; overflow: boolean }

export const MAX_LANES = 6

const BLANK: GraphCell = { ch: ' ', lane: -1 }

// what a glyph a link runs through becomes
const CROSS: Record<string, string> = { '│': '┼', '╯': '┴', '╰': '┴', '╮': '┬', '╭': '┬' }

// `commits` in `--topo-order`, newest first
export function commitGraph(commits: readonly GraphCommit[], maxLanes = MAX_LANES): GraphRow[] {
  // each lane: the commit it waits for next, null when free
  const lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  for (const c of commits) {
    let col = lanes.indexOf(c.sha)
    if (col < 0) {
      col = lanes.indexOf(null)
      if (col < 0) col = lanes.length
      lanes[col] = c.sha
    }
    const before = [...lanes]
    // other lanes waiting for this commit end here: branches merged into it
    const ins: number[] = []
    lanes.forEach((l, j) => {
      if (j !== col && l === c.sha) ins.push(j)
    })
    for (const j of ins) lanes[j] = null
    lanes[col] = c.parents[0] ?? null
    const taken = new Set([col, ...ins])
    const outs: { lane: number; fresh: boolean }[] = []
    for (const p of c.parents.slice(1)) {
      const k = lanes.indexOf(p)
      if (k === col) continue
      if (k >= 0) {
        outs.push({ lane: k, fresh: false })
        continue
      }
      let n = lanes.findIndex((l, j) => l === null && !taken.has(j))
      if (n < 0) n = lanes.length
      lanes[n] = p
      taken.add(n)
      outs.push({ lane: n, fresh: true })
    }
    const width = Math.max(before.length, lanes.length)
    const cells: GraphCell[] = Array.from({ length: width * 2 }, () => BLANK)
    for (let i = 0; i < width; i += 1) {
      if (i !== col && before[i] != null && lanes[i] != null && !ins.includes(i)) cells[2 * i] = { ch: '│', lane: i }
    }
    const link = (to: number, end: string) => {
      const lo = Math.min(col, to)
      const hi = Math.max(col, to)
      for (let x = 2 * lo + 1; x < 2 * hi; x += 1) {
        const cur = cells[x] ?? BLANK
        const cross = CROSS[cur.ch]
        if (cross !== undefined) cells[x] = { ch: cross, lane: cur.lane }
        else if (cur.ch === ' ') cells[x] = { ch: '─', lane: to }
      }
      const at = cells[2 * to] ?? BLANK
      if (at.ch === ' ' || at.ch === '│') cells[2 * to] = { ch: end, lane: to }
    }
    for (const j of ins) link(j, j > col ? '╯' : '╰')
    for (const o of outs) link(o.lane, o.fresh ? (o.lane > col ? '╮' : '╭') : o.lane > col ? '┤' : '├')
    cells[2 * col] = { ch: '●', lane: col }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
    while (cells.length > 0 && cells[cells.length - 1]?.ch === ' ') cells.pop()
    const cap = maxLanes * 2
    const overflow = cells.length > cap
    const shown = overflow ? cells.slice(0, cap) : cells
    const node = Math.min(col, maxLanes - 1) * 2
    if (col >= maxLanes) shown[node] = { ch: '●', lane: col }
    rows.push({ cells: shown, lane: col, node, overflow })
  }
  return rows
}

// the cells the widest row takes, an overflow mark's included
export function graphWidth(rows: readonly GraphRow[]): number {
  return rows.reduce((w, r) => Math.max(w, r.cells.length + (r.overflow ? 1 : 0)), 0)
}
