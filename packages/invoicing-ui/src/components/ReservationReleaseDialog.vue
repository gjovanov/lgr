<template>
  <v-dialog :model-value="modelValue" max-width="460" @update:model-value="(v: boolean) => { if (!v) close() }" @after-enter="focusQuantity">
    <v-card v-if="reservation" data-testid="reservation-release">
      <v-card-title class="text-wrap">{{ $t('invoicing.reservations.releaseTitle') }} <span class="text-no-wrap">{{ number }}</span></v-card-title>
      <v-card-text>
        <div v-if="subtitle" class="text-body-2 mb-1">{{ subtitle }}</div>
        <div class="text-body-2 text-medium-emphasis mb-3">
          {{ $t('invoicing.reservations.releaseFigures', { quantity: reservation.quantity, invoiced: reservation.invoicedQuantity || 0, dispatched: reservation.dispatchedQuantity || 0 }) }}
        </div>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3" role="alert">{{ error }}</v-alert>
        <template v-if="outcome.releasable > 0">
          <!-- FR-22.37: part of it, or all of it — the dialog says how much can go, and starts at all of it. -->
          <v-text-field
            ref="qtyRef"
            v-model.number="amount"
            type="number"
            min="0"
            :max="outcome.releasable"
            :label="$t('invoicing.reservations.releaseQuantity')"
            :suffix="unitLabel(reservation.productUnit)"
            :hint="$t('invoicing.reservations.releasableHint', { releasable: outcome.releasable })"
            :error-messages="amount > outcome.releasable + 1e-9 ? $t('invoicing.reservations.errors.releasable_exceeded', { releasable: outcome.releasable }) : ''"
            persistent-hint
            density="compact"
            variant="outlined"
            @keydown.enter.prevent="outcome.valid && release()"
          />
          <div v-if="outcome.valid" class="text-body-2 mt-3">
            <template v-if="outcome.cancels">{{ $t('invoicing.reservations.releaseCancels') }}</template>
            <template v-else-if="outcome.remaining <= outcome.consumed + 1e-9">{{ $t('invoicing.reservations.releaseKeepsConsumed', { remaining: outcome.remaining }) }}</template>
            <template v-else>{{ $t('invoicing.reservations.releaseKeeps', { remaining: outcome.remaining }) }}</template>
          </div>
        </template>
        <div v-else class="text-body-2">{{ $t('invoicing.reservations.errors.nothing_to_release') }}</div>
      </v-card-text>
      <!-- Two buttons that cannot be confused: „Не" keeps it, „Освободи резервацията" lets it go. -->
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="close">{{ $t('common.no') }}</v-btn>
        <v-btn color="error" variant="flat" :loading="saving" :disabled="!outcome.valid" @click="release">
          {{ $t('invoicing.reservations.release') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../store/app.store'
import { releaseOutcome } from '../composables/reservation-form'
import { reservationErrorMessage } from '../composables/reservation-errors'

/**
 * FR-22.37: release a reservation, or part of it (`POST /reservations/:id/cancel {quantity}`).
 *
 * What can go is quantity − max(invoiced, dispatched); the dialog starts at all of it and says what
 * stays. Releasing everything of a reservation nothing has consumed cancels it; anything else lowers
 * it and leaves it active. The quantity always travels explicitly, so a release that raced an
 * invoice is refused rather than freeing something other than what the dialog showed.
 */
const props = defineProps<{
  modelValue: boolean
  reservation: any | null
  subtitle?: string
  /** On the reservation's own page: a cancel there is not "reserved again from its row". */
  onPage?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; released: [reservation: any] }>()

const { t, te } = useI18n()
const appStore = useAppStore()
const { showSuccess } = useSnackbar()
const unitLabel = (u?: string) => (u && te(`warehouse.uomShort.${u}`) ? t(`warehouse.uomShort.${u}`) : u || '')

const qtyRef = ref<any>()
const amount = ref(0)
const saving = ref(false)
const error = ref('')
const number = computed(() => props.reservation?.reservationNumber || props.reservation?.number || '')
const outcome = computed(() => releaseOutcome(props.reservation || {}, amount.value))

watch(() => props.modelValue, (open) => {
  if (!open) return
  error.value = ''
  saving.value = false
  amount.value = releaseOutcome(props.reservation || {}, 0).releasable
})

function focusQuantity() {
  nextTick(() => {
    qtyRef.value?.focus?.()
    qtyRef.value?.select?.()
  })
}

function close() {
  emit('update:modelValue', false)
}

async function release() {
  if (!outcome.value.valid || !props.reservation) return
  saving.value = true
  error.value = ''
  const released = Number(amount.value)
  const cancels = outcome.value.cancels
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/invoicing/reservations/${props.reservation._id}/cancel`, { quantity: released })
    showSuccess(cancels
      ? t(props.onPage ? 'invoicing.reservations.cancelledHere' : 'invoicing.reservations.cancelled', { number: number.value })
      : t('invoicing.reservations.released', { quantity: released, number: number.value }))
    emit('released', data.reservation)
    close()
  } catch (e: any) {
    error.value = reservationErrorMessage(e, t)
  } finally {
    saving.value = false
  }
}
</script>
