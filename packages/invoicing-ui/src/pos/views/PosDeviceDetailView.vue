<template>
  <EntityFormShell
    :title="isNew ? t('pos.device.newTitle') : (device.name || t('pos.device.title'))"
    :subtitle="!isNew && device.deviceNumber ? device.deviceNumber : ''"
    :status="!isNew && device.status ? { steps: ['offline', 'online', 'error'].map(s => `pos.device.states.${s}`), current: `pos.device.states.${device.status}` } : undefined"
    :actions="formActions"
    :loading="loading"
    back-to="/configuration/devices"
    :back-label="t('nav.devices')"
  >
    <v-form ref="formRef" @submit.prevent="handleSave">
      <v-tabs v-model="tab">
        <v-tab value="general">{{ t('pos.device.tabs.general') }}</v-tab>
        <v-tab v-if="!isNew" value="operators">{{ t('pos.device.tabs.operators') }}</v-tab>
        <v-tab v-if="!isNew" value="reports">{{ t('pos.device.tabs.reports') }}</v-tab>
      </v-tabs>

      <v-tabs-window v-model="tab" class="mt-6 pt-4">
        <!-- Tab 1: General -->
        <v-tabs-window-item value="general">
          <v-row>
            <v-col cols="12" md="4">
              <v-text-field v-model="device.name" :label="t('common.name')" :rules="[rules.required]" density="compact" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field
                v-model="device.deviceNumber"
                :label="t('pos.device.number')"
                :rules="[rules.required, rules.deviceNumber]"
                maxlength="8"
                :hint="t('pos.device.numberHint')"
                persistent-hint
                density="compact"
                @blur="device.deviceNumber = device.deviceNumber.trim().toUpperCase()"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-select v-model="device.manufacturer" :label="t('pos.device.manufacturer')" :items="manufacturers" :rules="[rules.required]" density="compact" />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" md="4">
              <v-select v-model="device.connectionType" :label="t('pos.device.connectionType')" :items="connectionTypes" :rules="[rules.required]" density="compact" />
            </v-col>
            <v-col cols="12" md="4">
              <v-autocomplete
                v-model="device.warehouseId"
                :label="t('warehouse.warehouse')"
                :items="warehouses"
                item-title="name"
                item-value="_id"
                :loading="loadingWarehouses"
                clearable
                density="compact"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-switch v-model="device.isActive" :label="t('common.active')" color="primary" density="compact" />
            </v-col>
          </v-row>
          <!-- A TCP device is opened by the LGR server itself, so it needs an address the server can
               reach: on lgrai.app a public one, on an on-prem LGR server one on the shop's network. -->
          <v-row v-if="device.connectionType === 'tcp'">
            <v-col cols="12" md="4">
              <v-text-field
                v-model="device.ip"
                :label="t('pos.device.ip')"
                :rules="[rules.required]"
                :hint="t('pos.device.ipHint')"
                persistent-hint
                density="compact"
              />
            </v-col>
            <v-col cols="12" md="2">
              <v-text-field v-model.number="device.tcpPort" :label="t('pos.device.port')" type="number" density="compact" />
            </v-col>
          </v-row>
        </v-tabs-window-item>

        <!-- Tab 2: Operators -->
        <v-tabs-window-item value="operators">
          <!-- What this device cannot do with its operators, and how an Eltrade's password works -->
          <v-alert v-if="operatorNotes.length" type="info" variant="tonal" density="compact" class="mb-4" data-testid="operator-notes">
            <div v-for="note in operatorNotes" :key="note">{{ note }}</div>
          </v-alert>
          <v-table density="compact" data-testid="operators">
            <thead>
              <tr>
                <th style="width: 60px">#</th>
                <th>{{ t('common.name') }}</th>
                <th>{{ t('pos.device.operators.password') }}</th>
                <th style="width: 280px">{{ t('common.actions') }}</th>
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
                    :disabled="!has('programOperator')"
                    :loading="op.programming"
                    @click="programOperator(op)"
                  >
                    {{ t('pos.device.operators.program') }}
                  </v-btn>
                  <v-btn
                    size="small"
                    variant="outlined"
                    :disabled="!has('readOperator')"
                    :loading="op.reading"
                    @click="readOperator(op)"
                  >
                    {{ t('pos.device.operators.read') }}
                  </v-btn>
                </td>
              </tr>
            </tbody>
          </v-table>
        </v-tabs-window-item>

        <!-- Tab 3: Reports -->
        <v-tabs-window-item value="reports">
          <v-row>
            <!-- Device status: what the device itself reports — the first thing to check in the field -->
            <v-col cols="12">
              <v-card variant="outlined">
                <v-card-title class="text-subtitle-1">{{ t('pos.device.status.title') }}</v-card-title>
                <v-card-text>
                  <p v-if="!deviceStatus" class="text-body-2 text-medium-emphasis">
                    {{ t('pos.device.status.hint') }}
                  </p>
                  <v-table v-else density="compact">
                    <tbody>
                      <tr><td style="width: 220px">{{ t('pos.device.status.responding') }}</td><td>{{ deviceStatus.connected ? t('common.yes') : t('common.no') }}</td></tr>
                      <tr v-if="deviceStatus.model"><td>{{ t('pos.device.status.model') }}</td><td>{{ deviceStatus.model }}</td></tr>
                      <tr v-if="deviceStatus.serialNumber">
                        <td>{{ t('pos.device.status.serial') }}</td>
                        <td>
                          {{ deviceStatus.serialNumber }}
                          <v-chip v-if="deviceStatus.serialNumber.toUpperCase() !== device.deviceNumber.toUpperCase()" color="error" size="x-small" class="ml-2">
                            {{ t('pos.device.status.mismatch', { device: device.deviceNumber }) }}
                          </v-chip>
                        </td>
                      </tr>
                      <tr v-if="deviceStatus.fiscalMemoryNumber"><td>{{ t('pos.device.status.fiscalMemory') }}</td><td>{{ deviceStatus.fiscalMemoryNumber }}</td></tr>
                      <tr v-if="deviceStatus.firmwareVersion"><td>{{ t('pos.device.status.firmware') }}</td><td>{{ deviceStatus.firmwareVersion }}</td></tr>
                      <tr v-if="deviceStatus.fiscalized !== undefined"><td>{{ t('pos.device.status.fiscalized') }}</td><td>{{ deviceStatus.fiscalized ? t('common.yes') : t('pos.device.status.notFiscalized') }}</td></tr>
                      <tr v-if="deviceStatus.dateTime"><td>{{ t('pos.device.status.clock') }}</td><td>{{ new Date(deviceStatus.dateTime).toLocaleString() }}</td></tr>
                      <tr v-if="deviceStatus.lastReceiptNumber !== undefined"><td>{{ t('pos.device.status.lastDocument') }}</td><td>{{ deviceStatus.lastReceiptNumber }}</td></tr>
                      <tr><td>{{ t('pos.device.status.paper') }}</td><td>{{ deviceStatus.paperPresent ? t('pos.device.status.paperOk') : t('pos.device.status.paperOut') }}</td></tr>
                      <tr v-if="deviceStatus.errors?.length"><td>{{ t('pos.device.status.errors') }}</td><td class="text-error">{{ deviceStatus.errors.join(', ') }}</td></tr>
                      <tr v-if="deviceStatus.warnings?.length"><td>{{ t('pos.device.status.warnings') }}</td><td class="text-warning">{{ deviceStatus.warnings.join(', ') }}</td></tr>
                    </tbody>
                  </v-table>
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn color="primary" :loading="reportLoading.status" @click="readDeviceStatus">{{ t('pos.device.status.read') }}</v-btn>
                </v-card-actions>
              </v-card>
            </v-col>

            <!-- What the device cannot do is disabled with the reason (`capabilities` on the device):
                 an Eltrade has no operator report and no electronic-journal print in its protocol. -->

            <!-- Daily X-Report -->
            <v-col cols="12" md="6" lg="4">
              <v-card variant="outlined" data-testid="report-xReport">
                <v-card-title class="text-subtitle-1">{{ t('pos.device.reports.x') }}</v-card-title>
                <v-card-text>
                  <p class="text-body-2 text-medium-emphasis">{{ t('pos.device.reports.xHint') }}</p>
                  <p v-if="!has('xReport')" class="text-caption text-medium-emphasis mt-2" data-testid="why-xReport">
                    <v-icon icon="mdi-information-outline" size="small" class="mr-1" />{{ why('xReport') }}
                  </p>
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn color="primary" :disabled="!has('xReport')" :loading="reportLoading.xReport" @click="printXReport">{{ t('common.print') }}</v-btn>
                </v-card-actions>
              </v-card>
            </v-col>

            <!-- Daily Z-Report -->
            <v-col cols="12" md="6" lg="4">
              <v-card variant="outlined" data-testid="report-zReport">
                <v-card-title class="text-subtitle-1">{{ t('pos.device.reports.z') }}</v-card-title>
                <v-card-text>
                  <p class="text-body-2 text-medium-emphasis">{{ t('pos.device.reports.zHint') }}</p>
                  <p v-if="!has('zReport')" class="text-caption text-medium-emphasis mt-2" data-testid="why-zReport">
                    <v-icon icon="mdi-information-outline" size="small" class="mr-1" />{{ why('zReport') }}
                  </p>
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn color="primary" :disabled="!has('zReport')" :loading="reportLoading.zReport" @click="printZReport">{{ t('common.print') }}</v-btn>
                </v-card-actions>
              </v-card>
            </v-col>

            <!-- Operator Report -->
            <v-col cols="12" md="6" lg="4">
              <v-card variant="outlined" data-testid="report-operatorReport">
                <v-card-title class="text-subtitle-1">{{ t('pos.device.reports.operator') }}</v-card-title>
                <v-card-text>
                  <v-select
                    v-model="reportParams.operatorNumber"
                    :label="t('pos.deviceReport.operatorNumber')"
                    :items="operatorSelectOptions"
                    :disabled="!has('operatorReport')"
                    density="compact"
                    hide-details
                  />
                  <p v-if="!has('operatorReport')" class="text-caption text-medium-emphasis mt-2" data-testid="why-operatorReport">
                    <v-icon icon="mdi-information-outline" size="small" class="mr-1" />{{ why('operatorReport') }}
                  </p>
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn color="primary" :disabled="!has('operatorReport')" :loading="reportLoading.operatorReport" @click="printOperatorReport">{{ t('common.print') }}</v-btn>
                </v-card-actions>
              </v-card>
            </v-col>

            <!-- Fiscal Memory Report by Date -->
            <v-col cols="12" md="6" lg="4">
              <v-card variant="outlined" data-testid="report-fmReportByDate">
                <v-card-title class="text-subtitle-1">{{ t('pos.device.reports.fmByDate') }}</v-card-title>
                <v-card-text>
                  <v-text-field v-model="reportParams.fmDateFrom" :label="t('common.from')" type="date" :disabled="!has('fmReportByDate')" density="compact" hide-details class="mb-2" />
                  <v-text-field v-model="reportParams.fmDateTo" :label="t('common.to')" type="date" :disabled="!has('fmReportByDate')" density="compact" hide-details class="mb-2" />
                  <v-switch v-model="reportParams.fmDateDetailed" :label="t('pos.deviceReport.detailed')" :disabled="!has('fmReportByDate')" density="compact" hide-details color="primary" />
                  <p v-if="!has('fmReportByDate')" class="text-caption text-medium-emphasis mt-2" data-testid="why-fmReportByDate">
                    <v-icon icon="mdi-information-outline" size="small" class="mr-1" />{{ why('fmReportByDate') }}
                  </p>
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn color="primary" :disabled="!has('fmReportByDate')" :loading="reportLoading.fmReportDate" @click="printFmReportByDate">{{ t('common.print') }}</v-btn>
                </v-card-actions>
              </v-card>
            </v-col>

            <!-- Fiscal Memory Report by Number -->
            <v-col cols="12" md="6" lg="4">
              <v-card variant="outlined" data-testid="report-fmReportByNumber">
                <v-card-title class="text-subtitle-1">{{ t('pos.device.reports.fmByNumber') }}</v-card-title>
                <v-card-text>
                  <v-text-field v-model.number="reportParams.fmStartNumber" :label="t('pos.device.reports.startNumber')" type="number" :disabled="!has('fmReportByNumber')" density="compact" hide-details class="mb-2" />
                  <v-text-field v-model.number="reportParams.fmEndNumber" :label="t('pos.device.reports.endNumber')" type="number" :disabled="!has('fmReportByNumber')" density="compact" hide-details class="mb-2" />
                  <v-switch v-model="reportParams.fmNumberDetailed" :label="t('pos.deviceReport.detailed')" :disabled="!has('fmReportByNumber')" density="compact" hide-details color="primary" />
                  <p v-if="!has('fmReportByNumber')" class="text-caption text-medium-emphasis mt-2" data-testid="why-fmReportByNumber">
                    <v-icon icon="mdi-information-outline" size="small" class="mr-1" />{{ why('fmReportByNumber') }}
                  </p>
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn color="primary" :disabled="!has('fmReportByNumber')" :loading="reportLoading.fmReportNumber" @click="printFmReportByNumber">{{ t('common.print') }}</v-btn>
                </v-card-actions>
              </v-card>
            </v-col>

            <!-- Electronic Journal (KLEN) -->
            <v-col cols="12" md="6" lg="4">
              <v-card variant="outlined" data-testid="report-electronicJournal">
                <v-card-title class="text-subtitle-1">{{ t('pos.device.reports.ej') }}</v-card-title>
                <v-card-text>
                  <v-text-field v-model="reportParams.ejDateFrom" :label="t('common.from')" type="date" :disabled="!has('electronicJournal')" density="compact" hide-details class="mb-2" />
                  <v-text-field v-model="reportParams.ejDateTo" :label="t('common.to')" type="date" :disabled="!has('electronicJournal')" density="compact" hide-details />
                  <p v-if="!has('electronicJournal')" class="text-caption text-medium-emphasis mt-2" data-testid="why-electronicJournal">
                    <v-icon icon="mdi-information-outline" size="small" class="mr-1" />{{ why('electronicJournal') }}
                  </p>
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn color="primary" :disabled="!has('electronicJournal')" :loading="reportLoading.ejReport" @click="printEjReport">{{ t('common.print') }}</v-btn>
                </v-card-actions>
              </v-card>
            </v-col>

            <!-- Payment types: the name the device prints for each payment slot. Cash on delivery
                 prints in a reserve slot (an Eltrade's R), which an admin names in one click. -->
            <v-col cols="12" md="6">
              <v-card variant="outlined" data-testid="payment-types">
                <v-card-title class="text-subtitle-1">{{ t('pos.device.paymentTypes.title') }}</v-card-title>
                <v-card-text>
                  <p v-if="!has('paymentNames')" class="text-caption text-medium-emphasis" data-testid="why-paymentNames">
                    <v-icon icon="mdi-information-outline" size="small" class="mr-1" />{{ why('paymentNames') }}
                  </p>
                  <template v-else>
                    <p v-if="!paymentNames" class="text-body-2 text-medium-emphasis">{{ t('pos.device.paymentTypes.hint') }}</p>
                    <v-table v-else density="compact">
                      <thead>
                        <tr>
                          <th style="width: 60px">{{ t('pos.device.paymentTypes.code') }}</th>
                          <th>{{ t('pos.device.paymentTypes.name') }}</th>
                          <th>{{ t('pos.device.paymentTypes.usedFor') }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="p in paymentNames" :key="p.code" :data-testid="`payment-${p.code}`">
                          <td>{{ p.code }}</td>
                          <td>{{ p.name || '—' }}</td>
                          <td>{{ p.type ? t(`pos.device.paymentTypes.uses.${p.type}`) : '' }}</td>
                        </tr>
                      </tbody>
                    </v-table>
                    <template v-if="codSlot">
                      <p class="text-caption text-medium-emphasis mt-2">
                        {{ t('pos.device.paymentTypes.codHint', { code: codSlot.code, name: codSlot.name }) }}
                        <template v-if="!isAdmin"> {{ t('pos.device.paymentTypes.adminOnly') }}</template>
                      </p>
                      <v-btn
                        variant="outlined"
                        color="primary"
                        size="small"
                        class="mt-2"
                        :disabled="!isAdmin"
                        :loading="paymentLoading.naming"
                        data-testid="name-cod-slot"
                        @click="nameCashOnDeliverySlot"
                      >
                        {{ t('pos.device.paymentTypes.nameCod', { code: codSlot.code, name: codSlot.name }) }}
                      </v-btn>
                    </template>
                  </template>
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn color="primary" :disabled="!has('paymentNames')" :loading="paymentLoading.reading" @click="readPaymentNames">
                    {{ t('pos.device.paymentTypes.read') }}
                  </v-btn>
                </v-card-actions>
              </v-card>
            </v-col>
          </v-row>
        </v-tabs-window-item>
      </v-tabs-window>
    </v-form>

    <template #sidebar>
      <div class="text-caption text-medium-emphasis pa-2">{{ t('pos.device.noNotes') }}</div>
    </template>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useFiscalBridge } from 'ui-shared/composables/useFiscalBridge'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import EntityFormShell from 'ui-shared/components/EntityFormShell'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'
import { jwtRole } from 'ui-shared/composables/useStorageIdentity'

const { t, te } = useI18n()
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
    showSuccess(t('pos.device.reconnected', { device: fiscalBridge.deviceNumber.value }))
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
  // A till's printer is opened from the POS page (Web Serial) — TCP needs an address the server reaches.
  connectionType: 'browser' as string,
  ip: '',
  tcpPort: 4999 as number | null,
  warehouseId: null as string | null,
  isActive: true,
  status: '' as string,
})

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'invoicing',
  entityType: 'posDevice',
  icon: 'mdi-printer-pos',
  getFormData: () => ({ ...device }),
  getPreviewFields: () => [
    { label: t('common.name'), value: device.name },
    { label: t('pos.device.number'), value: device.deviceNumber },
  ],
  setFormData: (data) => Object.assign(device, data),
  isEdit: () => !isNew.value,
  entityId: () => route.params.id as string,
})

