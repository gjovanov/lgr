<template>
  <BatchEmailBar
    :selected="selected"
    :kind="kind"
    :org-url="appStore.orgUrl()"
    preview-path="/invoicing/export/email/preview"
    email-path="/invoicing/export/email"
    :may-email="mayEmail"
    :org-name="appStore.currentOrg?.name"
    :locale="appStore.locale"
    :columns="columns"
    @update:selected="emit('update:selected', $event)"
  />
</template>

<script setup lang="ts">
import BatchEmailBar from 'ui-shared/components/BatchEmailBar.vue'
import { useAppStore } from '../store/app.store'
import { readPrintSettings } from '../composables/print-settings'

/**
 * A document list's ticked rows by e-mail (2026-11-16): the shared bar and dialog, told where invoicing's two routes
 * are. `invoice` is every document of the invoice collection (invoices, notes, proformas, offers, bills), `order` a
 * supplier order, which goes as one sheet per supplier.
 *
 *     <template #bulk-bar>
 *       <DocEmailBar v-model:selected="ticked" kind="invoice" :may-email="mailsTicked" />
 *     </template>
 */
const props = defineProps<{
  selected: string[]
  kind: 'invoice' | 'order'
  /** The list's answer to "does this role mail these documents" (`composables/doc-email-access`). */
  mayEmail: boolean
}>()
const emit = defineEmits<{ 'update:selected': [ids: string[]] }>()

const appStore = useAppStore()

/**
 * An invoice goes as its „Печат" prints it: with the person's own line columns (FR-22.20). An order's sheet has none
 * to choose. Read when the batch leaves, so a print made in another tab meanwhile counts.
 */
const columns = () => (props.kind === 'invoice' ? readPrintSettings().columns : undefined)
</script>
