<template>
  <v-container fluid>
    <h1 class="text-h4 mb-6">{{ $t('settings.organization') }}</h1>

    <v-form @submit.prevent="save">
      <!-- General Settings -->
      <v-card class="mb-4">
        <v-card-title>{{ $t('settings.generalInfo') }}</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="12" sm="6"><v-text-field v-model="form.name" :label="$t('common.name')" /></v-col>
            <v-col cols="12" sm="6"><v-text-field v-model="form.slug" :label="$t('settings.slug')" /></v-col>
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

      <!-- Company Identity (shown on outgoing invoices) -->
      <v-card class="mb-4">
        <v-card-title>{{ $t('settings.companyIdentity') }}</v-card-title>
        <v-card-text>
          <v-row dense>
            <v-col cols="12" md="6"><v-text-field v-model="form.taxNumber" :label="$t('invoicing.taxNumber')" density="compact" /></v-col>
            <v-col cols="12" md="6"><v-text-field v-model="form.vatNumber" :label="$t('invoicing.vatNumber')" density="compact" /></v-col>
          </v-row>
          <v-row dense>
            <v-col cols="12" md="4"><v-text-field v-model="form.email" :label="$t('invoicing.email')" type="email" density="compact" /></v-col>
            <v-col cols="12" md="4"><v-text-field v-model="form.phone" :label="$t('invoicing.phone')" density="compact" /></v-col>
            <v-col cols="12" md="4"><v-text-field v-model="form.website" :label="$t('invoicing.website')" density="compact" /></v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Logo (letterhead on printed documents) -->
      <v-card class="mb-4">
        <v-card-title>{{ $t('settings.logo') }}</v-card-title>
        <v-card-text>
          <div class="d-flex align-center flex-wrap ga-6">
            <div class="logo-preview d-flex align-center justify-center">
              <v-img v-if="logoUrl" :src="logoUrl" max-height="80" max-width="240" contain />
              <div v-else class="text-medium-emphasis text-caption text-center">
                <v-icon size="32" class="d-block mx-auto mb-1">mdi-image-outline</v-icon>
                {{ $t('settings.logoNone') }}
              </div>
            </div>

            <div class="flex-grow-1" style="min-width: 260px">
              <v-file-input
                v-model="logoFile"
                :label="$t('settings.logoUpload')"
                accept="image/png,image/jpeg,image/webp"
                prepend-icon="mdi-image-plus"
                density="compact"
                :disabled="!isAdmin || logoBusy"
                show-size
                @update:model-value="onLogoPicked"
              />
              <div class="text-caption text-medium-emphasis">{{ $t('settings.logoHint') }}</div>
              <v-btn
                v-if="logoUrl"
                class="mt-2"
                color="error"
                variant="text"
                size="small"
                prepend-icon="mdi-delete-outline"
                :disabled="!isAdmin"
                :loading="logoBusy"
                @click="removeLogo"
              >
                {{ $t('settings.logoRemove') }}
              </v-btn>
            </div>
          </div>
        </v-card-text>
      </v-card>

      <!-- Addresses -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <span>{{ $t('invoicing.addresses') }}</span>
          <v-spacer />
          <v-btn variant="outlined" size="small" prepend-icon="mdi-plus" @click="form.addresses.push({ type: 'billing', street: '', city: '', state: '', postalCode: '', country: '', isDefault: form.addresses.length === 0 })">
            {{ $t('invoicing.addAddress') }}
          </v-btn>
        </v-card-title>
        <v-card-text>
          <div v-for="(addr, i) in form.addresses" :key="`addr-${i}`" class="mb-3 pa-3 border rounded">
            <div class="d-flex align-center mb-2">
              <span class="text-caption">{{ $t('invoicing.address') }} {{ i + 1 }}</span>
              <v-chip v-if="addr.type" size="x-small" class="ml-2" label>{{ addr.type }}</v-chip>
              <v-spacer />
              <v-btn icon="mdi-delete" variant="text" size="x-small" color="error" @click="form.addresses.splice(i, 1)" />
            </div>
            <v-row dense>
              <v-col cols="12" md="3"><v-select v-model="addr.type" :label="$t('common.type')" :items="['billing', 'shipping', 'office']" density="compact" /></v-col>
              <v-col cols="12" md="9"><v-text-field v-model="addr.street" :label="$t('invoicing.street')" density="compact" /></v-col>
            </v-row>
            <v-row dense>
              <v-col cols="4"><v-text-field v-model="addr.city" :label="$t('invoicing.city')" density="compact" /></v-col>
              <v-col cols="4"><v-text-field v-model="addr.postalCode" :label="$t('invoicing.postalCode')" density="compact" /></v-col>
              <v-col cols="4"><v-text-field v-model="addr.country" :label="$t('invoicing.country')" density="compact" /></v-col>
            </v-row>
          </div>
          <div v-if="form.addresses.length === 0" class="text-caption text-medium-emphasis">
            {{ $t('settings.noAddresses') }}
          </div>
        </v-card-text>
      </v-card>

      <!-- Bank Details -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <span>{{ $t('invoicing.bankDetails') }}</span>
          <v-spacer />
          <v-btn variant="outlined" size="small" prepend-icon="mdi-plus" @click="form.bankDetails.push({ bankName: '', accountNumber: '', iban: '', swift: '', currency: form.baseCurrency, isDefault: form.bankDetails.length === 0 })">
            {{ $t('invoicing.addBankAccount') }}
          </v-btn>
        </v-card-title>
        <v-card-text>
          <div v-for="(bank, i) in form.bankDetails" :key="`bank-${i}`" class="mb-3 pa-3 border rounded">
            <div class="d-flex align-center mb-2">
              <span class="text-caption">{{ $t('invoicing.bankAccount') }} {{ i + 1 }}</span>
              <v-spacer />
              <v-btn icon="mdi-delete" variant="text" size="x-small" color="error" @click="form.bankDetails.splice(i, 1)" />
            </div>
            <v-row dense>
              <v-col cols="12" md="4"><v-text-field v-model="bank.bankName" :label="$t('invoicing.bankName')" density="compact" /></v-col>
              <v-col cols="12" md="4"><v-text-field v-model="bank.accountNumber" :label="$t('invoicing.accountNumber')" density="compact" /></v-col>
              <v-col cols="12" md="4"><v-text-field v-model="bank.currency" :label="$t('common.currency')" density="compact" /></v-col>
            </v-row>
            <v-row dense>
              <v-col cols="12" md="6"><v-text-field v-model="bank.iban" label="IBAN" density="compact" /></v-col>
              <v-col cols="12" md="6"><v-text-field v-model="bank.swift" label="SWIFT/BIC" density="compact" /></v-col>
            </v-row>
          </div>
          <div v-if="form.bankDetails.length === 0" class="text-caption text-medium-emphasis">
            {{ $t('settings.noBankDetails') }}
          </div>
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
              <v-text-field v-model.number="form.payDay" :label="$t('settings.payDay')" type="number" min="1" max="31" />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" sm="6">
              <v-text-field v-model.number="form.workingHoursPerDay" :label="$t('settings.workingHoursPerDay')" type="number" min="1" max="24" />
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field v-model.number="form.workingDaysPerWeek" :label="$t('settings.workingDaysPerWeek')" type="number" min="1" max="7" />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Inventory / Warehouse Settings -->
      <v-card class="mb-4">
        <v-card-title>{{ $t('settings.inventorySettings') }}</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="12" sm="6">
              <v-select
                v-model="form.defaultCostingMethod"
                :label="$t('warehouse.costingMethod')"
                :items="costingMethods"
                :hint="$t('settings.costingMethodOrgHint')"
                persistent-hint
              />
            </v-col>
            <v-col cols="12" sm="6">
              <v-switch v-model="form.allowNegativeStock" :label="$t('settings.allowNegativeStock')" color="primary" />
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

      <!-- Daily digest (FR-11 #21) -->
      <v-card class="mb-4">
        <v-card-title class="d-flex align-center">
          <v-icon class="mr-2">mdi-email-newsletter</v-icon>
          {{ $t('settings.dailyDigest.title') }}
        </v-card-title>
        <v-card-text>
          <div class="text-body-2 text-medium-emphasis mb-3">{{ $t('settings.dailyDigest.hint') }}</div>

          <v-row>
            <v-col cols="12" sm="4">
              <v-switch
                v-model="form.digestEnabled"
                :label="$t('settings.dailyDigest.enabled')"
                color="primary"
                hide-details
                density="compact"
              />
            </v-col>
            <v-col cols="12" sm="4">
              <v-select
                v-model="form.digestHour"
                :items="hourOptions"
                :label="$t('settings.dailyDigest.hour')"
                :disabled="!form.digestEnabled"
                :hint="$t('settings.dailyDigest.hourHint', { tz: orgTimezone })"
                persistent-hint
                density="compact"
              />
            </v-col>
            <v-col cols="12" sm="4">
              <v-select
                v-model="form.digestLocale"
                :items="localeOptions"
                :label="$t('settings.dailyDigest.locale')"
                :disabled="!form.digestEnabled"
                density="compact"
              />
            </v-col>
          </v-row>

          <v-autocomplete
            v-model="form.digestRecipients"
            :items="digestUsers"
            item-title="label"
            item-value="id"
            :label="$t('settings.dailyDigest.recipients')"
            :disabled="!form.digestEnabled"
            :loading="usersLoading"
            multiple
            chips
            closable-chips
            density="compact"
            :hint="$t('settings.dailyDigest.recipientsHint')"
            persistent-hint
          />

          <div class="text-body-2 font-weight-medium mt-4 mb-1">{{ $t('settings.dailyDigest.sections') }}</div>
          <v-row dense>
            <v-col v-for="s in digestSections" :key="s" cols="12" sm="6" md="4">
              <v-checkbox
                v-model="form.digestSections[s]"
                :label="$t(`settings.dailyDigest.section.${s}`)"
                :disabled="!form.digestEnabled"
                density="compact"
                hide-details
              />
            </v-col>
          </v-row>

          <v-divider class="my-3" />

          <div class="d-flex align-center flex-wrap ga-2">
            <v-btn
              variant="outlined"
              prepend-icon="mdi-email-fast-outline"
              :loading="digestTesting"
              :disabled="!form.digestEnabled"
              @click="sendTestDigest"
            >
              {{ $t('settings.dailyDigest.sendTest') }}
            </v-btn>
            <span class="text-caption text-medium-emphasis">{{ $t('settings.dailyDigest.sendTestHint') }}</span>
            <v-spacer />
            <!-- Read-only last-run line: the only place a `skipped` run is visible, since
                 an unconfigured provider writes no EmailLog row at all. -->
            <span v-if="lastRun" class="text-caption">
              <v-icon size="small" :color="lastRunColor" class="mr-1">{{ lastRunIcon }}</v-icon>
              {{ $t(`settings.dailyDigest.status.${lastRun.status}`) }}
              · {{ lastRun.date }}
              <template v-if="lastRun.reason"> · {{ lastRun.reason }}</template>
              <template v-if="lastRun.recipients?.length">
                · {{ lastRun.recipients.filter((r: any) => r.ok).length }}/{{ lastRun.recipients.length }}
              </template>
            </span>
            <span v-else class="text-caption text-medium-emphasis">{{ $t('settings.dailyDigest.neverRun') }}</span>
          </div>
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
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../store/settings.store'
import { useAppStore } from '../../store/app.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { jwtRole } from 'ui-shared/composables/useStorageIdentity'
import { resizeImage, ImageResizeError } from 'ui-shared/composables/useImageResize'

const { t } = useI18n()
const store = useSettingsStore()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const saving = ref(false)

// ── Logo ──
// The endpoint is bearer-authenticated, so the image cannot be an <img src="/api/..."> —
// it is fetched as a blob and shown from an object URL, which is revoked on replace/unmount.
const logoFile = ref<File | File[] | null>(null)
const logoUrl = ref<string>('')
const logoBusy = ref(false)
// The store's `user` is null until /auth/me runs, which does not happen on a plain page load —
// so fall back to the JWT, which is always there. (The server enforces admin on POST/DELETE.)
const isAdmin = computed(() => ((appStore.user as any)?.role || jwtRole()) === 'admin')

function setLogoObjectUrl(blob: Blob | null) {
  if (logoUrl.value) URL.revokeObjectURL(logoUrl.value)
  logoUrl.value = blob ? URL.createObjectURL(blob) : ''
}

async function loadLogo() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/logo`, { responseType: 'blob' })
    setLogoObjectUrl(data as Blob)
  } catch {
    // 404 — this org prints the bundled letterhead.
    setLogoObjectUrl(null)
  }
}

async function onLogoPicked(picked: File | File[] | null) {
  const file = Array.isArray(picked) ? picked[0] : picked
  if (!file) return
  logoBusy.value = true
  try {
    const resized = await resizeImage(file)
    await store.uploadLogo(resized)
    await loadLogo()
    logoFile.value = null
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    const message = e instanceof ImageResizeError
      ? e.message
      : e?.response?.data?.message || t('common.operationFailed')
    showError(message)
    logoFile.value = null
  } finally {
    logoBusy.value = false
  }
}

async function removeLogo() {
  logoBusy.value = true
  try {
    await store.deleteLogo()
    setLogoObjectUrl(null)
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    logoBusy.value = false
  }
}

onBeforeUnmount(() => setLogoObjectUrl(null))

const currencies = ['EUR', 'USD', 'GBP', 'CHF', 'MKD', 'BGN', 'RSD', 'BAM']
const locales = [
  { title: 'English', value: 'en' },
  { title: 'Български', value: 'bg' },
  { title: 'Deutsch', value: 'de' },
  { title: 'Македонски', value: 'mk' },
]

const costingMethods = [
  { title: t('warehouse.costingWAC'), value: 'wac' },
  { title: 'FIFO', value: 'fifo' },
  { title: 'LIFO', value: 'lifo' },
  { title: 'FEFO', value: 'fefo' },
  { title: t('warehouse.costingStandard'), value: 'standard' },
]

const modulesList = [
  { key: 'accounting', label: t('nav.accounting') },
  { key: 'trade', label: t('nav.trade') },
  { key: 'payroll', label: t('nav.payroll') },
  { key: 'hr', label: t('nav.hr') },
  { key: 'crm', label: t('nav.crm') },
  { key: 'erp', label: t('nav.erp') },
]

const form = reactive({
  name: '',
  slug: '',
  description: '',
  taxNumber: '',
  vatNumber: '',
  email: '',
  phone: '',
  website: '',
  addresses: [] as Array<{ type: string; street: string; city: string; state?: string; postalCode: string; country: string; isDefault?: boolean }>,
  bankDetails: [] as Array<{ bankName: string; accountNumber?: string; iban?: string; swift?: string; currency?: string; isDefault?: boolean }>,
  baseCurrency: 'EUR',
  defaultLocale: 'en',
  vatEnabled: true,
  vatRates: [] as any[],
  payrollCycle: 'Monthly',
  payDay: 25,
  workingHoursPerDay: 8,
  workingDaysPerWeek: 5,
  defaultCostingMethod: 'wac',
  allowNegativeStock: false,
  modules: {} as Record<string, boolean>,
  subscription: null as any,
  // FR-11 (#21) — daily digest.
  digestEnabled: false,
  digestHour: 7,
  digestLocale: '',
  digestRecipients: [] as string[],
  digestSections: {} as Record<string, boolean>,
})

// ── FR-11 (#21): daily digest ───────────────────────────────────────────────

const digestSections = [
  'kpis', 'documents', 'materials', 'stock', 'corrections',
  'undocumentedSales', 'duplicates', 'editedAfterIssue', 'ops',
]
const hourOptions = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  title: `${String(h).padStart(2, '0')}:00`,
}))
const localeOptions = [
  { value: '', title: t('settings.dailyDigest.localeDefault') },
  { value: 'en', title: 'English' },
  { value: 'bg', title: 'Български' },
  { value: 'de', title: 'Deutsch' },
  { value: 'mk', title: 'Македонски' },
]

const digestUsers = ref<{ id: string; label: string }[]>([])
const usersLoading = ref(false)
const digestTesting = ref(false)
const lastRun = ref<any>(null)
/** The hour is meaningless without saying which clock it is on (edge case 9). */
const orgTimezone = ref('')

const lastRunColor = computed(() => ({
  sent: 'success', partial: 'warning', failed: 'error', skipped: 'grey', running: 'info',
}[lastRun.value?.status as string] || 'grey'))
const lastRunIcon = computed(() => ({
  sent: 'mdi-check-circle', partial: 'mdi-alert', failed: 'mdi-close-circle',
  skipped: 'mdi-minus-circle', running: 'mdi-progress-clock',
}[lastRun.value?.status as string] || 'mdi-help-circle'))

async function loadDigestUsers() {
  usersLoading.value = true
  try {
    // `size=0` means "all" here. The response no longer carries password hashes (FR-11.3).
    const { data } = await httpClient.get(`${appStore.orgUrl()}/user`, { params: { size: 0 } })
    digestUsers.value = (data.users || []).map((u: any) => ({
      id: String(u._id || u.id),
      label: `${[u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || u.email}${u.email ? ` <${u.email}>` : ''}`,
    }))
  } catch {
    digestUsers.value = []
  } finally {
    usersLoading.value = false
  }
}

async function loadLastRun() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/digest/last-run`)
    lastRun.value = data.run
  } catch {
    lastRun.value = null
  }
}

