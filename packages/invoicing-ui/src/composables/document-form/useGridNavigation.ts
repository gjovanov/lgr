import { nextTick } from 'vue'

/**
 * Spreadsheet-like keyboard navigation for the invoice line-item grid.
 *
 * One capture-phase `keydown` handler on the table wrapper does a DOM-walk (resilient to the
 * dynamically rendered columns), so no per-cell wiring is needed:
 *   - Tab / Shift+Tab        → next / previous editable cell (wraps across rows)
 *   - Enter / Shift+Enter     → same column, next / previous row
 *   - Arrow Up / Down         → same column, previous / next row (SKIPPED on number fields so
 *                               the native spinner still works; deferred while a dropdown is open)
 *   - Arrow Left / Right      → previous / next cell, but ONLY when the text caret is already at
 *                               the start / end of the field (otherwise the caret just moves)
 *   - Tab/Enter/Down past the last cell of the last row → append a row and focus it
 *       (only if the last row has content, so blanks never stack)
 *
 * When a Vuetify dropdown is OPEN (`aria-expanded="true"`) we defer entirely, letting the
 * combobox/autocomplete navigate its list and commit on Tab/Enter natively. The non-input action
 * buttons (magnify, delete) carry `tabindex="-1"` so native Tab order also lands on cell inputs.
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

  function moveRow(rows: Element[], rowIdx: number, colIdx: number, dir: number): boolean {
    const targetRow = rows[rowIdx + dir]
    if (!targetRow) return false
    const cell = (targetRow.children[colIdx] as Element | undefined)?.querySelector('input') as HTMLInputElement | null
    focusCell(cell && !cell.disabled && !cell.readOnly ? cell : rowInputs(targetRow)[0])
    return true
  }

  async function appendAndFocus(tbody: Element, colIdx: number): Promise<boolean> {
    const lines = opts.getLines()
    const last = lines[lines.length - 1]
    const lastHasContent = !!last && (!!last.productId || String(last.description || '').trim() !== '')
    if (!lastHasContent) return false // let the key leave the grid instead of stacking blank rows
    opts.addLine()
    await nextTick()
    const rows = Array.from(tbody.querySelectorAll(':scope > tr'))
    const newRow = rows[rows.length - 1]
    if (!newRow) return true
    const byCol = (newRow.children[colIdx] as Element | undefined)?.querySelector('input') as HTMLInputElement | null
    focusCell(byCol && !byCol.disabled && !byCol.readOnly ? byCol : rowInputs(newRow)[0])
    return true
  }

  // Caret at the very start / end of a text field (number inputs report null selection → false).
  function atStart(i: HTMLInputElement) { return i.selectionStart === 0 && i.selectionEnd === 0 }
  function atEnd(i: HTMLInputElement) { const n = (i.value ?? '').length; return i.selectionStart === n && i.selectionEnd === n }

  async function onGridKeydown(e: KeyboardEvent) {
    const k = e.key
    if (!['Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) return
    const target = e.target as HTMLInputElement | null
    if (!target || target.tagName !== 'INPUT') return
    if (target.getAttribute('aria-expanded') === 'true') return // defer to an open dropdown
    // Defer to an open product line-search (its own ↑/↓/Enter/Esc drive the results menu).
    // This capture-phase handler runs before the input's own keydown, so a data flag on the
    // wrapper is the only reliable way to yield the arrow keys to it.
    if (target.closest('[data-linesearch-open="true"]')) return

    const td = target.closest('td')
    const tr = td?.closest('tr')
    const tbody = tr?.closest('tbody')
    if (!td || !tr || !tbody) return
    const rows = Array.from(tbody.querySelectorAll(':scope > tr'))
    const rowIdx = rows.indexOf(tr)
    const inputs = rowInputs(tr)
    const inputIdx = inputs.indexOf(target)
    if (inputIdx === -1) return
    const colIdx = Array.from(tr.children).indexOf(td)

    // ── Horizontal ──
    if (k === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      if (inputIdx < inputs.length - 1) focusCell(inputs[inputIdx + 1])
      else if (rows[rowIdx + 1]) focusCell(rowInputs(rows[rowIdx + 1])[0])
      else await appendAndFocus(tbody, 0)
      return
    }
    if (k === 'Tab' && e.shiftKey) {
      e.preventDefault()
      if (inputIdx > 0) focusCell(inputs[inputIdx - 1])
      else if (rows[rowIdx - 1]) { const pi = rowInputs(rows[rowIdx - 1]); focusCell(pi[pi.length - 1]) }
      return
    }
    if (k === 'ArrowRight') {
      if (atEnd(target) && inputIdx < inputs.length - 1) { e.preventDefault(); focusCell(inputs[inputIdx + 1]) }
      return
    }
    if (k === 'ArrowLeft') {
      if (atStart(target) && inputIdx > 0) { e.preventDefault(); focusCell(inputs[inputIdx - 1]) }
      return
    }

    // ── Vertical ──
    // Arrow Up/Down are skipped on number fields so the native spinner keeps working.
    if ((k === 'ArrowUp' || k === 'ArrowDown') && target.type === 'number') return

    if (k === 'Enter' || k === 'ArrowDown') {
      const dir = (k === 'Enter' && e.shiftKey) ? -1 : 1
      e.preventDefault()
      if (dir === 1) {
        if (!moveRow(rows, rowIdx, colIdx, 1) && rowIdx === rows.length - 1) await appendAndFocus(tbody, colIdx)
      } else {
        moveRow(rows, rowIdx, colIdx, -1)
      }
      return
    }
    if (k === 'ArrowUp') {
      e.preventDefault()
      moveRow(rows, rowIdx, colIdx, -1)
    }
  }

  return { onGridKeydown }
}
