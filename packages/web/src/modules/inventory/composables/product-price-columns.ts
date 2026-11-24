/**
 * The Products list's price-tier columns now live in `ui-shared` (FR-28.22): the list and the product
 * dialog show the same columns, and the dialog is mounted by the invoicing and inventory screens alike.
 * This file keeps the old path, which a unit test and the Suppliers tab import.
 */
export * from 'ui-shared/composables/product-price-columns'
