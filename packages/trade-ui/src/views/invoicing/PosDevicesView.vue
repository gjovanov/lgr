<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">POS Devices</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" :to="{ name: 'invoicing.pos-devices.new' }">
        New Device
      </v-btn>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="2">
            <v-select
              v-model="statusFilter"
              :label="$t('common.status')"
              :items="statusOptions"
              clearable
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="12" md="2">
            <v-select
              v-model="activeFilter"
              label="Active"
              :items="activeOptions"
              clearable
              hide-details
              density="compact"
            />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Data Table -->
    <v-card>
      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="pagination.total"
          :loading="loading"
          :page="pagination.page + 1"
          :items-per-page="pagination.size"
          @update:options="onUpdateOptions"
          item-value="_id"
          hover
        >
          <template #item.name="{ item }">
            <entity-link :label="item.name" :to="{ name: 'invoicing.pos-devices.detail', params: { id: item._id || item.id } }" />
          </template>
          <template #item.status="{ item }">
            <v-chip size="small" label :color="deviceStatusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.lastCommunication="{ item }">
            {{ item.lastCommunication ? formatDateTime(item.lastCommunication) : '-' }}
          </template>
          <template #item.actions="{ item }">
            <v-btn
              v-if="item.connectionType === 'browser'"
              size="small"
              variant="outlined"
              :color="connectedDeviceId === (item._id || item.id) ? 'error' : 'success'"
              :loading="connectingDeviceId === (item._id || item.id)"
              :prepend-icon="connectedDeviceId === (item._id || item.id) ? 'mdi-printer-off' : 'mdi-printer'"
              @click="toggleConnection(item)"
            >
              {{ connectedDeviceId === (item._id || item.id) ? 'Disconnect' : 'Connect' }}
            </v-btn>
            <span v-else class="text-medium-emphasis text-caption">{{ item.connectionType }}</span>
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useFiscalBridge } from 'ui-shared/composables/useFiscalBridge'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import EntityLink from 'ui-shared/components/EntityLink'

const { t } = useI18n()
const appStore = useAppStore()
const fiscalBridge = useFiscalBridge()
const { showSuccess, showError } = useSnackbar()

// Watch for device disconnect (USB unplugged / powered off)
watch(() => fiscalBridge.status.value, (val) => {
  if (val === 'error' && fiscalBridge.errorMessage.value) {
    showError(fiscalBridge.errorMessage.value)
    connectedDeviceId.value = null
    fetchItems()
  }
  if (val === 'connected' && fiscalBridge.deviceNumber.value) {
    showSuccess(`Device ${fiscalBridge.deviceNumber.value} reconnected`)
    fetchItems()
  }
})

const statusFilter = ref<string | null>(null)
const activeFilter = ref<string | null>(null)

const statusOptions = ['online', 'offline', 'error']
const activeOptions = [
  { title: 'Yes', value: 'true' },
  { title: 'No', value: 'false' },
]

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (statusFilter.value) f.status = statusFilter.value
  if (activeFilter.value) f.isActive = activeFilter.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/fiscal/device`),
  entityKey: 'fiscalDevices',
  filters,
})

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: 'Device Number', key: 'deviceNumber', sortable: true },
  { title: 'Manufacturer', key: 'manufacturer', sortable: true },
  { title: 'Connection Type', key: 'connectionType', sortable: true },
  { title: t('common.status'), key: 'status', sortable: true },
  { title: 'Last Communication', key: 'lastCommunication', sortable: true },
  { title: 'Actions', key: 'actions', sortable: false, width: 160 },
])

function formatDateTime(dateStr: string) {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  return d.toLocaleString()
}

const connectedDeviceId = ref<string | null>(null)
const connectingDeviceId = ref<string | null>(null)

async function updateDeviceStatus(id: string, status: string) {
  try {
    await httpClient.put(`${appStore.orgUrl()}/fiscal/device/${id}`, { status })
  } catch { /* best-effort status update */ }
}

async function toggleConnection(item: any) {
  const id = item._id || item.id
  if (connectedDeviceId.value === id) {
    // Disconnect
    await fiscalBridge.disconnect()
    connectedDeviceId.value = null
    await updateDeviceStatus(id, 'offline')
    await fetchItems()
    showSuccess('Device disconnected')
    return
  }

  connectingDeviceId.value = id
  try {
    const ok = await fiscalBridge.requestPort()
    if (!ok) { connectingDeviceId.value = null; return }
    await fiscalBridge.connect(appStore.currentOrg!.id, item.deviceNumber, item.warehouseId)
    connectedDeviceId.value = id
    await updateDeviceStatus(id, 'online')
    await fetchItems()
    showSuccess(`Connected to ${item.deviceNumber}`)
  } catch (e: any) {
    showError(e.message || 'Connection failed')
  } finally {
    connectingDeviceId.value = null
  }
}

function deviceStatusColor(s: string) {
  const map: Record<string, string> = {
    online: 'success',
    offline: 'grey',
    error: 'error',
  }
  return map[s] || 'grey'
}

onMounted(() => {
  fetchItems()
})
</script>
