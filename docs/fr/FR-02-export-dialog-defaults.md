# FR-02 — Export dialog defaults for Sales & Purchase documents

**Goal:** When exporting from the Sales and Purchase document lists, the dialog opens with
**Status and Currency unticked**, **Payment Method ticked**, everything else unchanged, and
**PDF preselected** as the format.

Status: draft for implementation · Date: 2026-08-21 · Depends on: nothing (FR-01 changes the
same views — coordinate) · Feeds: FR-03 (cash-sales export reuses these defaults)

---

## 1. Current state

- **One shared column catalog** drives every export dialog:
  `packages/ui-shared/src/composables/useExportColumns.ts:22-48` (`EXPORT_COLUMNS`), entries
  `{key, i18n, label, modes, docs?, defaultOn, align?}`. Relevant rows (verbatim):
  - `:28` `{ key: 'status', i18n: 'common.status', … modes: ['compact','detailed'], defaultOn: true }`
  - `:29` `{ key: 'currency', … modes: ['compact','detailed'], defaultOn: true }`
  - `:38` `{ key: 'paymentMethod', i18n: 'invoicing.paymentMethod', … modes: ['compact'], defaultOn: false }`
- **The dialog**: `packages/ui-shared/src/components/ExportDialog.vue`. Format default is
  `props.defaultFormat || 'xlsx'` (`:135`) — a `defaultFormat` prop **already exists** and no
  caller passes it. Columns reset from `defaultSelection(mode, docType)` every time the dialog
  opens or mode/docType changes (`:147-161`); **no persistence** of user selections.
- **Callers** (list views pass no columns; catalog rules):
  - `SalesInvoicesView.vue:133` `<ExportDialog … doc-type="invoice" @confirm="onExport" />`
  - `PurchaseInvoicesView.vue:119` `doc-type="bill"`
  - Reporting page cards (`ReportingExportView.vue:43,59,74`) feed docTypes
    `invoice`/`bill`/`cash_sale` and post to `/invoicing/export/kind/:kind`.
  - The single-document **Print** dialog reuses the same component with
    `default-mode="detailed"` (`DocumentForm.vue:111-119`).
- Server accepts both formats (`invoice-export.controller.ts:454` `xlsx|pdf`), validates
  column keys against its allowlist (`:18-22`), and — for `/export/list` — returns **404 when
  no documents match** (`:268`). PDF is rendered via md-to-pdf/Puppeteer
  (`packages/reporting/src/pdf/base.pdf.ts:30-55`) with a 503 fallback when unavailable
  (`invoice-export.controller.ts:439-448`).

## 2. Requirements

- **FR-2.1 (MUST)** Add per-mode default support to the catalog: extend `ExportColumn` with
  `defaultOnByMode?: Partial<Record<ExportMode, boolean>>`, consulted by
  `defaultSelection(mode, docType)` before falling back to `defaultOn`.
  Rationale: the request targets the **list** export (compact mode). The same catalog feeds
  the single-doc Print dialog (detailed mode) — its defaults must not change silently.
- **FR-2.2 (MUST)** New defaults, compact mode only:
  - `status` → `defaultOnByMode: { compact: false }` (stays default-on in detailed),
  - `currency` → `defaultOnByMode: { compact: false }`,
  - `paymentMethod` → `defaultOn: true` (it is compact-only already, so the plain flag suffices).
  All other entries untouched. Columns remain *available* — only the initial ticks change.
- **FR-2.3 (MUST)** Default format PDF at the two list dialogs: pass `default-format="pdf"` in
  `SalesInvoicesView` and `PurchaseInvoicesView` (post-FR-01: the merged views). The user can
  still switch to Excel per export; there is no persistence (existing behavior, keep).
- **FR-2.4 (SHOULD)** Apply `default-format="pdf"` to the Reporting → Export page's
  *outgoing* and *incoming* cards too (same data, same expectation). The *cash register* card
  is handled in FR-03. Leave the single-doc **Print** dialog's format default unchanged here
  (FR-03/impl MAY flip it to pdf for Print as an obvious follow-up — a Print button defaulting
  to xlsx is odd, but it was not requested; note it for the user).
- **FR-2.5 (MUST)** Server-side: **no change**. The dialog always sends an explicit `columns`
  array (confirm button is disabled when empty, `ExportDialog.vue:81`), so the server's
  `DEFAULT_COLUMNS` fallback (`reporting/src/excel/invoicing-list.excel.ts:105-114`) never
  engages from the UI.

## 3. Edge cases

1. **Empty result + PDF default**: `/export/list` 404s when nothing matches — with PDF now the
   default this path gets hit more (users exporting a filtered-empty list). Verify the
   snackbar shows the server message, not a blob-parse error (axios `responseType:'blob'`
   turns the JSON error into a Blob — check `useInvoicingExport.ts` handles it; fix if not).
2. **PDF renderer down** → 503 `PDF renderer unavailable`; same blob-error caveat as above.
3. **Mode switch inside the dialog** re-runs `resetSelection` — switching compact→detailed
   must re-tick status/currency (per-mode defaults working both ways).
4. **FR-01 interplay**: the merged lists add the `type` column (defaultOn true, compact) —
   its default is defined in FR-01; this FR must not drop it.
5. Payment-method column renders `paymentsByMethod`-derived labels
   (`invoice-export.controller.ts:122`, cash fallback for cash sales) — nothing to change,
   but include a bill with `paymentMethod` set and one without in the test data.

## 4. Acceptance criteria

- [ ] Open Export on the sales list: format=PDF, Status/Currency unticked, Payment Method ticked, all other defaults as before.
- [ ] Same on the purchase list and (SHOULD) on Reporting → Export outgoing/incoming cards.
- [ ] Detailed mode (and the Print dialog) still opens with Status/Currency ticked.
- [ ] Exported PDF/XLSX contain exactly the ticked columns; Payment Method values localized.
- [ ] Export with zero matching rows shows a readable error, not a broken download.
- [ ] `bun run build` green; unit test for `defaultSelection` per-mode behavior added.

## 5. Field test (lgrai.app / regal)

1. Sales list → filter to a real month → Export with defaults → PDF downloads; verify columns
   (no Status/Currency, has Payment Method) and Cyrillic rendering in the PDF.
2. Same export as Excel — column parity with the PDF.
3. Purchase list → Export defaults → verify supplier bills' payment methods.
4. Filter to an empty range → Export → readable "no documents" error.
5. Open a sales invoice → Print → confirm the detailed defaults are unchanged.
