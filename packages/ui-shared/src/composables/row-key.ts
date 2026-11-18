import { toRaw } from 'vue'

/**
 * A line's key in an editable grid (FR-31.12): `<tr v-for="(line, idx) in form.lines" :key="rowKey(line)">`.
 *
 * Eight grids keyed their rows by position. When a row was removed, the rows below it were reused for other lines,
 * and what a row holds by itself (an open menu, a typed search text, a loaded option list, the focus) moved to its
 * neighbour; each reused row loaded again too (FR-30.10).
 *
 * The key belongs to the line OBJECT, not to its data: it is given the first time a line is asked for one, kept in a
 * `WeakMap`, and never written on the line. So no payload carries it, the unsaved-edits guard never sees it (a key on
 * the line would read as an edit, and travel in the Pending Changes copy), and a line keeps it for as long as it is the
 * same line: added, moved, or with a line above it removed. A line made anew (a load, a restore) is a new row.
 */
const keys = new WeakMap<object, number>()
let last = 0

export function rowKey(line: object): number {
  const raw = toRaw(line)
  let key = keys.get(raw)
  if (key === undefined) {
    key = ++last
    keys.set(raw, key)
  }
  return key
}
