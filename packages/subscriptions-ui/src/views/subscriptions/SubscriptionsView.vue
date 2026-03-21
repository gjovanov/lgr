<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('subscriptions.subscriptions') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <v-btn color="secondary" prepend-icon="mdi-receipt" :loading="store.loading" @click="generateInvoices">{{ $t('subscriptions.generateInvoices') }}</v-btn>
        <v-btn color="primary" prepend-icon="mdi-plus" :to="{ name: 'subscriptions.new' }">{{ $t('common.create') }}</v-btn>
      </div>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" @update:model-value="debounceFetch" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="stateFilter" :label="$t('common.state')" :items="states" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="total"
          :loading="store.loading"
          :page="page + 1"
          :items-per-page="pageSize"
          @update:options="onUpdateOptions"
          item-value="_id"
          hover
        >
          <template #item.name="{ item }">
            <router-link :to="{ name: 'subscriptions.edit', params: { id: item._id } }" class="text-decoration-none">{{ item.name }}</router-link>
          </template>
          <template #item.state="{ item }">
            <v-chip size="small" :color="stateColor(item.state)">{{ item.state }}</v-chip>
          </template>
          <template #item.amountRecurring="{ item }">{{ formatAmount(item.amountRecurring, item.currency) }}</template>
          <template #item.nextInvoiceDate="{ item }">{{ item.nextInvoiceDate?.split('T')[0] || '-' }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'subscriptions.edit', params: { id: item._id } }" />
            <v-btn v-if="item.state === 'draft'" icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Delete Dialog -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('subscriptions.deleteConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="store.loading" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSubscriptionsStore, type Subscription } from '../../store/subscriptions.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { t } = useI18n()
const store = useSubscriptionsStore()
const { showSuccess, showError } = useSnackbar()

const states = ['draft', 'active', 'paused', 'cancelled', 'expired']
const search = ref('')
const stateFilter = ref<string | null>(null)
const items = ref<Subscription[]>([])
const total = ref(0)
const page = ref(0)
const pageSize = ref(10)
const deleteDialog = ref(false)
const selectedId = ref('')

let debounceTimer: ReturnType<typeof setTimeout> | null = null

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('subscriptions.partner'), key: 'partnerName' },
  { title: t('common.state'), key: 'state', sortable: true },
  { title: t('subscriptions.amountRecurring'), key: 'amountRecurring', sortable: true, align: 'end' as const },
  { title: t('subscriptions.recurringPeriod'), key: 'recurringPeriod' },
  { title: t('subscriptions.nextInvoiceDate'), key: 'nextInvoiceDate', sortable: true },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function stateColor(state: string) {
  const map: Record<string, string> = { draft: 'grey', active: 'success', paused: 'warning', cancelled: 'error', expired: 'error' }
  return map[state] || 'grey'
}

function formatAmount(amount: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'EUR' }).format(amount || 0)
}

async function fetchData() {
  const params: Record<string, any> = { page: page.value, size: pageSize.value }
  if (search.value) params.search = search.value
  if (stateFilter.value) params.state = stateFilter.value
  const data = await store.fetchSubscriptions(params)
  items.value = store.subscriptions
  total.value = data?.total || 0
}

function debounceFetch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => { page.value = 0; fetchData() }, 300)
}

function onUpdateOptions(opts: any) {
  page.value = (opts.page || 1) - 1
  pageSize.value = opts.itemsPerPage || 10
  fetchData()
}

watch(stateFilter, () => { page.value = 0; fetchData() })

function confirmDelete(item: Subscription) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await store.deleteSubscription(selectedId.value)
    deleteDialog.value = false
    showSuccess(t('common.deletedSuccessfully'))
    await fetchData()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function generateInvoices() {
  try {
    const result = await store.generateInvoices()
    showSuccess(t('subscriptions.invoicesGenerated', { count: result.invoicesCreated }))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => { fetchData() })
</script>
