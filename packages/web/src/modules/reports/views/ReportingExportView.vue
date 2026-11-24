<template>
  <v-container fluid>
    <ReportPageHeader :title="$t('reporting.export.title')" :subtitle="$t('reporting.export.hint')" />

    <v-tabs v-model="activeKind" color="primary" class="mb-4">
      <v-tab v-for="tab in tabs" :key="tab.kind" :value="tab.kind">
        <v-icon class="mr-2">{{ tab.icon }}</v-icon>
        {{ $t(tab.titleKey) }}
      </v-tab>
    </v-tabs>

    <!-- Exactly ONE grid is mounted, keyed on the active tab. v-window would keep every
         visited tab alive, and three live grids would fight over the same querystring keys
         (FR-05 URL state). Keying also resets filters when switching kinds, which is what
         switching between "outgoing" and "cash register" means anyway. -->
    <ReportingTabGrid
      v-if="activeTab"
      :key="activeTab.kind"
      :kind="activeTab.kind"
      :doc-type="activeTab.docType"
      :status-options="activeTab.statusOptions"
      :description="$t(activeTab.descKey)"
    />
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ReportingTabGrid from '../components/ReportingTabGrid.vue'
import ReportPageHeader from '../components/ReportPageHeader.vue'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import type { DocType } from 'ui-shared/composables/useExportColumns'

type Kind = 'outgoing' | 'incoming' | 'cash_register'

const KINDS: Kind[] = ['outgoing', 'incoming', 'cash_register']

const { t } = useI18n()
const activeKind = ref<Kind>('outgoing')

// The chosen tab belongs in the shareable link too, alongside the grid's own filters.
useListQueryState([
  { key: 'tab', ref: activeKind, default: 'outgoing', sanitize: v => (KINDS.includes(v) ? v : undefined) },
])

const tabs = computed(() => [
  {
    kind: 'outgoing' as Kind,
    titleKey: 'reporting.export.outgoing.title',
    descKey:  'reporting.export.outgoing.desc',
    icon: 'mdi-file-export-outline',
    docType: 'invoice' as DocType,
    statusOptions: [
      { value: 'draft',          title: t('invoicing.status.draft') },
      { value: 'sent',           title: t('invoicing.status.sent') },
      { value: 'partially_paid', title: t('invoicing.status.partially_paid') },
      { value: 'paid',           title: t('invoicing.status.paid') },
      { value: 'overdue',        title: t('invoicing.status.overdue') },
      { value: 'voided',         title: t('invoicing.status.voided') },
      { value: 'cancelled',      title: t('invoicing.status.cancelled') },
    ],
  },
  {
    kind: 'incoming' as Kind,
    titleKey: 'reporting.export.incoming.title',
    descKey:  'reporting.export.incoming.desc',
    icon: 'mdi-file-import-outline',
    docType: 'bill' as DocType,
    statusOptions: [
      { value: 'draft',          title: t('invoicing.status.draft') },
      { value: 'received',       title: t('invoicing.status.received') },
      { value: 'partially_paid', title: t('invoicing.status.partially_paid') },
      { value: 'paid',           title: t('invoicing.status.paid') },
      { value: 'overdue',        title: t('invoicing.status.overdue') },
      { value: 'cancelled',      title: t('invoicing.status.cancelled') },
    ],
  },
  {
    kind: 'cash_register' as Kind,
    titleKey: 'reporting.export.cashRegister.title',
    descKey:  'reporting.export.cashRegister.desc',
    icon: 'mdi-cash-register',
    docType: 'cash_sale' as DocType,
    // The two states a cash-register document has: a sale or storno is paid, and a storno whose
    // receipt failed is voided. There is no draft, and `completed` is no Invoice status at all.
    statusOptions: [
      { value: 'paid',   title: t('invoicing.status.paid') },
      { value: 'voided', title: t('invoicing.status.voided') },
    ],
  },
])

const activeTab = computed(() => tabs.value.find(tab => tab.kind === activeKind.value) || tabs.value[0])
</script>
