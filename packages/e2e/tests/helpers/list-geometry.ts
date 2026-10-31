import type { Page } from '@playwright/test'

export interface ListGeometry {
  /** Pixels of the table hidden sideways: what the user would have to scroll to reach. */
  hidden: number
  /** The tallest row, and the line height of a cell: a row is one line while tallest < 2 lines. */
  tallest: number
  lineHeight: number
  rows: number
  /** Buttons and links in each row's last cell — its actions. One: the row's ⋮ menu. */
  actionButtons: number[]
}

/**
 * FR-22.23: how a document list sits on the screen — „Document lists fit 1366 px. Row actions live
 * in one compact menu that needs no sideways scroll, and a row is one line tall."
 */
export async function listGeometry(page: Page): Promise<ListGeometry> {
  return page.locator('.v-table__wrapper').first().evaluate((el) => {
    const trs = [...el.querySelectorAll('tbody tr')] as HTMLElement[]
    const td = el.querySelector('tbody td') as HTMLElement | null
    return {
      hidden: el.scrollWidth - el.clientWidth,
      tallest: Math.max(0, ...trs.map((r) => r.offsetHeight)),
      lineHeight: (td && parseFloat(getComputedStyle(td).lineHeight)) || 20,
      rows: trs.length,
      actionButtons: trs.map((r) => r.lastElementChild?.querySelectorAll('button, a').length ?? 0),
    }
  })
}

/**
 * Whether the first row's cell in column `cellIndex` and its row menu are in view — inside the
 * table's box and painted on top, not scrolled under a pinned column — with the table scrolled
 * to its `start` or its `end`.
 */
export async function pinnedInView(page: Page, scroll: 'start' | 'end', cellIndex: number): Promise<{ cell: boolean; menu: boolean }> {
  return page.locator('.v-table__wrapper').first().evaluate((el, { scroll, cellIndex }) => {
    el.scrollLeft = scroll === 'start' ? 0 : el.scrollWidth
    const box = el.getBoundingClientRect()
    const row = el.querySelector('tbody tr') as HTMLElement
    const inView = (node: Element | null | undefined) => {
      if (!node) return false
      const r = node.getBoundingClientRect()
      if (r.left < box.left - 1 || r.right > box.right + 1) return false
      const hit = document.elementFromPoint(r.left + Math.min(10, r.width / 2), r.top + r.height / 2)
      return !!hit && node.contains(hit)
    }
    return { cell: inView(row.children[cellIndex]), menu: inView(row.lastElementChild?.querySelector('button')) }
  }, { scroll, cellIndex })
}
