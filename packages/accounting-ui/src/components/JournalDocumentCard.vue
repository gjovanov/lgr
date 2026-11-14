<template>
  <!-- FR-25a §3.6: the entry's document. Read-only for an entry the books import wrote (as booked), editable on a draft of
       LGR's own. No table and no "description" label before the lines: the journal specs find the lines as the page's
       first table, and the entry's description as the first field so labelled. -->
  <CollapsiblePanel
    ref="panel"
    screen="accounting.journal-entry"
    panel-id="document"
    :default-open="defaultOpen"
    :summary="summary"
    :flag="problemCount ? $t('accounting.journalEntry.document.needsAttention', { n: problemCount }) : undefined"
    class="mt-2 mb-2"
    data-testid="journal-document-card"
  >
    <template #title>
      <span class="text-subtitle-1">{{ $t('accounting.journalEntry.document.title') }}</span>
      <v-chip v-if="asBooked" size="x-small" label color="info" variant="tonal" prepend-icon="mdi-lock" data-testid="as-booked-chip">
        {{ $t('accounting.journalEntry.document.asBooked') }}
      </v-chip>
    </template>

    <v-card-text class="pt-3">
      <v-alert v-if="asBooked" type="info" variant="tonal" density="compact" icon="mdi-lock" class="mb-3">
        {{ $t('accounting.journalEntry.document.asBookedHint') }}
      </v-alert>

      <v-defaults-provider :defaults="fieldDefaults">
        <v-row dense>
          <v-col cols="12" sm="6" md="2">
            <v-combobox v-model="form.docType" :label="$t('accounting.journalEntry.document.docType')" :items="docTypeItems" :disabled="!editable" />
          </v-col>
          <v-col cols="12" sm="6" md="2">
            <v-text-field v-model="form.docNumber" :label="$t('accounting.journalEntry.document.docNumber')" :disabled="!editable" maxlength="40" />
          </v-col>
          <v-col cols="12" sm="6" md="2">
            <DateField v-model="form.docDate" :label="$t('accounting.journalEntry.document.docDate')" :disabled="!editable" :rules="rule('docDate')" />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-select
              v-model="form.registerDocType"
              :label="$t('accounting.journalEntry.document.registerDocType')"
              :items="registerDocTypeItems"
              :disabled="!editable"
              :rules="rule('registerDocType')"
              clearable
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field
              v-model="form.reasonRef"
              :label="$t('accounting.journalEntry.document.reasonRef')"
              :hint="noticeSelected ? $t('accounting.journalEntry.document.reasonRefHint') : undefined"
              :persistent-hint="noticeSelected && editable"
              :disabled="!editable"
              :rules="rule('reasonRef')"
              maxlength="200"
            />
          </v-col>
          <v-col v-if="entry?.partnerName" cols="12" md="6">
            <v-text-field :model-value="entry.partnerName" :label="$t('accounting.journalEntry.document.partner')" disabled />
          </v-col>
        </v-row>

        <div class="text-subtitle-2 mt-3 mb-1">{{ $t('accounting.journalEntry.payment.title') }}</div>
        <v-row dense>
          <v-col cols="12" sm="6" md="2">
            <v-select
              v-model="form.paymentCode"
              :label="$t('accounting.journalEntry.payment.code')"
              :items="paymentItems"
              :disabled="!editable"
              :rules="rule('paymentCode')"
              clearable
            />
          </v-col>
          <v-col cols="12" sm="6" md="2">
            <v-text-field v-model.number="form.paidAmount" type="number" min="0" step="0.01" :label="$t('accounting.journalEntry.payment.paidAmount')" :disabled="!editable" />
          </v-col>
          <v-col cols="12" sm="6" md="2">
            <v-text-field v-model.number="form.paidCash" type="number" min="0" step="0.01" :label="$t('accounting.journalEntry.payment.paidCash')" :disabled="!editable" :rules="rule('paidCash')" />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-text-field v-model="form.bankOperation" :label="$t('accounting.journalEntry.payment.bankOperation')" :disabled="!editable" maxlength="100" />
          </v-col>
          <v-col v-if="entry?.docTotal !== undefined && entry?.docTotal !== null" cols="12" md="3" class="d-flex flex-column justify-center text-body-2">
            <div>{{ $t('accounting.journalEntry.document.total') }}: <strong>{{ money(entry.docTotal) }}</strong></div>
            <div v-if="openAmount !== undefined">{{ $t('accounting.journalEntry.payment.open') }}: <strong>{{ money(openAmount) }}</strong></div>
          </v-col>
        </v-row>

        <div class="text-subtitle-2 mt-3 mb-1">{{ $t('accounting.journalEntry.vat.title') }}</div>
        <v-row dense>
          <v-col cols="12" sm="6" md="2">
            <v-text-field v-model="form.vatKind" :label="$t('accounting.journalEntry.vat.kind')" :disabled="!editable" maxlength="20" />
          </v-col>
          <v-col cols="12" sm="6" md="2">
            <v-select v-model="form.vatRate" :label="$t('accounting.journalEntry.vat.rate')" :items="vatRateItems" :disabled="!editable" :rules="rule('vatRate')" clearable />
          </v-col>
          <v-col cols="12" sm="6" md="4">
            <v-text-field v-model="form.vatRule" :label="$t('accounting.journalEntry.vat.rule')" :disabled="!editable" maxlength="200" />
          </v-col>
          <v-col cols="12" sm="6" md="4">
            <v-text-field
              v-model="form.vatExemptionReason"
              :label="$t('accounting.journalEntry.vat.exemptionReason')"
              :disabled="!editable"
              :rules="rule('vatExemptionReason')"
              maxlength="300"
            />
          </v-col>
          <v-col cols="12" sm="6" md="2">
            <DateField v-model="form.taxEventDate" :label="$t('accounting.journalEntry.vat.taxEventDate')" :disabled="!editable" :rules="rule('taxEventDate')" />
          </v-col>
          <v-col cols="12" sm="6" md="2">
            <v-text-field v-model="form.reportingMonth" type="month" :label="$t('accounting.journalEntry.vat.reportingMonth')" :disabled="!editable" :rules="rule('reportingMonth')" />
          </v-col>
          <v-col cols="12" sm="6" md="2">
            <v-combobox v-model="form.protocolType" :label="$t('accounting.journalEntry.vat.protocolType')" :items="protocolItems" :disabled="!editable" />
          </v-col>
          <v-col cols="12" sm="6" md="2">
            <v-text-field v-model="form.customsRef" :label="$t('accounting.journalEntry.vat.customsRef')" :disabled="!editable" maxlength="40" />
          </v-col>
          <v-col v-if="entry?.docVat !== undefined && entry?.docVat !== null" cols="12" md="4" class="d-flex align-center text-body-2">
            {{ $t('accounting.journalEntry.vat.docVat') }}: <strong class="ml-1">{{ money(entry.docVat) }}</strong>
          </v-col>
        </v-row>
      </v-defaults-provider>

      <div class="d-flex align-center mt-3 mb-1">
        <span class="text-subtitle-2">{{ $t('accounting.journalEntry.links.title') }}</span>
        <v-spacer />
        <v-btn v-if="editable" size="small" variant="text" prepend-icon="mdi-link-plus" data-testid="add-link" @click="addLink">
          {{ $t('accounting.journalEntry.links.add') }}
        </v-btn>
      </div>
      <div v-if="!form.links.length" class="text-body-2 text-medium-emphasis">{{ $t('accounting.journalEntry.links.none') }}</div>
      <v-table v-else density="compact" class="journal-links" data-testid="journal-links">
        <thead>
          <tr>
            <th>{{ $t('accounting.journalEntry.links.docType') }}</th>
            <th>{{ $t('accounting.journalEntry.links.docNumber') }}</th>
            <th>{{ $t('accounting.journalEntry.links.date') }}</th>
            <th class="text-end">{{ $t('accounting.journalEntry.links.amount') }}</th>
            <th class="text-end">{{ $t('accounting.journalEntry.links.amountFx') }}</th>
            <th style="width: 48px"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(link, idx) in form.links"
            :key="idx"
            :class="{ 'journal-link--open': !editable && link.entryId }"
            @click="!editable && openLink(link)"
          >
            <template v-if="editable">
              <td><v-text-field v-model="link.docType" density="compact" variant="underlined" hide-details maxlength="20" :aria-label="$t('accounting.journalEntry.links.docType')" /></td>
              <td><v-text-field v-model="link.docNumber" density="compact" variant="underlined" hide-details maxlength="40" :aria-label="$t('accounting.journalEntry.links.docNumber')" /></td>
              <td><v-text-field v-model="link.date" type="date" density="compact" variant="underlined" hide-details :aria-label="$t('accounting.journalEntry.links.date')" /></td>
              <td><v-text-field v-model.number="link.amount" type="number" step="0.01" density="compact" variant="underlined" hide-details class="text-end" :aria-label="$t('accounting.journalEntry.links.amount')" /></td>
              <td><v-text-field v-model.number="link.amountFx" type="number" step="0.01" density="compact" variant="underlined" hide-details class="text-end" :aria-label="$t('accounting.journalEntry.links.amountFx')" /></td>
              <td>
                <v-btn icon="mdi-close" size="x-small" variant="text" :title="$t('accounting.journalEntry.links.remove')" :aria-label="$t('accounting.journalEntry.links.remove')" @click.stop="form.links.splice(idx, 1)" />
              </td>
            </template>
            <template v-else>
              <td>{{ link.docType }}</td>
              <td>{{ link.docNumber }}</td>
              <td>{{ link.date }}</td>
              <td class="text-end">{{ link.amount !== null ? money(link.amount) : '' }}</td>
              <td class="text-end">{{ link.amountFx !== null ? link.amountFx.toFixed(2) : '' }}</td>
              <td>
                <v-btn
                  v-if="link.entryId"
                  icon="mdi-open-in-new"
                  size="x-small"
                  variant="text"
                  :title="$t('accounting.journalEntry.links.open')"
                  :aria-label="$t('accounting.journalEntry.links.open')"
                  @click.stop="openLink(link)"
                />
                <v-icon v-else size="small" color="grey" :title="$t('accounting.journalEntry.links.notFound')">mdi-link-off</v-icon>
              </td>
            </template>
          </tr>
        </tbody>
      </v-table>
      <div v-if="problems.links" class="text-caption text-error mt-1">{{ $t(`accounting.journalEntry.errors.${problems.links}`) }}</div>

      <template v-if="switches.length">
        <div class="text-subtitle-2 mt-3 mb-1">{{ $t('accounting.journalEntry.document.switches') }}</div>
        <div class="d-flex flex-wrap ga-1">
          <v-chip v-for="s in switches" :key="s" size="small" label variant="outlined">{{ s }}</v-chip>
        </div>
      </template>

      <div v-if="sourceLine" class="text-body-2 text-medium-emphasis mt-3" data-testid="journal-source">
        <v-icon size="small" class="mr-1">mdi-account-edit-outline</v-icon>{{ sourceLine }}
      </div>
    </v-card-text>
  </CollapsiblePanel>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { JOURNAL_DOC_TYPES, PAYMENT_CODES, REGISTER_DOC_TYPES, VAT_RATES, isNotice, openAmountOf, type JournalHeaderField } from 'config/journal-header'
