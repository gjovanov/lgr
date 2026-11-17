/**
 * FR-30.7 / FR-30.8: what a list answers with, and how many rows at most.
 *
 * **Rows, not documents (FR-30.7, D-1).** A list endpoint asked with `fields=list` answers each row without what its
 * grid and its row actions never read: an invoice's lines (5 of the 5.8 KB an invoice averages), an article's legacy
 * price arrays and its price slots' filters, a movement's line costs, the lowered search mirrors. An answer without the
 * parameter stays whole, so the importers, the skills and every other caller are untouched. The UI asks.
 *
 * Each projection EXCLUDES, rather than names what is kept: a grid reads a field nobody listed, and an exclusion keeps
 * it. What is left out is what `integration/list-projection.flow.test.ts` holds each list to.
 *
 * **A ceiling (FR-30.8, D-2).** No list answer carries more than `LIST_CEILING` rows, whatever `size` says. `size <= 0`
 * ("All") means "up to the ceiling", and an answer that was cut says so: `truncated: true`, with the real `total`. The
 * repository applies it (`dal-mongo` `findAll`, `services/utils/pagination`, `services/biz/sorted-page`). A caller that
 * reads every row on purpose says so (`PageRequest.unbounded`): server code, and an endpoint's declared lean "all".
 *
 * Import-pure: the API and the grids read the same table.
 */

/** The most rows one list answer carries (D-2). */
export const LIST_CEILING = 1000

/** The value of `fields` that asks for rows. */
export const LIST_FIELDS = 'list'

/**
 * The stock levels' declared lean "all" (FR-30.8, §2.6): every level of a warehouse, past the ceiling, as the count
 * form needs them, each with only the article's id, name, SKU and unit, its quantity and its average cost.
 */
export const COUNT_FIELDS = 'count'

export type ListRowsId = 'invoices' | 'products' | 'contacts' | 'stockLevels' | 'movements'

/** The lowered mirrors `lowered-fields.plugin` keeps for search. No screen reads them. */
const PRODUCT_MIRRORS = ['nameLower', 'skuLower', 'barcodeLower', 'descriptionLower', 'categoryLower']
const CONTACT_MIRRORS = ['companyNameLower', 'firstNameLower', 'lastNameLower', 'emailLower', 'taxIdLower', 'vatNumberLower', 'aliasesLower', 'representativeLower']

const excluding = (fields: readonly string[]): Record<string, 0> => Object.fromEntries(fields.map((f) => [f, 0 as const]))

/** Per list, what a row leaves out. */
export const LIST_ROW_EXCLUDES: Record<ListRowsId, Record<string, 0>> = {
  // Sales invoices, Bills, Proforma, Offers and the Reports tabs. The lines are the document; the row is its head.
  invoices: excluding(['lines']),
  // The grid shows each price slot's final price under its name (`tierPrice`), and the cost redaction reads the names.
  // The filters of a slot, the legacy price arrays, the variants and the pictures are the form's.
  products: excluding([
    'customPrices', 'tagPrices', 'categoryPrices', 'variants', 'images', 'dimensions',
    'priceTiers.contactIds', 'priceTiers.tags', 'priceTiers.minQuantity', 'priceTiers.validFrom', 'priceTiers.validTo',
    ...PRODUCT_MIRRORS,
  ]),
  // The list and the pickers. A document's party block reads the picked contact's addresses and tax numbers, so they
  // stay; the notes are the form's.
  contacts: excluding(['notes', ...CONTACT_MIRRORS]),
  // A level is small already. What the list adds (the article's name and SKU, the warehouse's name) is read narrowly.
  stockLevels: {},
  // The list counts a movement's lines and, filtered to one article, sums its quantity: the rest of a line stays.
  movements: excluding([
    'lines.unitCost', 'lines.totalCost', 'lines.batchNumber', 'lines.expiryDate', 'lines.serialNumbers', 'lines.costAllocations',
    'lines.resolvedUnitCost', 'lines.costingMethod', 'lines.productUpdate', 'lines.priceTiers',
  ]),
}

/** The projection a list request asks for: its rows with `fields=list`, else none (the whole document). */
export function listProjection(list: ListRowsId, fields: unknown): Record<string, 0> | undefined {
  if (fields !== LIST_FIELDS) return undefined
  const p = LIST_ROW_EXCLUDES[list]
  return Object.keys(p).length ? p : undefined
}

/**
 * The rows a page asks for, under the ceiling: `size <= 0` ("All") and anything above the ceiling are the ceiling.
 * `asked` is what was asked for (Infinity for "All"), so the caller can tell a cut answer.
 */
export function pageUnderCeiling(size: number, unbounded = false): { take: number; asked: number } {
  const asked = !Number.isFinite(size) || size <= 0 ? Infinity : Math.floor(size)
  return { take: unbounded ? asked : Math.min(asked, LIST_CEILING), asked }
}
