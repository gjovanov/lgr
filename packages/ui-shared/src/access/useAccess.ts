import { can as grantCan, canOpen, type CapabilityId, type Grant } from 'config/access'
import { sessionViewer } from '../composables/useStorageIdentity'
import { grantOfViewer } from '../nav/page-registry'

/**
 * FR-27.2 (#529) — what this tab's session may do, for the views: the same grant and the same `can()` the server
 * decides by: the token's claims compiled (`compileLegacy`), exactly as today's permission checks, or, in an org on
 * `roles`, the role's grant as `/auth/me` said, followed live (FR-27.5, `live-grant.ts`).
 *
 * Read from the token, like `sessionViewer`: the app store's user is null on a fresh page load.
 */
export function accessGrant(): Grant {
  return grantOfViewer(sessionViewer())
}

export function useAccess() {
  return {
    grant: accessGrant,
    can: (cap: CapabilityId | readonly CapabilityId[]): boolean => grantCan(accessGrant(), cap),
    canOpen: (pageId: string): boolean => canOpen(pageId, accessGrant(), sessionViewer()?.amr),
  }
}
