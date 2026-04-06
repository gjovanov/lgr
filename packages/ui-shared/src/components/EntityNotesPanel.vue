<template>
  <div class="entity-notes-panel">
    <!-- Add note form -->
    <div class="mb-3">
      <v-textarea
        v-model="newNote"
        :placeholder="entityId ? $t('common.addNote') : $t('common.saveFirstToAddNotes')"
        rows="2"
        density="compact"
        variant="outlined"
        hide-details
        auto-grow
        :disabled="!entityId"
      />
      <div class="d-flex justify-end mt-1">
        <v-btn
          size="small"
          color="primary"
          variant="flat"
          :disabled="!entityId || !newNote.trim()"
          :loading="saving"
          @click="submitNote"
        >
          {{ $t('common.log') }}
        </v-btn>
      </div>
    </div>

    <v-divider class="mb-3" />

    <!-- Timeline of notes + audit entries -->
    <div v-if="loading" class="text-center pa-4">
      <v-progress-circular indeterminate size="24" />
    </div>

    <div v-else-if="!entries.length" class="text-center text-medium-emphasis text-caption pa-4">
      {{ entityId ? $t('common.noHistory') : '' }}
    </div>

    <v-timeline v-else density="compact" side="end" class="notes-timeline">
      <v-timeline-item
        v-for="entry in entries"
        :key="entry.id"
        :dot-color="entry.type === 'note' ? 'primary' : 'grey'"
        :icon="entry.type === 'note' ? 'mdi-message-text' : 'mdi-history'"
        size="x-small"
      >
        <div class="timeline-entry">
          <div class="d-flex align-center ga-1 mb-1">
            <span class="text-caption font-weight-medium">{{ entry.userName || 'System' }}</span>
            <span class="text-caption text-medium-emphasis">{{ formatRelativeTime(entry.timestamp) }}</span>
          </div>
          <div v-if="entry.type === 'note'" class="text-body-2">{{ entry.text }}</div>
          <div v-else class="text-caption text-medium-emphasis">
            <span class="font-weight-medium">{{ entry.action }}</span>
            <template v-if="entry.changes?.length">
              <div v-for="change in entry.changes" :key="change.field" class="change-item">
                {{ change.field }}: <span class="text-decoration-line-through">{{ change.oldValue }}</span> → {{ change.newValue }}
              </div>
            </template>
          </div>
        </div>
      </v-timeline-item>
    </v-timeline>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { httpClient } from '../composables/useHttpClient.js'

interface NoteEntry {
  id: string
  type: 'note' | 'audit'
  text?: string
  action?: string
  userName?: string
  timestamp: Date
  changes?: { field: string; oldValue: any; newValue: any }[]
}

const props = defineProps<{
  orgUrl: string
  entityType: string
  entityId?: string
}>()

const newNote = ref('')
const saving = ref(false)
const loading = ref(false)
const entries = ref<NoteEntry[]>([])

async function fetchEntries() {
  if (!props.entityId) return
  loading.value = true
  try {
    // Fetch audit log entries for this entity
    const { data } = await httpClient.get(`${props.orgUrl}/audit-logs`, {
      params: {
        entityType: props.entityType,
        entityId: props.entityId,
        size: 50,
        sortBy: 'timestamp',
        sortOrder: 'desc',
      },
    })
    const logs = (data.auditLogs || []).map((log: any) => ({
      id: log._id || log.id,
      type: log.action === 'note' ? 'note' as const : 'audit' as const,
      text: log.action === 'note' ? log.changes?.[0]?.newValue : undefined,
      action: log.action,
      userName: log.userName || log.userId,
      timestamp: new Date(log.timestamp || log.createdAt),
      changes: log.changes?.filter((c: any) => c.field !== 'note'),
    }))
    entries.value = logs
  } catch {
    // Silently fail — audit log might not have entries
  } finally {
    loading.value = false
  }
}

async function submitNote() {
  if (!newNote.value.trim() || !props.entityId) return
  saving.value = true
  try {
    await httpClient.post(`${props.orgUrl}/audit-logs`, {
      action: 'note',
      module: props.entityType.split('_')[0] || 'general',
      entityType: props.entityType,
      entityId: props.entityId,
      changes: [{ field: 'note', oldValue: null, newValue: newNote.value.trim() }],
    })
    newNote.value = ''
    await fetchEntries()
  } catch {
    // Silent fail
  } finally {
    saving.value = false
  }
}

function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return date.toLocaleDateString()
}

watch(() => props.entityId, () => {
  if (props.entityId) fetchEntries()
})

onMounted(() => {
  if (props.entityId) fetchEntries()
})
</script>

<style scoped>
.entity-notes-panel {
  height: 100%;
}

.notes-timeline {
  padding-top: 0;
}

.notes-timeline :deep(.v-timeline-item__body) {
  padding-top: 2px;
  padding-bottom: 8px;
}

.timeline-entry {
  font-size: 0.8125rem;
}

.change-item {
  font-size: 0.75rem;
  padding-left: 8px;
  border-left: 2px solid rgba(var(--v-border-color), 0.2);
  margin-top: 2px;
}
</style>
