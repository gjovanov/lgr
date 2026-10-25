<template>
  <v-dialog :model-value="modelValue" max-width="420" @update:model-value="emit('update:modelValue', $event)">
    <v-card v-if="reservation">
      <v-card-title>{{ $t('invoicing.reservations.changeQuantity') }} — {{ reservation.reservationNumber || reservation.number }}</v-card-title>
      <v-card-text>
        <div v-if="subtitle" class="text-body-2 text-medium-emphasis mb-3">{{ subtitle }}</div>
        <v-text-field
          v-model.number="quantity"
          type="number"
          :min="floor"
          :label="$t('invoicing.qty')"
          :hint="floor > 0 ? $t('invoicing.reservations.minQuantity', { min: floor }) : ''"
          persistent-hint
          density="compact"
          variant="outlined"
          autofocus
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="emit('update:modelValue', false)">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" :disabled="!(quantity > 0) || quantity < floor" @click="save">
          {{ $t('common.save') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../store/app.store'

/**
 * #203: change a reservation's quantity in place (`POST /invoicing/reservations/:id/update`). A raise
 * is checked like a new reservation on the server; a cut cannot go under what is already invoiced
 * or dispatched — that floor is shown here too.
 */
const props = defineProps<{ modelValue: boolean; reservation: any | null; subtitle?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; saved: [reservation: any] }>()

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const quantity = ref(0)
const saving = ref(false)
const floor = computed(() => Math.max(Number(props.reservation?.invoicedQuantity) || 0, Number(props.reservation?.dispatchedQuantity) || 0))

watch(() => props.modelValue, (open) => { if (open) quantity.value = Number(props.reservation?.quantity) || 0 })

async function save() {
  saving.value = true
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/invoicing/reservations/${props.reservation._id}/update`, { quantity: quantity.value })
    showSuccess(t('common.savedSuccessfully'))
    emit('saved', data.reservation)
    emit('update:modelValue', false)
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}
</script>
