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

**Why new types, not a `cash_sale` with a flag.** Every report that counts sales names its types, so with a new type it never sees the receipt. The worst outcome there is a drawer count that comes up short at the close, where it shows. With a flag, every one of those reports would have to learn it, and any that didn't would count the money twice, which nothing shows. This is FR-21 D-2's argument again.

⚠ That argument covers the readers that name their types, and no others. A reader with no `type` in its filter sees a receipt as one more paid document with a customer on it, and counts the money twice with nothing to show for it. Each of those says so (`NOT_PAYMENT_RECEIPT`), and §3 says what that means for a rollback.

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
- **Off unless the org opts in (owner, 2026-11-01).** Every path that creates an org writes the switch off, explicitly: `defaultOrgSettings` (registration, OAuth, `POST /auth/orgs`), the demo seed and `import-regal-pz`. An org turns it on when its sales print here. ⚠ This narrows #390's "every org": the gate binds an org that opted in, or that predates this and was not turned off below. There is one switch, so it narrows the till's gate with the invoices'.
- ⚠ **An UNSET value still reads as on.** `regal`'s real till depends on that, and a default flipped under it would stop its gate silently. New orgs get an explicit false instead, and the reading does not change.
- **Existing orgs are a migration:** `0011-printer-gate-off` writes `false` on every org with no active fiscal device whose switch is unset, on every node, and takes only the orgs homed there. An org with an active device keeps what it has, and a value somebody set is theirs. `bun run migrate --dry-run` says what it would do.
- **One org is a named step:** `scripts/printer-gate-off.ts` is for `regal-pz`, which has a device and whose till is still PlusMinus: nothing in the data says that. It refuses `regal`: out of its plan whatever it holds, out of its write's filter, and naming it stops the script.
- ⚠ **R1's deploy order:** on lgrai.app both run BEFORE the new image serves, because `MIGRATIONS_AUTO` is off there and every cash invoice in an org with the gate unset would then need an LGR device. A master runs the migration by itself, before it listens. Each store turns the switch on when it moves to the LGR till.
- **Every refusal of the gate names the switch and where it lives** (Settings → Organization → Cash register), in all four languages and in the API's own message: an org with no printer has no other way out.

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
| SUPTO tables that list receipts (18.2–18.5) | listed. **This changes the SUPTO database structure: FR-20.50's declaration rule applies.** R1 is SUPTO version 2 (`config/supto.json`); `declared` stays empty until the owner declares it. | listed |
| Digest "sales with no movement" (FR-11.10) | excluded: no movement is right | excluded |
| Invoice PDF | lists the receipts that paid it (УНП and number), as R0's PDF lists its sale's | — |

### 2.7 Edits and voids

Once a receipt has printed for an invoice, its total can no longer change: `PUT` answers 409 `fiscally_paid` to anything that would move it, and void is refused. A printed receipt cannot change, so the invoice is corrected with a credit or debit note, which prints its own storno or receipt. Every other invoice stays editable in every status, as today. (**Q-5**)

## 3. Releases

| | Contents | Rollback |
|---|---|---|
| **R1** | `payment_receipt`: cash at issue, cash later, part payments, debit notes; `printFiscalText`; the invoice PDF's receipt list; §2.7's freeze | Clean only while no receipt exists. See below. |
| **R2** | `payment_storno`: credit-note cash refunds, partial, the two refusals | same |
| **R3** | The till's partial storno (#363) | same |

Each release goes through Atanas's protocol on #171, and the SUPTO docs change in the PR that changes the structure (R1).

**R1's rollback.** With no `payment_receipt` in the database, redeploying the previous image is all it takes. Once one exists it is not clean, and a receipt on a device cannot be taken back:

- **The previous image counts every receipt again.** Its readers with no `type` have no `NOT_PAYMENT_RECEIPT`: `GET /invoices`, the invoice summary (paid in 30 days), the digest's KPIs, `byMethod` and `paymentsTotal`, the contact ledger with its cost, `/stats/*` and the contact's summary. A cash invoice of 24.00 reads as 48.00 paid, and a receipt printed whole adds its products to the customer's ledger and cost. Nothing marks those figures wrong.
- **It loses the link.** On `payment.recorded` it writes the `payments` array back through its own schema, which has no `receiptId`. A payment recorded under it no longer points at its receipt after a roll forward.
- **It does not know a hold or a claim.** A receipt in doubt reads as a paid document, and its money as neither booked nor held.
- **Its till and its invoices print as they did:** no receipt for a cash invoice, which is a sale the device never saw if the org already opted in.

