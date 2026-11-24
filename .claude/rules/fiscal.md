---
paths:
  - "packages/fiscal/**"
  - "packages/desktop/**"
  - "packages/api/src/invoicing/controllers/pos*"
  - "packages/api/src/invoicing/controllers/cash-*"
  - "packages/api/src/invoicing/controllers/invoice.controller.ts"
  - "packages/services/src/biz/document/**"
  - "packages/api/src/invoicing/lib/cash-register-*"
  - "packages/api/src/invoicing/lib/counter-*"
  - "packages/web/src/modules/invoicing/pos/**"
  - "packages/web/src/modules/invoicing/views/CashSale*"
  - "packages/services/src/biz/cash-register/**"
  - "packages/services/src/biz/*fiscal*"
  - "packages/services/src/biz/*cash*"
  - "packages/services/src/biz/sequence.service.ts"
  - "packages/api/src/websocket/**"
  - "packages/api/src/controllers/fiscal*"
  - "packages/api/src/controllers/workstation*"
  - "packages/config/src/pos-*"
  - "packages/config/src/line-amounts*"
  - "packages/tests/src/helpers/*simulator*"
  - "scripts/cash-register-*"
---

# Rules and traps: Fiscal devices, the till and SUPTO

Every ⚠ and every never/always rule of this area's history, copied whole with the bullet it sits in, by section.
Why each one exists, and what was built around it: [`docs/history/fiscal.md`](../../docs/history/fiscal.md).
`unit/claude-md.test.ts` fails when a ⚠ of that history is in neither this file nor `CLAUDE.md`.

## Ready for several pods (FR-24 Phase 5, #402)

- ⚠ **Its unique index decides `bridge_in_use`**, not the in-memory socket map, which cannot see a
  sibling pod. The same tab (`instanceId`, FR-24.49) or desktop (`desktopId`) reconnecting takes its
  own row over at once; a dead row is anyone's; an admin takeover replaces it.

- ⚠ `replicas` stays 1 until Phase 6 (lgr-deploy says so on the field).

- Holder unreachable: 503 `fiscal_holder_unreachable`, nothing written. A hop is never forwarded
  again; one that finds the device gone: 409 `fiscal_holder_moved`.

- ⚠ `getFiscalContext` throws `fiscal_held_elsewhere` while another pod holds a warehouse's device:
  "held elsewhere" is never "offline", so nothing completes without its receipt.

- ⚠ `unit/fiscal-route-declared.test.ts` walks every function of `api` and `fiscal` to a fixpoint and
  fails on a route that reaches the driver without `fiscalDevice` (the numbering witness is exempt).

- ⚠ `replicas: 2` is lgr-deploy's, merged only after this image is live.

## Fiscal Package (`packages/fiscal/`)

- **`DatecsFiscalPrinter`** / **`WebSocketFiscalPrinter`** — Datecs over TCP / browser. ⚠ Never proven on hardware:
  its frame is wrong (LEN one short, CMD sent +20h, UTF-8 text) — the correct ISL framing is `isl-frame.ts`

- **Tremol** — own ZFP driver (`tremol.ts` / `ws-tremol-printer.ts`), field-tested on a non-fiscalized M20. Since
  #467 it reports `fiscalized` from the 7 bytes that answer 20h: byte 3 bit 5 „FM fiscalized" (ErpNet.FP's ZFP table),
  read raw (`tremolPayload`: `parseTremolResponse` decodes text, and most of 80h–BFh come out as '?'). ⚠ `false` only
  from a status read whole (checksum matches, 7 bytes, bit 7 set on each, no FM missing or in error), else unset = fiscal.
  Seen on no unit

- **Eltrade** (`eltrade.ts`, 2026-09-24) — A1/A3/A6/B1/B3 KL ECRs + FP printers. ISL framing (`isl-frame.ts`),
  CP1251 (`cp1251.ts`). Opens fiscal receipts with **90h `<name>,<УНП>`**; card = payment code `L`; a storno
  carries the **original** УНП with positive lines. Fails only on per-command bits (syntax / invalid / not
  allowed / overflow, + no paper for printing commands) — "general error" and the NRA-link bit stay raised on
  healthy devices (ErpNet.FP #166). Serializes commands, primes a random SEQ (a same-SEQ frame is replayed,
  not executed), voids a receipt an interrupted sale left open. Built against
  `tests/helpers/eltrade-simulator.ts` (from the protocol PDF); field-verified 2026-09-26 on a NON-fiscalized A3
  (status, diagnostics, clock, a non-fiscal sale through prod). ⚠ On 2026-11-08 that unit, with no ЕИК, TOOK
  a fiscal receipt sent by hand with the driver's own payloads (90h to 38h, counted on its X). The protocol's
  "90h fails with no ЕИК" does not hold there. A fiscal receipt through LGR itself is still unproven on hardware.
  Field guide: **`docs/guides/eltrade-fiscal-device.md`**

- ⚠ **A report never touches a receipt the driver is still printing** (2026-10-31): X, Z and the fiscal-memory
  reports read the status, deal with an open receipt and print in ONE turn of the command queue. A receipt THIS
  driver is printing (`receipt` / `textReceipt`) refuses the report (`busy` → HTTP 409 `receipt_open`): they used
  to clear it like a new sale does, and the POS and the device page share the driver, so an X pressed mid-sale
  voided the sale, or cash-completed it once part-paid. One it is NOT printing (server stopped, bridge dropped
  mid-sale; a reconnect is a new driver) is cleared as a sale clears it (`clearOpenReceipt`) and the report
  prints: refusing it stranded the till, whose close runs this Z. ⚠ Only the driver's own state tells the two
  apart (`fiscalOperation()` counts, it does not lock): a receipt is counted BEFORE its 90h/26h is sent, and let
  go once closed, voided, or (text) a line fails. A POS close whose Z is refused this way answers 409
  `receipt_open`, leaves the device's status alone and puts the session back to `open` with no failure on it:
  closing again once the sale has finished works. Every other Z failure stays 503 `fiscal_error` + device `error`.

- v1.1.7 has NO command to read an operator back (66h only sets one), no operator report and no КЛЕН print —
  never add a method that pretends. Operators 1–16; payment slots P N C D I J K L M Q R (35h/55h).

- ⚠ `toFiscalPaymentType` has **no default** (`FiscalPaymentMethodError`). Everything unknown used to print as
  cash, so a bank transfer on a joined sale was recorded by the device as cash taken. `mobile` stays card;
  `check` is gone (no document can hold it, and at the till it would have burned a CS number at the insert).
  A method no receipt can carry is 422 `payment_method_not_fiscal`. The tender's `method` is a plain string in
  the till's schemas on purpose: a schema union would answer that with its own generic 422.

- ⚠ The courier holds that money, so it is **never in the drawer**: `POSSession.totalCashOnDelivery`, its own
  bucket, out of expected cash. The close's `cash_on_delivery` line carries `expected` only (no `counted`, no
  `difference`), and only when there is something to expect. The session report has its own line
  (`cashOnDeliveryOf`). The session JE leaves it in "POS Other" on the receivable account, unchanged. The back
  office's cash-sale form still does not offer it (`usePaymentMethods({ cashOnDelivery: false })`).

- **`capabilities.ts`** — what each DRIVER can do (which reports, operator read/program, text receipts,
  payment-name programming, COD, max operators), resolved from manufacturer × connection type exactly as
  `createPrinter` / `createBridgePrinter` choose the class. Served on `GET /fiscal/device[/:id]`; the device page
  disables what is off with its reason (`protocol` / `driver` / `no_driver`). ⚠ `unit/fiscal-capabilities.test.ts`
  holds the table to the classes: a feature is on ⇔ the class has its methods — add the method, then the flag.

- **`device-command.ts`** — `onDevice` and `printDeviceReport`: one command on a device, and the X, fiscal-memory,
  КЛЕН and operator reports, as an API answers them. In `fiscal` because two controllers print them and
  `api/src/invoicing` does not import the portal's controllers. ⚠ It has no Z: on the device page that is its own route, and from
  POS Sessions it does not exist (a Z outside the close makes the next close print zeros).

- **`fiscal-bridge.ts`** (api/src/websocket/) — WebSocket endpoint `/ws/fiscal-bridge`, with **two
  kinds of bridge**: a browser tab over Web Serial, and (since FR-14.26) a registered **LGR Desktop**
  relaying its till's own serial port in Rust. ⚠ Elysia wraps each ws event in a NEW `ElysiaWS` —
  per-connection maps are keyed by `ws.raw` (keyed by the wrapper, the close handler never ran).
  Commands may carry `protocol: 'isl'` + `timeoutMs`, which the Web Serial relay (`useFiscalBridge`)
  and the Rust transport both use to frame answers (SEQ-matched, SYN-aware)

