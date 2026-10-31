import type { Locator } from '@playwright/test'

/** A table's header titles, in order: their text, not the upper case the CSS paints. */
export async function headerTitles(table: Locator): Promise<string[]> {
  return (await table.locator('thead th').allTextContents()).map((s) => s.trim())
}

/** What each row shows under the header `title`. */
export async function columnValues(table: Locator, title: string): Promise<string[]> {
  const index = (await headerTitles(table)).indexOf(title)
  if (index < 0) throw new Error(`no column „${title}"`)
  return (await table.locator(`tbody tr > td:nth-child(${index + 1})`).allTextContents()).map((s) => s.trim())
}
