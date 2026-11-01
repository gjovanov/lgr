<template>
  <v-dialog :model-value="!!overlap" max-width="640" scrollable @update:model-value="onToggle">
    <v-card v-if="overlap" data-testid="receipt-overlap-dialog">
      <v-card-title class="d-flex align-center ga-2">
        <v-icon color="warning">mdi-alert-outline</v-icon>
        {{ $t('invoicing.receiptOverlap.title') }}
      </v-card-title>
      <v-card-text>
        <div class="text-body-2 mb-2">{{ $t('invoicing.receiptOverlap.text') }}</div>
        <v-list density="compact">
          <v-list-item v-for="r in overlap.receipts" :key="r.id" data-testid="receipt-overlap-row">
            <template #prepend>
              <v-checkbox-btn v-model="selected" :value="r.id" />
            </template>
            <v-list-item-title>
              <a :href="receiptHref(r.id)" target="_blank" rel="noopener" class="font-weight-medium">{{ r.number }}</a>
              · {{ String(r.date || '').slice(0, 10) }}
              <v-chip v-if="r.noSupplier" size="x-small" label class="ml-1" data-testid="receipt-no-supplier">{{ $t('invoicing.linkDelivery.noSupplier') }}</v-chip>
            </v-list-item-title>
            <v-list-item-subtitle>{{ $t('invoicing.linkDelivery.receiptLines', { n: r.lineCount }) }} · {{ formatCurrency(r.total, baseCurrency, locale) }}</v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-card-text>
      <v-alert v-if="overlap.typedLines" type="warning" variant="tonal" density="compact" class="mx-4 mt-2 flex-grow-0" data-testid="replace-lines-warning">
        {{ $t('invoicing.linkDelivery.replaceWarning', overlap.typedLines) }}
      </v-alert>
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mx-4 mt-2 flex-grow-0" data-testid="receipt-overlap-error">{{ error }}</v-alert>
      <v-card-actions class="flex-wrap">
        <v-spacer />
        <v-btn variant="text" :disabled="busy" @click="close">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="warning" variant="outlined" :loading="receiving" :disabled="linking" data-testid="receipt-overlap-receive" @click="receiveAnyway">
          {{ $t('invoicing.receiptOverlap.receiveAnyway') }}
        </v-btn>
        <v-btn color="primary" variant="flat" :loading="linking" :disabled="receiving || !selected.length" data-testid="receipt-overlap-link" @click="link">
          {{ $t('invoicing.receiptOverlap.link') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { stockRefusalMessage } from 'ui-shared/composables/stock-refusals'
import { appHref } from 'ui-shared/nav/navigate'
import type { ReceiptOverlap } from '../composables/receipt-overlap'

/**
 * FR-22.31c: a bill about to book goods that may already be in stock. The two ways out are linking
 * it to the delivery (the bill then moves nothing) and receiving it anyway, which stays on the audit
 * log. Linking stops short of receiving: the delivery's lines carry the receipt's costs, and the user
 * reads them against the supplier's paper first (D-2).
 */
const props = defineProps<{
  overlap: ReceiptOverlap | null
  orgUrl: string
  baseCurrency: string
  locale: string
}>()

const emit = defineEmits<{
  'update:overlap': [value: ReceiptOverlap | null]
  /** The bill was received anyway. */
  received: [invoice: any]
  /** The bill is linked to the delivery, still a draft. */
  linked: [billId: string]
}>()

const { t } = useI18n()
const { formatCurrency } = useCurrency()

const selected = ref<string[]>([])
const linking = ref(false)
const receiving = ref(false)
const error = ref('')
const busy = computed(() => linking.value || receiving.value)

watch(() => props.overlap, (o) => {
  error.value = ''
  // One candidate is chosen for the user, as „Свържи с доставка" does. Several are for them to pick.
  selected.value = o?.receipts.length === 1 ? [o.receipts[0].id] : []
})

const receiptHref = (id: string) => appHref('inventory', `/inventory/movements/${id}`)

function close() {
  emit('update:overlap', null)
}

function onToggle(open: boolean) {
  if (!open && !busy.value) close()
}

async function link() {
  const overlap = props.overlap
  if (!overlap || !selected.value.length || busy.value) return
  linking.value = true
  error.value = ''
  try {
    await httpClient.post(`${props.orgUrl}/invoicing/bills/${overlap.billId}/link-receipts`, {
      movementIds: selected.value,
      ...(overlap.typedLines ? { replaceLines: true } : {}),
    })
    close()
    emit('linked', overlap.billId)
  } catch (e: any) {
    error.value = stockRefusalMessage(e, t)
  } finally {
    linking.value = false
  }
}

async function receiveAnyway() {
  const overlap = props.overlap
  // The keyboard reaches a button that shows its spinner: Enter again would receive it again.
  if (!overlap || busy.value) return
  receiving.value = true
  error.value = ''
  try {
    const { data } = await httpClient.post(`${props.orgUrl}/invoices/${overlap.billId}/receive`, { acknowledgeOverlap: true })
    close()
    emit('received', data?.invoice)
  } catch (e: any) {
    error.value = e?.response?.data?.message || t('common.operationFailed')
  } finally {
    receiving.value = false
  }
}
</script>
