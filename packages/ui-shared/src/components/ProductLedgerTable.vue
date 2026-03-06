<template>
  <div>
    <v-row class="mb-2" dense>
      <v-col cols="12" md="4">
        <v-select
          v-model="warehouseFilter"
          :label="$t('warehouse.warehouse')"
          :items="warehouses"
          item-title="name"
          item-value="_id"
          clearable
          hide-details
          density="compact"
        />
      </v-col>
      <v-col cols="12" md="3">
        <v-text-field v-model="dateFrom" :label="$t('invoicing.dateFrom')" type="date" hide-details density="compact" />
      </v-col>
      <v-col cols="12" md="3">
        <v-text-field v-model="dateTo" :label="$t('invoicing.dateTo')" type="date" hide-details density="compact" />
      </v-col>
      <v-col cols="12" md="2" class="d-flex align-center">
        <v-btn variant="outlined" size="small" prepend-icon="mdi-refresh" @click="fetchLedger">{{ $t('common.refresh') }}</v-btn>
      </v-col>
    </v-row>

    <v-data-table
      :headers="headers"
      :items="entries"
      :loading="loading"
      density="compact"
      items-per-page="-1"
      hide-default-footer
    >
      <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
      <template #item.eventType="{ item }">
        <v-chip size="x-small" label :color="eventColor(item.eventType)">{{ eventLabel(item.eventType) }}</v-chip>
      </template>
      <template #item.quantityChange="{ item }">
        <span :class="item.quantityChange > 0 ? 'text-success' : 'text-error'">
          {{ item.quantityChange > 0 ? '+' : '' }}{{ item.quantityChange }}
        </span>
      </template>
      <template #item.unitCost="{ item }">{{ fmtCurrency(item.unitCost) }}</template>
      <template #item.lineTotalCost="{ item }">{{ fmtCurrency(item.lineTotalCost) }}</template>
      <template #item.runningQty="{ item }">
        <strong>{{ item.runningQty }}</strong>
      </template>
      <template #item.runningValue="{ item }">
        <strong>{{ fmtCurrency(item.runningValue) }}</strong>
      </template>
      <template #item.invoiceNumber="{ item }">
        <span v-if="item.invoiceNumber">{{ item.invoiceNumber }}</span>
      </template>

      <template #bottom>
        <v-divider />
        <v-row class="pa-3" dense>
          <v-col cols="3">
            <span class="text-caption text-medium-emphasis">{{ $t('warehouse.totalIn') }}:</span>
            <strong class="ml-1 text-success">+{{ summary.totalIn }}</strong>
          </v-col>
          <v-col cols="3">
            <span class="text-caption text-medium-emphasis">{{ $t('warehouse.totalOut') }}:</span>
            <strong class="ml-1 text-error">-{{ summary.totalOut }}</strong>
          </v-col>
          <v-col cols="3">
            <span class="text-caption text-medium-emphasis">{{ $t('warehouse.quantity') }}:</span>
            <strong class="ml-1">{{ summary.currentQty }}</strong>
          </v-col>
          <v-col cols="3">
            <span class="text-caption text-medium-emphasis">{{ $t('warehouse.currentValue') }}:</span>
            <strong class="ml-1">{{ fmtCurrency(summary.currentValue) }}</strong>
          </v-col>
        </v-row>
      </template>
    </v-data-table>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from '../composables/useHttpClient'
import { useCurrency } from '../composables/useCurrency'

const props = defineProps<{
  productId: string
  orgUrl: string
  baseCurrency?: string
  localeCode?: string
  warehouses?: { _id: string; name: string }[]
}>()

const { t } = useI18n()
const { formatCurrency } = useCurrency()

const loading = ref(false)
const entries = ref<any[]>([])
const summary = ref({ totalIn: 0, totalOut: 0, currentQty: 0, currentValue: 0 })
const warehouseFilter = ref<string | null>(null)
const dateFrom = ref('')
const dateTo = ref('')

const warehouses = computed(() => props.warehouses || [])

const headers = computed(() => [
  { title: t('common.date'), key: 'date', width: '100px' },
  { title: t('warehouse.document'), key: 'documentRef' },
  { title: t('warehouse.event'), key: 'eventType' },
  { title: t('warehouse.warehouse'), key: 'warehouseName' },
  { title: t('warehouse.qtyChange'), key: 'quantityChange', align: 'end' as const },
  { title: t('warehouse.unitCost'), key: 'unitCost', align: 'end' as const },
  { title: t('common.total'), key: 'lineTotalCost', align: 'end' as const },
  { title: t('warehouse.runningQty'), key: 'runningQty', align: 'end' as const },
  { title: t('warehouse.runningValue'), key: 'runningValue', align: 'end' as const },
  { title: t('invoicing.invoice'), key: 'invoiceNumber' },
])

function fmtCurrency(amount: number) {
  return formatCurrency(amount, props.baseCurrency || 'EUR', props.localeCode || 'en-US')
}

function eventColor(eventType: string) {
  const map: Record<string, string> = {
    received: 'success', dispatched: 'error', transferred_in: 'info',
    transferred_out: 'orange', adjusted: 'amber', count_adjusted: 'purple',
    returned: 'teal', produced_in: 'light-green', produced_out: 'deep-orange',
  }
  return map[eventType] || 'grey'
}

function eventLabel(eventType: string) {
  const map: Record<string, string> = {
    received: t('warehouse.received'), dispatched: t('warehouse.dispatched'),
    transferred_in: t('warehouse.transferredIn'), transferred_out: t('warehouse.transferredOut'),
    adjusted: t('warehouse.adjusted'), count_adjusted: t('warehouse.countAdjusted'),
    returned: t('warehouse.returned'), produced_in: t('warehouse.producedIn'),
    produced_out: t('warehouse.producedOut'),
  }
  return map[eventType] || eventType
}

async function fetchLedger() {
  if (!props.productId) return
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (warehouseFilter.value) params.warehouseId = warehouseFilter.value
    if (dateFrom.value) params.dateFrom = dateFrom.value
    if (dateTo.value) params.dateTo = dateTo.value

    const { data } = await httpClient.get(`${props.orgUrl}/warehouse/product-ledger/${props.productId}`, { params })
    entries.value = data.entries || []
    summary.value = data.summary || { totalIn: 0, totalOut: 0, currentQty: 0, currentValue: 0 }
  } catch {
    entries.value = []
    summary.value = { totalIn: 0, totalOut: 0, currentQty: 0, currentValue: 0 }
  }
  loading.value = false
}

watch(() => props.productId, () => { if (props.productId) fetchLedger() })

onMounted(() => { if (props.productId) fetchLedger() })
</script>
