<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon="mdi-arrow-left" variant="text" @click="$router.push({ name: 'helpdesk.tickets' })" />
      <h1 class="text-h5 ml-2">{{ ticket?.name || '' }}</h1>
      <v-chip v-if="ticket" class="ml-2" size="small" :color="stateColor(ticket.state)">{{ ticket.state }}</v-chip>
      <v-spacer />

      <!-- Action Buttons -->
      <div v-if="ticket" class="d-flex ga-2">
        <v-btn v-if="ticket.state === 'new'" color="primary" variant="tonal" @click="transition('in_progress')">
          <v-icon start>mdi-play</v-icon>{{ t('helpdesk.start') }}
        </v-btn>
        <v-btn v-if="ticket.state === 'in_progress'" color="success" variant="tonal" @click="transition('resolved')">
          <v-icon start>mdi-check</v-icon>{{ t('helpdesk.resolve') }}
        </v-btn>
        <v-btn v-if="ticket.state === 'in_progress'" color="warning" variant="tonal" @click="transition('on_hold')">
          <v-icon start>mdi-pause</v-icon>{{ t('helpdesk.hold') }}
        </v-btn>
        <v-btn v-if="ticket.state === 'on_hold'" color="primary" variant="tonal" @click="transition('in_progress')">
          <v-icon start>mdi-play</v-icon>{{ t('helpdesk.resume') }}
        </v-btn>
        <v-btn v-if="['new', 'in_progress', 'on_hold', 'resolved'].includes(ticket.state)" color="grey" variant="tonal" @click="transition('closed')">
          <v-icon start>mdi-lock</v-icon>{{ t('helpdesk.close') }}
        </v-btn>
        <v-btn v-if="ticket.state === 'resolved' || ticket.state === 'closed'" color="info" variant="tonal" @click="transition('in_progress')">
          <v-icon start>mdi-refresh</v-icon>{{ t('helpdesk.reopen') }}
        </v-btn>
      </div>
    </div>

    <v-row v-if="ticket">
      <!-- Main Info -->
      <v-col cols="12" md="8">
        <v-card class="mb-4">
          <v-card-title>{{ t('helpdesk.ticketInfo') }}</v-card-title>
          <v-card-text>
            <div class="text-body-1 mb-4" style="white-space: pre-wrap;">{{ ticket.description }}</div>
            <v-divider class="mb-4" />
            <v-row>
              <v-col cols="6" md="3">
                <div class="text-caption text-medium-emphasis">{{ t('helpdesk.channel') }}</div>
                <div>{{ ticket.channelSource }}</div>
              </v-col>
              <v-col cols="6" md="3">
                <div class="text-caption text-medium-emphasis">{{ t('helpdesk.priority') }}</div>
                <v-chip size="small" :color="priorityColor(ticket.priority)">{{ ticket.priority }}</v-chip>
              </v-col>
              <v-col cols="6" md="3">
                <div class="text-caption text-medium-emphasis">{{ t('common.createdAt') }}</div>
                <div>{{ ticket.createdAt?.split('T')[0] }}</div>
              </v-col>
              <v-col cols="6" md="3">
                <div class="text-caption text-medium-emphasis">{{ t('helpdesk.totalHours') }}</div>
                <div>{{ ticket.totalHours || 0 }}h</div>
              </v-col>
            </v-row>
            <v-row v-if="ticket.tags?.length">
              <v-col cols="12">
                <div class="text-caption text-medium-emphasis mb-1">{{ t('common.tags') }}</div>
                <v-chip v-for="tag in ticket.tags" :key="tag" size="small" class="mr-1">{{ tag }}</v-chip>
              </v-col>
            </v-row>
          </v-card-text>
        </v-card>

        <!-- Rating (for resolved/closed) -->
        <v-card v-if="['resolved', 'closed'].includes(ticket.state)" class="mb-4">
          <v-card-title>{{ t('helpdesk.rating') }}</v-card-title>
          <v-card-text>
            <div class="d-flex align-center ga-2">
              <v-rating
                v-model="ratingValue"
                color="amber"
                hover
                :readonly="!!ticket.rating"
                @update:model-value="submitRating"
              />
              <span v-if="ticket.rating" class="text-body-2">{{ ticket.rating }}/5</span>
            </div>
            <v-text-field
              v-if="!ticket.rating"
              v-model="ratingComment"
              :label="t('helpdesk.ratingComment')"
              class="mt-2"
              density="compact"
            />
            <div v-if="ticket.ratingComment" class="text-body-2 mt-2 text-medium-emphasis">{{ ticket.ratingComment }}</div>
          </v-card-text>
        </v-card>

        <!-- Live Chat -->
        <v-card v-if="ticket.roomId" class="mb-4">
          <v-card-title>{{ t('discuss.liveChat') }}</v-card-title>
          <v-card-text>
            <roomler-chat-embed :room-id="ticket.roomId" :height="400" />
          </v-card-text>
        </v-card>
      </v-col>

      <!-- Sidebar -->
      <v-col cols="12" md="4">
        <!-- SLA Status -->
        <v-card class="mb-4">
          <v-card-title>{{ t('helpdesk.sla') }}</v-card-title>
          <v-card-text>
            <div class="d-flex align-center justify-space-between mb-2">
              <span class="text-caption text-medium-emphasis">{{ t('helpdesk.slaStatus') }}</span>
              <v-chip size="small" :color="slaColor(ticket.slaStatus)">{{ ticket.slaStatus }}</v-chip>
            </div>
            <div v-if="ticket.slaDeadline" class="d-flex align-center justify-space-between mb-2">
              <span class="text-caption text-medium-emphasis">{{ t('helpdesk.slaDeadline') }}</span>
              <span class="text-body-2">{{ new Date(ticket.slaDeadline).toLocaleString() }}</span>
            </div>
            <div v-if="ticket.firstResponseDate" class="d-flex align-center justify-space-between mb-2">
              <span class="text-caption text-medium-emphasis">{{ t('helpdesk.firstResponse') }}</span>
              <span class="text-body-2">{{ ticket.firstResponseDate?.split('T')[0] }}</span>
            </div>
            <div v-if="ticket.resolutionDate" class="d-flex align-center justify-space-between">
              <span class="text-caption text-medium-emphasis">{{ t('helpdesk.resolvedAt') }}</span>
              <span class="text-body-2">{{ ticket.resolutionDate?.split('T')[0] }}</span>
            </div>
          </v-card-text>
        </v-card>

        <!-- Assignee -->
        <v-card class="mb-4">
          <v-card-title>{{ t('helpdesk.assignee') }}</v-card-title>
          <v-card-text>
            <v-autocomplete
              v-model="assigneeId"
              :items="users"
              :item-title="(u: any) => `${u.firstName} ${u.lastName}`"
              item-value="_id"
              clearable
              density="compact"
              hide-details
              @update:model-value="doAssign"
            />
          </v-card-text>
        </v-card>

        <!-- Partner -->
        <v-card class="mb-4">
          <v-card-title>{{ t('helpdesk.partner') }}</v-card-title>
          <v-card-text>
            <div v-if="ticket.partner">
              {{ ticket.partner.companyName || `${ticket.partner.firstName} ${ticket.partner.lastName}` }}
            </div>
            <div v-else class="text-caption text-disabled">{{ t('common.noData') }}</div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { useHelpdeskStore } from '../../store/helpdesk.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import RoomlerChatEmbed from 'ui-shared/components/RoomlerChatEmbed.vue'

