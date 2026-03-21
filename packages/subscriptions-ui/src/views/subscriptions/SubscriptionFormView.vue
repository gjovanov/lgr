<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon="mdi-arrow-left" variant="text" :to="{ name: 'subscriptions.list' }" />
      <h1 class="text-h5 ml-2">{{ isNew ? $t('subscriptions.create') : $t('subscriptions.edit') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2" v-if="!isNew && subscription">
        <v-btn v-if="subscription.state === 'draft'" color="success" prepend-icon="mdi-check" :loading="store.loading" @click="activate">{{ $t('subscriptions.activate') }}</v-btn>
        <v-btn v-if="subscription.state === 'active'" color="warning" prepend-icon="mdi-pause" :loading="store.loading" @click="pause">{{ $t('subscriptions.pause') }}</v-btn>
        <v-btn v-if="subscription.state === 'paused'" color="success" prepend-icon="mdi-play" :loading="store.loading" @click="resume">{{ $t('subscriptions.resume') }}</v-btn>
        <v-btn v-if="subscription.state === 'active' || subscription.state === 'paused'" color="error" prepend-icon="mdi-cancel" @click="cancelDialog = true">{{ $t('subscriptions.cancel') }}</v-btn>
      </div>
    </div>

    <v-card>
      <v-card-text>
        <v-form ref="formRef">
          <v-row>
            <v-col cols="12" md="6">
              <v-text-field v-model="form.name" :label="$t('common.name')" :rules="[v => !!v || $t('required')]" :disabled="!isDraft" />
            </v-col>
            <v-col cols="12" md="6">
              <v-autocomplete v-model="form.partnerId" :label="$t('subscriptions.partner')" :items="partners" item-title="name" item-value="_id" :rules="[v => !!v || $t('required')]" :disabled="!isDraft" />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" md="3">
              <v-text-field v-model="form.dateStart" :label="$t('subscriptions.dateStart')" type="date" :rules="[v => !!v || $t('required')]" :disabled="!isDraft" />
            </v-col>
            <v-col cols="12" md="3">
              <v-text-field v-model="form.dateEnd" :label="$t('subscriptions.dateEnd')" type="date" :disabled="!isDraft" />
            </v-col>
            <v-col cols="12" md="2">
              <v-text-field v-model.number="form.recurringInterval" :label="$t('subscriptions.interval')" type="number" :rules="[v => v > 0 || $t('required')]" :disabled="!isDraft" />
            </v-col>
            <v-col cols="12" md="2">
              <v-select v-model="form.recurringPeriod" :label="$t('subscriptions.period')" :items="periods" :rules="[v => !!v || $t('required')]" :disabled="!isDraft" />
            </v-col>
            <v-col cols="12" md="2">
              <v-select v-model="form.currency" :label="$t('subscriptions.currency')" :items="['EUR', 'USD', 'GBP', 'BGN', 'MKD']" :disabled="!isDraft" />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" md="3">
              <v-switch v-model="form.autoRenew" :label="$t('subscriptions.autoRenew')" color="primary" :disabled="!isDraft" />
            </v-col>
            <v-col cols="12" md="3">
              <v-text-field v-model="form.paymentMethod" :label="$t('subscriptions.paymentMethod')" :disabled="!isDraft" />
            </v-col>
          </v-row>

          <!-- Line Items -->
          <div class="d-flex align-center mt-4 mb-2">
            <span class="text-subtitle-1 font-weight-medium">{{ $t('subscriptions.lineItems') }}</span>
            <v-spacer />
            <v-btn v-if="isDraft" size="small" variant="text" prepend-icon="mdi-plus" @click="addLine">{{ $t('common.add') }}</v-btn>
          </div>
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ $t('subscriptions.product') }}</th>
                <th>{{ $t('subscriptions.quantity') }}</th>
                <th>{{ $t('subscriptions.price') }}</th>
                <th>{{ $t('subscriptions.discount') }} %</th>
                <th class="text-end">{{ $t('subscriptions.subtotal') }}</th>
                <th v-if="isDraft"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(line, idx) in form.lines" :key="idx">
                <td style="min-width: 200px">
                  <v-text-field v-model="line.name" density="compact" hide-details :rules="[v => !!v || $t('required')]" :disabled="!isDraft" />
                </td>
                <td style="width: 100px">
                  <v-text-field v-model.number="line.quantity" density="compact" hide-details type="number" :rules="[v => v > 0 || $t('required')]" :disabled="!isDraft" />
                </td>
                <td style="width: 120px">
                  <v-text-field v-model.number="line.priceUnit" density="compact" hide-details type="number" :rules="[v => v >= 0 || $t('required')]" :disabled="!isDraft" />
                </td>
                <td style="width: 100px">
                  <v-text-field v-model.number="line.discount" density="compact" hide-details type="number" :disabled="!isDraft" />
                </td>
                <td class="text-end">{{ lineSubtotal(line) }}</td>
                <td v-if="isDraft">
                  <v-btn icon="mdi-delete" size="x-small" variant="text" color="error" @click="form.lines.splice(idx, 1)" />
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="4" class="text-end font-weight-bold">{{ $t('subscriptions.totalRecurring') }}:</td>
                <td class="text-end font-weight-bold">{{ totalRecurring }}</td>
                <td v-if="isDraft"></td>
              </tr>
            </tfoot>
          </v-table>

          <v-textarea v-model="form.notes" :label="$t('common.notes')" rows="2" class="mt-4" :disabled="!isDraft" />
        </v-form>
      </v-card-text>
      <v-card-actions v-if="isDraft">
        <v-spacer />
        <v-btn :to="{ name: 'subscriptions.list' }">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" :loading="store.loading" @click="save">{{ $t('common.save') }}</v-btn>
      </v-card-actions>
    </v-card>

    <!-- Cancel Reason Dialog -->
    <v-dialog v-model="cancelDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('subscriptions.cancelSubscription') }}</v-card-title>
        <v-card-text>
          <v-textarea v-model="cancelReason" :label="$t('subscriptions.cancellationReason')" :rules="[v => !!v || $t('required')]" rows="3" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="cancelDialog = false">{{ $t('common.close') }}</v-btn>
          <v-btn color="error" :loading="store.loading" @click="doCancel">{{ $t('subscriptions.cancel') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSubscriptionsStore, type Subscription, type SubscriptionLine } from '../../store/subscriptions.store'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useSubscriptionsStore()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const periods = ['day', 'week', 'month', 'year']
const isNew = computed(() => !route.params.id)
const subscription = ref<Subscription | null>(null)
const isDraft = computed(() => isNew.value || subscription.value?.state === 'draft')
const formRef = ref()
const cancelDialog = ref(false)
const cancelReason = ref('')
const partners = ref<{ _id: string; name: string }[]>([])

const form = ref({
  name: '',
  partnerId: '',
  dateStart: '',
  dateEnd: '',
  recurringInterval: 1,
  recurringPeriod: 'month',
  currency: 'EUR',
  autoRenew: true,
  paymentMethod: '',
  notes: '',
  lines: [] as { productId?: string; name: string; quantity: number; priceUnit: number; discount: number }[],
})

function lineSubtotal(line: { quantity: number; priceUnit: number; discount: number }) {
  const sub = line.quantity * line.priceUnit * (1 - (line.discount || 0) / 100)
  return Math.round(sub * 100) / 100
}

const totalRecurring = computed(() =>
  form.value.lines.reduce((sum, l) => sum + lineSubtotal(l), 0).toFixed(2)
)

function addLine() {
  form.value.lines.push({ name: '', quantity: 1, priceUnit: 0, discount: 0 })
}

async function fetchPartners() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`, { params: { size: 200 } })
    partners.value = (data.contacts || []).map((c: any) => ({ _id: c._id, name: c.name }))
  } catch { /* */ }
}

async function loadSubscription() {
  if (!route.params.id) return
  try {
    const data = await store.fetchSubscription(route.params.id as string)
    subscription.value = data
    form.value = {
      name: data.name,
      partnerId: data.partnerId,
      dateStart: data.dateStart?.split('T')[0] || '',
      dateEnd: data.dateEnd?.split('T')[0] || '',
      recurringInterval: data.recurringInterval,
      recurringPeriod: data.recurringPeriod,
      currency: data.currency,
      autoRenew: data.autoRenew,
      paymentMethod: data.paymentMethod || '',
      notes: data.notes || '',
      lines: (data.lines || []).map((l: SubscriptionLine) => ({
        productId: l.productId,
        name: l.name,
        quantity: l.quantity,
        priceUnit: l.priceUnit,
        discount: l.discount || 0,
      })),
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    const payload = {
      ...form.value,
      nextInvoiceDate: form.value.dateStart,
    }
    if (isNew.value) {
      const created = await store.createSubscription(payload as any)
      showSuccess(t('common.createdSuccessfully'))
      router.push({ name: 'subscriptions.edit', params: { id: created._id } })
    } else {
      await store.updateSubscription(route.params.id as string, payload as any)
      showSuccess(t('common.savedSuccessfully'))
      await loadSubscription()
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function activate() {
  try {
    await store.activateSubscription(route.params.id as string)
    showSuccess(t('subscriptions.activated'))
    await loadSubscription()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function pause() {
  try {
    await store.pauseSubscription(route.params.id as string)
    showSuccess(t('subscriptions.paused'))
    await loadSubscription()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function resume() {
  try {
    await store.resumeSubscription(route.params.id as string)
    showSuccess(t('subscriptions.resumed'))
    await loadSubscription()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function doCancel() {
  if (!cancelReason.value) return
  try {
    await store.cancelSubscription(route.params.id as string, cancelReason.value)
    cancelDialog.value = false
    showSuccess(t('subscriptions.cancelled'))
    await loadSubscription()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => {
  fetchPartners()
  loadSubscription()
})
</script>
