<template>
  <!-- FR-21.13: one cash-register sale or storno in full, from whichever store holds it. A sale
       already held as a document also opens on its invoicing page, where it prints and emails. -->
  <CashRegisterDocument
    :org-url="appStore.orgUrl()"
    :id="String(route.params.id)"
    :locale="appStore.locale"
    :role="role"
    :user-id="userId"
    :back-route="{ name: 'pos.orders' }"
    :related-route="(row: any) => ({ name: 'pos.orders.detail', params: { id: row.id } })"
    :document-route="(row: any) => (row.store === 'invoice' ? appHref('invoicing', `/invoicing/cash-sales/${row.id}/edit`) : null)"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from '../store/app.store'
import CashRegisterDocument from 'ui-shared/components/cash-register/CashRegisterDocument.vue'
import { jwtRole, jwtUserId } from 'ui-shared/composables/useStorageIdentity'
import { appHref } from 'ui-shared/nav/navigate'

const route = useRoute()
const appStore = useAppStore()
// The app store's user is empty on a fresh page load; the session token is the durable source.
const role = computed(() => appStore.user?.role || jwtRole())
const userId = computed(() => appStore.user?.id || jwtUserId())
</script>
