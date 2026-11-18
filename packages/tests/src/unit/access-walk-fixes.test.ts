import { describe, it, expect } from 'bun:test'
import { ROLES } from 'config/constants'
import { EDITOR_FEATURES, ROLE_TEMPLATES, beyondLevel, canOpen, levelOf, levelsOf, offersLevel, templateDefaults, templateGrant, withImplied, type CapabilityId, type Grant } from 'config/access'
import { targetRefusal } from 'services/biz/doc-import/target-access'
import { PAGE_REGISTRY, canOpenPage, startPage } from 'ui-shared/nav/page-registry'

/** A built-in role's session viewer (FR-27 P3-6: a viewer is its grant). */
const as = (r: string) => ({ grant: templateGrant(r) })

/**
 * What the FR-27 acceptance-4 walk (`e2e/tests/field-walk-roles.spec.ts`) found, held here.
 *
 * - An import is decided by what its target needs. In an org on `roles`, by the role's capabilities: its token's
 *   permissions are its legacy projection, which may say less than the role. On the legacy model, as before.
 * - The two invoicing pages that moved into Reports open only for a role that reads what they show: Reports alone
 *   opened them, and their data answered 403 (the HR Manager, the Warehouse Manager).
 * - The editor ticks only a level it offers (the acceptance-3 walk could not tick cash sales' Full: Work is already
 *   everything there), and its ticks give every built-in role back exactly.
 * - A role that does not open the Dashboard starts on the first page it opens, not on the Dashboard, whose summary
 *   answers it 403 (FR-27.7's landing rule; the HR Manager).
 *
 * NOTE: no `.rejects` / `.resolves` (Known Issues).
 */

const role = (...caps: string[]) => ({ role: 'member', permissions: [] as string[], access: { caps: new Set(caps as CapabilityId[]) } as Grant })

describe('an import is decided by what its target needs', () => {
  it('a role: its capabilities, whatever its projection says', () => {
    // A purchasing clerk: bills, no sales documents. Its projection holds no `invoicing.write`.
    const clerk = role('bills.view', 'bills.create')
    expect(targetRefusal(clerk, 'bill')).toBeNull()
    expect(targetRefusal(clerk, 'sales_invoice')).toMatchObject({ code: 'capability_required', capabilities: ['sales-docs.create', 'sales-docs.import'] })
    expect(targetRefusal(clerk, 'movement')).toMatchObject({ capabilities: ['movements.create'] })
    // The Seller's shape: sells, imports nothing (#493 item 5).
    const seller = role('sales-docs.view', 'sales-docs.create', 'movements.create:transfer')
    expect(targetRefusal(seller, 'sales_invoice')).toMatchObject({ capabilities: ['sales-docs.import'] })
    expect(targetRefusal(seller, 'cash_sale')).toMatchObject({ capabilities: ['sales-docs.import'] })
    expect(targetRefusal(seller, 'movement')).toMatchObject({ capabilities: ['movements.create'] })
    expect(targetRefusal(role('movements.create'), 'movement')).toBeNull()
    expect(targetRefusal(role('sales-docs.create', 'sales-docs.import'), 'cash_sale')).toBeNull()
    expect(targetRefusal({ role: 'admin', permissions: [], access: { all: true } as Grant }, 'bill')).toBeNull()
  })

  it('FR-27 P3-6: a caller without a grant imports nothing; the built-in roles as their templates say', () => {
    expect(targetRefusal({ id: 'u' }, 'sales_invoice')).toMatchObject({ code: 'capability_required' })
    const of = (r: string) => ({ access: templateGrant(r) })
    expect(targetRefusal(of('sales'), 'sales_invoice')).toBeNull()
    expect(targetRefusal(of('sales'), 'bill')).toBeNull()
    expect(targetRefusal(of('sales'), 'movement')).toMatchObject({ code: 'capability_required', capabilities: ['movements.create'] })
    expect(targetRefusal(of('sales_consultant'), 'bill')).toMatchObject({ code: 'capability_required', capabilities: ['bills.create'] })
    expect(targetRefusal(of('seller'), 'sales_invoice')).toMatchObject({ code: 'capability_required' })
    expect(targetRefusal(of('warehouse_manager'), 'movement')).toBeNull()
  })
})