const { t } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const store = useHelpdeskStore()
const { showSuccess, showError } = useSnackbar()

const ticketId = route.params.id as string
const ticket = ref<any>(null)
const assigneeId = ref('')
const ratingValue = ref(0)
const ratingComment = ref('')
const users = ref<any[]>([])

function stateColor(state: string) {
  return ({ new: 'info', in_progress: 'primary', on_hold: 'warning', resolved: 'success', closed: 'grey' }[state] || 'grey')
}

function priorityColor(priority: string) {
  return ({ low: 'grey', normal: 'info', high: 'warning', urgent: 'error' }[priority] || 'grey')
}

function slaColor(status: string) {
  return ({ none: 'grey', on_track: 'success', at_risk: 'warning', breached: 'error', met: 'success' }[status] || 'grey')
}

async function loadTicket() {
  try {
    ticket.value = await store.fetchTicket(ticketId)
    assigneeId.value = ticket.value.assigneeId || ''
    ratingValue.value = ticket.value.rating || 0
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function transition(state: string) {
  try {
    ticket.value = await store.transitionTicket(ticketId, state)
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function doAssign(userId: string) {
  if (!userId) return
  try {
    ticket.value = await store.assignTicket(ticketId, userId)
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function submitRating(value: number) {
  try {
    ticket.value = await store.rateTicket(ticketId, value, ratingComment.value || undefined)
    showSuccess(t('helpdesk.ratingSubmitted'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function fetchUsers() {
  try {
    const portalBase = window.location.hostname === 'localhost' ? 'http://localhost:4001/api' : ''
    const { data } = await httpClient.get(`${portalBase}/org/${appStore.currentOrg?.id}/users`)
    users.value = data.users || data || []
  } catch { /* */ }
}

onMounted(async () => {
  await fetchUsers()
  await loadTicket()
})
</script>
