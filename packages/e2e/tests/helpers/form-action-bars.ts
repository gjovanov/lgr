import { expect } from '@playwright/test'
import type { Download, Locator, Page } from '@playwright/test'

/**
 * A form's two action bars: the one under its title, and the same actions again at its foot
 * (`EntityFormShell` with `bottom-actions`). Both are drawn from one list, each action under its
 * `data-action` key; the foot's test ids carry `-bottom`.
 */
export const headerBar = (page: Page): Locator => page.locator('.form-actions-bar')
export const bottomBar = (page: Page): Locator => page.getByTestId('form-bottom-actions')

/** The actions a bar offers, in the order it shows them. */
export async function actionKeys(bar: Locator): Promise<string[]> {
  return bar.locator('[data-action]').evaluateAll((els) => els.map((e) => e.getAttribute('data-action') || ''))
}

/**
 * Both bars offer exactly `keys`, in that order. Polled: the list follows the document, which is
 * still loading when the form first shows.
 */
export async function expectBars(page: Page, keys: string[]): Promise<void> {
  await expect.poll(() => actionKeys(headerBar(page)), { timeout: 15000 }).toEqual(keys)
  await expect.poll(() => actionKeys(bottomBar(page))).toEqual(keys)
}

/** The actions a bar shows as their icon alone (the row was too narrow for every label). */
export async function iconOnlyKeys(bar: Locator): Promise<string[]> {
  return bar.locator('[data-action]').evaluateAll((els) => els
    .filter((e) => !!e.querySelector('.form-action-icon'))
    .map((e) => e.getAttribute('data-action') || ''))
}

/** The bar's buttons sit on one line: it is no taller than its tallest button and a half. */
export async function isOneLine(bar: Locator): Promise<boolean> {
  return bar.evaluate((el) => {
    const row = (el.classList.contains('form-action-row') ? el : el.querySelector('.form-action-row')) as HTMLElement
    let tallest = 0
    for (const child of Array.from(row.children) as HTMLElement[]) tallest = Math.max(tallest, child.offsetHeight)
    return tallest > 0 && row.clientHeight <= tallest * 1.5
  })
}

/** Every file the page downloads from here on, in order. */
export function collectDownloads(page: Page): Download[] {
  const downloads: Download[] = []
  page.on('download', (d) => downloads.push(d))
  return downloads
}

/** The Print dialog of a document form: the export dialog, found by its confirming button. */
export const printDialog = (page: Page): Locator =>
  page.getByRole('dialog').filter({ has: page.getByTestId('export-confirm') })
