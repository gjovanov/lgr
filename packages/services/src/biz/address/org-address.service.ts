/**
 * An org's address on the internet, `<label>.lgrai.app` (FR-20.72, plan step P3-4a). Global only.
 *
 * - **Issued only** for a label that is a DNS label of at most 63 characters (no punycode), not
 *   reserved, with no record of its own in the zone, to an org whose licence includes on-prem
 *   (FR-20.55), after a sys-admin approves it. The label is the org's slug WHEN REQUESTED: a rename
 *   does not move it.
 * - **Issued once.** A retired address answers with a notice for 12 months and is never issued to
 *   another org (`OrgAddress`'s unique index keeps every label but a refused one).
 * - The router (P3-4b) reads it: an active address of an org homed on a master is tunnelled there;
 *   one of an org homed on lgrai.app answers exactly like an unknown label.
 *
 * ⚠ Global's record about the org, never its data: written on lgrai.app even while the org is homed
 * on its server (`GLOBAL_STATE_WRITES`), and never in a backup bundle (`NODE_STATE_MODELS`).
 */
import { randomBytes } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { config, nodeRole } from 'config'
import { Org, OrgAddress } from 'db/models'
import { mongoose } from 'db/connection'
import { entitlementsOf } from '../licence/licence-issue.service.js'
import { logger } from '../../logger/logger.js'

/** How long a retired address answers with a notice. */
export const ADDRESS_NOTICE_MS = 365 * 86_400_000

/**
 * FR-20.72's reserved labels, "and the like": the names a service, a mail system or a person would
 * expect to be lgrai.app's own. `ORG_ADDRESS_RESERVED` adds more (comma-separated), e.g. the labels
 * the zone already serves.
 */
const BUILT_IN_RESERVED = [
  'www', 'api', 'app', 'admin', 'auth', 'login', 'account', 'id', 'sso', 'oauth', 'mail', 'status', 'docs', 'help',
  'support', 'billing', 'pay', 'secure', 'static', 'cdn', 'download', 'update', 'registry',
  'accounts', 'apps', 'assets', 'autoconfig', 'autodiscover', 'blog', 'console', 'dashboard', 'dev', 'ftp', 'imap', 'pop',
  'pop3', 'smtp', 'webmail', 'mx', 'ns', 'ns1', 'ns2', 'ns3', 'portal', 'proxy', 'qa', 'staging', 'stage', 'test', 'beta',
  'demo', 'sandbox', 'preview', 'vpn', 'git', 'ci', 'media', 'files', 'images', 'img', 'uploads', 'downloads', 'updates',
  'global', 'lgr', 'lgrai', 'node', 'nodes', 'tunnel', 'relay', 'derp', 'turn', 'stun', 'monitor', 'metrics', 'grafana',
  'argocd', 'root', 'system', 'server', 'servers', 'internal', 'localhost', 'email', 'em', 'track', 'click', 'links',
  'bounce', 'unsubscribe', 'dkim', 'spf', 'dmarc', 'security', 'privacy', 'legal', 'terms', 'abuse', 'postmaster',
  'hostmaster', 'webmaster', 'noreply', 'no-reply',
]

export function reservedLabels(): ReadonlySet<string> {
  const extra = (process.env.ORG_ADDRESS_RESERVED ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return new Set([...BUILT_IN_RESERVED, ...extra])
}

const LABEL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type LabelProblem = 'invalid' | 'too_long' | 'punycode' | 'reserved'

/** Why a label cannot be an address, or null when it can. */
export function labelProblem(label: string): LabelProblem | null {
  if (label.length > 63) return 'too_long'
  if (label.startsWith('xn--')) return 'punycode'
  if (!LABEL_RE.test(label)) return 'invalid'
  if (reservedLabels().has(label)) return 'reserved'
  return null
}

/** The address of a label, as people type it. */
export function addressUrl(label: string): string {
  return `https://${label}.${config.idp.addressApex}`
}

/** The few DNS answers the own-record check needs; a test hands in its own. */
export interface DnsLookup {
  resolve4(name: string): Promise<string[]>
  resolveCname(name: string): Promise<string[]>
  resolveMx(name: string): Promise<unknown[]>
  resolveTxt(name: string): Promise<unknown[]>
}

function publicResolver(): DnsLookup {
  const r = new Resolver({ timeout: 4000, tries: 2 })
  r.setServers(['1.1.1.1', '8.8.8.8'])
  return r
}

/** None, rather than an error: a name with no such record. */
async function answers<T>(q: () => Promise<T[]>): Promise<T[]> {
  try {
    return await q()
  } catch (e: any) {
    if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ESERVFAIL'].includes(e?.code)) return []
    throw e
  }
}

/**
 * Whether `<label>.<apex>` has a record of its own in the zone (FR-20.72: the mail-authentication
 * records, a site the zone already serves), and which. A CNAME, MX or TXT is one. An A record is one
 * when it differs from what a label nobody has answers: the zone's wildcard, if there is one, is not.
 */
export async function ownDnsRecord(label: string, lookup: DnsLookup = publicResolver()): Promise<string | null> {
  const apex = config.idp.addressApex
  const name = `${label}.${apex}`
  if ((await answers(() => lookup.resolveCname(name))).length) return 'CNAME'
  if ((await answers(() => lookup.resolveMx(name))).length) return 'MX'
  if ((await answers(() => lookup.resolveTxt(name))).length) return 'TXT'
  const mine = (await answers(() => lookup.resolve4(name))).sort()
  if (!mine.length) return null
  const nobody = (await answers(() => lookup.resolve4(`lgr-probe-${randomBytes(6).toString('hex')}.${apex}`))).sort()
  return mine.join(',') === nobody.join(',') ? null : 'A'
}

export type AddressRefusal = LabelProblem | 'no_licence' | 'already' | 'label_taken'

export class AddressError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409, readonly code: string, message: string) {
    super(message)
  }
}

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v)