async function sendTestDigest() {
  digestTesting.value = true
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/digest/test`, {})
    showSuccess(t('settings.dailyDigest.sentTo', { to: data.to }))
  } catch (e: any) {
    // "not configured" is a 503 with an explicit message — it must reach the operator
    // verbatim rather than becoming a generic failure.
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    digestTesting.value = false
  }
}

async function save() {
  saving.value = true
  try {
    const enabledModules = Object.entries(form.modules)
      .filter(([, v]) => v)
      .map(([k]) => k)

    const payload = {
      name: form.name,
      description: form.description,
      taxNumber: form.taxNumber || undefined,
      vatNumber: form.vatNumber || undefined,
      email: form.email || undefined,
      phone: form.phone || undefined,
      website: form.website || undefined,
      addresses: form.addresses.length ? form.addresses : undefined,
      bankDetails: form.bankDetails.length ? form.bankDetails : undefined,
      settings: {
        baseCurrency: form.baseCurrency,
        locale: form.defaultLocale,
        modules: enabledModules,
        taxConfig: {
          vatEnabled: form.vatEnabled,
          vatRates: form.vatRates,
        },
        inventory: {
          defaultCostingMethod: form.defaultCostingMethod,
          allowNegativeStock: form.allowNegativeStock,
        },
        payroll: {
          payFrequency: form.payrollCycle,
        },
        // FR-11.1 (#21). The whole block goes every time: `findByIdAndUpdate` REPLACES the
        // settings subdocument, so a partial send silently drops whatever it omits.
        dailyDigest: {
          enabled: form.digestEnabled,
          hour: form.digestHour,
          locale: form.digestLocale || undefined,
          recipients: form.digestRecipients.map(id => ({ userId: id })),
          sections: { ...form.digestSections },
        },
      },
    }

    await store.saveOrganization(payload)
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  loadLogo()
  await store.fetchOrganization()
  const org = store.organization as any
  if (org) {
    form.name = org.name || ''
    form.slug = org.slug || ''
    form.description = org.description || ''
    form.taxNumber = org.taxNumber || ''
    form.vatNumber = org.vatNumber || ''
    form.email = org.email || ''
    form.phone = org.phone || ''
    form.website = org.website || ''
    form.addresses = (org.addresses || []).map((a: any) => ({ ...a }))
    form.bankDetails = (org.bankDetails || []).map((b: any) => ({ ...b }))
    form.baseCurrency = org.settings?.baseCurrency || 'EUR'
    form.defaultLocale = org.settings?.locale || 'en'
    form.vatEnabled = org.settings?.taxConfig?.vatEnabled ?? true
    form.vatRates = org.settings?.taxConfig?.vatRates?.map((r: any) => ({ ...r })) || []
    form.payrollCycle = org.settings?.payroll?.payFrequency || 'Monthly'
    form.payDay = org.settings?.payroll?.payDay || 25
    form.workingHoursPerDay = org.settings?.payroll?.workingHoursPerDay || 8
    form.workingDaysPerWeek = org.settings?.payroll?.workingDaysPerWeek || 5
    form.defaultCostingMethod = org.settings?.inventory?.defaultCostingMethod || 'wac'
    form.allowNegativeStock = org.settings?.inventory?.allowNegativeStock || false
    form.subscription = org.subscription || null

    // Build modules toggle map
    const enabledModules = org.settings?.modules || []
    for (const mod of modulesList) {
      form.modules[mod.key] = enabledModules.includes(mod.key)
    }

    // FR-11 (#21) — daily digest. Sections default ON: a digest nobody tuned should be the
    // full picture, and switching a part off is the deliberate act.
    const dg = org.settings?.dailyDigest || {}
    form.digestEnabled = dg.enabled ?? false
    form.digestHour = dg.hour ?? 7
    form.digestLocale = dg.locale || ''
    form.digestRecipients = (dg.recipients || []).map((r: any) => String(r.userId)).filter(Boolean)
    for (const s of digestSections) form.digestSections[s] = dg.sections?.[s] ?? true
    orgTimezone.value = org.settings?.timezone || 'UTC'
  }

  await Promise.all([loadDigestUsers(), loadLastRun()])
})
</script>

<style scoped>
/* Fixed frame so the card does not jump between "no logo" and a loaded one. */
.logo-preview {
  width: 260px;
  height: 96px;
  border: 1px dashed rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 4px;
  padding: 8px;
}
</style>
