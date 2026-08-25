# FR-09 — „Каса и приключване" / Cash-register end-of-day close

**Goal:** Closing the register at end of day becomes a real close procedure: the operator
enters the **actually counted** amounts per payment method (cash, card, other), the system
shows the **expected** amounts next to them with the difference, and on „Приключване" the
**fiscal day-close (Z-report) runs on the fiscal device and prints**. Success / failure /
**communication error** are clearly visualised — **on any fiscal error the day is NOT
marked closed** and the operator gets an understandable message.

Status: draft for implementation · Date: 2026-08-25 · Depends on: nothing (FR-06 optional —
see placement) · Feeds: FR-08 (its reconciliation summary shows the same expected numbers).

Source requirement: „Spravki ledger.docx" §3 — verbatim text in the appendix. Legacy layout
(`word/media/image4.png`): per-method rows **НАЛИЧНОСТ (expected) / ДЕЙСТВ. НАЛИЧНОСТ
(counted input) / РАЗЛИКА** for В БРОЙ, С КАРТА, С ВАУЧЕР, numpad, comment field, one
orange ПРИКЛЮЧВАНЕ button, operator badge.

**⚠ Placement decision for goran (blocker for UI work, not for backend):** the session
close lives in the **POS app** (`PosTerminalView`) — recommended, since sessions, devices
and the fiscal bridge are all there — with (MAY) a „Каса" card in the FR-06 Reports hub
that deep-links to it. The alternative (a Reports-app page driving a POS session remotely)
splits the fiscal-bridge browser connection across apps and is not recommended.

---

## 1. Current state (master @ `dc1422c`)

**Session close today is bookkeeping only** — `packages/invoicing-api/src/controllers/
pos.controller.ts:274-310` `POST /org/:orgId/trade/pos/session/:id/close`:
body is a **single `closingBalance` number**; `expectedBalance = openingBalance +
totalCash` (**cash only**); `difference = closingBalance − expectedBalance`; the session is
set `closed` unconditionally; **no fiscal device interaction whatsoever**; audit entry
(`action:'close', module:'trade'`); `eventBus.emit('pos.session.closed')`.

- `POSSession` (`packages/db/src/models/pos-session.model.ts`): `warehouseId`, `cashierId`,
  `openingBalance`, `closingBalance?`, `expectedBalance?`, `difference?`, `totalSales`,
  `totalReturns`, **`totalCash`, `totalCard`** (only these two accumulate —
  `pos.controller.ts:447-450`; `mobile`/`voucher` are accepted per transaction (`:512`) but
  never summed), `cashCountLines[{denomination,quantity}]` — **exists in the schema but is
  written/read by nothing**, `notes` (never written on close), `journalEntryId`,
  `batchMovementId`. Status enum has 4 values but only `open`/`closed` are ever written.
  **No `fiscalDeviceId`/`workstationId`** — the device is resolved transitively:
  `getFiscalContext` does `fiscalDevices.findOne({orgId, warehouseId, isActive:true})`
  (`pos.controller.ts:25-50`) — an **unordered findOne** (arbitrary with 2 devices).
- Single-open-session is enforced **per cashier only**, read-then-write, no unique index
  (`:213-214`) — two cashiers can hold open sessions on the same warehouse/device.
- The close UI is a minimal dialog in `PosTerminalView.vue:160-174`: shows `totalSales`,
  one `closingBalance` text field — **no expected amounts, no per-method entry, no
  difference, no fiscal call**. `PosSessionsView` is read-only.
- `pos.session.closed` handler (`services/src/events/handlers.ts:175-242` →
  `auto-journal.service.ts:327-500`): batch `POS-OUT` dispatch (when
  `inventoryAccountId` configured) + a JE incl. **overage/shortage lines from
  `session.difference`** (`:445-455`). Fire-and-forget: emit is not awaited, handler errors
  are swallowed (`event-bus.ts:69-79`) — close never fails because of it.
