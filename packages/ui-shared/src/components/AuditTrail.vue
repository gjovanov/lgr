<template>
  <v-card variant="outlined">
    <v-card-title class="text-subtitle-1">
      <v-icon start>mdi-history</v-icon>
      {{ $t('common.auditTrail') }}
    </v-card-title>
    <v-divider />
    <v-timeline v-if="logs.length" density="compact" side="end" class="pa-4">
      <v-timeline-item
        v-for="log in logs"
        :key="log._id"
        :dot-color="actionColor(log.action)"
        size="small"
      >
        <div class="text-body-2">
          <strong>{{ log.action }}</strong> by {{ log.userId }}
        </div>
        <div class="text-caption text-grey">
          {{ formatDate(log.timestamp) }}
        </div>
        <div v-if="log.changes?.length" class="mt-1">
          <v-chip v-for="(change, i) in log.changes" :key="i" size="x-small" class="mr-1 mb-1">
            {{ change.field }}: {{ change.oldValue }} → {{ change.newValue }}
          </v-chip>
        </div>
      </v-timeline-item>
    </v-timeline>
    <v-card-text v-else class="text-center text-grey">
      {{ $t('common.noHistory') }}
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
defineProps<{
  logs: any[]
}>()

function actionColor(action: string) {
  const colors: Record<string, string> = { create: 'green', update: 'blue', delete: 'red', login: 'purple' }
  return colors[action] || 'grey'
}

function formatDate(date: string) {
  return new Date(date).toLocaleString()
}
</script>
