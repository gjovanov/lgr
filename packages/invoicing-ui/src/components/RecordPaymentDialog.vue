<template>
  <v-dialog :model-value="modelValue" max-width="500" @update:model-value="emit('update:modelValue', $event)">
    <v-card>
      <v-card-title>{{ $t('invoicing.recordPayment') }}</v-card-title>
      <v-card-text>
        <v-form ref="formRef">
          <v-text-field
            v-model.number="form.amount"
            :label="$t('common.amount')"
            type="number"
            :rules="[rules.required, rules.notMoreThanDue]"
          />
          <v-select
            v-model="form.method"
            :label="$t('invoicing.paymentMethod')"
            :placeholder="$t('invoicing.paymentMethod')"
            :items="paymentMethods"
            item-title="text"
            item-value="value"
            persistent-placeholder
            :rules="[rules.required]"
          />
          <DateField v-model="form.date" :label="$t('common.date')" :rules="[rules.required]" />
          <v-text-field v-model="form.reference" :label="$t('invoicing.reference')" />
        </v-form>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="emit('update:modelValue', false)">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" :loading="saving" @click="save">{{ $t('common.save') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
/**
 * Record a payment on a sales or purchase document — one dialog for both lists (FR-22.7), which
 * used to carry a copy each. It opens on what the document still owes, by the method the document
 * says it is paid with.
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { createIdempotentAction } from 'ui-shared/composables/idempotency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaymentMethods } from 'ui-shared/composables/usePaymentMethods'
import DateField from 'ui-shared/components/DateField.vue'
import { defaultPaymentMethod, outstandingAmount, type PayableDoc } from '../composables/payment-defaults'

const props = defineProps<{
  modelValue: boolean
  /** The list row being paid: its id, total, `amountPaid`, `paymentMethod` and currency. */
  document: (PayableDoc & { _id: string; currency?: string }) | null
}>()
const emit = defineEmits<{ 'update:modelValue': [open: boolean]; recorded: [] }>()

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const paymentMethods = usePaymentMethods()

const formRef = ref()
const saving = ref(false)
const today = () => new Date().toISOString().split('T')[0]
const form = ref({ amount: 0, method: 'bank_transfer', date: today(), reference: '' })

const outstanding = computed(() => outstandingAmount(props.document))

// Every opening starts from the document, never from the previous row's leftovers.
watch(
  () => props.modelValue,
  (open) => {
    if (!open || !props.document) return
    form.value = {
      amount: outstanding.value,
      method: defaultPaymentMethod(props.document, paymentMethods.value.map((m) => m.value)),
      date: today(),
      reference: '',
    }
  },
  { immediate: true },
)

function fmt(amount: number) {
  const locale = ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' } as Record<string, string>)[appStore.locale] || 'en-US'
  return formatCurrency(amount, props.document?.currency || appStore.currentOrg?.baseCurrency || 'EUR', locale)
}

const rules = {
  required: (v: string | number) => (v !== '' && v !== null && v !== 0) || t('validation.required'),
  // The API refuses it too (422); saying so here keeps the user in the dialog with the reason.
  notMoreThanDue: (v: string | number) =>
    Number(v) <= outstanding.value + 0.005 || t('invoicing.paymentExceedsOutstanding', { amount: fmt(outstanding.value) }),
}

// #155: one Idempotency-Key per Record-payment attempt (ui-shared/composables/idempotency).
const attempt = createIdempotentAction()

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid || !props.document) return
  const id = props.document._id
  saving.value = true
  try {
    await attempt.run({ id, ...form.value }, (headers) =>
      httpClient.post(`${appStore.orgUrl()}/invoices/${id}/payments`, form.value, { headers }))
    showSuccess(t('invoicing.paymentRecorded'))
    emit('update:modelValue', false)
    emit('recorded')
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}
</script>