- **Z-report exists but is a device-admin action**, disconnected from sessions:
  `POST /org/:orgId/fiscal/device/:id/z-report`
  (`portal-api/src/controllers/fiscal-device.controller.ts:184-203`), role gate
  **`['admin','manager']` only** (a cashier cannot call it), every printer error → **500**
  `Z-Report failed: <msg>` with no connected/offline distinction, and it does not flip
  `FiscalDevice.status` on failure. A manual button lives in
  `PosDeviceDetailView.vue:116-128`.
- Printer layer: `IFiscalPrinter.printDailyZReport()` is required
  (`fiscal/src/types.ts:97`), returns `{reportNumber, dateTime, totalSales, totalReturns,
  receiptCount}`. Datecs parses real totals (`datecs.ts:336-350`); **both Tremol
  implementations return `reportNumber:'unknown'` and zero totals** (`tremol.ts:419-423`,
  `ws-tremol-printer.ts:128-131`) — success is signalled only by not throwing. Connection
  manager (`fiscal/src/fiscal-device.service.ts`) is an **in-process map**; `getPrinter`
  throws `Fiscal device <id> is not connected` (`:81`). Browser-bridge (`/ws/fiscal-bridge`,
  `useFiscalBridge` in ui-shared, used by pos-ui only) rejects **all** pending commands
  when the tab closes (`fiscal-bridge.ts:204`), command timeout 60 s (`:28`).
- Error message inventory (all plain `Error`, no codes): `not connected`, `Fiscal device
  timeout` (10 s TCP), `Tremol NAK`, `Fiscal bridge command timeout (60000ms)`,
  `Fiscal bridge disconnected`, serial read timeout 30 s.
- **`SUPTO_MODE=production` currently enforces nothing** — its only consumer is a log line
  (`unified.ts:293-295`). Receipt printing on sales is best-effort non-blocking and uses
  the **non-fiscal text path by default** (`pos.controller.ts:372-401`).

## 2. Requirements

### 2.1 Model & totals

- **FR-9.1 (MUST)** `POSSession` gains `closingBreakdown[]`:
  `{ method: 'cash'|'card'|'other', expected: number, counted: number, difference: number }`,
  plus `fiscalStatus: 'closed'|'skipped'|'failed'` (default unset), `zReportNumber?`,
  `fiscalClosedAt?`, `fiscalDeviceId?` (the device actually used). `closingBalance` /
  `expectedBalance` / `difference` keep their current meaning (cash) for back-compat.
- **FR-9.2 (MUST)** Accumulate `totalOther` on the session (transactions with method
  ∉ {cash, card} — `mobile`, `voucher`), next to `totalCash`/`totalCard`
  (`pos.controller.ts:447-450`), so the „Други плащания" expected value exists.
  Sessions predating the field treat it as 0.

### 2.2 Close flow (backend)

- **FR-9.3 (MUST)** Extend `POST /session/:id/close` body:
  `{ counted: { cash: number, card?: number, other?: number }, notes?, closeWithoutFiscal?:
  boolean }`; the legacy `{ closingBalance }` body stays accepted (maps to
  `counted.cash`) — **do not break existing callers**. Expected values are computed
  server-side: cash = `openingBalance + totalCash`, card = `totalCard`, other =
  `totalOther`.
