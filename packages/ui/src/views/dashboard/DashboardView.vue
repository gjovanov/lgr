<template>
  <v-container fluid>
    <h1 class="text-h4 mb-6">{{ $t('dashboard.title') }}</h1>

    <v-row>
      <v-col cols="12" sm="6" lg="3">
        <v-card color="primary" variant="tonal">
          <v-card-text>
            <div class="d-flex align-center">
              <v-icon size="48" class="mr-4">mdi-cash-multiple</v-icon>
              <div>
                <div class="text-h5 font-weight-bold">€ 0.00</div>
                <div class="text-body-2">{{ $t('dashboard.totalRevenue') }}</div>
                <div class="text-caption text-grey">{{ $t('dashboard.thisMonth') }}</div>
              </div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" sm="6" lg="3">
        <v-card color="warning" variant="tonal">
          <v-card-text>
            <div class="d-flex align-center">
              <v-icon size="48" class="mr-4">mdi-receipt-text-clock</v-icon>
              <div>
                <div class="text-h5 font-weight-bold">0</div>
                <div class="text-body-2">{{ $t('dashboard.outstandingInvoices') }}</div>
              </div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" sm="6" lg="3">
        <v-card color="info" variant="tonal">
          <v-card-text>
            <div class="d-flex align-center">
              <v-icon size="48" class="mr-4">mdi-warehouse</v-icon>
              <div>
                <div class="text-h5 font-weight-bold">€ 0.00</div>
                <div class="text-body-2">{{ $t('dashboard.stockValue') }}</div>
              </div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" sm="6" lg="3">
        <v-card color="success" variant="tonal">
          <v-card-text>
            <div class="d-flex align-center">
              <v-icon size="48" class="mr-4">mdi-account-group</v-icon>
              <div>
                <div class="text-h5 font-weight-bold">0</div>
                <div class="text-body-2">{{ $t('dashboard.activeEmployees') }}</div>
              </div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-row class="mt-4">
      <v-col cols="12" md="8">
        <v-card>
          <v-card-title>{{ $t('dashboard.recentActivity') }}</v-card-title>
          <v-card-text>
            <v-list>
              <v-list-item v-for="i in 5" :key="i" :title="`Activity item ${i}`" subtitle="Just now">
                <template #prepend><v-icon color="primary">mdi-circle-small</v-icon></template>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" md="4">
        <v-card>
          <v-card-title>Quick Actions</v-card-title>
          <v-card-text>
            <v-btn block color="primary" variant="outlined" class="mb-2" to="/invoicing/sales/new" prepend-icon="mdi-plus">New Invoice</v-btn>
            <v-btn block color="primary" variant="outlined" class="mb-2" to="/accounting/journal-entries/new" prepend-icon="mdi-plus">New Journal Entry</v-btn>
            <v-btn block color="primary" variant="outlined" class="mb-2" to="/warehouse/products/new" prepend-icon="mdi-plus">New Product</v-btn>
            <v-btn block color="primary" variant="outlined" to="/crm/leads" prepend-icon="mdi-account-plus">New Lead</v-btn>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
</script>
