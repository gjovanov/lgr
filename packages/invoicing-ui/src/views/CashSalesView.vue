<template>
  <!-- FR-21.13: the cash-register journal („Касови продажби") — the till's sales, the back office's
       and the imports'. This app adds what it always offered on cash sales: export (list or
       per-product aggregate), import, create, email. A till-only session gets the journal itself:
       those need invoicing's own rights, as does a sale's document page. -->
  <CashRegisterJournal
    ref="journal"
    :org-url="appStore.orgUrl()"
    :locale="appStore.locale"
    :role="role"
    :user-id="userId"
    :detail-route="(row: any) => journalRoute(row, tillOnly)"
    :invoice-link="(inv: any) => (tillOnly ? undefined : { name: 'invoicing.sales.edit', params: { id: inv.id } })"
  >
    <template #actions="{ filters }">
      <template v-if="!tillOnly">
        <v-btn variant="outlined" prepend-icon="mdi-download" :loading="exportLoading" @click="openExport(filters)">{{ $t('common.export') }}</v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-file-upload-outline" @click="showImportDialog = true">{{ $t('docImport.importBtn') }}</v-btn>
      </template>
      <!-- A new sale is rung up on the till, and not everyone who reads this journal sells. -->
      <responsive-btn v-if="canSell" color="primary" icon="mdi-plus" :to="{ name: 'invoicing.cash-sales.new' }">
        {{ $t('common.create') }}
      </responsive-btn>
    </template>

    <template #row-actions="{ item }">
      <!-- #171: „Издай фактура" for a sale held as a document, until it is invoiced in full. -->
      <v-btn
        v-if="!tillOnly && item.store === 'invoice' && item.kind === 'sale' && item.status === 'completed' && item.invoicingState !== 'full'"
        icon="mdi-file-document-plus-outline"
        size="small"
        variant="text"
        color="primary"
        :title="$t('invoicing.cashSaleInvoice.action')"
        :aria-label="$t('invoicing.cashSaleInvoice.action')"
        @click="openInvoiceDialog(item)"
      />
      <!-- Print the document — a sale or its storno, which prints as „Сторно на касова продажба"
           naming the sale it reverses — as the document page's Печат does. -->
      <v-btn
        v-if="!tillOnly && item.store === 'invoice'"
        icon="mdi-printer"
        size="small"
        variant="text"
        :loading="printingId === item.id"
        :title="$t('common.print')"
        :aria-label="$t('common.print')"
        @click="printRow(item)"
      />
      <!-- FR-10 (#19): email a cash sale or a storno held as a document. Tooltip on a wrapper span
           — a disabled v-btn has `pointer-events: none`, so a tooltip on the button itself never fires. -->
      <v-tooltip v-if="!tillOnly && item.store === 'invoice'" location="top" :text="$t('invoicing.sendEmail.action')">
        <template #activator="{ props: tip }">
          <span v-bind="tip">
            <v-btn
              icon="mdi-email-arrow-right-outline"
              size="small"
              variant="text"
              :disabled="item.status === 'voided'"
              :aria-label="$t('invoicing.sendEmail.action')"
              @click="openRowEmail({ _id: item.id, number: item.number, status: 'paid', contactEmail: item.contactEmail })"
            />
          </span>
        </template>
      </v-tooltip>
    </template>
  </CashRegisterJournal>

  <template v-if="!tillOnly">
    <ExportDialog
      v-model="showExportDialog"
      :loading="exportLoading"
      doc-type="cash_sale"
      default-format="pdf"
      show-aggregate
      default-aggregate
      @confirm="onExport"
    />

    <DocImportDialog
      v-model="showImportDialog"
      :org-url="appStore.orgUrl()"
      target="cash_sale"
      mode="batch"
      @committed="onImported"
    />

    <CashSaleInvoiceDialog v-if="invoiceFor" v-model="invoiceDialog" :cash-sale-id="invoiceFor" @issued="onInvoiceIssued" />

    <SendEmailDialog
      v-model="emailDialog"
      :default-to="emailTo"
      :default-subject="emailSubject"
      :document-number="emailDocNumber"
      :loading="emailLoading"
      @confirm="sendRowEmail"
    />
  </template>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAppStore } from '../store/app.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { jwtRole, jwtUserId, sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { canOpenPage, isTillOnly, pageById } from 'ui-shared/nav/page-registry'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import ExportDialog from 'ui-shared/components/ExportDialog'
