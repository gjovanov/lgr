import { can as grantCan, canOpen, compileLegacy, type CapabilityId, type Grant } from 'config/access'
import { sessionViewer } from '../composables/useStorageIdentity'

/**
 * FR-27.2 (#529) — what this tab's session may do, for the views: the same grant and the same `can()` the server
 * decides by. Phase 0 compiles it from the token's claims (`compileLegacy`), so it answers exactly as today's
 * permission checks. Phase 1 takes it from `/auth/me` and follows a role edit live (FR-27.5).
 *
 * Read from the token, like `sessionViewer`: the app store's user is null on a fresh page load.
 */
export function accessGrant(): Grant {
  return compileLegacy(sessionViewer())
}

export function useAccess() {
  return {
    grant: accessGrant,
    can: (cap: CapabilityId | readonly CapabilityId[]): boolean => grantCan(accessGrant(), cap),
    canOpen: (pageId: string): boolean => canOpen(pageId, accessGrant(), sessionViewer()?.amr),
  }
}
