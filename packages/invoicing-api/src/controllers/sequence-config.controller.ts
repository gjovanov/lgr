import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { listSequencesForOrg, setDisplayPrefix } from 'services/biz/sequence.service'
import { createAuditEntry } from 'services/biz/audit-log.service'

/**
 * The invoicing-side sequence keys we surface in the configuration UI. Counter rows for
 * other prefixes (UNP-*, custom seeds) exist in the same collection but aren't exposed here.
 *
 * Each entry: storage prefix + default display prefix + grouping label/variant for the UI.
 * External orders keep the historical ORDER/DRAFT_ORD counter keys (numbering continues
 * across the ORD→ORDO rename); only the default display prefix changed.
 */
export const INVOICING_SEQUENCE_KEYS: Array<{
  prefix: string
  defaultDisplay: string
  group: 'invoice' | 'proforma' | 'credit_note' | 'debit_note' | 'bill' | 'cash_sale' | 'order'
    | 'internal_order' | 'reservation' | 'certificate' | 'pp_protocol'
  variant: 'draft' | 'issued'
}> = [
  // Drafts (per-type counters)
  { prefix: 'DRAFT_INV',  defaultDisplay: 'DRF-INV',  group: 'invoice',     variant: 'draft' },
  { prefix: 'DRAFT_PRF',  defaultDisplay: 'DRF-PRF',  group: 'proforma',    variant: 'draft' },
  { prefix: 'DRAFT_CN',   defaultDisplay: 'DRF-CN',   group: 'credit_note', variant: 'draft' },
  { prefix: 'DRAFT_DN',   defaultDisplay: 'DRF-DN',   group: 'debit_note',  variant: 'draft' },
  { prefix: 'DRAFT_BILL', defaultDisplay: 'DRF-BILL', group: 'bill',        variant: 'draft' },
  { prefix: 'DRAFT_CS',   defaultDisplay: 'DRF-CS',   group: 'cash_sale',   variant: 'draft' }, // unused but listed for completeness
  { prefix: 'DRAFT_ORD',  defaultDisplay: 'DRF-ORDO', group: 'order',       variant: 'draft' },
  { prefix: 'DRAFT_ORDI', defaultDisplay: 'DRF-ORDI', group: 'internal_order', variant: 'draft' },
  // Issued (SALES_DOC shared by INV+CN+DN, others per-type)
  { prefix: 'SALES_DOC',  defaultDisplay: 'INV',      group: 'invoice',     variant: 'issued' },
  { prefix: 'SALES_DOC',  defaultDisplay: 'CRN',      group: 'credit_note', variant: 'issued' },
  { prefix: 'SALES_DOC',  defaultDisplay: 'DBN',      group: 'debit_note',  variant: 'issued' },
  { prefix: 'PROFORMA',   defaultDisplay: 'PRF',      group: 'proforma',    variant: 'issued' },
  { prefix: 'BILL',       defaultDisplay: 'BILL',     group: 'bill',        variant: 'issued' },
  { prefix: 'CASH_SALE',  defaultDisplay: 'CS',       group: 'cash_sale',   variant: 'issued' },
  { prefix: 'ORDER',      defaultDisplay: 'ORDO',     group: 'order',       variant: 'issued' },
  { prefix: 'INTERNAL_ORDER', defaultDisplay: 'ORDI', group: 'internal_order', variant: 'issued' },
  { prefix: 'RESERVATION', defaultDisplay: 'RES',     group: 'reservation', variant: 'issued' },
  // Companion documents printed alongside an outgoing sales document — own running numbers.
  { prefix: 'CERTIFICATE', defaultDisplay: 'CERT',    group: 'certificate', variant: 'issued' },
  { prefix: 'PP_PROTOCOL', defaultDisplay: 'PPP',     group: 'pp_protocol', variant: 'issued' },
]

const ALLOWED_PREFIXES = new Set(INVOICING_SEQUENCE_KEYS.map(e => e.prefix))

export const sequenceConfigController = new Elysia({ prefix: '/org/:orgId/invoicing/sequences' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'manager'].includes(user.role)) {
      return status(403, { message: 'Sequence configuration requires admin or manager role' })
    }

    const all = await listSequencesForOrg(orgId)
    const currentYear = new Date().getFullYear()

    // Surface one row per (group × variant). For each, find the active counter for the current
    // year and the year=0 displayPrefix override (if any).
    const rows = INVOICING_SEQUENCE_KEYS.map(entry => {
      const counter = all.find(s => s.prefix === entry.prefix && s.year === currentYear)
      const override = all.find(s => s.prefix === entry.prefix && s.year === 0)
      return {
        prefix: entry.prefix,
        defaultDisplay: entry.defaultDisplay,
        displayPrefix: override?.displayPrefix || entry.defaultDisplay,
        group: entry.group,
        variant: entry.variant,
        year: currentYear,
        lastNumber: counter?.lastNumber ?? 0,
      }
    })

    return { sequences: rows, year: currentYear }
  }, { isSignIn: true })
  .put(
    '/:prefix',
    async ({ params: { orgId, prefix }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'manager'].includes(user.role)) {
        return status(403, { message: 'Sequence configuration requires admin or manager role' })
      }
      if (!ALLOWED_PREFIXES.has(prefix)) {
        return status(400, { message: `Unknown sequence prefix: ${prefix}` })
      }

      const next = (body.displayPrefix || '').trim() || null
      // Reject obviously invalid display prefixes — keep them ASCII-friendly to avoid filename
      // issues in exports and confused-deputy attacks via templated rendering.
      if (next && !/^[A-Za-z0-9_-]{1,32}$/.test(next)) {
        return status(400, { message: 'displayPrefix must be 1-32 chars from [A-Za-z0-9_-]' })
      }

      await setDisplayPrefix(orgId, prefix, next)

      createAuditEntry({
        orgId,
        userId: user.id,
        action: 'update',
        module: 'invoicing',
        entityType: 'sequence',
        entityId: prefix,
        entityName: `${prefix} display prefix`,
        changes: { displayPrefix: { to: next || '(default)' } },
      })

      return { prefix, displayPrefix: next }
    },
    {
      isSignIn: true,
      body: t.Object({
        displayPrefix: t.Union([t.String(), t.Null()]),
      }),
    },
  )
