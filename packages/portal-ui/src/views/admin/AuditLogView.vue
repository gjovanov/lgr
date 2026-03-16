<template>
  <v-container fluid>
    <h1 class="text-h4 mb-4">{{ $t('admin.auditLog') }}</h1>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row dense>
          <v-col cols="12" sm="6" md="2">
            <v-select v-model="filters.modules" :label="$t('admin.module')" :items="filterOptions.modules" multiple chips closable-chips density="compact" clearable hide-details />
          </v-col>
          <v-col cols="12" sm="6" md="2">
            <v-select v-model="filters.entityTypes" :label="$t('admin.entityType') || 'Entity Type'" :items="filterOptions.entityTypes" multiple chips closable-chips density="compact" clearable hide-details />
          </v-col>
          <v-col cols="12" sm="6" md="2">
            <v-select v-model="filters.actions" :label="$t('admin.action')" :items="filterOptions.actions" multiple chips closable-chips density="compact" clearable hide-details />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-autocomplete
              v-model="filters.userIds"
              :label="$t('admin.user')"
              :items="userResults"
              item-title="label"
              item-value="id"
              multiple
              chips
              closable-chips
              density="compact"
              clearable
              hide-details
              :loading="searchingUsers"
              @update:search="onUserSearch"
            />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-autocomplete
              v-model="filters.entityIds"
              :label="$t('admin.entity') || 'Search Objects'"
              :items="entityResults"
              item-title="label"
              item-value="id"
              multiple
              chips
              closable-chips
              density="compact"
              clearable
              hide-details
              :loading="searchingEntities"
              :disabled="filters.entityTypes.length !== 1"
              :hint="filters.entityTypes.length !== 1 ? 'Select exactly one entity type first' : ''"
              persistent-hint
              @update:search="onEntitySearch"
            />
          </v-col>
        </v-row>
        <v-row dense class="mt-1">
          <v-col cols="12" sm="3" md="2">
            <v-text-field v-model="filters.dateFrom" :label="$t('common.from')" type="date" density="compact" hide-details clearable />
          </v-col>
          <v-col cols="12" sm="3" md="2">
            <v-text-field v-model="filters.dateTo" :label="$t('common.to')" type="date" density="compact" hide-details clearable />
          </v-col>
          <v-col cols="12" sm="6" md="8" class="d-flex align-center justify-end ga-2">
            <v-btn variant="outlined" size="small" @click="resetFilters">{{ $t('common.reset') }}</v-btn>
            <v-btn color="primary" size="small" @click="applyFilters">{{ $t('common.filter') }}</v-btn>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Audit Log Table -->
    <v-card>
      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="store.auditLogs"
          :items-length="store.total"
          :loading="store.loading"
          :page="store.page + 1"
          :items-per-page="pageSize"
          @update:options="onUpdateOptions"
          item-value="_id"
          hover
          show-expand
        >
          <template #item.timestamp="{ item }">
            <span class="text-caption">{{ formatDateTime(item.timestamp) }}</span>
          </template>
          <template #item.action="{ item }">
            <v-chip :color="actionColor(item.action)" size="x-small" label>{{ item.action }}</v-chip>
          </template>
          <template #item.module="{ item }">
            <v-chip size="x-small" variant="outlined">{{ item.module }}</v-chip>
          </template>
          <template #item.entityType="{ item }">
            <span class="text-caption">{{ item.entityType }}</span>
          </template>
          <template #item.entityName="{ item }">
            <a v-if="entityUrl(item.entityType, item.entityId)" :href="entityUrl(item.entityType, item.entityId)" class="text-primary text-decoration-none font-weight-medium" @click.stop>
              {{ item.entityName || item.entityId }}
            </a>
            <span v-else>{{ item.entityName || item.entityId }}</span>
          </template>
          <template #expanded-row="{ columns, item }">
            <tr>
              <td :colspan="columns.length" class="pa-4">
                <div v-if="item.changes?.length" class="mb-2">
                  <div class="text-subtitle-2 mb-2">{{ $t('admin.changeDetails') }}</div>
                  <v-table density="compact">
                    <thead>
                      <tr>
                        <th>{{ $t('admin.field') }}</th>
                        <th>{{ $t('admin.oldValue') }}</th>
                        <th>{{ $t('admin.newValue') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(change, i) in item.changes" :key="i">
                        <td class="font-weight-medium">{{ change.field }}</td>
                        <td class="text-error text-caption" style="max-width:300px;overflow:hidden;text-overflow:ellipsis">{{ formatValue(change.oldValue) }}</td>
                        <td class="text-success text-caption" style="max-width:300px;overflow:hidden;text-overflow:ellipsis">{{ formatValue(change.newValue) }}</td>
                      </tr>
                    </tbody>
                  </v-table>
                </div>
                <div v-else class="text-medium-emphasis">{{ $t('admin.noChanges') }}</div>
                <!-- Correlated entries (bulk operations) -->
                <div v-if="item.correlationId" class="mt-3">
                  <div class="d-flex align-center mb-2">
                    <span class="text-subtitle-2">Related Entries</span>
                    <v-btn v-if="!correlatedCache[item.correlationId]" size="x-small" variant="text" color="primary" class="ml-2" :loading="loadingCorrelated[item.correlationId]" @click="fetchCorrelated(item.correlationId)">Load</v-btn>
                  </div>
                  <v-table v-if="correlatedCache[item.correlationId]?.length" density="compact">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Action</th>
                        <th>Changes</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="ce in correlatedCache[item.correlationId]" :key="ce._id">
                        <td>
                          <a v-if="entityUrl(ce.entityType, ce.entityId)" :href="entityUrl(ce.entityType, ce.entityId)" class="text-primary text-decoration-none font-weight-medium">{{ ce.entityName || ce.entityId }}</a>
                          <span v-else>{{ ce.entityName || ce.entityId }}</span>
                        </td>
                        <td><v-chip :color="actionColor(ce.action)" size="x-small" label>{{ ce.action }}</v-chip></td>
                        <td>
                          <span v-for="(c, ci) in (ce.changes || []).slice(0, 3)" :key="ci" class="text-caption">
                            {{ c.field }}: {{ formatValue(c.oldValue) }} → {{ formatValue(c.newValue) }}<br>
                          </span>
                          <span v-if="(ce.changes || []).length > 3" class="text-caption text-medium-emphasis">+{{ ce.changes.length - 3 }} more</span>
                        </td>
                      </tr>
                    </tbody>
                  </v-table>
                </div>

                <div class="mt-2 text-caption text-medium-emphasis">
                  ID: {{ item.entityId }}
                  <span v-if="item.ipAddress"> | IP: {{ item.ipAddress }}</span>
                </div>
              </td>
            </tr>
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '../../store/admin.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from '../../store/app.store'

const { t } = useI18n()
const store = useAdminStore()
const appStore = useAppStore()

const pageSize = ref(25)
const correlatedCache = ref<Record<string, any[]>>({})
const loadingCorrelated = ref<Record<string, boolean>>({})

const filterOptions = reactive({ modules: [] as string[], actions: [] as string[], entityTypes: [] as string[] })
const userResults = ref<{ id: string; label: string }[]>([])
const entityResults = ref<{ id: string; label: string }[]>([])
const searchingUsers = ref(false)
const searchingEntities = ref(false)

const filters = reactive({
  modules: [] as string[],
  entityTypes: [] as string[],
  actions: [] as string[],
  userIds: [] as string[],
  entityIds: [] as string[],
  dateFrom: '',
  dateTo: '',
})

const headers = [
  { title: t('admin.timestamp'), key: 'timestamp', width: 160 },
  { title: t('admin.user'), key: 'userName', width: 140 },
  { title: t('admin.module'), key: 'module', width: 100 },
  { title: t('admin.entity'), key: 'entityType', width: 120 },
  { title: t('common.name'), key: 'entityName' },
  { title: t('admin.action'), key: 'action', width: 120 },
]

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

let userDebounce: ReturnType<typeof setTimeout> | null = null
function onUserSearch(q: string) {
  if (userDebounce) clearTimeout(userDebounce)
  if (!q || q.length < 2) return
  userDebounce = setTimeout(async () => {
    searchingUsers.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/audit-logs/search-users`, { params: { q } })
      userResults.value = data.results || []
    } catch { /* */ } finally { searchingUsers.value = false }
  }, 300)
}

let entityDebounce: ReturnType<typeof setTimeout> | null = null
function onEntitySearch(q: string) {
  if (entityDebounce) clearTimeout(entityDebounce)
  if (!q || q.length < 2 || filters.entityTypes.length !== 1) return
  entityDebounce = setTimeout(async () => {
    searchingEntities.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/audit-logs/search-entities`, { params: { entityType: filters.entityTypes[0], q } })
      entityResults.value = data.results || []
    } catch { /* */ } finally { searchingEntities.value = false }
  }, 300)
}

