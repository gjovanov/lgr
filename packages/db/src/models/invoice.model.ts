import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IPriceStep {
  type: string
  label: string
  price: number
}

/**
 * Back-references from an invoice line into the order/reservation graph.
 * Supply side (ORDO): orderId/groupId/lineId/allocationId — set on ORD-linked bill
 * imports and on conversions consuming order-source reservations. Demand side (ORDI):
 * internalOrderId/internalOrderLineId — set on conversions executing an internal order.
 * reservationId points at the Reservation (RES-) document the line consumes; lines from
 * stock-source reservations carry only reservationId + the demand refs.
 */
export interface IInvoiceLineOrderRef {
  orderId?: Types.ObjectId
  groupId?: Types.ObjectId
  lineId?: Types.ObjectId
  allocationId?: Types.ObjectId
  reservationId?: Types.ObjectId
  internalOrderId?: Types.ObjectId
  internalOrderLineId?: Types.ObjectId
}

export interface IInvoiceLine {
  productId?: Types.ObjectId
  description: string
  quantity: number
  unit: string
  unitPrice: number
  discount: number
  taxRate: number
  taxAmount: number
  lineTotal: number
  accountId?: Types.ObjectId
  warehouseId?: Types.ObjectId
  priceExplanation?: IPriceStep[]
  /** Back-reference into the source Order (conversion / ORD-linked bill import). */
  orderRef?: IInvoiceLineOrderRef
  /** Original OCR-extracted description (before product matching) — feeds alias learning. */
  sourceText?: string
  /** On an invoice for a cash sale: the `_id` of the cash-sale line this line invoices. */
  cashSaleLineId?: Types.ObjectId
}

/**
 * The cash sale an invoice was issued for („фактура към касова продажба", #171).
 *
 * The cash sale moved the stock and took the money; this invoice is the tax document for that
 * sale. So it moves no stock (`stockSource` is set as well), is born paid, posts no journal
 * entry, and the reports count the sale once, on the cash sale (`services/biz/sale-counting.ts`).
 *
 * Only the invoice stores the link. An issued sale is never written to (FR-20.51), so the cash
 * sale's side is read through the `{orgId, 'cashSaleRef.cashSaleId'}` index.
 */
export interface IInvoiceCashSaleRef {
  cashSaleId: Types.ObjectId
  /** The cash sale's number when the invoice was made (CS-/CSR-…). */
  number: string
  /** The date of the sale, which the invoice prints as its tax event. */
  issueDate: Date
  /** The customer the cash sale itself named, if any: the per-customer reports need it. */
  contactId?: Types.ObjectId
  /** A till sale's УНП and fiscal receipt number, printed beside its number (FR-21 §3.9). */
  unp?: string
  receiptNumber?: string
}

export interface IInvoicePayment {
  date: Date
  amount: number
  method: string
  reference?: string
  bankAccountId?: Types.ObjectId
  journalEntryId?: Types.ObjectId
  /**
   * Set when the system, not a person, recorded it: `cash_on_issue` / `card_on_issue` (paid at the
   * counter as the invoice was issued — services/biz/cash-settlement), or `cash_register` — the
   * money of an invoice for a cash sale, which that cash sale took. `payment_receipt`: taken at the
   * counter on a printed receipt (FR-23), `receiptId`.
   */
  origin?: string
  /**
   * FR-23: the `payment_receipt` that took this money. The link between the two lives here, on a
   * key that survives: `payment.recorded` writes the array back through the repository, which gives
   * every row a new `_id`.
   */
  receiptId?: Types.ObjectId
  /** The `Idempotency-Key` that recorded this payment, and its request hash (#155). */
  clientKey?: string
  requestHash?: string
  /**
   * FR-21: what the customer handed over, when it differs from `amount` — a till sale tendered 50
   * for 37.20 records `amount: 37.2, tendered: 50`. `amount` is always what was kept, so the
   * payments of a document add up to its total; SUPTO 18.2 prints `tendered ?? amount`.
   */
  tendered?: number
}

