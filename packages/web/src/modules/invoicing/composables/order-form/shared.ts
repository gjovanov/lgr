/**
 * FR-32.23 (#797): what the supplier order form (`OrderFormView`, ORDO) and the customer order form
 * (`InternalOrderFormView`, ORDI) do the same way, as plain functions. The state they share is `useOrderFormBase`.
 */

/** The `t` of vue-i18n, as these helpers call it. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** Which pool of contacts a field searches: the suppliers, or everyone (the clients). */
export type ContactPool = 'supplier' | 'client'

/** The colour of a reservation's status, on the tree and on the Reservations card of both forms. */
export function resStatusColor(status: string): string {
  return status === 'active' ? 'primary' : status === 'fulfilled' ? 'success' : 'error'
}

/** A contact's name as the forms show it: the company, else the person. */
export function contactName(c: any): string {
  return c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ')
}

/**
 * FR-28.28: several articles at once. The first goes on the line the dialog was opened from, as one pick would; each
 * of the others on the next free line of the same list, through the line's own after-pick logic (`take`).
 */
export function fillPickedLines<L extends { productId?: string; description: string }>(
  lines: L[],
  from: number,
  picked: any[],
  blank: () => L,
  take: (line: L, product: any) => void,
): void {
  let li = from
  picked.forEach((p, i) => {
    if (i > 0) {
      li += 1
      const next = lines[li]
      if (!next || next.productId || next.description) lines.splice(li, 0, blank())
    }
    const line = lines[li]
    if (!line) return
    take(line, p)
  })
}

/** The status pipeline over the form's title: four steps, the one the order is at, and a cancelled order in red. */
export function orderStatusDef(steps: string[], current: string, status: string) {
  return {
    steps: steps.map((s) => `invoicing.status.${s}`),
    current: `invoicing.status.${current}`,
    colors: status === 'cancelled' ? { [`invoicing.status.cancelled`]: 'error' } : undefined,
  }
}
