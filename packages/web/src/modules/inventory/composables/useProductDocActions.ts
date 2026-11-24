import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { productDocActions, type ProductDocAction, type ProductForActions } from './product-doc-actions'

/** An action with its link: a route of the one SPA (`to`), or, kept for callers, a plain `href`. */
export interface ProductDocLink extends ProductDocAction {
  to?: string
  href?: string
}

/**
 * FR-22.47: `productDocActions` for this person, each with the link that opens it. Every module is a
 * route of the one SPA (FR-24.21), so a form in another module is a router push like one in this
 * module: the full path, which the router resolves.
 */
export function useProductDocActions() {
  // The session cannot change under a mounted page — a switch or a sign-in reloads it.
  const viewer = sessionViewer()

  function actionsFor(product: ProductForActions): ProductDocLink[] {
    return productDocActions(product, viewer).map(a => ({ ...a, to: a.path }))
  }

  return { actionsFor }
}
