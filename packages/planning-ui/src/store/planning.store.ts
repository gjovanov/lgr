import { defineStore } from 'pinia'
import { ref } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export interface Shift {
  _id: string
  employeeId?: string
  employeeName?: string
  roleId?: string
  projectId?: string
  projectName?: string
  taskId?: string
  dateStart: string
  dateEnd: string
  hours: number
  state: 'draft' | 'published' | 'confirmed' | 'cancelled'
  isRecurring: boolean
  recurringTemplateId?: string
  notes?: string
  color?: string
  createdBy: string
  createdAt: string
}

export interface ShiftTemplateEntry {
  roleId?: string
  dayOfWeek: number
  startTime: string
  endTime: string
}

export interface ShiftTemplate {
  _id: string
  name: string
  entries: ShiftTemplateEntry[]
  isActive: boolean
  createdAt: string
}

export interface Appointment {
  _id: string
  typeId: string
  typeName?: string
  partnerId?: string
  partnerName?: string
  assigneeId: string
  assigneeName?: string
  dateStart: string
  dateEnd: string
  state: 'scheduled' | 'confirmed' | 'done' | 'cancelled' | 'no_show'
  meetingUrl?: string
  notes?: string
  answers: { questionLabel: string; answer: string }[]
  leadId?: string
  createdBy: string
  createdAt: string
}

export interface AppointmentTypeQuestion {
  label: string
  type: string
  required?: boolean
  options?: string[]
}

export interface AppointmentType {
  _id: string
  name: string
  duration: number
  assigneeIds: string[]
  location: 'online' | 'in_person' | 'phone'
  autoConfirm: boolean
  reminderMinutes: number[]
  customQuestions: AppointmentTypeQuestion[]
  isPublic: boolean
  isActive: boolean
  createdAt: string
}

export const usePlanningStore = defineStore('planning', () => {
  const appStore = useAppStore()

  // State
  const shifts = ref<Shift[]>([])
  const shiftTemplates = ref<ShiftTemplate[]>([])
  const appointments = ref<Appointment[]>([])
  const appointmentTypes = ref<AppointmentType[]>([])
  const loading = ref(false)

  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // --- Shifts ---
  async function fetchShifts(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/planning/shifts`, { params: filters })
      shifts.value = data.shifts || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function createShift(payload: Partial<Shift>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/planning/shifts`, payload)
      shifts.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateShift(id: string, payload: Partial<Shift>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/planning/shifts/${id}`, payload)
      const idx = shifts.value.findIndex(s => s._id === id)
      if (idx !== -1) shifts.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteShift(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/planning/shifts/${id}`)
      shifts.value = shifts.value.filter(s => s._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Shift Templates ---
  async function fetchShiftTemplates(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/planning/templates`, { params: filters })
      shiftTemplates.value = data.shiftTemplates || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function createShiftTemplate(payload: Partial<ShiftTemplate>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/planning/templates`, payload)
      shiftTemplates.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateShiftTemplate(id: string, payload: Partial<ShiftTemplate>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/planning/templates/${id}`, payload)
      const idx = shiftTemplates.value.findIndex(t => t._id === id)
      if (idx !== -1) shiftTemplates.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteShiftTemplate(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/planning/templates/${id}`)
      shiftTemplates.value = shiftTemplates.value.filter(t => t._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Appointments ---
  async function fetchAppointments(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/planning/appointments`, { params: filters })
      appointments.value = data.appointments || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function fetchAppointment(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/planning/appointments/${id}`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function createAppointment(payload: Partial<Appointment>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/planning/appointments`, payload)
      appointments.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateAppointment(id: string, payload: Partial<Appointment>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/planning/appointments/${id}`, payload)
      const idx = appointments.value.findIndex(a => a._id === id)
      if (idx !== -1) appointments.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteAppointment(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/planning/appointments/${id}`)
      appointments.value = appointments.value.filter(a => a._id !== id)
    } finally {
      loading.value = false
    }
  }

  async function confirmAppointment(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/planning/appointments/${id}/confirm`)
      const idx = appointments.value.findIndex(a => a._id === id)
      if (idx !== -1) appointments.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function cancelAppointment(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/planning/appointments/${id}/cancel`)
      const idx = appointments.value.findIndex(a => a._id === id)
      if (idx !== -1) appointments.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function noShowAppointment(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/planning/appointments/${id}/no-show`)
      const idx = appointments.value.findIndex(a => a._id === id)
      if (idx !== -1) appointments.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  // --- Appointment Types ---
  async function fetchAppointmentTypes(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/planning/appointment-types`, { params: filters })
      appointmentTypes.value = data.appointmentTypes || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function createAppointmentType(payload: Partial<AppointmentType>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/planning/appointment-types`, payload)
      appointmentTypes.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateAppointmentType(id: string, payload: Partial<AppointmentType>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/planning/appointment-types/${id}`, payload)
      const idx = appointmentTypes.value.findIndex(t => t._id === id)
      if (idx !== -1) appointmentTypes.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteAppointmentType(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/planning/appointment-types/${id}`)
      appointmentTypes.value = appointmentTypes.value.filter(t => t._id !== id)
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    shifts,
    shiftTemplates,
    appointments,
    appointmentTypes,
    loading,
    // Shifts
    fetchShifts,
    createShift,
    updateShift,
    deleteShift,
    // Shift Templates
    fetchShiftTemplates,
    createShiftTemplate,
    updateShiftTemplate,
    deleteShiftTemplate,
    // Appointments
    fetchAppointments,
    fetchAppointment,
    createAppointment,
    updateAppointment,
    deleteAppointment,
    confirmAppointment,
    cancelAppointment,
    noShowAppointment,
    // Appointment Types
    fetchAppointmentTypes,
    createAppointmentType,
    updateAppointmentType,
    deleteAppointmentType,
  }
})
