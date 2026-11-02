import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { forgetDevices, tillApp, tillWorld, type TillWorld } from '../helpers/till-world'
import { draftOf, raw, send } from '../helpers/receipt-world'
import { printableDocument } from 'invoicing-api/src/lib/invoice-pdf'
import { buildInvoiceHtml } from 'reporting/pdf/invoice.pdf'
import { Invoice } from 'db/models'

/**
 * A credit or a debit note names the invoice it corrects, by number and date: ЗДДС wants both on the
 * note, and the printout named neither. The renderer's side, in four languages, is
 * `unit/invoice-pdf-form.test.ts`.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia
beforeAll(async () => { await setupTestDB(); app = tillApp() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() })

const issued = async (w: TillWorld) => {
  const d = await draftOf(w, { method: 'bank_transfer' })
  expect((await send(w, d.id)).status).toBe(200)
  return { ...d, doc: await raw(d.id) }
}

const printed = (doc: any) => buildInvoiceHtml(doc, { name: 'Org' } as any, {} as any, undefined, { locale: 'bg' }).html

describe('the invoice a note corrects, on its printout', () => {
  for (const type of ['credit_note', 'debit_note']) {
    it(`a ${type} prints its number and its date`, async () => {
      const w = await tillWorld(app, { device: false })
      const inv = await issued(w)
      const note = await draftOf(w, { type, method: 'bank_transfer', extra: { relatedInvoiceId: inv.id, contactId: inv.contactId } })

      const doc = await printableDocument(w.orgId, await raw(note.id))

      expect(doc.relatedInvoiceRef.number).toBe(inv.doc.invoiceNumber)
      expect(new Date(doc.relatedInvoiceRef.issueDate).getTime()).toBe(new Date(inv.doc.issueDate).getTime())
      const html = printed(doc)
      expect(html).toContain('Към фактура')
      expect(html).toContain(inv.doc.invoiceNumber)
    })
  }

  it('an invoice corrects nothing, and prints no such line', async () => {
    const w = await tillWorld(app, { device: false })
    const inv = await issued(w)

    const doc = await printableDocument(w.orgId, inv.doc)

    expect(doc.relatedInvoiceRef).toBeUndefined()
    expect(printed(doc)).not.toContain('Към фактура')
  })

  it('a note whose invoice is not there prints no line rather than an empty one', async () => {
    const w = await tillWorld(app, { device: false })
    const inv = await issued(w)
    const note = await draftOf(w, { type: 'credit_note', method: 'bank_transfer', extra: { relatedInvoiceId: inv.id, contactId: inv.contactId } })
    await Invoice.deleteOne({ _id: inv.id })

    const doc = await printableDocument(w.orgId, await raw(note.id))

    expect(doc.relatedInvoiceRef).toBeUndefined()
    expect(printed(doc)).not.toContain('Към фактура')
  })

  it('never reads another org\'s invoice, whatever the id on the note says', async () => {
    const w = await tillWorld(app, { device: false })
    const other = await tillWorld(app, { device: false })
    const foreign = await issued(other)
    const inv = await issued(w)
    const note = await draftOf(w, { type: 'credit_note', method: 'bank_transfer', extra: { relatedInvoiceId: inv.id, contactId: inv.contactId } })

    const doc = await printableDocument(w.orgId, { ...(await raw(note.id)), relatedInvoiceId: foreign.id })

    expect(doc.relatedInvoiceRef).toBeUndefined()
  })
})
