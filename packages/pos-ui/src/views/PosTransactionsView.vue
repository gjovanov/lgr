<template>
  <!-- FR-21.13: the cash-register journal („Касови продажби"), the same page as invoicing's
       /cash-sales — the till's sales, the back office's and the imports'. -->
  <CashRegisterJournal
    :org-url="appStore.orgUrl()"
    :locale="appStore.locale"
    :role="role"
    :user-id="userId"
    :detail-route="(row: any) => ({ name: 'pos.orders.detail', params: { id: row.id } })"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../store/app.store'
import CashRegisterJournal from 'ui-shared/components/cash-register/CashRegisterJournal.vue'
import { jwtRole, jwtUserId } from 'ui-shared/composables/useStorageIdentity'

const appStore = useAppStore()
// The app store's user is empty on a fresh page load; the session token is the durable source.
const role = computed(() => appStore.user?.role || jwtRole())
const userId = computed(() => appStore.user?.id || jwtUserId())
</script>