/**
 * FR-21 (D-3) — the cash-register block, on `cash_sale`, `cash_storno` and `payment_receipt`
 * (FR-23) documents only: what a POS transaction carries and an invoice does not. A till sale copied from `postransactions` keeps
 * every field it had here, so the readers that still speak POS rows read it back unchanged
 * (`services/biz/cash-register/mapping.ts`).
 */
export interface IInvoiceRegister {
  /** `pos` the till, `backoffice` the form or the API, `import` a PlusMinus day (Files, CLI). */
  origin?: 'pos' | 'backoffice' | 'import'
  /**
   * FR-21.31 (D-13): entered in the back office by a cashier with an open session, which it joined.
   * Its `origin` is then `pos`: it is that drawer's sale, in its totals, its close JE and SUPTO.
   */
  joinedFrom?: 'backoffice'
  sessionId?: Types.ObjectId
  warehouseId?: Types.ObjectId
  cashierId?: Types.ObjectId
  fiscalDeviceNumber?: string
  operatorCode?: string
  /** УНП — Наредба Н-18, Прил. 29 т. 9. */
  unp?: string
  fiscalReceiptNumber?: string
  printedAt?: Date
  isFiscal?: boolean
  /** The receipt as a step that survives a crash (#155); see `POSTransaction.fiscal`. */
  fiscal?: {
    state: 'pending' | 'printed' | 'failed' | 'unknown' | 'none'
    mode?: 'fiscal' | 'text'
    attemptedAt?: Date
    counterBefore?: number
    receiptNo?: string
    printedAt?: Date
    error?: string
  }
  changeDue?: number
  sessionTotalsApplied?: boolean
  receiptError?: string
  stockError?: string
  /** The dispatch (sale) or return (storno) the till booked for it. */
  movementId?: Types.ObjectId
  /** On a `payment_receipt` (FR-23): the invoice or debit note it took money for. */
  paidInvoiceId?: Types.ObjectId
  /** What the person who settled a receipt in doubt said, and who it was. */
  settled?: { printed: boolean; by: Types.ObjectId; at: Date }
  paidInvoiceNumber?: string
  /** On a `payment_receipt`: the free text printed under its lines, „Фактура № …". */
  receiptText?: string
  /** On a `cash_storno`: the sale it reverses, as its fiscal receipt names it. */
  storno?: {
    originalId?: Types.ObjectId
    originalUnp?: string
    originalReceiptNumber?: string
    originalDate?: Date
    reason?: string
  }
  /**
   * On a `cash_sale`: whether a storno reversed it. The sale stays `paid` and keeps counting; its
   * storno counts against it (FR-21.1). Never flip the sale to `cancelled`.
   */
  stornoState?: 'none' | 'full'
  stornoedBy?: Types.ObjectId[]
  /** When it was stornoed (a sale) or voided (a storno whose receipt failed) — SUPTO 18.5. */
  cancelledAt?: Date
  /** On a document copied from `postransactions`: where it came from. */
  legacy?: { source: string; type?: string; transactionNumber?: string }
}

export interface IInvoiceAddress {
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
}

export interface IInvoiceRecurringConfig {
  enabled: boolean
  frequency: string
  nextDate: Date
  endDate?: Date
}

export interface IInvoiceStatusEntry {
  status: string
  fromStatus?: string
  changedAt: Date
  changedBy?: Types.ObjectId
  reason?: string
}

