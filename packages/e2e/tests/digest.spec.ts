/**
 * The daily-digest operator card — FR-11.15 (#21), untested at any level until now
 * (gjovanov/lgr#31 P2).
 *
 * The digest builder is covered exhaustively by `daily-digest.flow.test.ts` and its three
 * routes now by `digest-routes.flow.test.ts`. Neither touches the card in Settings →
 * Organization, which is the only place a human ever meets this feature: the enable switch,
 * the hour, the recipient list, the section checkboxes, the test-send button, and the
 * last-run status line.
 *
 * ⚠ Vuetify's `v-switch` has role `checkbox`, not `switch` — see the E2E gotchas in CLAUDE.md.
 * Everything here reaches switches through `getByLabel`.
 */
import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/login'
import { openSelect, chooseOption } from './helpers/vuetify'

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/settings/organization', { waitUntil: 'networkidle' })
})

test('the card renders with its controls', async ({ page }) => {
  const card = page.locator('.v-card', { hasText: /daily digest/i }).first()
  await expect(card).toBeVisible()

  await expect(card.getByLabel(/send the daily digest/i)).toBeVisible()
  await expect(card.getByRole('button', { name: /send test now/i })).toBeVisible()

  // The line that tells an operator whether this morning's digest went out. It is the ONLY
  // surface where a `skipped` run is visible — an unconfigured provider writes no EmailLog row.
  await expect(card.getByText(/not sent yet|sent|failed|skipped|partially sent/i).first()).toBeVisible()
})

test('the schedule controls are disabled until the digest is enabled', async ({ page }) => {
  const card = page.locator('.v-card', { hasText: /daily digest/i }).first()
  const toggle = card.getByLabel(/send the daily digest/i)

  if (await toggle.isChecked()) await toggle.click()

  // Enforced per-control by `:disabled="!form.digestEnabled"`. Nothing but a rendering test
  // can confirm the eight of them agree — a new control is easy to add without the binding.
  await expect(card.getByRole('combobox', { name: /send at/i })).toBeDisabled()
  await expect(card.getByRole('button', { name: /send test now/i })).toBeDisabled()

  await toggle.click()

  await expect(card.getByRole('combobox', { name: /send at/i })).toBeEnabled()
  await expect(card.getByRole('button', { name: /send test now/i })).toBeEnabled()
})

test('the hour and section choices survive a save and a reload', async ({ page }) => {
  const card = page.locator('.v-card', { hasText: /daily digest/i }).first()
  const toggle = card.getByLabel(/send the daily digest/i)
  if (!(await toggle.isChecked())) await toggle.click()

  await openSelect(card, /send at/i)
  const hourText = await chooseOption(page, 7)

  const stockSection = card.getByLabel(/stock at or below zero/i)
  const wanted = !(await stockSection.isChecked())
  await stockSection.click()

  await page.getByRole('button', { name: /^save/i }).first().click()
  await page.waitForLoadState('networkidle')

  await page.reload({ waitUntil: 'networkidle' })

  // `digestSections` is a nested object on the org settings document; a round-trip that drops
  // it silently leaves every section on, which looks fine until someone reads the mail.
  const reloaded = page.locator('.v-card', { hasText: /daily digest/i }).first()
  // `toHaveValue`, not `toHaveText`: a v-select's combobox IS an `<input>`, and its text
  // content is always the empty string — an assertion that would pass against any value.
  await expect(reloaded.getByRole('combobox', { name: /send at/i })).toHaveValue(hourText)
  await expect(reloaded.getByLabel(/stock at or below zero/i)).toBeChecked({ checked: wanted })
})

test('the test send reports what happened instead of claiming success', async ({ page }) => {
  const card = page.locator('.v-card', { hasText: /daily digest/i }).first()
  const toggle = card.getByLabel(/send the daily digest/i)
  if (!(await toggle.isChecked())) await toggle.click()

  await card.getByRole('button', { name: /send test now/i }).click()

  // Either outcome is correct and which one depends on whether SENDGRID_API_KEY is set on the
  // machine running this. What must NEVER happen is silence, or a success message on a server
  // that cannot send mail — FR-10 doctrine, and the reason the route answers 503.
  await expect(
    page.getByText(/test digest sent to|not configured|email is not configured|rejected/i).first(),
  ).toBeVisible({ timeout: 20000 })
})