const manufacturers = ['datecs', 'daisy', 'tremol', 'eltrade', 'incotex']
const connectionTypes = ['serial', 'tcp', 'usb', 'browser']

const warehouses = ref<any[]>([])
const loadingWarehouses = ref(false)

const rules = {
  required: (v: any) => !!v || t('validation.required'),
  deviceNumber: (v: string) => (v && v.length === 8) || t('pos.device.numberLength'),
}

// Form actions
const formActions = computed<FormAction[]>(() => {
  const actions: FormAction[] = [
    { label: isNew.value ? t('common.create') : t('common.save'), color: 'primary', icon: 'mdi-content-save', handler: handleSave, loading: saving.value },
  ]
  if (!isNew.value && device.connectionType === 'browser') {
    actions.push({
      label: fiscalBridge.status.value === 'connected' ? t('pos.device.disconnect') : t('pos.device.connect'),
      color: fiscalBridge.status.value === 'connected' ? 'error' : 'success',
      icon: fiscalBridge.status.value === 'connected' ? 'mdi-printer-off' : 'mdi-printer',
      handler: toggleConnection,
      loading: fiscalBridge.status.value === 'connecting',
      variant: 'outlined',
    })
  }
  return actions
})

/**
 * What the saved device's driver can do (`GET /fiscal/device/:id` → `capabilities`, from
 * `fiscal/capabilities` on the server): what it cannot is disabled below, with the reason. Null
 * until the device is loaded — and then nothing is disabled, as before capabilities existed.
 */