export interface IInvoice extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  invoiceNumber: string
  type: string
  direction: string
  status: string
  statusHistory: IInvoiceStatusEntry[]
  contactId?: Types.ObjectId
  issueDate: Date
  dueDate: Date
  currency: string
  exchangeRate: number
  reference?: string
  lines: IInvoiceLine[]
  subtotal: number
  discountTotal: number
  taxTotal: number
  total: number
  totalBase: number
  amountPaid: number
  amountDue: number
  payments: IInvoicePayment[]
  /**
   * FR-23: the money the receipts printing right now are taking, each until its payment is recorded
   * or its print fails. Part of what is due in every payment's check, so a payment recorded while a
   * receipt prints cannot take the same money. On the document, because that check is one atomic
   * update; a receipt is a document of its own, and two of them could not see each other.
   */
  receiptHolds?: Array<{ receiptId: Types.ObjectId; amount: number }>
  /** FR-23: a void has claimed this document until then, so no receipt takes a hold on it meanwhile. */
  voidingUntil?: Date | null
  /**
   * FR-23: this cash-on-delivery invoice was issued where LGR prints, so it owes a receipt. Written by
   * the issue, in the issue's own write, and never by a client.
   */
  deliveryReceiptOwed?: boolean
  // ── Idempotency (FR-20.37, #155) ──
  /** The `Idempotency-Key` that created this document, and the hash of that request. */
  clientKey?: string
  requestHash?: string
  /** One request at a time finishes a keyed create; `completedAt` marks it finished. */
  leaseUntil?: Date
  completedAt?: Date
  /**
   * The claim on issuing a draft (`/send`). Held while one request dispatches the stock and
   * allocates the issued number, so a second Issue — a double click, a retry — cannot do it
   * again. Carries the key that issued it, so its retry gets the issued document back.
   */
  issue?: { clientKey?: string; requestHash?: string; leaseUntil?: Date; completedAt?: Date }
  /**
   * FR-20.84 (P3-6e): a document a replaced server issued after the cutoff, brought in by the audited
   * import: its source (the server, the promotion, the export), the method, when, and who asked
   * (Прил. 42). Everything else of the document is as the site wrote it; `number` is the site's when
   * the import had to give a draft another. `reseed_kept` (P3-7g): what a re-seed kept on the server,
   * brought in there (no export, so no `exportId`).
   */
  importedFrom?: { kind: 'fenced_export' | 'reseed_kept'; exportId?: Types.ObjectId; moveId: Types.ObjectId; nodeId: string; at: Date; by: Types.ObjectId; number?: string }
  /**
   * FR-20.51, AC 51: a legal number issued twice. Both documents exist on paper, so both are in the
   * books under it; this one, the second to reach this database, names the other (`withId`). The
   * unique key is `{orgId, invoiceNumber, numberClash.withId}`, so the pair fits and a third never
   * does. The LATER of the two is annulled by a credit note and re-issued under a new number (ЗДДС
   * чл. 116), never edited or deleted: `correction` holds the two drafts once a person prepares them.
   */
  numberClash?: {
    withId: Types.ObjectId
    withNumber: string
    /** Where this document came in from: `fenced_export`, `reseed_kept`. */
    source: string
    at: Date
    correction?: { target: Types.ObjectId; creditNoteId: Types.ObjectId; reissueId: Types.ObjectId; preparedAt: Date; preparedBy: Types.ObjectId }
  }
  /** How the document is (to be) paid: cash | card | bank_transfer | cash_on_delivery. */
  paymentMethod?: string
  /** Съставил — who authored the document (OCR-imported name or the creating user). */
  preparedBy?: string
  /** Място на сделката — place of transaction (e.g. "гр.Пазарджик"). */
  placeOfTransaction?: string
  notes?: string
  /**
   * Free text printed under the number/date block of the invoice form ("Доставка до обект №4").
   * Belongs to the document, not to a single print run: typed once, it is reprinted with every
   * later copy of the same invoice.
   */
  printNote?: string
  /** FR-10: recipients this document has been successfully emailed to, and when. */
  emailedTo?: string[]
  lastEmailedAt?: Date
  terms?: string
  footer?: string
  billingAddress: IInvoiceAddress
  shippingAddress?: IInvoiceAddress
  relatedInvoiceId?: Types.ObjectId
  convertedInvoiceId?: Types.ObjectId
  proformaId?: Types.ObjectId
  /** Source external order (ORDO-) this document was generated from / received against. */
  orderId?: Types.ObjectId
  /** The supplier group inside the order (ORDO-linked purchase bills). */
  orderGroupId?: Types.ObjectId
  /** Source internal order (ORDI-) this conversion invoice executes. */
  internalOrderId?: Types.ObjectId
  /** The cash sale this invoice was issued for — see `IInvoiceCashSaleRef`. */
  cashSaleRef?: IInvoiceCashSaleRef
  /**
   * Дата на данъчното събитие, when it is not the issue date. An invoice for a cash sale is
   * issued after the sale it documents and prints the sale's date. Absent ⇒ `issueDate`.
   */
  taxEventDate?: Date
  /**
   * The stock document that already moved these goods.
   *
   * PlusMinus converts a складова разписка into a фактура keeping the same lines and prices; the
   * stock left on the разписка, so the invoice must not dispatch again. The PDF export drops the
   * comment recording that, so the import recognises it from the partner and the line set and
   * writes the link here. Present ⇒ this document deliberately moves no stock.
   */
  stockSource?: {
    /** Idempotency marker of the source note, e.g. `sklrazp:0000012713`. */
    marker: string
    docNumber: string
    movementIds: Types.ObjectId[]
    /** How the link was established — `lines` (detected) or `manual`. */
    detectedBy: string
    linkedAt: Date
  }
  journalEntryId?: Types.ObjectId
  recurringConfig?: IInvoiceRecurringConfig
  attachments: Types.ObjectId[]
  pendingTransferIds?: Types.ObjectId[]
  sentAt?: Date
  paidAt?: Date
  tags?: string[]
  /** The pre-issue draft number (e.g. "DRF-INV-2026-00007") preserved on send so the
   * issued invoice keeps a pointer to its draft history. */
  draftNumber?: string
  /** Декларация за съответствие number, allocated from the CERTIFICATE counter the first
   * time the companion document is printed and reused by every later reprint. */
  certificateNumber?: string
  /** Приемо-предавателен протокол number, allocated from the PP_PROTOCOL counter on first
   * print and reused by every later reprint. */
  ppProtocolNumber?: string
  /**
   * Free text printed in the "Допълнителна информация" block of BOTH companion documents.
   * Belongs to the document rather than to a print run — typed once, it reprints with every
   * later copy of the declaration and the protocol.
   */
  companionNote?: string
  /** Append-only log of every number this document has carried, in allocation order. */
  numberHistory?: Array<{ number: string; allocatedAt: Date; status: string }>
  /** FR-21: the cash-register block, on `cash_sale`, `cash_storno` and `payment_receipt` only. */
  register?: IInvoiceRegister
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

