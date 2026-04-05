<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon variant="text" @click="$router.push({ name: 'pos.devices' })"><v-icon>mdi-arrow-left</v-icon></v-btn>
      <h1 class="text-h5 ml-2">{{ isNew ? 'New POS Device' : (device.name || 'POS Device') }}</h1>
      <v-spacer />
      <v-btn
        v-if="!isNew && device.connectionType === 'browser'"
        :color="fiscalBridge.status.value === 'connected' ? 'error' : 'success'"
        :loading="fiscalBridge.status.value === 'connecting'"
        :prepend-icon="fiscalBridge.status.value === 'connected' ? 'mdi-printer-off' : 'mdi-printer'"
        variant="outlined"
        size="small"
        class="mr-2"
        @click="toggleConnection"
      >
        {{ fiscalBridge.status.value === 'connected' ? 'Disconnect' : 'Connect' }}
      </v-btn>
      <v-chip v-if="!isNew && device.status" size="small" label :color="deviceStatusColor(device.status)" class="ml-2">
        {{ device.status }}
      </v-chip>
    </div>

    <v-progress-linear v-if="loading" indeterminate class="mb-4" />

    <v-card>
      <v-card-text>
        <v-tabs v-model="tab">
          <v-tab value="general">General</v-tab>
          <v-tab v-if="!isNew" value="operators">Operators</v-tab>
          <v-tab v-if="!isNew" value="reports">Reports</v-tab>
        </v-tabs>

        <v-tabs-window v-model="tab" class="mt-6 pt-4">
          <!-- Tab 1: General -->
          <v-tabs-window-item value="general">
            <v-form ref="formRef" @submit.prevent="handleSave">
              <v-row>
                <v-col cols="12" md="4">
                  <v-text-field v-model="device.name" label="Name" :rules="[rules.required]" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model="device.deviceNumber" label="Device Number" :rules="[rules.required, rules.deviceNumber]" maxlength="8" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-select v-model="device.manufacturer" label="Manufacturer" :items="manufacturers" :rules="[rules.required]" />
                </v-col>
              </v-row>
              <v-row>
                <v-col cols="12" md="4">
                  <v-select v-model="device.connectionType" label="Connection Type" :items="connectionTypes" :rules="[rules.required]" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-autocomplete
                    v-model="device.warehouseId"
                    label="Warehouse"
                    :items="warehouses"
                    item-title="name"
                    item-value="_id"
                    :loading="loadingWarehouses"
                    clearable
                  />
                </v-col>
                <v-col cols="12" md="4">
                  <v-switch v-model="device.isActive" label="Active" color="primary" />
                </v-col>
              </v-row>
              <div class="d-flex justify-end mt-4">
                <v-btn color="primary" type="submit" :loading="saving">
                  {{ isNew ? 'Create' : 'Save' }}
                </v-btn>
              </div>
            </v-form>
          </v-tabs-window-item>

          <!-- Tab 2: Operators -->
          <v-tabs-window-item value="operators">
            <v-table density="compact">
              <thead>
                <tr>
                  <th style="width: 60px">#</th>
                  <th>Name</th>
                  <th>Password</th>
                  <th style="width: 280px">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="op in operators" :key="op.number">
                  <td>{{ op.number }}</td>
                  <td>
                    <v-text-field v-model="op.name" density="compact" hide-details variant="outlined" />
                  </td>
                  <td>
                    <v-text-field v-model="op.password" type="password" density="compact" hide-details variant="outlined" />
                  </td>
                  <td>
                    <v-btn
                      size="small"
                      variant="outlined"
                      color="primary"
                      class="mr-2"
                      :loading="op.programming"
                      @click="programOperator(op)"
                    >
                      Program on Device
                    </v-btn>
                    <v-btn
                      size="small"
                      variant="outlined"
                      :loading="op.reading"
                      @click="readOperator(op)"
                    >
                      Read from Device
                    </v-btn>
                  </td>
                </tr>
              </tbody>
            </v-table>
          </v-tabs-window-item>

          <!-- Tab 3: Reports -->
          <v-tabs-window-item value="reports">
            <v-row>
              <!-- Daily X-Report -->
              <v-col cols="12" md="6" lg="4">
                <v-card variant="outlined">
                  <v-card-title class="text-subtitle-1">Daily X-Report</v-card-title>
                  <v-card-text>
                    <p class="text-body-2 text-medium-emphasis">Print daily X-report (without closing the day).</p>
                  </v-card-text>
                  <v-card-actions>
                    <v-spacer />
                    <v-btn color="primary" :loading="reportLoading.xReport" @click="printXReport">Print</v-btn>
                  </v-card-actions>
                </v-card>
              </v-col>

              <!-- Daily Z-Report -->
              <v-col cols="12" md="6" lg="4">
                <v-card variant="outlined">
                  <v-card-title class="text-subtitle-1">Daily Z-Report</v-card-title>
                  <v-card-text>
                    <p class="text-body-2 text-medium-emphasis">Print daily Z-report (closes the fiscal day).</p>
                  </v-card-text>
                  <v-card-actions>
                    <v-spacer />
                    <v-btn color="primary" :loading="reportLoading.zReport" @click="printZReport">Print</v-btn>
                  </v-card-actions>
                </v-card>
              </v-col>

              <!-- Operator Report -->
              <v-col cols="12" md="6" lg="4">
                <v-card variant="outlined">
                  <v-card-title class="text-subtitle-1">Operator Report</v-card-title>
                  <v-card-text>
                    <v-select
                      v-model="reportParams.operatorNumber"
                      label="Operator"
                      :items="operatorSelectOptions"
                      density="compact"
                      hide-details
                    />
                  </v-card-text>
                  <v-card-actions>
                    <v-spacer />
                    <v-btn color="primary" :loading="reportLoading.operatorReport" @click="printOperatorReport">Print</v-btn>
                  </v-card-actions>
                </v-card>
              </v-col>

              <!-- Fiscal Memory Report by Date -->
              <v-col cols="12" md="6" lg="4">
                <v-card variant="outlined">
                  <v-card-title class="text-subtitle-1">FM Report by Date</v-card-title>
                  <v-card-text>
                    <v-text-field v-model="reportParams.fmDateFrom" label="From" type="date" density="compact" hide-details class="mb-2" />
                    <v-text-field v-model="reportParams.fmDateTo" label="To" type="date" density="compact" hide-details class="mb-2" />
                    <v-switch v-model="reportParams.fmDateDetailed" label="Detailed" density="compact" hide-details color="primary" />
                  </v-card-text>
                  <v-card-actions>
                    <v-spacer />
                    <v-btn color="primary" :loading="reportLoading.fmReportDate" @click="printFmReportByDate">Print</v-btn>
                  </v-card-actions>
                </v-card>
              </v-col>

              <!-- Fiscal Memory Report by Number -->
              <v-col cols="12" md="6" lg="4">
                <v-card variant="outlined">
                  <v-card-title class="text-subtitle-1">FM Report by Number</v-card-title>
                  <v-card-text>
                    <v-text-field v-model.number="reportParams.fmStartNumber" label="Start Number" type="number" density="compact" hide-details class="mb-2" />
                    <v-text-field v-model.number="reportParams.fmEndNumber" label="End Number" type="number" density="compact" hide-details class="mb-2" />
                    <v-switch v-model="reportParams.fmNumberDetailed" label="Detailed" density="compact" hide-details color="primary" />
                  </v-card-text>
                  <v-card-actions>
                    <v-spacer />
                    <v-btn color="primary" :loading="reportLoading.fmReportNumber" @click="printFmReportByNumber">Print</v-btn>
                  </v-card-actions>
                </v-card>
              </v-col>

              <!-- Electronic Journal (KLEN) -->
              <v-col cols="12" md="6" lg="4">
                <v-card variant="outlined">
                  <v-card-title class="text-subtitle-1">Electronic Journal (KLEN)</v-card-title>
                  <v-card-text>
                    <v-text-field v-model="reportParams.ejDateFrom" label="From" type="date" density="compact" hide-details class="mb-2" />
                    <v-text-field v-model="reportParams.ejDateTo" label="To" type="date" density="compact" hide-details />
                  </v-card-text>
                  <v-card-actions>
                    <v-spacer />
                    <v-btn color="primary" :loading="reportLoading.ejReport" @click="printEjReport">Print</v-btn>
                  </v-card-actions>
                </v-card>
              </v-col>
            </v-row>
          </v-tabs-window-item>
        </v-tabs-window>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useFiscalBridge } from 'ui-shared/composables/useFiscalBridge'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const fiscalBridge = useFiscalBridge()