interface Capabilities {
  driver: string | null
  features: Record<string, boolean>
  missing: Record<string, 'protocol' | 'driver' | 'no_driver'>
  maxOperators: number
  cashOnDeliverySlot?: { code: string; name: string }
}
const caps = ref<Capabilities | null>(null)
/** The manufacturer the capabilities were read for — the saved one, not the form's. */
const capsManufacturer = ref('')

function has(feature: string): boolean {
  return !caps.value || !!caps.value.features?.[feature]
}

/** Why `feature` is off on this device; '' when it is on. */
function why(feature: string): string {
  const reason = caps.value?.missing?.[feature]
  const m = capsManufacturer.value
  const brand = m ? m[0].toUpperCase() + m.slice(1) : ''
  if (reason === 'protocol') {
    const key = `pos.device.why.protocol.${feature}`
    return te(key) ? t(key, { brand }) : t('pos.device.why.protocol.other', { brand })
  }
  if (reason === 'no_driver') return t('pos.device.why.noDriver', { brand })
  if (reason === 'driver') return t('pos.device.why.driver', { brand })
  return ''
}

const role = computed(() => appStore.user?.role || jwtRole())
const isAdmin = computed(() => role.value === 'admin')
const codSlot = computed(() => caps.value?.cashOnDeliverySlot || null)

