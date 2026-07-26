<template>
  <v-container fluid class="pa-4">
    <div class="d-flex align-center mb-4">
      <v-icon icon="mdi-file-upload-outline" class="mr-2" />
      <h2 class="text-h5">{{ $t('bills.batchImport.title') }}</h2>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-arrow-left" :to="{ name: 'invoicing.purchases' }">{{ $t('nav.purchaseInvoices') }}</v-btn>
    </div>

    <v-stepper v-model="step" :items="[$t('bills.batchImport.step1'), $t('bills.batchImport.step2'), $t('bills.batchImport.step3')]" flat hide-actions>
      <!-- ── Step 1: upload + extract ── -->
      <template #item.1>
        <v-card flat>
          <v-row>
            <v-col cols="12" md="4">
              <v-select
                v-model="warehouseId"
                :items="warehouses"
                item-title="name"
                item-value="_id"
                :label="$t('bills.batchImport.warehouse')"
                :hint="orderId ? $t('bills.batchImport.orderWarehouseHint') : $t('bills.batchImport.warehouseHint')"
                persistent-hint
                density="comfortable"
                variant="outlined"
              />
            </v-col>
            <v-col cols="12" md="4">
              <!-- ORD-aware import: lines are matched against this order's supplier group
                   (learned aliases + AI) and quantities split per its WH allocations. -->
              <v-autocomplete
                v-model="orderId"
                :items="orderOptions"
                item-title="label"
                item-value="_id"
                :label="$t('bills.batchImport.order')"
                :hint="$t('bills.batchImport.orderHint')"
                persistent-hint
                clearable
                no-filter
                density="comfortable"
                variant="outlined"
                :loading="loadingOrders"
                @update:search="onOrderSearch"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-file-input
                v-model="files"
                :label="$t('bills.batchImport.selectPdfs')"
                accept="application/pdf"
                multiple
                chips
                show-size
                prepend-icon="mdi-file-pdf-box"
                density="comfortable"
                variant="outlined"
              />
            </v-col>
          </v-row>
          <div class="d-flex align-center">
            <v-btn color="primary" :loading="extracting" :disabled="!warehouseId || !files.length" prepend-icon="mdi-text-recognition" @click="doExtract">
              {{ $t('bills.batchImport.extract') }}
            </v-btn>
            <span v-if="extracted.length" class="text-caption text-medium-emphasis ml-4">
              {{ $t('bills.batchImport.extractedN', { n: extracted.length }) }}
            </span>
          </div>

          <v-expansion-panels v-if="extracted.length" class="mt-4" multiple>
            <v-expansion-panel v-for="e in extracted" :key="e.fileId">
              <v-expansion-panel-title>
                <v-icon :icon="e.error ? 'mdi-alert-circle' : 'mdi-file-check'" :color="e.error ? 'error' : 'success'" class="mr-2" size="small" />
                {{ e.filename }}
                <v-chip v-if="e.method" size="x-small" class="ml-2" :color="e.method === 'native' ? 'info' : 'warning'">{{ e.method }}</v-chip>
                <span v-if="e.error" class="text-error text-caption ml-2">{{ e.error }}</span>
                <span v-else class="text-caption text-medium-emphasis ml-2">{{ e.chars }} {{ $t('bills.batchImport.chars') }}</span>
              </v-expansion-panel-title>
              <v-expansion-panel-text>
                <v-textarea v-model="e.text" :rows="10" variant="outlined" density="compact" hide-details class="text-mono" />
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>

          <div v-if="extractedOk.length" class="mt-4">
            <v-btn color="primary" variant="tonal" append-icon="mdi-arrow-right" @click="step = 2">{{ $t('common.next') }}</v-btn>
          </div>
        </v-card>
      </template>

      <!-- ── Step 2: draft ── -->
      <template #item.2>
        <v-card flat>
          <p class="text-body-2 mb-4">{{ $t('bills.batchImport.draftIntro', { n: extractedOk.length }) }}</p>
          <v-btn color="primary" :loading="drafting" :disabled="!extractedOk.length" prepend-icon="mdi-robot-outline" @click="doDraft">
            {{ $t('bills.batchImport.draftBtn', { n: extractedOk.length }) }}
          </v-btn>
          <v-progress-linear v-if="drafting" :model-value="draftProgress" color="primary" height="8" rounded class="mt-4" />
          <p v-if="drafting" class="text-caption text-medium-emphasis mt-2">{{ draftStatus }}</p>
          <div class="mt-4">
            <v-btn variant="text" prepend-icon="mdi-arrow-left" @click="step = 1">{{ $t('common.back') }}</v-btn>
          </div>
        </v-card>
      </template>

      <!-- ── Step 3: review + convert ── -->
      <template #item.3>
        <v-card flat>
          <div class="d-flex align-center mb-3">
            <span class="text-body-2">{{ $t('bills.batchImport.reviewIntro', { n: bills.length }) }}</span>
            <v-spacer />
            <v-btn color="success" variant="tonal" class="mr-2" :disabled="!selected.length || converting" :loading="converting" prepend-icon="mdi-check" @click="doConvert(selected)">
              {{ $t('bills.batchImport.convertSelected', { n: selected.length }) }}
            </v-btn>
            <v-btn color="success" :disabled="!draftIds.length || converting" :loading="converting" prepend-icon="mdi-check-all" @click="doConvert(draftIds)">
              {{ $t('bills.batchImport.convertAll') }}
            </v-btn>
          </div>
          <v-data-table
            v-model="selected"
            :headers="headers"
            :items="bills"
            item-value="_id"
            show-select
            :items-per-page="50"
            density="comfortable"
          >
            <template #[`item.direction`]="{ item }">
              <v-chip size="x-small" :color="item.direction === 'outgoing' ? 'success' : 'info'" variant="tonal">
                {{ item.direction === 'outgoing' ? $t('bills.batchImport.sales') : $t('bills.batchImport.purchase') }}
              </v-chip>
            </template>
            <template #[`item.status`]="{ item }">
              <v-chip size="small" :color="item.status === 'received' ? 'info' : 'grey'">{{ $t('invoicing.status.' + item.status, item.status) }}</v-chip>
              <v-chip v-if="(item.tags || []).includes('needs-review')" size="x-small" color="warning" class="ml-1" prepend-icon="mdi-alert">{{ $t('bills.batchImport.review') }}</v-chip>
              <v-chip v-for="tag in (item.tags || []).filter((t: string) => t.startsWith('ord:'))" :key="tag" size="x-small" color="primary" variant="tonal" class="ml-1" prepend-icon="mdi-clipboard-list-outline">{{ tag.slice(4) }}</v-chip>
              <v-chip v-if="(item.tags || []).includes('ord-unmatched')" size="x-small" color="warning" variant="tonal" class="ml-1" prepend-icon="mdi-clipboard-alert-outline">{{ $t('bills.batchImport.orderUnmatched') }}</v-chip>
            </template>
            <template #[`item.total`]="{ item }">{{ item.total?.toFixed(2) }} {{ item.currency }}</template>
            <template #[`item.matched`]="{ item }">{{ matchedCount(item) }} / {{ (item.lines || []).length }}</template>
            <template #[`item.actions`]="{ item }">
              <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: item.direction === 'outgoing' ? 'invoicing.sales.edit' : 'invoicing.purchases.edit', params: { id: item._id } }" />
              <v-btn v-if="item.status === 'draft'" icon="mdi-delete" size="small" variant="text" color="error" @click="reject(item)" />
            </template>
          </v-data-table>
          <div class="mt-3">
            <v-btn variant="text" prepend-icon="mdi-refresh" @click="loadBills">{{ $t('common.refresh') }}</v-btn>
          </div>
        </v-card>
      </template>
    </v-stepper>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const step = ref(1)
