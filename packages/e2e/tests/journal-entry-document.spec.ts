import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiGet, apiDelete } from './helpers/api'
import { openSelect } from './helpers/vuetify'

/**
 * The journal entry form's Document card (FR-25a §3.6), for an entry made in LGR: the document it books, how that is
 * paid and its VAT, saved with the entry, shown again, changed, and found by the journal's filters. An entry the books
 * import wrote is another matter (as booked, read-only) and needs imported books, which the seed does not hold.
 *
 * ⚠ Two things here have no other check in the suite:
 *   - a folded card is still part of the entry: the entry is saved with what the card holds, and a save the header's
 *     rules refuse opens the card and says why, with nothing sent;
 *   - the lines' account picker holds the whole chart. The API answers ten accounts a page, and a picker fed from one
 *     page offered those ten and showed every other account as its raw id.
 */
test.describe('Journal entry document', () => {
  test.describe.configure({ mode: 'serial' })

  const stamp = Date.now().toString(36)
  const reference = `E2E-JE-${stamp}`
  const description = `E2E document ${stamp}`
  // Neither is on the API's first page of the chart (ten accounts, by code): the first test holds that true.
  const DEBIT = '5900 - Bank Charges'
  const CREDIT = '2000 - Accounts Payable'
  let session: any
  let entryId = ''

  test.beforeAll(async () => {
    session = await apiLogin()
  })

  test.afterAll(async () => {
    // Never posted, so still a draft: the route deletes it.
    if (entryId) await apiDelete(session, `/accounting/journal/${entryId}`)
  })

  const cardOf = (page: any) => page.getByTestId('journal-document-card')

  /** The lines. Not the rows of the page's first table once the card holds a link: the links are a table too. */
  const linesOf = (page: any) => page.locator('.v-table')
    .filter({ has: page.getByRole('columnheader', { name: 'Account', exact: true }) })
    .locator('tbody tr')

  /** A line's account: a plain select over the whole chart, and typing a code goes to it as in any select. */
  async function pickLineAccount(page: any, row: any, option: string) {
    await row.locator('.v-select input').focus()
    await page.keyboard.type(option.slice(0, 4))
    await expect(row.locator('.v-select')).toContainText(option)
  }

  /** One option of a select or a combobox. */
  async function choose(page: any, scope: any, label: RegExp, option: string) {
    await openSelect(scope, label)
    await page.getByRole('option', { name: option, exact: true }).click()
  }

  /** The Save the form shell offers, and the answer of the route it calls. */
  async function saveAndWait(page: any, method: 'POST' | 'PUT') {
    const [response] = await Promise.all([
      page.waitForResponse((r: any) => r.request().method() === method && /\/accounting\/journal(\/[0-9a-f]{24})?$/.test(new URL(r.url()).pathname)),
      page.getByRole('button', { name: /^save$/i }).first().click(),
    ])
    return response
  }

  /** How many entries of this spec the journal answers under a filter. */
  const listed = async (query: string) => (await apiGet(session, `/accounting/journal?search=${encodeURIComponent(stamp)}&${query}`)).total

  test('an entry is made with its document, its payment and its VAT', async ({ page }) => {
    const firstPage: string[] = (await apiGet(session, '/accounting/account')).accounts.map((a: any) => a.code)
    expect(firstPage).toHaveLength(10)
    expect(firstPage).not.toContain(DEBIT.slice(0, 4))
    expect(firstPage).not.toContain(CREDIT.slice(0, 4))

    await loginForApp(page)
    await page.goto('/accounting/journal-entries/new')
    await expect(page.getByRole('heading', { name: /new journal entry/i })).toBeVisible({ timeout: 15000 })

    await page.getByLabel(/^date$/i).first().fill('2026-03-10')
    await page.getByLabel(/^reference$/i).fill(reference)
    await page.getByLabel(/^description$/i).first().fill(description)

    // A new entry says nothing of a document yet, so its card starts folded.
    const card = cardOf(page)
    await expect(card).toHaveAttribute('data-open', 'false')
    await card.getByTestId('panel-toggle').click()
    await expect(card).toHaveAttribute('data-open', 'true')

    await choose(page, card, /^document type$/i, '-Ф')
    await card.getByLabel(/^document number$/i).fill('0000000123')
    await card.getByLabel(/^document date$/i).fill('2026-03-09')
    await choose(page, card, /^register type$/i, '01 · Invoice')
    await choose(page, card, /^paid by$/i, 'Bank')
    await card.getByLabel(/^paid$/i).fill('120')
    await card.getByLabel(/^paid in cash$/i).fill('20')
    await card.getByLabel(/^bank operation$/i).fill('BT-77')
    await card.getByLabel(/^vat kind$/i).fill('standard')
    await choose(page, card, /^vat rate$/i, '20%')
    await card.getByLabel(/^vat rule$/i).fill('art. 12')
    await card.getByLabel(/^tax event date$/i).fill('2026-03-09')
    // Declared in its own month: not "another month" yet.
    await card.getByLabel(/^declared in$/i).fill('2026-03')

    await card.getByTestId('add-link').click()
    const link = card.getByTestId('journal-links').locator('tbody tr')
    await link.getByLabel('Type', { exact: true }).fill('+Ф')
    await link.getByLabel('Number', { exact: true }).fill('45')
    await link.getByLabel('Date', { exact: true }).fill('2026-02-27')
    await link.getByLabel('Amount', { exact: true }).fill('60')

    await page.getByRole('button', { name: /add line/i }).click()
    await page.getByRole('button', { name: /add line/i }).click()
    const lines = linesOf(page)
    await expect(lines).toHaveCount(2)
    await pickLineAccount(page, lines.nth(0), DEBIT)
    await lines.nth(0).locator('input[type="number"]').nth(0).fill('120')
    await pickLineAccount(page, lines.nth(1), CREDIT)
    await lines.nth(1).locator('input[type="number"]').nth(1).fill('120')

    // Folded, the card says in a line what it holds, and the entry is saved with it all the same.
    await card.getByTestId('panel-toggle').click()
    await expect(card.getByTestId('panel-summary')).toHaveText('-Ф 0000000123 · Invoice · Bank · VAT rate 20%')

    const response = await saveAndWait(page, 'POST')
    expect(response.status(), 'the route takes what the form sends').toBe(200)
    const sent = response.request().postDataJSON()
    expect(sent).toMatchObject({
      date: '2026-03-10', reference, description,
      docType: '-Ф', docNumber: '0000000123', docDate: '2026-03-09', registerDocType: '01',
      paymentCode: '2', paidAmount: 120, paidCash: 20, bankOperation: 'BT-77',
      vatKind: 'standard', vatRate: 20, vatRule: 'art. 12', taxEventDate: '2026-03-09', reportingMonth: '202603',
      links: [{ docType: '+Ф', docNumber: '45', date: '2026-02-27', amount: 60, amountFx: null }],
      // What the form leaves empty is sent as cleared.
      reasonRef: null, vatExemptionReason: null, protocolType: null, customsRef: null,
      lines: [{ debit: 120, credit: 0 }, { debit: 0, credit: 120 }],
    })
    const made = (await response.json()).journalEntry
    entryId = String(made?._id ?? made?.id ?? '')
    expect(entryId, 'the answer names the new entry').toMatch(/^[0-9a-f]{24}$/)

    // The form goes back to the journal.
    await page.waitForURL(/\/accounting\/journal-entries(\?.*)?$/, { timeout: 15000 })

    const { journalEntry } = await apiGet(session, `/accounting/journal/${entryId}`)
    expect(journalEntry).toMatchObject({
      status: 'draft', reference, description, totalDebit: 120, totalCredit: 120,
      docType: '-Ф', docNumber: '0000000123', registerDocType: '01', paymentCode: '2', paidAmount: 120, paidCash: 20,
      bankOperation: 'BT-77', vatKind: 'standard', vatRate: 20, vatRule: 'art. 12', reportingMonth: '202603',
      links: [{ docType: '+Ф', docNumber: '45', amount: 60 }],
      // A line typed by hand carries its base amounts: every statement and balance reads those.
      lines: [
        { account: { code: '5900' }, debit: 120, credit: 0, baseDebit: 120, baseCredit: 0 },
        { account: { code: '2000' }, debit: 0, credit: 120, baseDebit: 0, baseCredit: 120 },
      ],
    })
    // Days are kept at UTC midnight.
    expect(String(journalEntry.date).slice(0, 10)).toBe('2026-03-10')
    expect(String(journalEntry.docDate).slice(0, 10)).toBe('2026-03-09')
    expect(String(journalEntry.taxEventDate).slice(0, 10)).toBe('2026-03-09')
    expect(String(journalEntry.links[0].date).slice(0, 10)).toBe('2026-02-27')

    // An invoice paid by bank and declared in its own month: the last test reads the same filters after the edit.
    expect(await listed('payment=bank')).toBe(1)
    expect(await listed('payment=cash')).toBe(0)
    expect(await listed('notices=true')).toBe(0)
    expect(await listed('otherMonth=true')).toBe(0)
  })

  test('the entry opens again with its document, and a notice must say what it corrects', async ({ page }) => {
    await loginForApp(page)
    await page.goto(`/accounting/journal-entries/${entryId}/edit`)
    const card = cardOf(page)
    // It says something of its document, so its card opens; and it is LGR's own, not as booked.
    await expect(card).toHaveAttribute('data-open', 'true', { timeout: 15000 })
    await expect(card.getByTestId('as-booked-chip')).toHaveCount(0)
    await expect(page.getByLabel(/^description$/i).first()).toHaveValue(description)
    await expect(card.getByRole('combobox', { name: /^document type$/i })).toHaveValue('-Ф')
    await expect(card.getByLabel(/^document number$/i)).toHaveValue('0000000123')
    await expect(card.getByLabel(/^document date$/i)).toHaveValue('2026-03-09')
    await expect(card.getByRole('combobox', { name: /^register type$/i })).toHaveValue('01 · Invoice')
    await expect(card.getByRole('combobox', { name: /^paid by$/i })).toHaveValue('Bank')
    await expect(card.getByLabel(/^paid$/i)).toHaveValue('120')
    await expect(card.getByLabel(/^paid in cash$/i)).toHaveValue('20')
    await expect(card.getByRole('combobox', { name: /^vat rate$/i })).toHaveValue('20%')
    await expect(card.getByLabel(/^tax event date$/i)).toHaveValue('2026-03-09')
    await expect(card.getByLabel(/^declared in$/i)).toHaveValue('2026-03')
    const link = card.getByTestId('journal-links').locator('tbody tr')
    await expect(link.getByLabel('Number', { exact: true })).toHaveValue('45')
    await expect(link.getByLabel('Date', { exact: true })).toHaveValue('2026-02-27')
    await expect(link.getByLabel('Amount', { exact: true })).toHaveValue('60')
    // The lines name their accounts: one the picker does not hold shows as its raw id.
    const lines = linesOf(page)
    await expect(lines).toHaveCount(2)
    await expect(lines.nth(0).locator('.v-select')).toContainText(DEBIT)
    await expect(lines.nth(1).locator('.v-select')).toContainText(CREDIT)

    // A credit notice says which invoice it corrects. The card flags it before anything is sent, folded or not.
    await choose(page, card, /^register type$/i, '03 · Credit notice')
    await expect(card.getByTestId('panel-flag')).toContainText('1 to check')
    await card.getByTestId('panel-toggle').click()
    await expect(card).toHaveAttribute('data-open', 'false')
    await expect(card.getByTestId('panel-flag')).toBeVisible()

    let puts = 0
    page.on('request', (r: any) => {
      if (r.method() === 'PUT' && /\/accounting\/journal\//.test(r.url())) puts++
    })
    await page.getByRole('button', { name: /^save$/i }).first().click()
    // The card of the refused field opens, and the field says why.
    await expect(card).toHaveAttribute('data-open', 'true')
    await expect(card.getByText('A notice states the invoice it corrects.')).toBeVisible()
    expect(puts, 'a header the rules refuse is not sent').toBe(0)
    await expect(page).toHaveURL(new RegExp(`/accounting/journal-entries/${entryId}/edit$`))

    await card.getByLabel(/^corrects$/i).fill('0000000100')
    await expect(card.getByTestId('panel-flag')).toHaveCount(0)
    // Declared a month later, and no part of it in cash any more.
    await card.getByLabel(/^declared in$/i).fill('2026-04')
    await card.getByLabel(/^paid in cash$/i).fill('')

    const response = await saveAndWait(page, 'PUT')
    expect(response.status(), 'the route takes what the form sends').toBe(200)
    expect(response.request().postDataJSON()).toMatchObject({
      registerDocType: '03', reasonRef: '0000000100', reportingMonth: '202604', paidAmount: 120,
      // An emptied field is sent as cleared, and the server removes it.
      paidCash: null,
      links: [{ docType: '+Ф', docNumber: '45', date: '2026-02-27', amount: 60, amountFx: null }],
    })

    const { journalEntry } = await apiGet(session, `/accounting/journal/${entryId}`)
    expect(journalEntry).toMatchObject({
      status: 'draft', reference, description, totalDebit: 120, totalCredit: 120,
      docType: '-Ф', docNumber: '0000000123', registerDocType: '03', reasonRef: '0000000100', reportingMonth: '202604',
      paymentCode: '2', paidAmount: 120, vatRate: 20,
      links: [{ docType: '+Ф', docNumber: '45', amount: 60 }],
      lines: [{ account: { code: '5900' }, debit: 120 }, { account: { code: '2000' }, credit: 120 }],
    })
    expect(journalEntry).not.toHaveProperty('paidCash')
  })

  test('the journal finds it by how it is paid, as a notice and by the month it is declared in', async ({ page }) => {
    // A filter that is ignored answers the whole list, so each is read against its opposite. The first test read these
    // on an invoice declared in its own month; the edit made it a notice declared in another.
    expect(await listed('payment=bank')).toBe(1)
    expect(await listed('payment=cash')).toBe(0)
    expect(await listed('notices=true')).toBe(1)
    expect(await listed('otherMonth=true')).toBe(1)
    // An entry made here states no document total, so nothing of it is open.
    expect(await listed('unpaid=true')).toBe(0)

    await loginForApp(page)
    await page.goto('/accounting/journal-entries')
    await expect(page.getByRole('heading', { name: /journal entries/i })).toBeVisible({ timeout: 15000 })
    await page.getByLabel(/^search$/i).fill(stamp)
    const row = page.locator('.v-data-table tbody tr').filter({ hasText: description })
    await expect(row).toHaveCount(1, { timeout: 15000 })

    // The page's own filters reach the list request.
    await choose(page, page, /^payment$/i, 'Cash')
    await expect(row).toHaveCount(0, { timeout: 15000 })
    await choose(page, page, /^payment$/i, 'Bank')
    await expect(row).toHaveCount(1, { timeout: 15000 })
    for (const [label, param] of [[/^notices only$/i, 'notices'], [/^declared in another month$/i, 'otherMonth']] as const) {
      const [request] = await Promise.all([
        page.waitForRequest((r: any) => new URL(r.url()).pathname.endsWith('/accounting/journal') && new URL(r.url()).searchParams.get(param) === 'true'),
        page.getByLabel(label).check(),
      ])
      expect(request.method()).toBe('GET')
      await expect(row).toHaveCount(1, { timeout: 15000 })
    }
    await page.getByLabel(/^unpaid$/i).check()
    await expect(row).toHaveCount(0, { timeout: 15000 })
  })
})
