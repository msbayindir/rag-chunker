/**
 * Internal block produced during AST walk, before the size-fitting pass.
 * `nodes` is typed as `unknown[]` to avoid importing mdast at this level;
 * ast-chunker.ts casts to its local AnyMdNode[] type.
 */
export interface SectionBlock {
  /** Depth of the heading that opened this block (0 = before any heading) */
  headingDepth: number
  /** Breadcrumb of heading texts from root to this section */
  sectionPath: string[]
  /** mdast RootContent nodes belonging to this block */
  nodes: unknown[]
  /** Source page number (from <!-- page N --> markers) */
  pageNumber: number
  containsTable: boolean
  containsCode: boolean
  /** Approximate token count (computed after the block is closed) */
  tokenCount: number
}
