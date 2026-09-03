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

    <div v-if="isEdit" class="d-flex justify-end mb-2">
      <v-btn variant="outlined" prepend-icon="mdi-printer" :loading="exportLoading" @click="showExportDialog = true">
        {{ $t('common.print') }}
      </v-btn>
    </div>
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

        <v-row dense>
          <!-- ── Left: product catalog (create mode only) ── -->
          <v-col v-if="!readonly" cols="12" md="7">
            <v-card variant="outlined" class="pa-3 terminal-catalog">
              <div class="d-flex ga-2 mb-3 flex-wrap">
                <v-text-field
                  v-model="catalogSearch"
                  :label="$t('common.search')"
                  prepend-inner-icon="mdi-magnify"
                  hide-details
                  clearable
                  autofocus
                  style="min-width: 200px; flex: 2 1 220px"
                  @keydown.enter.prevent="onSearchEnter"
                />
                <v-select
                  v-model="categoryFilter"
                  :items="categories"
                  item-title="name"
                  item-value="name"
                  :label="$t('warehouse.category')"
                  hide-details
                  clearable
                  style="min-width: 160px; flex: 1 1 160px"
                />
              </div>

              <div v-if="catalogLoading" class="d-flex justify-center py-8">
                <v-progress-circular indeterminate color="primary" />
              </div>
              <v-row v-else dense>
                <v-col v-for="p in products" :key="p.productId" cols="6" sm="4" lg="3">
                  <v-card
                    class="pa-2 terminal-card"
                    variant="tonal"
                    :color="p.stockAvailable !== null && p.stockAvailable <= 0 ? 'error' : undefined"
                    @click="addToCart(p)"
                  >
                    <div class="text-body-2 font-weight-medium terminal-card-name">{{ p.productName }}</div>
                    <div class="text-caption text-medium-emphasis text-truncate">{{ p.sku }}</div>
                    <div class="d-flex align-center justify-space-between mt-1">
                      <span class="text-body-2 font-weight-bold">{{ fmtCurrency(p.unitPrice || 0, form.currency) }}</span>
                      <v-chip v-if="p.stockAvailable !== null" size="x-small" label :color="p.stockAvailable > 0 ? 'success' : 'error'">
                        {{ p.stockAvailable }}
                      </v-chip>
                    </div>
                  </v-card>
                </v-col>
                <v-col v-if="!products.length" cols="12" class="text-center text-medium-emphasis py-8">
                  {{ $t('list.noMatches') }}
                </v-col>
              </v-row>

              <v-pagination
                v-if="totalPages > 1"
                v-model="catalogPage"
                :length="totalPages"
                density="compact"
                class="mt-2"
              />
            </v-card>
          </v-col>

          <!-- ── Right: cart + totals ── -->
          <v-col cols="12" :md="readonly ? 12 : 5">
            <v-card variant="outlined" class="pa-3">
              <div class="d-flex align-center justify-space-between mb-2">
                <span class="text-subtitle-1 font-weight-bold">
                  {{ $t('pos.cart') }} ({{ cartLines.length }})
                </span>
              </div>

              <div v-if="!cartLines.length" class="text-center text-medium-emphasis py-6">
                {{ $t('pos.cartEmpty') }}
              </div>

              <div
                v-for="{ line, idx } in cartLines"
                :key="idx"
                class="terminal-cart-row py-2"
              >
                <div class="d-flex align-center justify-space-between ga-2">
                  <span class="text-body-2 flex-grow-1 terminal-cart-name">{{ line.description }}</span>
                  <v-btn
                    v-if="!readonly"
                    icon="mdi-close"
                    size="x-small"
                    variant="text"
                    color="error"
                    :aria-label="$t('common.delete')"
                    @click="removeLine(idx)"
                  />
                </div>
                <div class="d-flex align-center ga-2 mt-1 flex-wrap">
                  <template v-if="!readonly">
                    <v-btn icon="mdi-minus" size="x-small" variant="tonal" :aria-label="$t('pos.decreaseQty')" @click="decrementQty(idx)" />
                    <v-text-field
                      v-model.number="line.quantity"
                      type="number"
                      min="0"
                      hide-details
                      density="compact"
                      style="max-width: 76px"
                      @change="onQtyChange(idx)"
                    />
                    <v-btn icon="mdi-plus" size="x-small" variant="tonal" :aria-label="$t('pos.increaseQty')" @click="line.quantity = Number(line.quantity || 0) + 1" />
                    <span class="text-caption">×</span>
                    <v-text-field
                      v-model.number="line.unitPrice"
                      type="number"
                      step="0.0001"
                      min="0"
                      hide-details
                      density="compact"
                      style="max-width: 110px"
                      @change="onLinePriceManualChange(idx)"
                    />
                    <PriceSelectButton
                      :product-id="line.productId"
                      :contact-id="form.contactId || undefined"
                      :quantity="line.quantity"
                      :org-url="orgUrl()"
                      :currency="form.currency"
                      @select="onLinePriceSelected(idx, $event)"
                    />
                  </template>
                  <template v-else>
                    <span class="text-body-2">{{ line.quantity }} × {{ fmtCurrency(line.unitPrice || 0, form.currency) }}</span>
                  </template>
                  <v-spacer />
                  <span class="text-body-2 font-weight-bold">{{ fmtCurrency(computeLineTotal(line), form.currency) }}</span>
                </div>
              </div>

              <v-divider class="my-3" />
              <div class="d-flex justify-space-between text-body-2">
                <span>{{ $t('common.subtotal') }}</span>
                <span>{{ fmtCurrency(subtotal, form.currency) }}</span>
              </div>
              <div class="d-flex justify-space-between text-body-2 mt-1">
                <span>{{ uniformTaxRate !== null ? $t('invoicing.taxTotalWithRate', { rate: uniformTaxRate }) : $t('invoicing.tax') }}</span>
                <span>{{ fmtCurrency(taxTotal, form.currency) }}</span>
              </div>
              <div class="d-flex justify-space-between text-h6 font-weight-bold mt-2">
                <span>{{ $t('common.total') }}</span>
                <span>{{ fmtCurrency(documentTotal, form.currency) }}</span>
              </div>

              <v-textarea v-model="notesModel" :label="$t(config.notesFieldLabelKey)" rows="2" auto-grow class="mt-3" />
              <TagInput v-model="form.tags" type="invoice" :org-url="orgUrl()" class="mt-1" />

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
            </v-card>
          </v-col>
        </v-row>

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
import { ref, computed, watch, onMounted } from 'vue'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import ExportDialog from 'ui-shared/components/ExportDialog'
import TagInput from 'ui-shared/components/TagInput.vue'
import ContactLedgerDialog from 'ui-shared/components/ContactLedgerDialog.vue'
import ContactPickerDialog from 'ui-shared/components/ContactPickerDialog'
import DateField from 'ui-shared/components/DateField.vue'
import PriceSelectButton from 'ui-shared/components/PriceSelectButton.vue'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import BankInfoRow from '../BankInfoRow.vue'
import SignatureFooter from '../SignatureFooter.vue'
import ContactAutocompleteWithCreate from '../ContactAutocompleteWithCreate.vue'
import { useDocumentForm, type UseDocumentFormOptions } from '../../composables/document-form/useDocumentForm'
import type { DocumentTypeConfig } from '../../composables/document-form/types'

