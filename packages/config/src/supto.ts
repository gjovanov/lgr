import data from './supto.json'

/**
 * FR-20.50 (plan step P3-8c): a SUPTO version travels only once declared.
 *
 * Under Н-18 чл. 52в(3) and (3а) a change to Прил. 29 functionality or to the database structure is a
 * new SUPTO version, which the producer declares to НАП within 7 days; a build within a version is not
 * one. The data is `supto.json`, so that the build host's deploy reads it with `jq` and the supervisor
 * with `include_str!`; this is its reading for the code. Import-pure.
 *
 * - **Not enforced while nothing is declared:** LGR is not on НАП's list yet, and no SUPTO version
 *   binds anyone.
 * - Once something is: a release of a declared version travels, and so does a build within the
 *   version that runs. Any other waits, on a master (the update offer) and on lgrai.app (the deploy).
 * - ⚠ A release that names no SUPTO version waits once enforced: it cannot be shown to be declared.
 */

export const SUPTO_VERSION: string = data.version
export const SUPTO_DECLARED: readonly string[] = data.declared

/** What a SUPTO version may look like: short, and safe in a file name and a log line. */
export const SUPTO_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/

export interface SuptoOffer {
  /** The release's SUPTO version; null when it names none (or none that is one). */
  version: string | null
  /** Whether that version is among the declared ones. */
  declared: boolean
  /** False while nothing is declared: then nothing waits. */
  enforced: boolean
}

/** What an update offer says of a release's SUPTO version, against the declared ones. */
export function suptoOffer(version: string | null | undefined, declared: readonly string[] = SUPTO_DECLARED): SuptoOffer {
  const v = typeof version === 'string' && SUPTO_VERSION_RE.test(version.trim()) ? version.trim() : null
  return { version: v, declared: v !== null && declared.includes(v), enforced: declared.length > 0 }
}

/**
 * The SUPTO version a release waits for, or null when it may travel: nothing declared yet, a declared
 * version, or a build within the version that runs. The supervisor's `supto::waits` is the same rule.
 */
export function suptoWaits(offer: SuptoOffer, running: string | null): string | null {
  if (!offer.enforced || offer.declared) return null
  if (offer.version !== null && offer.version === running) return null
  return offer.version ?? 'unknown'
}
