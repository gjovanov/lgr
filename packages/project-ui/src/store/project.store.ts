import { defineStore } from 'pinia'
import { ref } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export interface Project {
  _id: string
  id: string
  name: string
  description?: string
  partnerId?: string
  partner?: any
  managerId?: string
  manager?: any
  memberIds: string[]
  state: string
  dateStart?: string
  dateEnd?: string
  stages: ProjectStage[]
  color?: string
  tags?: string[]
  budgetPlanned: number
  budgetSpent: number
  revenueExpected: number
  revenueInvoiced: number
  isFavorite: boolean
  salesOrderId?: string
  createdAt: string
}

export interface ProjectStage {
  name: string
  sequence: number
  fold?: boolean
}

export interface Task {
  _id: string
  id: string
  projectId: string
  name: string
  description?: string
  stageName: string
  state: string
  priority: string
  assigneeIds: string[]
  parentTaskId?: string
  dependencyIds: string[]
  dateDeadline?: string
  dateStart?: string
  dateEnd?: string
  plannedHours: number
  effectiveHours: number
  remainingHours: number
  milestoneId?: string
  tags?: string[]
  isRecurring: boolean
  recurringInterval?: number
  recurringPeriod?: string
  createdAt: string
}

export interface Milestone {
  _id: string
  id: string
  projectId: string
  name: string
  deadline: string
  isReached: boolean
  reachedDate?: string
  salesOrderLineIndex?: number
  createdAt: string
}

export interface Timesheet {
  _id: string
  id: string
  employeeId: string
  projectId: string
  taskId?: string
  date: string
  hours: number
  description?: string
  unitAmount: number
  createdAt: string
}

export interface FieldServiceTask {
  _id: string
  id: string
  name: string
  description?: string
  partnerId?: string
  partner?: any
  assigneeId?: string
  assignee?: any
  projectId?: string
  state: string
  priority: string
  dateScheduled: string
  dateStart?: string
  dateEnd?: string
  location?: string
  plannedHours: number
  effectiveHours: number
  totalPartsCost: number
  totalLaborCost: number
  tags?: string[]
  worksheetNotes?: string
  createdAt: string
}

export interface Profitability {
  budgetPlanned: number
  budgetSpent: number
  revenueExpected: number
  revenueInvoiced: number
  timesheetHours: number
  timesheetCost: number
  margin: number
  marginPercent: number
}

