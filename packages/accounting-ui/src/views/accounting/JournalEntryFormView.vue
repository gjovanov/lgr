<template>
  <EntityFormShell
    :title="isEdit ? $t('accounting.editJournalEntry') : $t('accounting.newJournalEntry')"
    :subtitle="isEdit ? entryNumber : ''"
    :status="isEdit ? { steps: [$t('common.draft'), $t('common.posted'), $t('common.voided')], current: statusLabel } : undefined"
    :actions="formActions"
    :smart-buttons="isEdit ? smartButtons : undefined"
    :loading="store.loading"
    back-to="/journal-entries"
  >
    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="3">
          <v-text-field
            v-model="form.date"
            :label="$t('common.date')"
            type="date"
            :rules="[rules.required, rules.validDate]"
            :disabled="entryStatus !== 'draft'"
          />
        </v-col>
        <v-col cols="12" md="3">
          <v-text-field
            v-model="form.reference"
            :label="$t('accounting.reference')"
            :disabled="entryStatus !== 'draft'"
          />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="form.description"
            :label="$t('common.description')"
            :rules="[rules.required]"
            :disabled="entryStatus !== 'draft'"
          />
        </v-col>
      </v-row>

      <div class="d-flex align-center mt-4 mb-2">
        <span class="text-subtitle-1 font-weight-medium">{{ $t('accounting.lines') }}</span>
        <v-spacer />
        <v-btn
          v-if="entryStatus === 'draft'"
          color="primary"
          variant="outlined"
          size="small"
          prepend-icon="mdi-plus"
          @click="addLine"
        >
          {{ $t('accounting.addLine') }}
        </v-btn>
      </div>

      <v-table density="compact">
        <thead>
          <tr>
            <th>{{ $t('accounting.account') }}</th>
            <th>{{ $t('common.description') }}</th>
            <th class="text-end">{{ $t('accounting.debit') }}</th>
            <th class="text-end">{{ $t('accounting.credit') }}</th>
            <th v-if="entryStatus === 'draft'" style="width: 40px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(line, idx) in form.lines" :key="idx">
            <td style="min-width: 200px">
              <v-select
                v-model="line.accountId"
                :items="accountOptions"
                item-title="label"
                item-value="_id"
                density="compact"
                hide-details
                variant="underlined"
                :disabled="entryStatus !== 'draft'"
              />
            </td>
            <td>
              <v-text-field
                v-model="line.description"
                density="compact"
                hide-details
                variant="underlined"
                :disabled="entryStatus !== 'draft'"
              />
            </td>
            <td style="width: 140px">
              <v-text-field
                v-model.number="line.debit"
                type="number"
                min="0"
                density="compact"
                hide-details
                variant="underlined"
                class="text-end"
                :disabled="entryStatus !== 'draft'"
              />
            </td>
            <td style="width: 140px">
              <v-text-field
                v-model.number="line.credit"
                type="number"
                min="0"
                density="compact"
                hide-details
                variant="underlined"
                class="text-end"
                :disabled="entryStatus !== 'draft'"
              />
            </td>
            <td v-if="entryStatus === 'draft'">
              <v-btn icon="mdi-close" size="x-small" variant="text" @click="removeLine(idx)" />
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr class="font-weight-bold">
            <td colspan="2">{{ $t('common.total') }}</td>
            <td class="text-end">{{ formatCurrency(totalDebit, currency, localeCode) }}</td>
            <td class="text-end">{{ formatCurrency(totalCredit, currency, localeCode) }}</td>
            <td v-if="entryStatus === 'draft'"></td>
          </tr>
        </tfoot>
      </v-table>

      <v-alert
        v-if="linesError"
        type="error"
        density="compact"
        class="mt-2"
      >
        {{ linesError }}
      </v-alert>

      <v-alert
        v-if="!isBalanced && form.lines.length > 0"
        type="warning"
        density="compact"
        class="mt-2"
      >
        {{ $t('accounting.unbalanced') }}:
        {{ formatCurrency(Math.abs(totalDebit - totalCredit), currency, localeCode) }}
      </v-alert>
    </v-form>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { useAccountingStore } from '../../store/accounting.store'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import type { FormAction, SmartButtonDef } from 'ui-shared/components/EntityFormShell.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const store = useAccountingStore()
const { showSuccess, showError } = useSnackbar()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const formRef = ref()
const isEdit = computed(() => !!route.params.id)
const entryNumber = ref('')
const entryStatus = ref<'draft' | 'posted' | 'voided'>('draft')
const entryData = ref<any>(null)

const statusLabel = computed(() => {
  if (entryStatus.value === 'draft') return t('common.draft')
  if (entryStatus.value === 'posted') return t('common.posted')
  if (entryStatus.value === 'voided') return t('common.voided')
  return t('common.draft')
})

