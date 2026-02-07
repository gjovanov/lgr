<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon="mdi-arrow-left" variant="text" @click="$router.back()" />
      <h1 class="text-h4 ml-2">{{ isNew ? $t('payroll.newEmployee') : $t('payroll.editEmployee') }}</h1>
    </div>

    <v-card>
      <v-card-text>
        <v-tabs v-model="tab">
          <v-tab value="personal">{{ $t('payroll.personalInfo') }}</v-tab>
          <v-tab value="employment">{{ $t('payroll.employmentDetails') }}</v-tab>
          <v-tab value="salary">{{ $t('payroll.salary') }}</v-tab>
          <v-tab value="deductions">{{ $t('payroll.deductions') }}</v-tab>
          <v-tab value="benefits">{{ $t('payroll.benefits') }}</v-tab>
        </v-tabs>
        <v-tabs-window v-model="tab" class="mt-4">
          <v-tabs-window-item value="personal">
            <v-row>
              <v-col cols="6"><v-text-field v-model="form.firstName" :label="$t('common.firstName')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.lastName" :label="$t('common.lastName')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.email" :label="$t('common.email')" type="email" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.phone" :label="$t('common.phone')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.dateOfBirth" :label="$t('payroll.dateOfBirth')" type="date" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.nationalId" :label="$t('payroll.nationalId')" /></v-col>
              <v-col cols="12"><v-text-field v-model="form.address" :label="$t('common.address')" /></v-col>
            </v-row>
          </v-tabs-window-item>

          <v-tabs-window-item value="employment">
            <v-row>
              <v-col cols="6"><v-text-field v-model="form.employeeNumber" :label="$t('payroll.employeeNumber')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.position" :label="$t('payroll.position')" /></v-col>
              <v-col cols="6">
                <v-select v-model="form.employmentType" :label="$t('payroll.employmentType')" :items="['Full-time', 'Part-time', 'Contract', 'Intern']" />
              </v-col>
              <v-col cols="6"><v-text-field v-model="form.startDate" :label="$t('payroll.startDate')" type="date" /></v-col>
              <v-col cols="6">
                <v-select v-model="form.status" :label="$t('common.status')" :items="['Active', 'On Leave', 'Terminated', 'Suspended']" />
              </v-col>
            </v-row>
          </v-tabs-window-item>

          <v-tabs-window-item value="salary">
            <v-row>
              <v-col cols="6"><CurrencyInput v-model="form.baseSalary" :label="$t('payroll.baseSalary')" /></v-col>
              <v-col cols="6">
                <v-select v-model="form.payFrequency" :label="$t('payroll.payFrequency')" :items="['Monthly', 'Bi-weekly', 'Weekly']" />
              </v-col>
              <v-col cols="6"><v-text-field v-model="form.bankAccount" :label="$t('payroll.bankAccount')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.taxId" :label="$t('payroll.taxId')" /></v-col>
            </v-row>
          </v-tabs-window-item>

          <v-tabs-window-item value="deductions">
            <v-row v-for="(ded, i) in form.deductions" :key="i" class="align-center">
              <v-col cols="4"><v-text-field v-model="ded.name" :label="$t('common.name')" /></v-col>
              <v-col cols="3"><v-select v-model="ded.type" :items="['Fixed', 'Percentage']" :label="$t('common.type')" /></v-col>
              <v-col cols="3"><v-text-field v-model.number="ded.amount" :label="$t('common.amount')" type="number" /></v-col>
              <v-col cols="2"><v-btn icon="mdi-delete" size="small" color="error" variant="text" @click="form.deductions.splice(i, 1)" /></v-col>
            </v-row>
            <v-btn variant="outlined" prepend-icon="mdi-plus" @click="form.deductions.push({ name: '', type: 'Fixed', amount: 0 })">
              {{ $t('payroll.addDeduction') }}
            </v-btn>
          </v-tabs-window-item>

          <v-tabs-window-item value="benefits">
            <v-row v-for="(ben, i) in form.benefits" :key="i" class="align-center">
              <v-col cols="4"><v-text-field v-model="ben.name" :label="$t('common.name')" /></v-col>
              <v-col cols="3"><v-select v-model="ben.type" :items="['Fixed', 'Percentage']" :label="$t('common.type')" /></v-col>
              <v-col cols="3"><v-text-field v-model.number="ben.amount" :label="$t('common.amount')" type="number" /></v-col>
              <v-col cols="2"><v-btn icon="mdi-delete" size="small" color="error" variant="text" @click="form.benefits.splice(i, 1)" /></v-col>
            </v-row>
            <v-btn variant="outlined" prepend-icon="mdi-plus" @click="form.benefits.push({ name: '', type: 'Fixed', amount: 0 })">
              {{ $t('payroll.addBenefit') }}
            </v-btn>
          </v-tabs-window-item>
        </v-tabs-window>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="$router.back()">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" :loading="saving" @click="save">{{ $t('common.save') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { usePayrollStore } from '../../store/payroll.store'
import CurrencyInput from '../../components/shared/CurrencyInput.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = usePayrollStore()
const saving = ref(false)
const tab = ref('personal')

const isNew = computed(() => !route.params.id)

const form = reactive({
  firstName: '', lastName: '', email: '', phone: '',
  dateOfBirth: '', nationalId: '', address: '',
  employeeNumber: '', position: '', employmentType: 'Full-time',
  startDate: '', status: 'Active', baseSalary: 0,
  payFrequency: 'Monthly', bankAccount: '', taxId: '',
  deductions: [] as any[], benefits: [] as any[],
})

async function save() {
  saving.value = true
  try {
    await store.saveEmployee({ ...form })
    router.push('/payroll/employees')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  if (route.params.id) {
    // TODO: fetch employee by ID and populate form
  }
})
</script>