function wire(a: any) {
  return {
    id: String(a._id),
    label: a.label,
    url: addressUrl(a.label),
    state: a.state,
    requestedAt: a.requestedAt,
    decidedAt: a.decidedAt ?? null,
    reason: a.reason ?? null,
    retiredAt: a.retiredAt ?? null,
    noticeUntil: a.noticeUntil ?? null,
  }
}

/** Why this org may not request an address now, or null when it may. */
async function refusalFor(orgId: string, now: Date): Promise<{ code: AddressRefusal; label: string } | null> {
  const org: any = await Org.findById(orgId, { slug: 1 }).lean()
  if (!org) throw new AddressError(404, 'not_found', 'No such organization')
  const label = String(org.slug ?? '').toLowerCase()
  const problem = labelProblem(label)
  if (problem) return { code: problem, label }
  if (await OrgAddress.exists({ orgId: oid(orgId), state: { $in: ['requested', 'active'] } })) return { code: 'already', label }
  if (await OrgAddress.exists({ label, state: { $in: ['requested', 'active', 'retired'] } })) return { code: 'label_taken', label }
  const ent = (await entitlementsOf([orgId])).get(orgId)
  if (!ent || ent.paidThrough.getTime() < now.getTime()) return { code: 'no_licence', label }
  return null
}

export interface AddressView {
  /** The org's live address or request; else its last refused or retired one; else null. */
  address: ReturnType<typeof wire> | null
  /** Whether it may request one now, the label and address it would get, and why not. */
  request: { ok: boolean; label: string; url: string; reason?: AddressRefusal }
}

/** For the org's Servers page. */
export async function addressView(orgId: string, now = new Date()): Promise<AddressView> {
  if (!isId(orgId)) throw new AddressError(404, 'not_found', 'No such organization')
  const rows: any[] = await OrgAddress.find({ orgId: oid(orgId) }).sort({ requestedAt: -1 }).lean()
  const current = rows.find(r => r.state === 'requested' || r.state === 'active') ?? rows[0] ?? null
  const refusal = await refusalFor(orgId, now)
  const label = refusal?.label ?? String(((await Org.findById(orgId, { slug: 1 }).lean()) as any)?.slug ?? '').toLowerCase()
  return {
    address: current ? wire(current) : null,
    request: refusal ? { ok: false, label, url: addressUrl(label), reason: refusal.code } : { ok: true, label, url: addressUrl(label) },
  }
}

/** The org's admin asks for an address: a sys-admin then approves or refuses it. */
export async function requestAddress(orgId: string, by: string, now = new Date()): Promise<AddressView> {
  if (!isId(orgId)) throw new AddressError(404, 'not_found', 'No such organization')
  const refusal = await refusalFor(orgId, now)
  if (refusal) throw new AddressError(409, refusal.code, `This organization cannot have an address now (${refusal.code}).`)
  const org: any = await Org.findById(orgId, { slug: 1 }).lean()
  const label = String(org.slug).toLowerCase()
  try {
    await OrgAddress.create({ label, orgId: oid(orgId), state: 'requested', requestedBy: by, requestedAt: now })
  } catch (e: any) {
    // Two requests at once, for the org or for the label: the index decides, and says so.
    if (e?.code === 11000) throw new AddressError(409, 'label_taken', 'This address is being requested already.')
    throw e
  }
  logger.info({ orgId, label, by }, 'An organization asked for its address on lgrai.app (FR-20.72)')
  return addressView(orgId, now)
}

