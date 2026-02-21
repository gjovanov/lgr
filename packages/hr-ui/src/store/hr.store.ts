import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export interface Department {
  _id: string
  name: string
  code: string
  managerId?: string
  managerName?: string
  parentId?: string
  employeeCount: number
  isActive: boolean
}

export interface LeaveType {
  _id: string
  name: string
  code: string
  defaultDays: number
  isPaid: boolean
  isActive: boolean
}

export interface LeaveRequest {
  _id: string
  employeeId: string
  employeeName?: string
  leaveTypeId: string
  leaveTypeName?: string
  startDate: string
  endDate: string
  days: number
  reason?: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  approvedBy?: string
  createdAt: string
}

export interface LeaveBalance {
  _id: string
  employeeId: string
  employeeName?: string
  leaveTypeId: string
  leaveTypeName?: string
  year: number
  entitled: number
  used: number
  remaining: number
}

export interface BusinessTrip {
  _id: string
  employeeId: string
  employeeName?: string
  destination: string
  purpose: string
  startDate: string
  endDate: string
  estimatedCost: number
  actualCost?: number
  currency: string
  status: 'requested' | 'approved' | 'in_progress' | 'completed' | 'cancelled'
}

export interface EmployeeDocument {
  _id: string
  employeeId: string
  employeeName?: string
  type: string
  name: string
  fileUrl: string
  uploadedAt: string
  expiresAt?: string
}

