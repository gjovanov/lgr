<template>
  <!-- FR-21.13: a cash-register sale or storno from the journal, from whichever store holds it.
       A sale held as a document opens on its own page (print, email); a storno is shown here,
       where it reads as a storno, and prints from here. -->
  <CashRegisterDocument
    :org-url="appStore.orgUrl()"
    :id="String(route.params.id)"
    :locale="appStore.locale"
    :role="role"
    :user-id="userId"
    :back-route="{ name: 'invoicing.cash-sales' }"
    :related-route="journalRoute"
    :document-route="(row: any) => (row.store === 'invoice' && row.kind === 'sale' ? { name: 'invoicing.cash-sales.edit', params: { id: row.id } } : null)"
  >
    <template #actions="{ row }">
      <v-btn v-if="row.store === 'invoice'" variant="outlined" prepend-icon="mdi-printer" :loading="printing" @click="print(row)">
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
import { jwtRole, jwtUserId } from 'ui-shared/composables/useStorageIdentity'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'

const route = useRoute()
const appStore = useAppStore()
// The app store's user is empty on a fresh page load; the session token is the durable source.
const role = computed(() => appStore.user?.role || jwtRole())
const userId = computed(() => appStore.user?.id || jwtUserId())
const { loading: printing, exportOne } = useInvoicingExport(() => appStore.orgUrl())

/** A sale held as a document opens on its page; a storno, and a till sale that is not one yet, here. */
function journalRoute(row: any) {
  return row.store === 'invoice' && row.kind === 'sale'
    ? { name: 'invoicing.cash-sales.edit', params: { id: row.id } }
    : { name: 'invoicing.cash-sales.view', params: { id: row.id } }
}

/** Печат: the document's PDF — a storno prints as „Сторно на касова продажба", naming its sale. */
function print(row: any) {
  return exportOne(row.id, row.number, 'pdf', 'detailed', undefined, appStore.locale)
}
</script>
