import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

/**
 * Where the fields of one table row are underlined.
 *
 * A row of line items is a line of controls, and the owner reads their underlines as ONE line
 * (2026-11-15). That is a fact about rendered boxes, so it is read from them: a class name says
 * what a cell is meant to do, not where its field ended up.
 *
 * Positions are measured from the top of the row's TABLE, not of the row and not of the page: a
 * row that grows or re-centres its cells moves its fields against the table, and a page that
 * scrolls a focused field into view moves nothing against it.
 */
export interface RowLines {
  /** The row's own height. */
  height: number
  fields: { name: string; underline: number; focused: boolean }[]
}

export async function rowLines(row: Locator): Promise<RowLines> {
  await expect(row).toBeVisible()
  return row.evaluate((tr) => {
    const origin = tr.closest('table')!.getBoundingClientRect().top
    const fields: { name: string; underline: number; focused: boolean }[] = []
    for (const field of Array.from(tr.querySelectorAll('.v-field'))) {
      const box = field.getBoundingClientRect()
      if (!box.width || !box.height) continue
      // The underlined variant draws its line along the bottom of the outline box.
      const outline = field.querySelector('.v-field__outline')?.getBoundingClientRect()
      const cell = field.closest('td') as HTMLTableCellElement | null
      const named = field.closest('[data-testid]')
      const name = (named && named !== tr && tr.contains(named) ? named.getAttribute('data-testid') : null)
        || cell?.getAttribute('data-col')
        || `cell ${cell?.cellIndex}`
      fields.push({
        name: name as string,
        underline: Math.round(((outline ? outline.bottom : box.bottom) - origin) * 100) / 100,
        focused: field.classList.contains('v-field--focused'),
      })
    }
    return { height: tr.getBoundingClientRect().height, fields }
  })
}

const say = (lines: RowLines) => lines.fields.map((f) => `${f.name}${f.focused ? '*' : ''}=${f.underline}`).join(' ')

/**
 * Every underline of the row within 1 px of the others.
 *
 * Soft, like every position check here: each state of a row is a look of its own, and a row that is
 * crooked in one of them should go on to say in which of the others it is too.
 */
export function expectOneLine(lines: RowLines, what: string): void {
  expect(lines.fields.length, `${what}: the row has fields to line up`).toBeGreaterThan(1)
  const ys = lines.fields.map((f) => f.underline)
  expect.soft(Math.max(...ys) - Math.min(...ys), `${what}: every underline on one line (${say(lines)})`).toBeLessThanOrEqual(1)
}

/** Nothing moved between two looks at the same row: no underline, and not the row's height. */
export function expectUnmoved(before: RowLines, after: RowLines, what: string): void {
  expect(after.fields.map((f) => f.name), `${what}: the row keeps its fields`).toEqual(before.fields.map((f) => f.name))
  const moved = after.fields
    .map((f, i) => ({ name: f.name, by: Math.round((f.underline - before.fields[i].underline) * 100) / 100 }))
    .filter((m) => Math.abs(m.by) > 1)
  expect.soft(moved, `${what}: no underline moves (${say(before)} → ${say(after)})`).toEqual([])
  expect.soft(Math.abs(after.height - before.height), `${what}: the row keeps its height (${before.height} → ${after.height})`).toBeLessThanOrEqual(1)
}

/**
 * Give `control` the focus the way a person does (`act`: a click, a Tab, a key), then look at the
 * row again: the focused control must be the one meant, every underline still on one line, and
 * none of them moved from where `before` saw it.
 */
export async function expectSteadyUnder(
  row: Locator,
  before: RowLines,
  what: string,
  act: () => Promise<unknown>,
  focusedName?: string,
): Promise<RowLines> {
  await act()
  // The field redraws its line on focus (a 150 ms transition); what is measured is where it settles.
  await row.page().waitForTimeout(300)
  const after = await rowLines(row)
  // A step that left the focus elsewhere would pass by looking at a row nobody touched.
  const focused = after.fields.filter((f) => f.focused).map((f) => f.name)
  expect(focused, `${what}: one field of the row has the focus`).toHaveLength(1)
  if (focusedName) expect(focused, `${what}: the focus is where the step put it`).toEqual([focusedName])
  expectOneLine(after, what)
  expectUnmoved(before, after, what)
  return after
}

/** Take the focus out of the row and close whatever it opened. */
export async function leaveField(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(page.locator('.v-field--focused')).toHaveCount(0)
}

/**
 * Link an article to the row through its search (`ProductLineDescription`): from then on the
 * article's chip hangs under the field, which is the state that used to lift that field off the line.
 */
export async function linkArticle(page: Page, row: Locator, sku: string): Promise<void> {
  await row.getByTestId('product-field').locator('input').first().fill(sku)
  const found = page.locator('.pld-overlay .pld-item').first()
  await expect(found).toBeVisible({ timeout: 10000 })
  await found.scrollIntoViewIfNeeded()
  await found.click({ force: true })
  await expect(row.getByTestId('product-field').locator('.v-chip')).toBeVisible()
  await page.waitForLoadState('networkidle')
  await leaveField(page)
}

const API = process.env.BASE_URL || 'http://localhost:4001'

/**
 * Switch every optional line column on (discount, tax rate, warehouse, total) for the document
 * types named, before the app loads. The preference is per user and org
 * (`ui-shared/composables/useInvoiceLineColumns`): nothing hidden, the catalog's own order.
 *
 * The tax rate is a line column only when switched on, and it is one of the three controls the
 * owner named. Call it BEFORE the first navigation.
 */
export async function showEveryLineColumn(page: Page, docTypes: string[]): Promise<void> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
  })
  const { user, org } = await res.json()
  await page.addInitScript(({ userId, orgId, types }) => {
    for (const type of types) {
      localStorage.setItem(`lgr:invoice-line-cols:${userId}:${orgId}:${type}`, JSON.stringify({ order: [], hidden: [] }))
    }
  }, { userId: user.id, orgId: org.id || org._id, types: docTypes })
}
