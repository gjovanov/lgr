<template>
  <div class="pa-3">
    <div v-if="loading" class="text-center pa-4">
      <v-progress-circular indeterminate size="24" />
    </div>
    <div v-else-if="!logs.length" class="text-center text-medium-emphasis pa-4">
      No audit log entries
    </div>
    <v-timeline v-else density="compact" side="end" truncate-line="both">
      <v-timeline-item
        v-for="log in logs"
        :key="log.id || log._id"
        :dot-color="actionColor(log.action)"
        size="x-small"
      >
        <div class="text-caption text-medium-emphasis">{{ formatDate(log.createdAt) }}</div>
        <div class="text-body-2 font-weight-medium">{{ log.action }}</div>
        <div v-if="log.userName" class="text-caption text-medium-emphasis">by {{ log.userName }}</div>
        <div v-if="log.changes && Object.keys(log.changes).length" class="mt-1">
          <v-chip
            v-for="(val, key) in log.changes"
            :key="String(key)"
            size="x-small"
            variant="outlined"
            class="mr-1 mb-1"
          >
            {{ key }}
          </v-chip>
        </div>
      </v-timeline-item>
    </v-timeline>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useHttpClient } from 'ui-shared/composables/useHttpClient'

const props = defineProps<{
  entityType: string
  entityId: string
  orgUrl: string
}>()

const { httpClient } = useHttpClient()
const logs = ref<any[]>([])
const loading = ref(false)

async function fetchLogs() {
  if (!props.entityId || !props.orgUrl) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${props.orgUrl}/audit-logs`, {
      params: { entityType: props.entityType, entityId: props.entityId, size: 50 },
    })
    logs.value = data.auditLogs || data.items || []
  } catch {
    logs.value = []
  } finally {
    loading.value = false
  }
}

function actionColor(action: string) {
  if (action === 'create') return 'success'
  if (action === 'delete') return 'error'
  return 'primary'
}

function formatDate(d: string) {
  if (!d) return ''
  return new Date(d).toLocaleString()
}

watch(() => props.entityId, fetchLogs, { immediate: true })
</script>
