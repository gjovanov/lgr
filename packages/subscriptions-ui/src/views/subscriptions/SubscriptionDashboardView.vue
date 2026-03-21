<template>
  <v-container fluid>
    <h1 class="text-h5 mb-4">{{ $t('subscriptions.dashboard') }}</h1>

    <v-row>
      <v-col cols="12" md="4">
        <v-card>
          <v-card-item>
            <template #prepend>
              <v-avatar color="success" size="48">
                <v-icon color="white">mdi-currency-usd</v-icon>
              </v-avatar>
            </template>
            <v-card-title class="text-h6">{{ formatAmount(store.totalMRR) }}</v-card-title>
            <v-card-subtitle>{{ $t('subscriptions.totalMRR') }}</v-card-subtitle>
          </v-card-item>
        </v-card>
      </v-col>
      <v-col cols="12" md="4">
        <v-card>
          <v-card-item>
            <template #prepend>
              <v-avatar color="primary" size="48">
                <v-icon color="white">mdi-account-check</v-icon>
              </v-avatar>
            </template>
            <v-card-title class="text-h6">{{ store.activeSubscriptions.length }}</v-card-title>
            <v-card-subtitle>{{ $t('subscriptions.activeCount') }}</v-card-subtitle>
          </v-card-item>
        </v-card>
      </v-col>
      <v-col cols="12" md="4">
        <v-card>
          <v-card-item>
            <template #prepend>
              <v-avatar color="info" size="48">
                <v-icon color="white">mdi-chart-line</v-icon>
              </v-avatar>
            </template>
            <v-card-title class="text-h6">{{ formatAmount(store.averageValue) }}</v-card-title>
            <v-card-subtitle>{{ $t('subscriptions.avgValue') }}</v-card-subtitle>
          </v-card-item>
        </v-card>
      </v-col>
    </v-row>

    <v-card class="mt-6">
      <v-card-title>{{ $t('subscriptions.activeSubscriptions') }}</v-card-title>
      <v-card-text>
        <v-table v-if="store.activeSubscriptions.length">
          <thead>
            <tr>
              <th>{{ $t('common.name') }}</th>
              <th>{{ $t('subscriptions.partner') }}</th>
              <th>{{ $t('subscriptions.recurringPeriod') }}</th>
              <th class="text-end">{{ $t('subscriptions.amountRecurring') }}</th>
              <th>{{ $t('subscriptions.nextInvoiceDate') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="sub in store.activeSubscriptions" :key="sub._id">
              <td>
                <router-link :to="{ name: 'subscriptions.edit', params: { id: sub._id } }" class="text-decoration-none">{{ sub.name }}</router-link>
              </td>
              <td>{{ sub.partnerName || sub.partnerId }}</td>
              <td>{{ sub.recurringInterval }} {{ sub.recurringPeriod }}</td>
              <td class="text-end">{{ formatAmount(sub.amountRecurring) }}</td>
              <td>{{ sub.nextInvoiceDate?.split('T')[0] || '-' }}</td>
            </tr>
          </tbody>
        </v-table>
        <v-alert v-else type="info">{{ $t('subscriptions.noActiveSubscriptions') }}</v-alert>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useSubscriptionsStore } from '../../store/subscriptions.store'

const store = useSubscriptionsStore()

function formatAmount(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(amount || 0)
}

onMounted(() => {
  store.fetchSubscriptions({ size: 200 })
})
</script>
