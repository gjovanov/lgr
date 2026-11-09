import { describe, it, expect } from 'bun:test'
import { AREAS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES } from 'config/constants'
import {
  APP_NAV_META, isTillOnly, isTransferOnly, landingWithoutPortal, runsDevices, writesInventory, type PageViewer,
} from 'ui-shared/nav/page-registry'
import { canStornoJournalRow, canStornoTransaction } from 'ui-shared/cash-register/storno'

/**
 * FR-27 P0-6 (#529) — the client's helpers on the grant answer as the role and permission checks they replaced,
 * written out here as they were, for every role × no, each single and its default permissions × areas absent,
 * `[]` and all × a PIN sign-in.
 */

const INVOICING = ['invoicing.read', 'invoicing.write', 'invoicing.send']
const READ_WITH_INVENTORY = [...INVOICING, 'inventory.read', 'inventory.write', 'inventory.adjust']
const READ_TILL = ['pos.read', 'pos.write']
const holds = (w: PageViewer, ps: readonly string[]) => ps.some(p => (w.permissions ?? []).includes(p))

const OLD = {
  isTillOnly: (w: PageViewer) => !!w.amr?.includes('pin') || (w.role !== 'admin' && !holds(w, READ_WITH_INVENTORY) && holds(w, READ_TILL)),
  isTransferOnly: (w: PageViewer) => w.role !== 'admin' && holds(w, ['inventory.transfer']) && !holds(w, ['inventory.write']),
  writesInventory: (w: PageViewer) => w.role === 'admin' || holds(w, ['inventory.write']),
  runsDevices: (w: PageViewer) => ['admin', 'manager', 'warehouse_manager'].includes(w.role ?? ''),
  // Before #493 item 3's Products first: the first app the session opens.
  firstApp: (w: PageViewer) => {
    for (const [, meta] of Object.entries(APP_NAV_META)) {
      if (w.role === 'admin' || holds(w, meta.reads ?? [meta.permission])) return `${meta.base}/`
    }
    return '/account'
  },
  storno: (w: PageViewer) => ['admin', 'manager'].includes(w.role ?? ''),
}

function shapes(): PageViewer[] {
  const out: PageViewer[] = []
  for (const role of ROLES) {
    for (const permissions of [[], ...PERMISSIONS.map(p => [p]), [...DEFAULT_ROLE_PERMISSIONS[role]]]) {
      for (const areas of [undefined, [], [...AREAS]]) out.push({ role, permissions: [...permissions], ...(areas ? { areas: [...areas] } : {}) })
    }
    out.push({ role, permissions: [...DEFAULT_ROLE_PERMISSIONS[role]], amr: ['pin'] })
  }
  return out
}
const label = (w: PageViewer) => `${w.role} [${(w.permissions ?? []).join(',')}] areas=${w.areas ? `[${w.areas.join(',')}]` : 'absent'}${w.amr ? ' pin' : ''}`

describe('FR-27 P0-6: the client helpers answer as before', () => {
  const cases: Array<[string, (w: PageViewer) => boolean, (w: PageViewer) => boolean]> = [
    ['isTillOnly', isTillOnly, OLD.isTillOnly],
    ['isTransferOnly', isTransferOnly, OLD.isTransferOnly],
    ['writesInventory', writesInventory, OLD.writesInventory],
    ['runsDevices', runsDevices, OLD.runsDevices],
  ]
  for (const [name, now, before] of cases) {
    it(name, () => {
      expect(shapes().filter(w => now(w) !== before(w)).map(label)).toEqual([])
    })
  }

  it('landingWithoutPortal: Products where the session opens them (#493 item 3), else the first app, as before', () => {
    const differences = shapes().filter(w => !w.amr).filter(w => {
      const opensProducts = w.role === 'admin' || holds(w, ['inventory.read'])
      return landingWithoutPortal(w) !== (opensProducts ? '/inventory/products' : OLD.firstApp(w))
    })
    expect(differences.map(label)).toEqual([])
  })

  it('the storno buttons: the storno roles, given a role or a session', () => {
    const sale = { type: 'sale', status: 'completed' }
    const row = { kind: 'sale', status: 'completed', origin: 'pos' }
    for (const w of shapes()) {
      expect({ w: label(w), v: canStornoTransaction(sale, w.role) }).toEqual({ w: label(w), v: OLD.storno(w) })
      expect({ w: label(w), v: canStornoJournalRow(row, w.role) }).toEqual({ w: label(w), v: OLD.storno(w) })
    }
  })
})