// All fields optional: real-world counterparties often lack a postal code (or a
// structured address at all) — saving must not be blocked by address completeness.
const addressSchema = new Schema(
  {
    street: String,
    city: String,
    state: String,
    postalCode: String,
    country: String,
  },
  { _id: false },
)

const invoiceSchema = new Schema<IInvoice>(
  {
    invoiceNumber: { type: String, required: true },
    // `cash_storno` (FR-21, D-2): a storno of a cash sale, stored positive — the sign is the type.
    // `payment_receipt` (FR-23): the fiscal receipt of a payment on an invoice or a debit note. Not a
    // sale: its invoice is. A reader that has not learned the type ignores it.
    type: { type: String, required: true, enum: ['invoice', 'proforma', 'credit_note', 'debit_note', 'cash_sale', 'cash_storno', 'payment_receipt'] },
    direction: { type: String, required: true, enum: ['outgoing', 'incoming'] },
    status: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'sent', 'received', 'partially_paid', 'paid', 'overdue', 'voided', 'cancelled', 'converted'],
    },
    statusHistory: [
      {
        status: { type: String, required: true },
        fromStatus: String,
        changedAt: { type: Date, required: true, default: Date.now },
        changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        reason: String,
      },
    ],
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    currency: { type: String, default: 'EUR' },
    exchangeRate: { type: Number, required: true, default: 1 },
    reference: String,
    lines: [
      {
        productId: { type: Schema.Types.ObjectId, ref: 'Product' },
        description: { type: String, required: true },
        quantity: { type: Number, required: true },
        unit: { type: String, required: true },
        unitPrice: { type: Number, required: true },
        discount: { type: Number, default: 0 },
        taxRate: { type: Number, required: true },
        taxAmount: { type: Number, required: true },
        lineTotal: { type: Number, required: true },
        accountId: { type: Schema.Types.ObjectId, ref: 'Account' },
        warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
        priceExplanation: [
          {
            type: { type: String, enum: ['base', 'category', 'tag', 'contact', 'tier', 'override'] },
            label: String,
            price: Number,
          },
        ],
        orderRef: {
          type: new Schema(
            {
              orderId: Schema.Types.ObjectId,
              groupId: Schema.Types.ObjectId,
              lineId: Schema.Types.ObjectId,
              allocationId: Schema.Types.ObjectId,
              reservationId: Schema.Types.ObjectId,
              internalOrderId: Schema.Types.ObjectId,
              internalOrderLineId: Schema.Types.ObjectId,
            },
            { _id: false },
          ),
          required: false,
        },
        sourceText: String,
        cashSaleLineId: Schema.Types.ObjectId,
      },
    ],
    subtotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    totalBase: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 },
    amountDue: { type: Number, default: 0 },
    payments: [
      {
        date: { type: Date, required: true },
        amount: { type: Number, required: true },
        // No 'check': nobody pays by cheque here, and no document ever did. cash_on_delivery is
        // наложен платеж — the courier collects, so on an invoice it is paid later, not on issue.
        // The till takes it too (2026-10-31): a fiscal receipt in the device's own slot, the sale
        // `paid` as every till sale is, and the money on the session's own bucket, never in the
        // drawer. `mobile` and `voucher` are the till's legacy methods (FR-21): kept for copied POS
        // sales, offered by no form, and counted as "other" by every report.
        method: { type: String, required: true, enum: ['cash', 'bank_transfer', 'card', 'cash_on_delivery', 'other', 'mobile', 'voucher'] },
        tendered: Number,
        reference: String,
        bankAccountId: { type: Schema.Types.ObjectId, ref: 'BankAccount' },
        journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
        origin: { type: String, enum: ['cash_on_issue', 'card_on_issue', 'cash_register', 'payment_receipt'] },
        receiptId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
        clientKey: String,
        requestHash: String,
      },
    ],
    voidingUntil: Date,
    deliveryReceiptOwed: Boolean,
    receiptHolds: {
      type: [{ _id: false, receiptId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true }, amount: { type: Number, required: true } }],
      default: undefined,
    },
    clientKey: String,
    requestHash: String,
    leaseUntil: Date,
    completedAt: Date,
    issue: {
      clientKey: String,
      requestHash: String,
      leaseUntil: Date,
      completedAt: Date,
    },
    importedFrom: {
      kind: { type: String, enum: ['fenced_export', 'reseed_kept'] },
      exportId: Schema.Types.ObjectId,
      moveId: Schema.Types.ObjectId,
      nodeId: String,
      at: Date,
      by: Schema.Types.ObjectId,
      number: String,
    },
    paymentMethod: String,
    preparedBy: String,
    placeOfTransaction: String,
    notes: String,
    // Capped at the length the printed form will render (HEADER_NOTE_MAX in invoice.pdf.ts);
    // beyond that it would crowd the parties band.
    printNote: { type: String, maxlength: 300 },
    // FR-10: written only after a mail is actually delivered.
    emailedTo: [String],
    lastEmailedAt: Date,
    terms: String,
    footer: String,
    billingAddress: { type: addressSchema, required: true },
    shippingAddress: { type: addressSchema, required: false },
    relatedInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    convertedInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    proformaId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    orderGroupId: { type: Schema.Types.ObjectId },
    internalOrderId: { type: Schema.Types.ObjectId, ref: 'InternalOrder' },
    // A single nested subdocument, so an invoice without one carries none. The nested
    // `stockSource` path below is different: Mongoose materialises it as `{ movementIds: [] }`
    // on every invoice, which is why its readers test `stockSource?.marker`.
    cashSaleRef: {
      type: new Schema(
        {
          cashSaleId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
          number: { type: String, required: true },
          issueDate: { type: Date, required: true },
          contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
          unp: String,
          receiptNumber: String,
        },
        { _id: false },
      ),
      required: false,
    },
    taxEventDate: Date,
    // ⚠ A single nested subdocument, like `cashSaleRef`: an invoice without a clash carries none, so
    // `numberClash.withId` is missing (null) in the unique key for every ordinary document.
    numberClash: {
      type: new Schema(
        {
          withId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
          withNumber: { type: String, required: true },
          source: { type: String, required: true },
          at: { type: Date, required: true },
          correction: {
            type: new Schema(
              {
                target: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
                creditNoteId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
                reissueId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
                preparedAt: { type: Date, required: true },
                preparedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
              },
              { _id: false },
            ),
            required: false,
          },
        },
        { _id: false },
      ),
      required: false,
    },
    stockSource: {
      marker: String,
      docNumber: String,
      movementIds: [{ type: Schema.Types.ObjectId, ref: 'StockMovement' }],
      detectedBy: String,
      linkedAt: Date,
    },
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    recurringConfig: {
      enabled: Boolean,
      frequency: { type: String, enum: ['weekly', 'monthly', 'quarterly', 'yearly'] },
      nextDate: Date,
      endDate: Date,
    },
    attachments: [{ type: Schema.Types.ObjectId, ref: 'File' }],
    pendingTransferIds: [{ type: Schema.Types.ObjectId, ref: 'StockMovement' }],
    sentAt: Date,
    paidAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tags: [String],
    draftNumber: String,
    certificateNumber: String,
    ppProtocolNumber: String,
    // Capped like printNote — the companion form reserves one block for it.
    companionNote: { type: String, maxlength: 300 },
    numberHistory: [
      {
        _id: false,
        number: { type: String, required: true },
        allocatedAt: { type: Date, required: true, default: Date.now },
        status: { type: String, required: true },
      },
    ],
    register: {
      type: new Schema(
        {
          origin: { type: String, enum: ['pos', 'backoffice', 'import'] },
          joinedFrom: { type: String, enum: ['backoffice'] },
          sessionId: { type: Schema.Types.ObjectId, ref: 'POSSession' },
          warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
          cashierId: { type: Schema.Types.ObjectId, ref: 'User' },
          fiscalDeviceNumber: String,
          operatorCode: String,
          unp: String,
          fiscalReceiptNumber: String,
          printedAt: Date,
          isFiscal: Boolean,
          fiscal: {
            state: { type: String, enum: ['pending', 'printed', 'failed', 'unknown', 'none'] },
            mode: { type: String, enum: ['fiscal', 'text'] },
            attemptedAt: Date,
            counterBefore: Number,
            receiptNo: String,
            printedAt: Date,
            error: String,
            /** FR-23: nothing can prove whether it printed: no money booked, until a person settles it. */
            inDoubt: Boolean,
          },
          /** What the person who settled a receipt in doubt said, and who it was. */
          settled: { printed: Boolean, by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date },
          changeDue: Number,
          sessionTotalsApplied: Boolean,
          receiptError: String,
          stockError: String,
          movementId: { type: Schema.Types.ObjectId, ref: 'StockMovement' },
          paidInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
          paidInvoiceNumber: String,
          receiptText: String,
          storno: {
            originalId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
            originalUnp: String,
            originalReceiptNumber: String,
            originalDate: Date,
            reason: { type: String, enum: ['operator_error', 'customer_return', 'price_reduction', 'tax_base_reduction'] },
          },
          stornoState: { type: String, enum: ['none', 'full'] },
          stornoedBy: [{ type: Schema.Types.ObjectId, ref: 'Invoice' }],
          cancelledAt: Date,
          legacy: { source: String, type: { type: String }, transactionNumber: String },
        },
        { _id: false },
      ),
      required: false,
    },
  },
  { timestamps: true },
)

