import { useAppStore } from '../store/app.store'

/**
 * FR-32.24 (#797): the invoicing screens' HTTP calls live in this folder, one module per resource, each function with
 * the body its route's schema declares and the answer its handler returns. A component or a composable calls a function
 * here and makes no request of its own (`unit/ui-api-modules.test.ts`).
 *
 * The types are written from the controllers, each module naming its own: a UI package cannot import an API package's
 * schema without bringing the server's program, and Elysia, into `vue-tsc` and the web build.
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

/** What a route answers when it deletes or deactivates a record. */
export interface Done {
  message: string
}
