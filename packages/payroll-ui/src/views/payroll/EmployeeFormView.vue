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
        <v-tabs-window v-model="tab" class="mt-6 pt-4">
          <v-tabs-window-item value="personal">
            <v-row>
              <v-col cols="6"><v-text-field v-model="form.firstName" :label="$t('common.firstName')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.lastName" :label="$t('common.lastName')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.email" :label="$t('common.email')" type="email" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.phone" :label="$t('common.phone')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.dateOfBirth" :label="$t('payroll.dateOfBirth')" type="date" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.nationalId" :label="$t('payroll.nationalId')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.address.street" :label="$t('payroll.street')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.address.city" :label="$t('payroll.city')" /></v-col>
              <v-col cols="4"><v-text-field v-model="form.address.state" :label="$t('payroll.state')" /></v-col>
              <v-col cols="4"><v-text-field v-model="form.address.postalCode" :label="$t('payroll.postalCode')" /></v-col>
              <v-col cols="4"><v-text-field v-model="form.address.country" :label="$t('payroll.country')" /></v-col>
            </v-row>
          </v-tabs-window-item>

          <v-tabs-window-item value="employment">
            <v-row>
              <v-col cols="6"><v-text-field v-model="form.employeeNumber" :label="$t('payroll.employeeNumber')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.department" :label="$t('payroll.department')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.position" :label="$t('payroll.position')" /></v-col>
              <v-col cols="6">
                <v-select v-model="form.employmentType" :label="$t('payroll.employmentType')" :items="employmentTypes" />
              </v-col>
              <v-col cols="6"><v-text-field v-model="form.contractStartDate" :label="$t('payroll.contractStartDate')" type="date" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.contractEndDate" :label="$t('payroll.contractEndDate')" type="date" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.probationEndDate" :label="$t('payroll.probationEndDate')" type="date" /></v-col>
              <v-col cols="6">
                <v-select v-model="form.status" :label="$t('common.status')" :items="statuses" />
              </v-col>
            </v-row>
          </v-tabs-window-item>

          <v-tabs-window-item value="salary">
            <v-row>
              <v-col cols="6"><CurrencyInput v-model="form.salary.baseSalary" :label="$t('payroll.baseSalary')" /></v-col>
              <v-col cols="3"><v-text-field v-model="form.salary.currency" :label="$t('payroll.currency')" /></v-col>
              <v-col cols="3">
                <v-select v-model="form.salary.frequency" :label="$t('payroll.frequency')" :items="salaryFrequencies" />
              </v-col>
              <v-col cols="6"><v-text-field v-model="form.salary.bankAccountNumber" :label="$t('payroll.bankAccountNumber')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.salary.bankName" :label="$t('payroll.bankName')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.salary.iban" :label="$t('payroll.iban')" /></v-col>
              <v-col cols="6"><v-text-field v-model="form.taxId" :label="$t('payroll.taxId')" /></v-col>
            </v-row>
          </v-tabs-window-item>

          <v-tabs-window-item value="deductions">
            <v-row v-for="(ded, i) in form.deductions" :key="i" class="align-center">
              <v-col cols="3"><v-text-field v-model="ded.type" :label="$t('common.type')" /></v-col>
              <v-col cols="3"><v-text-field v-model="ded.name" :label="$t('common.name')" /></v-col>
              <v-col cols="2"><v-text-field v-model.number="ded.amount" :label="$t('common.amount')" type="number" /></v-col>
              <v-col cols="2"><v-text-field v-model.number="ded.percentage" :label="$t('common.percentage')" type="number" /></v-col>
              <v-col cols="2"><v-btn icon="mdi-delete" size="small" color="error" variant="text" @click="form.deductions.splice(i, 1)" /></v-col>
            </v-row>
            <v-btn variant="outlined" prepend-icon="mdi-plus" @click="form.deductions.push({ type: '', name: '', amount: 0, percentage: 0 })">
              {{ $t('payroll.addDeduction') }}
            </v-btn>
          </v-tabs-window-item>

          <v-tabs-window-item value="benefits">
            <v-row v-for="(ben, i) in form.benefits" :key="i" class="align-center">
              <v-col cols="4"><v-text-field v-model="ben.name" :label="$t('common.name')" /></v-col>
              <v-col cols="3"><v-text-field v-model="ben.type" :label="$t('common.type')" /></v-col>
              <v-col cols="3"><v-text-field v-model.number="ben.value" :label="$t('common.value')" type="number" /></v-col>
              <v-col cols="2"><v-btn icon="mdi-delete" size="small" color="error" variant="text" @click="form.benefits.splice(i, 1)" /></v-col>
            </v-row>
            <v-btn variant="outlined" prepend-icon="mdi-plus" @click="form.benefits.push({ name: '', type: '', value: 0 })">
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
import CurrencyInput from 'ui-shared/components/CurrencyInput'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = usePayrollStore()
const saving = ref(false)
const tab = ref('personal')

const isNew = computed(() => !route.params.id)

const statuses = ['active', 'on_leave', 'terminated', 'suspended']
const employmentTypes = ['full_time', 'part_time', 'contract', 'intern']
const salaryFrequencies = ['monthly', 'biweekly', 'weekly', 'hourly']

const emptyForm = () => ({
  firstName: '', lastName: '', email: '', phone: '',
  dateOfBirth: '', gender: '' as string, nationalId: '', taxId: '',
  address: { street: '', city: '', state: '', postalCode: '', country: '' },
  employeeNumber: '', department: '', position: '', managerId: '' as string,
  employmentType: 'full_time',
  contractStartDate: '', contractEndDate: '', probationEndDate: '',
  status: 'active',
  salary: { baseSalary: 0, currency: 'EUR', frequency: 'monthly', bankAccountNumber: '', bankName: '', iban: '' },
  deductions: [] as any[], benefits: [] as any[],
  emergencyContact: { name: '', relationship: '', phone: '' },
  notes: '',
})

const form = reactive(emptyForm())

async function save() {
  saving.value = true
  try {
    await store.saveEmployee({ ...form })
    router.push('/employees')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  if (route.params.id) {
    const employee = await store.fetchEmployee(route.params.id as string)
    if (employee) {
      const empty = emptyForm()
      Object.assign(form, {
        ...empty,
        ...employee,
        address: { ...empty.address, ...employee.address },
        salary: { ...empty.salary, ...employee.salary },
        emergencyContact: { ...empty.emergencyContact, ...employee.emergencyContact },
        deductions: employee.deductions?.length ? employee.deductions.map((d: any) => ({ ...d })) : [],
        benefits: employee.benefits?.length ? employee.benefits.map((b: any) => ({ ...b })) : [],
      })
    }
  }
})
</script>
