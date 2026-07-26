<template>
  <EntityFormShell
    :title="isEdit ? $t('invoicing.editOrder') : $t('invoicing.newOrder')"
    :subtitle="documentNumber"
    :status="statusDef"
    :actions="formActions"
    :loading="loading"
    back-to="/orders"
    :back-label="$t('nav.orders')"
    :entity-id="isEdit ? (route.params.id as string) : undefined"
  >
    <template #document-header>
      <div class="d-flex align-center justify-space-between px-4 py-3 ga-4 flex-wrap">
        <div class="d-flex align-center ga-3">
          <v-avatar size="36" color="primary" variant="tonal">
            <v-icon size="20">mdi-clipboard-list-outline</v-icon>
          </v-avatar>
          <div>
            <div class="text-overline text-medium-emphasis">{{ appStore.currentOrg?.name || '—' }}</div>
            <div class="text-subtitle-1 font-weight-bold">{{ isEdit ? $t('invoicing.editOrder') : $t('invoicing.newOrder') }}</div>
          </div>
        </div>
        <div class="text-end">
          <div class="text-h6 font-weight-bold">{{ documentNumber || '—' }}</div>
          <v-chip size="x-small" label color="primary" variant="tonal" class="mt-1">
            {{ $t(`invoicing.status.${orderStatus}`) }}
          </v-chip>
        </div>
      </div>
    </template>

    <v-form ref="formRef" @submit.prevent="onSave">
      <v-defaults-provider :defaults="{
        VTextField: { density: 'compact', variant: 'outlined' },
        VSelect: { density: 'compact', variant: 'outlined' },
        VAutocomplete: { density: 'compact', variant: 'outlined' },
        VTextarea: { density: 'compact', variant: 'outlined' },
      }">
        <!-- Header fields -->
        <v-row dense>
          <v-col cols="6" sm="3" md="2">
            <v-text-field v-model="form.issueDate" :label="$t('invoicing.issueDate')" type="date" :readonly="readonly" />
          </v-col>
          <v-col cols="6" sm="3" md="2">
            <v-text-field v-model="form.expectedDate" :label="$t('invoicing.expectedDate')" type="date" clearable :readonly="readonly" />
          </v-col>
          <v-col cols="6" sm="3" md="2">
            <v-select v-model="form.currency" :label="$t('common.currency')" :items="currencyOptions" :readonly="readonly" />
          </v-col>
        </v-row>

        <!-- Supplier groups -->
        <div v-for="(group, gi) in form.supplierGroups" :key="group._id || gi" class="mt-4">
          <v-card variant="outlined" rounded="lg">
            <v-card-title class="d-flex align-center ga-2 py-2 flex-wrap">
              <v-icon size="20" color="primary">mdi-factory</v-icon>
              <div style="min-width: 260px; max-width: 380px" class="flex-grow-1">
                <v-autocomplete
                  v-model="group.supplierId"
                  :items="supplierOptions"
                  item-title="companyName"
                  item-value="_id"
                  :label="$t('invoicing.supplier')"
                  :rules="[rules.required]"
                  no-filter
                  hide-details
                  :readonly="readonly"
                  :loading="loadingContacts"
                  @update:search="(s: string) => onContactSearch(s, 'supplier')"
                />
              </div>
              <v-text-field v-model="group.reference" :label="$t('invoicing.reference')" hide-details style="max-width: 200px" :readonly="readonly" />
              <v-spacer />
              <v-menu v-if="isEdit && group._id">
                <template #activator="{ props: mp }">
                  <v-btn v-bind="mp" size="small" variant="outlined" prepend-icon="mdi-download">{{ $t('common.export') }}</v-btn>
                </template>
                <v-list density="compact">
                  <v-list-subheader>{{ $t('invoicing.exportSupplierSheet') }}</v-list-subheader>
                  <v-list-item prepend-icon="mdi-file-excel" title="Excel" @click="exportGroup(group, 'supplier', 'xlsx')" />
                  <v-list-item prepend-icon="mdi-file-pdf-box" title="PDF" @click="exportGroup(group, 'supplier', 'pdf')" />
                  <v-divider />
                  <v-list-subheader>{{ $t('invoicing.exportInternalSheet') }}</v-list-subheader>
                  <v-list-item prepend-icon="mdi-file-excel" title="Excel" @click="exportGroup(group, 'internal', 'xlsx')" />
                  <v-list-item prepend-icon="mdi-file-pdf-box" title="PDF" @click="exportGroup(group, 'internal', 'pdf')" />
                </v-list>
              </v-menu>
              <v-btn v-if="!readonly" icon="mdi-close" size="small" variant="text" color="error" :title="$t('common.remove')" :aria-label="$t('common.remove')" @click="removeGroup(gi)" />
            </v-card-title>
            <v-divider />
            <v-card-text class="pa-2">
              <div style="overflow-x: auto">
                <v-table density="compact">
                  <thead>
                    <tr>
                      <th style="width: 34%; min-width: 240px">{{ $t('common.description') }}</th>
                      <th class="text-end" style="width: 110px">{{ $t('invoicing.qty') }}</th>
                      <th style="width: 100px">{{ $t('invoicing.unit') }}</th>
                      <th class="text-end" style="width: 130px">{{ $t('invoicing.expectedPrice') }}</th>
                      <th v-if="isEdit" class="text-end" style="width: 100px">{{ $t('invoicing.receivedQty') }}</th>
                      <th style="min-width: 220px">{{ $t('invoicing.allocations') }}</th>
                      <th style="width: 40px"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="(line, li) in group.lines" :key="line._id || li">
                      <tr>
                        <td>
                          <ProductLineDescription
                            :description="line.description"
                            :product-id="line.productId"
                            price-field="purchasePrice"
                            @update:description="line.description = $event"
                            @update:product-id="line.productId = $event"
                            @product-selected="onProductSelected(line, $event)"
                            @product-cleared="line.productId = undefined"
                          />
                        </td>
                        <td>
                          <v-text-field v-model.number="line.quantity" type="number" min="0" density="compact" hide-details variant="underlined" style="min-width: 100px" :readonly="readonly" />
                        </td>
                        <td>
                          <v-autocomplete v-model="line.unit" :items="uomOptions" item-title="title" item-value="value" density="compact" hide-details variant="underlined" :readonly="readonly">
                            <template #selection="{ item }">{{ item.raw.short }}</template>
                            <template #item="{ item, props: ip }">
                              <v-list-item v-bind="ip" :title="item.raw.short" :subtitle="item.raw.full" />
                            </template>
                          </v-autocomplete>
                        </td>
                        <td>
                          <v-text-field v-model.number="line.expectedUnitPrice" type="number" step="0.0001" min="0" density="compact" hide-details variant="underlined" style="min-width: 110px" :readonly="readonly" />
                        </td>
                        <td v-if="isEdit" class="text-end" style="white-space: nowrap">
                          <span :class="(line.receivedQuantity || 0) >= line.quantity && line.quantity > 0 ? 'text-success' : ''">
                            {{ line.receivedQuantity || 0 }}
                          </span>
                        </td>
                        <td>
                          <div class="d-flex align-center ga-1 flex-wrap">
                            <v-chip
                              v-for="(alloc, ai) in line.allocations"
                              :key="ai"
                              size="x-small"
                              variant="tonal"
                              :color="allocReserved(alloc) > 0 ? 'primary' : undefined"
                            >
                              {{ warehouseName(alloc.warehouseId) }}: {{ alloc.quantity }}<span v-if="allocReserved(alloc)"> ({{ allocReserved(alloc) }}R)</span>
                            </v-chip>
                            <v-chip v-if="unallocated(line) > 0" size="x-small" variant="outlined">+{{ unallocated(line) }}</v-chip>
                            <v-btn
                              :icon="line._expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                              size="x-small"
                              variant="text"
                              :title="$t('invoicing.allocations')"
                              :aria-label="$t('invoicing.allocations')"
                              @click="line._expanded = !line._expanded"
                            />
                          </div>
                        </td>
                        <td>
                          <v-btn v-if="!readonly" icon="mdi-close" size="x-small" variant="text" tabindex="-1" :title="$t('common.remove')" :aria-label="$t('common.remove')" @click="group.lines.splice(li, 1)" />
                        </td>
                      </tr>
                      <!-- Allocation editor -->
                      <tr v-if="line._expanded">
                        <td :colspan="isEdit ? 7 : 6" class="pa-0">
                          <v-sheet color="surface" class="pa-3" style="border-left: 3px solid rgb(var(--v-theme-primary))">
                            <div v-for="(alloc, ai) in line.allocations" :key="ai" class="mb-2">
                              <div class="d-flex align-center ga-2 flex-wrap">
                                <v-autocomplete
                                  v-model="alloc.warehouseId"
                                  :items="warehouses"
                                  item-title="name"
                                  item-value="_id"
                                  :label="$t('warehouse.warehouse')"
                                  density="compact"
                                  hide-details
                                  style="max-width: 220px; min-width: 180px"
                                  :readonly="readonly"
                                />
                                <v-text-field v-model.number="alloc.quantity" type="number" min="0" :label="$t('invoicing.qty')" density="compact" hide-details style="max-width: 110px" :readonly="readonly" />
                                <v-chip v-if="isEdit" size="x-small" variant="tonal" :color="(alloc.receivedQuantity || 0) > 0 ? 'success' : undefined">
                                  {{ $t('invoicing.receivedQty') }}: {{ alloc.receivedQuantity || 0 }}
                                </v-chip>
                                <v-chip size="x-small" variant="tonal">
                                  {{ $t('invoicing.freeQty') }}: {{ allocFree(alloc) }}
                                </v-chip>
                                <v-btn v-if="!readonly" icon="mdi-close" size="x-small" variant="text" color="error" :title="$t('common.remove')" :aria-label="$t('common.remove')" @click="line.allocations.splice(ai, 1)" />
                              </div>
                              <!-- Reservations -->
                              <div class="ml-6 mt-1">
                                <div v-for="(res, ri) in alloc.reservations" :key="ri" class="d-flex align-center ga-2 mb-1 flex-wrap">
                                  <v-icon size="16" color="primary">mdi-account-lock-outline</v-icon>
                                  <v-autocomplete
                                    v-model="res.contactId"
                                    :items="clientOptions"
                                    item-title="companyName"
                                    item-value="_id"
                                    :label="$t('invoicing.customer')"
                                    density="compact"
                                    hide-details
                                    no-filter
                                    style="max-width: 260px; min-width: 200px"
                                    :readonly="readonly"
                                    :loading="loadingContacts"
                                    @update:search="(s: string) => onContactSearch(s, 'client')"
                                  />
                                  <v-text-field v-model.number="res.quantity" type="number" min="0" :label="$t('invoicing.qty')" density="compact" hide-details style="max-width: 110px" :readonly="readonly" />
                                  <v-chip v-if="isEdit && (res.invoicedQuantity || 0) > 0" size="x-small" color="success" variant="tonal">
                                    {{ $t('invoicing.status.converted') }}: {{ res.invoicedQuantity }}
                                  </v-chip>
                                  <v-btn v-if="!readonly" icon="mdi-close" size="x-small" variant="text" :title="$t('common.remove')" :aria-label="$t('common.remove')" @click="alloc.reservations.splice(ri, 1)" />
                                </div>
                                <v-btn v-if="!readonly" size="x-small" variant="text" prepend-icon="mdi-account-plus-outline" @click="alloc.reservations.push(emptyReservation())">
                                  {{ $t('invoicing.addReservation') }}
                                </v-btn>
                                <span v-if="overReserved(alloc)" class="text-error text-caption ml-2">{{ $t('invoicing.overReserved') }}</span>
                              </div>
                            </div>
                            <v-btn v-if="!readonly" size="small" variant="outlined" prepend-icon="mdi-warehouse" @click="line.allocations.push(emptyAllocation())">
                              {{ $t('invoicing.addAllocation') }}
                            </v-btn>
                            <span v-if="overAllocated(line)" class="text-error text-caption ml-2">{{ $t('invoicing.overAllocated') }}</span>
                          </v-sheet>
                        </td>
                      </tr>
                    </template>
                  </tbody>
                </v-table>
              </div>
              <v-btn v-if="!readonly" color="primary" variant="text" size="small" prepend-icon="mdi-plus" class="mt-1" @click="group.lines.push(emptyLine())">
                {{ $t('invoicing.addLine') }}
              </v-btn>
            </v-card-text>
          </v-card>
        </div>

        <v-btn v-if="!readonly" color="primary" variant="outlined" prepend-icon="mdi-factory" class="mt-4" @click="addGroup">
          {{ $t('invoicing.addSupplier') }}
        </v-btn>

        <!-- Notes / terms / tags -->
        <v-row class="mt-4">
          <v-col cols="12" md="6">
            <v-textarea v-model="form.notes" :label="$t('common.notes')" rows="2" auto-grow :readonly="readonly" />
            <v-textarea v-model="form.terms" :label="$t('invoicing.terms')" rows="2" auto-grow :readonly="readonly" />
            <TagInput v-model="form.tags" type="order" :org-url="orgUrl()" class="mt-2" />
          </v-col>
          <v-col cols="12" md="6">
            <v-card variant="outlined">
              <v-card-text>
                <div class="d-flex justify-space-between mb-2">
                  <span>{{ $t('invoicing.orderedQty') }}</span>
                  <span class="font-weight-medium">{{ totalOrdered }}</span>
                </div>
                <div class="d-flex justify-space-between mb-2">
                  <span>{{ $t('invoicing.reservedQty') }}</span>
                  <span>{{ totalReserved }}</span>
                </div>
                <div v-if="isEdit" class="d-flex justify-space-between mb-2">
                  <span>{{ $t('invoicing.receivedQty') }}</span>
                  <span>{{ totalReceived }}</span>
                </div>
                <v-divider class="my-2" />
                <div class="d-flex justify-space-between text-h6">
                  <span>{{ $t('invoicing.estimatedTotal') }}</span>
                  <span>{{ fmtCurrency(estimatedTotal) }}</span>
                </div>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>
      </v-defaults-provider>
    </v-form>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" entity-type="order" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>

    <!-- Convert-to-invoices dialog -->
    <v-dialog v-model="convertDialog" max-width="560">
      <v-card>
        <v-card-title>{{ $t('invoicing.convertToInvoices') }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 text-medium-emphasis mb-3">{{ $t('invoicing.orderConvertHint') }}</p>
          <v-list density="compact">
            <v-list-item v-for="c in convertibleClients" :key="c.contactId">
              <v-list-item-title>{{ c.name }}</v-list-item-title>
              <v-list-item-subtitle>{{ $t('invoicing.openReservedQty') }}: {{ c.open }}</v-list-item-subtitle>
              <template #append>
                <v-btn size="small" color="primary" variant="flat" :loading="convertingId === c.contactId" @click="convertFor(c.contactId)">
                  {{ $t('invoicing.convertToInvoice') }}
                </v-btn>
              </template>
            </v-list-item>
            <v-list-item v-if="!convertibleClients.length">
              <v-list-item-title class="text-medium-emphasis">{{ $t('invoicing.noOpenReservations') }}</v-list-item-title>
            </v-list-item>
          </v-list>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="convertDialog = false">{{ $t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { useProductUnits } from 'ui-shared/composables/useProductUnits'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { triggerBlobDownload } from 'ui-shared/composables/useInvoicingExport'
import EntityFormShell, { type FormAction, type StatusDef } from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import TagInput from 'ui-shared/components/TagInput.vue'
import ProductLineDescription from '../components/ProductLineDescription.vue'

interface ResRow { _id?: string; contactId: string; quantity: number; invoicedQuantity?: number; dispatchedQuantity?: number }
interface AllocRow { _id?: string; warehouseId: string; quantity: number; receivedQuantity?: number; reservations: ResRow[] }
interface LineRow {
  _id?: string
  productId?: string
  description: string
  sku?: string
  quantity: number
  unit: string
  expectedUnitPrice?: number
  taxRate?: number
  receivedQuantity?: number
  allocations: AllocRow[]
  _expanded?: boolean
}
interface GroupRow { _id?: string; supplierId: string; reference?: string; notes?: string; lines: LineRow[] }

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const { uomOptions } = useProductUnits()

const isEdit = computed(() => !!route.params.id)
const formRef = ref<any>()
const loading = ref(false)
const orderStatus = ref('draft')
const orderNumber = ref('')
const peekedNumber = ref('')
const documentNumber = computed(() => orderNumber.value || peekedNumber.value)
const readonly = computed(() => ['completed', 'cancelled'].includes(orderStatus.value))

const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => (({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' } as Record<string, string>)[appStore.locale] || 'en-US'))
const currencyOptions = computed(() => [...new Set([baseCurrency.value, 'EUR', 'BGN', 'USD', 'GBP'])])
const rules = { required: (v: string) => !!v || t('validation.required') }

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }
function fmtCurrency(amount: number) { return formatCurrency(amount, form.currency || baseCurrency.value, localeCode.value) }

function emptyReservation(): ResRow { return { contactId: '', quantity: 0 } }
function emptyAllocation(): AllocRow { return { warehouseId: '', quantity: 0, reservations: [] } }
function emptyLine(): LineRow { return { description: '', quantity: 0, unit: 'pcs', allocations: [], _expanded: false } }
function emptyGroup(): GroupRow { return { supplierId: '', reference: '', lines: [emptyLine()] } }

const form = reactive({
  issueDate: new Date().toISOString().split('T')[0],
  expectedDate: '',
  currency: baseCurrency.value,
  exchangeRate: 1,
  notes: '',
  terms: '',
  tags: [] as string[],
  supplierGroups: [emptyGroup()] as GroupRow[],
})

// ── contacts (server-searched pools) + warehouses ──
const supplierOptions = ref<any[]>([])
const clientOptions = ref<any[]>([])
const loadingContacts = ref(false)
const warehouses = ref<Array<{ _id: string; name: string }>>([])
const contactNames = ref<Record<string, string>>({})

let contactSearchTimer: ReturnType<typeof setTimeout> | null = null
function onContactSearch(text: string, pool: 'supplier' | 'client') {
  if (contactSearchTimer) clearTimeout(contactSearchTimer)
  contactSearchTimer = setTimeout(() => fetchContacts(pool, text || undefined), 300)
}

async function fetchContacts(pool: 'supplier' | 'client', search?: string) {
  loadingContacts.value = true
  try {
    const params: Record<string, any> = { size: 20 }
    if (pool === 'supplier') params.type = 'supplier'
    if (search) params.search = search
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact`, { params })
    const items = data.contacts || []
    // Keep already-selected ids resolvable by merging known entries in.
    const known = knownOptionEntries(pool)
    const merged = [...items]
    for (const k of known) if (!merged.some((c: any) => c._id === k._id)) merged.push(k)
    if (pool === 'supplier') supplierOptions.value = merged
    else clientOptions.value = merged
    for (const c of items) contactNames.value[c._id] = c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ')
  } catch { /* */ } finally {
    loadingContacts.value = false
  }
}

function knownOptionEntries(pool: 'supplier' | 'client') {
  const ids = new Set<string>()
  for (const g of form.supplierGroups) {
    if (pool === 'supplier' && g.supplierId) ids.add(g.supplierId)
    if (pool === 'client')
      for (const l of g.lines) for (const a of l.allocations) for (const r of a.reservations) if (r.contactId) ids.add(r.contactId)
  }
  return [...ids].filter((id) => contactNames.value[id]).map((id) => ({ _id: id, companyName: contactNames.value[id] }))
}

async function fetchWarehouses() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`, { params: { size: 1000 } })
    warehouses.value = data.warehouses || []
  } catch { /* */ }
}
function warehouseName(id: string) { return warehouses.value.find((w) => w._id === id)?.name || '—' }

// ── line helpers ──
function onProductSelected(line: LineRow, product: any) {
  line.unit = product.unit || line.unit
  line.sku = product.sku
  if (!line.expectedUnitPrice) line.expectedUnitPrice = product.purchasePrice || undefined
  if (!line.quantity) line.quantity = 1
}
function allocReserved(alloc: AllocRow) { return alloc.reservations.reduce((s, r) => s + (Number(r.quantity) || 0), 0) }
function allocFree(alloc: AllocRow) { return Math.max(0, (Number(alloc.quantity) || 0) - allocReserved(alloc)) }
function overReserved(alloc: AllocRow) { return allocReserved(alloc) > (Number(alloc.quantity) || 0) }
function allocatedQty(line: LineRow) { return line.allocations.reduce((s, a) => s + (Number(a.quantity) || 0), 0) }
function unallocated(line: LineRow) { return Math.max(0, (Number(line.quantity) || 0) - allocatedQty(line)) }
function overAllocated(line: LineRow) { return allocatedQty(line) > (Number(line.quantity) || 0) }

function addGroup() { form.supplierGroups.push(emptyGroup()) }
function removeGroup(gi: number) { form.supplierGroups.splice(gi, 1) }

const totalOrdered = computed(() => form.supplierGroups.reduce((s, g) => s + g.lines.reduce((ls, l) => ls + (Number(l.quantity) || 0), 0), 0))
const totalReceived = computed(() => form.supplierGroups.reduce((s, g) => s + g.lines.reduce((ls, l) => ls + (Number(l.receivedQuantity) || 0), 0), 0))
const totalReserved = computed(() =>
  form.supplierGroups.reduce((s, g) => s + g.lines.reduce((ls, l) => ls + l.allocations.reduce((as_, a) => as_ + allocReserved(a), 0), 0), 0),
)
const estimatedTotal = computed(() =>
  form.supplierGroups.reduce((s, g) => s + g.lines.reduce((ls, l) => ls + (Number(l.quantity) || 0) * (Number(l.expectedUnitPrice) || 0), 0), 0),
)

// ── status pipeline + actions ──
const statusDef = computed<StatusDef | undefined>(() => ({
  steps: ['invoicing.status.draft', 'invoicing.status.sent', 'invoicing.status.received', 'invoicing.status.completed'],
  current: `invoicing.status.${orderStatus.value === 'partially_received' ? 'sent' : orderStatus.value}`,
  colors: orderStatus.value === 'cancelled' ? { [`invoicing.status.cancelled`]: 'error' } : undefined,
}))

const saving = ref(false)
const formActions = computed<FormAction[]>(() => [
  { label: t('common.save'), icon: 'mdi-content-save', handler: onSave, loading: saving.value, show: !readonly.value },
  { label: t('invoicing.sendOrder'), icon: 'mdi-send', color: 'success', handler: sendOrder, show: isEdit.value && orderStatus.value === 'draft' },
  { label: t('invoicing.convertToInvoices'), icon: 'mdi-swap-horizontal', color: 'info', handler: () => { convertDialog.value = true }, show: isEdit.value && ['sent', 'partially_received', 'received'].includes(orderStatus.value) },
  { label: t('invoicing.completeOrder'), icon: 'mdi-check-all', variant: 'outlined', handler: completeOrder, show: isEdit.value && ['sent', 'partially_received', 'received'].includes(orderStatus.value) },
  { label: t('invoicing.cancelOrder'), icon: 'mdi-cancel', color: 'error', variant: 'outlined', handler: cancelOrder, show: isEdit.value && !readonly.value },
  { label: t('common.delete'), icon: 'mdi-delete', color: 'error', variant: 'text', handler: deleteOrder, show: isEdit.value && orderStatus.value === 'draft' },
])

// ── pending changes ──
const { markSaved, tryRestore } = usePendingChanges({
  appId: 'invoicing',
  entityType: 'order',
  icon: 'mdi-clipboard-list-outline',
  getFormData: () => JSON.parse(JSON.stringify(form)),
  getPreviewFields: () => [
    { label: 'Date', value: form.issueDate || '' },
    { label: 'Suppliers', value: String(form.supplierGroups.length) },
  ],
  setFormData: (data) => Object.assign(form, data),
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

// ── persistence ──
function buildPayload() {
  return {
    issueDate: form.issueDate,
    expectedDate: form.expectedDate || undefined,
    currency: form.currency,
    exchangeRate: form.exchangeRate || 1,
    notes: form.notes || undefined,
    terms: form.terms || undefined,
    tags: form.tags,
    supplierGroups: form.supplierGroups
      .filter((g) => g.supplierId)
      .map((g) => ({
        ...(g._id ? { _id: g._id } : {}),
        supplierId: g.supplierId,
        reference: g.reference || undefined,
        notes: g.notes || undefined,
        lines: g.lines
          .filter((l) => l.productId || (l.description || '').trim())
          .map((l) => ({
            ...(l._id ? { _id: l._id } : {}),
            productId: l.productId || undefined,
            description: l.description,
            sku: l.sku || undefined,
            quantity: Number(l.quantity) || 0,
            unit: l.unit || 'pcs',
            expectedUnitPrice: l.expectedUnitPrice !== undefined && l.expectedUnitPrice !== null ? Number(l.expectedUnitPrice) : undefined,
            taxRate: l.taxRate,
            allocations: l.allocations
              .filter((a) => a.warehouseId)
              .map((a) => ({
                ...(a._id ? { _id: a._id } : {}),
                warehouseId: a.warehouseId,
                quantity: Number(a.quantity) || 0,
                reservations: a.reservations
                  .filter((r) => r.contactId && (Number(r.quantity) || 0) > 0)
                  .map((r) => ({
                    ...(r._id ? { _id: r._id } : {}),
                    contactId: r.contactId,
                    quantity: Number(r.quantity) || 0,
                  })),
              })),
          })),
      })),
  }
}

async function onSave() {
  const { valid } = (await formRef.value?.validate()) || { valid: true }
  if (!valid) return
  saving.value = true
  try {
    if (isEdit.value) {
      await httpClient.put(`${orgUrl()}/invoicing/orders/${route.params.id}`, buildPayload())
      showSuccess(t('common.savedSuccessfully'))
      markSaved()
      await loadOrder()
    } else {
      const { data } = await httpClient.post(`${orgUrl()}/invoicing/orders`, buildPayload())
      showSuccess(t('common.savedSuccessfully'))
      markSaved()
      router.replace({ name: 'invoicing.orders.edit', params: { id: data.order._id } })
      orderNumber.value = data.order.orderNumber
      orderStatus.value = data.order.status
      await loadOrder(data.order._id)
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

async function doAction(path: string, successKey: string) {
  loading.value = true
  try {
    await httpClient.post(`${orgUrl()}/invoicing/orders/${route.params.id}/${path}`)
    showSuccess(t(successKey))
    await loadOrder()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}
function sendOrder() { doAction('send', 'invoicing.orderSent') }
function completeOrder() { doAction('complete', 'invoicing.orderCompleted') }
function cancelOrder() { doAction('cancel', 'invoicing.orderCancelled') }

async function deleteOrder() {
  if (!confirm(t('invoicing.deleteOrderConfirm'))) return
  try {
    await httpClient.delete(`${orgUrl()}/invoicing/orders/${route.params.id}`)
    showSuccess(t('common.deletedSuccessfully'))
    router.push({ name: 'invoicing.orders' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

// ── conversion ──
const convertDialog = ref(false)
const convertingId = ref('')
const convertibleClients = computed(() => {
  const byClient = new Map<string, number>()
  for (const g of form.supplierGroups)
    for (const l of g.lines)
      for (const a of l.allocations)
        for (const r of a.reservations) {
          const open = (Number(r.quantity) || 0) - (Number(r.invoicedQuantity) || 0)
          if (r.contactId && open > 0) byClient.set(r.contactId, (byClient.get(r.contactId) || 0) + open)
        }
  return [...byClient.entries()].map(([contactId, open]) => ({
    contactId,
    open,
    name: contactNames.value[contactId] || contactId,
  }))
})

async function convertFor(contactId: string) {
  convertingId.value = contactId
  try {
    const { data } = await httpClient.post(`${orgUrl()}/invoicing/orders/${route.params.id}/convert`, { contactId })
    showSuccess(t('invoicing.invoiceCreatedFromOrder', { number: data.invoice.invoiceNumber }))
    await loadOrder()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    convertingId.value = ''
  }
}

// ── group exports (supplier / internal sheets) ──
async function exportGroup(group: GroupRow, variant: 'supplier' | 'internal', format: 'xlsx' | 'pdf') {
  try {
    const res = await httpClient.get(`${orgUrl()}/invoicing/orders/${route.params.id}/export`, {
      params: { groupId: group._id, variant, format, locale: appStore.locale },
      responseType: 'blob',
    })
    triggerBlobDownload(res.data, `${orderNumber.value || 'order'}-${variant}.${format}`)
  } catch (e: any) {
    showError(e?.response?.data?.message || t('export.failed'))
  }
}

// ── loading ──
async function loadOrder(id?: string) {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/orders/${id || route.params.id}`)
    const o = data.order
    orderStatus.value = o.status
    orderNumber.value = o.orderNumber
    form.issueDate = o.issueDate?.split('T')[0] || ''
    form.expectedDate = o.expectedDate?.split('T')[0] || ''
    form.currency = o.currency || baseCurrency.value
    form.exchangeRate = o.exchangeRate || 1
    form.notes = o.notes || ''
    form.terms = o.terms || ''
    form.tags = o.tags || []
    form.supplierGroups = (o.supplierGroups || []).map((g: any) => ({
      _id: g._id,
      supplierId: g.supplierId,
      reference: g.reference || '',
      notes: g.notes || '',
      lines: (g.lines || []).map((l: any) => ({
        _id: l._id,
        productId: l.productId || undefined,
        description: l.description || '',
        sku: l.sku,
        quantity: l.quantity || 0,
        unit: l.unit || 'pcs',
        expectedUnitPrice: l.expectedUnitPrice,
        taxRate: l.taxRate,
        receivedQuantity: l.receivedQuantity || 0,
        _expanded: false,
        allocations: (l.allocations || []).map((a: any) => ({
          _id: a._id,
          warehouseId: a.warehouseId,
          quantity: a.quantity || 0,
          receivedQuantity: a.receivedQuantity || 0,
          reservations: (a.reservations || []).map((r: any) => ({
            _id: r._id,
            contactId: r.contactId,
            quantity: r.quantity || 0,
            invoicedQuantity: r.invoicedQuantity || 0,
            dispatchedQuantity: r.dispatchedQuantity || 0,
          })),
        })),
      })),
    }))
    // Names for suppliers / reservation clients / warehouses come with the response.
    if (data.lookup?.contacts) Object.assign(contactNames.value, data.lookup.contacts)
    // Refresh the option pools so selected ids render their names.
    supplierOptions.value = mergeKnown(supplierOptions.value, 'supplier')
    clientOptions.value = mergeKnown(clientOptions.value, 'client')
  } catch {
    showError(t('common.operationFailed'))
  }
}

function mergeKnown(list: any[], pool: 'supplier' | 'client') {
  const merged = [...list]
  for (const k of knownOptionEntries(pool)) if (!merged.some((c) => c._id === k._id)) merged.push(k)
  return merged
}

async function fetchPeekedNumber() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/orders/peek-next`)
    peekedNumber.value = data.next || ''
  } catch { /* */ }
}

onMounted(async () => {
  await Promise.all([fetchContacts('supplier'), fetchContacts('client'), fetchWarehouses()])
  if (tryRestore()) return
  if (isEdit.value) await loadOrder()
  else fetchPeekedNumber()
})
</script>
