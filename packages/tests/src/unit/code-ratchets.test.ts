import { describe, it, expect } from 'bun:test'
import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * FR-32.16 and FR-32.17 (#797): two counts that may only go down.
 *
 * - Direct model calls in the API packages' controllers (`Invoice.find(…)` with a model imported from `db/models`).
 *   New code reads and writes through a repository or a service.
 * - `as any` outside the tests, in every package. The lint baseline already refuses a NEW one in the API packages
 *   and `services` (`lgr/no-as-any`); this is the whole count, the one FR-32.17 starts from (2 173 at the audit).
 * - Files that use the raw driver (`Model.collection.*`, `connection.db`): a new one fails until it is listed below
 *   with the reason it bypasses Mongoose.
 * - FR-32.26: the source files over 1 000 lines (`LARGE_FILES`). None may get longer, and no other may join them.
 *
 * A count that went DOWN fails too, until the number here is lowered: otherwise the slack would let the next one in
 * unseen. Lower it in the same pull request.
 */
const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const PACKAGES = join(ROOT, 'packages')

const CONTROLLER_MODEL_CALLS = 256
const AS_ANY = 1978

const COPY = 'copies, compares or replays documents as they are stored, which Mongoose would cast, default and hook'
const HOME = "writes the org's home or legal-series state below the home guard, on purpose (home-write-guard's RAW_WRITE_SITES)"
const MIGRATIONS = 'the migrations runner works on collections, as the migrations themselves do'
/** Used before this check: the reason is at its call site, and is to be named here when the file is next touched. */
const UNNAMED = 'in use before FR-32.16; its reason is at the call site, to be named here when the file is next touched'
const PIPELINE = 'one aggregation-pipeline update, which derives the amounts in the database (Mongoose casts a pipeline away)'

/**
 * The files that use the raw driver when FR-32.16 started, and why. A new file is added here with its reason.
 * ⚠ Its WRITES are also held by `home-write-guard.flow.test.ts#RAW_WRITE_SITES` (each guarded or exempt with a reason).
 */
const RAW_DRIVER_FILES: Record<string, string> = {
  'services/src/biz/login-throttle.service.ts': UNNAMED,
  'services/src/biz/replication/control.ts': COPY,
  'services/src/biz/replication/dead-letters.ts': COPY,
  'services/src/biz/replication/engine.ts': COPY,
  'services/src/biz/replication/reconcile.ts': COPY,
  'services/src/biz/personal-data/employee-personal.ts': UNNAMED,
  'services/src/biz/personal-data/restore.ts': UNNAMED,
  'services/src/biz/org-clone/clone.service.ts': COPY,
  'services/src/biz/move/fenced-import.service.ts': COPY,
  'services/src/biz/move/kept-import.service.ts': COPY,
  'services/src/biz/move/move-back.service.ts': COPY,
  'services/src/biz/move/move-worker.service.ts': COPY,
  'services/src/biz/move/move.service.ts': COPY,
  'services/src/biz/move/reseed.service.ts': COPY,
  'services/src/biz/home/home-hold.service.ts': HOME,
  'services/src/biz/home/series-lock.service.ts': HOME,
  'services/src/biz/cash-register/freeze-check.ts': UNNAMED,
  'services/src/biz/cash-register/payment-receipt.service.ts': UNNAMED,
  'services/src/biz/backup/backup-restore.service.ts': UNNAMED,
  'services/src/biz/backup/backup-status.service.ts': "reads the database's own statistics, which no model has",
  'services/src/biz/access/live.ts': UNNAMED,
  'portal-api/src/api.ts': UNNAMED,
  'portal-api/src/unified.ts': MIGRATIONS,
  'portal-api/src/websocket/uplink.ts': UNNAMED,
  'migrations/src/cli.ts': MIGRATIONS,
  'invoicing-api/src/controllers/invoice.controller.ts': PIPELINE,
}

/**
 * FR-32.26: the source files over 1 000 lines, with their length when the check started. A file on this list may not
 * get longer, and no other file may pass 1 000 lines. Lower a number when a file gets shorter, if you like; take a
 * file off when it is 1 000 lines or fewer (the check says so). Slice E of FR-32 splits the first four.
 */
const MAX_LINES = 1000
const LARGE_FILES: Record<string, number> = {
  'invoicing-ui/src/views/InternalOrderFormView.vue': 1564,
  'invoicing-ui/src/views/OrderFormView.vue': 1544,
  'services/src/biz/cash-register/register.service.ts': 1542,
  'inventory-ui/src/views/MovementFormView.vue': 1407,
  'services/src/biz/cash-sale-invoice.service.ts': 1379,
  'fiscal/src/eltrade.ts': 1357,
  'invoicing-api/src/controllers/pos.controller.ts': 1196,
  'services/src/biz/oauth.service.ts': 1162,
  'services/src/biz/backup/backup-restore.service.ts': 1158,
  'services/src/biz/reservation-ops.service.ts': 1133,
  'portal-ui/src/views/settings/ServersView.vue': 1101,
  'portal-api/src/websocket/fiscal-bridge.ts': 1100,
  'config/src/index.ts': 1065,
  'services/src/biz/cash-register/payment-receipt.service.ts': 1061,
  'invoicing-api/src/controllers/invoice-export.controller.ts': 1027,
  'services/src/biz/receipt-bill.service.ts': 1025,
  'inventory-ui/src/views/ProductFormView.vue': 1016,
  'services/src/biz/doc-import/parse-table.ts': 1014,
  'services/src/biz/accounting-books/import.service.ts': 1002,
}

/** Lines as `wc -l` counts them in a file that ends with a newline, and the last line too when it does not. */
function lineCount(text: string): number {
  const lines = text.split('\n')
  return text.endsWith('\n') ? lines.length - 1 : lines.length
}

const METHODS = 'find|findOne|findById|findOneAndUpdate|findByIdAndUpdate|findOneAndDelete|findByIdAndDelete|updateOne|updateMany|create|insertMany|deleteOne|deleteMany|countDocuments|aggregate|exists|bulkWrite|distinct|replaceOne'

function sources(pattern: string, skip: RegExp = /^(tests|e2e)[\\/]/): Array<[string, string]> {
  return [...new Glob(pattern).scanSync(PACKAGES)]
    .filter(f => !skip.test(f))
    .map(f => [f.replace(/\\/g, '/'), readFileSync(join(PACKAGES, f), 'utf8')])
}

function modelCalls(text: string): number {
  const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'db\/models'/g)].flatMap(m => m[1].split(','))
    .map(s => s.trim()).filter(s => s && !s.startsWith('type ')).map(s => s.split(/\s+as\s+/).pop()!.trim())
  if (!imports.length) return 0
  const re = new RegExp(`\\b(${imports.join('|')})\\.(${METHODS})\\(`, 'g')
  return [...text.matchAll(re)].length
}

