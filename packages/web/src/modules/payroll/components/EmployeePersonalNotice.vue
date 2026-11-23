<template>
  <v-col v-if="personal.sealed.value && !personal.revealed.value" cols="12">
    <v-alert density="compact" variant="tonal" type="info" icon="mdi-lock">
      {{ $t('payroll.personalSealed') }}
      <strong v-if="personal.mask.value" class="ml-2">{{ personal.mask.value }}</strong>
      <template #append>
        <v-btn size="small" variant="text" prepend-icon="mdi-eye" :loading="personal.revealing.value" @click="show">
          {{ $t('payroll.personalShow') }}
        </v-btn>
      </template>
    </v-alert>
  </v-col>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import type { useEmployeePersonal } from '../composables/useEmployeePersonal'

const props = defineProps<{ personal: ReturnType<typeof useEmployeePersonal>; employeeId: string }>()
const { t } = useI18n()
const { showError } = useSnackbar()

async function show() {
  try {
    await props.personal.reveal(props.employeeId)
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}
</script>
