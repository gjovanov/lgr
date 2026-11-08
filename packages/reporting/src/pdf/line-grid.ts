/**
 * The line-items grid of the document forms (2026-11-08): the invoicing documents (sales
 * invoice, bill, proforma, credit and debit note, cash sale and storno), the protocol and the
 * certificate printed beside them, and the stock receipt. The list and report exports keep
 * their own banded table (house-style.ts).
 *
 * - **Flush outer edges.** No padding before the first column's text and none after the last
 *   column's, so the grid starts and ends on the page margins, as the parties band above it
 *   and the totals box below it do.
 * - **Columns as wide as their contents.** Every column but the item's name gets `GRID_FIT_CLASS`,
 *   which makes it exactly as wide as its widest entry, heading or value. The name takes the
 *   rest of the line. With the old fixed percentages a quantity of „2" sat alone in a column a
 *   fifth of the line wide, and long names wrapped to three lines next to the empty space.
 * - **One gutter between neighbours.** `GRID_GUTTER_PX` is the whole gap between two columns'
 *   text, split evenly over the two cells. It is the narrowest gap at which two wide neighbours
 *   still read as two columns. The tight case is two amounts side by side, a quantity of
 *   „1000" before a price of „9999.99": Bulgarian groups thousands with a space, so at a word
 *   space's distance the pair reads as ONE figure. Rendered side by side on 2026-11-08, 6px and
 *   8px still read that way, 10px did not. The old grid had 12px plus fixed column widths.
 *
 * Each form keeps its own `table.lines` rules (type size, rules, shading, vertical padding) and
 * writes its horizontal cell padding as `GRID_CELL_PADDING_X`. `LINE_GRID_CSS` then takes it off
 * the outer edges and sizes the fitted columns. Its selectors are more specific than those
 * per-form rules, so it does not depend on where in the stylesheet it is placed.
 */

/** The whole gap between two neighbouring columns' text. */
export const GRID_GUTTER_PX = 10

/** Horizontal padding of every grid cell: half the gutter on each side of a column boundary. */
export const GRID_CELL_PADDING_X = `${GRID_GUTTER_PX / 2}px`

/**
 * The class that sizes a column to its widest entry. Every column but the free text has it: the
 * item's name, and on the protocol and the certificate their remark column.
 */
export const GRID_FIT_CLASS = 'fit'

/**
 * Edges and fitted columns, for a grid whose cells are `table.lines thead th` and
 * `table.lines tbody td`. A fitted cell never wraps: the column's width is its widest entry, and
 * the name column, which may wrap, absorbs whatever is left of the line.
 *
 * ⚠ The free-text cells break ANYWHERE as a last resort. A fitted column cannot give up any
 * width, so a name with nothing to break at (a long product code) would otherwise push the
 * whole grid past the right margin — 290px past it, measured, for a 90-character code. Only
 * `anywhere` lowers the cell's minimum width, which is what the table layout reads; with
 * `break-word` the grid still overflows. Text that has spaces wraps at them exactly as before.
 * NB this is a template literal: no backticks in the CSS comments.
 */
export const LINE_GRID_CSS = `
  table.lines thead th:first-child, table.lines tbody td:first-child { padding-left: 0; }
  table.lines thead th:last-child, table.lines tbody td:last-child { padding-right: 0; }
  table.lines th.${GRID_FIT_CLASS}, table.lines td.${GRID_FIT_CLASS} { width: 1%; white-space: nowrap; }
  table.lines th:not(.${GRID_FIT_CLASS}), table.lines td:not(.${GRID_FIT_CLASS}) { overflow-wrap: anywhere; }
`
