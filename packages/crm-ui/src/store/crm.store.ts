import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export interface Lead {
  _id: string
  name: string
  email?: string
  phone?: string
  company?: string
  source: string
  status: 'new' | 'contacted' | 'qualified' | 'unqualified' | 'converted'
  assignedTo?: string
  assignedToName?: string
  notes?: string
  createdAt: string
}

export interface Deal {
  _id: string
  name: string
  contactId: string
  contactName?: string
  pipelineId: string
  stageId: string
  stageName?: string
  value: number
  currency: string
  probability: number
  expectedCloseDate: string
  assignedTo?: string
  assignedToName?: string
  status: 'open' | 'won' | 'lost'
  createdAt: string
}

export interface Pipeline {
  _id: string
  name: string
  stages: PipelineStage[]
  isDefault: boolean
  isActive: boolean
}

export interface PipelineStage {
  _id: string
  name: string
  order: number
  probability: number
  color?: string
}

export interface Activity {
  _id: string
  type: 'call' | 'email' | 'meeting' | 'task' | 'note'
  subject: string
  description?: string
  relatedTo: { type: 'lead' | 'deal' | 'contact'; id: string }
  dueDate?: string
  completedAt?: string
  assignedTo?: string
  assignedToName?: string
  status: 'pending' | 'completed' | 'cancelled'
  createdAt: string
}

export interface PipelineSummary {
  pipelineId: string
  pipelineName: string
  stages: {
    stageId: string
    stageName: string
    dealCount: number
    totalValue: number
  }[]
  totalDeals: number
  totalValue: number
  weightedValue: number
}

