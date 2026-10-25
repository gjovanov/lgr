import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { DigestRun, Org } from 'db/models'
import { buildDailyDigest, orgLocalParts, previousLocalDate } from 'services/biz/digest/daily-digest.service'
import { digestSubject, renderDigestHtml } from 'services/biz/digest/daily-digest.render'
import { sendDigestTo } from 'services/biz/digest/digest-runner.service'

/**
 * FR-11.15 (#21) — the digest's operator surface: send myself one now, look at one, see how
 * the last scheduled run went.
 *
 * Admin-only, using the same raw `role !== 'admin'` guard as the org PUT it sits beside —
 * `admin.settings` deliberately does NOT suffice there, and a test button that mails people
 * is settings-grade, not report-grade.
 *
 * ⚠ The test send goes to the CALLING ADMIN ONLY, never to the configured recipient list.
 * A "test" that mails the whole company is not a test.
 */

/** The day a digest sent today reports on, in the org's own zone. */
async function reportDateFor(orgId: string): Promise<{ date: string; timezone: string }> {
  const org: any = await Org.findById(orgId).lean().exec()
  const timezone = org?.settings?.timezone || 'UTC'
  const { date: today } = orgLocalParts(new Date(), timezone)
  return { date: previousLocalDate(today), timezone }
}

export const digestController = new Elysia({ prefix: '/org/:orgId/digest' })
  .use(AuthService)

  /** Build yesterday's digest and mail it to the caller. Exempt from the daily claim. */
  .post(
    '/test',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })
      if (!user.email) return status(422, { message: 'Your account has no email address' })

      const b = (body || {}) as any
      const { date } = await reportDateFor(orgId)
      const reportDate = b.date || date

      const outcome = await sendDigestTo(orgId, reportDate, [{ userId: user.id, email: user.email }])

      // FR-10 doctrine: an unconfigured provider is an ops problem the operator must see,
      // never a silent success.
      if (outcome.status === 'skipped' && outcome.reason === 'email_not_configured') {
        return status(503, { message: 'Email is not configured on this server' })
      }
      if (outcome.status === 'failed') {
        return status(502, {
          message: 'The mail provider rejected the message',
          detail: outcome.recipients[0]?.error?.slice(0, 300),
        })
      }
      return { sent: true, to: user.email, date: reportDate }
    },
    { isSignIn: true, body: t.Optional(t.Object({ date: t.Optional(t.String()) })) },
  )

  /** The same HTML the mail would carry — for an in-card preview, no send. */
  .get('/preview', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin') return status(403, { message: 'Admin only' })

    const { date } = await reportDateFor(orgId)
    const reportDate = (query.date as string) || date
    const data = await buildDailyDigest(orgId, reportDate)
    return { date: reportDate, subject: digestSubject(data), html: renderDigestHtml(data) }
  }, { isSignIn: true })

  /** Last run, for the settings card's status line. */
  .get('/last-run', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    // S-29: admin-only like its two siblings. It was the one route of the three without the guard.
    if (user.role !== 'admin') return status(403, { message: 'Admin only' })
    const run = await DigestRun.findOne({ orgId }).sort({ startedAt: -1 }).lean().exec()
    return { run: run || null }
  }, { isSignIn: true })