export const useProjectStore = defineStore('project', () => {
  const appStore = useAppStore()

  const projects = ref<Project[]>([])
  const tasks = ref<Task[]>([])
  const milestones = ref<Milestone[]>([])
  const timesheets = ref<Timesheet[]>([])
  const fieldServiceTasks = ref<FieldServiceTask[]>([])
  const loading = ref(false)

  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // ── Projects ──
  async function fetchProjects(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/project/projects`, { params: filters })
      projects.value = data.projects || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function fetchProject(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/project/projects/${id}`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function createProject(payload: Partial<Project>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/project/projects`, payload)
      projects.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateProject(id: string, payload: Partial<Project>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/project/projects/${id}`, payload)
      const idx = projects.value.findIndex(p => p._id === id || p.id === id)
      if (idx !== -1) projects.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteProject(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/project/projects/${id}`)
      projects.value = projects.value.filter(p => p._id !== id && p.id !== id)
    } finally {
      loading.value = false
    }
  }

  async function fetchProfitability(projectId: string): Promise<Profitability> {
    const { data } = await httpClient.get(`${orgUrl()}/project/projects/${projectId}/profitability`)
    return data
  }

  // ── Tasks ──
  async function fetchTasks(projectId: string, filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/project/tasks`, {
        params: { projectId, ...filters },
      })
      tasks.value = data.tasks || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function fetchTask(id: string) {
    const { data } = await httpClient.get(`${orgUrl()}/project/tasks/${id}`)
    return data
  }

  async function createTask(payload: Partial<Task>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/project/tasks`, payload)
      tasks.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateTask(id: string, payload: Partial<Task>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/project/tasks/${id}`, payload)
      const idx = tasks.value.findIndex(t => t._id === id || t.id === id)
      if (idx !== -1) tasks.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteTask(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/project/tasks/${id}`)
      tasks.value = tasks.value.filter(t => t._id !== id && t.id !== id)
    } finally {
      loading.value = false
    }
  }

  async function transitionTask(id: string, state: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/project/tasks/${id}/transition`, { state })
      const idx = tasks.value.findIndex(t => t._id === id || t.id === id)
      if (idx !== -1) tasks.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  // ── Milestones ──
  async function fetchMilestones(projectId: string) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/project/milestones`, {
        params: { projectId },
      })
      milestones.value = data.milestones || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function createMilestone(payload: { projectId: string; name: string; deadline: string; salesOrderLineIndex?: number }) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/project/milestones`, payload)
      milestones.value.push(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateMilestone(id: string, payload: Partial<Milestone>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/project/milestones/${id}`, payload)
      const idx = milestones.value.findIndex(m => m._id === id || m.id === id)
      if (idx !== -1) milestones.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteMilestone(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/project/milestones/${id}`)
      milestones.value = milestones.value.filter(m => m._id !== id && m.id !== id)
    } finally {
      loading.value = false
    }
  }

  async function reachMilestone(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/project/milestones/${id}/reach`)
      const idx = milestones.value.findIndex(m => m._id === id || m.id === id)
      if (idx !== -1) milestones.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  // ── Timesheets ──
  async function fetchTimesheets(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/project/timesheets`, { params: filters })
      timesheets.value = data.timesheets || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function createTimesheet(payload: Partial<Timesheet>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/project/timesheets`, payload)
      timesheets.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateTimesheet(id: string, payload: Partial<Timesheet>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/project/timesheets/${id}`, payload)
      const idx = timesheets.value.findIndex(t => t._id === id || t.id === id)
      if (idx !== -1) timesheets.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteTimesheet(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/project/timesheets/${id}`)
      timesheets.value = timesheets.value.filter(t => t._id !== id && t.id !== id)
    } finally {
      loading.value = false
    }
  }

  // ── Field Service ──
  async function fetchFieldServiceTasks(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/project/field-service`, { params: filters })
      fieldServiceTasks.value = data.tasks || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function fetchFieldServiceTask(id: string) {
    const { data } = await httpClient.get(`${orgUrl()}/project/field-service/${id}`)
    return data
  }

  async function createFieldServiceTask(payload: Partial<FieldServiceTask>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/project/field-service`, payload)
      fieldServiceTasks.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateFieldServiceTask(id: string, payload: Partial<FieldServiceTask>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/project/field-service/${id}`, payload)
      const idx = fieldServiceTasks.value.findIndex(t => t._id === id || t.id === id)
      if (idx !== -1) fieldServiceTasks.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteFieldServiceTask(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/project/field-service/${id}`)
      fieldServiceTasks.value = fieldServiceTasks.value.filter(t => t._id !== id && t.id !== id)
    } finally {
      loading.value = false
    }
  }

  async function startFieldServiceTask(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/project/field-service/${id}/start`)
      const idx = fieldServiceTasks.value.findIndex(t => t._id === id || t.id === id)
      if (idx !== -1) fieldServiceTasks.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function completeFieldServiceTask(id: string, payload?: { effectiveHours?: number; laborRate?: number; worksheetNotes?: string }) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/project/field-service/${id}/complete`, payload || {})
      const idx = fieldServiceTasks.value.findIndex(t => t._id === id || t.id === id)
      if (idx !== -1) fieldServiceTasks.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function cancelFieldServiceTask(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/project/field-service/${id}/cancel`)
      const idx = fieldServiceTasks.value.findIndex(t => t._id === id || t.id === id)
      if (idx !== -1) fieldServiceTasks.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    projects,
    tasks,
    milestones,
    timesheets,
    fieldServiceTasks,
    loading,
    // Helpers
    orgUrl,
    // Projects
    fetchProjects,
    fetchProject,
    createProject,
    updateProject,
    deleteProject,
    fetchProfitability,
    // Tasks
    fetchTasks,
    fetchTask,
    createTask,
    updateTask,
    deleteTask,
    transitionTask,
    // Milestones
    fetchMilestones,
    createMilestone,
    updateMilestone,
    deleteMilestone,
    reachMilestone,
    // Timesheets
    fetchTimesheets,
    createTimesheet,
    updateTimesheet,
    deleteTimesheet,
    // Field Service
    fetchFieldServiceTasks,
    fetchFieldServiceTask,
    createFieldServiceTask,
    updateFieldServiceTask,
    deleteFieldServiceTask,
    startFieldServiceTask,
    completeFieldServiceTask,
    cancelFieldServiceTask,
  }
})
