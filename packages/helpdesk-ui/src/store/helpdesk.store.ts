import { defineStore } from 'pinia'
import { ref } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export interface Ticket {
  _id: string
  id: string
  name: string
  description: string
  channelSource: string
  partnerId?: string
  partner?: any
  assigneeId?: string
  assignee?: any
  teamId?: string
  stageName: string
  state: string
  priority: string
  slaDeadline?: string
  slaStatus: string
  firstResponseDate?: string
  resolutionDate?: string
  closedDate?: string
  rating?: number
  ratingComment?: string
  tags?: string[]
  categoryId?: string
  totalHours: number
  createdAt: string
}

export interface Team {
  _id: string
  id: string
  name: string
  memberIds: string[]
  leaderId: string
  assignmentMethod: string
  emailAlias?: string
  description?: string
  isActive: boolean
  createdAt: string
}

export interface SLAPolicy {
  _id: string
  id: string
  name: string
  teamId?: string
  priority: string
  targets: {
    firstResponseHours?: number
    resolutionHours?: number
  }
  businessHoursOnly: boolean
  escalateTo?: string
  isActive: boolean
  createdAt: string
}

export interface KnowledgeArticle {
  _id: string
  id: string
  name: string
  content: string
  parentId?: string
  authorId?: string
  author?: any
  lastEditorId?: string
  accessLevel: string
  sharedWith: Array<{ userId: string; canEdit: boolean }>
  tags?: string[]
  isFavorite: boolean
  version: number
  isPublished: boolean
  createdAt: string
}

export const useHelpdeskStore = defineStore('helpdesk', () => {
  const appStore = useAppStore()

  const tickets = ref<Ticket[]>([])
  const teams = ref<Team[]>([])
  const slaPolicies = ref<SLAPolicy[]>([])
  const knowledgeArticles = ref<KnowledgeArticle[]>([])
  const loading = ref(false)

  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // ── Tickets ──
  async function fetchTickets(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/helpdesk/tickets`, { params: filters })
      tickets.value = data.tickets || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function fetchTicket(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/helpdesk/tickets/${id}`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function createTicket(payload: Partial<Ticket>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/helpdesk/tickets`, payload)
      tickets.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateTicket(id: string, payload: Partial<Ticket>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/helpdesk/tickets/${id}`, payload)
      const idx = tickets.value.findIndex(t => t._id === id || t.id === id)
      if (idx !== -1) tickets.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteTicket(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/helpdesk/tickets/${id}`)
      tickets.value = tickets.value.filter(t => t._id !== id && t.id !== id)
    } finally {
      loading.value = false
    }
  }

  async function transitionTicket(id: string, state: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/helpdesk/tickets/${id}/transition`, { state })
      const idx = tickets.value.findIndex(t => t._id === id || t.id === id)
      if (idx !== -1) tickets.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function assignTicket(id: string, assigneeId: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/helpdesk/tickets/${id}/assign`, { assigneeId })
      const idx = tickets.value.findIndex(t => t._id === id || t.id === id)
      if (idx !== -1) tickets.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function rateTicket(id: string, rating: number, comment?: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/helpdesk/tickets/${id}/rate`, { rating, comment })
      const idx = tickets.value.findIndex(t => t._id === id || t.id === id)
      if (idx !== -1) tickets.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  // ── Teams ──
  async function fetchTeams(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/helpdesk/teams`, { params: filters })
      teams.value = data.teams || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function createTeam(payload: Partial<Team>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/helpdesk/teams`, payload)
      teams.value.push(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateTeam(id: string, payload: Partial<Team>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/helpdesk/teams/${id}`, payload)
      const idx = teams.value.findIndex(t => t._id === id || t.id === id)
      if (idx !== -1) teams.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteTeam(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/helpdesk/teams/${id}`)
      teams.value = teams.value.filter(t => t._id !== id && t.id !== id)
    } finally {
      loading.value = false
    }
  }

  // ── SLA Policies ──
  async function fetchSLAPolicies(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/helpdesk/sla-policies`, { params: filters })
      slaPolicies.value = data.slaPolicies || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function createSLAPolicy(payload: Partial<SLAPolicy>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/helpdesk/sla-policies`, payload)
      slaPolicies.value.push(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateSLAPolicy(id: string, payload: Partial<SLAPolicy>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/helpdesk/sla-policies/${id}`, payload)
      const idx = slaPolicies.value.findIndex(p => p._id === id || p.id === id)
      if (idx !== -1) slaPolicies.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteSLAPolicy(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/helpdesk/sla-policies/${id}`)
      slaPolicies.value = slaPolicies.value.filter(p => p._id !== id && p.id !== id)
    } finally {
      loading.value = false
    }
  }

  // ── Knowledge Articles ──
  async function fetchKnowledgeArticles(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/helpdesk/knowledge`, { params: filters })
      knowledgeArticles.value = data.articles || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function fetchKnowledgeArticle(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/helpdesk/knowledge/${id}`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function createKnowledgeArticle(payload: Partial<KnowledgeArticle>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/helpdesk/knowledge`, payload)
      knowledgeArticles.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateKnowledgeArticle(id: string, payload: Partial<KnowledgeArticle>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/helpdesk/knowledge/${id}`, payload)
      const idx = knowledgeArticles.value.findIndex(a => a._id === id || a.id === id)
      if (idx !== -1) knowledgeArticles.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteKnowledgeArticle(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/helpdesk/knowledge/${id}`)
      knowledgeArticles.value = knowledgeArticles.value.filter(a => a._id !== id && a.id !== id)
    } finally {
      loading.value = false
    }
  }

  async function publishKnowledgeArticle(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/helpdesk/knowledge/${id}/publish`)
      const idx = knowledgeArticles.value.findIndex(a => a._id === id || a.id === id)
      if (idx !== -1) knowledgeArticles.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    tickets,
    teams,
    slaPolicies,
    knowledgeArticles,
    loading,
    // Helpers
    orgUrl,
    // Tickets
    fetchTickets,
    fetchTicket,
    createTicket,
    updateTicket,
    deleteTicket,
    transitionTicket,
    assignTicket,
    rateTicket,
    // Teams
    fetchTeams,
    createTeam,
    updateTeam,
    deleteTeam,
    // SLA Policies
    fetchSLAPolicies,
    createSLAPolicy,
    updateSLAPolicy,
    deleteSLAPolicy,
    // Knowledge Articles
    fetchKnowledgeArticles,
    fetchKnowledgeArticle,
    createKnowledgeArticle,
    updateKnowledgeArticle,
    deleteKnowledgeArticle,
    publishKnowledgeArticle,
  }
})
