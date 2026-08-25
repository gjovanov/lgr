<template>
  <!-- date -->
  <DateField
    v-if="def.type === 'date'"
    :model-value="modelValue"
    :label="$t(def.labelKey)"
    hide-details
    density="compact"
    clearable
    @update:model-value="emit('update:modelValue', $event)"
  />

  <!-- select -->
  <v-select
    v-else-if="def.type === 'select'"
    :model-value="modelValue"
    :items="optionItems"
    item-title="title"
    item-value="value"
    :label="$t(def.labelKey)"
    :clearable="!def.required"
    hide-details
    density="compact"
    @update:model-value="emit('update:modelValue', $event)"
  />

  <!-- multiselect: one summary chip, same control the invoicing grids use -->
  <StatusMultiselect
    v-else-if="def.type === 'multiselect'"
    :model-value="Array.isArray(modelValue) ? modelValue : []"
    :items="optionItems"
    :label="$t(def.labelKey)"
    :all-label="$t('reports.params.all')"
    @update:model-value="emit('update:modelValue', $event)"
  />

  <!-- bool -->
  <v-switch
    v-else-if="def.type === 'bool'"
    :model-value="modelValue === true"
    :label="$t(def.labelKey)"
    color="primary"
    hide-details
    density="compact"
    @update:model-value="emit('update:modelValue', $event)"
  />

  <!-- entity lookups: server-side searched autocomplete -->
  <v-autocomplete
    v-else-if="lookup"
    :model-value="modelValue ?? null"
    :items="items"
    :loading="loading"
    item-title="title"
    item-value="value"
    :label="$t(def.labelKey)"
    :no-data-text="$t('list.noMatches')"
    clearable
    hide-details
    density="compact"
    :search="search"
    @update:search="onSearch"
    @update:model-value="emit('update:modelValue', $event)"
  />

  <!-- text -->
  <v-text-field
    v-else
    :model-value="modelValue"
    :label="$t(def.labelKey)"
    clearable
    hide-details
    density="compact"
    @update:model-value="emit('update:modelValue', $event)"
  />
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import DateField from 'ui-shared/components/DateField.vue'
import StatusMultiselect from 'ui-shared/components/StatusMultiselect.vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from '../store/app.store'
import type { ParamDef } from '../types/report'

/**
 * FR-06 (#14) — renders ONE registry parameter. Splitting it out of ReportRunner keeps the
 * runner readable and, more importantly, gives every entity-reference param its own
 * debounced server-side search: contact/product/category pickers must never materialise a
 * whole collection into a `<select>` (regal has ~23k products).
 *
 * A new `ParamType` is added here and nowhere else in the UI.
 */

const props = defineProps<{
  def: ParamDef
  modelValue: any
  /** Current values of the sibling params — drives `contactSideFrom`. */
  siblings?: Record<string, any>
}>()

const emit = defineEmits<{ 'update:modelValue': [value: any] }>()

const { t } = useI18n()
const appStore = useAppStore()

const LOOKUPS: Record<string, { url: string; key: string; title: (row: any) => string }> = {
  contact: {
    url: '/invoicing/contact',
    key: 'contacts',
    title: (c) => c.companyName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || '—',
  },
  warehouse: { url: '/warehouse/warehouse', key: 'warehouses', title: (w) => w.name },
  product: { url: '/warehouse/product', key: 'products', title: (p) => `${p.sku ? p.sku + ' — ' : ''}${p.name}` },
  category: { url: '/warehouse/product-category', key: 'productCategories', title: (c) => c.name },
  user: {
    url: '/user',
    key: 'users',
    title: (u) => `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || u.email || '—',
  },
}

const lookup = computed(() => LOOKUPS[props.def.type])

const items = ref<{ value: string; title: string }[]>([])
const loading = ref(false)
const search = ref('')

const optionItems = computed(() =>
  (props.def.options || []).map(o => ({ value: o.value, title: t(o.labelKey) })),
)

/** `contactSideFrom` narrows a contact picker to customers or suppliers. */
const contactSide = computed(() => {
  const spec = props.def.contactSideFrom
  if (!spec) return undefined
  return spec.map[String(props.siblings?.[spec.param] ?? '')]
})

let timer: ReturnType<typeof setTimeout> | null = null

function onSearch(value: string) {
  search.value = value
  if (!lookup.value) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => fetchItems(value), 300)
}

async function fetchItems(term?: string) {
  const cfg = lookup.value
  if (!cfg || !appStore.currentOrg?.id) return
  loading.value = true
  try {
    const params: Record<string, any> = { size: 20 }
    if (term) params.search = term
    if (props.def.type === 'contact' && contactSide.value) params.type = contactSide.value
    const { data } = await httpClient.get(`${appStore.orgUrl()}${cfg.url}`, { params })
    items.value = (data[cfg.key] || []).map((row: any) => ({
      value: row._id || row.id,
      title: cfg.title(row),
    }))
  } catch {
    // A picker that cannot load degrades to "no filter" rather than blocking the report.
    items.value = []
  } finally {
    loading.value = false
  }
}

// Re-fetch when the contact side flips (purchases ↔ sales) and clear a now-invalid pick.
watch(contactSide, (side, prev) => {
  if (side === prev) return
  if (props.modelValue) emit('update:modelValue', null)
  fetchItems(search.value)
})

onMounted(() => {
  if (lookup.value) fetchItems()
})
</script>
