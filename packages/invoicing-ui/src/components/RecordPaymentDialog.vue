<template>
  <v-dialog :model-value="modelValue" max-width="500" @update:model-value="emit('update:modelValue', $event)">
    <v-card>
      <v-card-title>{{ $t('invoicing.recordPayment') }}</v-card-title>
      <v-card-text>
        <!-- FR-23: why the receipt did not print. Nothing was recorded, so saving again is the retry. -->
        <v-alert v-if="refusal" :type="printFailed ? 'error' : 'warning'" variant="tonal" density="compact" class="mb-3" data-testid="payment-refusal">
          {{ refusal }}
        </v-alert>
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
          <!-- FR-23: what prints is dated by the device, as it prints. -->
          <DateField v-model="form.date" :label="$t('common.date')" :rules="[rules.required]" :disabled="prints" />
          <v-text-field v-model="form.reference" :label="$t('invoicing.reference')" />
        </v-form>
        <div v-if="prints" class="text-caption text-medium-emphasis" data-testid="payment-prints">
          <v-icon icon="mdi-printer-pos-outline" size="small" class="mr-1" />{{ $t('cashRegister.receipt.willPrint') }}
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="emit('update:modelValue', false)">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" :loading="saving" data-testid="payment-save" @click="save">{{ printFailed ? $t('cashRegister.receipt.printAgain') : $t('common.save') }}</v-btn>
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
import { isFailedPrint, receiptRefusalMessage } from 'ui-shared/cash-register/receipt-refusal'
import { defaultPaymentMethod, outstandingAmount, type PayableDoc } from '../composables/payment-defaults'

const props = defineProps<{
  modelValue: boolean
  /** The document being paid: its id, total, `amountPaid`, `paymentMethod`, currency, and which methods print. */
  document: (PayableDoc & { _id: string; currency?: string; printsOnPayment?: string[] }) | null
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
/** FR-23: why the last attempt did not go through, and whether it was the print that failed. */
const refusal = ref('')
const printFailed = ref(false)

/** FR-23: whether saving prints a receipt. The server answers it, per document and by method. */
const prints = computed(() => (props.document?.printsOnPayment ?? []).includes(form.value.method))

const outstanding = computed(() => outstandingAmount(props.document))

// Every opening starts from the document, never from the previous row's leftovers.
watch(
  () => props.modelValue,
  (open) => {
    if (!open || !props.document) return
    refusal.value = ''
    printFailed.value = false
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
  refusal.value = ''
  printFailed.value = false
  try {
    const { data } = await attempt.run({ id, ...form.value }, (headers) =>
      httpClient.post(`${appStore.orgUrl()}/invoices/${id}/payments`, form.value, { headers }))
    // An interrupted print the device cannot confirm: the payment stands, and someone checks it.
    if (data?.receiptError) showError(t('cashRegister.receipt.unknown', { reason: data.receiptError }))
    else showSuccess(data?.receipt?.number ? t('cashRegister.receipt.printed', { number: data.receipt.number }) : t('invoicing.paymentRecorded'))
    emit('update:modelValue', false)
    emit('recorded')
  } catch (e: any) {
    // A definitive answer ends the attempt (`createIdempotentAction`): saving again is a new one.
    const message = receiptRefusalMessage(t, e, t('common.operationFailed'))
    refusal.value = message
    printFailed.value = isFailedPrint(e?.response?.data)
    showError(message)
  } finally {
    saving.value = false
  }
}
</script>
