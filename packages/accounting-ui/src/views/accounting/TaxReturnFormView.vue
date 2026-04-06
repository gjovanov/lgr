<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('accounting.taxReturn') : $t('common.new') + ' ' + $t('accounting.taxReturn')"
    :subtitle="isEdit ? form.type : ''"
    :status="isEdit ? { steps: statusSteps, current: currentStatusLabel } : undefined"
    :actions="formActions"
    :loading="loading"
    back-to="/tax-returns"
    :back-label="$t('accounting.taxReturns')"
  >
    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="4">
          <v-select
            v-model="form.type"
            :label="$t('common.type')"
            :items="typeOptions"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.periodStart"
            :label="$t('common.dateFrom')"
            type="date"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.periodEnd"
            :label="$t('common.dateTo')"
            type="date"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
      </v-row>

      <!-- Line Items -->
      <div class="d-flex align-center mt-4 mb-2">
        <span class="text-subtitle-1 font-weight-medium">
          {{ $t('accounting.lineItems') }}
        </span>
        <v-spacer />
        <v-btn
          color="primary"
          variant="outlined"
          size="small"
          prepend-icon="mdi-plus"
          @click="addLineItem"
        >
          {{ $t('accounting.addLine') }}
        </v-btn>
      </div>

      <v-table density="compact">
        <thead>
          <tr>
            <th>{{ $t('common.description') }}</th>
            <th class="text-end">{{ $t('accounting.taxCollected') }}</th>
            <th class="text-end">{{ $t('accounting.taxPaid') }}</th>
            <th style="width: 40px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(line, idx) in form.lines" :key="idx">
            <td>
              <v-text-field
                v-model="line.description"
                density="compact"
                hide-details
                variant="underlined"
              />
            </td>
            <td style="width: 150px">
              <v-text-field
                v-model.number="line.taxCollected"
                type="number"
                density="compact"
                hide-details
                variant="underlined"
                class="text-end"
              />
            </td>
            <td style="width: 150px">
              <v-text-field
                v-model.number="line.taxPaid"
                type="number"
                density="compact"
                hide-details
                variant="underlined"
                class="text-end"
              />
            </td>
            <td>
              <v-btn icon="mdi-close" size="x-small" variant="text" @click="removeLineItem(idx)" />
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr class="font-weight-bold">
            <td>{{ $t('common.total') }}</td>
            <td class="text-end">{{ formatCurrency(totalCollected, currency, localeCode) }}</td>
            <td class="text-end">{{ formatCurrency(totalPaid, currency, localeCode) }}</td>
            <td></td>
          </tr>
          <tr class="font-weight-bold">
            <td>{{ $t('accounting.netPayable') }}</td>
            <td colspan="2" class="text-end" :class="netPayable >= 0 ? 'text-error' : 'text-success'">
              {{ formatCurrency(Math.abs(netPayable), currency, localeCode) }}
              {{ netPayable >= 0 ? $t('accounting.payable') : $t('accounting.refund') }}
            </td>
            <td></td>
          </tr>
        </tfoot>
      </v-table>

      <v-row class="mt-4">
        <v-col cols="12">
          <v-textarea
            v-model="form.notes"
            :label="$t('common.notes')"
            rows="2"
            density="compact"
          />
        </v-col>
      </v-row>
    </v-form>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" entity-type="taxReturn" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
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

interface TaxReturnLine {
  description: string
  taxCollected: number
  taxPaid: number
}

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const formRef = ref()
const loading = ref(false)
const isEdit = computed(() => !!route.params.id)
const currentStatus = ref('draft')

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const typeOptions = ['VAT', 'income_tax', 'corporate_tax', 'withholding']
const statusSteps = ['draft', 'submitted', 'accepted', 'rejected']

const currentStatusLabel = computed(() => currentStatus.value)

const form = ref({
  type: '',
  periodStart: '',
  periodEnd: '',
  notes: '',
  lines: [{ description: '', taxCollected: 0, taxPaid: 0 }] as TaxReturnLine[],
})

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'accounting',
  entityType: 'taxReturn',
  icon: 'mdi-file-percent',
  getFormData: () => ({ ...form.value, lines: [...form.value.lines] }),
  getPreviewFields: () => [
    { label: 'Type', value: form.value.type || '' },
    { label: 'Period', value: form.value.periodStart || '' },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const totalCollected = computed(() => form.value.lines.reduce((s, l) => s + (l.taxCollected || 0), 0))
const totalPaid = computed(() => form.value.lines.reduce((s, l) => s + (l.taxPaid || 0), 0))
const netPayable = computed(() => totalCollected.value - totalPaid.value)

const rules = {
  required: (v: string) => !!v || t('validation.required'),
}

const formActions = computed<FormAction[]>(() => {
  const actions: FormAction[] = [
    { label: t('common.save'), color: 'primary', handler: handleSubmit, loading: loading.value },
  ]
  if (isEdit.value && currentStatus.value === 'draft') {
    actions.push({
      label: t('common.submit'),
      color: 'primary',
      variant: 'outlined',
      icon: 'mdi-send',
      handler: submitReturn,
      loading: loading.value,
    })
  }
  return actions
})

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function addLineItem() {
  form.value.lines.push({ description: '', taxCollected: 0, taxPaid: 0 })
}

function removeLineItem(idx: number) {
  form.value.lines.splice(idx, 1)
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  loading.value = true
  try {
    const payload = {
      ...form.value,
      taxCollected: totalCollected.value,
      taxPaid: totalPaid.value,
    }
    if (isEdit.value) {
      await httpClient.put(`${orgUrl()}/accounting/tax-return/${route.params.id}`, payload)
    } else {
      await httpClient.post(`${orgUrl()}/accounting/tax-return`, payload)
    }
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'accounting.tax-returns' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function submitReturn() {
  loading.value = true
  try {
    await httpClient.post(`${orgUrl()}/accounting/tax-return/${route.params.id}/submit`)
    markSaved()
    showSuccess(t('common.submittedSuccessfully'))
    router.push({ name: 'accounting.tax-returns' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function loadTaxReturn() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/accounting/tax-return/${route.params.id}`)
    const tr = data.taxReturn || data
    currentStatus.value = tr.status || 'draft'
    form.value = {
      type: tr.type || '',
      periodStart: tr.periodStart?.split('T')[0] || '',
      periodEnd: tr.periodEnd?.split('T')[0] || '',
      notes: tr.notes || '',
      lines: tr.lines || [{ description: '', taxCollected: tr.taxCollected || 0, taxPaid: tr.taxPaid || 0 }],
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
    await loadTaxReturn()
  }
})
</script>
