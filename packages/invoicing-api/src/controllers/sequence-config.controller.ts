import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { listSequencesForOrg, setDisplayPrefix } from 'services/biz/sequence.service'
import { createAuditEntry } from 'services/biz/audit-log.service'

/**
 * The invoicing-side sequence keys we surface in the configuration UI. Counter rows for
 * other prefixes (UNP-*, custom seeds) exist in the same collection but aren't exposed here.
 *
 * The table itself lives in `services/biz/sequence-registry` — allocation paths read the
 * same rows, so a prefix configured here is the prefix every document actually gets.
 * Re-exported for existing importers.
 */
export { INVOICING_SEQUENCE_KEYS } from 'services/biz/sequence-registry'
import { INVOICING_SEQUENCE_KEYS } from 'services/biz/sequence-registry'

/** A closed series allocates nothing (FR-21's TXN): it is neither listed nor configurable. */
const OPEN_SEQUENCE_KEYS = INVOICING_SEQUENCE_KEYS.filter(e => !e.closed)
const ALLOWED_PREFIXES = new Set(OPEN_SEQUENCE_KEYS.map(e => e.prefix))

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
    const rows = OPEN_SEQUENCE_KEYS.map(entry => {
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

      // Read the current override first so the audit entry records both sides of the change.
      // `null` means "no override" — allocations fall back to the canonical prefix.
      const current = await listSequencesForOrg(orgId)
      const previous = current.find(s => s.prefix === prefix && s.year === 0)?.displayPrefix ?? null

      await setDisplayPrefix(orgId, prefix, next)

      createAuditEntry({
        orgId,
        userId: user.id,
        action: 'update',
        module: 'invoicing',
        entityType: 'sequence',
        entityId: prefix,
        entityName: `${prefix} display prefix`,
        changes: [{ field: 'displayPrefix', oldValue: previous, newValue: next }],
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
