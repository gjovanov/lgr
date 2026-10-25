<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('accounting.fixedAsset') : $t('common.create') + ' ' + $t('accounting.fixedAsset')"
    :subtitle="isEdit ? form.name : ''"
    :status="isEdit ? { steps: statusItems, current: form.status } : undefined"
    :actions="formActions"
    :loading="loading"
    back-to="/fixed-assets"
    :back-label="$t('accounting.fixedAssets')"
  >
    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.code"
            :label="$t('common.code')"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.name"
            :label="$t('common.name')"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.category"
            :label="$t('common.category')"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.acquisitionDate"
            :label="$t('accounting.purchaseDate')"
            type="date"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model.number="form.acquisitionCost"
            :label="$t('accounting.purchasePrice')"
            type="number"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-select
            v-model="form.depreciationMethod"
            :label="$t('accounting.depreciationMethod')"
            :items="depreciationMethods"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model.number="form.usefulLife"
            :label="$t('accounting.usefulLife')"
            type="number"
            suffix="years"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-select
            v-model="form.status"
            :label="$t('common.status')"
            :items="statusItems"
            density="compact"
          />
        </v-col>
      </v-row>

      <!-- Depreciation Schedule (read-only, shown on edit) -->
      <template v-if="isEdit && depSchedule.length">
        <div class="d-flex align-center mt-6 mb-2">
          <span class="text-subtitle-1 font-weight-medium">{{ $t('accounting.depreciationSchedule') }}</span>
        </div>
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ $t('common.year') || 'Year' }}</th>
              <th class="text-end">{{ $t('accounting.depreciation') || 'Depreciation' }}</th>
              <th class="text-end">{{ $t('accounting.accumulated') || 'Accumulated' }}</th>
              <th class="text-end">{{ $t('accounting.bookValue') || 'Book Value' }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in depSchedule" :key="row.year">
              <td>{{ row.year }}</td>
              <td class="text-end">{{ formatCurrency(row.depreciation, currency, localeCode) }}</td>
              <td class="text-end">{{ formatCurrency(row.accumulated, currency, localeCode) }}</td>
              <td class="text-end">{{ formatCurrency(row.bookValue, currency, localeCode) }}</td>
            </tr>
          </tbody>
        </v-table>
      </template>
    </v-form>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" entity-type="fixedAsset" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'

interface DepreciationRow {
  year: number
  depreciation: number
  accumulated: number
  bookValue: number
}

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const formRef = ref()
const loading = ref(false)
const isEdit = computed(() => !!route.params.id)

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const depreciationMethods = ['straight-line', 'declining-balance', 'units-of-production']
const statusItems = ['active', 'disposed', 'fully-depreciated']

const form = ref({
  code: '',
  name: '',
  category: '',
  acquisitionDate: '',
  acquisitionCost: 0,
  depreciationMethod: 'straight-line',
  usefulLife: 5,
  status: 'active',
})

const depSchedule = ref<DepreciationRow[]>([])

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'accounting',
  entityType: 'fixedAsset',
  icon: 'mdi-domain',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'Code', value: form.value.code || '' },
    { label: 'Name', value: form.value.name || '' },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const rules = {
  required: (v: string) => !!v || t('validation.required'),
}

const formActions = computed<FormAction[]>(() => [
  { label: t('common.save'), color: 'primary', handler: handleSubmit, loading: loading.value },
])

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function computeDepreciation() {
  const cost = form.value.acquisitionCost
  const life = form.value.usefulLife || 1
  if (!cost || !life) {
    depSchedule.value = []
    return
  }
  const annualDep = cost / life
  const schedule: DepreciationRow[] = []
  let accumulated = 0
  for (let y = 1; y <= life; y++) {
    accumulated += annualDep
    schedule.push({
      year: y,
      depreciation: Math.round(annualDep * 100) / 100,
      accumulated: Math.round(accumulated * 100) / 100,
      bookValue: Math.round((cost - accumulated) * 100) / 100,
    })
  }
  depSchedule.value = schedule
}

watch(() => [form.value.acquisitionCost, form.value.usefulLife], computeDepreciation)

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  loading.value = true
  try {
    if (isEdit.value) {
      await httpClient.put(`${orgUrl()}/accounting/fixed-asset/${route.params.id}`, form.value)
    } else {
      await httpClient.post(`${orgUrl()}/accounting/fixed-asset`, form.value)
    }
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'accounting.fixed-assets' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function loadFixedAsset() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/accounting/fixed-asset/${route.params.id}`)
    const asset = data.fixedAsset || data
    form.value = {
      code: asset.code || '',
      name: asset.name || '',
      category: asset.category || '',
      acquisitionDate: asset.acquisitionDate?.split('T')[0] || '',
      acquisitionCost: asset.acquisitionCost || 0,
      depreciationMethod: asset.depreciationMethod || 'straight-line',
      usefulLife: asset.usefulLife || 5,
      status: asset.status || 'active',
    }
    computeDepreciation()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (tryRestore()) return
  if (isEdit.value) {
    await loadFixedAsset()
  }
})
</script>