/** The unique key on an org's invoice numbers (AC 51), by name: migration 0010 and the tests use it. */
export const INVOICE_NUMBER_KEY = 'invoice_number_unique'

invoiceSchema.plugin(tenantPlugin)
/**
 * One number, one document, but for a number issued twice (FR-20.51, AC 51): the pair's second carries
 * `numberClash.withId`, so it fits beside the first, and a third never does. Every ordinary invoice
 * has no such field, which the key reads as null: `(org, number)` stays unique for them exactly as
 * before. Migration `0010-invoice-number-clash` replaced the old `orgId_1_invoiceNumber_1`.
 */
invoiceSchema.index({ orgId: 1, invoiceNumber: 1, 'numberClash.withId': 1 }, { unique: true, name: INVOICE_NUMBER_KEY })
// FR-20.84: what an audited import brought in, by the export it came from.
invoiceSchema.index({ orgId: 1, 'importedFrom.exportId': 1 }, { partialFilterExpression: { 'importedFrom.exportId': { $exists: true } } })
// One document per client key. Partial, so the many documents without a key never collide.
invoiceSchema.index(
  { orgId: 1, clientKey: 1 },
  { unique: true, partialFilterExpression: { clientKey: { $type: 'string' } } },
)
invoiceSchema.index({ orgId: 1, contactId: 1 })
invoiceSchema.index({ orgId: 1, status: 1 })
invoiceSchema.index({ orgId: 1, direction: 1, issueDate: -1 })
invoiceSchema.index({ orgId: 1, dueDate: 1, status: 1 })
invoiceSchema.index({ orgId: 1, tags: 1 })
invoiceSchema.index({ orgId: 1, orderId: 1 })
invoiceSchema.index({ orgId: 1, internalOrderId: 1 })
invoiceSchema.index({ orgId: 1, 'lines.orderRef.reservationId': 1 })
// The invoices of a cash sale (#171). Partial: only the few invoices that carry the link.
invoiceSchema.index(
  { orgId: 1, 'cashSaleRef.cashSaleId': 1 },
  { partialFilterExpression: { 'cashSaleRef.cashSaleId': { $exists: true } } },
)
invoiceSchema.index({ invoiceNumber: 'text', notes: 'text', reference: 'text' })
// FR-21: the cash-register journal lists by type and date; Invoice had no `type` index at all.
invoiceSchema.index({ orgId: 1, type: 1, issueDate: -1 })
invoiceSchema.index({ orgId: 1, 'register.sessionId': 1 }, { partialFilterExpression: { 'register.sessionId': { $exists: true } } })
invoiceSchema.index({ orgId: 1, 'register.unp': 1 }, { partialFilterExpression: { 'register.unp': { $type: 'string' } } })
// FR-23: the receipts that paid a document.
invoiceSchema.index({ orgId: 1, 'register.paidInvoiceId': 1 }, { partialFilterExpression: { 'register.paidInvoiceId': { $exists: true } } })

replicate(invoiceSchema, { class: 'R' })

export const Invoice = model<IInvoice>('Invoice', invoiceSchema)