// Watch for device disconnect (USB unplugged / powered off)
watch(() => fiscalBridge.status.value, async (val) => {
  if (val === 'error' && fiscalBridge.errorMessage.value) {
    showError(fiscalBridge.errorMessage.value)
    device.status = 'error'
    if (!isNew.value) {
      try { await httpClient.put(`${deviceUrl.value}/${deviceId.value}`, { status: 'error' }) } catch {}
    }
  }
  if (val === 'connected' && fiscalBridge.deviceNumber.value) {
    showSuccess(`Device ${fiscalBridge.deviceNumber.value} reconnected`)
    device.status = 'online'
    if (!isNew.value) {
      try { await httpClient.put(`${deviceUrl.value}/${deviceId.value}`, { status: 'online' }) } catch {}
    }
  }
})

const isNew = computed(() => route.params.id === undefined || route.name === 'pos.devices.new')
const deviceId = computed(() => route.params.id as string)
const deviceUrl = computed(() => `${appStore.orgUrl()}/fiscal/device`)

const loading = ref(false)
const saving = ref(false)
const formRef = ref()
const tab = ref('general')

const device = reactive({
  name: '',
  deviceNumber: '',
  manufacturer: 'datecs' as string,
  connectionType: 'tcp' as string,
  warehouseId: null as string | null,
  isActive: true,
  status: '' as string,
})

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'pos',
  entityType: 'posDevice',
  icon: 'mdi-printer-pos',
  getFormData: () => ({ ...device }),
  getPreviewFields: () => [
    { label: 'Name', value: device.name },
    { label: 'Number', value: device.deviceNumber },
  ],
  setFormData: (data) => Object.assign(device, data),
  isEdit: () => !isNew.value,
  entityId: () => route.params.id as string,
})

