import { describe, it, expect } from 'bun:test'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { currentAppId, orgSlugFromName, switchLanding } from 'ui-shared/session/useOrgSession'

/**
 * The new-org dialog suggests the org's address from its name. The server takes only lowercase
 * letters, digits and dashes, and LGR's orgs are mostly named in Cyrillic, so a suggestion that
 * dropped every Cyrillic letter would leave the field empty for exactly the people who use it.
 */
describe('orgSlugFromName', () => {
  it('transliterates Bulgarian and Macedonian names', () => {
    expect(orgSlugFromName('Регал Пловдив')).toBe('regal-plovdiv')
    expect(orgSlugFromName('Щастие ООД')).toBe('shtastie-ood')
    expect(orgSlugFromName('Ѓорѓи Њушки')).toBe('gjorgji-njushki')
  })

  it('keeps what the server accepts and collapses the rest', () => {
    expect(orgSlugFromName('  Acme & Co.  ')).toBe('acme-co')
    expect(orgSlugFromName('Müller GmbH')).toBe('muller-gmbh')
    expect(orgSlugFromName('A--B__C')).toBe('a-b-c')
    expect(orgSlugFromName('!!!')).toBe('')
  })

  it('never ends in a dash, even when cut to the server\'s 50 characters', () => {
    const slug = orgSlugFromName(`${'a'.repeat(49)} b`)
    expect(slug.length).toBeLessThanOrEqual(50)
    expect(slug.endsWith('-')).toBe(false)
    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(orgSlugFromName('Регал - Пловдив / Склад 2'))).toBe(true)
  })
})

describe('where an org switch lands', () => {
  const accountant = { role: 'accountant', permissions: DEFAULT_ROLE_PERMISSIONS.accountant }
  const sales = { role: 'sales', permissions: DEFAULT_ROLE_PERMISSIONS.sales }
  const land = (here: string, who: any, over = {}) => switchLanding(here, { hasRouteParams: false, appEnabled: true, who, ...over })

  it('the same page, when the person may open it in the new org', () => {
    expect(land('/invoicing/invoices', accountant)).toBe('/invoicing/invoices')
    expect(land('/invoicing/cash-sales', accountant)).toBe('/invoicing/cash-sales')
    expect(land('/invoicing/cash-sales/new', sales)).toBe('/invoicing/cash-sales/new')
    expect(land('/invoicing/cash-register/sessions', sales)).toBe('/invoicing/cash-register/sessions')
  })

  // The tile is the app's, and the terminal is a page of it: `sales` in one org, `accountant` in the
  // next, and the person used to sit on a terminal whose every call was refused.
  it('the app\'s home, when the page is not theirs there, though the app is', () => {
    expect(land('/invoicing/cash-sales/new', accountant)).toBe('/invoicing/')
    expect(land('/invoicing/cash-register/sessions', accountant)).toBe('/invoicing/')
    expect(land('/invoicing/configuration/devices', accountant)).toBe('/invoicing/')
    expect(land('/invoicing/invoices/new', { role: 'member', permissions: DEFAULT_ROLE_PERMISSIONS.member })).toBe('/invoicing/')
  })

  it('the app\'s home, when the page names something of the old org', () => {
    expect(land('/invoicing/invoices/6a1b/edit', accountant, { hasRouteParams: true })).toBe('/invoicing/')
  })

  it('the App Hub, when the app is not theirs there', () => {
    expect(land('/invoicing/invoices', accountant, { appEnabled: false })).toBe('/apps')
  })

  it('a portal page keeps to its own rule', () => {
    expect(land('/settings/users', accountant, { appEnabled: false })).toBe('/settings/users')
    expect(land('/settings/users/1', accountant, { appEnabled: false, hasRouteParams: true })).toBe('/apps')
  })
})

describe('currentAppId', () => {
  it('names the domain app a path belongs to, and the portal for everything else', () => {
    expect(currentAppId('/invoicing/invoices')).toBe('invoicing')
    // The till's pages are the invoicing app's, and so is the address they had in it for a while.
    expect(currentAppId('/invoicing/cash-sales/new')).toBe('invoicing')
    expect(currentAppId('/invoicing/pos/terminal')).toBe('invoicing')
    expect(currentAppId('/reports')).toBe('reports')
    expect(currentAppId('/apps')).toBe('portal')
    expect(currentAppId('/settings/users')).toBe('portal')
    // A prefix is not an app: `/reportsX` is not Reports.
    expect(currentAppId('/reportsX')).toBe('portal')
  })
})
