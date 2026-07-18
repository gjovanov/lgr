import { useAppStore } from '../store/app.store'
import { useGRColumns as useGRColumnsShared } from 'ui-shared/composables/useGRColumns'

export { GR_COLUMNS } from 'ui-shared/composables/useGRColumns'
export type { GRColumn, GRColumnSection } from 'ui-shared/composables/useGRColumns'

/** App-store-bound wrapper around the shared composable (storage key per user × org). */
export function useGRColumns() {
  const appStore = useAppStore()
  return useGRColumnsShared({
    userId: () => (appStore.user as any)?._id,
    orgId: () => appStore.currentOrg?.id,
  })
}
