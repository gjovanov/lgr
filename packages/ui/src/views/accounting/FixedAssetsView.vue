<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.fixedAssets') }}</h1>
      <v-spacer />
      <export-menu module="accounting" class="mr-2" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openDialog()">
        {{ $t('common.add') }}
      </v-btn>
    </div>

    <v-card>
      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="pagination.total"
          :loading="loading"
          :page="pagination.page + 1"
          :items-per-page="pagination.size"
          item-value="_id"
          @update:options="onUpdateOptions"
          @click:row="(_event: Event, row: any) => openDialog(row.item)"
        >
          <template #item.acquisitionDate="{ item }">
            {{ item.acquisitionDate?.split('T')[0] }}
          </template>
          <template #item.acquisitionCost="{ item }">
            {{ formatCurrency(item.acquisitionCost, currency, localeCode) }}
          </template>
          <template #item.currentValue="{ item }">
            {{ formatCurrency(item.currentValue, currency, localeCode) }}
          </template>
          <template #item.status="{ item }">
            <v-chip size="small" :color="statusColor(item.status)">
              {{ item.status }}
            </v-chip>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click.stop="openDialog(item)" />
            <v-btn
              icon="mdi-calendar-clock"
              size="small"
              variant="text"
              color="info"
              :title="$t('accounting.depreciationSchedule')"
              @click.stop="showDepreciation(item)"
            />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click.stop="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="700">
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.add') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="6">
                <v-text-field v-model="form.code" :label="$t('common.code')" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field v-model="form.name" :label="$t('common.name')" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field v-model="form.category" :label="$t('common.category')" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field v-model="form.acquisitionDate" :label="$t('accounting.purchaseDate')" type="date" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field v-model.number="form.acquisitionCost" :label="$t('accounting.purchasePrice')" type="number" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="6">
                <v-select v-model="form.depreciationMethod" :label="$t('accounting.depreciationMethod')" :items="depreciationMethods" />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field v-model.number="form.usefulLife" :label="$t('accounting.usefulLife')" type="number" suffix="years" />
              </v-col>
              <v-col cols="12" md="6">
                <v-select v-model="form.status" :label="$t('common.status')" :items="statusItems" />
              </v-col>
            </v-row>
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirmDelete') }}</v-card-title>
        <v-card-text>{{ $t('common.confirmDeleteMessage') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="saving" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Depreciation Schedule Dialog -->
    <v-dialog v-model="depDialog" max-width="700">
      <v-card>
        <v-card-title>{{ $t('accounting.depreciationSchedule') }}</v-card-title>
        <v-card-text>
          <div v-if="depAsset" class="mb-4">
            <p><strong>{{ depAsset.code }}</strong> - {{ depAsset.name }}</p>
            <p>{{ $t('accounting.depreciationMethod') }}: {{ depAsset.depreciationMethod }}</p>
            <p>{{ $t('accounting.usefulLife') }}: {{ depAsset.usefulLife }} years</p>
          </div>
          <v-data-table :headers="depHeaders" :items="depSchedule" density="compact">
            <template #item.depreciation="{ item }">
              {{ formatCurrency(item.depreciation, currency, localeCode) }}
            </template>
            <template #item.accumulated="{ item }">
              {{ formatCurrency(item.accumulated, currency, localeCode) }}
            </template>
            <template #item.bookValue="{ item }">
              {{ formatCurrency(item.bookValue, currency, localeCode) }}
            </template>
          </v-data-table>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="depDialog = false">{{ $t('common.close') }}</v-btn>
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
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import ExportMenu from '../../components/shared/ExportMenu.vue'

interface FixedAsset {
  _id: string
  code: string
  name: string
  category: string
  acquisitionDate: string
  acquisitionCost: number
  depreciationMethod: string
  usefulLife: number
  currentValue: number
  status: string
}

interface DepreciationRow {
  year: number
  depreciation: number
  accumulated: number
  bookValue: number
}

const appStore = useAppStore()
const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const saving = ref(false)
const dialog = ref(false)
const deleteDialog = ref(false)
const depDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')
const depAsset = ref<FixedAsset | null>(null)
const depSchedule = ref<DepreciationRow[]>([])

const depreciationMethods = ['straight-line', 'declining-balance', 'units-of-production']
const statusItems = ['active', 'disposed', 'fully-depreciated']

const emptyForm = () => ({
  code: '', name: '', category: '', acquisitionDate: '', acquisitionCost: 0,
  depreciationMethod: 'straight-line', usefulLife: 5, status: 'active',
})

const form = ref(emptyForm())

const headers = computed(() => [
  { title: t('common.code'), key: 'code' },
  { title: t('common.name'), key: 'name' },
  { title: t('common.category'), key: 'category' },
  { title: t('accounting.purchaseDate'), key: 'acquisitionDate' },
  { title: t('accounting.purchasePrice'), key: 'acquisitionCost', align: 'end' as const },
  { title: t('accounting.currentValue'), key: 'currentValue', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const depHeaders = [
  { title: 'Year', key: 'year' },
  { title: 'Depreciation', key: 'depreciation', align: 'end' as const },
  { title: 'Accumulated', key: 'accumulated', align: 'end' as const },
  { title: 'Book Value', key: 'bookValue', align: 'end' as const },
]

const rules = {
  required: (v: string | number) => (v !== '' && v !== null && v !== undefined) || 'Required',
}

function statusColor(status: string) {
  const colors: Record<string, string> = { active: 'success', disposed: 'grey', 'fully-depreciated': 'warning' }
  return colors[status] || 'grey'
}

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${orgUrl()}/accounting/fixed-asset`),
  entityKey: 'fixedAssets',
})

function openDialog(item?: FixedAsset | Record<string, unknown>) {
  if (item && '_id' in item && item._id) {
    const asset = item as FixedAsset
    editing.value = true
    selectedId.value = asset._id
    form.value = {
      code: asset.code, name: asset.name, category: asset.category,
      acquisitionDate: asset.acquisitionDate?.split('T')[0] || '',
      acquisitionCost: asset.acquisitionCost, depreciationMethod: asset.depreciationMethod,
      usefulLife: asset.usefulLife, status: asset.status,
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
  saving.value = true
  try {
    if (editing.value) {
      await httpClient.put(`${orgUrl()}/accounting/fixed-asset/${selectedId.value}`, form.value)
    } else {
      await httpClient.post(`${orgUrl()}/accounting/fixed-asset`, form.value)
    }
    await fetchItems()
    showSuccess(t('common.savedSuccessfully'))
    dialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

function confirmDelete(item: FixedAsset) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  saving.value = true
  try {
    await httpClient.delete(`${orgUrl()}/accounting/fixed-asset/${selectedId.value}`)
    await fetchItems()
    showSuccess(t('common.deletedSuccessfully'))
    deleteDialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

function showDepreciation(asset: FixedAsset) {
  depAsset.value = asset
  const annualDep = asset.acquisitionCost / (asset.usefulLife || 1)
  const schedule: DepreciationRow[] = []
  let accumulated = 0
  for (let y = 1; y <= asset.usefulLife; y++) {
    accumulated += annualDep
    schedule.push({
      year: y,
      depreciation: Math.round(annualDep * 100) / 100,
      accumulated: Math.round(accumulated * 100) / 100,
      bookValue: Math.round((asset.acquisitionCost - accumulated) * 100) / 100,
    })
  }
  depSchedule.value = schedule
  depDialog.value = true
}

onMounted(() => { fetchItems() })
</script>
