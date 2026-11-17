import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROLES } from 'config/constants'
import {
  CAPABILITIES, CATALOGUE, beyondLevel, can, levelOf, levelsOf, summarize, templateDefaults, templateGrant, type CapabilityId,
} from 'config/access'

/**
 * The owner, 2026-11-12: "Manual price, unavailable for Seller, but available for Sales Consultant."
 *
 * `sales-docs.manual-price`: a sales document line's price TYPED rather than picked from what the price engine offers.
 * Legacy: `invoicing.write` granted it, the Seller's role NAME withheld it, so nobody else's access changed. The built-in
 * templates follow (FR-27 P3-6: the legacy model and its projection are gone; `access-legacy-frozen` pins the templates).
 */

const MANUAL: CapabilityId = 'sales-docs.manual-price'

describe('the capability', () => {
  it('is a Sales documents action, an extra in the editor, and work rather than reading', () => {
    expect(CAPABILITIES.has(MANUAL)).toBe(true)
    const docs = CATALOGUE.find(f => f.id === 'sales-docs')!
    const l = levelsOf(docs)
    expect(l.extras).toContain(MANUAL)
    expect([...l.view, ...l.work, ...l.full]).not.toContain(MANUAL)
    // A role that reads sales documents and may type a price works on them: the summary does not call it read-only.
    const s = summarize({ caps: new Set<CapabilityId>(['sales-docs.view', MANUAL]) })
    expect(s.canCreate).toContain('sales-docs')
    expect(s.readOnly).not.toContain('sales-docs')
  })
})

describe('the built-in roles', () => {
  it('who types a price, by built-in role', () => {
    const holds = Object.fromEntries(ROLES.map(r => [r, can(templateGrant(r), MANUAL)]))
    expect(holds).toEqual({
      admin: true, manager: true, accountant: true, hr_manager: false, warehouse_manager: false,
      sales: true, seller: false, sales_consultant: true, member: false, nra_auditor: false,
    })
  })

  it('a Seller loses nothing else: what the Sales Consultant holds beyond him is the orders and the typed price', () => {
    const seller = templateGrant('seller') as { caps: ReadonlySet<CapabilityId> }
    const consultant = templateGrant('sales_consultant') as { caps: ReadonlySet<CapabilityId> }
    expect([...consultant.caps].filter(c => !seller.caps.has(c)).filter(c => !c.startsWith('orders.')).sort()).toEqual([MANUAL])
  })

  it('the templates follow the legacy roles: the Seller without, the Sales Consultant and Sales with', () => {
    expect(can(templateGrant('seller'), MANUAL)).toBe(false)
    expect(can(templateGrant('sales_consultant'), MANUAL)).toBe(true)
    expect(can(templateGrant('sales'), MANUAL)).toBe(true)
    expect(can(templateGrant('manager'), MANUAL)).toBe(true)
    expect(can(templateGrant('accountant'), MANUAL)).toBe(true)
    // A new organization's roles (FR-27.11.B) start from the template's defaults.
    expect(can(templateDefaults('seller'), MANUAL)).toBe(false)
    expect(can(templateDefaults('sales_consultant'), MANUAL)).toBe(true)
  })

  it('the editor shows it ticked on the Sales Consultant, unticked on the Seller', () => {
    const docs = CATALOGUE.find(f => f.id === 'sales-docs')!
    expect(levelOf(docs, templateGrant('seller'))).toBe(levelOf(docs, templateGrant('sales_consultant')))
    expect(beyondLevel(docs, templateGrant('sales_consultant'))).toContain(MANUAL)
    expect(beyondLevel(docs, templateGrant('seller'))).not.toContain(MANUAL)
  })
})

describe('the words, in four locales', () => {
  const locale = (loc: string) => JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'ui-shared', 'src', 'locales', `${loc}.json`), 'utf8'))
  for (const loc of ['en', 'bg', 'de', 'mk']) {
    it(loc, () => {
      const l = locale(loc)
      expect(typeof l.access.action.manual_price).toBe('string')
      // The hint of a price field that takes only picks.
      expect(typeof l.invoicing.pricePickOnly).toBe('string')
    })
  }
})
