import type { TreeFlag, TreeNode } from './types'

/**
 * FR-28.38 / .42 — which rows of a tree are showing, and what opens and closes them.
 *
 * PURE, and in functions that return a new state rather than change one: the component keeps the
 * state in a ref and hands it to these. Open and closed is the tree's own, not a table library's: it
 * has to open by itself where something needs a look, open and close all of one supplier, survive the
 * reload a save causes, and be told to open a row a link points at.
 *
 * State is only the user's CHANGES (`overrides`). A node with no override is open exactly when its
 * `defaultOpen` says so, so what the data says (a line holds reservations) keeps applying until the
 * user decides otherwise, and a node the user has closed stays closed.
 */

export const FLAG_ORDER: readonly TreeFlag[] = ['overAllocated', 'overReserved', 'unallocated', 'new', 'changed', 'cancelledOnSave', 'late']

/** The flags that mean "look here" and so open a row by default. `unallocated` only informs. */
const ATTENTION: ReadonlySet<TreeFlag> = new Set<TreeFlag>(['overAllocated', 'overReserved', 'new', 'changed', 'cancelledOnSave', 'late'])

export function needsAttention(flags: readonly TreeFlag[]): boolean {
  return flags.some((f) => ATTENTION.has(f))
}

/** Several lists of flags as one, without repeats, in the order they are shown. */
export function mergeFlags(...lists: ReadonlyArray<readonly TreeFlag[]>): TreeFlag[] {
  const seen = new Set<TreeFlag>()
  for (const list of lists) for (const f of list) seen.add(f)
  return FLAG_ORDER.filter((f) => seen.has(f))
}

/** The user's changes to what is open: `true` opened, `false` closed. Absent: whatever the node says. */
export type OpenState = Record<string, boolean>

export function isNodeOpen(node: TreeNode, state: OpenState): boolean {
  return state[node.id] ?? node.defaultOpen
}

export interface VisibleRow {
  node: TreeNode
  /** Has children showing. */
  open: boolean
  /** Has children at all (a parent with none yet has its placeholder). */
  expandable: boolean
}

/** The rows a person sees, top to bottom, in the order of the lines. */
export function visibleRows(roots: readonly TreeNode[], state: OpenState): VisibleRow[] {
  const out: VisibleRow[] = []
  const walk = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      const expandable = node.children.length > 0
      const open = expandable && isNodeOpen(node, state)
      out.push({ node, open, expandable })
      if (open) walk(node.children)
    }
  }
  walk(roots)
  return out
}

/** Every node that has children, below `roots` (and themselves): what "expand all" has to open. */
export function parentIds(roots: readonly TreeNode[]): string[] {
  const out: string[] = []
  const walk = (nodes: readonly TreeNode[]) => {
    for (const n of nodes) {
      if (n.children.length) {
        out.push(n.id)
        walk(n.children)
      }
    }
  }
  walk(roots)
  return out
}

export function toggled(state: OpenState, node: TreeNode): OpenState {
  return { ...state, [node.id]: !isNodeOpen(node, state) }
}

export function setOpen(state: OpenState, id: string, open: boolean): OpenState {
  return { ...state, [id]: open }
}

/** Open everything below `roots`. */
export function expandAll(state: OpenState, roots: readonly TreeNode[]): OpenState {
  const next = { ...state }
  for (const id of parentIds(roots)) next[id] = true
  return next
}

/** Close everything below `roots`. */
export function collapseAll(state: OpenState, roots: readonly TreeNode[]): OpenState {
  const next = { ...state }
  for (const id of parentIds(roots)) next[id] = false
  return next
}

/** The ids from the root down to `id`'s parent: what has to be open for `id` to show. */
export function ancestorIds(index: ReadonlyMap<string, TreeNode>, id: string): string[] {
  const chain: string[] = []
  let cur = index.get(id)?.parentId
  while (cur) {
    chain.unshift(cur)
    cur = index.get(cur)?.parentId
  }
  return chain
}

/** Open every ancestor of `id` (and `id` itself when it is a parent): the state in which a link's row is there to see. */
export function revealed(state: OpenState, index: ReadonlyMap<string, TreeNode>, id: string, openSelf = false): OpenState {
  const next = { ...state }
  for (const a of ancestorIds(index, id)) next[a] = true
  if (openSelf && (index.get(id)?.children.length ?? 0) > 0) next[id] = true
  return next
}

/** What a closed parent says about what is below it: its flags and its children's, the ones a person should see. */
export function closedFlags(node: TreeNode): TreeFlag[] {
  return node.rolledFlags
}
