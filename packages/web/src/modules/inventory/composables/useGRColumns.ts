import { useAppStore } from '../store/app.store'
import { useGRColumns as useGRColumnsShared } from 'ui-shared/composables/useGRColumns'
import { jwtUserId } from 'ui-shared/composables/useStorageIdentity'

export { GR_COLUMNS } from 'ui-shared/composables/useGRColumns'
export type { GRColumn, GRColumnSection } from 'ui-shared/composables/useGRColumns'

/**
 * App-store-bound wrapper around the shared composable (storage key per user × org).
 *
 * The user comes from the session token. It used to be `appStore.user._id`, which `/auth/me`
 * never returns (its user is JWT-shaped: `id`), so every preference was saved under `anon`. The
 * shared composable still reads an `anon` key when the user's own is missing, so nothing saved
 * there is lost.
 */
export function useGRColumns() {
  const appStore = useAppStore()
  return useGRColumnsShared({
    userId: jwtUserId,
    orgId: () => appStore.currentOrg?.id,
  })
}
