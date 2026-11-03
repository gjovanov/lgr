<template>
  <v-container fluid>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <h1 class="text-h5">{{ $t('accounting.vat.title') }}</h1>
      <v-spacer />
      <v-text-field
        v-model="month"
        type="month"
        :label="$t('accounting.vat.period')"
        density="compact"
        hide-details
        style="max-width: 200px"
      />
      <responsive-btn color="primary" icon="mdi-calendar-arrow-right" :disabled="!month" @click="openMonth">
        {{ $t('accounting.vat.openMonth') }}
      </responsive-btn>
    </div>

    <v-data-table-server
      :headers="headers"
      :items="items"
      :items-length="pagination.total"
      :loading="loading"
      :page="pagination.page + 1"
      :items-per-page="pagination.size"
      :no-data-text="$t('accounting.vat.none')"
      @update:options="onUpdateOptions"
      @click:row="(_e: any, row: any) => open(row.item.periodCode)"
    >
      <template #item.periodCode="{ item }">{{ periodLabel(item.periodCode) }}</template>
      <template #item.status="{ item }">
        <v-chip size="small" :color="statusColor(item.status)">{{ $t(`accounting.vat.status.${item.status}`) }}</v-chip>
      </template>
      <template #item.output="{ item }">{{ money(item, '01-20') }}</template>
      <template #item.credit="{ item }">{{ money(item, '01-40') }}</template>
      <template #item.result="{ item }">
        <span v-if="item.cells?.['01-60']" class="text-success">{{ money(item, '01-60') }} {{ $t('accounting.vat.refundable') }}</span>
        <span v-else>{{ money(item, '01-50') }} {{ $t('accounting.vat.payable') }}</span>
      </template>
      <template #item.filedAt="{ item }">{{ item.filedAt?.split('T')[0] }}</template>
    </v-data-table-server>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import { periodLabel, statusColor } from './vat-cells'

interface VatReturn {
  periodCode: string
  status: string
  currency: string
  cells?: Record<string, number>
  rowCounts?: { sales: number; purchase: number }
  filedAt?: string
}

const appStore = useAppStore()
const router = useRouter()
const { t } = useI18n()

const month = ref('')

const url = computed(() => `/org/${appStore.currentOrg?.id}/accounting/vat`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'returns',
  defaultSize: 25,
  defaultSortBy: 'periodCode',
  defaultSortOrder: 'desc',
})

const headers = computed(() => [
  { title: t('accounting.vat.period'), key: 'periodCode', sortable: false },
  { title: t('common.status'), key: 'status', sortable: false },
  { title: t('accounting.vat.salesRows'), key: 'rowCounts.sales', align: 'end' as const, sortable: false },
  { title: t('accounting.vat.purchaseRows'), key: 'rowCounts.purchase', align: 'end' as const, sortable: false },
  { title: t('accounting.vat.output'), key: 'output', align: 'end' as const, sortable: false },
  { title: t('accounting.vat.credit'), key: 'credit', align: 'end' as const, sortable: false },
  { title: t('accounting.vat.result'), key: 'result', align: 'end' as const, sortable: false },
  { title: t('accounting.vat.filedAt'), key: 'filedAt', sortable: false },
])

const localeCode = computed(() => ({ en: 'en-US', bg: 'bg-BG', mk: 'mk-MK', de: 'de-DE' } as Record<string, string>)[appStore.locale] || 'en-US')

/** A cell holds cents, in the month's currency. */
function money(item: VatReturn, code: string): string {
  return formatCurrency((item.cells?.[code] ?? 0) / 100, item.currency, localeCode.value)
}

function open(period: string) {
  router.push({ name: 'accounting.vat-return', params: { period } })
}

function openMonth() {
  open(month.value.replace('-', ''))
}

onMounted(() => {
  fetchItems()
})
</script>
