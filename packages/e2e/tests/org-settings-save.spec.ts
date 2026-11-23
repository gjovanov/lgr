import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/login'
import { apiGet, apiLogin, apiPut } from './helpers/api'

/**
 * Settings → Organization, saved by the person at the page.
 *
 * - FR-25a §3.7: the company's representative (МОЛ), the town its documents are issued in and its activity code are
 *   stored as typed, without the spaces around them; one cleared is removed; an activity code that is not one is
 *   refused in the form, with nothing sent.
 * - What a save must not do: change a setting the page has no control for. The page sends part of several settings
 *   blocks, and a save used to remove the rest of each block: the tax number's label and the default VAT rate, and the
 *   digest sections the page does not list. Read back, the loss did not show, because a missing key reads as the
 *   model's default. So this plants values that are NOT the defaults before the page saves.
 *
 * The org is the suite's shared one: what is planted or typed here is put back when the spec ends.
 * `integration/org-settings-save.flow` holds the route's side, on the stored document.
 *
 * Serial: the second case starts from what the first saved.
 */
test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36)
const representative = `Ivan Petrov ${stamp}`
// Not the model's default for a tax number's label.
const LABEL = `Tax no. ${stamp}`

let admin: Awaited<ReturnType<typeof apiLogin>>
/** The org before this spec, and the org once the spec planted what the page has no control for. */
let before: any
let planted: any

const readOrg = async () => (await apiGet(admin, '')).org

/**
 * An org's settings and company data, to compare two reads of it: without the three fields this spec types, and without
 * the ids of its lists' rows, which a save gives anew.
 */
function comparable(org: any) {
  const strip = (v: any): any => {
    if (Array.isArray(v)) return v.map(strip)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_id' && k !== 'id').map(([k, x]) => [k, strip(x)]))
    return v
  }
  const { settings, name, slug, taxNumber, vatNumber, email, phone, website, addresses, bankDetails } = org
  return strip({ settings, name, slug, taxNumber, vatNumber, email, phone, website, addresses, bankDetails })
}

test.beforeAll(async () => {
  admin = await apiLogin()
  before = await readOrg()
  // Backups is off unless an operator turns it on, and the server's own section is on unless turned off.
  const res = await apiPut(admin, '', {
    settings: { taxConfig: { taxIdLabel: LABEL }, dailyDigest: { sections: { backups: true, server: false } } },
  })
  expect(res.status, 'the values the page has no control for are planted').toBe(200)
  planted = await readOrg()
  expect(planted.settings.taxConfig.taxIdLabel).toBe(LABEL)
  expect(planted.settings.dailyDigest.sections).toMatchObject({ backups: true, server: false })
  // Planting one value of a block left the rest of the block as it was.
  expect(planted.settings.taxConfig.defaultVatRate).toBe(before.settings.taxConfig.defaultVatRate)
  expect(planted.settings.taxConfig.vatRates).toHaveLength(before.settings.taxConfig.vatRates.length)
  expect(planted.settings.dailyDigest.hour).toBe(before.settings.dailyDigest.hour)
})

test.afterAll(async () => {
  if (!before) return
  await apiPut(admin, '', {
    representative: before.representative ?? '',
    placeOfIssue: before.placeOfIssue ?? '',
    activityCode: before.activityCode ?? '',
    settings: {
      taxConfig: { taxIdLabel: before.settings.taxConfig.taxIdLabel },
      dailyDigest: { sections: { backups: before.settings.dailyDigest.sections.backups, server: before.settings.dailyDigest.sections.server } },
    },
  })
})

async function openPage(page: any) {
  await loginAsAdmin(page)
  await page.goto('/settings/organization', { waitUntil: 'networkidle' })
  // The form has loaded once it shows the org's own name.
  await expect(page.getByLabel('Name', { exact: true }).first()).toHaveValue(before.name)
  return {
    representative: page.getByTestId('org-representative').locator('input'),
    placeOfIssue: page.getByTestId('org-place-of-issue').locator('input'),
    activityCode: page.getByTestId('org-activity-code').locator('input'),
  }
}

const isSave = (request: any) => request.method() === 'PUT' && new URL(request.url()).pathname === `/api/org/${admin.orgId}`

/** The page's Save, and the answer of the route it calls. */
async function save(page: any) {
  const [response] = await Promise.all([
    page.waitForResponse((r: any) => isSave(r.request())),
    page.getByRole('button', { name: /^save$/i }).first().click(),
  ])
  return response
}

test('the company\'s representative, town of issue and activity code are saved as typed, and no other setting changes', async ({ page }) => {
  const form = await openPage(page)
  await form.representative.fill(`  ${representative}  `)
  await form.placeOfIssue.fill(' Sofia ')
  await form.activityCode.fill('47.52')

  const response = await save(page)
  expect(response.status(), 'the route takes what the page sends').toBe(200)

  const org = await readOrg()
  expect(org).toMatchObject({ representative, placeOfIssue: 'Sofia', activityCode: '47.52' })
  // What the page has no control for is as it was planted,
  expect(org.settings.taxConfig.taxIdLabel).toBe(LABEL)
  expect(org.settings.taxConfig.defaultVatRate).toBe(before.settings.taxConfig.defaultVatRate)
  expect(org.settings.dailyDigest.sections).toMatchObject({ backups: true, server: false })
  // and so is everything the person did not change: the modules and the payroll block among it, which the page no
  // longer shows or sends (#816).
  expect(comparable(org)).toEqual(comparable(planted))

  // The page shows the three again.
  await page.reload({ waitUntil: 'networkidle' })
  await expect(form.representative).toHaveValue(representative)
  await expect(form.placeOfIssue).toHaveValue('Sofia')
  await expect(form.activityCode).toHaveValue('47.52')
})

test('an activity code that is not one is refused in the form with nothing sent, and a field cleared is removed', async ({ page }) => {
  const form = await openPage(page)
  await expect(form.representative).toHaveValue(representative)

  let saves = 0
  page.on('request', (r: any) => { if (isSave(r)) saves++ })
  await form.activityCode.fill('G47,52')
  await page.getByRole('button', { name: /^save$/i }).first().click()
  await expect(page.getByText(/Digits joined by dots, e\.g\. 47\.52, at most \d+ characters/)).toBeVisible()
  expect(saves, 'a form the rules refuse is not sent').toBe(0)
  expect((await readOrg()).activityCode).toBe('47.52')

  await form.representative.fill('')
  await form.placeOfIssue.fill('   ')
  await form.activityCode.fill('')
  const response = await save(page)
  expect(response.status(), 'the route takes what the page sends').toBe(200)

  // Cleared, the company reads like one that never set them: no empty text is kept.
  const org = await readOrg()
  for (const field of ['representative', 'placeOfIssue', 'activityCode']) expect(field in org, field).toBe(false)
  expect(comparable(org)).toEqual(comparable(planted))
})
