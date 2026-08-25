# FR-10 — „Изпращане на изходящи фактури по имейл" / Email an outgoing invoice

**Goal:** A **Send by email** action on outgoing/sales invoices: renders the invoice PDF,
lets the user confirm or edit the recipient (prefilled from the contact card's email),
sends the PDF **as an attachment**, and reports success/failure clearly. Every send is
logged (EmailLog + audit).

Status: draft for implementation · Date: 2026-08-25 · Depends on: nothing (independent of
FR-06..09; lands in the **invoicing** app, not Reports) · Feeds: nothing.

Source requirement: „Spravki ledger.docx" §4 — verbatim text in the appendix.

---

## 1. Current state (master @ `dc1422c`)

**Email service** — `packages/services/src/biz/email.service.ts` (47 lines total):
- Single export `sendEmail({to, subject, html, creatorId?, orgId?}): Promise<void>` posting
  to SendGrid v3 `POST /v3/mail/send` with `content: [{type:'text/html'}]` — **no
  attachments support**.
- **Missing API key → silent no-op** (`console.warn` + `return`, `:13-17`), resolves
  successfully, writes no log. **Non-2xx from SendGrid → warn + `return`** (`:33-37`) —
  the function **never throws and returns nothing**, so a caller cannot distinguish
  success from failure.
- `EmailLog` row only on 2xx (`:39-46`). Callers today: exactly two fire-and-forget auth
  emails (activation) — nothing else in the product emails.
- Config `packages/config/src/index.ts:133-138`: `SENDGRID_API_KEY` (default `''`),
  `FROM_EMAIL` (default `noreply@lgr.app`). **Neither key is in `.env` /
  `.env.example`**. Prod: the pod mounts `lgr-secret` via `envFrom` and the secret **does
  contain `SENDGRID_API_KEY`** (verified 2026-08-25); `FROM_EMAIL` is not set anywhere →
  the default sender is used. ⚠ SendGrid rejects mail from unverified senders — verify
  the sender identity/domain for the actual from-address before the field test.

**EmailLog model** (`packages/db/src/models/email-log.model.ts`): `creatorId?`, `orgId?`
(optional — **no tenantPlugin**), `from`, `to`, `subject`, `body`, timestamps; index
`{to, createdAt}` only. No `status`/`error`/`entityType`/`entityId` — a log row cannot be
tied back to an invoice today.

**Single-invoice PDF** — `GET /org/:orgId/invoicing/export/:id`
(`invoice-export.controller.ts:658-761`): guards `isSignIn` + `canExport(user)`
(`lib/export-access.ts:15`); assembles invoice + contact + org **with inlined logo**
(`getOrgLogoDataUri`, PR #15) + stored `printNote` + `orgFooterLine`, then
`generateInvoicePDF(invoice, org, contact, columns?, {locale, footerText, headerNote})
→ Buffer | undefined` (`reporting/src/pdf/invoice.pdf.ts:392-398`; `undefined` = renderer
down → 503). Filename `` `${invoiceNumber}.pdf` `` (`:677`). The UI calls it via
`useInvoicingExport.exportOne` (blob download + `decodeBlobError`).

**Where the button goes** — `DocumentForm.vue`: the **Print** button is the model
(edit-mode only, opens `ExportDialog`, loading state, snackbars) and renders in two
places: top-right (`:106-110`) and the bottom action bar (`:163-165`). The
`formActions` header array is the **wrong** slot — it returns `[]` for issued sales
invoices (`useDocumentForm.ts:658-664`), which is exactly when emailing happens.
Doc-type config: `configs.ts:28-93` (`invoice`: `direction:'outgoing'`,
`apiType:'invoice'`). List rows (`SalesInvoicesView.vue:82-115`) use flat icon buttons
with status-gated `v-if` — the send-issue button is `mdi-send` for drafts.

**Naming landmine:** `POST /invoices/:id/send` already exists and means **issue the
document** (allocate number, book stock — `invoice.controller.ts:806-861`). The email
action must not reuse "send" wording in routes or code.

**i18n landmine:** `invoicing.email` is an existing **string** key ("Email" field label,
all 4 locales — `en.json:684`) — an `invoicing.email.*` object would clobber it. Use a
different namespace.

**Contact** has exactly one `email?: string` (optional, un-validated,
`contact.model.ts:32,68`). Audit pattern: `createAuditEntry({orgId, userId, action,
module:'invoicing', entityType:'invoice', entityId, entityName})` — fire-and-forget
(`audit-log.service.ts:51`).

## 2. Requirements

### 2.1 Email service extension

- **FR-10.1 (MUST)** Extend `SendEmailOptions` with
  `attachments?: [{ filename: string, content: Buffer | string /* base64 */, type?: string }]`
  mapped to SendGrid v3 `attachments: [{content: <base64>, filename, type,
  disposition: 'attachment'}]`. Existing callers unaffected.
- **FR-10.2 (MUST)** Make outcomes distinguishable: `sendEmail` returns
  `{ ok: true } | { ok: false, reason: 'not_configured' | 'provider_error', detail? }`
  (or throws a typed error — implementer's choice, but **silent void must die**). The two
  existing auth callers keep fire-and-forget semantics (ignore the result).
- **FR-10.3 (MUST)** EmailLog gains `status: 'sent' | 'failed'`, `error?`, `entityType?`,
  `entityId?`, `attachmentNames?: string[]` — and logs **failed attempts too** (today only
  successes are logged). Do NOT store attachment content in the log (body stays the HTML).
- **FR-10.4 (MUST)** Add `SENDGRID_API_KEY` + `FROM_EMAIL` to `.env.example` (empty
  values, comment). Ops note: prod secret already carries the API key; `FROM_EMAIL` must
  be set to a **SendGrid-verified sender** before the field test — record the chosen
  address in the PR.

### 2.2 Backend endpoint

- **FR-10.5 (MUST)** `POST /org/:orgId/invoicing/export/:id/email` (sibling of the single
  export — same controller, same assembly path), body
  `{ to: string, subject?: string, message?: string, locale?, columns?, note? }`:
  1. guards: `isSignIn`, **`canWrite(user)`** (emailing a customer is an outward business
     action — read-only roles incl. `nra_auditor` get 403), invoice exists, org-scoped;
  2. **only outgoing documents** (`direction: 'outgoing'`; type `invoice`, `credit_note`,
     `debit_note`, `cash_sale`, `proforma`) — 422 otherwise; **draft documents → 422**
     („issue the document first" — a draft number in a customer inbox is wrong);
  3. `to` validated as an email; subject default `` `${docTypeLabel} ${invoiceNumber} —
     ${org.name}` `` localized; body = a minimal localized HTML template (org name,
     document number/date/total, optional user `message`, footer) — no new templating
     engine;
  4. render the PDF exactly as `GET /export/:id` does (columns default = detailed print
     defaults, stored printNote); renderer down → 503 (same message as export), nothing
     sent;
  5. `sendEmail` with the attachment `` `${invoiceNumber}.pdf` ``; `not_configured` →
     **503 „Email is not configured"** (explicit — never a fake success);
     `provider_error` → 502 with the safe detail;
  6. on success: EmailLog (`status:'sent'`, entity link), audit entry
     `{action: 'email', module: 'invoicing', entityType: 'invoice', entityId,
     entityName: invoiceNumber}`, and **persist on the invoice**
     `emailedTo: string[]` + `lastEmailedAt: Date` (append/set) for the FR-10.9
     indicator; response `{ sent: true, to }`.
- **FR-10.6 (SHOULD)** Rate-sanity: reject a second identical send (same invoice, same
  `to`) within 60 s with 429 — double-click insurance, not a rate limiter.

### 2.3 UI (invoicing-ui)

- **FR-10.7 (MUST)** `SendEmailDialog` (ui-shared, modeled 1:1 on `ExportDialog`'s
  dialog/emit/reset pattern): recipient field **prefilled from the loaded contact's
  `email`**, editable, `validation.invalidEmail` rule; subject prefilled (editable);
  optional message textarea; confirm button with loading; success → `showSuccess`
  („Изпратено на {to}"), failure → `showError` with the server message (503
  not-configured text surfaced verbatim).
- **FR-10.8 (MUST)** Buttons, mirroring Print exactly: `mdi-email-arrow-right-outline`
  next to Print in **both** `DocumentForm.vue` spots, gated
  `v-if="isEdit && config.direction === 'outgoing'"`; disabled with a tooltip while the
  document is draft. Plus a row action on `SalesInvoicesView` (`v-if="item.status !==
  'draft'"`) opening the same dialog (contact email fetched on open).
- **FR-10.9 (SHOULD)** "Sent" indicator: a small `mdi-email-check-outline` chip/tooltip
  on the form header (and MAY a list column, default-off) rendering
  `lastEmailedAt` + last recipient from the invoice fields persisted in FR-10.5.
- **FR-10.10 (MUST)** i18n ×4 under **`invoicing.sendEmail.*`** (namespace chosen to
  avoid the `invoicing.email` string collision): `action`, `title`, `to`, `subject`,
  `message`, `send`, `sentTo`, `notConfigured`, `draftBlocked`, `lastSent`. bg wording:
  „Изпрати по имейл", „Изпратено на …".

## 3. Edge cases

1. **Contact has no email** → dialog opens with an empty required field (the docx allows
   manual entry); saving the typed address back to the contact is **MAY** (checkbox,
   default off).
2. **No contact on the document** (anonymous cash sale) → empty prefill, manual entry.
3. **PDF renderer down** → 503 before any send; no EmailLog row.
4. **SendGrid 4xx/5xx** → 502, EmailLog `failed` with the error; the invoice's
   `emailedTo` is NOT updated.
5. **Not configured** (dev, or key removed) → 503 explicit; the button stays visible
   (config state isn't known client-side) — the error message carries the explanation.
6. **Huge invoices** (hundreds of lines → multi-MB PDF): SendGrid caps messages at 30 MB
   encoded — cap the attachment at 20 MB and 413 beyond (unreachable in practice; cheap
   guard).
7. **Cyrillic filenames**: keep the ASCII-safe `invoiceNumber` (numbers are Latin
   prefixes + digits today); subject/body are UTF-8 — verify a Cyrillic org name renders
   in the received mail.
8. **Concurrent sends of different invoices** share the singleton service — stateless,
   fine.

## 4. Integration & regression constraints

1. `GET /export/:id` and all export endpoints stay byte-identical; the email route only
   **reuses** their assembly helpers (extract a shared `renderInvoicePdf(orgId, id,
   opts)` helper rather than duplicating the 25 lines — refactor-only, behavior frozen,
   export tests must stay green unmodified).
2. `POST /invoices/:id/send` (issue) untouched; no wording overlap in routes/UI keys.
3. The two auth email callers keep working (FR-10.2 result type is additive).
4. Invoice model additions (`emailedTo`, `lastEmailedAt`) are optional fields — the
   import skills' POST payload contract is unaffected.
5. New tests: service unit (attachment payload shape, not-configured result, failure
   logging — mock fetch), endpoint integration (403 for read-only role, 422
   draft/incoming, happy path writes EmailLog + audit + invoice fields; try/catch
   capture, no `.rejects`), UI build.

## 5. Acceptance criteria

- [ ] Issued sales invoice → Send by email → dialog prefilled with the contact's address → send → success snackbar; mail arrives with `INV-….pdf` attached, correct letterhead/logo/locale.
- [ ] Recipient editable; invalid email blocked client- and server-side.
- [ ] Draft documents cannot be emailed (422 + disabled button/tooltip); incoming bills have no email button.
- [ ] Read-only user (member/nra_auditor) gets 403.
- [ ] With the API key absent (dev): explicit „not configured" error — no silent fake success.
- [ ] EmailLog rows for success AND failure, linked to the invoice; audit entry `email` visible in the audit log; form shows the last-sent indicator.
- [ ] `bun run test` + `bun run build` green; existing export suites untouched and green.

## 6. Field test (lgrai.app / regal)

1. Confirm `FROM_EMAIL` sender is verified in SendGrid (ops step) — else expect 502 with
   the provider message; record what was chosen.
2. Send a real (small) issued invoice to your own address; verify attachment renders,
   Cyrillic subject/body, logo present (PR #15 letterhead).
3. Send to a bad domain → provider failure surfaces as a red snackbar; EmailLog `failed`.
4. Verify the audit-log page shows the `email` action and the invoice form shows „last
   sent" after a success.
5. Re-send within a minute → 429 double-click guard.

---

## Appendix — authoritative requirement wording (Spravki ledger.docx §4)

```
Изпращане на изходящи фактури по имейл
Към изходящите/продажните фактури — функция „Изпрати по имейл": взема фактурата;
подготвя я за изпращане; възможност за въвеждане или избор на имейл адрес на клиента;
изпраща я като прикачен файл; ясно съобщение за успех/неуспех. Ако в картона на клиента
има имейл, той се попълва автоматично и може да се промени преди изпращането.
```
