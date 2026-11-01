# FR-23 — A receipt for every cash payment on an invoice, refunds as stornos, and partial storno

| | |
|---|---|
| **Status** | Specified 2026-10-31. The owner answered every question the same day (§5). LGR is not live yet: the accountant reviews the printed receipts in real time during the go-live preparation, so nothing waits on that review. **R1 built 2026-10-31** (§6). R2 and R3 are not. |
| **Tracking** | Partial storno: [gjovanov/lgr#363](https://github.com/gjovanov/lgr/issues/363). The rest is new. |
| **Builds on** | FR-21 (#171): the register block, the till's print-once state (#155), D-13 (a back-office sale joins the cashier's open session), R0 (an invoice for a cash sale, §3.9). The printer gate (#390). |
| **Code anchors** | origin/master `a2758a9e` (2026-10-31). Anchors, not gospel. |

## 0. What the owner decided (2026-10-31)

- **A cash invoice prints a fiscal receipt** for the cash paid, with the invoice number on it, and a cash-register document („CS") is linked to the invoice.
- **At every cash payment:** when the invoice is issued and paid at the counter, and again whenever a cash payment is recorded on it later.
- **A debit note paid in cash** prints a sale receipt.
- **A credit note refunded in cash** prints a storno of the invoice's receipt. Partial storno is built (#363).
- **A cash refund with no receipt to storno is refused.**
- **Stock moves once, by the invoice.** That was the wording of the option the owner picked. An earlier design note said the opposite (the CS moves the stock, as in R0), so §1 put the choice back to him, and he confirmed the invoice.

## 1. The decision: which document moves the stock

Today, an invoice paid in cash is settled on issue (`syncCashSettlement`, payment origin `cash_on_issue`). Nothing prints. Two models can add the receipt:

| | **A — the invoice is the sale** (picked 2026-10-31) | **B — the cash sale is the sale** (R0's end state) |
|---|---|---|
| Stock and revenue | The invoice, as every invoice does today | A CS made from the invoice's lines. The invoice gets `cashSaleRef`, moves no stock and posts no JE. |
| What the CS is | The receipt: money and fiscal facts, no stock, no revenue | The sale |
| Paid in full at issue | ✓ | ✓ (every reader already counts R0 once) |
| **Paid later** | ✓ a receipt for the payment | ✗ The invoice dispatched and posted at issue. Reaching B means reversing both on the payment day, which moves revenue and COGS from the tax-event date to the payment date. |
| **Paid in parts** | ✓ one receipt per payment | ✗ A payment is not a set of goods, so there are no lines to give the CS |
| Debit note in cash | ✓ | ✗ same problem as a part payment |
| Credit-note refund in cash | ✓ a storno, money only; the credit note returns the goods | ✓ but a storno of the CS returns the goods too, so it collides with the credit note (§3.5 of FR-21: a quantity is corrected once) |

**Decision: A** (owner, 2026-10-31), for every cash payment on an invoice-side document. R0 keeps its own direction: a sale rung at the till first and invoiced afterwards ends as B, and that stays. Each document says which direction it came from: `cashSaleRef` on an R0 invoice, `paidInvoiceId` on a receipt (§2.1).

## 2. Design (model A)

### 2.1 Two new cash-register documents

| | `payment_receipt` | `payment_storno` |
|---|---|---|
| Is | the fiscal receipt of a payment on an invoice or a debit note | the storno receipt of a cash refund on a credit note |
| Links | `register.paidInvoiceId`, plus the payment row's key | `register.refundOf` (the credit note) and `register.storno.original*` (the receipt it reverses: УНП, number, date) |
| Number | the register's series (`CS-…`, D-5), shown in the cash-register journal | the same series |
| Stock | none | none |
| Revenue JE | none: the invoice posted it | none: the credit note posted it |
| Money | `payment.recorded` on the invoice, as today | the refund recorded on the credit note |

**Why new types, not a `cash_sale` with a flag.** Every report that counts sales filters on `cash_sale`. With a new type, a report that has not learned it ignores the receipt. The worst outcome is a drawer count that comes up short at the close, where it shows. With a flag, every one of those reports would have to learn it, and any that didn't would count the money twice, which nothing shows. This is FR-21 D-2's argument again.

### 2.2 What prints, and when

| Event | Prints | Payment type |
|---|---|---|
| Invoice issued with method cash, at the counter | a `payment_receipt` for the total | cash |
| Cash payment recorded on an issued invoice (`POST /invoices/:id/payment`) | a `payment_receipt` for that amount | cash |
| Debit note issued or paid in cash | a `payment_receipt` (a sale receipt) | cash |
| Credit note refunded in cash | a `payment_storno` citing a receipt that paid the invoice (§2.5) | cash |
| Card at the counter: invoice issued with method card, or a card payment recorded | a `payment_receipt`, by the same rules as cash (owner, Q-2) | card |
| Invoice with method cash on delivery | At issue (owner, Q-2), payment type „НАЛОЖЕН ПЛАТЕЖ" (Eltrade slot R), with the invoice still due until the courier pays | slot R |
| **Any imported document** (Files app, `convertDraftInvoice`, the API import skills) | **never**. Another system printed its receipt. | — |
| Bank transfer, `other` | nothing | — |

**What the receipt says.** A payment that settles the whole invoice at issue prints the invoice's lines, like any sale, followed by a text line „Фактура № …". Any other payment prints one line per VAT rate, „Плащане по фактура № …", with the amount split pro rata. The last payment takes the remainder, so the receipts add up to the invoice exactly, rate by rate. The accountant reviews the printed wording against Н-18 during the go-live preparation (**Q-3**), so it is built as written here and corrected if that review says so.

**The driver gap.** `IFiscalPrinter` could not print text inside a fiscal receipt; `printNonFiscalText` works only on a non-fiscal one. One optional method is added, `printFiscalText(text)`, with a capability flag (`fiscalText`). On Eltrade it is ISL 36h, „PRINTING A FREE FISCAL TEXT" in the protocol v1.1.1: up to 46 bytes, framed in `#`, S1.1 with no fiscal receipt open. ErpNet.FP's ISL drivers send comments with it. It has not run on a physical device. A device without it prints the invoice number as the line's name.

### 2.3 Where it prints

- **Through the issuing user's open session**, on that session's device (D-13). The cash goes into that drawer.
- **No open session, or the device isn't connected:** refused before anything is written, the printer gate's 409 `fiscal_device_not_connected` (#390). Nothing is issued as paid, and no number or УНП is drawn.
- **Orgs where LGR prints nothing:** with the gate's switch off (`settings.cashRegister.requireConnectedDevice: false`), cash invoices behave as today: settled on issue, no receipt. There is one switch, not two (owner, Q-4).
- ⚠ **R1's deploy order:** the regal stores' till is still PlusMinus, so `regal-pz` and `regal-sf` get the switch set off BEFORE R1 deploys. Unset means required, and every cash invoice there would then need an LGR device. Each store turns it on when it moves to the LGR till.

### 2.4 Order of operations

The till's print-once machinery (#155) is reused unchanged: `register.fiscal.state` pending → printed / failed / unknown, `counterBefore`, and the reconciliation of an `unknown`.

1. Check the session, the device, the amount (≤ what is due) and the `Idempotency-Key`.
2. **At issue:** issue the invoice first, because the receipt names its number. It gets its number, dispatches its stock and posts `invoice.posted`, as today.
3. Insert the `payment_receipt` with `fiscal.state: 'pending'`, then print.
4. **Printed:** record the payment row (linked to the receipt), then `payment.recorded`.
5. **Failed:** the receipt is `failed` and no payment is recorded. An invoice issued in step 2 stays issued and unpaid (`sent`, amount due), and the user takes the payment again with the Pay button. Nothing is rolled back and no number is lost.

`syncCashSettlement` keeps settling cash invoices on issue in orgs where LGR prints nothing. In orgs where it prints, the receipt and its payment are the settlement.

### 2.5 Refunds, partial storno, refusals

**A credit note refunded in cash** prints a `payment_storno` for the refund, citing a receipt that paid its invoice:
- for an invoice paid at the counter or later: one of its `payment_receipt`s;
- for an R0 invoice: the till sale's own receipt.
- **Budget:** per receipt and per VAT rate, the stornos citing a receipt never exceed what it printed. Claims are taken in `_id` order and a later one that doesn't fit gives way, as R0's invoice claims do (`overClaimed`).
- **Which receipt:** the newest with enough left. A refund larger than any one receipt's remainder prints one storno per receipt it draws on.
- **Partial:** a refund smaller than the receipt is a partial storno of it. Н-18 allows that, and the device needs no new command.
- **Refused (409 `no_receipt_to_storno`):** a cash refund on a credit note whose invoice has no receipt in LGR to storno. That covers an invoice paid by bank, an imported invoice, and one paid before this FR. The message says to refund by bank.
- **Refused (422):** a refund larger than what the invoice's receipts still hold.
- **Risk:** no credit note has ever been refunded in cash through `POST /invoices/:id/payment`. The `payment.recorded` handler must post a credit note's payment as money OUT (Dr receivable / Cr cash). R2's first test checks this.

**The till's own partial storno (#363)**, for a sale rung at the till:
- `register.stornoState` gains `'partial'`.
- A per-line budget: sold minus what live stornos returned, claimed atomically like R0's claims, and safe under `Idempotency-Key` retries.
- The storno receipt carries only the returned lines and cites the original УНП.
- Stock returns for those lines only, at the cost they left at (`returnStornoStock`).
- Readers need no change: a storno already counts at its own amount (`cash_sale − cash_storno`). The journal's badge says „частично".
- **An invoiced till sale stays refused** (FR-21 §3.5). It is corrected through its invoice's credit note, whose cash refund prints a `payment_storno` citing the sale's receipt.

### 2.6 Who reads what

| Reader | `payment_receipt` | `payment_storno` |
|---|---|---|
| Revenue: sales history, digest KPIs, Reports, exports, ledgers, dashboard | not a sale; the invoice counts | not a refund of revenue; the credit note counts |
| Cash-register journal | listed: number, УНП, amount, the invoice it paid | listed |
| Session: expected cash, close preview, session report (#391), Z-report check | counts: the cash is in the drawer | counts negative |
| Session close JE (FR-21 D-6) | excluded: `payment.recorded` posted the cash | excluded |
| Stock | none | none |
| SUPTO tables that list receipts (18.2–18.5) | listed. **This changes the SUPTO database structure: FR-20.50's declaration rule applies.** | listed |
| Digest "sales with no movement" (FR-11.10) | excluded: no movement is right | excluded |
| Invoice PDF | lists the receipts that paid it (УНП and number), as R0's PDF lists its sale's | — |

### 2.7 Edits and voids

Once a receipt has printed for an invoice, its total can no longer change: `PUT` answers 409 `fiscally_paid` to anything that would move it, and void is refused. A printed receipt cannot change, so the invoice is corrected with a credit or debit note, which prints its own storno or receipt. Every other invoice stays editable in every status, as today. (**Q-5**)

## 3. Releases

| | Contents | Rollback |
|---|---|---|
| **R1** | `payment_receipt`: cash at issue, cash later, part payments, debit notes; `printFiscalText`; the invoice PDF's receipt list; §2.7's freeze | Redeploy the previous image. A printed receipt stays a document, which older code ignores (new type). |
| **R2** | `payment_storno`: credit-note cash refunds, partial, the two refusals | same |
| **R3** | The till's partial storno (#363) | same |

Each release goes through Atanas's protocol on #171, and the SUPTO docs change in the PR that changes the structure (R1).

## 4. Tests

- **Integration** (`packages/tests/src/integration/cash-invoice-receipts.flow.test.ts`, against the Eltrade simulator):
  - Issue at the counter: a retry with the same key prints once. A print failure leaves the invoice issued and unpaid, and the next attempt prints.
  - Three part payments: per rate, the receipts sum to the invoice.
  - A debit note in cash.
  - Refunds: a partial refund, a refund that spans two receipts, a refund beyond the budget (422), a refund with no receipt (409), and two concurrent refunds on one receipt.
  - Never prints: an imported invoice, and an org with the switch off.
  - Every reader in §2.6, each counting the money once.
  - The payment JE of a credit-note refund.
- **Till partial storno (#363):** two partial stornos and then a full one; an over-budget storno gives way; the stock returns at its original cost; SUPTO 18.4 and 18.5.
- **e2e** (`cash-register-fiscal` project, Eltrade stub): the receipt carries „Фактура № …", and the storno cites the original УНП.

## 5. Questions for the owner

- **Q-1 — Stock.** ✓ Answered 2026-10-31: model A, the invoice moves the stock.
- **Q-2 — Card and cash on delivery.**
  - ✓ Answered 2026-10-31: a card payment at the counter prints as cash does.
  - ✓ Answered 2026-10-31: a COD invoice prints at issue on slot R.
- **Q-3 — Wording.** ✓ Answered 2026-10-31: built as proposed, itemised lines plus „Фактура № …" for a whole payment at issue, and „Плащане по фактура № …" per VAT rate otherwise. The accountant reviews it in real time before go-live.
- **Q-4 — Which orgs print.** ✓ Answered 2026-10-31: the printer gate's switch decides. Off means LGR prints nothing and cash invoices stay as today.
- **Q-5 — Freeze.** ✓ Answered 2026-10-31: once a receipt has printed for an invoice, its total is corrected only by credit and debit notes.

## 6. R1 as built (2026-10-31)

Where the spec left a choice, what was chosen:

- **`unknown` stands, as the till's sale does (D-4).** §2.4 names printed and failed. An interrupted print the device cannot confirm is never reprinted, its money is recorded, and `receiptError` and the journal's fiscal state say so. Not recording it left a dead end: the invoice due, the money in the drawer, and only a second receipt to pay it with.
- **The amount is held on the invoice** (`receiptHolds`) while a receipt prints, in one atomic update with the check that it fits. The budget of §2.5 is taken in `_id` order because a sale is never written to; an invoice is written to anyway, and the hold also stops a payment by bank taking the same money during the print.
- **A request that died is finished by the next payment on the document.** That one prints nothing: the customer at the counter now may be paying another amount, another way. A keyed retry of the same request may print.
- **The link is `payments[].receiptId`.** `payment.recorded` writes the array back through the repository, which gives every row a new `_id`, so the row's id is no key. A receipt's payment is stamped in place.
- **SUPTO 18.1 lists the receipt too**, beside the §2.6 list of 18.2–18.5. It lists every receipt under its УНП, the invoice is in none of those tables, and 18.1 and 18.2 must agree. 18.4 has nothing to list until R2's `payment_storno`. 18.5 lists a failed receipt.
- **A whole payment prints per rate when its lines would not add up.** A device totals rounded VAT-inclusive prices; 1000 × 0.1234 net is 148.08 on the invoice and 150.00 on the device. The line is then named „Фактура № …", as on a device with no text line.
- **A debit note names itself:** „Дебитно известие № …", „Плащане по дебитно известие № …".
- **A cash payment on an imported invoice prints nothing and is recorded**, as §2.2's "never" says. That cash is in no session.
- **A later payment on a COD invoice prints nothing**, by any method: every cent of it has its receipt.
- **A COD receipt that fails at issue prints on its own** (`POST /invoices/:id/receipt`). §2.4's "the user takes the payment again" cannot apply: the money is the courier's, and Pay would record money nobody brought, print nothing, and leave the sale with no receipt. The form offers the print from the document's own state (`receiptToPrint`), because an unpaid COD invoice looks like any other once the page is reloaded. The invoice stays due. An invoice that never tried to print is not offered it: it was issued before LGR printed, or where it does not.
- **The doors declare their device (FR-24.50).** `/send`, `/payments` and `/receipt` follow the open session of whoever issues or pays, so on two pods they run where that session's printer is. A bank transfer by someone with a session runs there too: a hop, no more, and telling it apart would mean deciding what prints twice. `PUT` and void reach a device only to finish a dead receipt, and follow that receipt's own device.
- **The re-issue of a number issued twice prints nothing** (FR-20.51). It copies the invoice's method, and its money was taken under the number it replaces: a second receipt would book the sale on the device twice, and with no session it would refuse a legal correction.
- **A payment on a draft is refused** where LGR prints (422 `document_not_issued`): a receipt names a number.
- **A document in another currency than the session is refused** (422 `receipt_currency`). The device prints in one currency.
- **A rate with a negative total is refused** (422 `receipt_not_printable`). A device takes no negative line.