const warehouses = ref<{ _id: string; name: string }[]>([])
const warehouseId = ref<string>('')
const files = ref<File[]>([])

interface Extracted { fileId: string; filename: string; method?: string; chars: number; text: string; error?: string }
const extracted = ref<Extracted[]>([])
const extractedOk = computed(() => extracted.value.filter(e => !e.error && e.text))

const extracting = ref(false)
const drafting = ref(false)
const draftProgress = ref(0)
const draftStatus = ref('')
const converting = ref(false)

const batchId = ref('')
const bills = ref<any[]>([])
const selected = ref<string[]>([])
const draftIds = computed(() => bills.value.filter(b => b.status === 'draft').map(b => b._id))

// ── optional ORD- context ──
const orderId = ref<string | null>(null)
const orderOptions = ref<any[]>([])
const loadingOrders = ref(false)
let orderSearchTimer: ReturnType<typeof setTimeout> | null = null

async function fetchOrders(search?: string) {
  loadingOrders.value = true
  try {
    const params: Record<string, any> = { status: 'sent,partially_received,received', size: 20 }
    if (search) params.search = search
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/orders`, { params })
    const items = (data.orders || []).map((o: any) => ({
      _id: o._id,
      label: `${o.orderNumber} — ${(o.supplierNames || []).join(', ')}`,
    }))
    // Keep the current selection resolvable when the search filters it out.
    const current = orderOptions.value.find((o) => o._id === orderId.value)
    if (current && !items.some((o: any) => o._id === current._id)) items.push(current)
    orderOptions.value = items
  } catch { /* ignore */ } finally {
    loadingOrders.value = false
  }
}

function onOrderSearch(text: string) {
  if (orderSearchTimer) clearTimeout(orderSearchTimer)
  orderSearchTimer = setTimeout(() => fetchOrders(text || undefined), 300)
}

const headers = computed(() => [
  { title: t('bills.batchImport.number'), key: 'invoiceNumber' },
  { title: t('bills.batchImport.direction'), key: 'direction', sortable: false },
  { title: t('bills.batchImport.counterparty'), key: 'contactName' },
  { title: t('bills.batchImport.ref'), key: 'reference' },
  { title: t('bills.batchImport.total'), key: 'total', align: 'end' as const },
  { title: t('bills.batchImport.matched'), key: 'matched', sortable: false },
  { title: t('common.status'), key: 'status' },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
])

const matchedCount = (b: any) => (b.lines || []).filter((l: any) => l.productId).length
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

onMounted(async () => {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`, { params: { size: 1000 } })
    warehouses.value = data.warehouses || data.data || []
    const def = warehouses.value.find((w: any) => w.isDefault) || warehouses.value[0]
    if (def) warehouseId.value = def._id
  } catch { /* ignore */ }
  fetchOrders()
})

