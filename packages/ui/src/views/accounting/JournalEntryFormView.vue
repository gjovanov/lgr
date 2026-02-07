<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon variant="text" @click="router.back()">
        <v-icon>mdi-arrow-left</v-icon>
      </v-btn>
      <h1 class="text-h5 ml-2">
        {{ isEdit ? $t('accounting.editJournalEntry') : $t('accounting.newJournalEntry') }}
      </h1>
    </div>

    <v-card>
      <v-card-text>
        <v-form ref="formRef" @submit.prevent="handleSubmit">
          <v-row>
            <v-col cols="12" md="3">
              <v-text-field
                v-model="form.date"
                :label="$t('common.date')"
                type="date"
                :rules="[rules.required]"
              />
            </v-col>
            <v-col cols="12" md="3">
              <v-text-field
                v-model="form.reference"
                :label="$t('accounting.reference')"
              />
            </v-col>
            <v-col cols="12" md="6">
              <v-text-field
                v-model="form.description"
                :label="$t('common.description')"
                :rules="[rules.required]"
              />
            </v-col>
          </v-row>

          <div class="d-flex align-center mt-4 mb-2">
            <span class="text-subtitle-1 font-weight-medium">{{ $t('accounting.lines') }}</span>
            <v-spacer />
            <v-btn
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
                <th style="width: 40px"></th>
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
                  />
                </td>
                <td>
                  <v-text-field
                    v-model="line.description"
                    density="compact"
                    hide-details
                    variant="underlined"
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
                  />
                </td>
                <td>
                  <v-btn icon="mdi-close" size="x-small" variant="text" @click="removeLine(idx)" />
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr class="font-weight-bold">
                <td colspan="2">{{ $t('common.total') }}</td>
                <td class="text-end">{{ formatCurrency(totalDebit, currency, localeCode) }}</td>
                <td class="text-end">{{ formatCurrency(totalCredit, currency, localeCode) }}</td>
                <td></td>
              </tr>
            </tfoot>
          </v-table>

          <v-alert
            v-if="!isBalanced && form.lines.length > 0"
            type="warning"
            density="compact"
            class="mt-2"
          >
            {{ $t('accounting.unbalanced') }}:
            {{ formatCurrency(Math.abs(totalDebit - totalCredit), currency, localeCode) }}
          </v-alert>

          <div class="d-flex justify-end mt-6">
            <v-btn variant="text" class="mr-2" @click="router.back()">
              {{ $t('common.cancel') }}
            </v-btn>
            <v-btn
              type="submit"
              color="primary"
              :loading="store.loading"
              :disabled="!isBalanced"
            >
              {{ $t('common.save') }}
            </v-btn>
            <v-btn
              v-if="!isEdit"
              color="success"
              class="ml-2"
              :loading="store.loading"
              :disabled="!isBalanced"
              @click="saveAndPost"
            >
              {{ $t('accounting.saveAndPost') }}
            </v-btn>
          </div>
        </v-form>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { useAccountingStore } from '../../store/accounting.store'
import { formatCurrency } from '../../composables/useCurrency'

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const store = useAccountingStore()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const formRef = ref()
const isEdit = computed(() => !!route.params.id)

const form = reactive({
  date: new Date().toISOString().split('T')[0],
  reference: '',
  description: '',
  lines: [] as Array<{ accountId: string; description: string; debit: number; credit: number }>,
})

const accountOptions = computed(() =>
  store.activeAccounts.map(a => ({ _id: a._id, label: `${a.code} - ${a.name}` }))
)

const totalDebit = computed(() => form.lines.reduce((s, l) => s + (l.debit || 0), 0))
const totalCredit = computed(() => form.lines.reduce((s, l) => s + (l.credit || 0), 0))
const isBalanced = computed(() => form.lines.length > 0 && Math.abs(totalDebit.value - totalCredit.value) < 0.01)

const rules = {
  required: (v: string) => !!v || 'Required',
}

function addLine() {
  form.lines.push({ accountId: '', description: '', debit: 0, credit: 0 })
}

function removeLine(idx: number) {
  form.lines.splice(idx, 1)
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  await store.createJournalEntry({
    date: form.date,
    description: form.description,
    lines: form.lines.map(l => ({
      accountId: l.accountId,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
    })),
  })
  router.push({ name: 'accounting.journal-entries' })
}

async function saveAndPost() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  const entry = await store.createJournalEntry({
    date: form.date,
    description: form.description,
    lines: form.lines.map(l => ({
      accountId: l.accountId,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
    })),
  })
  if (entry?._id) {
    await store.postJournalEntry(entry._id)
  }
  router.push({ name: 'accounting.journal-entries' })
}

onMounted(() => {
  store.fetchAccounts()
  if (isEdit.value) {
    // Load existing entry for editing
  }
})
</script>