describe('the reports that read invoices open only where invoices are read', () => {
  const pages = ['/reports/aging', '/reports/export']

  it('Reports alone does not open them; Reports and the invoices do', () => {
    for (const id of pages) {
      expect(canOpen(id, { caps: new Set(['reports.view'] as CapabilityId[]) })).toBe(false)
    }
    expect(canOpen('/reports/aging', { caps: new Set(['reports.view', 'sales-docs.view'] as CapabilityId[]) })).toBe(true)
    expect(canOpen('/reports/export', { caps: new Set(['reports.view', 'sales-docs.export'] as CapabilityId[]) })).toBe(true)
    // The invoices alone do not open a page of Reports either.
    expect(canOpen('/reports/aging', { caps: new Set(['sales-docs.view'] as CapabilityId[]) })).toBe(false)
    expect(canOpen('/reports/aging', { all: true })).toBe(true)
  })

  it('for every built-in role, the menus answer as the page rule, and the HR and warehouse managers open neither', () => {
    for (const r of ROLES) {
      for (const id of pages) {
        const page = PAGE_REGISTRY.find(p => p.id === id)!
        expect(canOpenPage(page, as(r))).toBe(canOpen(id, templateGrant(r)))
      }
    }
    for (const r of ['hr_manager', 'warehouse_manager']) {
      for (const id of pages) expect({ r, id, opens: canOpen(id, templateGrant(r)) }).toEqual({ r, id, opens: false })
    }
  })
})

describe('the start page is one the role opens', () => {
  it('the HR Manager, who opens no Dashboard, starts in its own app; a reader of invoices on the Dashboard', () => {
    const hr = as('hr_manager')
    expect(canOpen('/dashboard', hr.grant)).toBe(false)
    expect(startPage(hr)).not.toBe('/dashboard')
    expect(startPage(hr)).toMatch(/^\/(payroll|reports)\//)
    expect(startPage({ grant: { caps: new Set(['sales-docs.view', 'dashboard.view'] as CapabilityId[]) } })).toBe('/dashboard')
    expect(startPage({ grant: { all: true } })).toBe('/dashboard')
  })

  it('for every default role: the Dashboard exactly when the role opens it', () => {
    for (const r of ROLES) {
      const opens = canOpen('/dashboard', templateGrant(r))
      expect({ r, dashboard: startPage(as(r)) === '/dashboard' }).toEqual({ r, dashboard: opens })
    }
  })
})

describe('the role editor: the level it ticks is one it offers, and the ticks give the role back', () => {
  it('for every built-in role, as it is and as a new role starts', () => {
    for (const t of ROLE_TEMPLATES) {
      for (const g of [templateGrant(t.key), templateDefaults(t.key)]) {
        if (g.all) continue
        const ticked = new Set<CapabilityId>()
        for (const f of EDITOR_FEATURES) {
          const level = levelOf(f, g)
          expect({ role: t.key, feature: f.id, level, offered: offersLevel(f, level) }).toEqual({ role: t.key, feature: f.id, level, offered: true })
          if (level !== 'none') for (const c of levelsOf(f)[level]) ticked.add(c)
          for (const c of beyondLevel(f, g)) ticked.add(c)
        }
        expect({ role: t.key, caps: withImplied(ticked) }).toEqual({ role: t.key, caps: [...g.caps].sort() })
      }
    }
  })

  it('the Administrator: the largest level offered on every feature', () => {
    for (const f of EDITOR_FEATURES) expect(offersLevel(f, levelOf(f, { all: true }))).toBe(true)
  })
})