const manufacturers = ['datecs', 'daisy', 'tremol', 'incotex']
const connectionTypes = ['serial', 'tcp', 'usb', 'browser']

const warehouses = ref<any[]>([])
const loadingWarehouses = ref(false)

const rules = {
  required: (v: any) => !!v || 'Required',
  deviceNumber: (v: string) => (v && v.length === 8) || 'Must be 8 characters',
}

// Operators
const operators = ref(
  Array.from({ length: 8 }, (_, i) => ({
    number: i + 1,
    name: '',
    password: '',
    programming: false,
    reading: false,
  }))
)

// Reports
const reportParams = reactive({
  operatorNumber: 0,
  fmDateFrom: '',
  fmDateTo: '',
  fmDateDetailed: false,
  fmStartNumber: null as number | null,
  fmEndNumber: null as number | null,
  fmNumberDetailed: false,
  ejDateFrom: '',
  ejDateTo: '',
})

const reportLoading = reactive({
  xReport: false,
  zReport: false,
  operatorReport: false,
  fmReportDate: false,
  fmReportNumber: false,
  ejReport: false,
})

const operatorSelectOptions = [
  { title: 'All Operators', value: 0 },
  ...Array.from({ length: 8 }, (_, i) => ({ title: `Operator ${i + 1}`, value: i + 1 })),
]

function deviceStatusColor(s: string) {
  const map: Record<string, string> = {
    online: 'success',
    offline: 'grey',
    error: 'error',
  }
  return map[s] || 'grey'
}

async function toggleConnection() {
  if (fiscalBridge.status.value === 'connected') {
    await fiscalBridge.disconnect()
    try { await httpClient.put(`${deviceUrl.value}/${deviceId.value}`, { status: 'offline' }) } catch {}
    device.status = 'offline'
    showSuccess('Device disconnected')
    return
  }
  try {
    const ok = await fiscalBridge.requestPort()
    if (!ok) return
    await fiscalBridge.connect(appStore.currentOrg!.id, device.deviceNumber, device.warehouseId || '')
    try { await httpClient.put(`${deviceUrl.value}/${deviceId.value}`, { status: 'online' }) } catch {}
    device.status = 'online'
    showSuccess(`Connected to ${device.deviceNumber}`)
  } catch (e: any) {
    showError(e.message || 'Connection failed')
  }
}

async function fetchWarehouses() {
  loadingWarehouses.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`, { params: { size: 0 } })
    warehouses.value = (data.warehouses || []).map((w: any) => ({ ...w, _id: w._id || w.id }))
  } catch {
    warehouses.value = []
  } finally {
    loadingWarehouses.value = false
  }
}

async function fetchDevice() {
  if (isNew.value) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${deviceUrl.value}/${deviceId.value}`)
    const d = data.fiscalDevice || data
    Object.assign(device, {
      name: d.name || '',
      deviceNumber: d.deviceNumber || '',
      manufacturer: d.manufacturer || 'datecs',
      connectionType: d.connectionType || 'tcp',
      warehouseId: d.warehouseId || null,
      isActive: d.isActive !== false,
      status: d.status || '',
    })
  } catch (e: any) {
    showError(e?.response?.data?.message || 'Failed to load device')
  } finally {
    loading.value = false
  }
}

