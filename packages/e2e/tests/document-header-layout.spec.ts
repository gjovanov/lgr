import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { draftDocument } from './helpers/draft-document'

/**
 * FR-28.32 to .36 — the header of a bill, a sales invoice and a proforma, new and edit, on a
 * laptop (1366) and a desk screen (1920).
 *
 * The banner used to spend its first row on the organization's name and the title the shell's
 * `<h1>` already carries, and stacked the print note and the companion-documents note under the
 * number. Now: the party select, the number with its status, and the issue date are one row of
 * three equal columns; the print note sits above Reason / Notes, and the companion note under the
 * totals. Only places moved: what a save validates is what it validated.
 *
 * Geometry is read from the rendered boxes, not from class names alone, because the layout IS the
 * requirement: a `v-col` that wraps to a second row still has its class.
 */

const API = process.env.BASE_URL || 'http://localhost:4001'

const KINDS = [
  { name: 'bill', list: 'bills', type: 'invoice', direction: 'incoming', companion: false },
  { name: 'invoice', list: 'invoices', type: 'invoice', direction: 'outgoing', companion: true },
  { name: 'proforma', list: 'proforma', type: 'proforma', direction: 'outgoing', companion: true },
] as const
const WIDTHS = [1366, 1920]
const MODES = ['new', 'edit'] as const

interface Box { x: number; y: number; width: number; height: number }

async function box(loc: any): Promise<Box> {
  await expect(loc).toBeVisible()
  const b = await loc.boundingBox()
  expect(b, 'the element has a box on screen').toBeTruthy()
  return b as Box
}

async function orgName(): Promise<string> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
  })
  return (await res.json()).org.name as string
}

for (const kind of KINDS) {
  for (const width of WIDTHS) {
    for (const mode of MODES) {
      test(`${kind.name} ${mode} at ${width} px: party | number | issue date in one row, notes in place`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        let path = `/invoicing/${kind.list}/new`
        if (mode === 'edit') {
          const draft = await draftDocument(kind.type, kind.direction)
          path = `/invoicing/${kind.list}/${draft.id}/edit`
        }
        const org = await orgName()
        await loginForApp(page)
        await page.goto(path)
        await page.waitForLoadState('networkidle')

        // The shell's heading stays: it is the title, and the specs find the form by it.
        const h1 = page.locator('h1').first()
        await expect(h1).toBeVisible()
        const title = (await h1.innerText()).trim()
        expect(title.length).toBeGreaterThan(0)

        const banner = page.locator('.doc-banner')
        await expect(banner).toBeVisible()

        // One <form> on the page, as before: specs find "the form" by `.v-form` (strict mode), so a
        // second one — say, wrapped round the date that moved into the banner — breaks them.
        await expect(page.locator('.v-form')).toHaveCount(1)

        // No organization-and-title block: not the avatar, not the two lines, not their words.
        await expect(banner.locator('.doc-banner-org, .doc-banner-title, .v-avatar')).toHaveCount(0)
        await expect(banner).not.toContainText(org)
        await expect(banner).not.toContainText(title)

        // Three columns, equal, on one row, in this order.
        const party = await box(page.locator('.doc-banner-party'))
        const meta = await box(page.locator('.doc-banner-meta'))
        const date = await box(page.locator('.doc-banner-date'))
        expect(Math.abs(party.y - meta.y), 'party and number share a row').toBeLessThanOrEqual(2)
        expect(Math.abs(party.y - date.y), 'party and date share a row').toBeLessThanOrEqual(2)
        expect(Math.abs(party.width - meta.width), 'party and number columns are equal').toBeLessThanOrEqual(1)
        expect(Math.abs(party.width - date.width), 'party and date columns are equal').toBeLessThanOrEqual(1)
        expect(party.x).toBeLessThan(meta.x)
        expect(meta.x).toBeLessThan(date.x)

        // What is in them: the select first in the page (the specs take `.v-autocomplete` `.first()`
        // for the contact), the number as `.text-h6` with the status chip beside it, the issue date.
        const firstAutocompleteIsParty = await page.locator('.v-autocomplete').first()
          .evaluate((el) => !!el.closest('.doc-banner-party'))
        expect(firstAutocompleteIsParty, 'the party select is the first autocomplete in the DOM').toBe(true)
        await expect(page.locator('.doc-banner-meta .text-h6')).toHaveCount(1)
        // A saved document has a status; a new one has none yet (the chip never showed on a new document).
        await expect(page.locator('.doc-banner-meta .v-chip')).toHaveCount(mode === 'edit' ? 1 : 0)
        await expect(page.locator('.doc-banner-date input[type="date"]')).toHaveCount(1)
        // The number and the party select overlap vertically: one row, not two stacked cells.
        const field = await box(page.locator('.doc-banner-party .v-field').first())
        const number = await box(page.locator('.doc-banner-meta .text-h6'))
        expect(number.y).toBeLessThan(field.y + field.height)
        expect(field.y).toBeLessThan(number.y + number.height)

        // The columns are the grid of the row below, so the party block sits under its select.
        const upper = await box(page.getByTestId('document-upper'))
        expect(Math.abs(party.x - upper.x), 'the banner and the row below share their left edge').toBeLessThanOrEqual(4)

        // Print note above Reason / Notes, in the left column, at its width.
        const printNote = await box(page.getByTestId('print-note'))
        const notes = await box(page.getByTestId('document-notes'))
        const totals = await box(page.getByTestId('document-totals'))
        expect(printNote.y + printNote.height, 'the print note ends above the notes').toBeLessThanOrEqual(notes.y + 1)
        expect(Math.abs(printNote.x - notes.x)).toBeLessThanOrEqual(1)
        expect(Math.abs(printNote.width - notes.width), 'the print note is as wide as the notes').toBeLessThanOrEqual(1)
        expect(printNote.x + printNote.width, 'in the left column, beside the totals').toBeLessThanOrEqual(totals.x)

        // Companion note under the totals on an outgoing document, absent on a bill.
        if (kind.companion) {
          const companion = await box(page.getByTestId('companion-note'))
          expect(companion.y, 'the companion note is under the totals card').toBeGreaterThanOrEqual(totals.y + totals.height - 1)
          expect(Math.abs(companion.x - totals.x)).toBeLessThanOrEqual(1)
          expect(Math.abs(companion.width - totals.width)).toBeLessThanOrEqual(1)
        } else {
          await expect(page.getByTestId('companion-note')).toHaveCount(0)
        }
      })
    }
  }
}