- ⚠ **Registration routes on the SIGNATURE, never on a claim.** The two credentials are signed
  with different secrets (`DESKTOP_TOKEN_SECRET` vs `JWT_SECRET`), so `verifyDesktopToken` is tried
  first and the user path is the fall-through. Reading `aud` out of an unverified payload to decide
  "this is a desktop" would let the caller pick which verifier runs.

- ⚠ **`BRIDGEABLE_CONNECTION_TYPES` is DISJOINT per kind, and the device LOOKUP filters on it**:
  `user → ['browser']`, `desktop → ['desktop']`. A browser asking for a desktop-bridged device
  never finds the row, so there is no window in which both could hold the port. It is told
  `bridged_by_desktop` rather than "not found".

- ⚠ **A desktop can never evict.** `BridgePrincipal` is a discriminated union so that is a thing
  the compiler agrees with, not an accident of an empty `permissions` array. Only an admin with
  `admin.settings` and an explicit `takeover: true` evicts, and it is audit-logged.

- The Rust side is `packages/desktop/src-tauri/src/{bridge,framing}.rs`. ⚠ **The transport is
  Rust, never Bun**: Bun + `serialport` on Windows opens the port and writes but never delivers
  received bytes, which made the Eltrade A3 look dead for two days in September. The drivers stay
  on the hub and УНП allocation stays there too — the shell only moves bytes.

- ⚠ **`POSSession.deviceFloat` is exactly-once on a command with no key.** The device's own `ServIn`, read and
  written down BEFORE the amount goes out, is what proves later whether an attempt with no answer got there. Never
  "retry on failure": a lost answer is not a command that did not run. An attempt the device refused keeps no such
  record, and another session's slip landing meanwhile is added to it: either would read as this one's.

- ⚠ **Its slip is numbered like any document**, so it comes after what judges an interrupted print and before the
  counter read (`printOnce`). The other way round the slip reads as that print, or as this document's.

- ⚠ **A float stops nothing.** It never throws and never marks a device in error, which would 503 every sale. An
  unregistered one is a line on the session's report (`drawer.onDevice`).

