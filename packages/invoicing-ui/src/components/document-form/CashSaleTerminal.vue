<template>
  <EntityFormShell
    :title="isEdit ? $t(config.titleEditKey) : $t(config.titleNewKey)"
    :subtitle="isEdit ? invoiceNumber : ''"
    :status="statusDef"
    :actions="formActions"
    :loading="loading"
    :back-to="config.backTo"
    :back-label="config.backLabelKey ? $t(config.backLabelKey) : undefined"
    :entity-id="isEdit ? (route.params.id as string) : undefined"
  >
    <!-- Same banner as DocumentForm: org + title | client picker | number + print note -->
    <template #document-header>
      <div class="doc-banner d-flex align-center justify-space-between px-4 py-3 ga-4 flex-wrap">
        <div class="d-flex align-center ga-3">
          <v-avatar size="36" color="primary" variant="tonal">
            <v-icon size="20">{{ config.pendingIcon }}</v-icon>
          </v-avatar>
          <div>
            <div class="text-overline text-medium-emphasis">{{ appStore.currentOrg?.name || '—' }}</div>
            <div class="text-subtitle-1 font-weight-bold">
              {{ isEdit ? $t(config.titleEditKey) : $t(config.titleNewKey) }}
            </div>
          </div>
        </div>

        <div style="flex: 1 1 260px; max-width: 460px;">
          <v-defaults-provider :defaults="{
            VAutocomplete: { density: 'compact', variant: 'filled', hideDetails: 'auto', persistentPlaceholder: true },
            VTextField: { density: 'compact', variant: 'filled', persistentPlaceholder: true },
          }">
            <div class="d-flex align-center ga-1">
              <ContactAutocompleteWithCreate
                v-model="form.contactId"
                :contacts="contacts"
                :label="$t(config.partyLabelKey)"
                :org-url="orgUrl()"
                :required="config.partyRequired"
                :loading="loadingContacts"
                :disabled="readonly"
                class="flex-grow-1"
                @update:model-value="onContactChange"
                @update:search="onContactSearch"
                @contact-created="onContactCreated"
              />
              <v-btn
                icon="mdi-magnify-expand"
                size="small"
                variant="text"
                :disabled="readonly"
                :title="$t('invoicing.searchContact')"
                :aria-label="$t('invoicing.searchContact')"
                @click="contactPickerOpen = true"
              />
              <v-btn
                v-if="form.contactId"
                icon="mdi-book-open-variant"
                size="small"
                variant="text"
                color="info"
                :title="$t('invoicing.contactLedger')"
                @click="ledgerDialog = true"
              />
            </div>
          </v-defaults-provider>
        </div>

        <div class="text-end terminal-banner-meta">
          <div class="text-h6 font-weight-bold">{{ documentNumber || '—' }}</div>
          <v-chip v-if="statusDef" size="x-small" label color="primary" variant="tonal" class="mt-1">
            {{ $t(statusDef.current) }}
          </v-chip>
          <!-- Fills the "Допълнителна информация" block of the companion documents. A saved
               cash sale is read-only, so the box is only worth showing while it can still be
               typed — or afterwards, when it actually carries something. -->
          <v-textarea
            v-if="!readonly || companionNote"
            v-model="companionNote"
            :readonly="readonly"
            :label="$t('invoicing.companionNote')"
            :hint="$t('invoicing.companionNoteHint')"
            :counter="readonly ? undefined : COMPANION_NOTE_MAX"
            :maxlength="COMPANION_NOTE_MAX"
            persistent-hint
            rows="2"
            auto-grow
            variant="outlined"
            class="mt-2 text-start"
          />
        </div>
      </div>
    </template>

    <div v-if="isEdit" class="d-flex justify-end align-center flex-wrap ga-2 mb-2">
      <!-- #171: the invoices issued for this sale. The link lives on them; this reads it back. -->
      <template v-if="invoicing?.invoices?.length">
        <span class="text-caption text-medium-emphasis">{{ $t('invoicing.cashSaleInvoice.existing') }}:</span>
        <v-chip
          v-for="inv in invoicing.invoices"
          :key="inv.id"
          size="small"
          variant="tonal"
          color="primary"
          prepend-icon="mdi-file-document-outline"
          :to="{ name: 'invoicing.sales.edit', params: { id: inv.id } }"
        >
          {{ inv.number }}
        </v-chip>
      </template>
      <v-btn
        v-if="invoicing?.canInvoice"
        variant="outlined"
        color="primary"
        prepend-icon="mdi-file-document-plus-outline"
        @click="invoiceDialog = true"
      >
        {{ $t('invoicing.cashSaleInvoice.action') }}
      </v-btn>
      <v-btn variant="outlined" prepend-icon="mdi-printer" :loading="exportLoading" @click="showExportDialog = true">
        {{ $t('common.print') }}
      </v-btn>
    </div>
    <CashSaleInvoiceDialog
      v-if="isEdit"
      v-model="invoiceDialog"
      :cash-sale-id="(route.params.id as string)"
      @issued="onInvoiceIssued"
    />
    <ExportDialog
      v-model="showExportDialog"
      :loading="exportLoading"
      default-mode="detailed"
      :title="$t('common.print')"
      icon="mdi-printer"
      :companion-docs="companionDocs"
      @confirm="onExportSingle"
    />

    <v-form ref="formRef" @submit.prevent="onSave">
      <v-defaults-provider :defaults="{
        VTextField: { density: 'compact', variant: 'outlined' },
        VSelect: { density: 'compact', variant: 'outlined' },
        VAutocomplete: { density: 'compact', variant: 'outlined' },
        VTextarea: { density: 'compact', variant: 'outlined' },
      }">
        <!-- Doc meta strip: date · payment · warehouse (+pin) · currency -->
        <v-row dense class="mb-1">
          <v-col cols="6" sm="3" md="2">
            <DateField v-model="form.issueDate" :label="$t('invoicing.issueDate')" :rules="[rules.required]" :disabled="readonly" />
          </v-col>
          <v-col cols="6" sm="3" md="2">
            <v-select
              v-model="form.paymentMethod"
              :label="$t('invoicing.paymentMethod')"
              :items="paymentMethods"
              item-title="text"
              item-value="value"
              :disabled="readonly"
            />
          </v-col>
          <v-col cols="9" sm="4" md="3">
            <v-autocomplete
              :model-value="docWarehouseId"
              :items="warehouses"
              item-title="name"
              item-value="_id"
              :label="$t('warehouse.warehouse')"
              :disabled="readonly"
              clearable
              @update:model-value="onDocWarehouseChange"
            />
          </v-col>
          <v-col cols="3" sm="2" md="1" class="d-flex align-center">
            <v-btn
              :icon="isPinnedDefaultWarehouse ? 'mdi-pin' : 'mdi-pin-outline'"
              size="small"
              variant="text"
              :title="$t('invoicing.saveDefaultWarehouse')"
              @click="pinDefaultWarehouse"
            />
          </v-col>
          <v-col cols="6" sm="4" md="2">
            <v-select v-model="form.currency" :label="$t('common.currency')" :items="currencies" :disabled="readonly" />
          </v-col>
        </v-row>

        <!-- FR-21.29: the catalog, the cart and the totals are the till's own RegisterTerminal; this
             form hands in its customer-aware price, its notes and tags, the receipt and Save. -->
        <RegisterTerminal
          ref="terminal"
          :org-url="orgUrl()"
          :currency="form.currency"
          :warehouse-id="docWarehouseId"
          :lines="cartRows"
          :totals="registerTotals"
          :line-gross="lineGross"
          :readonly="readonly"
          :search-label="$t('common.search')"
          :contact-id="form.contactId || undefined"
          @add="addToCart"
          @quantity="onCartQuantity"
          @remove="(i: number) => removeLine(cartLines[i].idx)"
          @price="(i: number, opt: any) => onLinePriceSelected(cartLines[i].idx, opt)"
        >
          <template #line-price="{ line, idx: i }">
            <span class="text-caption">×</span>
            <!-- The same price dropdown as an invoice line, but listing EVERY named price (`all`),
                 the „Цена N" slots included: at the till the cashier picks the price from the list
                 rather than typing it. A typed value still works. -->
            <PriceCombobox
              :model-value="line.unitPrice"
              :product-id="line.productId"
              :contact-id="form.contactId || undefined"
              :quantity="line.quantity"
              :org-url="orgUrl()"
              :currency="form.currency"
              :resolved-price="line.resolvedPrice"
              :price-explanation="line.priceExplanation"
              :auto-apply-resolved="!line.loaded && !line.pricePinned"
              all
              style="max-width: 160px"
              @update:model-value="onLinePriceChange(cartLines[i].idx, $event)"
              @update:price-explanation="line.priceExplanation = $event"
            />
            <PriceSelectButton
              :product-id="line.productId"
              :contact-id="form.contactId || undefined"
              :quantity="line.quantity"
              :org-url="orgUrl()"
              :currency="form.currency"
              @select="onLinePriceSelected(cartLines[i].idx, $event)"
            />
          </template>
          <template #cart-actions>
            <v-textarea v-model="notesModel" :label="$t(config.notesFieldLabelKey)" rows="2" auto-grow />
            <TagInput v-model="form.tags" type="invoice" :org-url="orgUrl()" class="mt-1" />
            <!-- FR-21.31 (D-13): the author's open session takes this sale; it prints on that
                 session's device only when asked, as the till's „Нефискален" switch asks. -->
            <v-select
              v-if="!readonly && openSession"
              v-model="receipt"
              :items="receiptOptions"
              item-title="title"
              item-value="value"
              :label="$t('pos.joinSession.receipt')"
              :hint="$t('pos.joinSession.hint', { session: openSession.sessionNumber })"
              persistent-hint
              class="mt-2"
              data-testid="cash-sale-receipt"
            />
            <v-btn
              v-if="!readonly"
              color="primary"
              variant="flat"
              block
              size="large"
              prepend-icon="mdi-cash-register"
              class="mt-3"
              :loading="loading"
              :disabled="!cartLines.length"
              @click="onSave"
            >
              {{ $t('common.save') }}
            </v-btn>
          </template>
        </RegisterTerminal>

        <v-divider class="my-4" />
        <BankInfoRow :org="appStore.currentOrg" />
        <SignatureFooter
          v-if="config.showSignatureFooter"
          :prepared-by="form.preparedBy || userFullName"
          :place="form.placeOfTransaction"
        />
      </v-defaults-provider>
    </v-form>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" :entity-type="config.notesEntityType" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>

    <ContactLedgerDialog v-model="ledgerDialog" :contact-id="form.contactId || ''" :org-url="orgUrl()" :selectable="!readonly" @add-lines="onAddLedgerLines" />
    <ContactPickerDialog v-model="contactPickerOpen" :org-url="orgUrl()" @select="onContactPicked" />

    <!-- Escape hatch for the wrapper's StockTransferDialog — same contract as DocumentForm. -->
    <slot name="dialogs" :submitCreate="submitCreate" :form="form" :orgUrl="orgUrl" :loading="loading" :config="config" />
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import ExportDialog from 'ui-shared/components/ExportDialog'
import TagInput from 'ui-shared/components/TagInput.vue'
import ContactLedgerDialog from 'ui-shared/components/ContactLedgerDialog.vue'
import ContactPickerDialog from 'ui-shared/components/ContactPickerDialog'
import DateField from 'ui-shared/components/DateField.vue'
import PriceSelectButton from 'ui-shared/components/PriceSelectButton.vue'
import PriceCombobox from 'ui-shared/components/PriceCombobox.vue'
import RegisterTerminal, { type RegisterCatalogProduct } from 'ui-shared/components/cash-register/RegisterTerminal.vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { jwtUserId } from 'ui-shared/composables/useStorageIdentity'
import { computePosTotals } from 'config/pos-totals'
import { useI18n } from 'vue-i18n'
import BankInfoRow from '../BankInfoRow.vue'
import SignatureFooter from '../SignatureFooter.vue'
import ContactAutocompleteWithCreate from 'ui-shared/components/ContactAutocompleteWithCreate.vue'
import CashSaleInvoiceDialog from '../CashSaleInvoiceDialog.vue'
import { useRouter } from 'vue-router'
import { useDocumentForm, type UseDocumentFormOptions } from '../../composables/document-form/useDocumentForm'
import type { DocumentTypeConfig } from '../../composables/document-form/types'

