/**
 * What a test copy of an org holds, and what it never does.
 *
 * ⚠ IMPORT-PURE. This file is the answer to "may this kind of record leave the real org?" and it
 * is read by the engine, by the CLI and by the test that makes every model with an `orgId` take a
 * side (`org-clone-policy.flow.test.ts`), so a model added next month cannot be copied into a test
 * org, or left out of one, by default.
 */

/**
 * Models that are NEVER copied, wiped by a sync or synced, with the reason. The reasons fall into
 * five kinds, and each is a hazard that is invisible until it is expensive:
 *
 * - **Files and archives** (owner, 2026-11-09: "without its backups/archives and documents"). The
 *   copy carries no file store at all, so no row that points into one: its rows would be links to
 *   files that are not there, and a delete from the test org must never be able to reach a file of
 *   the real one.
 * - **Hardware.** A fiscal device or a workstation is a binding to a physical till. A test org that
 *   inherited one could print a REAL fiscal receipt on it, which is a legal event.
 * - **Devices and credentials.** Enrolments and keys belong to the org they were issued in.
 * - **People's access.** Invites carry a globally unique code that would admit someone to the test
 *   org by a link meant for the real one.
 * - **Logs and inboxes about real people.**
 */
export const NEVER_CLONED: Readonly<Record<string, string>> = {
  ArchiveUnit: 'archives: the copy carries no file store',
  DocFile: 'documents: the copy carries no file store',
  File: 'documents: the copy carries no file store',
  FiscalDevice: 'hardware: a test org must never be able to print on a real till',
  Workstation: 'hardware: bound to a till and its fiscal device',
  Desktop: 'an enrolled desktop belongs to the org it enrolled in',
  DesktopEnrollmentCode: 'an enrolment credential',
  DesktopEnrollmentKey: 'an enrolment credential',
  DesktopEnrollmentKeyUse: "an enrolment credential's use",
  Invite: 'access: carries a globally unique code that would admit someone to the test org',
  OAuthHandoff: 'a one-time sign-in credential',
  Code: 'a one-time activation credential',
  EmailLog: 'a log of mail sent to real people',
  Notification: "a person's inbox",
  PersonalDataKey: 'sealed personal data (FR-25): its key row is never copied, and a source that holds one is refused',
}

/**
 * Seeded when missing, never overwritten and never wiped by a sync. A membership is access, and who
 * may enter the test org is decided there, not by a sync from the real one; a permission set or a
 * role (FR-27) is matched by its name, so a person's role in the test org stays the test org's. The
 * apps an org has enabled are its own switches, and the app creates them by itself the first time
 * anyone opens the app hub, so a copy made after a reset finds them already there: matched by app.
 */
export const SEED_ONLY: readonly string[] = ['User', 'PermissionSet', 'Role', 'OrgApp']

/**
 * Kept by a reset (the wipe that precedes the first copy into an org that already exists): access,
 * enrolled devices and their hardware, none of which is "data" a copy replaces. A person who was
 * signed into the org before still is.
 */
export const KEPT_ON_RESET: readonly string[] = [
  'User', 'PermissionSet', 'Role', 'Invite',
  'Desktop', 'DesktopEnrollmentCode', 'DesktopEnrollmentKey', 'DesktopEnrollmentKeyUse',
  'FiscalDevice', 'Workstation',
]

/** A source org that holds any of these is refused: the engine does not know how to copy them safely. */
export const REFUSED_SOURCE_MODELS: readonly string[] = ['PersonalDataKey']

/**
 * A deep copy of the plain objects and arrays of a document, with every other value (an ObjectId, a
 * Date, a Buffer) carried by reference. Not a JSON round trip: that would turn an ObjectId into a
 * string and a Date into its text, and the copy would hold the wrong types.
 */
export function clonePlain<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clonePlain) as unknown as T
  if (v && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v)
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clonePlain(x)
      return out as T
    }
  }
  return v
}

/** The models a copy carries, given every model with an `orgId` that a backup would bundle. */
export function clonedModels(tenantModels: readonly string[]): string[] {
  return tenantModels.filter(m => !(m in NEVER_CLONED)).sort()
}

/** The order a copy writes in: the models others point at come first; the rest alphabetically. */
export function copyOrder(models: readonly string[]): string[] {
  const first = ['PermissionSet', 'Role', 'User']
  return [...first.filter(m => models.includes(m)), ...models.filter(m => !first.includes(m)).sort()]
}

/**
 * The settings a test copy of a company starts with, from the real one's. Everything that makes
 * the org behave like the company (currency, tax, time zone, locale, payroll, inventory, the
 * till's switches) is kept; everything that reaches OUT of the org is dropped:
 *
 * - the daily digest (it mails people) and the nightly backup (it fills a disk and a Drive),
 * - integrations' tokens, the desktop/node enrolment switches,
 * - the link to a legal entity's books (`accounting.books`): the one place an org knows of another.
 */
export function testOrgSettings(source: any): any {
  const s = clonePlain(source ?? {})
  delete s.integrations
  delete s.desktop
  delete s.node
  if (s.accounting) delete s.accounting.books
  s.dailyDigest = { enabled: false, recipients: [] }
  s.backup = { enabled: false }
  s.environment = 'dev'
  return s
}

/**
 * What an EXISTING org gets when it becomes a test copy: only the switches that reach out are
 * turned off. Its own settings (the till's printer gate among them) stay as its owner set them.
 */
export const OUTWARD_SWITCHES_OFF = {
  'settings.environment': 'dev',
  'settings.dailyDigest.enabled': false,
  'settings.dailyDigest.recipients': [] as unknown[],
  'settings.backup.enabled': false,
} as const

/** The company's identity: copied onto a test org from the real one, so a printed document reads as the company's. */
export const IDENTITY_FIELDS = ['description', 'taxNumber', 'vatNumber', 'email', 'phone', 'website', 'representative', 'placeOfIssue', 'activityCode', 'addresses', 'bankDetails'] as const