function applyFilters() {
  const params: Record<string, any> = { page: 0, pageSize: pageSize.value }
  if (filters.modules.length) params.modules = filters.modules.join(',')
  if (filters.entityTypes.length) params.entityTypes = filters.entityTypes.join(',')
  if (filters.actions.length) params.actions = filters.actions.join(',')
  if (filters.userIds.length) params.userIds = filters.userIds.join(',')
  if (filters.entityIds.length) params.entityIds = filters.entityIds.join(',')
  if (filters.dateFrom) params.dateFrom = filters.dateFrom
  if (filters.dateTo) params.dateTo = filters.dateTo
  store.fetchAuditLogs(params)
}

function resetFilters() {
  Object.assign(filters, { modules: [], entityTypes: [], actions: [], userIds: [], entityIds: [], dateFrom: '', dateTo: '' })
  store.fetchAuditLogs({ page: 0, pageSize: pageSize.value })
}

function onUpdateOptions(opts: any) {
  pageSize.value = opts.itemsPerPage || 25
  applyFilters()
}

function formatDateTime(date: string) {
  return date ? new Date(date).toLocaleString() : ''
}

function formatValue(val: any) {
  if (val === null || val === undefined) return '-'
  if (typeof val === 'object') return JSON.stringify(val).slice(0, 200)
  return String(val)
}