import CollapsiblePanel from 'ui-shared/components/CollapsiblePanel.vue'
import DateField from 'ui-shared/components/DateField.vue'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { formProblems, headerSummary, switchLabel, type HeaderForm, type HeaderLinkForm } from '../views/accounting/journal-header-form'
import type { JournalEntryDetail } from '../store/accounting.store'

const props = defineProps<{
  /** The entry as loaded (a new one has none): what the card shows beside its fields. */
  entry: JournalEntryDetail | null
  /** A draft of LGR's own. */
  editable: boolean
  /** Written by the books import. */
  asBooked: boolean
  /** The panel starts open: the entry says something of its document. */
  defaultOpen: boolean
  currency: string
  localeCode: string
}>()

const form = defineModel<HeaderForm>({ required: true })
const { t } = useI18n()
const router = useRouter()
const panel = ref<{ setOpen: (v: boolean) => void } | null>(null)

const fieldDefaults = {
  VTextField: { density: 'compact', variant: 'outlined' },
  VSelect: { density: 'compact', variant: 'outlined' },
  VCombobox: { density: 'compact', variant: 'outlined' },
}

const docTypeItems = JOURNAL_DOC_TYPES.map(d => d.code)
const protocolItems = ['p117', 'pLN']
const registerDocTypeItems = computed(() => REGISTER_DOC_TYPES.map(r => ({
  title: `${r.code} · ${t(`accounting.journalEntry.document.registerDocTypes.${r.key}`)}`,
  value: r.code,
})))
const paymentItems = computed(() => Object.entries(PAYMENT_CODES).map(([code, way]) => ({ title: t(`accounting.paymentCodes.${way}`), value: code })))
const vatRateItems = VAT_RATES.map(rate => ({ title: `${rate}%`, value: rate }))

