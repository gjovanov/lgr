/**
 * The org that keeps imported books in the e2e database (#814, FR-25a), and what its books hold.
 *
 * `packages/tests/src/helpers/books-org.ts` makes it right after the seed (`scripts/nightly.ts`), through the books
 * import's own writers, and `nightly.ts` then sets `E2E_BOOKS_ORG` for Playwright. The `books` project's specs read it,
 * and skip without that variable: a run on the plain seed has no such org.
 *
 * ⚠ No imports here, ever. The step runs under Bun and imports this file; the specs run under Node and import it too,
 * and neither may pull the other's world in (a spec must never import `services` or `db`).
 *
 * Every name, number and amount is made up.
 */

/** Set by `nightly.ts` once the step has made the org: the books specs run only then. */
export const BOOKS_ORG_ENV = 'E2E_BOOKS_ORG'

export const booksOrgReady = () => !!process.env[BOOKS_ORG_ENV]

/**
 * The books org: a split of one, its own home (`settings.accounting.books.mode: 'books'`, `split.homeOrgId` itself),
 * the shape a store's books take on prod.
 */
export const BOOKS_ORG = {
  slug: 'e2e-books',
  name: 'E2E Books Ltd',
  /** The ЕИК every books file is checked against. */
  eik: '999999999',
  vatNumber: 'BG999999999',
  branchCode: 'BK',
} as const

/** An org of LGR's own (no books) with a few analytics: the only kind of analytic a person may change. */
export const NATIVE_ORG = {
  slug: 'e2e-analytics',
  name: 'E2E Analytics Ltd',
} as const

/**
 * One person, the admin of both orgs, signed in by org slug. A person of its own on purpose: a seeded person given
 * another membership would change what `org-switcher.spec.ts` and others count.
 */
export const BOOKS_ADMIN = {
  email: 'books-admin@lgr.test',
  username: 'books-admin',
  password: 'test123',
  firstName: 'Books',
  lastName: 'Admin',
} as const

/** The chart, as the accountant's export lists it. */
export const BOOKS_CHART = [
  ['101', 'Основен капитал'],
  ['204', 'Машини и оборудване'],
  ['2414', 'Амортизация на машини'],
  ['411', 'Клиенти'],
  ['4531', 'ДДС за покупките'],
  ['4532', 'ДДС за продажбите'],
  ['501', 'Каса'],
  ['503', 'Разплащателна сметка'],
  ['603', 'Разходи за амортизация'],
  ['702', 'Приходи от продажби на стоки'],
] as const

/** The customer of the part-paid invoice. Its МОЛ comes from the analytic's properties. */
export const CUSTOMER = {
  path: 'КЛИЕНТИ:Примерен Клиент ЕООД',
  name: 'Примерен Клиент ЕООД',
  eik: '111111111',
  vatNumber: 'BG111111111',
  representative: 'Иван Примеров',
} as const

export const SECOND_CUSTOMER = {
  path: 'КЛИЕНТИ:Втори Клиент ООД',
  name: 'Втори Клиент ООД',
  eik: '222222222',
  vatNumber: 'BG222222222',
} as const

export const CUSTOMERS_ROOT = 'КЛИЕНТИ'

/** A bank account: the import makes its BankAccount and links the analytic to it. */
export const BANK = {
  path: 'БАНКОВИ СМЕТКИ:BG00TEST00000000000001',
  iban: 'BG00TEST00000000000001',
  bankName: 'Примерна Банка',
} as const

/** A fixed asset: the import makes it from the analytic's properties (`fixed-asset-params.ts`). */
export const ASSET = {
  path: 'ДА:Тестова машина',
  name: 'Тестова машина',
  /** What the asset is booked on (`СМЕТКА`). */
  account: '204',
} as const

/** A sales invoice paid by bank, in part: the journal's "unpaid" filter lists it. */
export const PART_PAID_INVOICE = {
  docType: '-Ф',
  docNumber: '0000000101',
  date: '2026-01-12',
  total: 120,
  paid: 50,
  open: 70,
} as const

/** A sales invoice paid in cash, whole: never "unpaid". */
export const PAID_INVOICE = {
  docType: '-Ф',
  docNumber: '0000000102',
  date: '2026-01-15',
  total: 60,
} as const

/** The bank document that paid part of the first invoice. The two link to each other. */
export const PAYMENT = {
  docType: '+ББ',
  docNumber: '7',
  date: '2026-01-20',
  amount: 50,
} as const

/** A February invoice nothing has paid yet. */
export const FEBRUARY_INVOICE = {
  docType: '-Ф',
  docNumber: '0000000103',
  date: '2026-02-04',
  total: 240,
} as const

/** The filed VAT month: its sales register holds the two January invoices. */
export const VAT_PERIOD = '202601'

/** The native org's analytics: a root and one partner under it with no contact yet. */
export const NATIVE_ANALYTIC = {
  root: 'КЛИЕНТИ',
  path: 'КЛИЕНТИ:Партньор без контакт',
  name: 'Партньор без контакт',
} as const
