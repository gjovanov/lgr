<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('warehouse.categories') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu @export="onExport" />
        <responsive-btn color="primary" icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</responsive-btn>
      </div>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

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
            <EntityLink :id="item._id" :label="item.name" entity="ProductCategory" />
          </template>
          <template #item.sortOrder="{ item }">{{ item.sortOrder ?? 0 }}</template>
          <template #item.isActive="{ item }">
            <v-icon :color="item.isActive !== false ? 'success' : 'grey'">
              {{ item.isActive !== false ? 'mdi-check-circle' : 'mdi-close-circle' }}
            </v-icon>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="600" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('warehouse.category') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.name" :label="$t('common.name')" :rules="[rules.required]" />
            <v-textarea v-model="form.description" :label="$t('common.description')" rows="3" />
            <v-row>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.icon" :label="$t('warehouse.categoryIcon')" placeholder="mdi-laptop" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.color" :label="$t('warehouse.categoryColor')" placeholder="#FF5733" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model.number="form.sortOrder" :label="$t('warehouse.sortOrder')" type="number" />
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

    <!-- Delete Confirmation Dialog -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('warehouse.deleteCategoryConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'

interface Category {
  _id: string
  name: string
  description?: string
  icon?: string
  color?: string
  sortOrder?: number
  isActive: boolean
}

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const { search, debouncedSearch } = useSearchDebounce()
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const saving = ref(false)
const formRef = ref()
const selectedId = ref('')

const emptyForm = () => ({ name: '', description: '', icon: '', color: '', sortOrder: 0 })
const form = ref(emptyForm())

const rules = { required: (v: string) => !!v || t('validation.required') }

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  return f
})

const url = computed(() => `${appStore.orgUrl()}/warehouse/product-category`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'productCategories',
  filters,
})

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('common.description'), key: 'description', sortable: false },
  { title: t('warehouse.sortOrder'), key: 'sortOrder', sortable: true, align: 'end' as const },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function openCreate() {
  editing.value = false
  form.value = emptyForm()
  dialog.value = true
}

function openEdit(item: Category) {
  editing.value = true
  selectedId.value = item._id
  form.value = {
    name: item.name,
    description: item.description || '',
    icon: item.icon || '',
    color: item.color || '',
    sortOrder: item.sortOrder ?? 0,
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  saving.value = true
  try {
    if (editing.value) await httpClient.put(`${appStore.orgUrl()}/warehouse/product-category/${selectedId.value}`, form.value)
    else await httpClient.post(`${appStore.orgUrl()}/warehouse/product-category`, form.value)
    await fetchItems()
    dialog.value = false
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { saving.value = false }
}

function confirmDelete(item: Category) { selectedId.value = item._id; deleteDialog.value = true }

async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/warehouse/product-category/${selectedId.value}`)
    await fetchItems()
    deleteDialog.value = false
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function onExport(format: string) { console.log('Export categories as', format) }

onMounted(() => { fetchItems() })
</script>