/**
 * FR-03: POS-terminal layout for cash sales — product cards left, cart right.
 * `useDocumentForm` stays the engine (payload/pricing/save/stock-check contract is frozen:
 * the import-cash-register-sales skill posts the exact same POST /invoices body), so this
 * component is purely a different skin over the same state as DocumentForm.
 *
 * FR-21.29: the catalog, the cart and the totals are `ui-shared`'s RegisterTerminal, the one the till
 * sells through. This form keeps its document header, its customer-aware prices and its Save.
 */
const props = defineProps<{
  config: DocumentTypeConfig
  onBeforeCreate?: UseDocumentFormOptions['onBeforeCreate']
}>()

const doc = useDocumentForm(props.config, {
  onBeforeCreate: props.onBeforeCreate,
  // FR-21.31: a joined sale prints on its session's device only when asked.
  extraPayload: () => (openSession.value && receipt.value ? { receipt: receipt.value } : {}),
})
const {
  config, isEdit, route, invoiceNumber, documentNumber, statusDef, formActions,
  formRef, loading, form, contacts, loadingContacts, rules,
  onContactChange, onContactCreated, onContactSearch, contactPickerOpen, onContactPicked,
  notesModel, appStore, ledgerDialog, showExportDialog, exportLoading, onExportSingle, companionNote,
  onSave, submitCreate, onAddLedgerLines, orgUrl, warehouses,
  docWarehouseId, onDocWarehouseChange, pinDefaultWarehouse, isPinnedDefaultWarehouse,
  paymentMethods, fmtCurrency, subtotal, taxTotal, documentTotal, uniformTaxRate,
  computeLineTotal, removeLine, addLine, resolvePriceForLine,
  onLinePriceChange, onLinePriceSelected,
} = doc

