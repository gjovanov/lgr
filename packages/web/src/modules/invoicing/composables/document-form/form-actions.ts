/**
 * The one list of actions a document form offers, with no Vue in it.
 *
 * `DocumentForm` hands a single list to `EntityFormShell`, which draws it twice: under the title and at the
 * foot of the form. The list is the document's own steps (`useDocumentForm#formActions`: issue, receive, save,
 * convert, pay, correct), then what puts the document out (print, the stock receipt, e-mail), with Import
 * kept last. There is no second place that decides what a bar offers, so the two bars cannot differ.
 */

/**
 * Whose label is given up first where a bar is too narrow for every label (`FormAction#collapse`, the lowest
 * first): the action used least. What a person presses every day keeps its word the longest, and the steps
 * that move the document on (issue, receive, save, a payment) name no rank: they always keep it.
 */
export const COLLAPSE = {
  /** Import from a file: once per document, if ever. */
  import: 1,
  /** What may follow from a document, rarely: attaching it to a cash sale, converting a quote not issued yet. */
  followUp: 2,
  /** A debit note for it, and then a credit note: the one written more often keeps its word longer. */
  debitNote: 3,
  creditNote: 4,
  stockReceipt: 5,
  email: 6,
  print: 7,
} as const

/** The key of the Import action: the output actions go in front of it. */
export const IMPORT_KEY = 'import'

/**
 * `workflow` with the `output` actions in their place: after every step of the document, before Import. An
 * output action the document does not offer now is null (no e-mail of an incoming bill, no stock receipt
 * before one was booked) and is left out.
 */
export function withOutputActions<T extends { key?: string }>(workflow: T[], output: Array<T | null | undefined>): T[] {
  const offered = output.filter((a): a is T => !!a)
  const at = workflow.findIndex((a) => a.key === IMPORT_KEY)
  if (at < 0) return [...workflow, ...offered]
  return [...workflow.slice(0, at), ...offered, ...workflow.slice(at)]
}
