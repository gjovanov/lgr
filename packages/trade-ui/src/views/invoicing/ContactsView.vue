<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.contacts') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu @export="onExport" />
        <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.contacts.new' }">{{ $t('common.create') }}</responsive-btn>
      </div>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
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
          <v-col cols="12" sm="6" md="3">
            <TagInput v-model="tagFilter" type="contact" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
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
          <template #item.type="{ item }">
            <v-chip
              size="small"
              label
              :color="item.type === 'customer' ? 'primary' : item.type === 'supplier' ? 'orange' : 'purple'"
            >
              {{ item.type }}
            </v-chip>
          </template>
          <template #item.paymentTermsDays="{ item }">
            {{ item.paymentTermsDays ? `${item.paymentTermsDays} ${$t('invoicing.days')}` : '-' }}
          </template>
          <template #item.isActive="{ item }">
            <v-icon :color="item.isActive !== false ? 'success' : 'grey'">
              {{ item.isActive !== false ? 'mdi-check-circle' : 'mdi-close-circle' }}
            </v-icon>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'invoicing.contacts.edit', params: { id: item._id } }" />
            <v-btn icon="mdi-book-open-variant" size="small" variant="text" color="info" :title="$t('invoicing.contactLedger')" :to="{ name: 'invoicing.contacts.ledger', params: { id: item._id } }" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
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
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import TagInput from 'ui-shared/components/TagInput.vue'

interface Contact {
  _id: string
  companyName?: string
  firstName?: string
  lastName?: string
  type: 'customer' | 'supplier' | 'both'
  email?: string
  phone?: string
  taxId?: string
  paymentTermsDays?: number
  isActive?: boolean
}

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const search = ref('')
const deleteDialog = ref(false)
const selectedId = ref('')
const typeFilter = ref<string | null>(null)
const tagFilter = ref<string[]>([])

const typeFilterOptions = ['customer', 'supplier', 'both']

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (typeFilter.value) f.type = typeFilter.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoicing/contact`),
  entityKey: 'contacts',
  filters,
})

const headers = computed(() => [
  { title: t('invoicing.companyName'), key: 'companyName', sortable: true },
  { title: t('common.type'), key: 'type', sortable: true },
  { title: t('invoicing.email'), key: 'email', sortable: true },
  { title: t('invoicing.phone'), key: 'phone' },
  { title: t('invoicing.taxNumber'), key: 'taxNumber' },
  { title: t('invoicing.vatNumber'), key: 'vatNumber' },
  { title: t('invoicing.paymentTerms'), key: 'paymentTermsDays' },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function openLedger(item: Contact) {
  // Now navigated via :to on the button — this function is unused
}

function confirmDelete(item: Contact) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await httpClient.delete(`${orgUrl()}/invoicing/contact/${selectedId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    await fetchItems()
    deleteDialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function onExport(format: string) {
  console.log('Export contacts as', format)
}

onMounted(() => {
  fetchItems()
})
</script>
