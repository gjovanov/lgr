import { nextTick } from 'vue'

/**
 * Spreadsheet-like keyboard navigation for the invoice line-item grid.
 *
 * One capture-phase `keydown` handler on the table wrapper does a DOM-walk (resilient to the
 * dynamically rendered columns), so no per-cell wiring is needed:
 *   - Tab / Shift+Tab  → next / previous editable cell (wraps across rows)
 *   - Enter / Shift+Enter → same column, next / previous row
 *   - Tab/Enter past the last cell of the last row → append a row and focus it
 *       (only if the last row has content, so blanks never stack)
 *
 * When a Vuetify dropdown is OPEN (`aria-expanded="true"`) we defer entirely, letting the
 * combobox/autocomplete navigate its list and commit on Tab/Enter natively. The non-input
 * action buttons (magnify, delete) carry `tabindex="-1"` so native Tab order through an open
 * dropdown also lands on the next cell input.
 *
 * Arrow Up/Down are intentionally NOT handled (they'd clash with the native number spinners).
 */
export function useGridNavigation(opts: { addLine: () => void; getLines: () => any[] }) {
  function rowInputs(row: Element): HTMLInputElement[] {
    return (Array.from(row.querySelectorAll('td input')) as HTMLInputElement[])
      .filter((i) => !i.disabled && !i.readOnly && i.type !== 'hidden')
  }

  function focusCell(input?: HTMLInputElement | null) {
    if (!input) return
    input.focus()
    try { input.select() } catch { /* not all inputs support select() */ }
  }

  async function maybeAppendRow(e: KeyboardEvent, tbody: Element, colIdx: number) {
    const lines = opts.getLines()
    const last = lines[lines.length - 1]
    const lastHasContent = !!last && (!!last.productId || String(last.description || '').trim() !== '')
    if (!lastHasContent) return // let Tab/Enter leave the grid instead of stacking blank rows
    e.preventDefault()
    opts.addLine()
    await nextTick()
    const rows = Array.from(tbody.querySelectorAll(':scope > tr'))
    const newRow = rows[rows.length - 1]
    if (!newRow) return
    const byCol = (newRow.children[colIdx] as Element | undefined)?.querySelector('input') as HTMLInputElement | null
    focusCell(byCol && !byCol.disabled && !byCol.readOnly ? byCol : rowInputs(newRow)[0])
  }

  async function onGridKeydown(e: KeyboardEvent) {
    if (e.key !== 'Tab' && e.key !== 'Enter') return
    const target = e.target as HTMLElement | null
    if (!target || target.tagName !== 'INPUT') return
    // Defer to an open Vuetify dropdown (list navigation + commit-on-Tab/Enter).
    if (target.getAttribute('aria-expanded') === 'true') return

    const td = target.closest('td')
    const tr = td?.closest('tr')
    const tbody = tr?.closest('tbody')
    if (!td || !tr || !tbody) return

    const rows = Array.from(tbody.querySelectorAll(':scope > tr'))
    const rowIdx = rows.indexOf(tr)
    const inputs = rowInputs(tr)
    const inputIdx = inputs.indexOf(target as HTMLInputElement)
    if (inputIdx === -1) return

    if (e.key === 'Tab' && !e.shiftKey) {
      if (inputIdx < inputs.length - 1) { e.preventDefault(); focusCell(inputs[inputIdx + 1]) }
      else {
        const next = rows[rowIdx + 1]
        if (next) { e.preventDefault(); focusCell(rowInputs(next)[0]) }
        else await maybeAppendRow(e, tbody, 0)
      }
    } else if (e.key === 'Tab' && e.shiftKey) {
      if (inputIdx > 0) { e.preventDefault(); focusCell(inputs[inputIdx - 1]) }
      else {
        const prev = rows[rowIdx - 1]
        if (prev) { e.preventDefault(); const pi = rowInputs(prev); focusCell(pi[pi.length - 1]) }
      }
    } else if (e.key === 'Enter') {
      const colIdx = Array.from(tr.children).indexOf(td)
      const dir = e.shiftKey ? -1 : 1
      const targetRow = rows[rowIdx + dir]
      if (targetRow) {
        e.preventDefault()
        const cell = (targetRow.children[colIdx] as Element | undefined)?.querySelector('input') as HTMLInputElement | null
        focusCell(cell && !cell.disabled && !cell.readOnly ? cell : rowInputs(targetRow)[0])
      } else if (dir === 1 && rowIdx === rows.length - 1) {
        await maybeAppendRow(e, tbody, colIdx)
      }
    }
  }

  return { onGridKeydown }
}