const formActions = computed<FormAction[]>(() => {
  const s = entryStatus.value
  const actions: FormAction[] = []

  if (!isEdit.value) {
    // New entry: Save + Save & Post
    actions.push({ label: t('common.save'), color: 'primary', handler: handleSubmit, loading: store.loading, disabled: !isBalanced.value })
    actions.push({ label: t('accounting.saveAndPost'), color: 'primary', variant: 'outlined', handler: saveAndPost, loading: store.loading, disabled: !isBalanced.value })
  } else if (s === 'draft') {
    // Editing draft: Save + Post
    actions.push({ label: t('common.save'), color: 'primary', handler: handleSubmit, loading: store.loading, disabled: !isBalanced.value })
    actions.push({ label: t('accounting.post'), color: 'primary', variant: 'outlined', icon: 'mdi-check', handler: postEntry, loading: store.loading })
  } else if (s === 'posted') {
    // Posted: Void
    actions.push({ label: t('accounting.void'), color: 'warning', icon: 'mdi-cancel', handler: voidEntry, loading: store.loading })
  }

  return actions
})

const smartButtons = computed<SmartButtonDef[]>(() => {
  const btns: SmartButtonDef[] = []
  if (entryData.value?.sourceModule && entryData.value?.sourceId) {
    const moduleRoutes: Record<string, string> = {
      invoice: '/invoicing/invoices',
      sales: '/invoicing/invoices',
      purchase: '/invoicing/bills',
    }
    const basePath = moduleRoutes[entryData.value.sourceModule] || ''
    btns.push({
      label: t('common.sourceDocument'),
      value: entryData.value.sourceModule,
      icon: 'mdi-file-document-outline',
      to: basePath ? `${basePath}/${entryData.value.sourceId}` : undefined,
    })
  }
  return btns
})

const form = reactive({
  date: new Date().toISOString().split('T')[0],
  reference: '',
  description: '',
  lines: [] as Array<{ accountId: string; description: string; debit: number; credit: number }>,
})

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'accounting',
  entityType: 'journalEntry',
  icon: 'mdi-book-open-page-variant',
  getFormData: () => ({ ...form, lines: [...form.lines] }),
  getPreviewFields: () => [
    { label: 'Date', value: form.date },
    { label: 'Ref', value: form.reference },
  ],
  setFormData: (data) => Object.assign(form, data),
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const accountOptions = computed(() =>
  store.activeAccounts.map(a => ({ _id: a._id, label: `${a.code} - ${a.name}` }))
)

const totalDebit = computed(() => form.lines.reduce((s, l) => s + (l.debit || 0), 0))
const totalCredit = computed(() => form.lines.reduce((s, l) => s + (l.credit || 0), 0))
const isBalanced = computed(() => form.lines.length > 0 && Math.abs(totalDebit.value - totalCredit.value) < 0.01)

const linesError = ref('')

const rules = {
  required: (v: string) => !!v || t('validation.required'),
  validDate: (v: string) => !isNaN(Date.parse(v)) || 'Invalid date',
}

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function addLine() {
  form.lines.push({ accountId: '', description: '', debit: 0, credit: 0 })
}

function removeLine(idx: number) {
  form.lines.splice(idx, 1)
}

function validateLines(): boolean {
  linesError.value = ''
  if (form.lines.length === 0) {
    linesError.value = 'At least one line is required'
    return false
  }
  if (form.lines.some(l => !l.accountId)) {
    linesError.value = 'All lines must have an account selected'
    return false
  }
  return true
}

function buildPayload() {
  return {
    date: form.date,
    reference: form.reference || undefined,
    description: form.description,
    lines: form.lines.map(l => ({
      accountId: l.accountId,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
    })),
  }
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  if (!validateLines()) return

  try {
    if (isEdit.value) {
      await store.updateJournalEntry(route.params.id as string, buildPayload())
    } else {
      await store.createJournalEntry(buildPayload())
    }
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'accounting.journal-entries' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function saveAndPost() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  if (!validateLines()) return

  try {
    const entry = await store.createJournalEntry(buildPayload())
    if (entry?._id) {
      await store.postJournalEntry(entry._id)
    }
    markSaved()
    showSuccess(t('common.postedSuccessfully'))
    router.push({ name: 'accounting.journal-entries' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function postEntry() {
  try {
    await store.postJournalEntry(route.params.id as string)
    showSuccess(t('common.postedSuccessfully'))
    router.push({ name: 'accounting.journal-entries' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function voidEntry() {
  try {
    await store.voidJournalEntry(route.params.id as string)
    showSuccess(t('common.voidedSuccessfully'))
    router.push({ name: 'accounting.journal-entries' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(async () => {
  await store.fetchAccounts()
  if (tryRestore()) return
  if (isEdit.value) {
    const entries = store.journalEntries
    const existing = entries.find(e => e._id === route.params.id)
    if (existing) {
      entryNumber.value = existing.number || ''
      entryStatus.value = existing.status || 'draft'
      entryData.value = existing
      Object.assign(form, {
        date: existing.date?.split('T')[0] || '',
        reference: '',
        description: existing.description || '',
        lines: (existing.lines || []).map(l => ({
          accountId: l.accountId || '',
          description: l.description || '',
          debit: l.debit || 0,
          credit: l.credit || 0,
        })),
      })
    }
  }
})
</script>