import DocImportDialog from 'ui-shared/components/DocImportDialog.vue'
import SendEmailDialog from 'ui-shared/components/SendEmailDialog.vue'
import CashRegisterJournal from 'ui-shared/components/cash-register/CashRegisterJournal.vue'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'
import { useRowEmail } from '../composables/useRowEmail'
import CashSaleInvoiceDialog from '../components/CashSaleInvoiceDialog.vue'
import { journalRoute } from '../pos/till-rules'

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
// The app store's user is empty on a fresh page load; the session token is the durable source.
const role = computed(() => appStore.user?.role || jwtRole())
const userId = computed(() => appStore.user?.id || jwtUserId())
const journal = ref<{ fetchItems: () => Promise<void> } | null>(null)
const viewer = sessionViewer()
const tillOnly = isTillOnly(viewer)
const canSell = canOpenPage(pageById('/invoicing/cash-sales/new')!, viewer)

// FR-10 (#19): the row-level "send by email" action.
const {
  dialogOpen: emailDialog,
  loading: emailLoading,
  defaultTo: emailTo,
  defaultSubject: emailSubject,
  documentNumber: emailDocNumber,
  open: openRowEmail,
  send: sendRowEmail,
} = useRowEmail()

// ── #171: „Издай фактура" from the row ──
const router = useRouter()
const invoiceDialog = ref(false)
const invoiceFor = ref('')
function openInvoiceDialog(item: any) {
  invoiceFor.value = item.id
  invoiceDialog.value = true
}
function onInvoiceIssued(invoice: any) {
  router.push({ name: 'invoicing.sales.edit', params: { id: invoice.id || invoice._id } })
}

const showImportDialog = ref(false)

/** Imported documents land in this list, so refresh once the batch is written. */
function onImported(results: any[]) {
  const created = (results || []).filter((r: any) => r.ok).length
  if (created) showSuccess(t('docImport.committedN', { n: created }))
  void journal.value?.fetchItems()
}

// ── Export: the journal's period and status, as the invoicing export reads them ──
const showExportDialog = ref(false)
const exportFilters = ref<Record<string, any>>({})
const { loading: exportLoading, exportList, exportOne } = useInvoicingExport(() => appStore.orgUrl())

/** The row's Печат: the document's PDF, in the user's language. */
const printingId = ref('')
async function printRow(item: any) {
  printingId.value = item.id
  try {
    await exportOne(item.id, item.number, 'pdf', 'detailed', undefined, appStore.locale)
  } finally {
    printingId.value = ''
  }
}

function openExport(filters: Record<string, any>) {
  exportFilters.value = { ...filters }
  showExportDialog.value = true
}

async function onExport(opts: { format: 'xlsx' | 'pdf'; mode: 'compact' | 'detailed'; columns?: string[]; aggregated?: boolean }) {
  const f = exportFilters.value
  // The export reads documents: a voided one is `voided`, a completed or stornoed sale (and a
  // storno) is `paid`.
  const status = f.status === 'voided' ? 'voided' : f.status ? 'paid' : undefined
  try {
    await exportList('cash_sale', opts.format, opts.mode, {
      status,
      startDate: f.dateFrom || undefined,
      endDate: f.dateTo || undefined,
      // FR-03: per-product pivot — one row per product, no document headers.
      aggregated: opts.aggregated || undefined,
    }, {
      sortBy: 'issueDate',
      sortOrder: 'desc',
      columns: opts.columns,
      locale: appStore.locale,
    })
    showExportDialog.value = false
    showSuccess(t('export.success'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('export.failed'))
  }
}
</script>
