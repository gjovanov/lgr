<template>
  <v-container fluid>
    <h1 class="text-h4 mb-4">{{ $t('admin.auditLog') }}</h1>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row>
          <v-col cols="12" sm="3">
            <v-select v-model="filters.module" :label="$t('admin.module')" :items="modules" clearable density="compact" />
          </v-col>
          <v-col cols="12" sm="3">
            <v-text-field v-model="filters.userId" :label="$t('admin.user')" clearable density="compact" />
          </v-col>
          <v-col cols="12" sm="2">
            <v-select v-model="filters.action" :label="$t('admin.action')" :items="actions" clearable density="compact" />
          </v-col>
          <v-col cols="12" sm="2">
            <v-text-field v-model="filters.dateFrom" :label="$t('common.from')" type="date" density="compact" />
          </v-col>
          <v-col cols="12" sm="2">
            <v-text-field v-model="filters.dateTo" :label="$t('common.to')" type="date" density="compact" />
          </v-col>
        </v-row>
        <div class="d-flex justify-end">
          <v-btn variant="outlined" class="mr-2" @click="resetFilters">{{ $t('common.reset') }}</v-btn>
          <v-btn color="primary" @click="applyFilters">{{ $t('common.filter') }}</v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- Audit Log Table -->
    <DataTable :headers="headers" :items="store.auditLogs" :loading="store.loading">
      <template #item.timestamp="{ item }">
        {{ formatDateTime(item.timestamp) }}
      </template>
      <template #item.action="{ item }">
        <v-chip :color="actionColor(item.action)" size="small">{{ item.action }}</v-chip>
      </template>
      <template #item.module="{ item }">
        <v-chip size="small" variant="outlined">{{ item.module }}</v-chip>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-chevron-down" size="small" variant="text" @click="toggleExpand(item._id)" />
      </template>
      <template #expanded-row="{ columns, item }">
        <tr>
          <td :colspan="columns.length">
            <v-card flat class="ma-2">
              <v-card-text>
                <div class="text-subtitle-2 mb-2">{{ $t('admin.changeDetails') }}</div>
                <v-table v-if="item.changes?.length" density="compact">
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
                      <td class="text-error">{{ change.oldValue ?? '-' }}</td>
                      <td class="text-success">{{ change.newValue ?? '-' }}</td>
                    </tr>
                  </tbody>
                </v-table>
                <div v-else class="text-grey">{{ $t('admin.noChanges') }}</div>

                <div v-if="item.metadata" class="mt-3">
                  <div class="text-subtitle-2 mb-1">{{ $t('admin.metadata') }}</div>
                  <v-chip v-if="item.metadata.ip" size="small" class="mr-1">IP: {{ item.metadata.ip }}</v-chip>
                  <v-chip v-if="item.metadata.userAgent" size="small" class="mr-1">{{ item.metadata.userAgent }}</v-chip>
                </div>
              </v-card-text>
            </v-card>
          </td>
        </tr>
      </template>
    </DataTable>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '../../store/admin.store'
import DataTable from 'ui-shared/components/DataTable'

const { t } = useI18n()
const store = useAdminStore()

const expanded = ref<string[]>([])

const modules = ['Accounting', 'Invoicing', 'Warehouse', 'Payroll', 'HR', 'CRM', 'ERP', 'Settings', 'Admin', 'Auth']
const actions = ['create', 'update', 'delete', 'login', 'logout', 'export', 'approve', 'reject']

const headers = [
  { title: t('admin.timestamp'), key: 'timestamp' },
  { title: t('admin.user'), key: 'userName' },
  { title: t('admin.action'), key: 'action' },
  { title: t('admin.module'), key: 'module' },
  { title: t('admin.entity'), key: 'entityType' },
  { title: t('admin.entityId'), key: 'entityId' },
  { title: '', key: 'actions', sortable: false, width: 50 },
]

const filters = reactive({
  module: '',
  userId: '',
  action: '',
  dateFrom: '',
  dateTo: '',
})

function toggleExpand(id: string) {
  const idx = expanded.value.indexOf(id)
  if (idx >= 0) expanded.value.splice(idx, 1)
  else expanded.value.push(id)
}

function applyFilters() {
  store.fetchAuditLogs({ ...filters })
}

function resetFilters() {
  Object.assign(filters, { module: '', userId: '', action: '', dateFrom: '', dateTo: '' })
  store.fetchAuditLogs()
}

function formatDateTime(date: string) {
  return new Date(date).toLocaleString()
}

function actionColor(action: string) {
  const colors: Record<string, string> = {
    create: 'success', update: 'info', delete: 'error',
    login: 'purple', logout: 'grey', export: 'primary',
    approve: 'green', reject: 'red',
  }
  return colors[action] || 'grey'
}

onMounted(() => store.fetchAuditLogs())
</script>