async function handleSave() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  saving.value = true
  try {
    const payload = {
      name: device.name,
      deviceNumber: device.deviceNumber,
      manufacturer: device.manufacturer,
      connectionType: device.connectionType,
      warehouseId: device.warehouseId,
      isActive: device.isActive,
    }

    if (isNew.value) {
      const { data } = await httpClient.post(deviceUrl.value, payload)
      markSaved()
      showSuccess('Device created')
      const newId = data.fiscalDevice?._id || data.fiscalDevice?.id || data._id || data.id
      if (newId) {
        router.replace({ name: 'pos.devices.detail', params: { id: newId } })
      }
    } else {
      await httpClient.put(`${deviceUrl.value}/${deviceId.value}`, payload)
      markSaved()
      showSuccess('Device saved')
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || 'Failed to save device')
  } finally {
    saving.value = false
  }
}

// Operator actions
async function programOperator(op: any) {
  op.programming = true
  try {
    await httpClient.post(`${deviceUrl.value}/${deviceId.value}/program-operator`, {
      operatorNumber: op.number,
      name: op.name,
      password: op.password,
    })
    showSuccess(`Operator ${op.number} programmed on device`)
  } catch (e: any) {
    showError(e?.response?.data?.message || `Failed to program operator ${op.number}`)
  } finally {
    op.programming = false
  }
}

async function readOperator(op: any) {
  op.reading = true
  try {
    const { data } = await httpClient.post(`${deviceUrl.value}/${deviceId.value}/read-operator`, {
      operatorNumber: op.number,
    })
    const result = data.operator || data
    if (result.name !== undefined) op.name = result.name.trim()
    if (result.password !== undefined) op.password = result.password.trim()
    showSuccess(`Operator ${op.number} read from device`)
  } catch (e: any) {
    showError(e?.response?.data?.message || `Failed to read operator ${op.number}`)
  } finally {
    op.reading = false
  }
}

// Report actions
async function printXReport() {
  reportLoading.xReport = true
  try {
    await httpClient.post(`${deviceUrl.value}/${deviceId.value}/x-report`)
    showSuccess('X-Report printed')
  } catch (e: any) {
    showError(e?.response?.data?.message || 'Failed to print X-Report')
  } finally {
    reportLoading.xReport = false
  }
}

async function printZReport() {
  reportLoading.zReport = true
  try {
    await httpClient.post(`${deviceUrl.value}/${deviceId.value}/z-report`)
    showSuccess('Z-Report printed')
  } catch (e: any) {
    showError(e?.response?.data?.message || 'Failed to print Z-Report')
  } finally {
    reportLoading.zReport = false
  }
}

async function printOperatorReport() {
  reportLoading.operatorReport = true
  try {
    await httpClient.post(`${deviceUrl.value}/${deviceId.value}/operator-report`, {
      operatorNumber: reportParams.operatorNumber,
    })
    showSuccess('Operator report printed')
  } catch (e: any) {
    showError(e?.response?.data?.message || 'Failed to print operator report')
  } finally {
    reportLoading.operatorReport = false
  }
}

async function printFmReportByDate() {
  reportLoading.fmReportDate = true
  try {
    await httpClient.post(`${deviceUrl.value}/${deviceId.value}/fm-report`, {
      type: 'by_date',
      startDate: reportParams.fmDateFrom,
      endDate: reportParams.fmDateTo,
      detailed: reportParams.fmDateDetailed,
    })
    showSuccess('FM report printed')
  } catch (e: any) {
    showError(e?.response?.data?.message || 'Failed to print FM report')
  } finally {
    reportLoading.fmReportDate = false
  }
}

async function printFmReportByNumber() {
  reportLoading.fmReportNumber = true
  try {
    await httpClient.post(`${deviceUrl.value}/${deviceId.value}/fm-report`, {
      type: 'by_number',
      startNumber: reportParams.fmStartNumber,
      endNumber: reportParams.fmEndNumber,
      detailed: reportParams.fmNumberDetailed,
    })
    showSuccess('FM report printed')
  } catch (e: any) {
    showError(e?.response?.data?.message || 'Failed to print FM report')
  } finally {
    reportLoading.fmReportNumber = false
  }
}

async function printEjReport() {
  reportLoading.ejReport = true
  try {
    await httpClient.post(`${deviceUrl.value}/${deviceId.value}/ej-report`, {
      startDate: reportParams.ejDateFrom,
      endDate: reportParams.ejDateTo,
    })
    showSuccess('Electronic journal report printed')
  } catch (e: any) {
    showError(e?.response?.data?.message || 'Failed to print EJ report')
  } finally {
    reportLoading.ejReport = false
  }
}

onMounted(async () => {
  await fetchWarehouses()
  if (tryRestore()) return
  fetchDevice()
})
</script>
