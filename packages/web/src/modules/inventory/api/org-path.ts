import { useAppStore } from '../store/app.store'

/**
 * FR-32.24 (#797): the inventory screens' HTTP calls live in this folder, one module per resource, each function with
 * the body its route's schema declares and the answer its handler returns. A component calls a function here and
 * makes no request of its own (`unit/ui-api-modules.test.ts`).
 *
 * The path of a route of the tab's org, `/org/<id><path>`. Read at the call, as the screens read `appStore.orgUrl()`.
 */
export function orgPath(path = ''): string {
  return `${useAppStore().orgUrl()}${path}`
}

/** What every list route answers beside its own key (`findAll`'s page). */
export interface ListPage {
  total: number
  page: number
  size: number
  totalPages: number
  /** The list stopped at its ceiling (FR-30.8). */
  truncated?: boolean
}
