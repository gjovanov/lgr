/**
 * A row of form actions keeps to one line where it can (`FormActionBar`): an action that names a `collapse`
 * rank gives up its label for its icon when the row would otherwise wrap, the lowest rank first. The rule is
 * here, with no Vue and no DOM in it; the component only measures whether the row wraps.
 */

/** What an action has to say for the row to shorten it: an icon to stand for it, and its turn. */
export interface CollapsibleAction {
  icon?: string
  collapse?: number
}

/**
 * The ranks the actions name, lowest first: the order in which labels are given up. An action with no icon
 * keeps its label whatever rank it names: there would be nothing left to show.
 */
export function collapseRanks(actions: CollapsibleAction[]): number[] {
  const ranks = new Set<number>()
  for (const a of actions) if (a.icon && a.collapse != null) ranks.add(a.collapse)
  return [...ranks].sort((a, b) => a - b)
}

/** Whether `action` shows as its icon once the first `level` ranks have given up their labels. */
export function collapsedAt(action: CollapsibleAction, ranks: number[], level: number): boolean {
  if (!action.icon || action.collapse == null || level <= 0) return false
  const index = ranks.indexOf(action.collapse)
  return index >= 0 && index < level
}
