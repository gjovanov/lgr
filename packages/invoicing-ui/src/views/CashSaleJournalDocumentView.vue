<template>
  <!-- FR-21.13: a cash-register sale or storno from the journal, from whichever store holds it.
       Until R2 copies the till's history, a till sale here is still a POS row: this shows it, and
       a document opens on its own page (print, email). -->
  <CashRegisterDocument
    :org-url="appStore.orgUrl()"
    :id="String(route.params.id)"
    :locale="appStore.locale"
    :role="role"
    :user-id="userId"
    :back-route="{ name: 'invoicing.cash-sales' }"
    :related-route="journalRoute"
    :document-route="(row: any) => (row.store === 'invoice' ? { name: 'invoicing.cash-sales.edit', params: { id: row.id } } : null)"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from '../store/app.store'
import CashRegisterDocument from 'ui-shared/components/cash-register/CashRegisterDocument.vue'
import { jwtRole, jwtUserId } from 'ui-shared/composables/useStorageIdentity'

const route = useRoute()
const appStore = useAppStore()
// The app store's user is empty on a fresh page load; the session token is the durable source.
const role = computed(() => appStore.user?.role || jwtRole())
const userId = computed(() => appStore.user?.id || jwtUserId())

/** A document opens on its page; a till sale that is not one yet, here. */
function journalRoute(row: any) {
  return row.store === 'invoice'
    ? { name: 'invoicing.cash-sales.edit', params: { id: row.id } }
    : { name: 'invoicing.cash-sales.view', params: { id: row.id } }
}
</script>
