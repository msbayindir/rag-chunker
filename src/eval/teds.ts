import type { TableData } from '../documents/tables.js'

/**
 * TEDS (Tree-Edit-Distance-based Similarity, Zhong et al. 2020): how close a recognised table is
 * to the reference. Tables become trees (table → thead/tbody → tr → td with spans and text); the
 * score is 1 - edit distance / size of the larger tree, so 1 means identical structure and text.
 */

export interface TreeNode {
  label: string
  colSpan?: number
  rowSpan?: number
  text?: string
  children: TreeNode[]
}

/** The tree TEDS compares: header rows under `thead`, the rest under `tbody`. */
export function tableTree(t: TableData): TreeNode {
  const rows: TreeNode[] = Array.from({ length: t.rows }, () => ({ label: 'tr', children: [] }))
  for (const c of [...t.cells].sort((a, b) => a.row - b.row || a.col - b.col)) {
    rows[c.row]?.children.push({
      label: 'td',
      colSpan: c.colSpan,
      rowSpan: c.rowSpan,
      text: c.text.replace(/\s+/g, ' ').trim(),
      children: [],
    })
  }
  const headerRows = Math.min(t.headerRows, t.rows)
  const children: TreeNode[] = []
  if (headerRows > 0) children.push({ label: 'thead', children: rows.slice(0, headerRows) })
  children.push({ label: 'tbody', children: rows.slice(headerRows) })
  return { label: 'table', children }
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number
      prev[j] = Math.min(
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      diag = tmp
    }
  }
  return prev[b.length] as number
}

function renameCost(a: TreeNode, b: TreeNode, structureOnly: boolean): number {
  if (a.label !== b.label) return 1
  if (a.label !== 'td') return 0
  if ((a.colSpan ?? 1) !== (b.colSpan ?? 1) || (a.rowSpan ?? 1) !== (b.rowSpan ?? 1)) return 1
  if (structureOnly) return 0
  const ta = a.text ?? ''
  const tb = b.text ?? ''
  const max = Math.max(ta.length, tb.length)
  return max === 0 ? 0 : levenshtein(ta, tb) / max
}

interface Indexed {
  nodes: TreeNode[]
  /** Post-order index (1-based) of each node's leftmost leaf. */
  leftmost: number[]
  keyroots: number[]
}

function index(root: TreeNode): Indexed {
  const nodes: TreeNode[] = [null as unknown as TreeNode]
  const leftmost: number[] = [0]
  const visit = (n: TreeNode): number => {
    let first = 0
    for (const c of n.children) {
      const l = visit(c)
      if (first === 0) first = l
    }
    nodes.push(n)
    const id = nodes.length - 1
    leftmost.push(first === 0 ? id : first)
    return leftmost[id] as number
  }
  visit(root)
  const seen = new Set<number>()
  const keyroots: number[] = []
  for (let i = nodes.length - 1; i >= 1; i--) {
    const l = leftmost[i] as number
    if (!seen.has(l)) {
      seen.add(l)
      keyroots.push(i)
    }
  }
  keyroots.sort((a, b) => a - b)
  return { nodes, leftmost, keyroots }
}

/** Zhang–Shasha ordered tree edit distance with unit insert/delete costs. */
export function treeEditDistance(
  a: TreeNode,
  b: TreeNode,
  options: { structureOnly?: boolean } = {},
): number {
  const A = index(a)
  const B = index(b)
  const m = A.nodes.length - 1
  const n = B.nodes.length - 1
  const td: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  const structureOnly = options.structureOnly ?? false

  for (const i of A.keyroots) {
    for (const j of B.keyroots) {
      const li = A.leftmost[i] as number
      const lj = B.leftmost[j] as number
      const rows = i - li + 2
      const cols = j - lj + 2
      const fd: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
      for (let x = 1; x < rows; x++) (fd[x] as number[])[0] = ((fd[x - 1] as number[])[0] as number) + 1
      for (let y = 1; y < cols; y++) (fd[0] as number[])[y] = ((fd[0] as number[])[y - 1] as number) + 1
      for (let x = 1; x < rows; x++) {
        const i1 = li + x - 1
        for (let y = 1; y < cols; y++) {
          const j1 = lj + y - 1
          const del = ((fd[x - 1] as number[])[y] as number) + 1
          const ins = ((fd[x] as number[])[y - 1] as number) + 1
          if (A.leftmost[i1] === li && B.leftmost[j1] === lj) {
            const sub =
              ((fd[x - 1] as number[])[y - 1] as number) +
              renameCost(A.nodes[i1] as TreeNode, B.nodes[j1] as TreeNode, structureOnly)
            const best = Math.min(del, ins, sub)
            ;(fd[x] as number[])[y] = best
            ;(td[i1] as number[])[j1] = best
          } else {
            const px = (A.leftmost[i1] as number) - li
            const py = (B.leftmost[j1] as number) - lj
            const sub = ((fd[px] as number[])[py] as number) + ((td[i1] as number[])[j1] as number)
            ;(fd[x] as number[])[y] = Math.min(del, ins, sub)
          }
        }
      }
    }
  }
  return (td[m] as number[])[n] as number
}

function size(n: TreeNode): number {
  return 1 + n.children.reduce((s, c) => s + size(c), 0)
}

/** TEDS between a recognised table and the reference, in [0, 1]. `structureOnly` ignores cell text. */
export function teds(
  predicted: TableData,
  reference: TableData,
  options: { structureOnly?: boolean } = {},
): number {
  const a = tableTree(predicted)
  const b = tableTree(reference)
  const dist = treeEditDistance(a, b, options)
  const max = Math.max(size(a), size(b))
  return max === 0 ? 1 : Math.max(0, 1 - dist / max)
}