/** Cash sales are issued (paid) the moment they are saved — existing ones are read-only. */
const readonly = computed(() => isEdit.value)

// ── #171: „Издай фактура" — an invoice for this cash sale ──
const router = useRouter()
const invoiceDialog = ref(false)
const invoicing = ref<any>(null)
async function loadInvoicing() {
  if (!isEdit.value) return
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoices/${route.params.id}/to-invoice`)
    invoicing.value = data.invoicing
  } catch {
    invoicing.value = null
  }
}
function onInvoiceIssued(invoice: any) {
  router.push({ name: 'invoicing.sales.edit', params: { id: invoice.id || invoice._id } })
}
onMounted(loadInvoicing)

const currencies = ['EUR', 'USD', 'GBP', 'CHF', 'MKD', 'BGN', 'RSD']
/** Matches `companionNote`'s maxlength on the Invoice model. */
const COMPANION_NOTE_MAX = 300
const userFullName = computed(() => appStore.fullName || '')
const companionDocs = computed(() => [
  { key: 'certificate', i18n: 'export.certificate', label: 'Declaration of Conformity' },
  { key: 'ppprotocol', i18n: 'export.ppProtocol', label: 'Acceptance & Handover Protocol' },
])

/** Cart = the form's filled lines, with their REAL index so every line-op maps 1:1. */
const cartLines = computed(() =>
  form.lines.map((line: any, idx: number) => ({ line, idx })).filter((x: any) => x.line.productId),
)
/** What RegisterTerminal shows; its events name a cart position, mapped back through `cartLines`. */
const cartRows = computed(() => cartLines.value.map((x: any) => x.line))

// FR-21.30: the form's totals are `computePosTotals` for a cash sale (`computeTotals`), the till's.
const registerTotals = computed(() => ({ subtotal: subtotal.value, taxTotal: taxTotal.value, total: documentTotal.value }))
const lineGross = (l: any) => computePosTotals([{ quantity: Number(l.quantity) || 0, unitPrice: Number(l.unitPrice) || 0, taxRate: Number(l.taxRate) || 0 }]).total

/** A quantity RegisterTerminal settled (zero removes the line there). */
function onCartQuantity(i: number, quantity: number) {
  const idx = cartLines.value[i]?.idx
  if (idx === undefined) return
  const line = form.lines[idx]
  line.quantity = quantity
  // Quantity can move the resolved tier (minQuantity prices) — re-resolve unless the price was
  // manually overridden.
  if (line.resolvedPrice !== undefined && line.unitPrice === line.resolvedPrice) resolvePriceForLine(idx)
}

/** A card or a scan: increment an existing cart line or fill/append a new one. */
async function addToCart(p: RegisterCatalogProduct) {
  if (readonly.value) return
  const lines = form.lines as any[]
  const existing = lines.findIndex((l) => l.productId === p.productId)
  if (existing >= 0) {
    const i = cartLines.value.findIndex((x: any) => x.idx === existing)
    onCartQuantity(i, Number(lines[existing].quantity || 0) + 1)
    return
  }
  let idx = lines.findIndex((l) => !l.productId)
  if (idx < 0) {
    addLine()
    idx = lines.length - 1
  }
  const line = lines[idx]
  line.productId = p.productId
  line.description = p.productName
  line.quantity = 1
  line.unit = p.unit || line.unit || 'pcs'
  line.unitPrice = p.unitPrice ?? 0
  line.taxRate = p.taxRate ?? line.taxRate
  line.warehouseId = docWarehouseId.value || line.warehouseId
  // Contact-aware resolution (tag/tier prices) + audit-trail explanation.
  await resolvePriceForLine(idx)
}

// ── FR-21.31 (D-13): the author's open session, which this sale joins ──
const { t } = useI18n()
const openSession = ref<{ _id: string; sessionNumber: string } | null>(null)
/** How the joined sale prints on the session's device: nothing (''), a fiscal receipt, or text. */
const receipt = ref<'' | 'fiscal' | 'text'>('')
const receiptOptions = computed(() => [
  { title: t('pos.joinSession.noReceipt'), value: '' },
  { title: t('pos.joinSession.fiscal'), value: 'fiscal' },
  { title: t('pos.joinSession.text'), value: 'text' },
])
async function loadOpenSession() {
  if (readonly.value) return
  try {
    const cashierId = (appStore.user as any)?.id || jwtUserId()
    const { data } = await httpClient.get(`${orgUrl()}/trade/pos/session`, { params: { status: 'open', size: 1, ...(cashierId ? { cashierId } : {}) } })
    openSession.value = (data.sessions || [])[0] || null
  } catch {
    openSession.value = null // no till access: the sale stays sessionless, as the server decides too
  }
}
onMounted(loadOpenSession)


defineExpose({ submitCreate, doc })
</script>

<style scoped>
.terminal-banner-meta {
  min-width: 180px;
}
.doc-banner {
  background: linear-gradient(
    90deg,
    rgba(var(--v-theme-primary), 0.06),
    rgba(var(--v-theme-primary), 0.01)
  );
}
</style>
