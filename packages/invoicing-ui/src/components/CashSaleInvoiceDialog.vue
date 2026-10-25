<template>
  <v-dialog :model-value="modelValue" max-width="860" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card>
      <v-card-title class="d-flex align-center ga-2">
        <v-icon color="primary">mdi-file-document-plus-outline</v-icon>
        {{ $t('invoicing.cashSaleInvoice.title', { number: state?.cashSale.number || '' }) }}
      </v-card-title>
      <v-divider />

      <v-card-text v-if="loadingState" class="d-flex justify-center pa-8">
        <v-progress-circular indeterminate color="primary" />
      </v-card-text>

      <v-card-text v-else-if="state">
        <v-alert v-if="!state.canInvoice" type="info" variant="tonal" density="compact" class="mb-3">
          {{ state.reason }}
        </v-alert>
        <v-alert v-else type="info" variant="tonal" density="compact" class="mb-3" icon="mdi-information-outline">
          {{ $t('invoicing.cashSaleInvoice.noStockNote') }}
        </v-alert>

        <div v-if="state.invoices.length" class="mb-3">
          <div class="text-caption text-medium-emphasis mb-1">{{ $t('invoicing.cashSaleInvoice.existing') }}</div>
          <div class="d-flex flex-wrap ga-1">
            <v-chip
              v-for="inv in state.invoices"
              :key="inv.id"
              size="small"
              variant="tonal"
              color="primary"
              prepend-icon="mdi-file-document-outline"
              :to="{ name: 'invoicing.sales.edit', params: { id: inv.id } }"
            >
              {{ inv.number }}
            </v-chip>
          </div>
        </div>

        <template v-if="state.canInvoice">
          <v-row dense>
            <v-col cols="12" md="8">
              <div class="d-flex align-center ga-1">
                <ContactAutocompleteWithCreate
                  v-model="contactId"
                  :contacts="contacts"
                  :label="$t('invoicing.customer')"
                  required
                  :loading="loadingContacts"
                  class="flex-grow-1"
                  @update:search="onContactSearch"
                  @contact-created="onContactCreated"
                />
                <v-btn
                  icon="mdi-magnify-expand"
                  size="small"
                  variant="text"
                  :title="$t('invoicing.searchContact')"
                  :aria-label="$t('invoicing.searchContact')"
                  @click="pickerOpen = true"
                />
              </div>
            </v-col>
            <v-col cols="12" md="4">
              <DateField v-model="issueDate" :label="$t('invoicing.issueDate')" />
            </v-col>
          </v-row>
          <v-alert v-if="daysAfterSale > 5" type="warning" variant="tonal" density="compact" class="mb-2">
            {{ $t('invoicing.cashSaleInvoice.lateWarning', { days: daysAfterSale }) }}
          </v-alert>

          <div class="text-caption text-medium-emphasis mb-1">
            {{ state.wholeOnly ? $t('invoicing.cashSaleInvoice.wholeOnly') : $t('invoicing.cashSaleInvoice.partialHint') }}
          </div>
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ $t('common.description') }}</th>
                <th class="text-end">{{ $t('invoicing.cashSaleInvoice.sold') }}</th>
                <th class="text-end">{{ $t('invoicing.cashSaleInvoice.invoiced') }}</th>
                <th class="text-end" style="width: 120px">{{ $t('invoicing.qty') }}</th>
                <th class="text-end">{{ $t('invoicing.unitPrice') }}</th>
                <th class="text-end">{{ $t('invoicing.taxRate') }}</th>
                <th class="text-end">{{ $t('common.total') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.lineId" :class="row.remaining <= 0 ? 'text-disabled' : ''">
                <td>{{ row.description }}</td>
                <td class="text-end text-no-wrap">{{ row.quantity }} {{ row.unit }}</td>
                <td class="text-end">{{ row.invoiced || '—' }}</td>
                <td class="text-end">
                  <v-text-field
                    v-if="!state.wholeOnly && row.remaining > 0"
                    v-model.number="row.take"
                    type="number"
                    :min="0"
                    :max="row.remaining"
                    density="compact"
                    variant="outlined"
                    hide-details
                    class="text-end"
                    :aria-label="$t('invoicing.qty')"
                  />
                  <span v-else>{{ row.take }}</span>
                </td>
                <td class="text-end">{{ fmt(row.unitPrice) }}</td>
                <td class="text-end">{{ row.taxRate }}%</td>
                <td class="text-end text-no-wrap">{{ fmt(lineTotal(row)) }}</td>
              </tr>
            </tbody>
          </v-table>
          <div class="d-flex justify-end mt-3">
            <div style="min-width: 260px">
              <div class="d-flex justify-space-between text-body-2">
                <span>{{ $t('common.subtotal') }}</span><span>{{ fmt(totals.subtotal) }}</span>
              </div>
              <div class="d-flex justify-space-between text-body-2">
                <span>{{ $t('invoicing.tax') }}</span><span>{{ fmt(totals.taxTotal) }}</span>
              </div>
              <div class="d-flex justify-space-between text-h6 font-weight-bold">
                <span>{{ $t('common.total') }}</span><span>{{ fmt(totals.total) }}</span>
              </div>
            </div>
          </div>
        </template>
      </v-card-text>

      <v-divider />
      <v-card-actions>
        <v-spacer />
        <v-btn @click="emit('update:modelValue', false)">{{ state?.canInvoice ? $t('common.cancel') : $t('common.close') }}</v-btn>
        <template v-if="state?.canInvoice">
          <v-btn variant="outlined" :loading="saving === 'draft'" :disabled="!canSubmit || !!saving" @click="submit(false)">
            {{ $t('invoicing.cashSaleInvoice.saveDraft') }}
          </v-btn>
          <v-btn color="primary" variant="flat" prepend-icon="mdi-file-document-check-outline" :loading="saving === 'issue'" :disabled="!canSubmit || !!saving" @click="submit(true)">
            {{ $t('invoicing.cashSaleInvoice.action') }}
          </v-btn>
        </template>
      </v-card-actions>
    </v-card>

    <ContactPickerDialog v-model="pickerOpen" :org-url="appStore.orgUrl()" type="customer" @select="onContactPicked" />
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { createIdempotentAction } from 'ui-shared/composables/idempotency'
import DateField from 'ui-shared/components/DateField.vue'
import ContactPickerDialog from 'ui-shared/components/ContactPickerDialog'
import ContactAutocompleteWithCreate from './ContactAutocompleteWithCreate.vue'
import { useAppStore } from '../store/app.store'

/**
 * „Издай фактура" on a cash sale (#171): the customer, the date and — for a sale without a
 * customer — which lines and how much. The server decides everything that matters (the lines'
 * prices, the totals, that the invoice moves no stock and is paid); this only asks.
 */
const props = defineProps<{ modelValue: boolean; cashSaleId: string }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'issued': [invoice: any]
}>()

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()

interface StateLine {
  lineId: string; description: string; unit: string; quantity: number; invoiced: number; remaining: number
  unitPrice: number; discount: number; taxRate: number
}
interface Row extends StateLine { take: number }

const state = ref<any>(null)
const loadingState = ref(false)
const rows = ref<Row[]>([])
const contactId = ref('')
const issueDate = ref(today())
const saving = ref<'' | 'issue' | 'draft'>('')
// One key per opening of the dialog: a double click or a retried request issues one invoice.
let attempt = createIdempotentAction()

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' } as Record<string, string>)[appStore.locale] || 'en-US')
function fmt(v: number) {
  return formatCurrency(v, state.value?.cashSale.currency || 'EUR', localeCode.value)
}

const round2 = (v: number) => +(Number(v) || 0).toFixed(2)
function lineTotal(r: Row): number {
  const net = (Number(r.take) || 0) * r.unitPrice
  const taxable = net - net * (r.discount / 100)
  return round2(taxable * (1 + r.taxRate / 100))
}
/** The same arithmetic the server uses for a partial invoice (`invoiceTotalsOf`). */
const totals = computed(() => {
  let subtotal = 0
  let discountTotal = 0
  let taxTotal = 0
  for (const r of rows.value) {
    const net = (Number(r.take) || 0) * r.unitPrice
    const disc = net * (r.discount / 100)
    subtotal += net
    discountTotal += disc
    taxTotal += (net - disc) * (r.taxRate / 100)
  }
  const s = round2(subtotal)
  const d = round2(discountTotal)
  const tx = round2(taxTotal)
  return { subtotal: s, discountTotal: d, taxTotal: tx, total: round2(s - d + tx) }
})

/** ЗДДС чл. 113, ал. 4: an invoice within 5 days of the tax event. A warning, never a block. */
const daysAfterSale = computed(() => {
  const sold = state.value?.cashSale.issueDate ? new Date(String(state.value.cashSale.issueDate).slice(0, 10)) : null
  if (!sold || !issueDate.value) return 0
  return Math.round((new Date(issueDate.value).getTime() - sold.getTime()) / 86_400_000)
})

const canSubmit = computed(() =>
  !!contactId.value && rows.value.some(r => (Number(r.take) || 0) > 0)
  && rows.value.every(r => (Number(r.take) || 0) >= 0 && (Number(r.take) || 0) <= r.remaining + 1e-9),
)

// ── customers (server-searched, as the invoice forms do) ──
const contacts = ref<any[]>([])
const loadingContacts = ref(false)
const pickerOpen = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null
async function fetchContacts(search?: string) {
  loadingContacts.value = true
  try {
    const params: Record<string, any> = { type: 'customer', size: 20 }
    if (search) params.search = search
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`, { params })
    const list = data.contacts || []
    const chosen = contacts.value.find(c => c._id === contactId.value)
    contacts.value = chosen && !list.some((c: any) => c._id === chosen._id) ? [chosen, ...list] : list
  } catch { /* */ } finally {
    loadingContacts.value = false
  }
}
function onContactSearch(text: string) {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => fetchContacts(text || undefined), 300)
}
function onContactCreated(c: any) {
  contacts.value = [c, ...contacts.value]
}
function onContactPicked(c: any) {
  const id = c?._id || c?.id
  if (!id) return
  if (!contacts.value.some(x => x._id === id)) contacts.value = [{ ...c, _id: id }, ...contacts.value]
  contactId.value = id
}
async function ensureContactLoaded(id: string) {
  if (!id || contacts.value.some(c => c._id === id)) return
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact/${id}`)
    if (data.contact) contacts.value = [data.contact, ...contacts.value]
  } catch { /* */ }
}

