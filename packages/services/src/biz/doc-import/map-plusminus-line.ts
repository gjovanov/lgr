/**
 * Which article a PlusMinus document line is about.
 *
 * `item` is the stock item key (`СТОКИ:ГАЙКА М10 - DIN 985 - А2`); `name` is a free display ALIAS the
 * operator may have typed over it. Stock moves on the item. Seen on regal-pz (2026-11-01), in ~10 lines
 * of ~12,000: name "ГАЙКА М10 - DIN 985 - А2 - Gleitmo" on item "ГАЙКА М10 - DIN 985 - А2", and a
 * transfer line "…Ф6Х24 - Ш.П" on item "…Ф6Х24 - Ш.П." — the alias matched no catalogue product, so the
 * line was left unbooked ("stock stays too high") or blocked its whole document.
 *
 * Used by the stock-document mappers (receipts, transfers, write-offs), where the name is only ever a
 * lookup key. NOT used by the invoice mapper: there `name` is the description printed to the customer,
 * and changing it would rewrite a legal document's text — the invoice path matches on the description
 * server-side, so an aliased invoice line is repaired by linking the product, not by renaming it.
 */

/** PlusMinus prefixes an item key with its group. Only the known groups are stripped (a colon inside a name is kept). */
export const stripItemLabel = (s: unknown): string => String(s ?? '').replace(/^(СТОКИ|УСЛУГИ|МАТЕРИАЛИ):/, '').trim()

export function lineItemName(l: { name?: unknown; item?: unknown }): string {
  return stripItemLabel(l.item) || String(l.name ?? '').trim()
}