So a rollback needs, in this order: settle every receipt in doubt; finish the sessions that hold receipts; turn the printer gate off on every org that opted in, so no cash invoice is issued in a way the old code cannot settle; say which reports are wrong and until when. The way back is a roll forward, not a repair: this release's readers are right about everything the old image wrote, but for the `receiptId` of a payment it recorded. Prefer fixing forward.

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
- **Q-4 — Which orgs print.** ✓ Answered 2026-10-31: the printer gate's switch decides. Off means LGR prints nothing and cash invoices stay as today. ✓ Answered 2026-11-01: off unless the org opts in, with an unset value still reading as on (§2.3).
- **Q-5 — Freeze.** ✓ Answered 2026-10-31: once a receipt has printed for an invoice, its total is corrected only by credit and debit notes.
- **Q-6 — An expired licence.** ✓ Answered 2026-11-01: a session may open, and sales stay blocked. Refusing the session refused the payment `licence-gate.ts` promises to leave alone. Under `restricted` a session takes a cash or card payment on an existing document, issues an existing draft and closes its day; a new till sale and a new sales document answer 402.

## 6. R1 as built (2026-10-31)

Where the spec left a choice, what was chosen:

- **What proves a print (the owner's rulings, 2026-11-01).** In a document's turn on the device the counter is evidence; out of one it is not, because the device is shared. A print that throws in its turn is judged by `verdictOfFailedPrint`: counter +1 is `printed`; unmoved and idle, or stopped before the money, is `failed`; anything else is `unknown`, the money stands and it never prints again, because a real receipt voided and printed again is two fiscal receipts for one payment. A dead receipt that never reached the device, or whose device confirms the counter unmoved and nothing open, is given up. Any other is held: `unknown` + `inDoubt`, no money booked, nothing printed, its hold kept. A person who checked the device settles it, yes or no, in the journal (`POST /cash-register/documents/:id/settle`, the storno's roles, audited).
- **One turn per device** (`fiscal/device-turn.ts`), in the process holding it, from the counter read to the close, for a sale, a storno, a receipt and every report. It is the "two sales on one driver" risk, which sending back-office payments to the till's device widened. A wait past `TURN_WAIT_MS`, longer than the slowest report, answers 409 `device_busy`.
- **The amount is held on the invoice** (`receiptHolds`) while a receipt prints, in one atomic update with the check that it fits. The budget of §2.5 is taken in `_id` order because a sale is never written to; an invoice is written to anyway, and the hold also stops a payment by bank taking the same money during the print.
- **A request that died is finished by whoever next touches the document, or by the session's close.** That one prints nothing. A keyed retry of the same request may print, on the device it started on, when the proof above holds. A lease lapsed is not a dead request by itself: `keepLease` renews it while a print waits or runs.
- **A session cannot close over an unfinished receipt.** It finishes what it can prove and refuses the rest with 409 `receipts_unfinished`, naming them, before any Z-report. A closed session is never incremented.
- **The link is `payments[].receiptId`.** Other paths still rewrite the array through the repository, which gives every row a new `_id`. `payment.recorded` no longer does: it stamps in place, on `receiptId` or on the `paymentId` the event names, because the array it read is stale by then and writing it back lost a receipt's row while `amountPaid` kept the money.
- **SUPTO 18.1 lists the receipt too**, beside the §2.6 list of 18.2–18.5. It lists every receipt under its УНП, the invoice is in none of those tables, and 18.1 and 18.2 must agree. 18.4 has nothing to list until R2's `payment_storno`. 18.5 lists a failed receipt.
- **A whole payment prints per rate when its lines would not add up.** A device totals rounded VAT-inclusive prices; 1000 × 0.1234 net is 148.08 on the invoice and 150.00 on the device. The line is then named „Фактура № …", as on a device with no text line.
- **A debit note names itself:** „Дебитно известие № …", „Плащане по дебитно известие № …".
- **A cash payment on an imported invoice prints nothing and is recorded**, as §2.2's "never" says. That cash is in no session.
- **A later payment on a COD invoice prints nothing**, by any method, once its delivery receipt has printed: that took all that was owed.
- **A COD receipt that fails at issue prints on its own** (`POST /invoices/:id/receipt`), for what is still owed. §2.4's "the user takes the payment again" cannot apply: the money is the courier's. Until it has printed `/payments` refuses the courier's money (409 `delivery_receipt_owed`), so the sale cannot end with no receipt or part of one; a bank or card payment may go first. The invoice PDF lists a COD receipt only once the invoice is paid.
- **The doors declare their device (FR-24.50).** `/send`, `/payments` and `/receipt` follow the open session of whoever issues or pays, so on two pods they run where that session's printer is. A bank transfer by someone with a session runs there too: a hop, no more, and telling it apart would mean deciding what prints twice. `PUT` and void reach a device only to finish a dead receipt, and follow that receipt's own device.
- **"Held elsewhere" never reads as "offline" (FR-24.52).** With the holder unreachable the doors answer 503 `fiscal_holder_unreachable`, and a request that reached the wrong pod with no hop to take answers 503 from `getFiscalContext`. Once a crashed pod's row has lapsed the device is offline, and the printer gate refuses (409 `fiscal_device_not_connected`). In all three nothing is written, printed or booked. The two-pod lane proves the first and the third across real processes.
- **An unreachable holder keeps the `Idempotency-Key`** (FR-24.51). A hop's connection can die mid-print, so `fiscal_holder_unreachable` is an unknown outcome to the client: pressing again sends the same key and finds what the first attempt did, where a new key could print a second receipt for a part payment.
- **The re-issue of a number issued twice prints nothing** (FR-20.51). It copies the invoice's method, and its money was taken under the number it replaces: a second receipt would book the sale on the device twice, and with no session it would refuse a legal correction.
- **A payment on a draft is refused** where LGR prints (422 `document_not_issued`): a receipt names a number.
- **A document in another currency than the session is refused** (422 `receipt_currency`). The device prints in one currency.
- **A rate with a negative total is refused** (422 `receipt_not_printable`). A device takes no negative line.
- **Imported means §2.2's list, by `ocr_import` on the first status entry.** The `ocr-import` tag is copied by „Копирай", and `importedFrom` is LGR moving its own document, which prints like any other.
- **An edit keeps the settlement rule where no receipt can speak:** an imported invoice, and the rule's own row under a method the invoice no longer says.
- **`/void` claims the document before it moves stock** (`voidingUntil`), against the hold a receipt takes, so of a void and a payment one gives way.
- **A receipt is dated as it prints**, whatever the form says, so the device, the session and the row say one day.
- **Where LGR prints, a cash or card header on an unpaid invoice or debit note is no money** (`headerIsNoMoney`). An org with the switch off behaves as it always did, a debit note issued in cash included. Sales history keeps the row's total, because it is issued revenue, and its summary gains `unpaid`, so total = cash + card + other + unpaid. The digest skips the header. The sales register puts the open part in „По банка" (the operator's rule of 2026-10-15: the columns partition Общо, and „По банка" takes anything unpaid), never В брой or Карта, and cash on delivery keeps its own column.
- **A refused `/send` cancels the draft transfers drawn up for it.**
- **On a Tremol the number stays in the line's name.** The driver cuts a name at 34 characters and keeps no free text, so the wording shortens to fit (`lineNameMax`); `unknown` is never stored as a receipt number, and a storno of a sale with no number stays fiscal.
- **Under an expired licence "started before" is the local date.** A till sale is refused in a session opened on or after `restrictedFrom`, and one already open keeps selling, as FR-20.55 promised. A debit note written since prints no receipt: its lines are whatever it was given, so that receipt would be a new sale on the device. It can still be issued on a bank transfer.
- **A device's turn lives in the process holding it, so a move between pods is what can interrupt one.** A graceful stop finishes the queue before it closes the bridges, within `LGR_STOP_WAIT_MS`. A request that waits past the server's 30 s idle limit loses its connection and keeps its place; the `Idempotency-Key` finds what it did. After a crash the receipt's lease (120 s) outlives the presence row (20 s), so for up to two minutes the document answers "printing" on the pod that took the device over, and only then is the receipt proved or held. Nothing prints twice in that window.
