import { useGridNavigation } from 'ui-shared/composables/useGridNavigation'

/**
 * FR-33.8 (#933): the stock count's keyboard. It is `useGridNavigation`, the invoice's and the movement's, with two
 * additions a count needs:
 *
 * - **A virtual table** (FR-33.1, above 200 lines) draws only the rows in view, and `useGridNavigation` walks the rows
 *   in the page. So there, Enter / Tab (and with Shift, back) in a Counted field go by the line's place among the lines
 *   shown, not by the next row in the page: the table is scrolled to a row it has not drawn yet, and the cursor waits
 *   for it (§5's risk). A plain table has every row in the page and is walked by `useGridNavigation` as it is.
 * - **The entry line** is the last row (D-7). Past the last line the cursor goes there; Shift+Enter and Shift+Tab in it
 *   go back to the last line. Every other key in it is the search field's own (↓ / ↑ / Enter / Escape, F4).
 *
 * A Counted field says which line it belongs to: `data-line-qty="<productId>"`.
 */
export interface CountGridKeysOptions {
  /** The element holding the table: the keys are listened to there, and the fields are found inside it. */
  root: () => HTMLElement | null | undefined
  /** The lines shown, in order (the filter applied). */
  shown: () => readonly { productId: string }[]
  virtual: () => boolean
  /** The virtual table's own `scrollToIndex`. */
  scrollToIndex: (index: number) => void
  focusEntry: () => void
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

export function useCountGridKeys(opts: CountGridKeysOptions) {
  const { onGridKeydown } = useGridNavigation({ addLine: () => opts.focusEntry(), getLines: () => [...opts.shown()] })

  function qtyInput(productId: string): HTMLInputElement | null {
    return opts.root()?.querySelector<HTMLInputElement>(`[data-line-qty="${CSS.escape(productId)}"] input`) ?? null
  }

  /**
   * The cursor in the line's Counted field, its figure selected so typing replaces it. A row the virtual table has
   * not drawn is scrolled to first. False when the line is not among the lines shown.
   */
  async function focusLine(productId: string): Promise<boolean> {
    let input = qtyInput(productId)
    if (!input) {
      const index = opts.shown().findIndex((l) => String(l.productId) === productId)
      if (index < 0) return false
      if (opts.virtual()) opts.scrollToIndex(index)
      for (let i = 0; i < 30 && !input; i++) {
        await frame()
        input = qtyInput(productId)
      }
    }
    if (!input || input.disabled) return false
    input.focus()
    input.scrollIntoView({ block: 'nearest' })
    try { input.select() } catch { /* a number input may refuse select() */ }
    return true
  }

  function focusLast(): void {
    const lines = opts.shown()
    const last = lines[lines.length - 1]
    if (last) void focusLine(String(last.productId))
  }

  async function walk(e: KeyboardEvent, productId: string) {
    e.preventDefault()
    const lines = opts.shown()
    const index = lines.findIndex((l) => String(l.productId) === productId)
    if (index < 0) return
    const next = index + (e.shiftKey ? -1 : 1)
    if (next >= lines.length) opts.focusEntry()
    else if (next >= 0) await focusLine(String(lines[next].productId))
  }

  async function onKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null
    if (!target) return
    if (target.closest('[data-testid="count-entry"]')) {
      // Back to the last line; the search's open list keeps its keys.
      if ((e.key === 'Enter' || e.key === 'Tab') && e.shiftKey && target.getAttribute('aria-expanded') !== 'true') {
        e.preventDefault()
        focusLast()
      }
      return
    }
    const field = target.closest('[data-line-qty]')
    if (opts.virtual() && field && (e.key === 'Enter' || e.key === 'Tab')) {
      await walk(e, field.getAttribute('data-line-qty') || '')
      return
    }
    await onGridKeydown(e)
  }

  return { onKeydown, focusLine }
}
