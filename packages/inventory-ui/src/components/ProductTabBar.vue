<template>
  <v-tabs :model-value="activeTab" density="compact" class="mb-4" show-arrows>
    <v-tab
      v-for="t in tabs"
      :key="t.value"
      :value="t.value"
      :disabled="t.disabled"
      @click="t.disabled ? null : goTo(t.value)"
    >
      <v-icon v-if="t.icon" size="small" start>{{ t.icon }}</v-icon>
      {{ t.label }}
      <v-tooltip v-if="t.disabled" activator="parent" location="top">
        {{ $t('warehouse.tabDisabledUntilSave') }}
      </v-tooltip>
    </v-tab>
  </v-tabs>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

const props = defineProps<{
  /** URL tab slug — one of edit|pricing|settings|stock|ledger|movements|levels */
  activeTab: string
  /** When true, non-edit tabs are disabled (create flow — save first). */
  isNew?: boolean
  /** Product id (for URL construction). Ignored when isNew. */
  productId?: string
}>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

// FR-04 (#11): the LABEL VALUES of tabLedger/tabMovements are deliberately inverted in the
// locale files — users call the per-line journal (/ledger) "Movements"/"Движения" and the
// document list (/movements) "Ledger"/"Дневник". Keys, slugs and routes are unchanged;
// do not "fix" the locale values back.
const tabs = computed(() => [
  { value: 'edit',      label: t('warehouse.tabEdit'),      icon: 'mdi-pencil',            disabled: false },
  { value: 'pricing',   label: t('warehouse.tabPricing'),   icon: 'mdi-currency-usd',      disabled: false },
  { value: 'settings',  label: t('warehouse.tabSettings'),  icon: 'mdi-cog-outline',       disabled: false },
  { value: 'stock',     label: t('warehouse.tabStock'),     icon: 'mdi-warehouse',         disabled: !!props.isNew },
  { value: 'ledger',    label: t('warehouse.tabLedger'),    icon: 'mdi-book-open-variant', disabled: !!props.isNew },
  { value: 'movements', label: t('warehouse.tabMovements'), icon: 'mdi-swap-horizontal',   disabled: !!props.isNew },
  { value: 'levels',    label: t('warehouse.tabLevels'),    icon: 'mdi-counter',           disabled: !!props.isNew },
])

function goTo(tab: string) {
  const isFormTab = tab === 'edit' || tab === 'pricing' || tab === 'settings'
  const routeName = props.isNew
    ? 'inventory.products.new'
    : (isFormTab ? 'inventory.products.edit' : 'inventory.products.stock')
  const params: Record<string, string> = { tab }
  if (!props.isNew) params.id = (props.productId || route.params.id) as string
  router.push({ name: routeName, params })
}
</script>