export const useCRMStore = defineStore('crm', () => {
  const appStore = useAppStore()

  // State
  const leads = ref<Lead[]>([])
  const deals = ref<Deal[]>([])
  const pipelines = ref<Pipeline[]>([])
  const activities = ref<Activity[]>([])
  const pipelineSummary = ref<PipelineSummary | null>(null)
  const loading = ref(false)

  // Helpers
  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // Getters
  const openDeals = computed(() =>
    deals.value.filter(d => d.status === 'open')
  )

  const totalPipelineValue = computed(() =>
    deals.value
      .filter(d => d.status === 'open')
      .reduce((sum, d) => sum + d.value, 0)
  )

  const weightedPipelineValue = computed(() =>
    deals.value
      .filter(d => d.status === 'open')
      .reduce((sum, d) => sum + d.value * (d.probability / 100), 0)
  )

  const newLeads = computed(() =>
    leads.value.filter(l => l.status === 'new')
  )

  const pendingActivities = computed(() =>
    activities.value.filter(a => a.status === 'pending')
  )

  // --- Leads ---
  async function fetchLeads(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/crm/lead`, { params: filters })
      leads.value = data.leads
    } finally {
      loading.value = false
    }
  }

  async function createLead(payload: Partial<Lead>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/crm/lead`, payload)
      leads.value.unshift(data.lead)
      return data.lead
    } finally {
      loading.value = false
    }
  }

  async function updateLead(id: string, payload: Partial<Lead>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/crm/lead/${id}`, payload)
      const idx = leads.value.findIndex(l => l._id === id)
      if (idx !== -1) leads.value[idx] = data.lead
      return data.lead
    } finally {
      loading.value = false
    }
  }

  async function deleteLead(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/crm/lead/${id}`)
      leads.value = leads.value.filter(l => l._id !== id)
    } finally {
      loading.value = false
    }
  }

  async function convertLead(id: string, payload?: { createDeal?: boolean; dealName?: string; pipelineId?: string }) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/crm/lead/${id}/convert`, payload)
      const idx = leads.value.findIndex(l => l._id === id)
      if (idx !== -1) leads.value[idx] = data.lead
      if (data.deal) deals.value.unshift(data.deal)
      return data
    } finally {
      loading.value = false
    }
  }

  // --- Deals ---
  async function fetchDeals(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/crm/deal`, { params: filters })
      deals.value = data.deals
    } finally {
      loading.value = false
    }
  }

  async function createDeal(payload: Partial<Deal>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/crm/deal`, payload)
      deals.value.unshift(data.deal)
      return data.deal
    } finally {
      loading.value = false
    }
  }

  async function updateDeal(id: string, payload: Partial<Deal>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/crm/deal/${id}`, payload)
      const idx = deals.value.findIndex(d => d._id === id)
      if (idx !== -1) deals.value[idx] = data.deal
      return data.deal
    } finally {
      loading.value = false
    }
  }

  async function deleteDeal(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/crm/deal/${id}`)
      deals.value = deals.value.filter(d => d._id !== id)
    } finally {
      loading.value = false
    }
  }

  async function moveDealStage(id: string, stageId: string) {
    loading.value = true
    try {
      const { data } = await httpClient.patch(`${orgUrl()}/crm/deal/${id}/stage`, { stageId })
      const idx = deals.value.findIndex(d => d._id === id)
      if (idx !== -1) deals.value[idx] = data.deal
      return data.deal
    } finally {
      loading.value = false
    }
  }

  // --- Pipelines ---
  async function fetchPipelines() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/crm/pipeline`)
      pipelines.value = data.pipelines
    } finally {
      loading.value = false
    }
  }

  async function createPipeline(payload: Partial<Pipeline>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/crm/pipeline`, payload)
      pipelines.value.push(data.pipeline)
      return data.pipeline
    } finally {
      loading.value = false
    }
  }

  async function updatePipeline(id: string, payload: Partial<Pipeline>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/crm/pipeline/${id}`, payload)
      const idx = pipelines.value.findIndex(p => p._id === id)
      if (idx !== -1) pipelines.value[idx] = data.pipeline
      return data.pipeline
    } finally {
      loading.value = false
    }
  }

  async function deletePipeline(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/crm/pipeline/${id}`)
      pipelines.value = pipelines.value.filter(p => p._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Activities ---
  async function fetchActivities(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/crm/activity`, { params: filters })
      activities.value = data.activities
    } finally {
      loading.value = false
    }
  }

  async function createActivity(payload: Partial<Activity>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/crm/activity`, payload)
      activities.value.unshift(data.activity)
      return data.activity
    } finally {
      loading.value = false
    }
  }

  async function updateActivity(id: string, payload: Partial<Activity>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/crm/activity/${id}`, payload)
      const idx = activities.value.findIndex(a => a._id === id)
      if (idx !== -1) activities.value[idx] = data.activity
      return data.activity
    } finally {
      loading.value = false
    }
  }

  async function deleteActivity(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/crm/activity/${id}`)
      activities.value = activities.value.filter(a => a._id !== id)
    } finally {
      loading.value = false
    }
  }

  async function completeActivity(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/crm/activity/${id}/complete`)
      const idx = activities.value.findIndex(a => a._id === id)
      if (idx !== -1) activities.value[idx] = data.activity
      return data.activity
    } finally {
      loading.value = false
    }
  }

  // --- Pipeline Summary ---
  async function fetchPipelineSummary(pipelineId?: string) {
    loading.value = true
    try {
      const params = pipelineId ? { pipelineId } : undefined
      const { data } = await httpClient.get(`${orgUrl()}/crm/report/pipeline-summary`, { params })
      pipelineSummary.value = data.summary
      return data.summary
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    leads,
    deals,
    pipelines,
    activities,
    pipelineSummary,
    loading,
    // Getters
    openDeals,
    totalPipelineValue,
    weightedPipelineValue,
    newLeads,
    pendingActivities,
    // Actions - Leads
    fetchLeads,
    createLead,
    updateLead,
    deleteLead,
    convertLead,
    // Actions - Deals
    fetchDeals,
    createDeal,
    updateDeal,
    deleteDeal,
    moveDealStage,
    // Actions - Pipelines
    fetchPipelines,
    createPipeline,
    updatePipeline,
    deletePipeline,
    // Actions - Activities
    fetchActivities,
    createActivity,
    updateActivity,
    deleteActivity,
    completeActivity,
    // Actions - Reports
    fetchPipelineSummary,
  }
})