function actionColor(action: string) {
  const colors: Record<string, string> = {
    create: 'success', update: 'info', delete: 'error',
    send: 'primary', void: 'orange', approve: 'green', reject: 'red',
    post: 'purple', confirm: 'teal', execute: 'indigo',
    record_payment: 'blue', bulk_price_adjust: 'amber',
    calculate: 'cyan', close: 'brown', convert: 'lime',
    complete: 'green', cancel: 'grey', revoke: 'red',
    stage_change: 'blue-grey',
  }
  return colors[action] || 'grey'
}

async function fetchFilterOptions() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/audit-logs/filters`)
    filterOptions.modules = data.modules || []
    filterOptions.actions = data.actions || []
    filterOptions.entityTypes = data.entityTypes || []
  } catch { /* */ }
}

// Entity URL mapping for clickable links
const ENTITY_URL_MAP: Record<string, { base: string; path: string; hasDetail: boolean }> = {
  product: { base: '/trade', path: 'products', hasDetail: true },
  contact: { base: '/trade', path: 'contacts', hasDetail: true },
  invoice: { base: '/trade', path: 'invoices', hasDetail: true },
  warehouse: { base: '/trade', path: 'warehouses', hasDetail: false },
  stock_movement: { base: '/trade', path: 'movements', hasDetail: false },
  inventory_count: { base: '/trade', path: 'inventory-counts', hasDetail: false },
  price_list: { base: '/trade', path: 'price-lists', hasDetail: false },
  cash_order: { base: '/trade', path: 'cash-orders', hasDetail: false },
  payment_order: { base: '/trade', path: 'payment-orders', hasDetail: false },
  account: { base: '/accounting', path: 'accounts', hasDetail: false },
  journal_entry: { base: '/accounting', path: 'journal-entries', hasDetail: true },
  fixed_asset: { base: '/accounting', path: 'fixed-assets', hasDetail: false },
  bank_account: { base: '/accounting', path: 'bank-accounts', hasDetail: false },
  exchange_rate: { base: '/accounting', path: 'exchange-rates', hasDetail: false },
  employee: { base: '/payroll', path: 'employees', hasDetail: true },
  payroll_run: { base: '/payroll', path: 'runs', hasDetail: false },
  department: { base: '/hr', path: 'departments', hasDetail: false },
  lead: { base: '/crm', path: 'leads', hasDetail: false },
  deal: { base: '/crm', path: 'deals', hasDetail: false },
  activity: { base: '/crm', path: 'activities', hasDetail: false },
  bom: { base: '/erp', path: 'bom', hasDetail: false },
  production_order: { base: '/erp', path: 'production-orders', hasDetail: false },
  construction_project: { base: '/erp', path: 'construction-projects', hasDetail: false },
}

function entityUrl(entityType: string, entityId: string): string | null {
  const cfg = ENTITY_URL_MAP[entityType]
  if (!cfg) return null
  return cfg.hasDetail ? `${cfg.base}/${cfg.path}/${entityId}/edit` : `${cfg.base}/${cfg.path}`
}

async function fetchCorrelated(correlationId: string) {
  if (correlatedCache.value[correlationId]) return
  loadingCorrelated.value[correlationId] = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/audit-logs/correlation/${correlationId}`)
    correlatedCache.value[correlationId] = (data.entries || []).filter((e: any) => e.action !== 'bulk_price_adjust')
  } catch { /* */ } finally {
    loadingCorrelated.value[correlationId] = false
  }
}

onMounted(async () => {
  await fetchFilterOptions()
  store.fetchAuditLogs({ page: 0, pageSize: pageSize.value })
})
</script>
