<template>
  <v-container class="py-8">
    <h1 class="text-h4 font-weight-bold mb-2">Billing & Subscription</h1>
    <p class="text-body-1 text-medium-emphasis mb-8">Manage your organization's plan and billing</p>

    <v-alert v-if="$route.query.success" type="success" closable class="mb-6">
      Subscription updated successfully! Changes may take a moment to reflect.
    </v-alert>
    <v-alert v-if="$route.query.canceled" type="info" closable class="mb-6">
      Checkout was canceled. No changes were made.
    </v-alert>

    <!-- Current Plan -->
    <v-card variant="outlined" class="mb-8 pa-6">
      <div class="d-flex align-center justify-space-between flex-wrap ga-4">
        <div>
          <div class="text-overline text-medium-emphasis">Current Plan</div>
          <div class="text-h5 font-weight-bold text-capitalize">{{ currentPlan }}</div>
          <div v-if="subscription?.status" class="mt-1">
            <v-chip
              :color="subscription.status === 'active' ? 'success' : 'warning'"
              size="small"
              variant="tonal"
            >
              {{ subscription.status }}
            </v-chip>
            <span v-if="subscription.cancelAtPeriodEnd" class="text-body-2 text-warning ml-2">
              Cancels at period end
            </span>
          </div>
          <div v-if="subscription?.currentPeriodEnd" class="text-body-2 text-medium-emphasis mt-1">
            Current period ends: {{ new Date(subscription.currentPeriodEnd).toLocaleDateString() }}
          </div>
        </div>
        <v-btn
          v-if="subscription?.stripeCustomerId"
          variant="outlined"
          @click="openPortal"
          :loading="portalLoading"
        >
          Manage Subscription
        </v-btn>
      </div>
    </v-card>

    <!-- Plans -->
    <h2 class="text-h5 font-weight-bold mb-4">Available Plans</h2>
    <v-row>
      <v-col v-for="plan in plans" :key="plan.id" cols="12" sm="6" md="4">
        <v-card
          :variant="plan.id === currentPlan ? 'elevated' : 'outlined'"
          :elevation="plan.id === currentPlan ? 4 : 0"
          class="pa-6 h-100 d-flex flex-column"
          rounded="lg"
          :class="{ 'border-primary': plan.id === currentPlan }"
        >
          <div class="text-h6 font-weight-bold">{{ plan.name }}</div>
          <div class="my-4">
            <span class="text-h4 font-weight-bold">${{ plan.price }}</span>
            <span v-if="plan.price > 0" class="text-body-2 text-medium-emphasis">/user/mo</span>
            <span v-else class="text-body-2 text-medium-emphasis">forever</span>
          </div>
          <v-divider class="mb-4" />
          <v-list density="compact" class="flex-grow-1 bg-transparent">
            <v-list-item title="Users" :subtitle="plan.limits.maxUsers === -1 ? 'Unlimited' : String(plan.limits.maxUsers)" prepend-icon="mdi-account-group" />
            <v-list-item title="Records/Module" :subtitle="plan.limits.maxRecordsPerModule === -1 ? 'Unlimited' : String(plan.limits.maxRecordsPerModule)" prepend-icon="mdi-database" />
            <v-list-item title="Modules" :subtitle="plan.limits.modules.join(', ')" prepend-icon="mdi-view-module" />
            <v-list-item title="AI Recognition" :subtitle="plan.limits.aiRecognition ? 'Yes' : 'No'" :prepend-icon="plan.limits.aiRecognition ? 'mdi-check-circle' : 'mdi-close-circle'" />
            <v-list-item title="Cloud Storage" :subtitle="plan.limits.cloudStorage ? 'Yes' : 'No'" :prepend-icon="plan.limits.cloudStorage ? 'mdi-check-circle' : 'mdi-close-circle'" />
            <v-list-item title="Advanced Export" :subtitle="plan.limits.advancedExport ? 'Yes' : 'No'" :prepend-icon="plan.limits.advancedExport ? 'mdi-check-circle' : 'mdi-close-circle'" />
          </v-list>
          <v-btn
            v-if="plan.id !== 'free' && plan.id !== currentPlan"
            color="primary"
            block
            size="large"
            class="mt-4"
            @click="checkout(plan.id)"
            :loading="checkoutLoading === plan.id"
          >
            {{ currentPlan === 'free' ? 'Upgrade' : 'Switch' }} to {{ plan.name }}
          </v-btn>
          <v-btn
            v-else-if="plan.id === currentPlan"
            color="primary"
            variant="tonal"
            block
            size="large"
            class="mt-4"
            disabled
          >
            Current Plan
          </v-btn>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { httpClient } from '../../composables/useHttpClient'

const route = useRoute()

interface PlanLimit {
  maxUsers: number
  maxRecordsPerModule: number
  modules: string[]
  aiRecognition: boolean
  cloudStorage: boolean
  advancedExport: boolean
  customRoles: boolean
}

interface Plan {
  id: string
  name: string
  price: number
  limits: PlanLimit
}

const plans = ref<Plan[]>([])
const portalLoading = ref(false)
const checkoutLoading = ref<string | null>(null)

const org = computed(() => {
  try {
    return JSON.parse(localStorage.getItem('lgr_org') || '{}')
  } catch { return {} }
})

const subscription = computed(() => {
  return org.value?.subscription || {}
})

const currentPlan = computed(() => {
  return subscription.value?.plan || 'free'
})

async function fetchPlans() {
  try {
    const { data } = await httpClient.get('/stripe/plans')
    plans.value = data.plans
  } catch (e) {
    console.error('Failed to fetch plans:', e)
  }
}

async function checkout(planId: string) {
  checkoutLoading.value = planId
  try {
    const { data } = await httpClient.post('/stripe/checkout', { planId })
    if (data.url) window.location.href = data.url
  } catch (e) {
    console.error('Checkout failed:', e)
  } finally {
    checkoutLoading.value = null
  }
}

async function openPortal() {
  portalLoading.value = true
  try {
    const { data } = await httpClient.post('/stripe/portal')
    if (data.url) window.location.href = data.url
  } catch (e) {
    console.error('Portal failed:', e)
  } finally {
    portalLoading.value = false
  }
}

onMounted(fetchPlans)
</script>
