<template>
  <v-container fluid>
    <h1 class="text-h4 mb-6">{{ $t('settings.organization') }}</h1>

    <v-form ref="formRef" @submit.prevent="save">
      <!-- General Settings -->
      <v-card class="mb-4">
        <v-card-title>{{ $t('settings.generalInfo') }}</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="12" sm="6"><v-text-field v-model="form.name" :label="$t('common.name')" :rules="[rules.required]" /></v-col>
            <v-col cols="12" sm="6"><v-text-field v-model="form.slug" :label="$t('settings.slug')" :rules="[rules.required, rules.slug]" /></v-col>
          </v-row>
          <v-textarea v-model="form.description" :label="$t('common.description')" rows="3" />
          <v-row>
            <v-col cols="12" sm="6">
              <v-select v-model="form.baseCurrency" :label="$t('settings.baseCurrency')" :items="currencies" />
            </v-col>
            <v-col cols="12" sm="6">
              <v-select v-model="form.defaultLocale" :label="$t('settings.defaultLocale')" :items="locales" item-title="title" item-value="value" />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Tax Configuration -->
      <v-card class="mb-4">
        <v-card-title>{{ $t('settings.taxConfig') }}</v-card-title>
        <v-card-text>
          <v-switch v-model="form.vatEnabled" :label="$t('settings.vatEnabled')" color="primary" class="mb-2" />
          <div v-if="form.vatEnabled">
            <div class="text-subtitle-2 mb-2">{{ $t('settings.vatRates') }}</div>
            <v-row v-for="(rate, i) in form.vatRates" :key="i" class="align-center">
              <v-col cols="4"><v-text-field v-model="rate.name" :label="$t('common.name')" density="compact" /></v-col>
              <v-col cols="3"><v-text-field v-model.number="rate.rate" :label="$t('settings.ratePercent')" type="number" suffix="%" density="compact" /></v-col>
              <v-col cols="3"><v-checkbox v-model="rate.default" :label="$t('settings.default')" density="compact" hide-details /></v-col>
              <v-col cols="2"><v-btn icon="mdi-delete" size="small" color="error" variant="text" @click="form.vatRates.splice(i, 1)" /></v-col>
            </v-row>
            <v-btn variant="outlined" prepend-icon="mdi-plus" size="small" @click="form.vatRates.push({ name: '', rate: 0, default: false })">
              {{ $t('settings.addVatRate') }}
            </v-btn>
          </div>
        </v-card-text>
      </v-card>

      <!-- Payroll Settings -->
      <v-card class="mb-4">
        <v-card-title>{{ $t('settings.payrollSettings') }}</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="12" sm="6">
              <v-select v-model="form.payrollCycle" :label="$t('settings.payrollCycle')" :items="['Monthly', 'Bi-weekly', 'Weekly']" />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field v-model.number="form.payDay" :label="$t('settings.payDay')" type="number" :rules="[rules.range(1, 31)]" />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" sm="6">
              <v-text-field v-model.number="form.workingHoursPerDay" :label="$t('settings.workingHoursPerDay')" type="number" :rules="[rules.range(1, 24)]" />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field v-model.number="form.workingDaysPerWeek" :label="$t('settings.workingDaysPerWeek')" type="number" :rules="[rules.range(1, 7)]" />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Modules -->
      <v-card class="mb-4">
        <v-card-title>{{ $t('settings.modules') }}</v-card-title>
        <v-card-text>
          <v-row>
            <v-col v-for="mod in modulesList" :key="mod.key" cols="12" sm="6" md="4">
              <v-switch v-model="form.modules[mod.key]" :label="mod.label" color="primary" hide-details density="compact" />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Subscription -->
      <v-card class="mb-4">
        <v-card-title>{{ $t('settings.subscription') }}</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="12" sm="4">
              <v-text-field :model-value="form.subscription?.plan || '-'" :label="$t('settings.plan')" readonly />
            </v-col>
            <v-col cols="12" sm="4">
              <v-text-field :model-value="form.subscription?.validUntil || '-'" :label="$t('settings.validUntil')" readonly />
            </v-col>
            <v-col cols="12" sm="4">
              <v-chip :color="form.subscription?.active ? 'success' : 'error'" size="large" class="mt-3">
                {{ form.subscription?.active ? $t('common.active') : $t('common.inactive') }}
              </v-chip>
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <div class="d-flex justify-end">
        <v-btn color="primary" type="submit" :loading="saving" size="large">
          {{ $t('common.save') }}
        </v-btn>
      </div>
    </v-form>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../store/settings.store'
import { useSnackbar } from '../../composables/useSnackbar'
import { useValidation } from '../../composables/useValidation'

const { t } = useI18n()
const store = useSettingsStore()
const { showSuccess, showError } = useSnackbar()
const { rules } = useValidation()
const formRef = ref()
const saving = ref(false)

const currencies = ['EUR', 'USD', 'GBP', 'CHF', 'MKD', 'BGN', 'RSD', 'BAM']
const locales = [
  { title: 'English', value: 'en' },
  { title: 'Macedonian', value: 'mk' },
  { title: 'Deutsch', value: 'de' },
]

const modulesList = [
  { key: 'accounting', label: t('nav.accounting') },
  { key: 'invoicing', label: t('nav.invoicing') },
  { key: 'warehouse', label: t('nav.warehouse') },
  { key: 'payroll', label: t('nav.payroll') },
  { key: 'hr', label: t('nav.hr') },
  { key: 'crm', label: t('nav.crm') },
  { key: 'erp', label: t('nav.erp') },
]

const form = reactive({
  name: '',
  slug: '',
  description: '',
  baseCurrency: 'EUR',
  defaultLocale: 'en',
  vatEnabled: true,
  vatRates: [] as any[],
  payrollCycle: 'Monthly',
  payDay: 25,
  workingHoursPerDay: 8,
  workingDaysPerWeek: 5,
  modules: {} as Record<string, boolean>,
  subscription: null as any,
})

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  saving.value = true
  try {
    await store.saveOrganization({ ...form })
    showSuccess('Organization settings saved')
  } catch (e: any) {
    showError(e.response?.data?.message || e.message || 'Failed to save settings')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await store.fetchOrganization()
  if (store.organization) {
    Object.assign(form, store.organization)
  }
})
</script>
