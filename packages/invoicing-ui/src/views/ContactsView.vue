<template>
  <ListScaffold
    :title="$t('nav.contacts')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-account-multiple-outline', title: $t('list.empty.contacts'), description: $t('list.empty.contactsHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.contacts.new' }">
        {{ $t('common.create') }}
      </responsive-btn>
    </template>

    <template #filters>
      <FilterBar v-model:search="search">
        <v-col cols="12" sm="6" md="2">
          <v-select
            v-model="typeFilter"
            :label="$t('common.type')"
            :items="typeFilterOptions"
            clearable
          />
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <TagInput v-model="tagFilter" type="contact" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
        </v-col>
      </FilterBar>
    </template>

    <template #empty-actions>
      <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.contacts.new' }">
        {{ $t('common.create') }}
      </responsive-btn>
    </template>

    <!-- Cell renderers -->
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
      <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'invoicing.contacts.edit', params: { id: item._id } }" :title="$t('common.edit')" :aria-label="$t('common.edit')" />
      <v-btn icon="mdi-book-open-variant" size="small" variant="text" color="info" :to="{ name: 'invoicing.contacts.ledger', params: { id: item._id } }" :title="$t('invoicing.contactLedger')" :aria-label="$t('invoicing.contactLedger')" />
      <v-btn icon="mdi-delete" size="small" variant="text" color="error" :title="$t('common.delete')" :aria-label="$t('common.delete')" @click="confirmDelete(item)" />
    </template>

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
  </ListScaffold>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import TagInput from 'ui-shared/components/TagInput.vue'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'

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

const { search, debouncedSearch } = useSearchDebounce()
const deleteDialog = ref(false)
const selectedId = ref('')
const typeFilter = ref<string | null>(null)
const tagFilter = ref<string[]>([])

const typeFilterOptions = ['customer', 'supplier', 'both']

const hasActiveFilters = computed(() =>
  !!debouncedSearch.value || !!typeFilter.value || tagFilter.value.length > 0,
)

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (typeFilter.value) f.type = typeFilter.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  return f
})

// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'type', ref: typeFilter },
  { key: 'tags', ref: tagFilter, codec: 'csv' },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoicing/contact`),
  entityKey: 'contacts',
  filters,
  urlSync: true,
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

function confirmDelete(item: Contact) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/invoicing/contact/${selectedId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    await fetchItems()
    deleteDialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => {
  fetchItems()
})
</script>