// Operators — as many as the device numbers (an Eltrade 16); 8 until it says
const operatorCount = computed(() => caps.value?.maxOperators || 8)
const newOperator = (number: number) => ({ number, name: '', password: '', programming: false, reading: false })
const operators = ref(Array.from({ length: operatorCount.value }, (_, i) => newOperator(i + 1)))
watch(operatorCount, (n) => {
  operators.value = Array.from({ length: n }, (_, i) => operators.value[i] ?? newOperator(i + 1))
})

const operatorNotes = computed(() => {
  const notes: string[] = []
  if (!has('programOperator')) notes.push(why('programOperator'))
  if (!has('readOperator')) notes.push(why('readOperator'))
  if (caps.value?.driver === 'eltrade') notes.push(t('pos.device.operators.eltradePassword'))
  return [...new Set(notes)]
})

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

const deviceStatus = ref<any>(null)

const reportLoading = reactive({
  status: false,
  xReport: false,
  zReport: false,
  operatorReport: false,
  fmReportDate: false,
  fmReportNumber: false,
  ejReport: false,
})

const operatorSelectOptions = computed(() => [
  { title: t('pos.deviceReport.allOperators'), value: 0 },
  ...Array.from({ length: operatorCount.value }, (_, i) => ({ title: t('pos.device.operators.numbered', { n: i + 1 }), value: i + 1 })),
])