- ⚠ `46h` with an EMPTY field is no read on a real A3: it answers nothing and raises S1.0. The read is `0`. A refusal
  is `F,…` on a CLEAN status, so it must be read off the first field (2026-11-03, frames on #473).

- **`time-sync.service.ts`** — fiscal device clock sync (periodic, default 6h). Device clocks
  are Bulgarian time: format through `zoned-time.ts`, never `getHours()` (the pod is UTC).
  ⚠ **No unverified clock reaches a device** (FR-20.22, AC 58, P1-10). `clock.ts` checks the server
  against HTTPS sources: Cloudflare's trace (ms) and Google's `Date` (1 s), read at the round
  trip's midpoint.

- A check that reaches none is **unknown, never drift 0**.

- **A clock the sync holds is noted on the device** (#450): `FiscalDevice.clockHeld` (node-owned: the
  holding node read it), cleared by the next set. The device page shows it ("Set the clock" there opens
  the confirm), as do the device list and POS Sessions. An hour off reads as the summer-time change the
  device missed (`config/fiscal-clock`). ⚠ No rule of LGR's own on a fiscalized unit: the device
  refuses a time before its last fiscal record by itself, and that refusal is what the person sees.

- ⚠ **The device decides what a till sale prints, never a switch** (#461 D1, `decideSaleMode`): text on a service
  receipt only when its own status says `fiscalized === false`, read fresh in the sale's turn; anything else is a fiscal
  receipt. The till's „Нефискален" switch is gone, and in a fresh browser it had made a fiscal device print a slip the Z
  never saw. An old tab still sends `nonFiscal`: the route takes it and reads nothing of it. A print failure returns
  `receiptError` (the sale is still saved) instead of a silent success. The text receipt prints amounts in the
  **session's** currency (the org's `baseCurrency` printed BGN on a EUR till)

- **A text sale's storno prints a slip** (#467, `printStornoSlip`): on the device that printed the sale, its articles and
  „Сторно на бон № <sale>", no УНП, in its turn. ⚠ Only while that device still says it is not fiscalized: one
  fiscalized since, one that cannot say, or one away prints nothing and the storno goes through as before (`none`). A slip
  that fails gives the sale back (503 `fiscal_error`). One interrupted mid-print is held for a person when the next touch
  finds it (`decideInterrupted`: a slip has no counter to prove it), and a keyed retry prints it again, as R2's text storno.

- **POS requests are idempotent** (#155, FR-20.37): session open/close, sale and storno take an
  `Idempotency-Key` header (`ui-shared/composables/idempotency` makes one per attempt and keeps it only
  while the outcome is unknown). The key is stored ON the document (`clientKey` + `requestHash`, unique
  per org): same key + same body → the first outcome, different body → 422, no key → the old behaviour.
  A sale/storno is resumable steps recorded on the transaction (УНП, receipt `fiscal.state`, session
  totals in one Mongo transaction, stock found again by its note), held by a 2-minute lease; duplicates
  wait for the holder. ⚠ **A receipt is never printed twice**: before printing, the device's last document
  number goes on the record (`IFiscalPrinter.getLastReceiptNumber`, Eltrade only); a resumed print
  compares it — same → print, +1 → that was ours, otherwise (or Tremol, which cannot say) `unknown`,
  never reprinted. The УНП is drawn after the row exists, so racing duplicates never draw one.
  The invoicing half takes the same header: `POST /invoices` (a keyed **cash sale** is inserted under
  a `~pending:<key>` number and only the winner draws its CS number — no gaps), `/:id/send` (an atomic
  `issue` claim on the draft — with or without a key two Issue clicks no longer both dispatch and
  number it; a failure releases it) and `/:id/payments` (ONE aggregation-pipeline update appends the
  payment and derives `amountPaid`/`amountDue`/`status`/`paidAt`/history in the database; the key rides
  on `payments[].clientKey`. Read-modify-write lost a payment when two were recorded at once).

- POS totals come from ONE function, `config/pos-totals` → `computePosTotals`. Both the terminal and the
  server's `validateTotals` use it. Gross is rounded once per VAT rate, VAT is taken back out per rate the
  way a fiscal device does it, and the net is what remains, so the printed figures always add up. The
  terminal used to round VAT per line: it asked for 21.48 while the receipt said 21.47 with 0.01 change.
  `changeDue` is never negative, and `session.totalCash` is the cash KEPT (tendered − change).
  ⚠ A stored line's own net and VAT are rounded one by one and can miss the document by a cent (a valve at
  17.8952 net: line 17.90 + 3.58 = 21.48, receipt 21.47). Never sum lines for a per-rate figure: the session
  report did, and printed a rate's „Сума" a cent off its „ОБЩО" (2026-11-06). Per rate it now takes the gross
  the device was given, `grossByRate` (the one rule `linesOnDevice` prints and `printedByRate` charges stornos
  against; NOT `computePosTotals` per rate, which a two-rate sale's device never sees), and the document's VAT
  shared out over it (`session-report.ts#rowByRate`). Reports kept by a close before that are records and keep
  the cent.
  ⚠ The VAT a sale STORES is its device's (#554, `config/pos-totals#deviceTotals`): each rate's VAT out of the
  gross `grossByRate` gives the device, at the till's and the back office's doors and on a payment receipt that
  prints the invoice's lines. In a two-rate sale whose lines do not print exactly that is a cent from
  `computePosTotals`' own VAT, so the screens show the stored figures too: the till through `tillTotals` (and
  sends `tillLineAmounts`), the cash-sale form through `computeTotals`, whose net is the „Словом" note's tax base.
  The total never moves. Sales stored before keep their cent.
  ⚠ So a cash sale's line amounts are the SERVER's (#573), whatever the request carries: the till stores
  `tillLineAmounts`, the back office (POST and PUT) the cash-sale form's rule, `config/line-amounts#cashSaleLineAmounts`
  (the forms re-export its `lineAmounts`). They were stored as sent, so an old tab, an API client or a test helper
  moved the per-rate split, on the receipt and in the books. An imported day keeps its file's.

- Web Serial gives a COM port to ONE tab. A second tab's CONNECT fails with Chrome's NetworkError "Failed to
  open serial port". `useFiscalBridge` maps that to `errorCode: 'port_in_use'`, never status `error`: an
  `error` status marks the device record `error`, and the server then 503s every sale once no bridge holds
  the device. `GET /fiscal/device` returns a live `connected` flag, and the terminal shows "connected in
  another tab" (sales print through the tab that holds it). A POS tab left open reconnects by itself when
  the device is switched on, so a forgotten tab can be the one holding the port

- POS sale / storno stock movements are numbered **latest `SM-<year>-NNNNN` + 1** (retried on a duplicate), like
  every other movement path — never from a `getNextNumber('SM')` counter, which nothing else advances. Until
  2026-09-26 that counter pointed at taken numbers in any org with prior movements: the unique index refused
  every POS movement, the error was only logged, and sales never left stock. A failure now returns `stockError`

- ⚠ "Latest + 1" is read and then written, so every creator writes through **`services/biz/movement-number.ts`**
  (`withMovementNumber`, `createNumberedMovement`), which tries again under the next number when another
  movement took it at the same moment. Until 2026-11-12 only a sale's dispatch did: the movement form, a goods
  receipt, an import, a transfer and a count each read the latest themselves, and two made at once answered
  one of them a 500. `unit/movement-number-source.test.ts` fails when another source builds the number.
  What runs inside the write runs again, so it is the insert alone or one transaction around it.
  The numbers are TEXT in the index (`…-99999` sorts after `…-100000`), so the latest is read per width, the
  widest last (#714): read as one list it stopped at 99999 and nothing more was booked that year.

- ⚠ That collision was also all that kept two completions of ONE inventory count at the same moment from both
  booking its adjustment. `POST /warehouse/inventory-count/:id/complete` now holds its count while it books
  (`leaseUntil`, the lease of `services/biz/hot-path-key`, renewed while a large count runs); a second request
  answers 409 `count_busy`, and so do an edit and a delete of a held count, in the write's own filter. The
  list's Complete button takes one click (`integration/count-completion.flow`).

- **The two-hour rule (Прил. 29 т. 8, FR-20.49, `fiscal/device-reach.ts`):** in SUPTO production mode a NEW fiscal
  sale answers 409 `fiscal_device_unreached` when none of the warehouse's active devices was reached within 2 h
  AND none answers a status read now. A keyed retry is a sale that already opened and is never refused. The same
  holds at the counter receipt and, since #467, for a back-office cash sale that joins its author's session and prints.

- `lastCommunicationAt` is kept by every command a device answers (`getPrinter`'s counted view →
  `noteAnswered`, at most one write a minute per device). ⚠ It used to be written only when a bridge
  registered, so a till printing all day read "not reached since 07:00" by 09:00, and the rule would have
  stopped a working shop.

- ⚠ **`SUPTO_MODE=production` enforced NOTHING before this:** it only logged a banner saying fiscal receipts
  are required. A fiscal sale on a warehouse whose device is not connected still completes without a receipt
  (`getFiscalContext` → null). That is the §2.8 SUPTO-compliance work, not done here. Prod runs `development`.

## SequenceService (`packages/services/src/biz/sequence.service.ts`)

- `generateUNP(orgId, fiscalDeviceNumber, operatorCode)` → `"XXXXXXXX-ZZZZ-0000001"` (Appendix 29 format).
  ⚠ **One counter per fiscal device** (`UNP-<device>`, т. 9), shared by every operator — until #156 it
  was per device AND operator, so two operators issued the same numbers. Migration `0001-unp-per-device`
  seeds it above every number issued; until it has run, a device with old counters REFUSES to allocate
  rather than restart at 1. For one release the old per-operator counters and the new one `$max` each
  other on every allocation, so a binary rollback (and the re-upgrade after it) never repeats a number.

## SUPTO Models

- `connectionType` is `serial | tcp | usb | browser | desktop`. **`desktop`** (FR-14.27) means a
  registered LGR Desktop holds the port; `connectionParams` then carries `port`, `baudRate` and an
  optional **`bridgeDesktopId`** that PINS the device to one desktop (unset = any desktop the
  device is assigned to may bridge it). ⚠ Rollback per device is `connectionType` back to
  `browser`.

## SUPTO Controller Endpoints

- ⚠ **`/z-report` asks first with a session open on the device's warehouse** (#461 D5): 409 `sessions_open` naming them, and
  it prints when asked again with `confirmed: true`. It closes the device's day under them, and their close then reads
  0.00 from the device. A session's close is not this route.

- ⚠ **`/connect` REFUSES `browser` and `desktop` with 422**, before attempting anything. Those
  transports are opened by a tab or by a till, never by the server — and the catch path marks the
  device `status: 'error'`, which makes the server 503 every sale once no bridge holds it. An admin
  idly pressing Connect used to take the till out of service.

- **Fiscal bridge WebSocket**: `ws[s]://host/ws/fiscal-bridge` — a browser tab (Web Serial) or a
  registered LGR Desktop (Rust `serialport`) relays commands from the LGR server to a USB fiscal
  printer. Protocol: `fiscal:bridge:register` → `fiscal:command` / `fiscal:response`, with
  `fiscal:bridge:evicted` and `fiscal:bridge:error` codes (`bridge_in_use`, `device_not_assigned`,
  `bridged_by_desktop`, `desktop_revoked`, `key_rotated`, `org_moved`). ⚠ An unauthenticated socket is closed
  after 10 s.

## FR-09 — POS end-of-day close (2026-08-25)

- **Any fiscal failure reverts the session to `open`**, records `fiscalStatus:'failed'` +
  `fiscalError`, flips the device to `error`, and returns **503 `{code:'fiscal_error'}`** with
  a message distinguishing a connection failure from a device error. The day is never closed
  on a fiscal error. The one exception is a Z the driver refused because a sale is printing on
  it: nothing failed, so 409 `receipt_open`, the device untouched, and no failure on the session.

- `fiscalStatus: 'skipped'` when the warehouse has **no** active device (regal may run without
  one). A device that exists but fails is never silently skipped — only `closeWithoutFiscal`
  bypasses it, and only for admin/manager.

- Model: `closingBreakdown[{method,expected,counted?,difference?}]`, `fiscalStatus`,
  `fiscalError`, `zReportNumber`, `fiscalClosedAt`, `fiscalDeviceId`, and **`totalOther`**
  (mobile/voucher were accepted per transaction but never summed, so the close screen had no
  expected value for them). `closingBalance`/`expectedBalance`/`difference` keep their
  cash-only meaning — the JE overage/shortage handler reads them.

## The till lives in Invoicing (2026-10-31)

- ⚠ **`/pos/*` still answers, and must.** Tills store `Desktop.startPath: /pos/`, and the shell opens
  it on the server. `api/src/lib/pos-redirect.ts` is the map, called from `spaErrorHandler`'s
  NOT_FOUND branch just before the shell is chosen, so `spa-fallback.flow.test.ts` drives it through
  the real plugins in both static modes. An on-prem master runs the same file.

- **302, never 301**, with `no-store`: a browser keeps a permanent redirect, and a rollback has to
  bring the old app back.

- **`/pos` or `/pos/…`, never a prefix**: `/posters` is not the POS. A file (`/pos/assets/*`) is a 404.

- ⚠ **`/invoicing/pos/*` answers too**, in the router: Phase 0 served the till there, so a bookmark, a
  desktop's start path or a sign-in's return may name it. Named redirects in the manifest, which keep
  the query, and `pos.terminal`, `pos.orders` and `pos.orders.detail` alive as names.
  `module-manifests.test.ts` drives them on the real route table and holds them to the server's map.

- ⚠ **`canOpenPage` is the one rule for who may open what.** ★, „+ Нов", the menu, `tillRedirect`, the
  PIN's landing and the org switch's all ask it. `module-manifests.test.ts` is the table: each kind of
  person, every page, on the real router. It mirrors the server: a page opens for the capabilities
  `config/access/pages.ts#PAGE_ACCESS` names (FR-27.2; the legacy `PageDef.need`/`roles`/`area` are gone
  since P3-6), Devices for `devices.*` as well. Writes stay the server's.

- **`isTillOnly`** (`ui-shared/nav/page-registry.ts`): a PIN session, or `pos.*` with no right that
  opens another page of the app (`invoicing.*`, `inventory.*`). No default role is one today.
  ⚠ **`readsDocuments` is another question**: whether a session reads `/invoices`. `CashSalesView`
  drops export, import, print, email and the document page without it. `pos.*` + `inventory.*` is not
  till-only and still reads no documents.

- **`tillRedirect` holds the links the menu does not offer.** A till-only session on any other page of
  the module, and anyone on a till page `canOpenPage` refuses (an accountant's old bookmark of
  `/cash-sales/new`), go to `tillLanding`: the terminal, or the journal for someone who may only read
  it (`pos.read`, a PIN of someone without `pos.write`). So does someone with the till on the app's
  home who cannot read it, which is where the tile leads. Never to a page they cannot use. Someone who
  may read neither stays: the server answers them. ⚠ The router matches without regard to case, and the
  registry's paths are lower case: the guard lowers the path before it asks.

- ⚠ **A till sale's row opens on `/view` (`CashRegisterDocument`), for every role** (`journalRoute`): its
  tender, its stock and its storno chain are there, and the back-office form shows none of them. A
  back-office sale or an import keeps its document page, `/edit`.

- ⚠ **The PIN guard is for `meta.till` routes only.** Every other invoicing page keeps the portal's
  sign-in. `tillRedirect` asks `pinOffered()` first, so a session-less till page costs a request, and
  three seconds at most: the router waits for it, and no answer is a no. The pad's password link carries `?to=` on as `?next=`, so that way in returns to the page too.

- ⚠ **A filled cart is asked about, and a sale on its way cannot be left.** The menu, ★, „+ Нов" and Back
  are a click from the terminal, and the cart lives in the view, so `PosTerminalView` has a leave guard
  (`leave-cart-dialog`), on update too: `openPage` remounts this page under another address, and no leave
  guard runs for that. It also counts as work (`registerUnsavedCheck`), so a new build never reloads it away.

- ⚠ **A lost answer** (`answerLost`, `isOutcomeUnknown`): the sale may exist. The question says so and
  sends them to CR Sales first. It never says "not sold yet". ⚠ The idempotency key dies with the view, so
  someone who leaves and rings the same basket again books a second sale (reproduced): that is what the
  question is for.

- ⚠ **The basket holds still from the moment it is sent until a real answer.** A retry is the same sale
  only with the same body, and any other body is a new key: that is what keeps „Complete Sale will not ring
  it up twice" true. So the lines, the method and the receipt type freeze, and with the answer lost the
  catalog goes and Close Session is off (the key is good for that session only).

- **F5, a closed tab, an address typed, the shell's Reload** get the browser's own question while the cart
  holds lines, those two states included. ⚠ The app's own page loads do not stop at it: a failed move and an
  org switch both refuse a filled cart first. A line added while a switch is on its way gets past them, and
  by then the tab's session has left the org the cart was rung in, so nothing is asked (`askBeforeUnload`).
  A sign-out and a dead session go the same way, unasked.

- ⚠ **Only the till's views ask for a port, and a page load reopens one anywhere.** Web Serial gives a
  port to ONE tab. `requestPort`, the browser's picker, is a gesture on the terminal or the device page.
  The state is a module singleton, so a bridge opened there stays open while the tab moves around, and
  the shell's chip reads its status (FR-24.17). But the module also reopens a remembered port by itself
  500 ms after a page load (FR-24.41, `resume`, with no gesture), and `ModuleLayout` imports it, so this
  runs on any module's page, in every tab of that org: the one that loses gets `port_in_use`, never status
  `error`. `e2e/tests/till-printer-walk.spec.ts` walks the menu with one up, on a stand-in port
  (`helpers/fake-serial.ts`), and fails on a page load.

- **`CashSaleFormView` serves `/cash-sales/:id/edit`, and `/cash-sales/draft` for a draft left on it.**
  It stood at `/cash-sales/new` until the terminal took that address, and a Pending-changes entry
  names that route: `tillRedirect` brings `?restore=` to `draft`, ahead of the till's permissions, since
  the person who wrote it may hold no `pos.*`. Nothing links to it otherwise. ⚠ It is keyed with
  `useDocumentRouteKey`, as the other document views are: both addresses are one view, and left mounted
  it showed an open sale's lines under a New title, and Save issued them a second time. The back office's
  `POST /invoices` for a cash sale stays: the import skills and the tests use it.

- ⚠ **The till sells past stock by default** (FR-21.16: `allowNegative` comes from an org setting,
  default allowed), and CS Terminal is the only way to ring up a new cash sale now. The old form's
  availability check and transfer offer stay with its draft page.

- ⚠ **A new cash sale has no customer, so customer-aware prices no longer apply by themselves.** The
  terminal has no contact, so a contact tagged „Цена 4" gets the plain selling price unless the cashier
  picks the tier. It follows from `/cash-sales/new` being the terminal (the owner, 2026-10-31): nobody without
  `pos.write` starts a new cash sale in the UI either.

- Moved pages keep their stored state: `LEGACY_PAGE_IDS` remaps ★ and usage counts from `/pos/*` and
  from Phase 0's `/invoicing/pos/*` (one hop, so each names the final page). A pending change captured
  under `appId: 'pos'` still restores: `handleRestore` reopens it by route name, and an entry whose name
  is gone takes the server's 302 by its URL. `/pos` stays a return root (`return-path.ts`). An org's old
  `OrgApp` row for `pos` is simply never read, whichever way it was set: `pos.*` alone decides who sees
  the till now.

## FR-21 — one cash register (#171; R1–R5 on production 2026-10-27)

⚠ **R2 (#272–#274) is on master since 2026-10-26 and NOT deployed: the next deploy of master ships
it, whoever runs it.** That deploy needs four more steps (handover §5):
- the field check's baseline BEFORE it (`scripts/cash-register-field-check.ts`);
- `bun run migrate` on the build host after it (`0008-cash-register-copy`; `MIGRATIONS_AUTO` is
  off);
- the field check again;
- a device test in `acme-corp`.

- ⚠ **One counting rule, `services/biz/cash-register/counting.ts`**: a sale counts whether or not it
  was stornoed, a storno counts negative, nothing voided counts. A POS sale is `cancelled` only by
  its storno, so skipping `cancelled` rows AND subtracting the storno took the sale out twice — the
  session JE and the sales history both did. `keptByMethod` is what a row left in the drawer: card
  and other as paid, cash the rest of the total (change goes back in cash). Every new reader that
  sums cash-register rows uses both.

- ⚠ **No `POS-OUT` batch movement any more.** It was written `completed` without
  `confirmMovement`, moved nothing, and made SUPTO 18.8, FR-07 and FR-11.7c count every POS sale
  twice. Migration `0006` marks the old ones `recordOnly: true` and those readers skip the flag.
  A movement reader that sums quantities must skip `recordOnly` too.

- ⚠ **A cash sale's `lineTotal` is GROSS**, as everywhere the UI writes it. The till imports wrote
  the net; migration `0007` converts them, deciding per DOCUMENT (net lines sum to `subtotal`).

- ⚠ **Till sales are read through `loadPosRows`** (`cash-register/pos-union.ts`), never from
  `postransactions` (R4, FR-21.27): the till's documents (`register.origin: 'pos'`) read back as
  the POS rows they stand for. Only migrations and the restore read `postransactions`, through the
  driver. A reader that ALSO reads cash-sale documents must exclude `register.origin: 'pos'` there,
  or it counts a till sale twice.

- ⚠ **The cash register refuses until it may read that way** (FR-21.28,
  `cash-register/freeze-check.ts`): the till's routes, the journal and SUPTO 18.1–18.5 answer 503
  `cash_register_not_migrated` while `postransactions` holds a row and `0009-cash-register-freeze`
  is not recorded. An empty `postransactions` (a new database or master) needs no migration. Checked
  at startup, then every 15 s until ready. A test seeding legacy POS rows runs
  `helpers/migrate-till.ts#migrateTill` (the copy + the 0009 record) before it reads.

- ⚠ **`cash_storno` is a document type, stored POSITIVE.** Every invoice-side reader of cash sales
  (digest, documents report, export, product/contact ledgers, invoice summary, sales history) takes
  it with sign −1. Nothing writes one before R2; a new reader must learn it anyway.

- ⚠ **Till documents and stornos are immutable** (D-8, `cash-register/immutability.ts`): `PUT`,
  `DELETE`, `/void` answer 409 `register_document_immutable`, and the Files rollback skips them.
  Back-office cash sales behave as before.

- ⚠ **`exchangeRate` is the base-currency value of ONE unit of the document's currency**
  (`totalBase = total × exchangeRate`): a BGN till session in an EUR org maps to 1/1.95583, not
  1.95583 (`cash-register/mapping.ts#exchangeRateFor`).

- ⚠ **The POS terminal rings into the user's OWN open session** (owner, 2026-10-27, FR-21 R5):
  `PosTerminalView.vue#fetchSessions` asks `GET /trade/pos/session?cashierId=<me>`, and a sale into
  another cashier's session is 403 `session_not_yours` (a keyed retry of a sale already made is
  answered first). Until R5 it took the first open session in the org.

- **A back-office cash sale joins its author's open session** (FR-21.31, D-13): `POST /invoices`
  writes it with `register.origin: 'pos'`, `joinedFrom: 'backoffice'` and the session, so it counts
  in the drawer's totals, the close JE and SUPTO, is immutable and is reversed by a storno through a
  till. Its lines keep their warehouses. ⚠ Where LGR prints it prints on the session's device whether or not the
  request says `receipt` (#461 D6: with none it went past the gate, paid, in the drawer, printing nothing), and where
  LGR prints nothing only when it says so. Either value only asks: the device says which it prints. An imported day
  never joins, so the import skills are not this path, `--no-stock` or not. Test fixtures: `till-world`'s
  `backOfficeSale` posts as a clerk with no session, `cashierBackOfficeSale` as the till's cashier.
  ⚠ **Where LGR prints, a back-office cash sale with no open session is refused** (#492, owner 2026-11-08):
  409 `fiscal_device_not_connected` with `noSession: true`, as a cash invoice at the counter is (or
  `session_closing` while the author's session closes), before anything is written. Where LGR prints nothing,
  it still goes through sessionless, printing nothing; an imported till day is never refused. So a test that
  posts `backOfficeSale` with the gate on expects the refusal; one that needs a sessionless sale turns the gate
  off (`allowSalesWithoutPrinter`).

- ⚠ **One totals function** (FR-21.30): a cash sale is totalled with `config/pos-totals#computePosTotals`
  everywhere — the till, the form (`document-payload.ts#computeTotals` branches on `cash_sale`), and
  `POST /invoices`, which refuses a back-office cash sale off by more than 0.02 (422
  `cash_sale_total_mismatch`) and stores its own figures. Other document types keep their
  components-first rounding. An imported till day keeps its file's totals.

- ⚠ **Since R2 the till writes cash-register documents, never `POSTransaction`.** The steps live
  in `services/biz/cash-register/register.service.ts` (insert → number → УНП → print once →
  session totals → stock → complete → audit), on the `Invoice` row's `register` block. `services`
  must not import `fiscal/*` (which imports it), so the till hands the service a
  `RegisterPrinter` port built in `api/src/invoicing/lib/cash-register-till.ts`. A new till
  sale IS the copy of the POS row it would have been (`tillSaleDocument` maps a virtual row
  through `fromPosTransaction`): one mapping, so the R1 readers and an R1 rollback read both alike.

- ⚠ **One failure rule**: a failure removes the document only until the sale reached the device
  (receipt `pending`/`printed`/`unknown`) or the drawer (`sessionTotalsApplied`); after that
  it is recorded (`register.stockError`/`receiptError`).

- ⚠ **The till's stock check is `settings.cashRegister.allowNegativeStock`** (unset = allowed),
  run before the receipt. NOT `settings.inventory.allowNegativeStock`: it defaults to false and
  nothing read it, so wiring the till to it would have refused sales in every org.

- **Storno** (D-2): a `cash_storno` document, positive; the sale stays `paid` with
  `register.stornoState: 'full'` + `stornoedBy` (claimed atomically). One door for the till route
  and the journal's `POST /cash-register/documents/:id/storno` (session-less for a back-office
  sale). Refused: an imported day, an INVOICED sale (its credit note corrects it), a storno. A
  POS-row sale is stornoed as its copy (0008/0009; R2's on-the-spot `copyPosRow` went in R4); the
  frozen row is never written.

- ⚠ **The storno's return restocks at the cost the goods LEFT at** (the dispatch line's
  `resolvedUnitCost`), through `confirmMovement`. Not `reverseInvoiceStockMovement`: on a void
  it restores the consumed layers AND confirms a receipt that layers them again, at the sale
  price — layer-costed (FIFO/LIFO) goods counted twice, and WAC's `avgCost` pulled toward the selling
  price. That void path is still open (#276).

- ⚠ **`postransactions` is frozen (R3, FR-21.26)**: the `POSTransaction` model carries
  `db/plugins/frozen.plugin.ts`, so every write through it (save, insertMany, query writes,
  bulkWrite) throws `FrozenCollectionError`. Migration `0009-cash-register-freeze` copied the last
  rows and proved parity. A test that needs a legacy row inserts it raw: `createTestPOSTransaction`
  builds it with the model and writes `POSTransaction.collection.insertOne`. R4 removed what still
  read it at runtime: `GET /trade/pos/transactions*` (the journal replaces it), the DAL's
  `posTransactions` repository, the journal's POS side and R2's on-the-spot copy (FR-21.27).

- ⚠ **A body field the route's schema does not declare never reaches the handler**: Elysia's
  normalize drops it without a word. `POST /invoices` read `pendingTransferIds` without declaring
  it, so the cash-sale form's transfer-then-sell answered 400 for want of stock and left its draft
  transfer behind (FR-21.24, `cash-register-sale.flow`). The ids are the client's:
  `confirmTransferMovements(orgId, ids)` confirms only draft TRANSFERS of that org, and
  `checkPendingTransfers` refuses the whole list (422 `pending_transfer_invalid`) before a sale
  draws its number.

## A fiscal receipt for every payment on an invoice (2026-10-31, FR-23 R1)

**The invoice is the sale** (Q-1): it moves the stock and posts the revenue, as it always did. A
`payment_receipt` is the money: an `Invoice` row of its own type, in the register's `CS`/`CSR` series,
on the open session of whoever issues or pays (D-13), printed on that session's device. It moves no
stock and posts no revenue. It prints for an invoice or a debit note issued in cash or by card, a cash
or card payment on one (whole or in parts), and an invoice on cash on delivery (at issue, slot R, the
invoice still due until the courier pays).

- ⚠ **There is one switch, the printer gate's** (`settings.cashRegister.requireConnectedDevice`, #390).
  Off, LGR prints nothing and cash invoices behave as they always did. On, a cash invoice with no open
  session or no connected device is refused before anything is written: 409
  `fiscal_device_not_connected` (`noSession: true` for the first), no number, no УНП, no claim on the
  draft. Each refusal names the switch and where it lives (Settings → Organization → Cash register).

- ⚠ **Off unless the org opts in, and unset still reads as ON** (owner, 2026-11-01). Every path that
  creates an org writes `false` explicitly (`defaultOrgSettings`; `new-org-printer-gate.flow.test.ts`
  walks them, and a new `Org.create` fails it until it is named). Never change the reading: `regal`'s real
  till depends on unset being on. This narrows #390's "every org", the till's gate with the invoices'.

- **Existing orgs are `0012-printer-gate-off`**: off on every org with no active fiscal device whose
  switch is unset, node by node, `bun run migrate --dry-run` to read it first. ⚠ `MIGRATIONS_AUTO` is off
  on lgrai.app, so it runs by hand BEFORE the new image serves; a master runs it before it listens.
  `scripts/printer-gate-off.ts` is the one thing no data can say, `regal-pz`, which has a device and whose
  till is still PlusMinus. ⚠ It refuses `regal`.

- ⚠ **An imported document NEVER prints.** `syncCashSettlement` is called by `/send`, `PUT` and
  `convertDraftInvoice`, so printing lives in the doors (`api/src/invoicing/lib/counter-receipt.ts`,
  `prepareReceipt`), never in that function. The conversion settles as it always did, with the switch
  on too. `printsAtCounter` also refuses a document a person issues or pays by hand that an import
  wrote. ⚠ `isImportedDocument` is `ocr_import` on its FIRST status entry and nothing else, because a
  copy does not carry that and no route writes it. The `ocr-import` tag is copied by „Копирай" and a
  user can type it; `importedFrom` is LGR moving its own document between nodes, which prints like
  any other.

- ⚠ **Where LGR prints, `PUT` never settles**: `syncCashSettlement` takes one input, `settles`, and with
  `settles: false` it never adds or shrinks a payment and only says what is owed, so a raised total is
  payable where a stale `paid` would refuse the payment. It still withdraws its own row under a method
  the invoice no longer says, with its journal entry (no general route can remove a row), and adds none
  in its place, a move between two settled methods included. An imported invoice keeps the rule:
  nothing else would settle it.

- ⚠ **R1's rollback is clean only while no receipt exists** (FR-23 §3). The previous image has none of the
  filters below, so it counts every receipt again beside its invoice, and it rewrites `payments` without
  `receiptId`. Prefer fixing forward.

- ⚠ **A new `Invoice` type reaches every reader that has no `type` in its filter.** Those are
  `GET /invoices`, `getInvoiceSummary` (paid in 30 days), the digest's KPIs, `byMethod` and
  `paymentsTotal`, the contact ledger with its cost, `/stats/*`, the contact's summary. Each spreads
  `NOT_PAYMENT_RECEIPT` (`sale-counting.ts`). A reader that names its types needs nothing. The digest's
  CS sequence line still takes the receipts' numbers, or every one reads as a gap.

- ⚠ **`REGISTER_TYPES` stays the two sales.** `loadPosRows` leaves receipts out unless asked
  (`withReceipts`): the session journal entry and sales history read through it, and the invoice posted
  that money. The session's report and SUPTO ask. `TILL_DOCUMENT_TYPES` is what the journal and the device
  witness read.

- **The steps** (`payment-receipt.service.ts`, `runReceiptSteps`): hold → number → in its turn, how it
  prints and its УНП → print once → session totals → payment → complete. ⚠ The hold (`Invoice.receiptHolds`) is taken before the number, in
  one atomic update with the check that the amount fits, so a loser burns no number; `fitsDue` counts it
  in every payment, so a bank payment recorded during the print cannot take the same money.

- ⚠ **One turn per device** (`fiscal/device-turn.ts`): from the counter read to the close, for a sale, a
  storno, a receipt and every report. `deviceTurn` is a queue in the process holding the device; a nested
  call runs inside the turn it is in, and a wait past `TURN_WAIT_MS` (longer than the slowest report)
  answers 409 `device_busy`, which a sale reads as nothing printed. It exists because `clearOpenReceipt`
  of one request voided another's open receipt, and FR-23 sent back-office payments to the till's device.

- ⚠ **The turn lives in the process holding the device, and prod runs two pods**, so the holder moves
  under it. `tests/two-node/two-pods-roll.test.ts` is a release gate with `two-pods.test.ts`
  (`LGR_TWO_NODE=1`). A graceful stop finishes the queue before it closes the bridges. A device taken
  over mid-queue costs the waiting request its print: a request keeps the printer it started with, and
  ⚠ a send into a closed Bun socket throws nothing, so `createSendCommand` answers for a gone socket at
  once, or each command waits out its timeout with the turn held. ⚠ Elysia cuts a request at 30 s
  (`idleTimeout`), hops included, so a print waiting behind a slow report loses its connection and keeps
  its place; the `Idempotency-Key` finds what it did. After a crash the lease (120 s) outlives the
  presence row (20 s): the document reads as printing until it lapses, then is proved or held.

- ⚠ **What proves a print: all of it lives in `print-verdict.ts`, table-tested.** In the document's turn the
  counter is evidence, because nothing else printed since it was read. **Out of a turn nothing that
  moved proves anything, for any document**, because the device is shared: a resumed sale or storno goes
  `unknown` and a receipt is held, a counter moved by exactly one included. ⚠ Never bring back "+1 on a
  resume is ours": it recorded a sale under a payment's receipt number, and a storno refunded money with
  no storno on the device. An answer genuinely lost now means a look at the device.

- **A print that throws in its turn** (`verdictOfFailedPrint`). First what the driver saw:
  `cancelFiscalReceipt` says `voided`, `finished` or nothing (`AbandonOutcome`). Voided is `failed` at every
  stage, whatever the counter reads, so whether a real 71h numbers a voided receipt does not matter
  there. Finished is its fallback closing the receipt: `printed` past the money on +1, otherwise `unknown`,
  never `failed`. ⚠ **It may say voided only if it SAW a receipt open before it cancelled**: after a close
  whose answer was lost nothing is open, 3Ch does nothing and the status reads not open, and read as voided
  that books a real receipt as failed and prints it again. So it reads the open flag first, and not open
  or unreadable says neither. ⚠ And only of a receipt THIS document opened (`this.receipt`, which only speaks for this
  turn): a leftover its 90h was refused over, finished by its fallback, booked a payment the device never saw. With no word: before the money it is `failed`, whatever the counter says;
  past it +1 is `printed`, and unmoved and idle is `failed`: the receipt is voided with its number (18.5
  lists it), no payment, and the document stays as it was; `/payments` answers 503 `fiscal_error`, `/send`
  200 with `receiptError`, because issued is issued. ⚠ Anything else is `unknown`: never printed again,
  because a real receipt voided and printed again is two fiscal receipts for one payment. What an earlier
  document left open is cleared BEFORE the counter is read (`clearLeftovers`), in the same turn. A driver
  with no `cancelFiscalReceipt` closes the receipt on failure, and a close that goes through says finished.
  A driver says how far it got (`stagedPrint`), a storno too; `refused` means it sent nothing, so the device
  is not marked and nothing is read.

- ⚠ **`unknown` means a person must look at the device: nothing reads it as `failed` and nothing reads it
  as `printed`.** A sale's money stands (D-4). A receipt's and a storno's never do, in their own turn or not: each is
  held (`holdInDoubt`), the invoice unpaid and the session untouched, and a person settles it. ⚠ A receipt's used to
  stand when its print was in its own turn: a dropped socket then left a paid invoice, a receipt the next X voided,
  nothing on the device and no door out (#461 D3). At issue the invoice stands issued and unpaid, with the notice.

- ⚠ **A storno that may have printed is held, never voided** (`runStornoSteps`). Only `failed` voids it and
  gives the sale back. An `unknown` one keeps its claim, books no refund, no stock and no session totals, and
  answers 409 `storno_in_doubt`, as does every press after it: voided, the next press printed a second
  fiscal storno. ⚠ The claim (`stornoState: 'full'`, `claimForStorno`) has no lease of its own; the lease on the
  storno document says who is working on that document. Only a claim whose storno was never written lapses, by
  its age, id by id (`releaseOrphanClaims`), and a request that stalled past that wakes with no claim and never was
  (`lostItsClaim`). A dead storno is found by its lapsed lease, by the sale's next
  storno and by the close, and a storno in doubt holds the close. It counts nowhere until settled, and neither
  does a `failed` one not yet voided: `UNPROVED_STORNO_STATES`, `posRowSign` and `NOT_UNPROVED_STORNO`, which ⚠ a
  new reader that sums a storno of either kind must spread, and SUPTO's 18.2, 18.4, 18.5.

- ⚠ **A fiscal sale in doubt cannot be stornoed** (409 `sale_receipt_in_doubt`, before the claim): read as not
  printed it refunds with no storno on the device (#281). A sale still running cannot either, fiscal or text
  (409 `sale_in_progress`): nothing of it is booked yet.

- ⚠ **A sale whose request died is finished before anything reads its session's figures or reverses it**
  (`saleProgress`, `finishDeadSale`), printing nothing: the rows count it and its session does not. Dead means no
  `completedAt`, never "`pending`": a sale can stop after its print. The close runs it before `expected`, the
  preview adds what that would book, and the storno door runs it before `stornoRefusal`. What is left, live or
  whose finish threw, holds the close. A joined sale's transfers are on the document (`register.transfersToConfirm`).

- **The settle door** (`settle.service.ts`, `POST /cash-register/documents/:id/settle`, `STORNO_ROLES`) takes a
  receipt, a storno and a sale, by the table `FINISHES`; R2's `payment_storno` is one more row. A sale's
  "printed" needs `receiptNumber` off the slip, because its storno cites it and the drivers refuse one with
  no digits. An `unknown` sale is claimed only with its lease free (`sale_in_progress`). A sale's money stands either way. ⚠ **A person's word is taken only for what only a person can
  know.** For a fiscal document both answers get past the device it printed on, by `fiscalDeviceNumber`
  (`settleDevice`), never `documentContext` or `getFiscalContext`. Here: asked in its turn, and refused while a
  receipt is open on it (409 `receipt_open_on_device`, an X report clears it), because the next document voids it,
  or finishes it in cash if it took money, which prints it. Busy: 409 `device_busy`. A read that failed, or a device
  not here: 409 `receipt_device_away`. Only a driver with no `isReceiptOpen` leaves it to the person. No row or
  `isActive: false`: the word stands, and that is the way out, by deactivating it on its page. A typed number is
  read against the device's last (`receipt_number_off_device`, ⚠ no lower bound: nobody has held a slip against
  71h), checked taken by device for 31 days either side, and corrected at this door until a storno or an invoice
  cites it (`receipt_number_cited`). ⚠ The first two are questions for the same reason: `confirmNumber`, audited as
  `confirmedOver`, goes through. Digits and a citation never do.

- ⚠ **A request that died** (`finishInterruptedReceipt`, `finishInterruptedStorno`, which NEVER print). A lease lapsed is not a
  dead request by itself: `keepLease` renews it for as long as a print waits or runs. A dead receipt is
  given up only if it never reached the device, or the device confirms the counter unmoved AND nothing
  open. A moved counter proves nothing, and no device is no proof: such a receipt goes `unknown` +
  `register.fiscal.inDoubt`. **In doubt books nothing and prints nothing**, keeps its hold, so the document
  answers 409 `receipt_in_doubt` to payment, edit of the total and void, and a person settles it
  (`POST /cash-register/documents/:id/settle {printed}`, the storno's roles, audited as `settle_receipt`,
  `register.settled`), from the journal. What finishes it reaches no device. A keyed retry of the same request may print
  only when the proof holds on the device it started on (`documentContext`). ⚠ A settle is durable from its
  claim, which leaves a lease, so one that stops halfway is finished by the next touch or the close, and
  whatever finishes it writes the audit row if it is missing. The doors and the context follow
  `register.fiscalDeviceNumber`, never the warehouse: it can hold two.

- **A session cannot close over an unfinished receipt or storno.** The close finishes what it can prove,
  refuses the rest with 409 `receipts_unfinished` naming them, re-checks once it holds the claim (each checks
  the session in its turn, so one of them sees the other), and takes `expected` from the claimed session. It
  applies to `closeWithoutFiscal` too. `applySessionTotals` never increments a closed session. ⚠ The preview adds what
  the close will book by the function the steps book with (`bookedOnItsSession`), and `interruptedDocuments` is the
  close's own query. ⚠ A close that
  dies in its Z has a lease (`closeLeaseUntil`, `TURN_WAIT_MS + REPORT_MAX_MS`): lapsed, the next close puts it back
  to `open` and answers 409 `close_interrupted`, because the Z may have printed and only the device can say. Its
  writes from the claim on are conditional on what it holds.

- ⚠ **A session takes nothing new unless it is `open`** (409 `session_closing` at the door, a keyed retry above that; the
  invoice doors say so too, `noOpenSession`, and never send a cashier in a close to open a session first, #461 D7).
  ⚠ The door's read holds nothing: a document looks at its session once it is WRITTEN, and the close looks at the
  session's documents once it has CLAIMED it, so one of the two sees the other. A sale gives way by being removed, ⚠
  never voided: `posRowSign` counts any sale, because a storno alone flips one to `cancelled`. The close reads
  `expected` after its second look, not from the claim. A dead sale is finished whatever the session says.

- ⚠ **`payment.recorded` never writes the `payments` array back.** The array it read is stale by then:
  that lost a receipt's row while `amountPaid` kept the money. Its handler stamps in place, on `receiptId`
  or `paymentId` (the row's own id, which the route and the settlement rule choose before writing).
  ⚠ `payments[].receiptId` stays the link: other paths still rewrite the array through the repository.

- ⚠ **The freeze and a void are claims, not checks.** `voidingUntil` is the one claim on a document's money,
  taken by `/void` and by attach, lapsing, and honoured in `fitsDue` (`notBeingVoided`), so a payment of any
  method gives way. `/send` and `/void` respect each other's claim. A money-moving `PUT` is a conditional
  write on no hold, the `amountPaid` it read and no claim, and so is the settlement write after it, which
  reads again once and otherwise leaves the document alone, retiring a journal entry only once it has landed. Attach re-reads what got in before its claim,
  because its last step replaces `payments`, and pays from the document as claimed.

- ⚠ **A draft has the same mechanism** (`unclaimedDraft`, `invoice-payment.ts`): its `PUT`, its `DELETE` and a link
  to goods receipts are conditional on still being a draft with no issue under way and no claim. `/send` goes on from what it
  read, so its claim is a compare-and-set on `updatedAt`: changed since, 409 `document_changed`, nothing
  moved and no number drawn. Left out, an edit inside `/send` rang one amount and booked another, and bank
  to cash settled with no receipt. `/receive` honours it too. ⚠ A `DELETE` takes the claim first, releases a
  bill's receipts, then deletes: the bill is the only record of the supplier it wrote on them, so they go
  first, and a delete that lost must not have released them.

- ⚠ **The issue holds its claim until the receipt does.** When `/send` will print, its write keeps `issue.leaseUntil`
  and records `issue.tender`; `printAtIssue` lets go in a `finally`, and a crash lets it lapse. A money-moving `PUT`
  honours it (409 `issue_in_progress`). A lapsed lease or a retry holds no claim, so the last check before the device
  compares the document with `issue.tender`: moved, nothing prints (`receiptCode: 'issue_tender_moved'`). `/send`
  discards the transfers it was asked for on every refusal that means it will not issue, ⚠ never on
  `issue_in_progress`, whose holder may confirm those same ids.

- **Whether a COD invoice owes a receipt is a fact** (`deliveryReceiptOwed`, in the issue's own write, or by an edit
  moving an issued invoice with no live receipt onto COD, never on a note, never by a client), because an issue can
  leave no receipt document at all. `/receipt` waits for an issue under way.

- **What it prints** (`receipt-lines.ts`, pure): a whole payment at issue, the document's lines and
  `printFiscalText` „Фактура № …"; anything else, one line per VAT rate, „Плащане по фактура № …", pro
  rata of what is left of each rate, so the last takes the remainder and the receipts add up exactly.
  ⚠ A whole payment prints per rate too when the device would total its lines differently (a price
  rounded to the cent × a thousand), or has no text line (`capabilities.ts`, `fiscalText`); the line is
  then named „Фактура № …". Lines are checked before printing, never after.

- ⚠ **A till sale and its storno, whole or in part, come to their document to the cent** (#461 D2): both go through
  `linesOnDevice` (`printsExactly`, the rule above). Prices that reproduce the gross per rate print as lines; anything
  else is one line per rate at the exact gross, „Продажба № …" or „Връщане по продажба № …". 1000 × 0.0533 net at 20 % was
  63.96 in LGR and 60.00 on the device, with 3.96 printed as change. The document keeps its articles and its stock, and
  the text slip prints the document's own figures, as it always did.

- **COD:** the receipt pays nothing. A later payment on it prints nothing, by any method: `prepareReceipt`
  stops at a live delivery receipt, which took all that was owed. ⚠ A second receipt would book the sale
  on the device twice.
  ⚠ A print that fails at issue is NOT retried by Pay: the money is the courier's, and Pay would record
  it as received and print nothing. `POST /invoices/:id/receipt` prints it alone (`owesDeliveryReceipt`,
  `receiptToPrint` on the document), for what is still owed, and the invoice stays due. Until it has,
  `/payments` refuses the courier's money (409 `delivery_receipt_owed`) so the sale cannot end with no
  receipt or part of one; a bank or card payment may go first, and the receipt prints what is left. The
  PDF lists a COD receipt only once the invoice is paid: it paid nothing before.

- **A cash or card header on an unpaid invoice or debit note is no money, where LGR prints**
  (`headerIsNoMoney`, `sale-counting.ts`, read by `effectiveMethods` and `splitTotal`). ⚠ Only there: an
  org with the switch off behaves as it always did, a debit note issued in cash included, because such
  a document stays unpaid there. Sales history keeps the row's total, because it is issued revenue, and
  `meta.summary` gains `unpaid`, so total = cash + card + other + unpaid and the card foots. The digest
  skips the header. The sales register puts its open part in „По банка", never В брой or Карта (the
  operator's rule: the columns partition Общо, and „По банка" takes anything unpaid), and cash on
  delivery keeps its own column.

- ⚠ **A device that is not fiscalized prints text, and the device decides, never a switch** (owner,
  2026-11-01, §6). `receiptMode` (`receipt-mode.ts`, R2 uses it too) reads `fiscalized === false` from the
  device's own status, fresh, in the turn, with no cache; `undefined` or `true` is fiscal, so a Datecs
  never gets text (a Tremol does since #467, from its own 20h status) and a fiscalized device can never print it. ⚠ A status read that fails is never "not
  fiscalized": it is the path of a device that went away. No request field, org setting or screen
  selects it. A till sale follows the same rule since #461 (`decideSaleMode`). The УНП is drawn in the turn, by
  `decideMode`, so a text receipt has none. It stays out of what a text sale stays out of: no УНП, nothing fiscal on its
  18.1–18.3 rows, on no witness, no Z, no receipt range, and the invoice PDF does not call it a fiscal
  receipt. It freezes its document all the same. A text print that fails is `failed`, with no verdict:
  the device holds no money on one. One that started fiscally stays fiscal.

- ⚠ **A Tremol truncates a line's name at 34 and keeps no free text**, so `receipt-lines.ts` picks the
  wording that fits `lineNameMax` and keeps the number. "unknown" is never stored as a receipt number.

- ⚠ **The doors declare their device** (FR-24.50): `/send`, `/payments` and `/receipt` the open session
  of whoever issues or pays, `PUT` and `/void` a dead receipt's, the only way they reach a device.

- ⚠ **`bookingOf` (fenced import) answers `none` for a receipt.** As `register`, the import would dispatch
  its lines.

- ⚠ 36h is from Eltrade's protocol v1.1.1 and the simulator; it has not run on a device. Neither has any
  of the proof above: `isReceiptOpen`, the verdicts and `deviceTurn` were driven on the simulator and on
  the Tremol driver over a fake transport.

- ⚠ **`resetEventHandlers` removed nothing until FR-23** (Node reads the argument count, and the bus
  passed an explicit `undefined`), so a test file's listeners piled up between tests.

## A storno for every refund on a credit note (2026-11-01, FR-23 R2)

- ⚠ **The budget lives in one place, `cash-register/refund-budget.ts`, on the cited document**
  (`register.refundClaims`: storno, rate, cents), taken in one conditional update with the check that it
  fits. Not `_id` order: a claim that writes then reads cannot know what is written after its read, so
  two pods could both pass (§7). R3's partial storno feeds it with `takeBudget`.

- ⚠ **`unknown` on a storno is held (`holdInDoubt`), never voided, never printed again.** It keeps its
  claim and hold, books nothing, holds the close (`HOLDS_THE_CLOSE`), counts nowhere (`stornoUnproved`,
  `NOT_UNPROVED_STORNO`), and a person settles it at R1's door. While one is in doubt no other refund by
  cash or card goes through on that note, even a part that fits: a device must never end up with two.

- ⚠ **What backs a refund is only what is finished and known to have printed** (`refundBacking`). A receipt
  held for a person answers 409 `receipt_in_doubt`, a sale in doubt 409 `sale_receipt_in_doubt`, and settled
  as printed each holds from then on. A till sale nobody finished comes first: one whose request died is booked
  (`finishDeadSale`), and one still running answers 409 `payment_in_progress`. The door takes the number off
  the slip for a fiscal receipt too, optionally: with none it stands as printed and its refund goes by bank. One it
  brought is held to all a sale's is, and corrected at the door until a refund's storno cites it: a storno's
  claim is in the correction's filter (`stornoCites`), and what a storno cites is read after its claim
  (`takeFromCited`). ⚠ What a leftover's close did says nothing about this document, at the driver
  (`cancelFiscalReceipt`) and, for one with no cancel, at `opening` (`verdictOfFailedPrint`).

- ⚠ **A refund at issue is for what the issue decided** (`issue.tender`, `tenderMoved`). Its claim stands until
  the storno does, as a receipt's, and moved, nothing prints (`receiptCode: 'issue_tender_moved'`). Between two
  stornos nothing holds the note, and on a retry nothing holds it at all, so `refund` asks `refundMoved` before each
  part after the first: what printed stands, and the rest does not print.

- ⚠ **A storno prints on the device that printed its receipt:** the driver names its own fiscal memory.
  With two connected in a warehouse the door asks for the receipt's by number (`connectedInWarehouse`); refused
  otherwise (`receipt_on_other_device`). One storno per receipt a refund draws on, keys `<key>#2`, `#3`, so a
  retry goes on from what printed, and both doors say how much went back (`refunded`, `stornos`).

- ⚠ **A refund that prints is capped at what the customer paid** (`refundCap`, 422 `refund_exceeds_paid`): what this
  invoice took, less what notes on it gave back by any method; for an invoice for a till sale, the invoice's own
  amount, never the sale's. A guard, not a lock: it reads before the claim, and the budget stays what is atomic. A
  bank refund takes no cap.

- ⚠ **A held storno holds its note's cash and card refunds whatever the switch says** (above the gate), and `/void`
  on a till sale's invoice answers for its notes' stornos (`freezeUnderNotes`).

- ⚠ **`bookedOnItsSession` names `payment_storno`:** the steps and the close's preview read it, and a type it does
  not name books no totals, silently. A session not `open` takes no refund: 409 `session_closing` at the door, and
  once written the storno looks again and gives way, as a sale does.

- ⚠ **A credit note's goods come back at what they left at, never the selling price** (#461 D4, `returnCostOf`): the
  dispatch of the invoice it corrects or of that invoice's till sale, then today's average in that warehouse, then the
  purchase price. It is `resolvedUnitCost` on the line, which stock, the layers and the valuation entry read. ⚠ `unitCost`
  stays the document's price, as on every invoice-born line, because FR-07 and the digest read their value columns off it.
  A till storno's return does the same since #467 (`returnedUnitCost`, shared): it wrote its cost into `unitCost`, so
  FR-07 showed a returned line's cost as its value, and the valuation entry read the line as saying nothing. ⚠ A
  dispatched line that consumed says its cost even at its own price (`costingMethod`; WAC keeps no allocations). And the
  digest files a customer's return under sold, as FR-07 does: by its side alone it was loaded, at its sale value.

- ⚠ **A credit note's payment is money OUT:** `createPaymentJournalEntry` posts Dr receivable / Cr cash
  on one, for a bank refund too. Before R2 it posted every outgoing document's as money in. This, the digest's and
  summary's signs and the "Refund" label are the one deliberate change where nothing prints (§2.3).

- **R3, the till's partial storno (#363, FR-23 §8).** `POST …/storno` takes `lines: [{ lineId, quantity }]`; none is all
  that is left, so a whole storno is the request it was. `register.stornoState` gains `partial`, and a sale all of whose
  quantity has gone back ends `full`. ⚠ **One claim, one update** (`claimForStorno`): `register.stornoClaims` per line
  and R2's `refundClaims` per rate, with the checks inside it, each line as the plan read it (`asPlanRead`) and each rate
  within `fitsBudget`. A part's money is its line's running total less what the parts standing on it took (`config/pos-totals#partOfLine`,
  `storno-lines.ts`), so any number of parts, and any given back, comes to the receipt to the cent. ⚠ While one may have printed no other
  storno of that sale goes through, even of another line. ⚠ Each claim has its own age (`stornoClaims[].at`).
  `to-invoice` invoices only what is left. A refund and a part draw on one budget, either way round. A device prints
  one payment type per storno, so with no method named a part goes by one method when one still holds it
  (`refundOfPart`). A line on a storno carries its discount, whole or in part. SUPTO version 5. Tests:
  `integration/till-partial-storno.flow.test.ts`, `unit/storno-lines.test.ts`; e2e `till-partial-storno.spec.ts`.

## A sale waits for a bridge that has just dropped (#869, 2026-11-19)

- ⚠ **A fiscal operation's printer is chosen only at its OUTERMOST start, never inside one.** A command already
  handed to a socket that then dropped may have reached the device, and is never sent again: a second fiscal
  receipt is the one failure this must not cause. A receipt whose bridge drops mid-print fails as it always did,
  through the dead printer; the next sale, on the new bridge, voids what it left open.
- ⚠ **A deliberate close is no loss** (`deliberateCloses`, marked BEFORE the close): a revocation, a takeover, a row
  that is no longer this pod's, a socket replaced by its own principal. Nothing may wait for a till that is not
  coming back.
- ⚠ **A read never waits** (GET, HEAD): a status poll says what is true now.
- ⚠ **`handleClose` unregisters the printer before its first await**, when its socket is the registered one. Before
  #869 that came after a database read, and a sale in between was handed a driver whose socket had closed. The later
  unregister asks again after its read, so a bridge that registered meanwhile keeps its printer.