async function doExtract() {
  extracting.value = true
  try {
    const fd = new FormData()
    for (const f of files.value) fd.append('files', f)
    fd.append('warehouseId', warehouseId.value)
    // Override the client's default application/json so the browser sets
    // multipart/form-data + boundary (otherwise the server can't parse the files).
    const { data } = await httpClient.post(`${appStore.orgUrl()}/bills/import/extract`, fd, {
      headers: { 'Content-Type': undefined },
    })
    extracted.value = data.files || []
    const failed = extracted.value.filter(e => e.error).length
    if (failed) showError(t('bills.batchImport.someFailed', { n: failed }))
    else showSuccess(t('bills.batchImport.extractedN', { n: extracted.value.length }))
  } catch (e: any) {
    showError(e?.response?.data?.message || String(e))
  } finally {
    extracting.value = false
  }
}

async function doDraft() {
  drafting.value = true
  draftProgress.value = 0
  draftStatus.value = t('bills.batchImport.drafting')
  try {
    const items = extractedOk.value.map(e => ({ fileId: e.fileId, text: e.text }))
    const { data } = await httpClient.post(`${appStore.orgUrl()}/bills/import/draft`, {
      warehouseId: warehouseId.value,
      ...(orderId.value ? { orderId: orderId.value } : {}),
      items,
    })
    batchId.value = data.batchId
    // Poll for created bills until all appear (or timeout).
    for (let i = 0; i < 90; i++) {
      await sleep(2000)
      await loadBills()
      draftProgress.value = Math.min(99, Math.round((bills.value.length / items.length) * 100))
      draftStatus.value = t('bills.batchImport.draftedN', { n: bills.value.length, total: items.length })
      if (bills.value.length >= items.length) break
    }
    draftProgress.value = 100
    step.value = 3
    showSuccess(t('bills.batchImport.draftedN', { n: bills.value.length, total: items.length }))
  } catch (e: any) {
    showError(e?.response?.data?.message || String(e))
  } finally {
    drafting.value = false
  }
}

async function loadBills() {
  if (!batchId.value) return
  const { data } = await httpClient.get(`${appStore.orgUrl()}/invoices`, { params: { tags: `ocr:${batchId.value}`, pageSize: 200, sortBy: 'invoiceNumber' } })
  bills.value = data.invoices || []
}

async function doConvert(ids: string[]) {
  if (!ids.length) return
  converting.value = true
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/bills/import/convert`, { invoiceIds: ids })
    const failed = (data.results || []).filter((r: any) => !r.ok)
    showSuccess(t('bills.batchImport.convertedN', { n: data.converted }))
    if (failed.length) showError(t('bills.batchImport.convertFailed', { n: failed.length }))
    selected.value = []
    await loadBills()
  } catch (e: any) {
    showError(e?.response?.data?.message || String(e))
  } finally {
    converting.value = false
  }
}

async function reject(item: any) {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/invoices/${item._id}`)
    showSuccess(t('bills.batchImport.rejected'))
    await loadBills()
  } catch (e: any) {
    showError(e?.response?.data?.message || String(e))
  }
}
</script>

<style scoped>
.text-mono :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
</style>
