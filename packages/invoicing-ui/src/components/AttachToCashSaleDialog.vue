<template>
  <v-dialog :model-value="modelValue" max-width="640" @update:model-value="emit('update:modelValue', $event)">
    <v-card>
      <v-card-title class="d-flex align-center ga-2">
        <v-icon color="primary">mdi-link-variant</v-icon>
        {{ $t('invoicing.cashSaleInvoice.attachTitle') }}
      </v-card-title>
      <v-card-text>
        <v-alert type="info" variant="tonal" density="compact" class="mb-3">
          {{ $t('invoicing.cashSaleInvoice.attachExplain') }}
        </v-alert>
        <div v-if="loading" class="d-flex justify-center pa-4"><v-progress-circular indeterminate /></div>
        <template v-else-if="offer">
          <v-alert v-if="!offer.eligible" type="warning" variant="tonal" density="compact">
            {{ refusalText(offer.code, offer.reason) }}
          </v-alert>
          <div v-else-if="!offer.candidates.length" class="text-medium-emphasis text-body-2">
            {{ $t('invoicing.cashSaleInvoice.attachNone', { day: offer.day, n: offer.considered }) }}
          </div>
          <v-radio-group v-else v-model="picked" hide-details>
            <v-radio v-for="c in offer.candidates" :key="c.id" :value="c.id">
              <template #label>
                <span class="font-weight-medium me-2">{{ c.number }}</span>
                <span class="text-medium-emphasis me-2">{{ String(c.issueDate).slice(0, 10) }}</span>
                <span class="me-2">{{ formatCurrency(c.total, c.currency, localeCode) }}</span>
                <v-chip v-if="c.state === 'partial'" size="x-small" variant="tonal">{{ $t('invoicing.cashSaleInvoice.statePartial') }}</v-chip>
              </template>
            </v-radio>
          </v-radio-group>
        </template>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="emit('update:modelValue', false)">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" prepend-icon="mdi-link-variant" :loading="saving" :disabled="!picked || saving" @click="attach">
          {{ $t('invoicing.cashSaleInvoice.attachConfirm') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { useAppStore } from '../store/app.store'

/**
 * FR-21 §11: an issued invoice entered before the day's till export, attached to the cash sale
 * that export brought in. The server finds the sales that sold every line of it and decides
 * everything that matters (its dispatch is taken back, it becomes paid by the till); this asks
 * which sale.
 */
const props = defineProps<{ modelValue: boolean; invoiceId: string }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'attached': [invoice: any]
}>()

const { t, te } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' } as Record<string, string>)[appStore.locale] || 'en-US')

interface Offer {
  eligible: boolean; code?: string; reason?: string; day: string; considered: number
  candidates: Array<{ id: string; number: string; issueDate: string; total: number; currency: string; state: string }>
}
const offer = ref<Offer | null>(null)
const picked = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')

/** The reasons the user can act on, in their language; anything else as the server said it. */
function refusalText(code?: string, fallback?: string): string {
  const key = `invoicing.cashSaleInvoice.attachRefusal.${code}`
  return code && te(key) ? t(key) : (fallback || t('common.operationFailed'))
}

async function load() {
  loading.value = true
  error.value = ''
  offer.value = null
  picked.value = ''
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoices/${props.invoiceId}/cash-sale-candidates`)
    offer.value = data
    if (data.eligible && data.candidates.length === 1) picked.value = data.candidates[0].id
  } catch (e: any) {
    error.value = refusalText(e?.response?.data?.code, e?.response?.data?.message)
  } finally {
    loading.value = false
  }
}

async function attach() {
  if (!picked.value) return
  saving.value = true
  error.value = ''
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/invoices/${props.invoiceId}/attach-to-cash-sale`, { cashSaleId: picked.value })
    emit('attached', data.invoice)
    emit('update:modelValue', false)
  } catch (e: any) {
    error.value = refusalText(e?.response?.data?.code, e?.response?.data?.message)
  } finally {
    saving.value = false
  }
}

watch(() => props.modelValue, (open) => { if (open) void load() })
</script>
