import type { Locator, Page } from '@playwright/test'

/**
 * Opening a Vuetify `v-select` / `v-autocomplete`.
 *
 * ⚠ `getByRole('combobox', { name }).click()` resolves to the real `<input>` and then times
 * out with `<div class="v-field__input"> intercepts pointer events`. The input is painted
 * UNDER its own field wrapper, and the wrapper is what carries the activator. Clicking the
 * input is the obvious thing to write, fails on every select in the app, and the error names
 * the interceptor rather than the cause — so it reads like a flake and gets a retry instead
 * of a fix.
 *
 * Same family as the two gotchas already in CLAUDE.md: use `getByRole('combobox')` and not
 * `getByLabel()` to FIND a v-select, and `getByLabel()` and not `getByRole('switch')` for a
 * v-switch. Find it by role, then click its wrapper.
 *
 * `scope` may be the page or any container (a card), so a spec can disambiguate two selects
 * that share a label.
 */
export async function openSelect(scope: Page | Locator, name: RegExp | string): Promise<void> {
  const input = scope.getByRole('combobox', { name })
  await input.scrollIntoViewIfNeeded()
  await input.locator('xpath=ancestor::div[contains(@class,"v-field")][1]').click()
}

/**
 * Pick one option out of an open menu and close it.
 *
 * Vuetify renders the menu in a detached overlay at the end of `<body>`, so options are never
 * inside `scope` — they are always looked up on the page. A `multiple` select stays open after
 * a choice, which is why this always presses Escape.
 */
export async function chooseOption(page: Page, index = 0): Promise<string> {
  const option = page.getByRole('option').nth(index)
  await option.waitFor({ state: 'visible' })
  const label = (await option.textContent())?.trim() || ''
  await option.click()
  await page.keyboard.press('Escape')
  return label
}
