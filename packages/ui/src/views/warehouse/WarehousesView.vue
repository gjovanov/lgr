<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.warehouses') }}</h1>
      <v-spacer />
      <export-menu class="mr-2" @export="onExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card>
      <v-card-text>
        <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" class="mb-4" style="max-width:300px" />
        <v-data-table :headers="headers" :items="items" :search="search" :loading="loading" item-value="_id" hover>
          <template #item.type="{ item }">
            <v-chip size="small" label>{{ item.type || 'standard' }}</v-chip>
          </template>
          <template #item.isDefault="{ item }">
            <v-icon v-if="item.isDefault" color="primary">mdi-star</v-icon>
          </template>
          <template #item.isActive="{ item }">
            <v-icon :color="item.isActive !== false ? 'success' : 'grey'">
              {{ item.isActive !== false ? 'mdi-check-circle' : 'mdi-close-circle' }}
            </v-icon>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <v-dialog v-model="dialog" max-width="600" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('nav.warehouses') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="6"><v-text-field v-model="form.code" :label="$t('common.code')" :rules="[rules.required]" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.name" :label="$t('common.name')" :rules="[rules.required]" /></v-col>
            </v-row>
            <v-select v-model="form.type" :label="$t('common.type')" :items="['warehouse', 'store', 'production', 'transit']" />
            <v-text-field v-model="form.manager" :label="$t('warehouse.manager')" />
            <v-text-field v-model="form.address" :label="$t('invoicing.address')" />
            <v-row>
              <v-col cols="6"><v-switch v-model="form.isDefault" :label="$t('warehouse.default')" color="primary" /></v-col>
              <v-col cols="6"><v-switch v-model="form.isActive" :label="$t('common.active')" color="primary" /></v-col>
            </v-row>
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="loading" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('warehouse.deleteWarehouseConfirm') }}</v-card-text>
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
import { httpClient } from '../../composables/useHttpClient'
import ExportMenu from '../../components/shared/ExportMenu.vue'

interface Item { _id: string; code: string; name: string; type: string; manager?: string; address?: string; isDefault: boolean; isActive: boolean }

const { t } = useI18n()
const appStore = useAppStore()

const search = ref('')
const loading = ref(false)
const items = ref<Item[]>([])
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')

const form = ref({ code: '', name: '', type: 'warehouse', manager: '', address: '', isDefault: false, isActive: true })

const rules = { required: (v: string) => !!v || t('validation.required') }

const headers = computed(() => [
  { title: t('common.code'), key: 'code', sortable: true },
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('warehouse.manager'), key: 'manager' },
  { title: t('warehouse.default'), key: 'isDefault', align: 'center' as const },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function openCreate() {
  editing.value = false
  form.value = { code: '', name: '', type: 'warehouse', manager: '', address: '', isDefault: false, isActive: true }
  dialog.value = true
}

function openEdit(item: Item) {
  editing.value = true; selectedId.value = item._id
  form.value = { code: item.code, name: item.name, type: item.type || 'standard', manager: item.manager || '', address: item.address || '', isDefault: item.isDefault, isActive: item.isActive }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate(); if (!valid) return
  loading.value = true
  try {
    if (editing.value) await httpClient.put(`${orgUrl()}/warehouse/warehouse/${selectedId.value}`, form.value)
    else await httpClient.post(`${orgUrl()}/warehouse/warehouse`, form.value)
    await fetchItems(); dialog.value = false
  } finally { loading.value = false }
}

function confirmDelete(item: Item) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await httpClient.delete(`${orgUrl()}/warehouse/warehouse/${selectedId.value}`); await fetchItems(); deleteDialog.value = false }
function onExport(format: string) { console.log('Export warehouses as', format) }

async function fetchItems() {
  loading.value = true
  try { const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`); items.value = data.warehouses || [] }
  finally { loading.value = false }
}

onMounted(() => { fetchItems() })
</script>
