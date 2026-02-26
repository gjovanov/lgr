import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export interface Employee {
  _id: string
  employeeNumber: string
  firstName: string
  lastName: string
  email: string
  departmentId: string
  departmentName?: string
  position: string
  hireDate: string
  salary: number
  currency: string
  status: 'active' | 'inactive' | 'terminated'
  bankAccount?: string
}

export interface PayrollRun {
  _id: string
  name: string
  periodStart: string
  periodEnd: string
  status: 'draft' | 'calculated' | 'approved' | 'paid'
  totalGross: number
  totalDeductions: number
  totalNet: number
  employeeCount: number
  createdAt: string
}

export interface Payslip {
  _id: string
  payrollRunId: string
  employeeId: string
  employeeName?: string
  grossPay: number
  deductions: DeductionLine[]
  totalDeductions: number
  netPay: number
  periodStart: string
  periodEnd: string
}

export interface DeductionLine {
  type: string
  description: string
  amount: number
}

export interface Timesheet {
  _id: string
  employeeId: string
  employeeName?: string
  date: string
  hoursWorked: number
  overtimeHours: number
  project?: string
  description?: string
  status: 'draft' | 'submitted' | 'approved' | 'rejected'
}

export const usePayrollStore = defineStore('payroll', () => {
  const appStore = useAppStore()

  // State
  const employees = ref<Employee[]>([])
  const payrollRuns = ref<PayrollRun[]>([])
  const payslips = ref<Payslip[]>([])
  const timesheets = ref<Timesheet[]>([])
  const loading = ref(false)

  // Helpers
  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // Getters
  const activeEmployees = computed(() =>
    employees.value.filter(e => e.status === 'active')
  )

  const pendingPayrollRuns = computed(() =>
    payrollRuns.value.filter(r => r.status === 'draft' || r.status === 'calculated')
  )

  const totalPayrollCost = computed(() =>
    payrollRuns.value
      .filter(r => r.status === 'paid')
      .reduce((sum, r) => sum + r.totalGross, 0)
  )

  // --- Employees ---
  async function fetchEmployees(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/payroll/employee`, { params: filters })
      employees.value = data.employees || []
    } finally {
      loading.value = false
    }
  }

  async function createEmployee(payload: Partial<Employee>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/payroll/employee`, payload)
      employees.value.push(data.employee)
      return data.employee
    } finally {
      loading.value = false
    }
  }

  async function updateEmployee(id: string, payload: Partial<Employee>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/payroll/employee/${id}`, payload)
      const idx = employees.value.findIndex(e => e._id === id)
      if (idx !== -1) employees.value[idx] = data.employee
      return data.employee
    } finally {
      loading.value = false
    }
  }

  async function deleteEmployee(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/payroll/employee/${id}`)
      employees.value = employees.value.filter(e => e._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Payroll Runs ---
  async function fetchPayrollRuns(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/payroll/run`, { params: filters })
      payrollRuns.value = data.payrollRuns || []
    } finally {
      loading.value = false
    }
  }

  async function createPayrollRun(payload: { name: string; periodStart: string; periodEnd: string }) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/payroll/run`, payload)
      payrollRuns.value.unshift(data.payrollRun)
      return data.payrollRun
    } finally {
      loading.value = false
    }
  }

  async function updatePayrollRun(id: string, payload: Partial<PayrollRun>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/payroll/run/${id}`, payload)
      const idx = payrollRuns.value.findIndex(r => r._id === id)
      if (idx !== -1) payrollRuns.value[idx] = data.payrollRun
      return data.payrollRun
    } finally {
      loading.value = false
    }
  }

  async function deletePayrollRun(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/payroll/run/${id}`)
      payrollRuns.value = payrollRuns.value.filter(r => r._id !== id)
    } finally {
      loading.value = false
    }
  }

  async function calculatePayroll(runId: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/payroll/run/${runId}/calculate`)
      const idx = payrollRuns.value.findIndex(r => r._id === runId)
      if (idx !== -1) payrollRuns.value[idx] = data.payrollRun
      return data.payrollRun
    } finally {
      loading.value = false
    }
  }

  async function approvePayroll(runId: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/payroll/run/${runId}/approve`)
      const idx = payrollRuns.value.findIndex(r => r._id === runId)
      if (idx !== -1) payrollRuns.value[idx] = data.payrollRun
      return data.payrollRun
    } finally {
      loading.value = false
    }
  }

  // --- Payslips ---
  async function fetchPayslips(filters?: { payrollRunId?: string; employeeId?: string }) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/payroll/payslip`, { params: filters })
      payslips.value = data.payslips || []
    } finally {
      loading.value = false
    }
  }

  async function createPayslip(payload: Partial<Payslip>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/payroll/payslip`, payload)
      payslips.value.unshift(data.payslip)
      return data.payslip
    } finally {
      loading.value = false
    }
  }

  async function updatePayslip(id: string, payload: Partial<Payslip>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/payroll/payslip/${id}`, payload)
      const idx = payslips.value.findIndex(p => p._id === id)
      if (idx !== -1) payslips.value[idx] = data.payslip
      return data.payslip
    } finally {
      loading.value = false
    }
  }

  async function deletePayslip(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/payroll/payslip/${id}`)
      payslips.value = payslips.value.filter(p => p._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Timesheets ---
  async function fetchTimesheets(filters?: { employeeId?: string; startDate?: string; endDate?: string }) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/payroll/timesheet`, { params: filters })
      timesheets.value = data.timesheets || []
    } finally {
      loading.value = false
    }
  }

  async function createTimesheet(payload: Partial<Timesheet>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/payroll/timesheet`, payload)
      timesheets.value.unshift(data.timesheet)
      return data.timesheet
    } finally {
      loading.value = false
    }
  }

  async function updateTimesheet(id: string, payload: Partial<Timesheet>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/payroll/timesheet/${id}`, payload)
      const idx = timesheets.value.findIndex(t => t._id === id)
      if (idx !== -1) timesheets.value[idx] = data.timesheet
      return data.timesheet
    } finally {
      loading.value = false
    }
  }

  async function deleteTimesheet(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/payroll/timesheet/${id}`)
      timesheets.value = timesheets.value.filter(t => t._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Save wrappers (create or update) ---
  async function saveEmployee(payload: any) {
    if (payload._id) return updateEmployee(payload._id, payload)
    return createEmployee(payload)
  }

  async function savePayrollRun(payload: any) {
    if (payload._id) return updatePayrollRun(payload._id, payload)
    return createPayrollRun(payload)
  }

  async function saveTimesheet(payload: any) {
    if (payload._id) return updateTimesheet(payload._id, payload)
    return createTimesheet(payload)
  }

  return {
    // State
    employees,
    payrollRuns,
    payslips,
    timesheets,
    loading,
    // Getters
    activeEmployees,
    pendingPayrollRuns,
    totalPayrollCost,
    // Actions - Employees
    fetchEmployees,
    createEmployee,
    updateEmployee,
    deleteEmployee,
    saveEmployee,
    // Actions - Payroll Runs
    fetchPayrollRuns,
    createPayrollRun,
    updatePayrollRun,
    deletePayrollRun,
    calculatePayroll,
    approvePayroll,
    savePayrollRun,
    // Actions - Payslips
    fetchPayslips,
    createPayslip,
    updatePayslip,
    deletePayslip,
    // Actions - Timesheets
    fetchTimesheets,
    createTimesheet,
    updateTimesheet,
    deleteTimesheet,
    saveTimesheet,
  }
})
