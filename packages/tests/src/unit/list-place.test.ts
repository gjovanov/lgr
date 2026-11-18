import { describe, it, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

/**
 * FR-31 B3 (#796): lists keep their place, and three more lists are on the shared list shell.
 *
 * - FR-31.18: seventeen lists kept nothing in the address. Back from a record (the browser's, or a form's own Back)
 *   opened page one without the search or the filter. Every list on `usePaginatedTable` now writes its page, page size
 *   and sort to the address (`urlSync: true`), and each filter a person can set goes there too (`useListQueryState`),
 *   declared before the table so the first fetch already has it.
 * - FR-31.19: Movements, Stock levels and Inventory counts are on `ListScaffold`, so they have the column picker and the
 *   remembered columns. Their route names (which key the column choice) and their addresses do not change. Movements no
 *   longer fetches a contact list nothing on the page read.
 */

const PACKAGES = resolve(import.meta.dir, '../../..')
const read = (rel: string) => readFileSync(join(PACKAGES, rel), 'utf8')

/** §1.9's seventeen lists. */
const SEVENTEEN = [
  'inventory-ui/src/views/CategoriesView.vue',
  'inventory-ui/src/views/WarehousesView.vue',
  'inventory-ui/src/views/PriceListsView.vue',
  'accounting-ui/src/views/accounting/AccountsView.vue',
  'accounting-ui/src/views/accounting/BankAccountsView.vue',
  'accounting-ui/src/views/accounting/ExchangeRatesView.vue',
  'accounting-ui/src/views/accounting/FixedAssetsView.vue',
  'accounting-ui/src/views/accounting/VatReturnsView.vue',
  'payroll-ui/src/views/payroll/EmployeesView.vue',
  'payroll-ui/src/views/payroll/PayrollRunsView.vue',
  'payroll-ui/src/views/payroll/PayslipsView.vue',
  'payroll-ui/src/views/payroll/TimesheetsView.vue',
  'invoicing-ui/src/pos/views/PosDevicesView.vue',
  'invoicing-ui/src/pos/views/PosSessionsView.vue',
  'portal-ui/src/views/settings/UsersView.vue',
  'portal-ui/src/views/settings/InvitesView.vue',
  'portal-ui/src/views/settings/DesktopsView.vue',
]

/** Tables on `usePaginatedTable` that are not a page's list, so they keep nothing in the address. */
const NOT_A_LIST: Record<string, string> = {
  'ui-shared/src/components/ContactPickerDialog.vue': 'a picker dialog: it must never touch the address of the page under it',
  'accounting-ui/src/views/accounting/VatReturnView.vue': "one month's rows inside the return's own page, whose address is the month",
}

/** The text of the call `name(` … `)` starting at `from`, its parentheses balanced; null when there is none. */
function callAt(text: string, name: string, from = 0): { start: number; body: string } | null {
  const start = text.indexOf(`${name}(`, from)
  if (start < 0) return null
  let depth = 0
  for (let i = start + name.length; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return { start, body: text.slice(start, i + 1) }
  }
  return null
}

const scriptOf = (sfc: string) => sfc.slice(sfc.indexOf('<script'))
const templateOf = (sfc: string) => sfc.slice(0, sfc.indexOf('<script'))

function* vueSources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* vueSources(path)
    else if (name.endsWith('.vue')) yield path
  }
}

