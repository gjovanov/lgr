<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.taxReturns') }}</h1>
      <v-spacer />
      <export-menu module="accounting" class="mr-2" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openDialog()">
        {{ $t('common.add') }}
      </v-btn>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row>
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

    <data-table
      :headers="headers"
      :items="filteredItems"
      :loading="loading"
      @click:row="openDialog($event)"
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
        <v-btn icon="mdi-pencil" size="small" variant="text" @click.stop="openDialog(item)" />
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
    </data-table>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="700" scrollable>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.add') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-select
              v-model="form.type"
              :label="$t('common.type')"
              :items="typeOptions"
              :rules="[rules.required]"
            />
            <v-row>
              <v-col cols="12" md="6">
                <v-text-field
                  v-model="form.periodStart"
                  :label="$t('common.dateFrom')"
                  type="date"
                  :rules="[rules.required]"
                />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field
                  v-model="form.periodEnd"
                  :label="$t('common.dateTo')"
                  type="date"
                  :rules="[rules.required]"
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

            <v-textarea
              v-model="form.notes"
              :label="$t('common.notes')"
              rows="2"
              class="mt-4"
            />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="loading" @click="save">
            {{ $t('common.save') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from '../../composables/useHttpClient'
import { formatCurrency } from '../../composables/useCurrency'
import { useSnackbar } from '../../composables/useSnackbar'
import DataTable from '../../components/shared/DataTable.vue'
import ExportMenu from '../../components/shared/ExportMenu.vue'

interface TaxReturnLine {
  description: string
  taxCollected: number
  taxPaid: number
}

interface TaxReturn {
  _id: string
  type: string
  periodStart: string
  periodEnd: string
  status: string
  taxCollected: number
  taxPaid: number
  netPayable: number
  notes?: string
  lines?: TaxReturnLine[]
}

const appStore = useAppStore()
const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const loading = ref(false)
const items = ref<TaxReturn[]>([])
const dialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')
const statusFilter = ref<string | null>(null)
const typeFilter = ref<string | null>(null)

const statusOptions = ['draft', 'submitted', 'accepted', 'rejected']
const typeOptions = ['VAT', 'income_tax', 'corporate_tax', 'withholding']

const emptyForm = () => ({
  type: '',
  periodStart: '',
  periodEnd: '',
  notes: '',
  lines: [{ description: '', taxCollected: 0, taxPaid: 0 }] as TaxReturnLine[],
})

const form = ref(emptyForm())

const headers = computed(() => [
  { title: t('common.type'), key: 'type' },
  { title: t('common.dateFrom'), key: 'periodStart' },
  { title: t('common.dateTo'), key: 'periodEnd' },
  { title: t('common.status'), key: 'status' },
  { title: t('accounting.netPayable'), key: 'netPayable', align: 'end' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const filteredItems = computed(() => {
  let result = items.value
  if (statusFilter.value) result = result.filter(i => i.status === statusFilter.value)
  if (typeFilter.value) result = result.filter(i => i.type === typeFilter.value)
  return result
})

const totalCollected = computed(() => form.value.lines.reduce((s, l) => s + (l.taxCollected || 0), 0))
const totalPaid = computed(() => form.value.lines.reduce((s, l) => s + (l.taxPaid || 0), 0))
const netPayable = computed(() => totalCollected.value - totalPaid.value)

const rules = {
  required: (v: string) => !!v || 'Required',
}

function statusColor(s: string) {
  const colors: Record<string, string> = {
    draft: 'grey', submitted: 'info', accepted: 'success', rejected: 'error',
  }
  return colors[s] || 'grey'
}

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function addLineItem() {
  form.value.lines.push({ description: '', taxCollected: 0, taxPaid: 0 })
}

function removeLineItem(idx: number) {
  form.value.lines.splice(idx, 1)
}

function openDialog(item?: TaxReturn | Record<string, unknown>) {
  if (item && '_id' in item && item._id) {
    const tr = item as TaxReturn
    editing.value = true
    selectedId.value = tr._id
    form.value = {
      type: tr.type,
      periodStart: tr.periodStart?.split('T')[0] || '',
      periodEnd: tr.periodEnd?.split('T')[0] || '',
      notes: tr.notes || '',
      lines: tr.lines || [{ description: '', taxCollected: tr.taxCollected, taxPaid: tr.taxPaid }],
    }
  } else {
    editing.value = false
    form.value = emptyForm()
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  loading.value = true
  try {
    const payload = {
      ...form.value,
      taxCollected: totalCollected.value,
      taxPaid: totalPaid.value,
    }
    if (editing.value) {
      await httpClient.put(`${orgUrl()}/accounting/tax-return/${selectedId.value}`, payload)
    } else {
      await httpClient.post(`${orgUrl()}/accounting/tax-return`, payload)
    }
    await fetchItems()
    showSuccess(t('common.savedSuccessfully'))
    dialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function submitReturn(item: TaxReturn) {
  loading.value = true
  try {
    await httpClient.post(`${orgUrl()}/accounting/tax-return/${item._id}/submit`)
    await fetchItems()
    showSuccess(t('common.submittedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function fetchItems() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/accounting/tax-return`)
    items.value = data.taxReturns || []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchItems()
})
</script>
