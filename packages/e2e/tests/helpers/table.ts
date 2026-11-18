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

/**
 * Closes the open column picker (`GridColumnPickerDialog`) by its footer button. Its toolbar X is
 * named "Close" as well (FR-31 B4), so a role-and-name locator finds two; the test id finds the one.
 * `scope` is the open dialog.
 */
export async function closeColumnPicker(scope: Locator): Promise<void> {
  await scope.getByTestId('column-picker-close').click()
}