describe('FR-31.18: a list keeps its place in the address', () => {
  it('every list on usePaginatedTable syncs its page, size and sort (`urlSync: true`)', () => {
    const roots = readdirSync(PACKAGES).filter(p => p.endsWith('-ui') || p === 'ui-shared' || p === 'ui-shell').map(p => join(PACKAGES, p, 'src')).filter(existsSync)
    const unsynced: string[] = []
    let tables = 0
    for (const root of roots) {
      for (const file of vueSources(root)) {
        const rel = relative(PACKAGES, file).replace(/\\/g, '/')
        const call = callAt(scriptOf(readFileSync(file, 'utf8')), 'usePaginatedTable')
        if (!call) continue
        tables++
        if (rel in NOT_A_LIST) continue
        if (!/\burlSync:\s*true\b/.test(call.body)) unsynced.push(rel)
      }
    }
    expect(unsynced).toEqual([])
    expect(tables).toBeGreaterThan(30)
    // The exceptions are still tables of that kind; one that is gone leaves the list.
    for (const rel of Object.keys(NOT_A_LIST)) expect({ rel, table: !!callAt(scriptOf(read(rel)), 'usePaginatedTable') }).toEqual({ rel, table: true })
  })

  for (const rel of SEVENTEEN) {
    it(`${rel}: synced, and every filter a person can set is in the address, declared before the table`, () => {
      const sfc = read(rel)
      const script = scriptOf(sfc)
      const table = callAt(script, 'usePaginatedTable')!
      expect(table).not.toBeNull()
      expect(table.body).toMatch(/\burlSync:\s*true\b/)

      const filters = callAt(script, 'const filters = computed')
      if (!filters) return // a list without filters: page, size and sort are all it has
      // The refs the request's filters read, a debounced search under the field it mirrors.
      const used = new Set([...filters.body.matchAll(/\b(\w+)\.value\b/g)].map(m => (m[1] === 'debouncedSearch' ? 'search' : m[1])))
      // The ones a control on the page sets. A filter nothing on the page sets cannot be lost, and stays out.
      const settable = new Set([...templateOf(sfc).matchAll(/v-model="(\w+)"/g)].map(m => m[1]))
      const state = callAt(script, 'useListQueryState')
      expect({ rel, state: !!state }).toEqual({ rel, state: true })
      const synced = new Set([...state!.body.matchAll(/\bref:\s*(\w+)/g)].map(m => m[1]))
      const missing = [...used].filter(r => settable.has(r) && !synced.has(r))
      expect({ rel, missing }).toEqual({ rel, missing: [] })
      // Declared before the table, so its first fetch has the address's values and no filter watch fires a second one.
      expect({ rel, before: state!.start < table.start }).toEqual({ rel, before: true })
    })
  }
})

describe('FR-31.19: Movements, Stock levels and Inventory counts on the shared list shell', () => {
  const MOVED: Array<{ rel: string; route: string; keys: string[] }> = [
    {
      rel: 'inventory-ui/src/views/MovementsView.vue',
      route: "{ path: 'movements', name: 'inventory.movements', component: () => import('./views/MovementsView.vue') }",
      keys: ['q', 'type', 'status', 'warehouse', 'from', 'to', 'view', 'pq', 'pcategory', 'ptype', 'ptags', 'pstatus'],
    },
    {
      rel: 'inventory-ui/src/views/StockLevelsView.vue',
      route: "{ path: 'stock-levels', name: 'inventory.stock-levels', component: () => import('./views/StockLevelsView.vue') }",
      keys: ['q', 'warehouse', 'category', 'tags', 'low'],
    },
    {
      rel: 'inventory-ui/src/views/InventoryCountView.vue',
      route: "{ path: 'inventory-counts', name: 'inventory.inventory-counts', component: () => import('./views/InventoryCountView.vue') }",
      keys: ['q'],
    },
  ]
  const manifest = read('inventory-ui/src/manifest.ts')

  for (const { rel, route, keys } of MOVED) {
    it(`${rel}: on ListScaffold, under the same route name, with the same address`, () => {
      const sfc = read(rel)
      expect(templateOf(sfc)).toContain('<ListScaffold')
      // The shell draws the table, with the column picker; a table of its own would have neither.
      expect(templateOf(sfc)).not.toContain('<v-data-table-server')
      // The column choice is keyed by the route name, and the e2e suite navigates by it.
      expect(manifest).toContain(route)
      // The same keys in the address as before the move, and the page, size and sort beside them.
      const state = callAt(scriptOf(sfc), 'useListQueryState')!
      expect([...state.body.matchAll(/\bkey:\s*'(\w+)'/g)].map(m => m[1])).toEqual(keys)
      expect(callAt(scriptOf(sfc), 'usePaginatedTable')!.body).toMatch(/\burlSync:\s*true\b/)
    })
  }

  it('Movements fetches no contact list, shows no raw dates and keeps its tick column and the e-mail bar', () => {
    const sfc = read('inventory-ui/src/views/MovementsView.vue')
    expect(sfc).not.toContain('/invoicing/contact`')
    expect(sfc).not.toMatch(/\bfetchContacts\b|\bcontacts\.value\b/)
    expect(sfc).not.toMatch(/split\('T'\)/)
    expect(templateOf(sfc)).toMatch(/<ListScaffold[^>]*\bselectable\b/)
    expect(templateOf(sfc)).toMatch(/<template #bulk-bar>\s*<BatchEmailBar/)
    // The list's own testid on the shell's title row, which the fit test measures.
    expect(templateOf(sfc)).toContain('header-testid="movements-header"')
  })
})