/**
 * FR-03: POS-terminal layout for cash sales — product cards left, cart right.
 * `useDocumentForm` stays the engine (payload/pricing/save/stock-check contract is frozen:
 * the import-cash-register-sales skill posts the exact same POST /invoices body), so this
 * component is purely a different skin over the same state as DocumentForm.
 */
const props = defineProps<{
  config: DocumentTypeConfig
  onBeforeCreate?: UseDocumentFormOptions['onBeforeCreate']
}>()

const doc = useDocumentForm(props.config, { onBeforeCreate: props.onBeforeCreate })
const {
  config, isEdit, route, invoiceNumber, documentNumber, statusDef, formActions,
  formRef, loading, form, contacts, loadingContacts, rules,
  onContactChange, onContactCreated, onContactSearch, contactPickerOpen, onContactPicked,
  notesModel, appStore, ledgerDialog, showExportDialog, exportLoading, onExportSingle, companionNote,
  onSave, submitCreate, onAddLedgerLines, orgUrl, warehouses,
  docWarehouseId, onDocWarehouseChange, pinDefaultWarehouse, isPinnedDefaultWarehouse,
  paymentMethods, fmtCurrency, subtotal, taxTotal, documentTotal, uniformTaxRate,
  computeLineTotal, removeLine, addLine, resolvePriceForLine,
  onLinePriceManualChange, onLinePriceSelected,
} = doc

