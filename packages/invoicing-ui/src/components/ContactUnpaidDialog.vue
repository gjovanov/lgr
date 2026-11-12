<template>
  <v-dialog :model-value="modelValue" max-width="1100" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon class="mr-2">mdi-cash</v-icon>
        {{ $t('invoicing.openBalance') }}
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" @click="emit('update:modelValue', false)" />
      </v-card-title>

      <v-card-text>
        <v-data-table
          :headers="headers"
          :items="documents"
          :loading="loading"
          :items-per-page="25"
          density="compact"
          hover
          data-testid="contact-unpaid"
        >
          <template #item.invoiceNumber="{ item }">
            <entity-link :label="item.invoiceNumber || ''" :href="documentHref(item)" />
          </template>
          <template #item.type="{ item }">
            <v-chip size="x-small" label :color="typeColor(item)">{{ typeLabel(item) }}</v-chip>
          </template>
          <template #item.issueDate="{ item }">{{ day(item.issueDate) }}</template>
          <template #item.dueDate="{ item }">{{ day(item.dueDate) }}</template>
          <template #item.status="{ item }"><StatusChip :status="item.status" /></template>
          <template #item.total="{ item }">{{ money(item.total, item) }}</template>
          <template #item.amountPaid="{ item }">{{ money(item.amountPaid, item) }}</template>
          <template #item.due="{ item }"><strong>{{ money(item.due, item) }}</strong></template>
        </v-data-table>

        <!-- The figure on the button: these rows added up, a credit note's taken off. -->
        <div v-if="!refused" class="d-flex justify-end align-center mt-3 text-subtitle-1" data-testid="contact-unpaid-total">
          <span class="mr-3">{{ $t('invoicing.openBalance') }}</span>
          <strong>{{ balanceLabel }}</strong>
        </div>
        <p v-if="count > documents.length" class="text-caption text-medium-emphasis mt-1 mb-0 text-right" data-testid="contact-unpaid-capped">
          {{ $t('invoicing.unpaidListCapped', { shown: documents.length, total: count }) }}
        </p>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn @click="emit('update:modelValue', false)">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import EntityLink from 'ui-shared/components/EntityLink'
import StatusChip from 'ui-shared/components/StatusChip'

/**
 * The documents behind the contact form's Open Balance button: what the contact still owes, document by document,
 * the longest due first. The server reads them with the summary's own reader (`GET /invoicing/contact/:id/unpaid`),
 * so the rows add up to the figure on the button.
 *
 * The button used to open the contact's ledger, whose "Balance" is sales less purchases: another figure.
 */
interface UnpaidDocument {
  _id: string
  type: string
  direction?: string
  invoiceNumber?: string
  issueDate?: string
  dueDate?: string
  status: string
  currency?: string
  total: number
  amountPaid: number
  due: number
}

const props = defineProps<{
  modelValue: boolean
  contactId: string
  orgUrl: string
  /** The currency a figure is shown in when its document names none. */
  baseCurrency?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const { t } = useI18n()
const { formatCurrency } = useCurrency()

const documents = ref<UnpaidDocument[]>([])
const count = ref(0)
const openBalance = ref<number | null>(0)
const currency = ref<string | null>(null)
const loading = ref(false)
/** The list could not be read (the documents are not part of the role): then no figure of its own either. */
const refused = ref(false)

const WHOLE = { cellProps: { class: 'text-no-wrap' } }
const headers = computed(() => [
  { title: t('invoicing.invoiceNumber'), key: 'invoiceNumber', sortable: false, ...WHOLE },
  { title: t('common.type'), key: 'type', sortable: false },
  { title: t('invoicing.issueDate'), key: 'issueDate', sortable: false, ...WHOLE },
  { title: t('invoicing.dueDate'), key: 'dueDate', sortable: false, ...WHOLE },
  { title: t('common.status'), key: 'status', sortable: false },
  { title: t('common.total'), key: 'total', sortable: false, align: 'end' as const, ...WHOLE },
  { title: t('invoicing.amountPaid'), key: 'amountPaid', sortable: false, align: 'end' as const, ...WHOLE },
  { title: t('invoicing.amountDue'), key: 'due', sortable: false, align: 'end' as const, ...WHOLE },
])

const day = (d?: string) => (d ? String(d).split('T')[0] : '')
const money = (amount: number, doc: UnpaidDocument) => formatCurrency(amount || 0, doc.currency || props.baseCurrency || 'EUR')
/** As the button says it: no figure when the documents are in several currencies. */
const balanceLabel = computed(() =>
  openBalance.value == null ? '—' : formatCurrency(openBalance.value, currency.value || props.baseCurrency || 'EUR'))

const isBill = (doc: UnpaidDocument) => doc.direction === 'incoming'

/** A supplier's invoice is named as the menus name it; any other document by its type. */
function typeLabel(doc: UnpaidDocument): string {
  if (isBill(doc) && doc.type === 'invoice') return t('nav.newDoc.bill')
  return t(`invoicing.docType.${doc.type}`, doc.type)
}

/** The ledger's colours; a supplier's document in grey-blue, apart from what the contact owes us. */
function typeColor(doc: UnpaidDocument): string {
  if (isBill(doc)) return 'blue-grey'
  return ({ invoice: 'primary', cash_sale: 'success', credit_note: 'warning', debit_note: 'error' }[doc.type] || 'grey')
}

/** Where the document opens: notes live in the sales form (FR-01), a supplier's document in the bills form. */
function documentHref(doc: UnpaidDocument): string | undefined {
  if (isBill(doc)) return `/invoicing/bills/${doc._id}/edit`
  const path = ({ invoice: 'invoices', credit_note: 'invoices', debit_note: 'invoices', cash_sale: 'cash-sales' } as Record<string, string>)[doc.type]
  return path ? `/invoicing/${path}/${doc._id}/edit` : undefined
}

async function fetch() {
  if (!props.contactId) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${props.orgUrl}/invoicing/contact/${props.contactId}/unpaid`)
    documents.value = data.documents || []
    count.value = data.count || 0
    openBalance.value = data.mixedCurrency ? null : (data.openBalance ?? 0)
    currency.value = data.currency || null
    refused.value = false
  } catch {
    documents.value = []
    count.value = 0
    openBalance.value = 0
    currency.value = null
    refused.value = true
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, (open) => { if (open) fetch() })
</script>
