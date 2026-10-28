import { canOpenPage, pageById, type PageViewer } from 'ui-shared/nav/page-registry'

/**
 * FR-22.47: what an article offers — „Заприходи", „Продай", „Резервирай" — in the Products list's
 * row menu and on the article's own page. Each opens the form „+ Нов" opens for that document (the
 * same PAGE_REGISTRY row: its path, its app, and the write permission its Save needs, §5.8), with
 * `?productId=` so the article is on its first line. The forms read that parameter themselves: the
 * goods receipt (`MovementFormView`), every invoicing document form (`useDocumentForm`) and the
 * Reservations list's create dialog.
 *
 * Pure — no Vue, no window — so `unit/product-doc-actions.test.ts` holds the rules. Turning `path`
 * into a link (a route in this app, `appHref` into another) is the caller's.
 */

/** What the rules read of an article. The list row and the product page both have it. */
export interface ProductForActions {
  _id: string
  /** `false`: deactivated (FR-22.48). Unset reads as active, as everywhere else. */
  isActive?: boolean
  /** `false`: a service — no stock to receive or hold (`invoicing.service#stockTrackedIds`). */
  trackInventory?: boolean
}

export type ProductDocActionKey = 'receive' | 'sell' | 'reserve'

export interface ProductDocAction {
  key: ProductDocActionKey
  labelKey: string
  icon: string
  /** The document's name as „+ Нов" pages it („Нова стокова разписка"): what the action opens. */
  pageLabelKey: string
  /** The app that has the form, and the form's app-prefixed path, opened on this article. */
  appId: string
  path: string
  /** Why it cannot be taken on this article now (an i18n key); null when it can. */
  disabledKey: string | null
}

interface Rule {
  key: ProductDocActionKey
  pageId: string
  labelKey: string
  /** It moves or holds stock, which a service never has: not offered on one. */
  stock: boolean
  /** It sells the article, which a deactivated one no longer is: shown, but disabled. */
  sells: boolean
}

const RULES: readonly Rule[] = [
  { key: 'receive', pageId: '/inventory/movements/new', labelKey: 'warehouse.productActions.receive', stock: true, sells: false },
  { key: 'sell', pageId: '/invoicing/invoices/new', labelKey: 'warehouse.productActions.sell', stock: false, sells: true },
  { key: 'reserve', pageId: '/invoicing/reservations/new', labelKey: 'warehouse.productActions.reserve', stock: true, sells: true },
]

/** Why a deactivated article is neither sold nor reserved from here. */
export const INACTIVE_KEY = 'warehouse.productActions.inactive'

/**
 * The actions this person may take on this article, in menu order. One they may not take (the
 * form's Save would be refused) is left out, as „+ Нов" leaves it out; so is receiving or reserving a
 * service. Selling or reserving a deactivated article is listed, disabled, with the reason.
 * Receiving one is not refused: goods still arrive for an article being phased out.
 */
export function productDocActions(product: ProductForActions, who: PageViewer | null | undefined): ProductDocAction[] {
  const out: ProductDocAction[] = []
  for (const rule of RULES) {
    const page = pageById(rule.pageId)
    if (!page || !canOpenPage(page, who)) continue
    if (rule.stock && product.trackInventory === false) continue
    out.push({
      key: rule.key,
      labelKey: rule.labelKey,
      icon: page.icon,
      pageLabelKey: page.labelKey,
      appId: page.appId,
      path: withProduct(page.path, product._id),
      disabledKey: rule.sells && product.isActive === false ? INACTIVE_KEY : null,
    })
  }
  return out
}

/** The form's path with the article it starts from. */
export function withProduct(path: string, productId: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}productId=${encodeURIComponent(productId)}`
}