/** Cash sales are issued (paid) the moment they are saved — existing ones are read-only. */
const readonly = computed(() => isEdit.value)

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

function decrementQty(idx: number) {
  const line = form.lines[idx]
  if (!line) return
  const next = Number(line.quantity || 0) - 1
  if (next <= 0) removeLine(idx)
  else line.quantity = next
}

function onQtyChange(idx: number) {
  const line = form.lines[idx]
  if (!line) return
  if (!Number(line.quantity) || Number(line.quantity) <= 0) removeLine(idx)
  // Quantity can move the resolved tier (minQuantity prices) — re-resolve unless the
  // price was manually overridden.
  else if (line.resolvedPrice !== undefined && line.unitPrice === line.resolvedPrice) resolvePriceForLine(idx)
}

// ── product catalog (server-side, same endpoint the POS terminal uses) ──
interface CatalogProduct {
  productId: string
  productName: string
  sku?: string
  barcode?: string
  unitPrice: number
  taxRate: number
  unit?: string
  stockAvailable: number | null
}

const { search: catalogSearch, debouncedSearch } = useSearchDebounce()
const categoryFilter = ref<string | null>(null)
const categories = ref<Array<{ _id: string; name: string }>>([])
const products = ref<CatalogProduct[]>([])
const catalogPage = ref(1)
const totalPages = ref(1)
const catalogLoading = ref(false)

async function fetchCatalog() {
  if (readonly.value) return
  catalogLoading.value = true
  try {
    const params: Record<string, any> = { page: catalogPage.value - 1, size: 24 }
    if (docWarehouseId.value) params.warehouseId = docWarehouseId.value
    if (debouncedSearch.value) params.search = debouncedSearch.value
    if (categoryFilter.value) params.category = categoryFilter.value
    const { data } = await httpClient.get(`${orgUrl()}/trade/pos/catalog`, { params })
    products.value = data.products || []
    totalPages.value = data.totalPages || 1
  } catch {
    /* keep the previous page on transient errors */
  } finally {
    catalogLoading.value = false
  }
}

async function fetchCategories() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/product-category`, { params: { size: 0 } })
    categories.value = data.categories || []
  } catch {
    /* optional filter — ignore */
  }
}

watch([debouncedSearch, categoryFilter, docWarehouseId], () => {
  catalogPage.value = 1
  fetchCatalog()
})
watch(catalogPage, fetchCatalog)

onMounted(() => {
  if (!readonly.value) {
    fetchCatalog()
    fetchCategories()
  }
})

/** Click on a card: increment an existing cart line or fill/append a new one. */
async function addToCart(p: CatalogProduct) {
  if (readonly.value) return
  const lines = form.lines as any[]
  const existing = lines.findIndex((l) => l.productId === p.productId)
  if (existing >= 0) {
    lines[existing].quantity = Number(lines[existing].quantity || 0) + 1
    onQtyChange(existing)
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

/** Barcode scanners suffix Enter: a single match adds straight to the cart. */
function onSearchEnter() {
  if (products.value.length === 1) {
    addToCart(products.value[0])
    catalogSearch.value = ''
  }
}

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
.terminal-card {
  cursor: pointer;
  user-select: none;
  transition: transform 0.05s ease;
}
.terminal-card:active {
  transform: scale(0.97);
}
.terminal-card-name {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.6em;
  line-height: 1.3em;
}
.terminal-cart-row + .terminal-cart-row {
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.terminal-cart-name {
  word-break: break-word;
}
.terminal-catalog {
  min-height: 420px;
}
</style>