/** For the sys-admin Nodes page: every address and request, newest first, with its org. */
export async function listAddresses() {
  const rows: any[] = await OrgAddress.find({}).sort({ state: 1, requestedAt: -1 }).limit(500).lean()
  const orgs = new Map(((await Org.find({ _id: { $in: rows.map(r => r.orgId) } }, { name: 1, slug: 1 }).lean()) as any[]).map(o => [String(o._id), o]))
  return rows.map(r => ({ ...wire(r), org: { id: String(r.orgId), name: orgs.get(String(r.orgId))?.name ?? null, slug: orgs.get(String(r.orgId))?.slug ?? null } }))
}

/**
 * A sys-admin approves a request (the label is checked again, and so is the zone: a record of its own
 * refuses it) or refuses it, saying why. A refused request frees its label.
 */
export async function decideAddress(id: string, by: string, decision: 'approve' | 'refuse', opts: { reason?: string; lookup?: DnsLookup; now?: Date } = {}) {
  if (!isId(id)) throw new AddressError(404, 'not_found', 'No such address')
  const now = opts.now ?? new Date()
  const row: any = await OrgAddress.findById(id).lean()
  if (!row) throw new AddressError(404, 'not_found', 'No such address')
  if (row.state !== 'requested') throw new AddressError(409, 'not_requested', 'Only a request can be approved or refused.')
  if (decision === 'refuse') {
    const reason = String(opts.reason ?? '').trim().slice(0, 300)
    if (!reason) throw new AddressError(400, 'reason_required', 'Say why the address is refused.')
    await OrgAddress.updateOne({ _id: row._id, state: 'requested' }, { $set: { state: 'refused', decidedBy: by, decidedAt: now, reason } })
    logger.info({ orgId: String(row.orgId), label: row.label, by }, 'A sys-admin refused an organization\'s address (FR-20.72)')
    return wire({ ...row, state: 'refused', decidedAt: now, reason })
  }
  const problem = labelProblem(row.label)
  if (problem) throw new AddressError(409, problem, `The label "${row.label}" cannot be an address (${problem}).`)
  const record = await ownDnsRecord(row.label, opts.lookup)
  if (record) throw new AddressError(409, 'dns_record', `"${row.label}" has a ${record} record of its own in the zone: refuse the request, or remove the record first.`)
  const ent = (await entitlementsOf([String(row.orgId)])).get(String(row.orgId))
  if (!ent || ent.paidThrough.getTime() < now.getTime()) throw new AddressError(409, 'no_licence', 'The organization\'s licence does not include on-prem now.')
  const r = await OrgAddress.updateOne({ _id: row._id, state: 'requested' }, { $set: { state: 'active', decidedBy: by, decidedAt: now } })
  if (!r.modifiedCount) throw new AddressError(409, 'not_requested', 'The request changed meanwhile.')
  logger.info({ orgId: String(row.orgId), label: row.label, by }, 'A sys-admin issued an organization\'s address (FR-20.72)')
  return wire({ ...row, state: 'active', decidedAt: now })
}

/** A sys-admin retires an address: a notice answers on it for 12 months, and the label is never issued again. */
export async function retireAddress(id: string, by: string, now = new Date()) {
  if (!isId(id)) throw new AddressError(404, 'not_found', 'No such address')
  const noticeUntil = new Date(now.getTime() + ADDRESS_NOTICE_MS)
  const row: any = await OrgAddress.findOneAndUpdate({ _id: oid(id), state: 'active' }, { $set: { state: 'retired', retiredBy: by, retiredAt: now, noticeUntil } }, { new: true }).lean()
  if (!row) throw new AddressError(409, 'not_active', 'Only an active address can be retired.')
  logger.info({ orgId: String(row.orgId), label: row.label, by }, 'A sys-admin retired an organization\'s address (FR-20.72)')
  return wire(row)
}

/**
 * What an address label is now, for the router (P3-4b): an active address and its org, a retired one
 * and until when it answers a notice, or nothing (a request, a refusal, no such label).
 */
export async function addressRoute(label: string): Promise<{ state: 'active' | 'retired'; orgId: string; noticeUntil: Date | null } | null> {
  const row: any = await OrgAddress.findOne({ label, state: { $in: ['active', 'retired'] } }, { state: 1, orgId: 1, noticeUntil: 1 }).lean()
  return row ? { state: row.state, orgId: String(row.orgId), noticeUntil: row.noticeUntil ?? null } : null
}

/** The active address labels of these orgs: where "Sign in with LGR" may send a person back (FR-20.78). */
export async function activeLabelsOf(orgIds: readonly unknown[]): Promise<string[]> {
  if (!orgIds.length) return []
  const rows: any[] = await OrgAddress.find({ orgId: { $in: orgIds.map(String).filter(isId).map(oid) }, state: 'active' }, { label: 1 }).lean()
  return rows.map(r => r.label)
}

/** Global only: a master has no addresses. */
export function addressesHere(): boolean {
  return nodeRole() === 'global'
}
