import { config } from 'config'
import { Org, OrgLicence } from 'db/models'
import { logger } from '../../logger/logger.js'
import {
  BUILT_IN_KEYS,
  GRACE_DAYS,
  allowInDevelopment,
  ephemeralSigningKey,
  signLicence,
  signingKeyFrom,
  type LicencePlan,
  type SigningKey,
} from './licence-token.js'

/**
 * FR-20.55, global's side (plan step P2-3b): what an org is entitled to on its masters, and the
 * signed licence that says so.
 *
 * An org is entitled when it has either of these, and the later date wins:
 * - **an Enterprise subscription** that is active or trialing: paid through its period's end. A
 *   subscription that is `past_due` is NOT renewed: the master keeps the licence it has, which was
 *   signed for the period that was paid, and runs into its grace from there;
 * - **a pilot** a sys-admin issued (`OrgLicence`), until its date.
 *
 * An org with neither is sent nothing: its masters keep what they hold, and run out on its dates.
 */

export interface Entitlement {
  plan: LicencePlan
  paidThrough: Date
}

const PAYING = new Set(['active', 'trialing'])

export type IssuerKey = { ok: true; key: SigningKey } | { ok: false; reason: string }
let issuer: IssuerKey | undefined

/**
 * The key global signs with. In production: `LICENCE_SIGNING_KEY`, and only when it is one of the
 * keys built into this release (a licence no master accepts is worse than none). Elsewhere, a key
 * made in this process when none is set.
 */
export function issuerKey(): IssuerKey {
  if (issuer) return issuer
  const production = process.env.NODE_ENV === 'production'
  const raw = config.licence.signingKey
  if (!raw) {
    if (production) {
      issuer = { ok: false, reason: 'LICENCE_SIGNING_KEY is not set' }
    } else {
      const key = ephemeralSigningKey()
      allowInDevelopment(key)
      issuer = { ok: true, key }
    }
  } else {
    try {
      const key = signingKeyFrom(raw)
      if (production && !BUILT_IN_KEYS.has(key.kid)) {
        issuer = { ok: false, reason: `LICENCE_SIGNING_KEY (kid ${key.kid}) is not one of the keys built into this release, so no master would accept its licences` }
      } else {
        if (!production) allowInDevelopment(key)
        issuer = { ok: true, key }
      }
    } catch (e: any) {
      issuer = { ok: false, reason: `LICENCE_SIGNING_KEY is not a base64 PKCS#8 Ed25519 key (${e?.message ?? e})` }
    }
  }
  if (!issuer.ok) logger.error(`Licences cannot be issued: ${issuer.reason}`)
  return issuer
}

/** Tests: read the key again. */
export function resetIssuerKey(): void {
  issuer = undefined
}

/** What each org is entitled to, by org id; an org that is entitled to nothing is absent. */
export async function entitlementsOf(orgIds: readonly unknown[]): Promise<Map<string, Entitlement>> {
  const ids = [...new Set(orgIds.map(String))]
  const out = new Map<string, Entitlement>()
  if (!ids.length) return out
  const [orgs, pilots] = await Promise.all([
    Org.find({ _id: { $in: ids } }).select('subscription').lean(),
    OrgLicence.find({ orgId: { $in: ids }, revokedAt: { $exists: false } }).lean(),
  ])
  const offer = (orgId: string, e: Entitlement) => {
    const had = out.get(orgId)
    if (!had || e.paidThrough.getTime() > had.paidThrough.getTime()) out.set(orgId, e)
  }
  for (const org of orgs as any[]) {
    const s = org.subscription
    if (s?.plan === 'enterprise' && PAYING.has(s.status) && s.currentPeriodEnd) {
      offer(String(org._id), { plan: 'enterprise', paidThrough: new Date(s.currentPeriodEnd) })
    }
  }
  for (const p of pilots as any[]) offer(String(p.orgId), { plan: 'pilot', paidThrough: new Date(p.until) })
  return out
}

export interface IssuedLicence {
  orgId: string
  jws: string
  entitlement: Entitlement
}

/** Signed licences for `nodeId`, one per entitled org of `orgIds`. Empty when global cannot sign. */
export async function issueLicences(nodeId: string, orgIds: readonly unknown[]): Promise<Map<string, IssuedLicence>> {
  const out = new Map<string, IssuedLicence>()
  const key = issuerKey()
  if (!key.ok) return out
  const entitled = await entitlementsOf(orgIds)
  if (!entitled.size) return out
  const orgs = await Org.find({ _id: { $in: [...entitled.keys()] } }).select('slug name').lean()
  for (const org of orgs as any[]) {
    const orgId = String(org._id)
    const e = entitled.get(orgId)!
    const jws = signLicence(
      { sub: orgId, org: String(org.slug ?? ''), orgName: String(org.name ?? ''), node: nodeId, plan: e.plan, paidThrough: e.paidThrough.toISOString(), graceDays: GRACE_DAYS },
      key.key,
    )
    out.set(orgId, { orgId, jws, entitlement: e })
  }
  return out
}

/** What a licence says, as a master would compare it: a re-signed licence with the same terms is no news. */
export function licenceTerms(e: Entitlement): string {
  return `${e.plan}|${e.paidThrough.toISOString()}`
}
