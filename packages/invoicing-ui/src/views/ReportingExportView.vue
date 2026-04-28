<template>
  <v-container fluid>
    <h1 class="text-h5 mb-2">{{ $t('reporting.export.title') }}</h1>
    <p class="text-body-2 text-medium-emphasis mb-4">{{ $t('reporting.export.hint') }}</p>

    <v-tabs v-model="activeKind" color="primary" class="mb-4">
      <v-tab v-for="tab in tabs" :key="tab.kind" :value="tab.kind">
        <v-icon class="mr-2">{{ tab.icon }}</v-icon>
        {{ $t(tab.titleKey) }}
      </v-tab>
    </v-tabs>

    <v-window v-model="activeKind">
      <v-window-item v-for="tab in tabs" :key="tab.kind" :value="tab.kind">
        <ReportingTabGrid
          :kind="tab.kind"
          :doc-type="tab.docType"
          :status-options="tab.statusOptions"
          :description="$t(tab.descKey)"
        />
      </v-window-item>
    </v-window>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ReportingTabGrid from '../components/ReportingTabGrid.vue'
import type { DocType } from 'ui-shared/composables/useExportColumns'

type Kind = 'outgoing' | 'incoming' | 'cash_register'

const { t } = useI18n()
const activeKind = ref<Kind>('outgoing')

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
    statusOptions: [
      { value: 'draft',     title: t('invoicing.status.draft') },
      { value: 'completed', title: t('invoicing.status.completed') },
      { value: 'paid',      title: t('invoicing.status.paid') },
    ],
  },
])
</script>
