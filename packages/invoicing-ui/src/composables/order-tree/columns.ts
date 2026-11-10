import type { TreeColumn } from './types'

/**
 * FR-28.41 — a narrow screen keeps every figure the wide one has, but not always as a column of its own.
 *
 * PURE: the tree measures how much room it has and asks here which columns to draw. A column marked
 * `optional` is one whose figure the screen can say another way (a tooltip on its neighbour); it is left out only
 * while drawing it would make the table scroll sideways, which hides the status and the actions at the far edge.
 */

/** What the first column (the article, the warehouse, the client) needs to stay readable when it has no width of its own. */
export const ITEM_MIN_WIDTH = 160

/** The width a column asks for. A column with no width takes what is left, and is held to at least `ITEM_MIN_WIDTH`. */
export function columnWidth(column: TreeColumn): number {
  return parseInt(column.width || '', 10) || ITEM_MIN_WIDTH
}

/** The narrowest the table can be with these columns before it has to scroll. */
export function columnsWidth(columns: readonly TreeColumn[]): number {
  return columns.reduce((sum, c) => sum + columnWidth(c), 0)
}

export interface FittedColumns {
  /** The columns to draw, in order. */
  shown: TreeColumn[]
  /** The keys of the optional columns left out, for a screen to say their figure another way. */
  hidden: string[]
}

/**
 * The columns that fit in `room` px. Optional columns are dropped from the right, one at a time, and only until the
 * table fits; nothing else is ever dropped (a table with no optional column keeps all of them and scrolls, as a table
 * must). `room` of 0 means "not measured yet" and keeps everything.
 */
export function fitColumns(columns: readonly TreeColumn[], room: number): FittedColumns {
  let shown = [...columns]
  const hidden: string[] = []
  if (!(room > 0)) return { shown, hidden }
  for (let i = columns.length - 1; i >= 0 && columnsWidth(shown) > room; i--) {
    if (!columns[i].optional) continue
    shown = shown.filter((c) => c.key !== columns[i].key)
    hidden.push(columns[i].key)
  }
  return { shown, hidden }
}
