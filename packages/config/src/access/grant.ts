import type { CapabilityId } from './catalogue'

/**
 * FR-27.2 — what a session may do: everything (an Administrator), or a set of capabilities.
 *
 * Nothing in the model means "unrestricted" by being absent: `all` is said out loud, and an empty set is no access.
 */
export type Grant = { readonly all: true } | { readonly all?: false; readonly caps: ReadonlySet<CapabilityId> }

export const ALL: Grant = Object.freeze({ all: true as const })
export const NOTHING: Grant = Object.freeze({ caps: new Set<CapabilityId>() })

/** Whether the grant holds the capability, or any one of a list. An empty list is never held. */
export function can(grant: Grant | null | undefined, cap: CapabilityId | readonly CapabilityId[]): boolean {
  if (!grant) return false
  if (grant.all) return true
  if (typeof cap === 'string') return grant.caps.has(cap)
  return cap.some(c => grant.caps.has(c))
}