async function load() {
  loadingState.value = true
  state.value = null
  attempt = createIdempotentAction()
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoices/${props.cashSaleId}/to-invoice`)
    state.value = data.invoicing
    rows.value = (data.invoicing.lines as StateLine[])
      .filter(l => l.quantity > 0)
      .map(l => ({ ...l, take: l.remaining }))
    contactId.value = data.invoicing.cashSale.contactId || ''
    issueDate.value = today()
    await fetchContacts()
    if (contactId.value) await ensureContactLoaded(contactId.value)
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
    emit('update:modelValue', false)
  } finally {
    loadingState.value = false
  }
}

async function submit(issue: boolean) {
  saving.value = issue ? 'issue' : 'draft'
  const body: Record<string, any> = { contactId: contactId.value, issueDate: issueDate.value, issue, locale: appStore.locale }
  // A sale to a named customer is invoiced whole: the server takes every line.
  if (!state.value.wholeOnly) {
    body.lines = rows.value.filter(r => (Number(r.take) || 0) > 0).map(r => ({ lineId: r.lineId, quantity: Number(r.take) }))
  }
  try {
    const { data } = await attempt.run(body, headers =>
      httpClient.post(`${appStore.orgUrl()}/invoices/${props.cashSaleId}/to-invoice`, body, { headers }))
    showSuccess(issue
      ? t('invoicing.cashSaleInvoice.issued', { number: data.invoice.invoiceNumber })
      : t('invoicing.cashSaleInvoice.draftCreated', { number: data.invoice.invoiceNumber }))
    emit('issued', data.invoice)
    emit('update:modelValue', false)
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
    // A refusal can mean someone else invoiced part of the sale meanwhile: show the fresh state.
    if (e?.response?.status === 409) await load()
  } finally {
    saving.value = ''
  }
}

watch(() => props.modelValue, (open) => { if (open) load() }, { immediate: true })
</script>
