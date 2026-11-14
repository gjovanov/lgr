<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('accounting.account') : $t('common.create') + ' ' + $t('accounting.account')"
    :subtitle="isEdit ? form.name : ''"
    :actions="formActions"
    :loading="loading"
    back-to="/accounts"
    :back-label="$t('accounting.accounts')"
  >
    <!-- FR-25a §3.1: a books org's chart is as booked: the whole form is read-only, and the server refuses a save. -->
    <v-alert v-if="asBooked" type="info" variant="tonal" density="compact" icon="mdi-lock-outline" class="mb-4" data-testid="account-as-booked">
      {{ $t('accounting.accountBooks.readOnly') }}
    </v-alert>

    <v-form ref="formRef" :disabled="asBooked" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.code"
            :label="$t('accounting.accountCode')"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.name"
            :label="$t('common.name')"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-select
            v-model="form.type"
            :label="$t('accounting.accountType')"
            :items="accountTypes"
            :rules="[rules.required]"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-select
            v-model="form.subType"
            :label="$t('accounting.subType')"
            :items="subTypeOptions"
            clearable
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-autocomplete
            v-model="form.parentId"
            :label="$t('accounting.parentAccount')"
            :items="parentOptions"
            item-title="label"
            item-value="_id"
            clearable
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field
            v-model="form.currency"
            :label="$t('common.currency')"
            density="compact"
          />
        </v-col>
        <v-col cols="12">
          <v-textarea
            v-model="form.description"
            :label="$t('common.description')"
            rows="2"
            density="compact"
          />
        </v-col>
        <v-col cols="12" md="4">
          <v-switch
            v-model="form.isActive"
            :label="$t('common.active')"
            color="primary"
            density="compact"
          />
        </v-col>
      </v-row>
    </v-form>

    <!-- FR-25a §3.1: what the books say of the account. Read-only everywhere; absent on an account they never described. -->
    <template v-if="hasBooks">
      <h2 class="text-subtitle-1 font-weight-bold mt-4 mb-2 d-flex align-center ga-1">
        <v-icon size="small">mdi-lock-outline</v-icon>
        {{ $t('accounting.accountBooks.title') }}
      </h2>
      <v-row dense align="center" data-testid="account-books">
        <v-col cols="12" md="3">
          <div class="text-caption text-medium-emphasis">{{ $t('accounting.accountBooks.balanceSide') }}</div>
          <v-chip v-if="balanceSideKey(books.balanceSide)" size="small" label :color="balanceSideColor(books.balanceSide)" data-testid="account-balance-side">
            {{ $t(balanceSideKey(books.balanceSide)!) }}
          </v-chip>
          <span v-else>—</span>
        </v-col>
        <v-col cols="12" md="6">
          <div class="text-caption text-medium-emphasis">{{ $t('accounting.accountBooks.analyticRoots') }}</div>
          <div v-if="books.analyticRoots.length" class="d-flex flex-wrap ga-1">
            <!-- Each opens the analytics of its root. -->
            <v-chip
              v-for="r in books.analyticRoots"
              :key="r"
              size="small"
              label
              :to="{ name: 'accounting.analytics', query: { root: r } }"
              data-testid="account-analytic-root"
            >
              {{ rootTitle(r) }}
            </v-chip>
          </div>
          <span v-else class="text-body-2 text-medium-emphasis">{{ $t('accounting.accountBooks.noAnalyticRoots') }}</span>
        </v-col>
        <v-col cols="12" md="3">
          <v-switch :model-value="books.quantitative" :label="$t('accounting.accountBooks.quantitative')" color="primary" density="compact" hide-details disabled />
        </v-col>
      </v-row>
    </template>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" entity-type="account" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { useAccountingStore } from '../../store/accounting.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'
import { balanceSideColor, balanceSideKey, isBooksOrg, rootLabelKey, type AnalyticRootInfo, type BalanceSide } from './books-chart'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const store = useAccountingStore()
const { showSuccess, showError } = useSnackbar()

const formRef = ref()
const loading = ref(false)
const isEdit = computed(() => !!route.params.id)

/** FR-25a §3.1: the org keeps the accountant's books, and its chart is as booked there. */
const asBooked = computed(() => isBooksOrg(appStore.currentOrg as any))
/** What the books say of the account: never sent on a save. */
const books = ref<{ balanceSide?: BalanceSide; analyticRoots: string[]; quantitative: boolean }>({ analyticRoots: [], quantitative: false })
const hasBooks = computed(() => !!books.value.balanceSide || books.value.analyticRoots.length > 0 || books.value.quantitative)
const roots = ref<AnalyticRootInfo[]>([])

function rootTitle(root: string): string {
  const key = rootLabelKey(root, roots.value)
  return key ? t(key) : root
}

async function loadRoots() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/accounting/analytics/roots`)
    roots.value = data.roots ?? []
  } catch {
    // The chips show each root as booked.
  }
}

const accountTypes = ['asset', 'liability', 'equity', 'revenue', 'expense']
const subTypeOptions = [
  'current_asset', 'fixed_asset', 'current_liability', 'long_term_liability',
  'retained_earnings', 'share_capital', 'operating_revenue', 'other_revenue',
  'cost_of_goods_sold', 'operating_expense', 'other_expense',
]

const form = ref({
  code: '',
  name: '',
  type: '',
  subType: '',
  parentId: '',
  currency: '',
  description: '',
  isActive: true,
})

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'accounting',
  entityType: 'account',
  icon: 'mdi-book-open-variant',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'Code', value: form.value.code || '' },
    { label: 'Name', value: form.value.name || '' },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const parentOptions = computed(() =>
  store.accounts.map((a: any) => ({ _id: a._id, label: `${a.code} - ${a.name}` }))
)

const rules = {
  required: (v: string) => !!v || t('validation.required'),
}

const formActions = computed<FormAction[]>(() => [
  // FR-27.7: a new account is `accounts.create` (the admin's and the accountant's), a change `accounts.edit`.
  { label: t('common.save'), color: 'primary', handler: handleSubmit, cap: isEdit.value ? 'accounts.edit' : 'accounts.create', loading: loading.value, show: !asBooked.value },
])

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  loading.value = true
  try {
    if (isEdit.value) {
      await store.updateAccount(route.params.id as string, form.value)
    } else {
      await store.createAccount(form.value)
    }
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'accounting.accounts' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function loadAccount() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/accounting/account/${route.params.id}`)
    const account = data.account || data
    form.value = {
      code: account.code || '',
      name: account.name || '',
      type: account.type || '',
      subType: account.subType || '',
      parentId: account.parentId || '',
      currency: account.currency || '',
      description: account.description || '',
      isActive: account.isActive !== false,
    }
    books.value = {
      ...(account.balanceSide ? { balanceSide: account.balanceSide } : {}),
      analyticRoots: Array.isArray(account.analyticRoots) ? account.analyticRoots : [],
      quantitative: account.quantitative === true,
    }
    if (books.value.analyticRoots.length) void loadRoots()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await store.fetchAccounts()
  if (tryRestore()) return
  if (isEdit.value) {
    await loadAccount()
  }
})
</script>
