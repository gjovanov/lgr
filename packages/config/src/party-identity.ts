/**
 * FR-25a: what a document says of its two parties beyond their names and numbers. The МОЛ, the person legally
 * responsible for a company (`Org.representative`, `Contact.representative`), the town the company issues its
 * documents in (`Org.placeOfIssue`), and the company's economic activity code (`Org.activityCode`, which no document
 * prints: statistics and the annual filings read it).
 *
 * Import-pure: the API's body schemas, the settings page, the contact form, the in-app forms (`invoicing-ui`) and the
 * server's printed forms (`reporting/pdf/*`) read the same rules, so the two renderers of a document cannot disagree.
 */

/** The longest МОЛ a company or a contact may have: a person's name, with room to spare. */
export const MAX_REPRESENTATIVE_LENGTH = 200
/** The longest place of issue: a town. */
export const MAX_PLACE_OF_ISSUE_LENGTH = 100
/** The longest activity code (a КИД class is `47.52`). */
export const MAX_ACTIVITY_CODE_LENGTH = 20
/** An activity code: digits in groups joined by dots (`47`, `47.5`, `47.52`). As a pattern, for a body schema. */
export const ACTIVITY_CODE_PATTERN = '^[0-9]+(\\.[0-9]+)*$'

const ACTIVITY_CODE_RE = new RegExp(ACTIVITY_CODE_PATTERN)

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Empty is valid: the code is optional. Anything typed is digits in dot-joined groups, within the bound. */
export function isValidActivityCode(v: unknown): boolean {
  const s = text(v)
  return !s || (s.length <= MAX_ACTIVITY_CODE_LENGTH && ACTIVITY_CODE_RE.test(s))
}

/** The МОЛ a party prints, trimmed. `''` when it has none, and then the document prints no МОЛ line for it. */
export function representativeOf(party: unknown): string {
  return text((party as { representative?: unknown } | null | undefined)?.representative)
}

/**
 * Where a document says it was issued. Its own place of transaction wins, printed as it is stored; the company's
 * place of issue is the fallback; `''` when neither is set, and then nothing is printed.
 *
 * ⚠ For a company that sets no place of issue this is exactly the document's own value, whatever it holds, so its
 * documents print byte for byte as they did before the company could have one.
 */
export function placeOfIssueOf(docPlace: unknown, org: unknown): string {
  const own = typeof docPlace === 'string' ? docPlace : ''
  if (own.trim()) return own
  return text((org as { placeOfIssue?: unknown } | null | undefined)?.placeOfIssue) || own
}

/** The company's three FR-25a fields, as an org's update stores them. */
export const ORG_IDENTITY_FIELDS = ['representative', 'placeOfIssue', 'activityCode'] as const
export type OrgIdentityField = (typeof ORG_IDENTITY_FIELDS)[number]

/**
 * An org update's FR-25a fields, split into what it sets and what it clears. Each is trimmed; a field sent empty is
 * cleared (`$unset`), so the company reads exactly like one that never set it. A field the update does not carry is
 * in neither list, and keeps what is stored.
 */
export function orgIdentityUpdate(body: Partial<Record<OrgIdentityField, unknown>>): {
  set: Partial<Record<OrgIdentityField, string>>
  unset: OrgIdentityField[]
} {
  const set: Partial<Record<OrgIdentityField, string>> = {}
  const unset: OrgIdentityField[] = []
  for (const field of ORG_IDENTITY_FIELDS) {
    if (!(field in body) || body[field] === undefined) continue
    const v = text(body[field])
    if (v) set[field] = v
    else unset.push(field)
  }
  return { set, unset }
}
