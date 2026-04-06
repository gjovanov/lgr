<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.taxReturns') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu module="accounting" />
        <responsive-btn color="primary" icon="mdi-plus" @click="router.push({ name: 'accounting.tax-return-new' })">
          {{ $t('common.add') }}
        </responsive-btn>
      </div>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="4">
            <v-select
              v-model="statusFilter"
              :label="$t('common.status')"
              :items="statusOptions"
              clearable
              hide-details
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-select
              v-model="typeFilter"
              :label="$t('common.type')"
              :items="typeOptions"
              clearable
              hide-details
            />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-data-table-server
      :headers="headers"
      :items="items"
      :items-length="pagination.total"
      :loading="loading"
      :page="pagination.page + 1"
      :items-per-page="pagination.size"
      @update:options="onUpdateOptions"
      @click:row="(_e: any, row: any) => navigateToEdit(row.item)"
    >
      <template #item.periodStart="{ item }">
        {{ item.periodStart?.split('T')[0] }}
      </template>
      <template #item.periodEnd="{ item }">
        {{ item.periodEnd?.split('T')[0] }}
      </template>
      <template #item.status="{ item }">
        <v-chip size="small" :color="statusColor(item.status)">
          {{ item.status }}
        </v-chip>
      </template>
      <template #item.netPayable="{ item }">
        <span :class="item.netPayable >= 0 ? 'text-error' : 'text-success'">
          {{ formatCurrency(Math.abs(item.netPayable), currency, localeCode) }}
          {{ item.netPayable >= 0 ? $t('accounting.payable') : $t('accounting.refund') }}
        </span>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" @click.stop="navigateToEdit(item)" />
        <v-btn
          v-if="item.status === 'draft'"
          icon="mdi-send"
          size="small"
          variant="text"
          color="primary"
          :title="$t('common.submit')"
          @click.stop="submitReturn(item)"
        />
      </template>
    </v-data-table-server>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'

interface TaxReturn {
  _id: string
  type: string
  periodStart: string
  periodEnd: string
  status: string
  taxCollected: number
  taxPaid: number
  netPayable: number
}

const appStore = useAppStore()
const router = useRouter()
const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const { search, debouncedSearch } = useSearchDebounce()
const statusFilter = ref<string | null>(null)
const typeFilter = ref<string | null>(null)

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (statusFilter.value) f.status = statusFilter.value
  if (typeFilter.value) f.type = typeFilter.value
  return f
})

const url = computed(() => `/org/${appStore.currentOrg?.id}/accounting/tax-return`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'taxReturns',
  filters,
})

const statusOptions = ['draft', 'submitted', 'accepted', 'rejected']
const typeOptions = ['VAT', 'income_tax', 'corporate_tax', 'withholding']

const headers = computed(() => [
  { title: t('common.type'), key: 'type' },
  { title: t('common.dateFrom'), key: 'periodStart' },
  { title: t('common.dateTo'), key: 'periodEnd' },
  { title: t('common.status'), key: 'status' },
  { title: t('accounting.netPayable'), key: 'netPayable', align: 'end' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function statusColor(s: string) {
  const colors: Record<string, string> = {
    draft: 'grey', submitted: 'info', accepted: 'success', rejected: 'error',
  }
  return colors[s] || 'grey'
}

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function navigateToEdit(item: TaxReturn | Record<string, unknown>) {
  if (item && '_id' in item && item._id) {
    router.push({ name: 'accounting.tax-return-edit', params: { id: item._id as string } })
  }
}

async function submitReturn(item: TaxReturn) {
  try {
    await httpClient.post(`${orgUrl()}/accounting/tax-return/${item._id}/submit`)
    showSuccess(t('common.submittedSuccessfully'))
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => {
  fetchItems()
})
</script>