const RAW = /\.collection\.(find|insert|update|delete|aggregate|bulkWrite|count|distinct|replace)\w*\(|connection\.db\b|\.db\.collection\(/

describe('counts that only go down (FR-32.16, .17)', () => {
  it('direct model calls in controllers', () => {
    const count = sources('*-api/src/controllers/**/*.ts').reduce((n, [, text]) => n + modelCalls(text), 0)
    expect({ count, ratchet: CONTROLLER_MODEL_CALLS }).toEqual({ count: CONTROLLER_MODEL_CALLS, ratchet: CONTROLLER_MODEL_CALLS })
  })

  it('`as any` outside the tests', () => {
    const count = sources('*/src/**/*.{ts,vue}').reduce((n, [, text]) => n + [...text.matchAll(/\bas any\b/g)].length, 0)
    expect({ count, ratchet: AS_ANY }).toEqual({ count: AS_ANY, ratchet: AS_ANY })
  })

  it('a file that uses the raw driver is listed with its reason', () => {
    const files = sources('*/src/**/*.ts', /^(tests|e2e)[\\/]|^migrations[\\/]src[\\/]migrations[\\/]/)
      .filter(([, text]) => RAW.test(text)).map(([f]) => f)
    expect(files.filter(f => !(f in RAW_DRIVER_FILES))).toEqual([])
    expect(Object.keys(RAW_DRIVER_FILES).filter(f => !files.includes(f))).toEqual([])
  })
})

describe('large files do not grow (FR-32.26)', () => {
  const lengths = new Map(sources('*/src/**/*.{ts,vue}').map(([f, text]) => [f, lineCount(text)]))

  it('no file but the listed ones is over 1 000 lines', () => {
    const over = [...lengths].filter(([f, n]) => n > MAX_LINES && !(f in LARGE_FILES)).map(([f, n]) => `${f}: ${n}`)
    expect(over).toEqual([])
  })

  it('a listed file is no longer than it was', () => {
    const grown = Object.entries(LARGE_FILES)
      .filter(([f, max]) => (lengths.get(f) ?? 0) > max)
      .map(([f, max]) => `${f}: ${lengths.get(f)} > ${max}`)
    expect(grown).toEqual([])
  })

  it('a listed file is still over 1 000 lines (take it off the list otherwise)', () => {
    const done = Object.keys(LARGE_FILES).filter(f => (lengths.get(f) ?? 0) <= MAX_LINES).map(f => `${f}: ${lengths.get(f) ?? 'gone'}`)
    expect(done).toEqual([])
  })
})