const problems = computed(() => (props.editable ? formProblems(form.value) : {}))
const problemCount = computed(() => Object.keys(problems.value).length)
/** A field's rule: what `headerProblems` says of it, in words. */
const rule = (field: JournalHeaderField) => [() => {
  const code = problems.value[field]
  return code ? t(`accounting.journalEntry.errors.${code}`) : true
}]

const noticeSelected = computed(() => isNotice(form.value.registerDocType))
const openAmount = computed(() => (props.entry ? openAmountOf(props.entry) : undefined))
const summary = computed(() => headerSummary(form.value, key => t(key)))
const switches = computed(() => Object.entries(props.entry?.docOptions ?? {}).map(([k, v]) => switchLabel(k, String(v))))

const money = (n: number) => formatCurrency(n, props.entry?.docCurrency || props.currency, props.localeCode)
const stamp = (v?: string) => (v ? new Date(v).toLocaleString(props.localeCode) : '')
const sourceLine = computed(() => {
  const s = props.entry?.source
  if (!s) return ''
  const parts = [
    s.createdBy || s.createdAt ? t('accounting.journalEntry.document.source', { by: s.createdBy ?? '', at: stamp(s.createdAt) }) : '',
    s.modifiedBy || s.modifiedAt ? t('accounting.journalEntry.document.sourceChanged', { by: s.modifiedBy ?? '', at: stamp(s.modifiedAt) }) : '',
    s.version ? t('accounting.journalEntry.document.version', { version: s.version }) : '',
  ]
  return parts.filter(Boolean).join(' · ')
})

function addLink() {
  form.value.links.push({ docType: '', docNumber: '', date: '', amount: null, amountFx: null })
}

function openLink(link: HeaderLinkForm) {
  if (link.entryId) router.push({ name: 'accounting.journal-entry-edit', params: { id: link.entryId } })
}

/** Open the card, so a refused field is seen. */
defineExpose({ open: () => panel.value?.setOpen(true), problemCount })
</script>

<style scoped>
.journal-link--open {
  cursor: pointer;
}
</style>