- **FR-9.4 (MUST)** New close orchestration, in this order:
  1. guards: session exists, `status === 'open'` — transition via a **conditional update**
     (`findOneAndUpdate {status:'open'} → closing`) so two concurrent closes can't both
     proceed (today's read-then-write race);
  2. resolve the warehouse's fiscal device (`getFiscalContext` semantics);
  3. **run the Z-report FIRST** via `getPrinter(deviceId).printDailyZReport()` — a direct
     service call, **not** the admin-only `/fiscal/device/:id/z-report` route (the cashier
     closing their own session must not need the `admin|manager` role; that route's gate
     stays as is);
  4. **only after Z-report success** persist `status:'closed'`, `closedAt`,
     `closingBreakdown`, `notes`, `fiscalStatus:'closed'`, `zReportNumber`,
     `fiscalClosedAt`, `fiscalDeviceId`; write audit entries `close` + `z_report` sharing
     one `correlationId` (`generateCorrelationId()`, `audit-log.service.ts:260`); emit
     `pos.session.closed` (unchanged async JE/batch behavior).
- **FR-9.5 (MUST — the docx's core demand)** On **any** fiscal failure (not connected,
  timeout, NAK, bridge disconnected): the session is **reverted to `open`** (or never left
  it), `fiscalStatus:'failed'` is recorded with the error text, the device's `status` is
  set to `error` (mirroring the sale path `pos.controller.ts:400`), and the endpoint
  returns **503** `{ code: 'fiscal_error', message }` with a human message distinguishing
  „връзката с фискалното устройство" from other failures. **The day is never marked closed
  on a fiscal error.** Validation errors stay 400; already-closed stays 400.
- **FR-9.6 (MUST)** No-device and explicit-skip semantics: when the warehouse has **no
  active fiscal device configured**, close proceeds with `fiscalStatus:'skipped'` (regal
  today may run without one). When a device exists but the operator passes
  `closeWithoutFiscal:true`, allow it only for `admin|manager` (403 otherwise), record
  `fiscalStatus:'skipped'` + audit. A connected-but-failing device is **never** silently
  skipped — only the explicit flag bypasses.
- **FR-9.7 (SHOULD)** Warn-level guard: if other `open` sessions exist on the same
  warehouse, the response to a pre-close preview (FR-9.8) flags them — a Z-report zeroes
  the **device's** fiscal day, not just this session. Blocking vs warning is goran's call;
  default = warn in UI, do not block.
- **FR-9.8 (SHOULD)** `GET /session/:id/close-preview` returning
  `{ expected: {cash, card, other}, openSessionsOnWarehouse, fiscalDevice: {id, name,
  connected} | null }` so the UI can render the comparison before the operator commits.
  (MAY: an X-report button next to it — the printer route exists,
  `fiscal-device.controller.ts:222`.)

### 2.3 Close flow (UI — pos-ui)

- **FR-9.9 (MUST)** Replace the minimal dialog (`PosTerminalView.vue:160-174`) with a
  close screen/dialog modeled on the legacy layout: one row per method — icon, expected
  (НАЛИЧНОСТ), counted input (ДЕЙСТВ. НАЛИЧНОСТ), live difference (РАЗЛИКА, colored) — for
  В брой / С карта / Други плащания (hide „other" when `totalOther === 0` and nothing was
  counted), Коментар field, one primary „Приключване" button. Numpad entry is **MAY**
  (touch terminals); standard inputs suffice.
- **FR-9.10 (MUST)** Result states rendered distinctly: success (green, shows Z-report
  number **when the device reports one** — Tremol returns `unknown`, so show „Фискалният
  ден е приключен" without a number and don't render the literal `unknown`); skipped
  (neutral, „без фискално приключване"); fiscal error (red, session remains open, message
  from the server, retry button). Failure of the async JE/batch stays invisible here
  (unchanged behavior — note it in the FR only).
- **FR-9.11 (MUST)** i18n ×4 (`pos.close.*`: expected/counted/difference/methods/
  fiscalClosed/fiscalSkipped/fiscalFailed/closeWithoutFiscal/…), bg wording follows the
  legacy screen (Касова наличност, Действителна наличност, Разлика, Приключване).
- **FR-9.12 (MAY)** Denomination count entry persisting to the already-existing (dead)
  `cashCountLines` — schema needs no change.

## 3. Edge cases

1. **Bridge tab closed mid-Z** — command rejects after ≤60 s (`Fiscal bridge
   disconnected`); session must be back `open`; retry after reconnecting the bridge from
   `PosDevicesView` works.
2. **Two devices on one warehouse** — `findOne` is arbitrary; record the actually-used
   `fiscalDeviceId`; SHOULD prefer a `connected` one (`isDeviceConnected`) before an
   offline one.
3. **Difference ≠ 0** is allowed (recorded per method); the JE overage/shortage lines
   (`auto-journal.service.ts:445-455`) keep working off the cash `difference` — verify the
   new breakdown feeds the same value.
4. **Repeat close after fiscal failure** — `fiscalStatus:'failed'` is overwritten by the
   successful retry; audit keeps both attempts.
5. **Z-report succeeds but the DB update fails** — the fiscal day is closed on the device
   while the session stays open. Log loudly + surface „fiscal day closed, session update
   failed — retry with close-without-fiscal". Rare, but state the recovery.
6. **`counted.cash` omitted in legacy body** — maps as today (single number).
7. **Session currency vs mixed-currency payments** — sessions are single-currency
   (`currency` field); nothing new.
8. **erp.service.ts `closePOSSession` (`:41-58`)** is a dead duplicate of the close logic —
   align it or delete it in this PR (it validates status but is called by nothing).

## 4. Integration & regression constraints

1. `POST /session/:id/close` must remain **backward compatible** with
   `{ closingBalance }` (e2e `pos` specs + any API clients).
2. The POS **sale** path (`/session/:id/transaction`), receipt printing strategy, and the
   `pos.session.closed` JE/batch handler are untouched.
3. The admin Z-report route keeps its `['admin','manager']` gate; the close endpoint's
   internal Z-report call is gated by session ownership (cashier) — MUST verify
   `session.cashierId === user.id` or `admin|manager`.
4. Audit `module` naming is inconsistent today (`'trade'` in the controller vs `'pos'` in
   the handler) — pick `'pos'` for the new entries and note the legacy inconsistency; do
   not rename existing values.
5. New integration tests: close happy path (fiscal mocked printer), fiscal failure leaves
   session open (try/catch capture — **no `.rejects`**, Windows Bun deadlock), skip
   semantics + role gate, legacy body mapping, concurrent close race (conditional update),
   totalOther accumulation.

## 5. Acceptance criteria

- [ ] Close screen shows expected/counted/difference per method (cash, card, other) before anything is committed; values match session totals.
- [ ] With a connected fiscal device: „Приключване" prints the Z-report, then the session closes; audit has correlated `close` + `z_report` entries; breakdown + `zReportNumber`/`fiscalClosedAt` persisted.
- [ ] With the device unreachable: clear communication-error message, **session remains open**, device status flips to `error`, retry works after reconnect.
- [ ] With no device configured: close succeeds as `fiscalStatus:'skipped'`.
- [ ] `closeWithoutFiscal` works for admin/manager only; cashiers get 403.
- [ ] Legacy `{ closingBalance }` close still works (existing e2e green).
- [ ] Two concurrent close calls: exactly one wins; the other gets 400.
- [ ] `bun run test` + `bun run build` green; i18n ×4 complete.

## 6. Field test (lgrai.app / regal)

1. Without a fiscal device on the warehouse: open a session, make a cash + a card POS
   sale, open Close — expected amounts match; close → `skipped`; JE/batch created as
   before (check the session row + accounting).
2. With the browser-bridge device connected (Tremol via Web Serial, Chrome): close a
   session → printer emits the Z-report, UI shows fiscal success without a bogus report
   number.
3. Pull the USB cable (or close the bridge tab) and close another session → red
   communication-error state, session still open in `PosSessionsView`; reconnect and
   retry → success.
4. Verify the audit log shows correlated close/z_report entries and the differences you
   typed.

---

## Appendix — authoritative requirement wording (Spravki ledger.docx §3)

```
Каса и приключване
Цел: функционалност за приключване на касата в края на работния ден.
3.1 Въвеждане на реалните суми: наличност в брой; плащания с карта; други начини, ако се
използват. ERP-то показва и очакваните суми по регистрираните продажби; сравнение:
Очаквана сума по Ledger ↔ Реално въведена сума.
3.2 Приключване: след проверка — „Приключване" → фискално приключване на деня чрез
касовия апарат; апаратът отпечатва отчет за деня.
3.3 Резултат: ясна визуализация — успешна / неуспешна / прекъсната поради грешка при
комуникацията с фискалното устройство. При грешка: разбираемо съобщение и денят НЕ се
маркира като успешно приключен.
```