export const useHRStore = defineStore('hr', () => {
  const appStore = useAppStore()

  // State
  const departments = ref<Department[]>([])
  const leaveTypes = ref<LeaveType[]>([])
  const leaveRequests = ref<LeaveRequest[]>([])
  const leaveBalances = ref<LeaveBalance[]>([])
  const businessTrips = ref<BusinessTrip[]>([])
  const employeeDocuments = ref<EmployeeDocument[]>([])
  const loading = ref(false)

  // Helpers
  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // Getters
  const activeDepartments = computed(() =>
    departments.value.filter(d => d.isActive)
  )

  const pendingLeaveRequests = computed(() =>
    leaveRequests.value.filter(r => r.status === 'pending')
  )

  const activeTrips = computed(() =>
    businessTrips.value.filter(t => t.status === 'approved' || t.status === 'in_progress')
  )

  // --- Departments ---
  async function fetchDepartments() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/hr/department`)
      departments.value = data.departments
    } finally {
      loading.value = false
    }
  }

  async function createDepartment(payload: Partial<Department>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/hr/department`, payload)
      departments.value.push(data.department)
      return data.department
    } finally {
      loading.value = false
    }
  }

  async function updateDepartment(id: string, payload: Partial<Department>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/hr/department/${id}`, payload)
      const idx = departments.value.findIndex(d => d._id === id)
      if (idx !== -1) departments.value[idx] = data.department
      return data.department
    } finally {
      loading.value = false
    }
  }

  async function deleteDepartment(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/hr/department/${id}`)
      departments.value = departments.value.filter(d => d._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Leave Types ---
  async function fetchLeaveTypes() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/hr/leave-type`)
      leaveTypes.value = data.leaveTypes
    } finally {
      loading.value = false
    }
  }

  async function createLeaveType(payload: Partial<LeaveType>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/hr/leave-type`, payload)
      leaveTypes.value.push(data.leaveType)
      return data.leaveType
    } finally {
      loading.value = false
    }
  }

  async function updateLeaveType(id: string, payload: Partial<LeaveType>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/hr/leave-type/${id}`, payload)
      const idx = leaveTypes.value.findIndex(t => t._id === id)
      if (idx !== -1) leaveTypes.value[idx] = data.leaveType
      return data.leaveType
    } finally {
      loading.value = false
    }
  }

  async function deleteLeaveType(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/hr/leave-type/${id}`)
      leaveTypes.value = leaveTypes.value.filter(t => t._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Leave Requests ---
  async function fetchLeaveRequests(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/hr/leave-request`, { params: filters })
      leaveRequests.value = data.leaveRequests
    } finally {
      loading.value = false
    }
  }

  async function createLeaveRequest(payload: { leaveTypeId: string; startDate: string; endDate: string; reason?: string }) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/hr/leave-request`, payload)
      leaveRequests.value.unshift(data.leaveRequest)
      return data.leaveRequest
    } finally {
      loading.value = false
    }
  }

  async function updateLeaveRequest(id: string, payload: Partial<LeaveRequest>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/hr/leave-request/${id}`, payload)
      const idx = leaveRequests.value.findIndex(r => r._id === id)
      if (idx !== -1) leaveRequests.value[idx] = data.leaveRequest
      return data.leaveRequest
    } finally {
      loading.value = false
    }
  }

  async function deleteLeaveRequest(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/hr/leave-request/${id}`)
      leaveRequests.value = leaveRequests.value.filter(r => r._id !== id)
    } finally {
      loading.value = false
    }
  }

  async function approveLeave(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/hr/leave-request/${id}/approve`)
      const idx = leaveRequests.value.findIndex(r => r._id === id)
      if (idx !== -1) leaveRequests.value[idx] = data.leaveRequest
      return data.leaveRequest
    } finally {
      loading.value = false
    }
  }

  async function rejectLeave(id: string, reason?: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/hr/leave-request/${id}/reject`, { reason })
      const idx = leaveRequests.value.findIndex(r => r._id === id)
      if (idx !== -1) leaveRequests.value[idx] = data.leaveRequest
      return data.leaveRequest
    } finally {
      loading.value = false
    }
  }

  // --- Leave Balances ---
  async function fetchLeaveBalances(filters?: { employeeId?: string; year?: number }) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/hr/leave-balance`, { params: filters })
      leaveBalances.value = data.leaveBalances
    } finally {
      loading.value = false
    }
  }

  async function createLeaveBalance(payload: Partial<LeaveBalance>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/hr/leave-balance`, payload)
      leaveBalances.value.push(data.leaveBalance)
      return data.leaveBalance
    } finally {
      loading.value = false
    }
  }

  async function updateLeaveBalance(id: string, payload: Partial<LeaveBalance>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/hr/leave-balance/${id}`, payload)
      const idx = leaveBalances.value.findIndex(b => b._id === id)
      if (idx !== -1) leaveBalances.value[idx] = data.leaveBalance
      return data.leaveBalance
    } finally {
      loading.value = false
    }
  }

  async function deleteLeaveBalance(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/hr/leave-balance/${id}`)
      leaveBalances.value = leaveBalances.value.filter(b => b._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Business Trips ---
  async function fetchBusinessTrips(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/hr/business-trip`, { params: filters })
      businessTrips.value = data.businessTrips
    } finally {
      loading.value = false
    }
  }

  async function createBusinessTrip(payload: Partial<BusinessTrip>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/hr/business-trip`, payload)
      businessTrips.value.unshift(data.businessTrip)
      return data.businessTrip
    } finally {
      loading.value = false
    }
  }

  async function updateBusinessTrip(id: string, payload: Partial<BusinessTrip>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/hr/business-trip/${id}`, payload)
      const idx = businessTrips.value.findIndex(t => t._id === id)
      if (idx !== -1) businessTrips.value[idx] = data.businessTrip
      return data.businessTrip
    } finally {
      loading.value = false
    }
  }

  async function deleteBusinessTrip(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/hr/business-trip/${id}`)
      businessTrips.value = businessTrips.value.filter(t => t._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Employee Documents ---
  async function fetchEmployeeDocuments(filters?: { employeeId?: string; type?: string }) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/hr/employee-document`, { params: filters })
      employeeDocuments.value = data.documents
    } finally {
      loading.value = false
    }
  }

  async function createEmployeeDocument(payload: Partial<EmployeeDocument>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/hr/employee-document`, payload)
      employeeDocuments.value.unshift(data.document)
      return data.document
    } finally {
      loading.value = false
    }
  }

  async function updateEmployeeDocument(id: string, payload: Partial<EmployeeDocument>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/hr/employee-document/${id}`, payload)
      const idx = employeeDocuments.value.findIndex(d => d._id === id)
      if (idx !== -1) employeeDocuments.value[idx] = data.document
      return data.document
    } finally {
      loading.value = false
    }
  }

  async function deleteEmployeeDocument(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/hr/employee-document/${id}`)
      employeeDocuments.value = employeeDocuments.value.filter(d => d._id !== id)
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    departments,
    leaveTypes,
    leaveRequests,
    leaveBalances,
    businessTrips,
    employeeDocuments,
    loading,
    // Getters
    activeDepartments,
    pendingLeaveRequests,
    activeTrips,
    // Actions - Departments
    fetchDepartments,
    createDepartment,
    updateDepartment,
    deleteDepartment,
    // Actions - Leave Types
    fetchLeaveTypes,
    createLeaveType,
    updateLeaveType,
    deleteLeaveType,
    // Actions - Leave Requests
    fetchLeaveRequests,
    createLeaveRequest,
    updateLeaveRequest,
    deleteLeaveRequest,
    approveLeave,
    rejectLeave,
    // Actions - Leave Balances
    fetchLeaveBalances,
    createLeaveBalance,
    updateLeaveBalance,
    deleteLeaveBalance,
    // Actions - Business Trips
    fetchBusinessTrips,
    createBusinessTrip,
    updateBusinessTrip,
    deleteBusinessTrip,
    // Actions - Employee Documents
    fetchEmployeeDocuments,
    createEmployeeDocument,
    updateEmployeeDocument,
    deleteEmployeeDocument,
  }
})
