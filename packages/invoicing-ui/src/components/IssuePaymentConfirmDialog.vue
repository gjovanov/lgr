<template>
  <!-- Owner, 2026-11-12: an outgoing invoice is issued only once the person confirms the payment method it carries.
       The method decides what is booked, and at a till what prints. Esc and No leave the document a draft. -->
  <v-dialog :model-value="!!ask" max-width="460" persistent @keydown.esc="emit('answer', false)">
    <v-card v-if="ask" data-testid="issue-payment-confirm">
      <v-card-title class="text-wrap">{{ $t('invoicing.issueFlow.confirmPayment.title', { number: ask.number }) }}</v-card-title>
      <v-card-text>
        <div>{{ $t('invoicing.issueFlow.confirmPayment.text') }}</div>
        <div class="text-h6 mt-2" data-testid="issue-payment-method">{{ methodLabel }}</div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" data-testid="issue-payment-no" @click="emit('answer', false)">{{ $t('common.no') }}</v-btn>
        <v-btn color="primary" variant="flat" autofocus data-testid="issue-payment-yes" @click="emit('answer', true)">{{ $t('common.yes') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { paymentMethodKey } from 'ui-shared/composables/usePaymentMethods'
import type { PaymentConfirmAsk } from '../composables/useDocumentIssue'

const props = defineProps<{ ask: PaymentConfirmAsk | null }>()
const emit = defineEmits<{ answer: [yes: boolean] }>()
const { t } = useI18n()

/** The method's name, as the form's select shows it; a document with none says so rather than show a blank. */
const methodLabel = computed(() => (props.ask?.method ? t(paymentMethodKey(props.ask.method)) : t('invoicing.issueFlow.confirmPayment.none')))
</script>