// Payment types (the names the device prints for its payment slots)
const paymentNames = ref<{ code: string; name: string; type?: string }[] | null>(null)
const paymentLoading = reactive({ reading: false, naming: false })

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
    showSuccess(t('pos.device.disconnected'))
    return
  }
  try {
    const ok = await fiscalBridge.requestPort()
    if (!ok) {
      if (fiscalBridge.errorCode.value === 'port_in_use') showError(t('pos.bridge.portInUse'))
      return
    }
    const connected = await fiscalBridge.connect(appStore.currentOrg!.id, device.deviceNumber, device.warehouseId || '')
    if (!connected) {
      const reason = fiscalBridge.errorMessage.value
      await fiscalBridge.disconnect() // release the port so a retry can open it again
      showError(t('pos.connectFailed', { reason }))
      return
    }
    try { await httpClient.put(`${deviceUrl.value}/${deviceId.value}`, { status: 'online' }) } catch {}
    device.status = 'online'
    showSuccess(t('pos.device.connected', { device: device.deviceNumber }))
  } catch (e: any) {
    showError(e.message || t('pos.device.connectFailed'))
  }
}

async function readDeviceStatus() {
  reportLoading.status = true
  try {
    const { data } = await httpClient.get(`${deviceUrl.value}/${deviceId.value}/status`)
    deviceStatus.value = data.deviceStatus
  } catch (e: any) {
    showError(e?.response?.data?.message || t('pos.device.status.readFailed'))
  } finally {
    reportLoading.status = false
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
      connectionType: d.connectionType || 'browser',
      ip: d.connectionParams?.ip || '',
      tcpPort: d.connectionParams?.tcpPort || 4999,
      warehouseId: d.warehouseId || null,
      isActive: d.isActive !== false,
      status: d.status || '',
    })
    setCapabilities(d)
  } catch (e: any) {
    showError(e?.response?.data?.message || t('pos.device.loadFailed'))
  } finally {
    loading.value = false
  }
}

