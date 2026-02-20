<template>
  <v-container>
    <v-row>
      <v-col>
        <h1 class="text-h4 mb-4">{{ $t('dashboard.title') }}</h1>
      </v-col>
    </v-row>
    <v-row>
      <v-col cols="12" md="6" lg="3">
        <v-card>
          <v-card-text class="text-center">
            <v-icon size="48" color="green">mdi-cash-multiple</v-icon>
            <h3 class="text-h5 mt-2">--</h3>
            <p class="text-body-2 text-grey">{{ $t('dashboard.totalRevenue') }}</p>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" md="6" lg="3">
        <v-card>
          <v-card-text class="text-center">
            <v-icon size="48" color="orange">mdi-receipt-text</v-icon>
            <h3 class="text-h5 mt-2">--</h3>
            <p class="text-body-2 text-grey">{{ $t('dashboard.outstandingInvoices') }}</p>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" md="6" lg="3">
        <v-card>
          <v-card-text class="text-center">
            <v-icon size="48" color="blue">mdi-package-variant</v-icon>
            <h3 class="text-h5 mt-2">--</h3>
            <p class="text-body-2 text-grey">{{ $t('dashboard.stockValue') }}</p>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" md="6" lg="3">
        <v-card>
          <v-card-text class="text-center">
            <v-icon size="48" color="purple">mdi-account-group</v-icon>
            <h3 class="text-h5 mt-2">--</h3>
            <p class="text-body-2 text-grey">{{ $t('dashboard.activeEmployees') }}</p>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>