// The banner is short on purpose, so a message under one of its fields must not make it taller: when the
// party select loses focus its `required` message appears, and if that grew the banner, everything below
// would slide down while the mouse button was still held. The click that took the focus away would land
// on something else and be dropped — the first click on „With product update" did nothing.
for (const kind of KINDS) {
  test(`${kind.name}: a banner field losing focus does not move what is below it`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 })
    await loginForApp(page)
    await page.goto(`/invoicing/${kind.list}/new`)
    await page.waitForLoadState('networkidle')

    const upper = page.getByTestId('document-upper')
    const before = await box(upper)
    const bannerBefore = await box(page.locator('.doc-banner'))

    const select = page.locator('.doc-banner-party input').first()
    await select.focus()
    await select.blur()
    if (kind.name === 'bill') {
      // The situation that matters: the message really did appear.
      await expect(page.locator('.doc-banner-party .v-messages__message')).toBeVisible()
    }
    await page.waitForTimeout(400)

    const after = await box(upper)
    const bannerAfter = await box(page.locator('.doc-banner'))
    expect(bannerAfter.height, 'the banner kept its height').toBeLessThanOrEqual(bannerBefore.height + 1)
    expect(Math.abs(after.y - before.y), 'the row under the banner did not move').toBeLessThanOrEqual(1)
  })
}

// FR-28.35: the issue date moved out of the document's <v-form>, and it was a required field. A save
// with the date emptied must still be refused, and the field must say why.
for (const kind of KINDS) {
  test(`${kind.name}: an emptied issue date still stops the save`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 })
    await loginForApp(page)
    await page.goto(`/invoicing/${kind.list}/new`)
    await page.waitForLoadState('networkidle')

    const posts: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/org\/[^/]+\/invoices$/.test(new URL(req.url()).pathname)) posts.push(req.url())
    })

    // A bill also requires the supplier's own number: fill it, so the date is the one thing wrong
    // and this test cannot pass on the strength of some other required field.
    if (kind.name === 'bill') await page.getByLabel(/^supplier invoice #/i).first().fill('E2E-HDR-1')

    const issue = page.getByLabel(/^issue date/i).first()
    await expect(issue).toBeVisible()
    await issue.fill('')
    await page.getByRole('button', { name: /^save$/i }).first().click()

    // The error is on the date field itself, wherever the layout has put it.
    // (`v-input__control` also contains "v-input", so match the class token, not a substring.)
    const dateControl = issue.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " v-input ")][1]')
    await expect(dateControl.locator('.v-messages__message').filter({ hasText: /required/i })).toBeVisible()
    // Give a (wrong) request time to leave before asserting that none did.
    await page.waitForTimeout(800)
    expect(posts, 'no document was posted with an empty issue date').toEqual([])
    await expect(page).toHaveURL(new RegExp(`/${kind.list}/new$`))
  })
}