function setCapabilities(d: any) {
  caps.value = d?.capabilities || null
  capsManufacturer.value = d?.manufacturer || ''
}

/** A saved manufacturer or connection can change what the device can do. */
async function refreshCapabilities() {
  try {
    const { data } = await httpClient.get(`${deviceUrl.value}/${deviceId.value}`)
    setCapabilities(data.fiscalDevice || data)
  } catch { /* the page keeps what it had */ }
}

async function handleSave() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  saving.value = true
  try {
    const payload: Record<string, unknown> = {
      name: device.name,
      deviceNumber: device.deviceNumber,
      manufacturer: device.manufacturer,
      connectionType: device.connectionType,
      warehouseId: device.warehouseId,
      isActive: device.isActive,
    }
    // A TCP device is opened by the LGR server at this address.
    if (device.connectionType === 'tcp') {
      payload.connectionParams = { ip: device.ip.trim(), tcpPort: Number(device.tcpPort) || 4999 }
    }

    if (isNew.value) {
      const { data } = await httpClient.post(deviceUrl.value, payload)
      markSaved()
      showSuccess(t('pos.device.created'))
      const newId = data.fiscalDevice?._id || data.fiscalDevice?.id || data._id || data.id
      if (newId) {
        router.replace({ name: 'pos.devices.detail', params: { id: newId } })
      }
    } else {
      await httpClient.put(`${deviceUrl.value}/${deviceId.value}`, payload)
      markSaved()
      showSuccess(t('pos.device.saved'))
      await refreshCapabilities()
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('pos.device.saveFailed'))
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
    showSuccess(t('pos.device.operators.programmed', { n: op.number }))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('pos.device.operators.programFailed', { n: op.number }))
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
    showSuccess(t('pos.device.operators.wasRead', { n: op.number }))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('pos.device.operators.readFailed', { n: op.number }))
  } finally {
    op.reading = false
  }
}

