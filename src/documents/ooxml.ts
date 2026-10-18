import { XMLParser } from 'fast-xml-parser'

/**
 * Shared Office Open XML helpers for the PPTX and XLSX readers: an order-preserving XML parser
 * and small accessors for the node shape it produces.
 */

export type XNode = Record<string, unknown>

export const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
})

export const tagOf = (node: XNode): string | undefined => Object.keys(node).find((k) => k !== ':@')
export const childrenOf = (node: XNode): XNode[] => {
  const tag = tagOf(node)
  const value = tag ? node[tag] : undefined
  return Array.isArray(value) ? (value as XNode[]) : []
}
export const attrsOf = (node: XNode): Record<string, string> => (node[':@'] as Record<string, string>) ?? {}

export function* walk(nodes: XNode[]): Generator<XNode> {
  for (const n of nodes) {
    yield n
    yield* walk(childrenOf(n))
  }
}

export function find(nodes: XNode[], tag: string): XNode | undefined {
  for (const n of walk(nodes)) if (tagOf(n) === tag) return n
  return undefined
}

/** Concatenated text of a node's `#text` leaves. */
export function textOf(node: XNode): string {
  let text = ''
  for (const n of walk(childrenOf(node))) if (typeof n['#text'] === 'string') text += n['#text']
  return text
}

/** Relationship id → target of a `.rels` part. */
export function relTargets(xml: string): Map<string, string> {
  const doc = xmlParser.parse(xml) as XNode[]
  const out = new Map<string, string>()
  for (const n of walk(doc)) {
    if (tagOf(n) !== 'Relationship') continue
    const a = attrsOf(n)
    if (a['@Id'] && a['@Target']) out.set(a['@Id'], a['@Target'])
  }
  return out
}

/** Resolves a relationship target against the part that owns the `.rels` file. */
export function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}
