import { useRouter } from 'vue-router'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { appHref } from 'ui-shared/nav/navigate'
import { appRelativePath, routerAppId } from 'ui-shared/nav/open-page'
import { productDocActions, type ProductDocAction, type ProductForActions } from './product-doc-actions'

/** An action with its link: a route in this app (`to`), or a page in another one (`href`). */
export interface ProductDocLink extends ProductDocAction {
  to?: string
  href?: string
}

/**
 * FR-22.47: `productDocActions` for this person, each with the link that opens it. A form in another
 * app is a page load through `appHref` (never a route name: each app is its own SPA), which carries
 * the dev hand-off where one is needed; a form in this app is a route.
 */
export function useProductDocActions() {
  const router = useRouter()
  const here = routerAppId(router.options.history.base)
  // The session cannot change under a mounted page — a switch or a sign-in reloads it.
  const viewer = sessionViewer()

  function actionsFor(product: ProductForActions): ProductDocLink[] {
    return productDocActions(product, viewer).map((a) =>
      a.appId === here ? { ...a, to: appRelativePath(a) } : { ...a, href: appHref(a.appId, a.path) },
    )
  }

  return { actionsFor }
}
