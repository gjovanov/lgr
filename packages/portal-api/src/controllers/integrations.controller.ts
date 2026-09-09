import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { Org } from 'db/models'
import { config } from 'config'
import { googleDriveAdapter, GOOGLE_DRIVE_SCOPE } from 'services/biz/cloud-storage.service'
import { createAuditEntry } from 'services/biz/audit-log.service'

/**
 * FR-13.55 (#24) — connecting Google Drive, without going through the org settings PUT.
 *
 * **Why a dedicated pair of endpoints exists.** `PUT /org/:orgId` whitelists the settings
 * sub-object and already drops `integrations` (FR-11 §1), and a partial `settings` object
 * REPLACES the whole subdocument because the update is a `findByIdAndUpdate`. So a Drive
 * connection written through the ordinary settings route would either vanish silently or take
 * the rest of `settings` with it. These two routes write the one nested path and nothing else.
 *
 * **⚠ The refresh token is returned ONCE and is never persisted here.** That is the whole
 * point of the design decision recorded on the issue: `orgs` is inside every backup bundle,
 * so a token stored on the Org document would ship the credential that can DELETE the
 * off-site copy inside the thing it protects (FR-13.56). The operator seals it into
 * `lgr-secret` as `BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN`, and the backup job reads it from
 * config. What IS stored on the Org is non-secret provenance — which account, when, what
 * scope — so the UI can say "connected as …" without holding anything worth stealing.
 *
 * **Gating.** Admin of THIS org, using the same explicit guard as `backup.controller.ts` —
 * including the org comparison, whose absence there was a cross-tenant data leak. ⚠ When
 * §5.7's `config.backup.sysAdmins` allow-list lands (Phase 4), these routes move behind it:
 * connecting a Drive decides where an entire tenant's data is copied to, which is a
 * platform-operator act rather than an org-admin one. Until that exists, org-admin is the
 * tightest gate the product actually has — `ROLES` has no system-administrator.
 */

function guard(user: any, orgId: string, status: any) {
  // ⚠ Load-bearing, not defensive: per CLAUDE.md the `isSignIn` macro does not by itself
  // reject anonymous callers on these controllers.
  if (!user) return status(401, { message: 'Unauthorized' })
  if (user.role !== 'admin') return status(403, { message: 'Admin only' })
  if (String(user.orgId || '') !== String(orgId)) {
    return status(403, { message: 'This integration belongs to a different organisation' })
  }
  return null
}

export const integrationsController = new Elysia({ prefix: '/org/:orgId/integration/google-drive' })
  .use(AuthService)

  /**
   * The consent URL to open in a browser.
   *
   * ⚠ Requests `drive.file`, not the `drive.readonly` the placeholder used — that scope
   * cannot write, which is why the previous adapter could never have uploaded anything.
   * `drive.file` limits the token to files this application itself created, so a leak cannot
   * read the account's other documents (FR-13.51). Any org already connected under
   * `drive.readonly` must re-consent.
   */
  .get('/auth-url', async ({ params: { orgId }, user, status }) => {
    const denied = guard(user, orgId, status)
    if (denied) return denied
    if (!config.integrations.google.clientId || !config.integrations.google.clientSecret) {
      return status(503, { message: 'Google Drive is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)' })
    }
    if (!config.integrations.google.redirectUri) {
      return status(503, { message: 'GOOGLE_REDIRECT_URI is not set on this server' })
    }
    return { url: googleDriveAdapter.getAuthUrl(orgId), scope: GOOGLE_DRIVE_SCOPE }
  }, { isSignIn: true })

  /**
   * Exchange the code, and hand the refresh token back exactly once.
   *
   * ⚠ `handleCallback` takes the orgId explicitly. The original signature did not, and the
   * existing design smuggles it through `redirectUri.replace('{orgId}', orgId)` — Google
   * matches the redirect URI character for character when redeeming a code, so the same
   * substitution has to happen on both sides or the exchange fails with `redirect_uri_mismatch`.
   */
  .post('/callback', async ({ params: { orgId }, body, user, status }) => {
    const denied = guard(user, orgId, status)
    if (denied) return denied

    const code = String((body as any)?.code || '')
    if (!code) return status(422, { message: 'code is required' })

    let tokens
    try {
      tokens = await googleDriveAdapter.handleCallback(code, orgId)
    } catch (e: any) {
      return status(502, { message: 'The Google Drive consent could not be completed', detail: e?.message })
    }

    // Provenance only. ⚠ `$set` on the ONE nested path, never a whole `settings` object:
    // assigning `settings` would replace the subdocument and take `dailyDigest`, `backup` and
    // `accounting` with it (FR-13.55).
    await Org.updateOne({ _id: orgId }, {
      $set: {
        'settings.integrations.googleDrive.email': tokens.email,
        'settings.integrations.googleDrive.scope': GOOGLE_DRIVE_SCOPE,
        'settings.integrations.googleDrive.connectedAt': new Date(),
        'settings.integrations.googleDrive.connectedBy': user!.id,
      },
    }).exec()

    createAuditEntry({
      orgId, userId: user!.id, action: 'update', module: 'admin',
      entityType: 'integration', entityId: 'google_drive', entityName: tokens.email || 'google drive',
    })

    return {
      connected: true,
      email: tokens.email,
      scope: GOOGLE_DRIVE_SCOPE,
      // ⚠ SHOWN ONCE, STORED NOWHERE. Copy it into the sealed secret now — re-reading it
      // later means going through consent again, which is the correct trade for not keeping
      // a Drive credential inside the collection that every backup bundle contains.
      refreshToken: tokens.refreshToken,
      instructions:
        'Seal this refresh token into lgr-secret as BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN and restart the app. ' +
        'It is not stored anywhere on the server: the orgs collection travels inside every backup bundle, ' +
        'and a Drive credential kept there would ride along with the data it protects (FR-13.56).',
    }
  }, {
    isSignIn: true,
    body: t.Object({ code: t.String({ minLength: 1 }) }),
  })

  /** Whether this org has ever completed consent, and as whom. Never returns a secret. */
  .get('/status', async ({ params: { orgId }, user, status }) => {
    const denied = guard(user, orgId, status)
    if (denied) return denied

    const org: any = await Org.findById(orgId, { settings: 1 }).lean().exec()
    const gd = org?.settings?.integrations?.googleDrive
    return {
      consented: Boolean(gd?.connectedAt),
      email: gd?.email || undefined,
      scope: gd?.scope || undefined,
      connectedAt: gd?.connectedAt || undefined,
      // The two halves are independent, and conflating them hides the usual misconfiguration:
      // consent was granted, the token was never sealed, and the nightly job has been
      // reporting "not connected" ever since.
      backupTokenConfigured: Boolean(config.backup.googleDrive.refreshToken),
      encryptionConfigured: Boolean(config.backup.encryptionPublicKey),
    }
  }, { isSignIn: true })
