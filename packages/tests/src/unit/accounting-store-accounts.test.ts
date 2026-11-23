import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * The accounting store's `accounts` is the list every account picker looks an account up in (the journal entry's
 * lines, the fixed asset's three accounts, the bank account's ledger account, the general ledger). The API answers a
 * list without `size` with its first page of 10, so on a chart of a few hundred accounts (a books org) an entry's line
 * whose account was not among the first ten showed its raw id in place of the code and name, and could not be picked.
 * The demo orgs hold only a handful of accounts, which is why nobody saw it.
 *
 * The store is bound to Pinia and the app store, and a module mock reaches the whole test process (see
 * `pdf-product-credit.test.ts`), so this reads the source, like `session-keys.test.ts`.
 */

const STORE = resolve(import.meta.dir, '../../../web/src/modules/accounting/store/accounting.store.ts')

describe('the accounting store lists every account', () => {
  it('asks the API for all of them, not its first page', () => {
    const src = readFileSync(STORE, 'utf8')
    const start = src.indexOf('async function fetchAccounts()')
    expect(start).toBeGreaterThan(-1)
    // up to the next function of the store
    const body = src.slice(start, src.indexOf('async function', start + 10))
    expect(body).toContain('/accounting/account`')
    expect(body).toMatch(/params:\s*\{\s*size:\s*0\s*\}/)
  })
})