// Report actions
async function printXReport() {
  reportLoading.xReport = true
  try {
    await httpClient.post(`${deviceUrl.value}/${deviceId.value}/x-report`)
    showSuccess(t('pos.device.reports.xPrinted'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('pos.device.reports.xFailed'))
  } finally {
    reportLoading.xReport = false
  }
}

async function printZReport() {
  reportLoading.zReport = true
  try {
    await httpClient.post(`${deviceUrl.value}/${deviceId.value}/z-report`)
    showSuccess(t('pos.device.reports.zPrinted'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('pos.device.reports.zFailed'))
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
    showSuccess(t('pos.device.reports.operatorPrinted'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('pos.device.reports.operatorFailed'))
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
    showSuccess(t('pos.device.reports.fmPrinted'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('pos.device.reports.fmFailed'))
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
    showSuccess(t('pos.device.reports.fmPrinted'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('pos.device.reports.fmFailed'))
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
    showSuccess(t('pos.device.reports.ejPrinted'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('pos.device.reports.ejFailed'))
  } finally {
    reportLoading.ejReport = false
  }
}

// Payment type actions
async function readPaymentNames() {
  paymentLoading.reading = true
  try {
    const { data } = await httpClient.get(`${deviceUrl.value}/${deviceId.value}/payment-names`)
    paymentNames.value = data.paymentNames || []
  } catch (e: any) {
    showError(e?.response?.data?.message || t('pos.device.paymentTypes.readFailed'))
  } finally {
    paymentLoading.reading = false
  }
}

/** One click: the slot cash on delivery prints in gets the name the receipt should show. */
async function nameCashOnDeliverySlot() {
  const slot = codSlot.value
  if (!slot) return
  paymentLoading.naming = true
  try {
    const { data } = await httpClient.post(`${deviceUrl.value}/${deviceId.value}/payment-names`, { code: slot.code, name: slot.name })
    const named = data.paymentName || { code: slot.code, name: slot.name }
    if (paymentNames.value) {
      paymentNames.value = paymentNames.value.map(p => (p.code === named.code ? { ...p, ...named } : p))
    } else {
      await readPaymentNames()
    }
    showSuccess(t('pos.device.paymentTypes.named', { code: named.code, name: named.name }))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('pos.device.paymentTypes.nameFailed'))
  } finally {
    paymentLoading.naming = false
  }
}

onMounted(async () => {
  await fetchWarehouses()
  if (tryRestore()) return
  fetchDevice()
})
</script>
