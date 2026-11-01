<template>
  <!-- FR-21.13: a cash-register sale or storno from the journal, from whichever store holds it:
       what the till rang up reads here in full, and a storno reads as a storno and prints from
       here (`till-rules.ts#journalRoute`). -->
  <CashRegisterDocument
    :org-url="appStore.orgUrl()"
    :id="String(route.params.id)"
    :locale="appStore.locale"
    :role="role"
    :user-id="userId"
    :back-route="{ name: 'invoicing.cash-sales' }"
    :related-route="(row: any) => journalRoute(row, tillOnly)"
    :document-route="(row: any) => (!tillOnly && row.store === 'invoice' && row.kind === 'sale' ? { name: 'invoicing.cash-sales.edit', params: { id: row.id } } : null)"
    :invoice-route="tillOnly ? undefined : (inv: any) => ({ name: 'invoicing.sales.edit', params: { id: inv.id } })"
  >
    <template #actions="{ row }">
      <v-btn v-if="!tillOnly && row.store === 'invoice'" variant="outlined" prepend-icon="mdi-printer" :loading="printing" @click="print(row)">
        {{ $t('common.print') }}
      </v-btn>
    </template>
  </CashRegisterDocument>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from '../store/app.store'
import CashRegisterDocument from 'ui-shared/components/cash-register/CashRegisterDocument.vue'
import { jwtRole, jwtUserId, sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { readsDocuments } from 'ui-shared/nav/page-registry'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'
import { journalRoute } from '../pos/till-rules'

const route = useRoute()
const appStore = useAppStore()
// The app store's user is empty on a fresh page load; the session token is the durable source.
const role = computed(() => appStore.user?.role || jwtRole())
const userId = computed(() => appStore.user?.id || jwtUserId())
const { loading: printing, exportOne } = useInvoicingExport(() => appStore.orgUrl())
/** The journal's page is all of a sale someone without the documents reads: no document page, no print. */
const tillOnly = !readsDocuments(sessionViewer())

/** Печат: the document's PDF — a storno prints as „Сторно на касова продажба", naming its sale. */
function print(row: any) {
  return exportOne(row.id, row.number, 'pdf', 'detailed', undefined, appStore.locale)
}
</script>
