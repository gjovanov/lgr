<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('accounting.exchangeRate') : $t('common.create') + ' ' + $t('accounting.exchangeRate')"
    :subtitle="isEdit ? `${form.fromCurrency} / ${form.toCurrency}` : ''"
    :actions="formActions"
    :loading="loading"
    back-to="/exchange-rates"
    :back-label="$t('accounting.exchangeRates')"
  >
    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.fromCurrency"
            :label="$t('accounting.fromCurrency')"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.toCurrency"
            :label="$t('accounting.toCurrency')"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model.number="form.rate"
            :label="$t('accounting.rate')"
            type="number"
            step="0.000001"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.date"
            :label="$t('common.date')"
            type="date"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.source"
            :label="$t('accounting.source')"
            density="compact"
          />
        </v-col>
      </v-row>
    </v-form>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" entity-type="exchangeRate" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const formRef = ref()
const loading = ref(false)
const isEdit = computed(() => !!route.params.id)

const form = ref({
  fromCurrency: '',
  toCurrency: '',
  rate: 1,
  date: new Date().toISOString().split('T')[0],
  source: '',
})

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'accounting',
  entityType: 'exchangeRate',
  icon: 'mdi-currency-usd',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'From', value: form.value.fromCurrency || '' },
    { label: 'To', value: form.value.toCurrency || '' },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const rules = {
  required: (v: string | number) => (v !== '' && v !== null && v !== undefined) || t('validation.required'),
}

const formActions = computed<FormAction[]>(() => [
  { label: t('common.save'), color: 'primary', handler: handleSubmit, loading: loading.value },
])

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  loading.value = true
  try {
    if (isEdit.value) {
      await httpClient.put(`${orgUrl()}/accounting/exchange-rate/${route.params.id}`, form.value)
    } else {
      await httpClient.post(`${orgUrl()}/accounting/exchange-rate`, form.value)
    }
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'accounting.exchange-rates' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function loadExchangeRate() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/accounting/exchange-rate/${route.params.id}`)
    const rate = data.exchangeRate || data
    form.value = {
      fromCurrency: rate.fromCurrency || '',
      toCurrency: rate.toCurrency || '',
      rate: rate.rate || 1,
      date: rate.date?.split('T')[0] || '',
      source: rate.source || '',
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (tryRestore()) return
  if (isEdit.value) {
    await loadExchangeRate()
  }
})
</script>
