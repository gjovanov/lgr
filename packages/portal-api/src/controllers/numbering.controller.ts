import { Elysia, t } from 'elysia'
import { nodeRole } from 'config'
import { OrgHome } from 'db/models'
import { AuthService } from '../auth/auth.service.js'
import { MoveError } from 'services/biz/move/move.service'
import { legalSeriesOf, recordLastNumbers } from 'services/biz/move/promote.service'
import { mirrorLegalSeries } from 'services/biz/home/series-lock.service'

/**
 * Whether the org's legal numbering waits for the last numbers issued at a site, and recording them
 * (FR-20.51, FR-20.81): on every node. lgrai.app after a promotion (P3-6d), and a master whose
 * database went back in time: a restore, a reverted snapshot, a clone (P3-7).
 *
 * On a master, lgrai.app's mirror of the org is a floor too, when it can be asked: numbering
 * resumes above the highest of the person's reading and the mirror's. With the link down, the
 * person's reading stands alone, and the audit says so.
 */

function canAdmin(user: any): boolean {
  return user?.role === 'admin' || !!user?.permissions?.includes('admin.settings')
}

export const numberingController = new Elysia({ prefix: '/org/:orgId/numbering' })
  .use(AuthService)

  /** Whether legal numbering waits here, why, the series a person must give, and the mirror's when linked. */
  .get(
    '/last-numbers',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const home: any = await OrgHome.findOne({ orgId }, { seriesFrozen: 1 }).lean()
      const frozen = home?.seriesFrozen
      const mirror = frozen?.since && nodeRole() === 'master' ? await mirrorLegalSeries(orgId) : null
      return {
        frozen: !!frozen?.since,
        since: frozen?.since ?? null,
        reason: frozen?.reason ?? null,
        detail: frozen?.detail ?? null,
        series: await legalSeriesOf(orgId),
        mirror,
      }
    },
    { isSignIn: true },
  )

  /** The last numbers issued at the site: each legal series resumes above them, and numbering opens. */
  .post(
    '/last-numbers',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        const floor = nodeRole() === 'master' ? await mirrorLegalSeries(orgId) : null
        return { series: await recordLastNumbers(orgId, { id: user.id, operatorCode: user.operatorCode }, body.series, floor) }
      } catch (e) {
        if (e instanceof MoveError) return status(e.statusCode, { code: e.code, message: e.message, ...(e.extra ?? {}) })
        throw e
      }
    },
    {
      isSignIn: true,
      body: t.Object({ series: t.Array(t.Object({ prefix: t.String({ maxLength: 40 }), year: t.Integer({ minimum: 0 }), last: t.Integer({ minimum: 0 }) }), { maxItems: 200 }) }),
    },
  )
