<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.contacts') }}</h1>
      <v-spacer />
      <export-menu class="mr-2" @export="onExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" :to="{ name: 'invoicing.contacts.new' }">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-0">
        <v-row>
          <v-col cols="12" sm="6" md="4">
            <v-text-field
              v-model="search"
              prepend-inner-icon="mdi-magnify"
              :label="$t('common.search')"
              clearable
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-select
              v-model="typeFilter"
              :label="$t('common.type')"
              :items="typeFilterOptions"
              clearable
              hide-details
              density="compact"
            />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-text>
        <v-data-table
          :headers="headers"
          :items="filteredItems"
          :search="search"
          :loading="loading"
          :no-data-text="$t('common.noData')"
          item-value="_id"
          hover
        >
          <template #item.type="{ item }">
            <v-chip
              size="small"
              label
              :color="item.type === 'customer' ? 'primary' : item.type === 'supplier' ? 'orange' : 'purple'"
            >
              {{ item.type }}
            </v-chip>
          </template>
          <template #item.paymentTerms="{ item }">
            {{ item.paymentTerms ? `${item.paymentTerms} ${$t('invoicing.days')}` : '-' }}
          </template>
          <template #item.isActive="{ item }">
            <v-icon :color="item.isActive !== false ? 'success' : 'grey'">
              {{ item.isActive !== false ? 'mdi-check-circle' : 'mdi-close-circle' }}
            </v-icon>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'invoicing.contacts.edit', params: { id: item._id } }" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- Delete Confirmation -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('invoicing.deleteContactConfirm') }}</v-card-text>
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

interface Contact {
  _id: string
  name: string
  type: 'customer' | 'supplier' | 'both'
  email?: string
  phone?: string
  taxId?: string
  paymentTerms?: number
  isActive?: boolean
}

const { t } = useI18n()
const appStore = useAppStore()

const search = ref('')
const loading = ref(false)
const items = ref<Contact[]>([])
const deleteDialog = ref(false)
const selectedId = ref('')
const typeFilter = ref<string | null>(null)

const typeFilterOptions = ['customer', 'supplier', 'both']

const headers = computed(() => [
  { title: t('invoicing.companyName'), key: 'name', sortable: true },
  { title: t('common.type'), key: 'type', sortable: true },
  { title: t('invoicing.email'), key: 'email', sortable: true },
  { title: t('invoicing.phone'), key: 'phone' },
  { title: t('invoicing.taxId'), key: 'taxId' },
  { title: t('invoicing.paymentTerms'), key: 'paymentTerms' },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const filteredItems = computed(() => {
  let result = items.value
  if (typeFilter.value) result = result.filter(i => i.type === typeFilter.value)
  return result
})

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function confirmDelete(item: Contact) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  await httpClient.delete(`${orgUrl()}/contacts/${selectedId.value}`)
  await fetchItems()
  deleteDialog.value = false
}

function onExport(format: string) {
  console.log('Export contacts as', format)
}

async function fetchItems() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/contacts`)
    items.value = data.contacts || []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchItems()
})
</script>
